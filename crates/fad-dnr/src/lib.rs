//! Lowering from the canonical IR to Chromium `declarativeNetRequest` rules.
//!
//! Chromium owns the network hot path. Nothing in 404AD intercepts a request in
//! JavaScript or WASM; this crate's whole job is to turn filter rules into the
//! declarative form Chromium's own matcher consumes, and to be honest about the
//! rules that cannot be expressed that way.
//!
//! Three hard platform limits shape everything here:
//!
//! * 30,000 static rules across all enabled rulesets ([`limits::STATIC_RULES`]).
//! * 1,000 regex rules total ([`limits::REGEX_RULES`]).
//! * 50 enabled static rulesets ([`limits::ENABLED_RULESETS`]).
//!
//! Exceeding any of them makes Chromium reject the extension at load time, so
//! the packer enforces them at build time instead.

pub mod pack;

use fad_filter::ir::{Modifier, NetworkRule, Party, Pattern, RemoveParam, ResourceTypes};
use fad_filter::matcher::match_priority;
use serde::{Deserialize, Serialize};

/// Chromium `declarativeNetRequest` platform limits.
pub mod limits {
    /// `GUARANTEED_MINIMUM_STATIC_RULES`.
    pub const STATIC_RULES: usize = 30_000;
    /// `MAX_NUMBER_OF_REGEX_RULES`.
    pub const REGEX_RULES: usize = 1_000;
    /// `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS`.
    pub const ENABLED_RULESETS: usize = 50;
    /// `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES`.
    pub const DYNAMIC_RULES: usize = 5_000;
    /// Rules per emitted file. Keeps individual JSON files parseable quickly
    /// and keeps a single category from monopolising a ruleset slot.
    pub const RULES_PER_FILE: usize = 5_000;
}

/// TLDs an entity pattern (`example.*`) expands to.
///
/// ponytail: `declarativeNetRequest` has no entity syntax, so an entity scope
/// must be materialised as concrete domains. This covers the TLDs entity rules
/// are actually written for; a rule targeting an exotic ccTLD will not match
/// there. The alternative (dropping the scope) would make the rule global, which
/// is strictly worse. Upgrade path: widen this list, or drop entity support and
/// reject those rules outright.
pub const ENTITY_TLDS: &[&str] = &[
    "com", "net", "org", "io", "co", "de", "fr", "es", "it", "nl", "be", "at", "ch", "se", "no",
    "dk", "fi", "pl", "cz", "ru", "ua", "tr", "gr", "pt", "ro", "hu", "ie", "jp", "cn", "kr", "in",
    "au", "nz", "br", "mx", "ar", "cl", "ca", "za", "co.uk", "com.au", "co.jp", "com.br", "co.in",
    "com.mx", "com.tr", "co.za", "co.kr", "com.cn",
];

