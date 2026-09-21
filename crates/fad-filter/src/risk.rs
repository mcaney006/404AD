//! Automatic breakage-risk scoring.
//!
//! Every rule gets a 0-100 score estimating how likely it is to break a page if
//! it misfires. The score drives three things: the diagnostics UI, the ordering
//! of the "disable this rule" suggestions when a user reports breakage, and the
//! gate that keeps genuinely dangerous user-written filters in shadow mode until
//! the user confirms them.
//!
//! The model is a transparent additive heuristic, not a classifier. Every term
//! is documented and every term is deterministic.

use crate::ir::{
    CosmeticKind, CosmeticRule, Modifier, NetworkRule, Party, Pattern, RemoveParam, ResourceTypes,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskBand {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskBand {
    pub fn from_score(score: u8) -> Self {
        match score {
            0..=24 => RiskBand::Low,
            25..=54 => RiskBand::Medium,
            55..=79 => RiskBand::High,
            _ => RiskBand::Critical,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RiskAssessment {
    pub score: u8,
    pub band: RiskBand,
    /// Human-readable reasons, in the order they were applied.
    pub factors: Vec<&'static str>,
}

/// Score a network rule.
pub fn score_network(rule: &NetworkRule) -> RiskAssessment {
    let mut score: i32 = 0;
    let mut factors = Vec::new();

    // Exceptions only ever un-block, so they cannot break page rendering.
    if rule.exception {
        return RiskAssessment {
            score: 0,
            band: RiskBand::Low,
            factors: vec!["exception rule"],
        };
    }

    // A rule that cannot stop a request does not get scored like one that can.
    if !matches!(rule.modifier, Modifier::Block) {
        return score_modifier(rule);
    }

    // Blocking the top-level document removes the page entirely. Nothing else
    // a filter can do is worse.
    // Only actions that can actually stop a navigation count here. A
    // `$removeparam` rule covers main_frame by design and is harmless there.
    let blocks_document =
        rule.types.contains(ResourceTypes::MAIN_FRAME) && matches!(rule.modifier, Modifier::Block);
    if blocks_document {
        score += 50;
        factors.push("blocks the top-level document");
    }

    // A rule that names no type is not *targeting* scripts, it simply inherits
    // the default set. Stacking a per-type penalty on it would punish the most
    // common and safest rule shape there is: a plain third-party host block.
    // Explicit type selection is the signal worth scoring.
    if rule.types == ResourceTypes::implicit_default() {
        score += 10;
        factors.push("matches all subresource types");
    } else {
        // Scripts and XHR are where functional breakage concentrates.
        if rule.types.contains(ResourceTypes::SCRIPT) {
            score += 18;
            factors.push("targets scripts");
        }
        if rule.types.contains(ResourceTypes::XHR) {
            score += 16;
            factors.push("targets XHR/fetch");
        }
        if rule.types.contains(ResourceTypes::STYLESHEET) {
            score += 12;
            factors.push("targets stylesheets");
        }
        if rule.types.contains(ResourceTypes::SUB_FRAME) {
            score += 8;
            factors.push("targets subframes");
        }
    }

    // First-party blocking is far riskier than third-party blocking.
    match rule.party {
        Party::Third => {
            score -= 14;
            factors.push("third-party only");
        }
        Party::First => {
            score += 20;
            factors.push("first-party only");
        }
        Party::Any => {
            score += 8;
            factors.push("any party");
        }
    }

    // A short literal matches enormous numbers of unrelated URLs.
    let literal = rule.pattern.literal_len();
    if literal <= 4 {
        score += 30;
        factors.push("very short pattern");
    } else if literal <= 8 {
        score += 16;
        factors.push("short pattern");
    } else if literal >= 20 {
        score -= 10;
        factors.push("long specific pattern");
    }

    if rule.pattern.is_regex() {
        score += 14;
        factors.push("regular expression");
    }
    if matches!(&rule.pattern, Pattern::Plain { raw } if raw.contains('*')) {
        score += 8;
        factors.push("wildcard pattern");
    }

    // `||tracker.example^` names an entire host: unambiguous intent and a
    // bounded blast radius. That confidence does not extend to a rule that
    // also takes down the document served from that host.
    if let Pattern::HostAnchored { host, .. } = &rule.pattern {
        if !blocks_document && host.contains('.') && rule.pattern.literal_len() >= 10 {
            score -= 8;
            factors.push("anchored to a specific host");
        }
    }

    // Scoping a rule to named sites bounds its blast radius.
    if !rule.initiator_domains.is_empty() {
        score -= 22;
        factors.push("scoped to specific sites");
    }
    if !rule.excluded_request_domains.is_empty() {
        score -= 5;
        factors.push("has denyallow carve-outs");
    }

    // `$important` overrides exception rules, including site-specific fixes.
    if rule.important {
        score += 12;
        factors.push("important (overrides exceptions)");
    }

    let score = score.clamp(0, 100) as u8;
    RiskAssessment {
        score,
        band: RiskBand::from_score(score),
        factors,
    }
}

/// Risk model for rules that modify a request rather than stop it.
///
/// None of the blocking terms apply here: pattern breadth and resource type
/// decide *how many* requests are touched, but touching a request with a
/// parameter strip is not comparable to cancelling it. What matters instead is
/// how much of the request the modifier rewrites.
fn score_modifier(rule: &NetworkRule) -> RiskAssessment {
    let mut factors: Vec<&'static str> = Vec::new();
    let mut score: i32 = match &rule.modifier {
        Modifier::RemoveParam(RemoveParam::Keys(_)) => {
            factors.push("strips named query parameters");
            5
        }
        Modifier::RemoveParam(RemoveParam::All) => {
            // Signed URLs and session handoffs live in the query string.
            factors.push("strips the entire query string");
            30
        }
        Modifier::RemoveParam(RemoveParam::ExceptKeys(_)) => {
            factors.push("strips every parameter except an allowlist");
            35
        }
        Modifier::Redirect(_) => {
            factors.push("serves a neutered stub in place of the resource");
            15
        }
        Modifier::Csp(_) => {
            factors.push("injects a Content-Security-Policy header");
            18
        }
        Modifier::GenericHide
        | Modifier::ElemHide
        | Modifier::GenericBlock
        | Modifier::Document => {
            factors.push("relaxes filtering");
            0
        }
        Modifier::Block => unreachable!("handled by the blocking model"),
    };

    if rule.is_scoped() {
        score -= 8;
        factors.push("scoped to specific sites");
    }
    if rule.important {
        score += 10;
        factors.push("important (overrides exceptions)");
    }

    let score = score.clamp(0, 100) as u8;
    RiskAssessment {
        score,
        band: RiskBand::from_score(score),
        factors,
    }
}

/// Score a cosmetic rule. Cosmetic breakage is visual, not functional, so the
/// baseline sits well below network rules.
pub fn score_cosmetic(rule: &CosmeticRule) -> RiskAssessment {
    let mut score: i32 = 0;
    let mut factors = Vec::new();

    match rule.kind {
        CosmeticKind::Unhide | CosmeticKind::UnScriptlet => {
            return RiskAssessment {
                score: 0,
                band: RiskBand::Low,
                factors: vec!["exception rule"],
            }
        }
        CosmeticKind::Scriptlet => {
            score += 35;
            factors.push("runs a scriptlet in the page");
        }
        CosmeticKind::Style => {
            score += 10;
            factors.push("injects a style declaration");
        }
        CosmeticKind::Hide => {}
    }

    if rule.is_generic() {
        score += 28;
        factors.push("applies to every site");
    } else {
        score -= 12;
        factors.push("scoped to specific sites");
    }

    let selector = rule.css_prefix.as_deref().unwrap_or(&rule.payload);
    // Bare element selectors like `div` or `a` hide huge parts of a page.
    if selector.len() <= 4 && !selector.starts_with('.') && !selector.starts_with('#') {
        score += 40;
        factors.push("extremely broad selector");
    }
    if selector.contains('*') {
        score += 15;
        factors.push("universal selector");
    }
    if rule.anchor_token().is_none() && rule.is_generic() {
        score += 20;
        factors.push("no class or id anchor");
    }
    if !rule.procedural.is_empty() {
        score += 6;
        factors.push("procedural selector (runtime cost)");
    }

    let score = score.clamp(0, 100) as u8;
    RiskAssessment {
        score,
        band: RiskBand::from_score(score),
        factors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{ParsedLine, SourceRef};
    use crate::parse::parse_line;

    fn net(line: &str) -> NetworkRule {
        match parse_line(
            line,
            SourceRef {
                list: "t".into(),
                line: 1,
                raw: line.into(),
            },
            false,
        )
        .unwrap()
        {
            ParsedLine::Network(r) => *r,
            _ => panic!("expected network"),
        }
    }
    fn cos(line: &str) -> CosmeticRule {
        match parse_line(
            line,
            SourceRef {
                list: "t".into(),
                line: 1,
                raw: line.into(),
            },
            false,
        )
        .unwrap()
        {
            ParsedLine::Cosmetic(r) => *r,
            _ => panic!("expected cosmetic"),
        }
    }

    #[test]
    fn third_party_tracker_is_low_risk() {
        let a = score_network(&net("||doubleclick.net^$third-party"));
        assert_eq!(a.band, RiskBand::Low, "{a:?}");
    }

    #[test]
    fn blocking_the_document_is_critical() {
        let a = score_network(&net("||example.com^$document"));
        assert!(a.score >= 55, "{a:?}");
    }

    #[test]
    fn short_generic_script_block_outranks_a_scoped_one() {
        let broad = score_network(&net("/ad$script"));
        let scoped = score_network(&net("/ad$script,domain=example.com"));
        assert!(
            broad.score > scoped.score,
            "broad {broad:?} scoped {scoped:?}"
        );
    }

    #[test]
    fn removeparam_is_safer_than_blocking() {
        let block = score_network(&net("||x.com/track^"));
        let strip = score_network(&net("||x.com/track^$removeparam=utm_source"));
        assert!(strip.score < block.score);
    }

    #[test]
    fn stripping_the_whole_query_outranks_stripping_named_keys() {
        let named = score_network(&net("$removeparam=utm_source"));
        let all = score_network(&net("||x.com/t^$removeparam"));
        assert!(all.score > named.score, "named {named:?} all {all:?}");
    }

    #[test]
    fn generic_bare_element_selector_is_critical() {
        let a = score_cosmetic(&cos("##div"));
        assert_eq!(a.band, RiskBand::Critical, "{a:?}");
    }

    #[test]
    fn scoped_class_selector_is_low() {
        let a = score_cosmetic(&cos("example.com##.ad-slot-container"));
        assert_eq!(a.band, RiskBand::Low, "{a:?}");
    }

    #[test]
    fn removeparam_on_navigations_is_not_treated_as_document_blocking() {
        let a = score_network(&net("$removeparam=utm_source"));
        assert!(
            !a.factors.contains(&"blocks the top-level document"),
            "stripping a parameter does not stop a navigation: {a:?}"
        );
        assert_eq!(a.band, RiskBand::Low, "{a:?}");
    }

    #[test]
    fn a_plain_host_block_is_not_punished_for_default_types() {
        // The most common safe rule shape must not score like a targeted
        // script block just because it inherits every subresource type.
        let implicit = score_network(&net("||tracker.example^$third-party"));
        let explicit = score_network(&net("||tracker.example^$third-party,script,xmlhttprequest"));
        assert!(
            implicit.score < explicit.score,
            "implicit {implicit:?} explicit {explicit:?}"
        );
    }

    #[test]
    fn bands_are_monotonic_in_score() {
        let mut prev = RiskBand::Low;
        for s in 0u8..=100 {
            let b = RiskBand::from_score(s);
            assert!(b >= prev);
            prev = b;
        }
    }
}
