//! Reference network matcher.
//!
//! Chromium's `declarativeNetRequest` engine owns the real hot path; nothing
//! here ever sits in front of a network request. This matcher exists so the
//! extension can answer *"why was this request blocked, or why was it not?"*
//! from the same IR the DNR rules were lowered from, and so the compiler can
//! test its own lowering against an independent implementation.
//!
//! Priorities mirror the ones emitted into DNR exactly; see [`match_priority`].

use crate::error::BuildError;
use crate::index::{entity_label, DomainIndex, PatternIndex};
pub use crate::index::{host_of, registrable_domain, same_site};
use crate::ir::{Modifier, NetworkRule, Party, Pattern, ResourceTypes};
use regex_automata::meta::Regex;
use serde::Serialize;
use std::collections::BTreeMap;

/// DNR priority bands. Higher wins. Within a band Chromium resolves
/// `allow` > `allowAllRequests` > `block` > `redirect`.
pub mod priority {
    /// Shadow rules: an `allow` so low it can never outrank a real block.
    pub const SHADOW: u32 = 1;
    pub const REMOVE_PARAM: u32 = 5;
    pub const BLOCK_GENERIC: u32 = 10;
    pub const BLOCK_SCOPED: u32 = 20;
    pub const REDIRECT: u32 = 30;
    pub const CSP: u32 = 40;
    pub const EXCEPTION: u32 = 100;
    pub const IMPORTANT_BLOCK: u32 = 200;
    /// Per-site user disable, applied as a dynamic `allowAllRequests`.
    pub const SITE_DISABLE: u32 = 1000;
}

/// The priority a rule is lowered to. Shared by the matcher and the DNR lowerer
/// so the two can never drift apart.
pub fn match_priority(rule: &NetworkRule) -> u32 {
    if rule.shadow {
        return priority::SHADOW;
    }
    if rule.exception {
        return priority::EXCEPTION;
    }
    if rule.important {
        return priority::IMPORTANT_BLOCK;
    }
    match &rule.modifier {
        Modifier::RemoveParam(_) => priority::REMOVE_PARAM,
        Modifier::Redirect(_) => priority::REDIRECT,
        Modifier::Csp(_) => priority::CSP,
        Modifier::GenericHide
        | Modifier::ElemHide
        | Modifier::GenericBlock
        | Modifier::Document => priority::EXCEPTION,
        Modifier::Block => {
            if rule.is_scoped() {
                priority::BLOCK_SCOPED
            } else {
                priority::BLOCK_GENERIC
            }
        }
    }
}

/// A request to evaluate.
#[derive(Debug, Clone)]
pub struct MatchRequest<'a> {
    pub url: &'a str,
    /// Hostname of the request target.
    pub host: &'a str,
    /// Hostname of the document that initiated the request.
    pub initiator_host: &'a str,
    /// Exactly one [`ResourceTypes`] bit.
    pub resource: ResourceTypes,
    pub third_party: bool,
}

