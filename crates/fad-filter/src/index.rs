//! Candidate-narrowing indexes for the reference matcher.
//!
//! A linear scan over 60k rules is fine in a batch compiler and far too slow in
//! the diagnostics path, which runs per request when the user opens the
//! inspector. Two indexes cut the candidate set by ~3 orders of magnitude:
//!
//! * [`DomainIndex`] — document host to the rules scoped to it.
//! * [`PatternIndex`] — an Aho-Corasick automaton over every rule's longest
//!   literal, so only rules whose literal actually occurs in the URL are tried.

use crate::error::BuildError;
use crate::ir::NetworkRule;
use aho_corasick::{AhoCorasick, MatchKind};
use rustc_hash::FxHashSet;
use std::collections::BTreeMap;

/// Maps a document hostname to the rules that can apply to it.
#[derive(Debug, Default)]
pub struct DomainIndex {
    /// Rules with no `$domain=` scope. Apply to every document.
    global: Vec<u32>,
    /// Exact host to rule ids. A rule scoped to `a.com` is reachable from
    /// `x.y.a.com` through suffix decomposition at lookup time.
    scoped: BTreeMap<String, Vec<u32>>,
    /// Entity scopes such as `google.*`, keyed by the label prefix.
    entity: BTreeMap<String, Vec<u32>>,
}

impl DomainIndex {
    pub fn build(rules: &[NetworkRule]) -> Self {
        let mut idx = DomainIndex::default();
        for rule in rules {
            if rule.initiator_domains.is_empty() {
                idx.global.push(rule.id);
                continue;
            }
            for domain in &rule.initiator_domains {
                match domain.strip_suffix(".*") {
                    Some(prefix) => idx
                        .entity
                        .entry(prefix.to_string())
                        .or_default()
                        .push(rule.id),
                    None => idx.scoped.entry(domain.clone()).or_default().push(rule.id),
                }
            }
        }
        for v in idx.scoped.values_mut().chain(idx.entity.values_mut()) {
            v.sort_unstable();
            v.dedup();
        }
        idx.global.sort_unstable();
        idx.global.dedup();
        idx
    }

    /// Every rule id that could apply to a document served from `host`.
    pub fn candidates(&self, host: &str) -> Vec<u32> {
        let mut out: FxHashSet<u32> = self.global.iter().copied().collect();
        for suffix in host_suffixes(host) {
            if let Some(ids) = self.scoped.get(suffix) {
                out.extend(ids.iter().copied());
            }
        }
        // `google.*` matches `google.com` and `google.co.uk`, never `notgoogle.com`.
        if let Some(ids) = self.entity.get(entity_label(host)) {
            out.extend(ids.iter().copied());
        }
        let mut out: Vec<u32> = out.into_iter().collect();
        out.sort_unstable();
        out
    }

    pub fn len(&self) -> usize {
        self.scoped.len() + self.entity.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0 && self.global.is_empty()
    }
}

/// Multi-label public suffixes common enough to matter.
///
/// ponytail: a compiled-in subset, not the full Public Suffix List. Chromium
/// computes third-partyness itself, so enforcement never depends on this; it
/// only affects entity-scope matching (`google.*`) and the third-party label
/// shown in diagnostics. Upgrade path: swap in the `psl` crate, which embeds
/// the full list, if an exotic ccTLD ever matters.
const MULTI_LABEL_SUFFIXES: &[&str] = &[
    "co.uk",
    "org.uk",
    "ac.uk",
    "gov.uk",
    "me.uk",
    "net.uk",
    "sch.uk",
    "com.au",
    "net.au",
    "org.au",
    "edu.au",
    "gov.au",
    "id.au",
    "co.jp",
    "or.jp",
    "ne.jp",
    "ac.jp",
    "go.jp",
    "com.br",
    "net.br",
    "org.br",
    "gov.br",
    "co.in",
    "net.in",
    "org.in",
    "gov.in",
    "ac.in",
    "com.cn",
    "net.cn",
    "org.cn",
    "gov.cn",
    "edu.cn",
    "co.kr",
    "or.kr",
    "ne.kr",
    "go.kr",
    "co.za",
    "org.za",
    "net.za",
    "gov.za",
    "com.mx",
    "com.ar",
    "com.tr",
    "com.sg",
    "com.hk",
    "com.tw",
    "com.pl",
    "co.nz",
    "net.nz",
    "org.nz",
    "govt.nz",
    "github.io",
    "pages.dev",
    "workers.dev",
    "vercel.app",
    "netlify.app",
];

