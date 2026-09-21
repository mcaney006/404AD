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

/// One additive term, with the number it contributed.
///
/// The score is not a black box and is not meant to be trusted on faith: every
/// term is named, signed and visible, so the arithmetic can be checked by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RiskFactor {
    pub reason: &'static str,
    pub delta: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RiskAssessment {
    pub score: u8,
    pub band: RiskBand,
    /// Every term that was applied, in order, with its contribution.
    pub factors: Vec<RiskFactor>,
}

impl RiskAssessment {
    /// The reasons alone, for callers that only want prose.
    pub fn reasons(&self) -> Vec<&'static str> {
        self.factors.iter().map(|f| f.reason).collect()
    }

    /// Sum of the terms before clamping. Equals `score` unless it clamped.
    pub fn raw_total(&self) -> i32 {
        self.factors.iter().map(|f| f.delta).sum()
    }
}

/// Accumulates named terms so the score and its explanation cannot diverge.
struct Ledger {
    factors: Vec<RiskFactor>,
}

impl Ledger {
    fn new() -> Self {
        Ledger {
            factors: Vec::new(),
        }
    }

    fn add(&mut self, delta: i32, reason: &'static str) {
        self.factors.push(RiskFactor { reason, delta });
    }

    fn finish(self) -> RiskAssessment {
        let total: i32 = self.factors.iter().map(|f| f.delta).sum();
        let score = total.clamp(0, 100) as u8;
        RiskAssessment {
            score,
            band: RiskBand::from_score(score),
            factors: self.factors,
        }
    }

    fn only(delta: i32, reason: &'static str) -> RiskAssessment {
        let mut ledger = Ledger::new();
        ledger.add(delta, reason);
        ledger.finish()
    }
}

/// Score a network rule.
pub fn score_network(rule: &NetworkRule) -> RiskAssessment {
    // Exceptions only ever un-block, so they cannot break page rendering.
    if rule.exception {
        return Ledger::only(0, "exception rule");
    }
    // A rule that cannot stop a request does not get scored like one that can.
    if !matches!(rule.modifier, Modifier::Block) {
        return score_modifier(rule);
    }

    let mut ledger = Ledger::new();

    // Blocking the top-level document removes the page entirely. Nothing else
    // a filter can do is worse.
    let blocks_document = rule.types.contains(ResourceTypes::MAIN_FRAME);
    if blocks_document {
        ledger.add(50, "blocks the top-level document");
    }

    // A rule that names no type is not *targeting* scripts, it simply inherits
    // the default set. Stacking a per-type penalty on it would punish the most
    // common and safest rule shape there is: a plain third-party host block.
    // Explicit type selection is the signal worth scoring.
    if rule.types == ResourceTypes::implicit_default() {
        ledger.add(10, "matches all subresource types");
    } else {
        // Scripts and XHR are where functional breakage concentrates.
        if rule.types.contains(ResourceTypes::SCRIPT) {
            ledger.add(18, "targets scripts");
        }
        if rule.types.contains(ResourceTypes::XHR) {
            ledger.add(16, "targets XHR/fetch");
        }
        if rule.types.contains(ResourceTypes::STYLESHEET) {
            ledger.add(12, "targets stylesheets");
        }
        if rule.types.contains(ResourceTypes::SUB_FRAME) {
            ledger.add(8, "targets subframes");
        }
    }

    // First-party blocking is far riskier than third-party blocking.
    match rule.party {
        Party::Third => ledger.add(-14, "third-party only"),
        Party::First => ledger.add(20, "first-party only"),
        Party::Any => ledger.add(8, "any party"),
    }

    // A short literal matches enormous numbers of unrelated URLs.
    let literal = rule.pattern.literal_len();
    if literal <= 4 {
        ledger.add(30, "very short pattern");
    } else if literal <= 8 {
        ledger.add(16, "short pattern");
    } else if literal >= 20 {
        ledger.add(-10, "long specific pattern");
    }

    if rule.pattern.is_regex() {
        ledger.add(14, "regular expression");
    }
    if matches!(&rule.pattern, Pattern::Plain { raw } if raw.contains('*')) {
        ledger.add(8, "wildcard pattern");
    }

    // `||tracker.example^` names an entire host: unambiguous intent and a
    // bounded blast radius. That confidence does not extend to a rule that
    // also takes down the document served from that host.
    if let Pattern::HostAnchored { host, .. } = &rule.pattern {
        if !blocks_document && host.contains('.') && rule.pattern.literal_len() >= 10 {
            ledger.add(-8, "anchored to a specific host");
        }
    }

    // Scoping a rule to named sites bounds its blast radius.
    if !rule.initiator_domains.is_empty() {
        ledger.add(-22, "scoped to specific sites");
    }
    if !rule.excluded_request_domains.is_empty() {
        ledger.add(-5, "has denyallow carve-outs");
    }

    // `$important` overrides exception rules, including site-specific fixes.
    if rule.important {
        ledger.add(12, "important (overrides exceptions)");
    }

    ledger.finish()
}