impl<'a> MatchRequest<'a> {
    /// Build a request, deriving hosts and third-partyness from the URLs.
    pub fn from_urls(url: &'a str, initiator: &'a str, resource: ResourceTypes) -> Self {
        let host = host_of(url);
        let initiator_host = host_of(initiator);
        let third_party = !same_site(host, initiator_host);
        MatchRequest {
            url,
            host,
            initiator_host,
            resource,
            third_party,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Block,
    Allow,
    Redirect,
    RemoveParam,
    Csp,
    /// The rule matched but is in shadow mode, so nothing happened.
    Observe,
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchDetail {
    pub rule_id: u32,
    pub priority: u32,
    pub action: Action,
    pub shadow: bool,
    pub raw: String,
    pub list: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    pub action: Action,
    pub winner: Option<MatchDetail>,
    /// Every rule that matched, highest priority first. This is what the
    /// diagnostics panel renders.
    pub matched: Vec<MatchDetail>,
}

pub struct MatchEngine {
    by_id: BTreeMap<u32, NetworkRule>,
    domains: DomainIndex,
    patterns: PatternIndex,
    regexes: BTreeMap<u32, Regex>,
}

impl MatchEngine {
    pub fn new(rules: Vec<NetworkRule>) -> Result<Self, BuildError> {
        let domains = DomainIndex::build(&rules);
        let patterns = PatternIndex::build(&rules)?;
        let mut regexes = BTreeMap::new();
        for rule in &rules {
            if let Pattern::Regex { source } = &rule.pattern {
                // Validated at parse time, so a failure here is a bug, not input.
                if let Ok(re) = Regex::new(source) {
                    regexes.insert(rule.id, re);
                }
            }
        }
        let by_id = rules.into_iter().map(|r| (r.id, r)).collect();
        Ok(MatchEngine {
            by_id,
            domains,
            patterns,
            regexes,
        })
    }

    pub fn rule_count(&self) -> usize {
        self.by_id.len()
    }

    pub fn rule(&self, id: u32) -> Option<&NetworkRule> {
        self.by_id.get(&id)
    }

    /// Evaluate a request against every rule, returning the full match set.
    pub fn evaluate(&self, req: &MatchRequest<'_>) -> Decision {
        let domain_candidates = self.domains.candidates(req.initiator_host);
        let pattern_candidates = self.patterns.candidates(req.url);
        let pattern_set: std::collections::BTreeSet<u32> = pattern_candidates.into_iter().collect();

        let mut matched: Vec<MatchDetail> = Vec::new();
        for id in domain_candidates {
            if !pattern_set.contains(&id) {
                continue;
            }
            let Some(rule) = self.by_id.get(&id) else {
                continue;
            };
            if !self.rule_matches(rule, req) {
                continue;
            }
            matched.push(MatchDetail {
                rule_id: rule.id,
                priority: match_priority(rule),
                action: action_of(rule),
                shadow: rule.shadow,
                raw: rule.source.raw.clone(),
                list: rule.source.list.clone(),
                line: rule.source.line,
            });
        }

        // Highest priority first; ties resolved by rule id so output is stable.
        matched.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.rule_id.cmp(&b.rule_id)));

        let winner = matched.iter().find(|m| !m.shadow).cloned();
        let action = winner.as_ref().map_or(Action::None, |w| w.action);
        Decision {
            action,
            winner,
            matched,
        }
    }

    fn rule_matches(&self, rule: &NetworkRule, req: &MatchRequest<'_>) -> bool {
        if !rule.types.contains(req.resource) {
            return false;
        }
        match rule.party {
            Party::Any => {}
            Party::Third if !req.third_party => return false,
            Party::First if req.third_party => return false,
            _ => {}
        }
        if !domain_allowed(
            &rule.initiator_domains,
            &rule.excluded_initiator_domains,
            req.initiator_host,
        ) {
            return false;
        }
        if !domain_allowed(
            &rule.request_domains,
            &rule.excluded_request_domains,
            req.host,
        ) {
            return false;
        }
        self.pattern_matches(rule, req)
    }

    fn pattern_matches(&self, rule: &NetworkRule, req: &MatchRequest<'_>) -> bool {
        let url = if rule.match_case {
            req.url.to_string()
        } else {
            req.url.to_lowercase()
        };
        match &rule.pattern {
            Pattern::Plain { raw } => {
                if raw == "*" {
                    return true;
                }
                find_wildcard(raw, &url, None).is_some()
            }
            Pattern::LeftAnchored { raw } => find_wildcard(raw, &url, Some(0)).is_some(),
            Pattern::HostAnchored { host, tail } => {
                let req_host = req.host;
                let host_ok = req_host == host
                    || req_host
                        .strip_suffix(host)
                        .is_some_and(|p| p.ends_with('.'));
                if !host_ok {
                    return false;
                }
                if tail.is_empty() {
                    return true;
                }
                // Resume matching immediately after the host in the URL.
                match url.find(req_host) {
                    Some(pos) => find_wildcard(tail, &url, Some(pos + req_host.len())).is_some(),
                    None => false,
                }
            }
            Pattern::Regex { .. } => self
                .regexes
                .get(&rule.id)
                .is_some_and(|re| re.is_match(req.url)),
        }
    }
}

fn action_of(rule: &NetworkRule) -> Action {
    if rule.shadow {
        return Action::Observe;
    }
    if rule.exception {
        return Action::Allow;
    }
    match &rule.modifier {
        Modifier::Block => Action::Block,
        Modifier::Redirect(_) => Action::Redirect,
        Modifier::RemoveParam(_) => Action::RemoveParam,
        Modifier::Csp(_) => Action::Csp,
        Modifier::GenericHide
        | Modifier::ElemHide
        | Modifier::GenericBlock
        | Modifier::Document => Action::Allow,
    }
}

/// `included` empty means "any host". An `excluded` hit always wins.
fn domain_allowed(included: &[String], excluded: &[String], host: &str) -> bool {
    if excluded.iter().any(|d| host_matches_scope(host, d)) {
        return false;
    }
    included.is_empty() || included.iter().any(|d| host_matches_scope(host, d))
}

fn host_matches_scope(host: &str, scope: &str) -> bool {
    if let Some(label) = scope.strip_suffix(".*") {
        return entity_label(host) == label;
    }
    host == scope || host.strip_suffix(scope).is_some_and(|p| p.ends_with('.'))
}

/// True for characters the `^` separator token accepts.
fn is_separator(c: u8) -> bool {
    !(c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'%'))
}