/// Hostname of a URL, or the input unchanged if it is already a bare host.
pub fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.split_once('@').map_or(rest, |(_, r)| r);
    let end = rest.find(['/', '?', '#', ':']).unwrap_or(rest.len());
    &rest[..end]
}

/// Registrable domain (eTLD+1) under the embedded suffix subset.
pub fn registrable_domain(host: &str) -> &str {
    let host = host.trim_end_matches('.');
    for suffix in MULTI_LABEL_SUFFIXES {
        if let Some(prefix) = host.strip_suffix(suffix) {
            if prefix.ends_with('.') {
                let label_start = prefix[..prefix.len() - 1].rfind('.').map_or(0, |i| i + 1);
                return &host[label_start..];
            }
        }
    }
    match host.match_indices('.').nth_back_two() {
        Some(idx) => &host[idx + 1..],
        None => host,
    }
}

trait NthBackTwo {
    fn nth_back_two(self) -> Option<usize>;
}

impl<'a, I: DoubleEndedIterator<Item = (usize, &'a str)>> NthBackTwo for I {
    /// Byte offset of the second-to-last separator, i.e. the start of the
    /// registrable domain for a single-label suffix.
    fn nth_back_two(mut self) -> Option<usize> {
        self.next_back()?;
        self.next_back().map(|(i, _)| i)
    }
}

/// The entity label of a host: the leftmost label of its registrable domain.
///
/// `www.google.co.uk` -> `google`, so the entity scope `google.*` matches it.
/// `notgoogle.com` -> `notgoogle`, so it does not.
pub fn entity_label(host: &str) -> &str {
    let reg = registrable_domain(host);
    reg.split_once('.').map_or(reg, |(label, _)| label)
}

/// Do two hosts share a registrable domain?
pub fn same_site(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && registrable_domain(a) == registrable_domain(b)
}

/// All suffixes of a hostname with at least two labels, longest first.
///
/// `a.b.example.com` -> `a.b.example.com`, `b.example.com`, `example.com`.
pub fn host_suffixes(host: &str) -> impl Iterator<Item = &str> {
    let host = host.trim_end_matches('.');
    std::iter::successors(Some(host), |h| {
        h.split_once('.')
            .map(|(_, rest)| rest)
            .filter(|rest| rest.contains('.'))
    })
}

/// Aho-Corasick automaton over rule literals.
pub struct PatternIndex {
    automaton: AhoCorasick,
    /// Parallel to the automaton's patterns: which rule each literal belongs to.
    owners: Vec<u32>,
    /// Rules with no usable literal (pure regex or bare wildcard). Always tried.
    literal_free: Vec<u32>,
}

impl PatternIndex {
    pub fn build(rules: &[NetworkRule]) -> Result<Self, BuildError> {
        let mut literals: Vec<String> = Vec::new();
        let mut owners: Vec<u32> = Vec::new();
        let mut literal_free: Vec<u32> = Vec::new();

        for rule in rules {
            match rule.pattern.longest_literal() {
                // A one- or two-character literal narrows nothing; skipping the
                // automaton for it is cheaper than the false-positive traffic.
                Some(lit) if lit.len() >= 3 => {
                    literals.push(lit.to_lowercase());
                    owners.push(rule.id);
                }
                _ => literal_free.push(rule.id),
            }
        }

        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::Standard)
            .ascii_case_insensitive(true)
            .build(&literals)?;