/// A Chromium DNR rule. Field order is fixed so JSON output is byte-stable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DnrRule {
    pub id: u32,
    pub priority: u32,
    pub action: DnrAction,
    pub condition: DnrCondition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrAction {
    #[serde(rename = "type")]
    pub kind: ActionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect: Option<Redirect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_headers: Option<Vec<HeaderOp>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Block,
    Allow,
    AllowAllRequests,
    Redirect,
    ModifyHeaders,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redirect {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<Transform>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_transform: Option<QueryTransform>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryTransform {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_params: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderOp {
    pub header: String,
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrCondition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regex_filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_url_filter_case_sensitive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_types: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initiator_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_initiator_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_request_domains: Option<Vec<String>>,
}

/// A rule the DNR backend cannot express, reported rather than silently dropped.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Unsupported {
    pub rule_id: u32,
    pub raw: String,
    pub list: String,
    pub line: u32,
    pub reason: &'static str,
}

/// A filtering-suppression directive. These are not network rules: they tell the
/// content runtime to stand down on a document, so they travel with the cosmetic
/// payload instead of with DNR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suppression {
    pub rule_id: u32,
    pub kind: SuppressionKind,
    pub domains: Vec<String>,
    pub excluded_domains: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SuppressionKind {
    /// `$generichide` — skip generic cosmetic rules.
    GenericHide,
    /// `$elemhide` — skip all cosmetic rules.
    ElemHide,
    /// `$genericblock` — reported for diagnostics; unscoped network rules
    /// cannot be disabled per-document in DNR.
    GenericBlock,
}

/// Result of lowering a whole rule set.
#[derive(Debug, Default)]
pub struct Lowered {
    pub rules: Vec<DnrRule>,
    pub suppressions: Vec<Suppression>,
    pub unsupported: Vec<Unsupported>,
    /// DNR rule id -> IR rule id, for diagnostics and for `onRuleMatchedDebug`.
    pub id_map: Vec<(u32, u32)>,
    pub regex_count: usize,
}

/// Lower every rule, assigning DNR ids in IR-id order so output is stable.
pub fn lower(rules: &[NetworkRule]) -> Lowered {
    let mut out = Lowered::default();
    let mut next_id: u32 = 1;

    for rule in rules {
        match lower_one(rule) {
            LowerOutcome::Rule(action, condition) => {
                if condition.regex_filter.is_some() {
                    out.regex_count += 1;
                }
                out.rules.push(DnrRule {
                    id: next_id,
                    priority: match_priority(rule),
                    action,
                    condition,
                });
                out.id_map.push((next_id, rule.id));
                next_id += 1;
            }
            LowerOutcome::Suppression(kind) => out.suppressions.push(Suppression {
                rule_id: rule.id,
                kind,
                domains: rule.initiator_domains.clone(),
                excluded_domains: rule.excluded_initiator_domains.clone(),
            }),
            LowerOutcome::Unsupported(reason) => out.unsupported.push(Unsupported {
                rule_id: rule.id,
                raw: rule.source.raw.clone(),
                list: rule.source.list.clone(),
                line: rule.source.line,
                reason,
            }),
        }
    }
    out
}

enum LowerOutcome {
    Rule(DnrAction, DnrCondition),
    Suppression(SuppressionKind),
    Unsupported(&'static str),
}

fn lower_one(rule: &NetworkRule) -> LowerOutcome {
    // Suppression directives never become network rules.
    match &rule.modifier {
        Modifier::GenericHide => return LowerOutcome::Suppression(SuppressionKind::GenericHide),
        Modifier::ElemHide => return LowerOutcome::Suppression(SuppressionKind::ElemHide),
        Modifier::GenericBlock => return LowerOutcome::Suppression(SuppressionKind::GenericBlock),
        _ => {}
    }

    let condition = match lower_condition(rule) {
        Ok(c) => c,
        Err(reason) => return LowerOutcome::Unsupported(reason),
    };

    let action = match lower_action(rule) {
        Ok(a) => a,
        Err(reason) => return LowerOutcome::Unsupported(reason),
    };

    LowerOutcome::Rule(action, condition)
}

fn lower_action(rule: &NetworkRule) -> Result<DnrAction, &'static str> {
    // Shadow rules become the lowest-priority `allow` in the system. An `allow`
    // only changes behaviour when it outranks a block, and nothing ranks below
    // priority 1, so a shadow rule is observable but inert.
    if rule.shadow {
        return Ok(plain(ActionKind::Allow));
    }

    if rule.exception {
        return Ok(plain(if matches!(rule.modifier, Modifier::Document) {
            ActionKind::AllowAllRequests
        } else {
            ActionKind::Allow
        }));
    }

    Ok(match &rule.modifier {
        Modifier::Block => plain(ActionKind::Block),
        Modifier::Redirect(name) => DnrAction {
            kind: ActionKind::Redirect,
            redirect: Some(Redirect {
                extension_path: Some(format!("/redirect/{}", sanitize_resource(name))),
                transform: None,
            }),
            response_headers: None,
        },
        Modifier::RemoveParam(spec) => {
            let transform = match spec {
                RemoveParam::All => Transform {
                    query: Some(String::new()),
                    query_transform: None,
                },
                RemoveParam::Keys(keys) => Transform {
                    query: None,
                    query_transform: Some(QueryTransform {
                        remove_params: Some(keys.clone()),
                    }),
                },
                // `queryTransform` can remove or replace named parameters but
                // cannot express "keep only these".
                RemoveParam::ExceptKeys(_) => {
                    return Err("$removeparam with ~ inversion has no DNR equivalent")
                }
            };
            DnrAction {
                kind: ActionKind::Redirect,
                redirect: Some(Redirect {
                    extension_path: None,
                    transform: Some(transform),
                }),
                response_headers: None,
            }
        }
        Modifier::Csp(value) => {
            if value.is_empty() {
                return Err("$csp with no value cannot be lowered");
            }
            DnrAction {
                kind: ActionKind::ModifyHeaders,
                redirect: None,
                response_headers: Some(vec![HeaderOp {
                    header: "content-security-policy".into(),
                    operation: "append".into(),
                    value: Some(value.clone()),
                }]),
            }
        }
        Modifier::GenericHide
        | Modifier::ElemHide
        | Modifier::GenericBlock
        | Modifier::Document => {
            unreachable!("handled before lower_action")
        }
    })
}

fn plain(kind: ActionKind) -> DnrAction {
    DnrAction {
        kind,
        redirect: None,
        response_headers: None,
    }
}

fn lower_condition(rule: &NetworkRule) -> Result<DnrCondition, &'static str> {
    let mut c = DnrCondition::default();

    match &rule.pattern {
        Pattern::Regex { source } => {
            if source.len() > 1_000 {
                return Err("regex exceeds the DNR length limit");
            }
            c.regex_filter = Some(source.clone());
        }
        Pattern::HostAnchored { host, tail } => {
            if host.contains('*') {
                return Err("wildcard inside a host anchor has no DNR equivalent");
            }
            c.url_filter = Some(format!("||{host}{tail}"));
        }
        Pattern::LeftAnchored { raw } => c.url_filter = Some(format!("|{raw}")),
        Pattern::Plain { raw } => c.url_filter = Some(raw.clone()),
    }

    // DNR needs a condition to match on. `*` is the correct encoding of a rule
    // that deliberately applies to every URL, such as a global `$removeparam`.
    if c.url_filter.is_none() && c.regex_filter.is_none() {
        c.url_filter = Some("*".to_string());
    }

    // Emitted explicitly: Chromium's default for this field changed across
    // versions, and filter-list semantics are case-insensitive by default.
    if c.regex_filter.is_none() || rule.match_case {
        c.is_url_filter_case_sensitive = Some(rule.match_case);
    }

    // An empty `resourceTypes` means "everything except main_frame" in DNR,
    // which is exactly the implicit filter-list default. Omitting the field
    // keeps the JSON smaller and the semantics identical.
    if rule.types != ResourceTypes::implicit_default() {
        let names = rule.types.dnr_names();
        if names.is_empty() {
            return Err("rule matches no resource type");
        }
        c.resource_types = Some(names.into_iter().map(String::from).collect());
    }

    match rule.party {
        Party::First => c.domain_type = Some("firstParty".into()),
        Party::Third => c.domain_type = Some("thirdParty".into()),
        Party::Any => {}
    }

    c.initiator_domains = expand_domains(&rule.initiator_domains);
    c.excluded_initiator_domains = expand_domains(&rule.excluded_initiator_domains);
    c.request_domains = expand_domains(&rule.request_domains);
    c.excluded_request_domains = expand_domains(&rule.excluded_request_domains);

    // A rule that matches every URL, of every type, from every document, with a
    // `block` action would take the browser offline. Modifiers are a different
    // matter: a global `$removeparam` is exactly the intended shape.
    let unbounded = c.url_filter.as_deref() == Some("*")
        && c.resource_types.is_none()
        && c.domain_type.is_none()
        && c.initiator_domains.is_none()
        && c.request_domains.is_none();
    if unbounded && matches!(rule.modifier, Modifier::Block) && !rule.exception {
        return Err("an unscoped block would match every request");
    }
    Ok(c)
}

/// Expand entity scopes and drop empty lists.
fn expand_domains(domains: &[String]) -> Option<Vec<String>> {
    if domains.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(domains.len());
    for d in domains {
        match d.strip_suffix(".*") {
            Some(label) => out.extend(ENTITY_TLDS.iter().map(|tld| format!("{label}.{tld}"))),
            None => out.push(d.clone()),
        }
    }
    out.sort();
    out.dedup();
    Some(out)
}

/// Redirect resources live under `/redirect/` in the packaged extension.
fn sanitize_resource(name: &str) -> String {
    let base = name.split(':').next_back().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if cleaned.contains('.') {
        cleaned
    } else {
        format!("{cleaned}.js")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fad_filter::matcher::priority;
    use fad_filter::parse::{parse_list, ListSource, ParseOutput};
    use fad_filter::{dedup, optimize};

    fn lower_text(text: &str) -> Lowered {
        let mut out = ParseOutput::default();
        parse_list(&ListSource { id: "t", text }, &mut out);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let (net, _, _) = dedup::dedup(out.network, out.cosmetic, &out.badfilters);
        lower(&optimize::optimize_network(net).0)
    }

    fn only(text: &str) -> DnrRule {
        let l = lower_text(text);
        assert_eq!(
            l.rules.len(),
            1,
            "expected one rule, got {:?} / {:?}",
            l.rules,
            l.unsupported
        );
        l.rules.into_iter().next().unwrap()
    }

    #[test]
    fn host_anchor_becomes_a_url_filter() {
        let r = only("||ads.example.com^$script,third-party");
        assert_eq!(
            r.condition.url_filter.as_deref(),
            Some("||ads.example.com^")
        );
        assert_eq!(r.condition.domain_type.as_deref(), Some("thirdParty"));
        assert_eq!(r.condition.resource_types, Some(vec!["script".to_string()]));
        assert_eq!(r.action.kind, ActionKind::Block);
        assert_eq!(r.priority, priority::BLOCK_GENERIC);
    }

    #[test]
    fn implicit_default_types_are_omitted_because_dnr_agrees() {
        let r = only("||ads.com^");
        assert!(r.condition.resource_types.is_none());
    }

    #[test]
    fn exception_lowers_to_allow_above_blocks() {
        let r = only("@@||ads.com^");
        assert_eq!(r.action.kind, ActionKind::Allow);
        assert!(r.priority > priority::BLOCK_SCOPED);
    }

    #[test]
    fn document_exception_lowers_to_allow_all_requests() {
        let r = only("@@||example.com^$document");
        assert_eq!(r.action.kind, ActionKind::AllowAllRequests);
    }

    #[test]
    fn important_outranks_exceptions() {
        let l = lower_text("||ads.com^$important\n@@||ads.com^");
        let important = l
            .rules
            .iter()
            .find(|r| r.action.kind == ActionKind::Block)
            .unwrap();
        let exception = l
            .rules
            .iter()
            .find(|r| r.action.kind == ActionKind::Allow)
            .unwrap();
        assert!(important.priority > exception.priority);
    }

    #[test]
    fn shadow_rules_are_inert_allows_at_the_lowest_priority() {
        let l = lower_text("!#shadow on\n||candidate.com^\n!#shadow off\n||blocked.com^");
        let shadow = l
            .rules
            .iter()
            .find(|r| r.priority == priority::SHADOW)
            .unwrap();
        let real = l
            .rules
            .iter()
            .find(|r| r.action.kind == ActionKind::Block)
            .unwrap();
        assert_eq!(shadow.action.kind, ActionKind::Allow);
        assert!(
            shadow.priority < real.priority,
            "a shadow allow must never outrank a real block"
        );
    }

    #[test]
    fn removeparam_lowers_to_a_query_transform() {
        let r = only("||x.com^$removeparam=utm_source|gclid");
        assert_eq!(r.action.kind, ActionKind::Redirect);
        let qt = r
            .action
            .redirect
            .unwrap()
            .transform
            .unwrap()
            .query_transform
            .unwrap();
        assert_eq!(
            qt.remove_params,
            Some(vec!["gclid".into(), "utm_source".into()])
        );
        assert!(
            r.priority < priority::BLOCK_GENERIC,
            "a block must beat a param strip"
        );
    }

    #[test]
    fn removeparam_all_clears_the_whole_query() {
        let r = only("||x.com/t^$removeparam");
        assert_eq!(
            r.action
                .redirect
                .unwrap()
                .transform
                .unwrap()
                .query
                .as_deref(),
            Some("")
        );
    }

    #[test]
    fn csp_lowers_to_a_response_header_append() {
        let r = only("||x.com^$csp=script-src 'none'");
        assert_eq!(r.action.kind, ActionKind::ModifyHeaders);
        let h = &r.action.response_headers.unwrap()[0];
        assert_eq!(h.header, "content-security-policy");
        assert_eq!(h.operation, "append");
    }

    #[test]
    fn redirect_points_at_a_bundled_resource() {
        let r = only("||x.com/ads.js$redirect=noopjs");
        assert_eq!(
            r.action.redirect.unwrap().extension_path.as_deref(),
            Some("/redirect/noopjs.js")
        );
    }

    #[test]
    fn entity_scopes_expand_to_concrete_domains() {
        let r = only("/ads/$domain=google.*");
        let d = r.condition.initiator_domains.unwrap();
        assert!(d.contains(&"google.com".to_string()));
        assert!(d.contains(&"google.co.uk".to_string()));
        assert!(
            !d.iter().any(|x| x.contains('*')),
            "no wildcards may survive"
        );
    }

    #[test]
    fn suppression_directives_leave_the_network_path() {
        let l = lower_text("@@||example.com^$generichide");
        assert!(l.rules.is_empty());
        assert_eq!(l.suppressions.len(), 1);
        assert_eq!(l.suppressions[0].kind, SuppressionKind::GenericHide);
    }

    #[test]
    fn inexpressible_rules_are_reported_not_dropped_silently() {
        let l = lower_text("||x.com^$removeparam=~keep");
        assert!(l.rules.is_empty());
        assert_eq!(l.unsupported.len(), 1);
        assert!(l.unsupported[0].reason.contains("inversion"));
    }

    #[test]
    fn a_global_removeparam_lowers_to_a_wildcard_condition() {
        let r = only("$removeparam=utm_source");
        assert_eq!(r.condition.url_filter.as_deref(), Some("*"));
        assert_eq!(r.action.kind, ActionKind::Redirect);
        // It must reach navigations, which is where tracking params live.
        assert!(r
            .condition
            .resource_types
            .as_ref()
            .unwrap()
            .contains(&"main_frame".to_string()));
    }

    #[test]
    fn an_unscoped_block_is_refused() {
        let l = lower_text("*");
        assert!(l.rules.is_empty());
        assert_eq!(l.unsupported.len(), 1);
        assert!(l.unsupported[0].reason.contains("every request"));
    }

    #[test]
    fn a_typed_global_block_is_allowed() {
        // `*$ping,third-party` is bounded: one resource type, third-party only.
        let r = only("*$ping,third-party");
        assert_eq!(r.action.kind, ActionKind::Block);
        assert_eq!(r.condition.resource_types, Some(vec!["ping".to_string()]));
    }

    #[test]
    fn ids_are_dense_and_stable() {
        let a = lower_text("||b.com^\n||a.com^\n||c.com^");
        let b = lower_text("||c.com^\n||a.com^\n||b.com^");
        let key = |l: &Lowered| -> Vec<(u32, Option<String>)> {
            l.rules
                .iter()
                .map(|r| (r.id, r.condition.url_filter.clone()))
                .collect()
        };
        assert_eq!(key(&a), key(&b));
        assert_eq!(
            a.rules.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn regex_rules_are_counted_for_the_platform_budget() {
        let l = lower_text("/track[0-9]+/\n||plain.com^");
        assert_eq!(l.regex_count, 1);
    }
}