/// Match one wildcard-free segment at `start`, returning the end offset.
fn match_segment(seg: &[u8], hay: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    for (j, &s) in seg.iter().enumerate() {
        if s == b'^' {
            if i >= hay.len() {
                // A trailing `^` also matches the end of the URL.
                return (j == seg.len() - 1).then_some(i);
            }
            if !is_separator(hay[i]) {
                return None;
            }
        } else {
            if i >= hay.len() || hay[i] != s {
                return None;
            }
        }
        i += 1;
    }
    Some(i)
}

/// Match a `*`-containing pattern. `anchor` pins the first segment to an offset;
/// `None` searches for the first occurrence anywhere.
fn find_wildcard(pattern: &str, hay: &str, anchor: Option<usize>) -> Option<usize> {
    let hay_b = hay.as_bytes();
    let segments: Vec<&[u8]> = pattern.split('*').map(str::as_bytes).collect();

    let mut pos = anchor.unwrap_or(0);
    for (idx, seg) in segments.iter().enumerate() {
        if seg.is_empty() {
            continue;
        }
        if idx == 0 && anchor.is_some() {
            pos = match_segment(seg, hay_b, pos)?;
            continue;
        }
        let mut found = None;
        let mut start = pos;
        while start <= hay_b.len() {
            if let Some(end) = match_segment(seg, hay_b, start) {
                found = Some(end);
                break;
            }
            start += 1;
        }
        pos = found?;
    }
    Some(pos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedup::dedup;
    use crate::optimize::optimize_network;
    use crate::parse::{parse_list, ListSource, ParseOutput};

    fn engine(text: &str) -> MatchEngine {
        let mut out = ParseOutput::default();
        parse_list(&ListSource { id: "t", text }, &mut out);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let (net, _, _) = dedup(out.network, out.cosmetic, &out.badfilters);
        MatchEngine::new(optimize_network(net).0).unwrap()
    }

    fn decide(e: &MatchEngine, url: &str, doc: &str, ty: ResourceTypes) -> Action {
        e.evaluate(&MatchRequest::from_urls(url, doc, ty)).action
    }

    #[test]
    fn host_anchor_matches_subdomains_but_not_suffix_collisions() {
        let e = engine("||ads.com^");
        assert_eq!(
            decide(
                &e,
                "https://x.ads.com/a.js",
                "https://site.org/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://ads.com/a.js",
                "https://site.org/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://notads.com/a.js",
                "https://site.org/",
                ResourceTypes::SCRIPT
            ),
            Action::None
        );
    }

    #[test]
    fn separator_token_matches_end_of_url() {
        let e = engine("||ads.com^");
        assert_eq!(
            decide(
                &e,
                "https://ads.com",
                "https://site.org/",
                ResourceTypes::IMAGE
            ),
            Action::Block
        );
    }

    #[test]
    fn exception_beats_block() {
        let e = engine("||ads.com^\n@@||ads.com/allowed.js");
        assert_eq!(
            decide(
                &e,
                "https://ads.com/blocked.js",
                "https://s.org/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://ads.com/allowed.js",
                "https://s.org/",
                ResourceTypes::SCRIPT
            ),
            Action::Allow
        );
    }

    #[test]
    fn important_beats_exception() {
        let e = engine("||ads.com^$important\n@@||ads.com^");
        assert_eq!(
            decide(
                &e,
                "https://ads.com/x.js",
                "https://s.org/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
    }

    #[test]
    fn shadow_rules_never_win() {
        let e = engine("!#shadow on\n||ads.com^\n!#shadow off");
        let d = e.evaluate(&MatchRequest::from_urls(
            "https://ads.com/x.js",
            "https://s.org/",
            ResourceTypes::SCRIPT,
        ));
        assert_eq!(d.action, Action::None, "shadow rule must not block");
        assert_eq!(d.matched.len(), 1, "but it must still be reported");
        assert!(d.matched[0].shadow);
    }

    #[test]
    fn third_party_constraint_is_enforced() {
        let e = engine("||cdn.com^$third-party");
        assert_eq!(
            decide(
                &e,
                "https://cdn.com/a.js",
                "https://site.org/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://cdn.com/a.js",
                "https://www.cdn.com/",
                ResourceTypes::SCRIPT
            ),
            Action::None
        );
    }

    #[test]
    fn domain_scope_and_exclusion() {
        let e = engine("/track.js$domain=a.com|~sub.a.com");
        assert_eq!(
            decide(
                &e,
                "https://x.io/track.js",
                "https://a.com/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://x.io/track.js",
                "https://sub.a.com/",
                ResourceTypes::SCRIPT
            ),
            Action::None
        );
        assert_eq!(
            decide(
                &e,
                "https://x.io/track.js",
                "https://b.com/",
                ResourceTypes::SCRIPT
            ),
            Action::None
        );
    }

    #[test]
    fn resource_type_gates_the_match() {
        let e = engine("||ads.com^$script");
        assert_eq!(
            decide(
                &e,
                "https://ads.com/a.png",
                "https://s.org/",
                ResourceTypes::IMAGE
            ),
            Action::None
        );
        assert_eq!(
            decide(
                &e,
                "https://ads.com/a.js",
                "https://s.org/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
    }

    #[test]
    fn unqualified_rules_do_not_block_the_top_level_document() {
        let e = engine("||ads.com^");
        assert_eq!(
            decide(
                &e,
                "https://ads.com/",
                "https://ads.com/",
                ResourceTypes::MAIN_FRAME
            ),
            Action::None
        );
    }

    #[test]
    fn wildcards_match_across_segments() {
        let e = engine("/banner*/img.gif");
        assert_eq!(
            decide(
                &e,
                "https://x.io/banner-300/img.gif",
                "https://s.org/",
                ResourceTypes::IMAGE
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://x.io/img.gif",
                "https://s.org/",
                ResourceTypes::IMAGE
            ),
            Action::None
        );
    }

    #[test]
    fn regex_rules_match() {
        let e = engine("/\\/ad[0-9]{3}\\./$image");
        assert_eq!(
            decide(
                &e,
                "https://x.io/ad123.gif",
                "https://s.org/",
                ResourceTypes::IMAGE
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://x.io/ad12.gif",
                "https://s.org/",
                ResourceTypes::IMAGE
            ),
            Action::None
        );
    }

    #[test]
    fn entity_scope_matches_across_tlds() {
        let e = engine("/ads/$domain=google.*");
        assert_eq!(
            decide(
                &e,
                "https://x.io/ads/a.js",
                "https://www.google.co.uk/",
                ResourceTypes::SCRIPT
            ),
            Action::Block
        );
        assert_eq!(
            decide(
                &e,
                "https://x.io/ads/a.js",
                "https://notgoogle.com/",
                ResourceTypes::SCRIPT
            ),
            Action::None
        );
    }

    #[test]
    fn diagnostics_report_every_match_not_just_the_winner() {
        let e = engine("||ads.com^\n@@||ads.com/ok.js");
        let d = e.evaluate(&MatchRequest::from_urls(
            "https://ads.com/ok.js",
            "https://s.org/",
            ResourceTypes::SCRIPT,
        ));
        assert_eq!(d.matched.len(), 2);
        assert_eq!(d.matched[0].action, Action::Allow, "highest priority first");
        assert_eq!(d.action, Action::Allow);
    }
}