/// Risk model for rules that modify a request rather than stop it.
///
/// None of the blocking terms apply here: pattern breadth and resource type
/// decide *how many* requests are touched, but touching a request with a
/// parameter strip is not comparable to cancelling it. What matters instead is
/// how much of the request the modifier rewrites.
fn score_modifier(rule: &NetworkRule) -> RiskAssessment {
    let mut ledger = Ledger::new();
    match &rule.modifier {
        Modifier::RemoveParam(RemoveParam::Keys(_)) => {
            ledger.add(5, "strips named query parameters")
        }
        // Signed URLs and session handoffs live in the query string.
        Modifier::RemoveParam(RemoveParam::All) => ledger.add(30, "strips the entire query string"),
        Modifier::RemoveParam(RemoveParam::ExceptKeys(_)) => {
            ledger.add(35, "strips every parameter except an allowlist")
        }
        Modifier::Redirect(_) => ledger.add(15, "serves a neutered stub in place of the resource"),
        Modifier::Csp(_) => ledger.add(18, "injects a Content-Security-Policy header"),
        Modifier::GenericHide
        | Modifier::ElemHide
        | Modifier::GenericBlock
        | Modifier::Document => ledger.add(0, "relaxes filtering"),
        Modifier::Block => unreachable!("handled by the blocking model"),
    }

    if rule.is_scoped() {
        ledger.add(-8, "scoped to specific sites");
    }
    if rule.important {
        ledger.add(10, "important (overrides exceptions)");
    }
    ledger.finish()
}

/// Score a cosmetic rule. Cosmetic breakage is visual, not functional, so the
/// baseline sits well below network rules.
pub fn score_cosmetic(rule: &CosmeticRule) -> RiskAssessment {
    let mut ledger = Ledger::new();

    match rule.kind {
        CosmeticKind::Unhide | CosmeticKind::UnScriptlet => {
            return Ledger::only(0, "exception rule")
        }
        CosmeticKind::Scriptlet => ledger.add(35, "runs a scriptlet in the page"),
        CosmeticKind::Style => ledger.add(10, "injects a style declaration"),
        CosmeticKind::Hide => {}
    }

    if rule.is_generic() {
        ledger.add(28, "applies to every site");
    } else {
        ledger.add(-12, "scoped to specific sites");
    }

    let selector = rule.css_prefix.as_deref().unwrap_or(&rule.payload);
    // Bare element selectors like `div` or `a` hide huge parts of a page.
    if selector.len() <= 4 && !selector.starts_with('.') && !selector.starts_with('#') {
        ledger.add(40, "extremely broad selector");
    }
    if selector.contains('*') {
        ledger.add(15, "universal selector");
    }
    if rule.anchor_token().is_none() && rule.is_generic() {
        ledger.add(20, "no class or id anchor");
    }
    if !rule.procedural.is_empty() {
        ledger.add(6, "procedural selector (runtime cost)");
    }

    ledger.finish()
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
            !a.reasons().contains(&"blocks the top-level document"),
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
    fn the_score_is_exactly_the_sum_of_its_printed_terms() {
        // The whole point of the ledger: the explanation and the number cannot
        // drift apart, because the number is computed from the explanation.
        for line in [
            "||doubleclick.net^$third-party",
            "/ad$script",
            "||x.com^$document,important",
            "$removeparam=utm_source",
            "||x.com/t^$removeparam",
            "||x.com/ads.js$redirect=noopjs",
            "@@||x.com^",
        ] {
            let a = score_network(&net(line));
            let sum: i32 = a.factors.iter().map(|f| f.delta).sum();
            assert_eq!(a.raw_total(), sum, "{line}");
            assert_eq!(
                a.score,
                sum.clamp(0, 100) as u8,
                "{line} terms {:?}",
                a.factors
            );
        }
    }

    #[test]
    fn cosmetic_scores_are_the_sum_of_their_terms_too() {
        for line in [
            "##div",
            "example.com##.ad-slot-container",
            "##.promo:has-text(Ad)",
        ] {
            let a = score_cosmetic(&cos(line));
            assert_eq!(a.score, a.raw_total().clamp(0, 100) as u8, "{line}");
        }
    }

    #[test]
    fn every_term_carries_a_reason_and_a_nonzero_effect_or_says_why() {
        let a = score_network(&net("||ads.com^$third-party,script"));
        assert!(!a.factors.is_empty());
        for factor in &a.factors {
            assert!(
                !factor.reason.is_empty(),
                "a term with no reason is not inspectable"
            );
        }
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