        literal_free.sort_unstable();
        Ok(PatternIndex {
            automaton,
            owners,
            literal_free,
        })
    }

    /// Rule ids whose literal occurs in `url`, plus every literal-free rule.
    pub fn candidates(&self, url: &str) -> Vec<u32> {
        let mut out: FxHashSet<u32> = self.literal_free.iter().copied().collect();
        for m in self.automaton.find_overlapping_iter(url) {
            out.insert(self.owners[m.pattern().as_usize()]);
        }
        let mut out: Vec<u32> = out.into_iter().collect();
        out.sort_unstable();
        out
    }

    pub fn literal_count(&self) -> usize {
        self.owners.len()
    }
    pub fn literal_free_count(&self) -> usize {
        self.literal_free.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedup::dedup;
    use crate::optimize::optimize_network;
    use crate::parse::{parse_list, ListSource, ParseOutput};

    fn rules(text: &str) -> Vec<NetworkRule> {
        let mut out = ParseOutput::default();
        parse_list(&ListSource { id: "t", text }, &mut out);
        let (net, _, _) = dedup(out.network, out.cosmetic, &out.badfilters);
        optimize_network(net).0
    }

    #[test]
    fn suffix_decomposition_stops_at_two_labels() {
        let got: Vec<_> = host_suffixes("a.b.example.com").collect();
        assert_eq!(got, vec!["a.b.example.com", "b.example.com", "example.com"]);
        assert_eq!(
            host_suffixes("example.com").collect::<Vec<_>>(),
            vec!["example.com"]
        );
    }

    #[test]
    fn domain_index_reaches_scoped_rules_from_subdomains() {
        let rules = rules("||ads.com^$domain=example.com\n||other.com^$domain=nope.com");
        let idx = DomainIndex::build(&rules);
        let scoped_id = rules
            .iter()
            .find(|r| !r.initiator_domains.is_empty() && r.initiator_domains[0] == "example.com")
            .unwrap()
            .id;
        assert!(idx.candidates("www.example.com").contains(&scoped_id));
        assert!(!idx.candidates("elsewhere.org").contains(&scoped_id));
    }

    #[test]
    fn global_rules_are_candidates_everywhere() {
        let rules = rules("||ads.com^");
        let idx = DomainIndex::build(&rules);
        assert_eq!(idx.candidates("anything.example"), vec![rules[0].id]);
    }

    #[test]
    fn pattern_index_narrows_by_literal() {
        let rules = rules("||doubleclick.net^\n||scorecardresearch.com^");
        let idx = PatternIndex::build(&rules).unwrap();
        let dc = rules
            .iter()
            .find(|r| r.source.raw.contains("doubleclick"))
            .unwrap()
            .id;
        let hits = idx.candidates("https://ad.doubleclick.net/x");
        assert!(hits.contains(&dc));
        assert_eq!(hits.len(), 1, "unrelated rule should be excluded");
    }

    #[test]
    fn registrable_domain_handles_multi_label_suffixes() {
        assert_eq!(registrable_domain("www.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(registrable_domain("a.b.example.com"), "example.com");
        assert_eq!(registrable_domain("example.com"), "example.com");
        assert_eq!(registrable_domain("localhost"), "localhost");
        assert!(same_site("www.bbc.co.uk", "news.bbc.co.uk"));
        assert!(!same_site("bbc.co.uk", "itv.co.uk"));
    }

    #[test]
    fn entity_label_survives_multi_label_suffixes() {
        assert_eq!(entity_label("www.google.co.uk"), "google");
        assert_eq!(entity_label("google.de"), "google");
        assert_eq!(entity_label("notgoogle.com"), "notgoogle");
    }

    #[test]
    fn regex_rules_are_always_candidates() {
        let rules = rules("/track[0-9]+/");
        let idx = PatternIndex::build(&rules).unwrap();
        assert_eq!(idx.literal_free_count(), 1);
        assert_eq!(
            idx.candidates("https://unrelated.example/"),
            vec![rules[0].id]
        );
    }
}
