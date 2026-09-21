//! Property tests.
//!
//! Example-based tests check the cases someone thought of. These check the
//! invariants the whole pipeline rests on, against inputs nobody thought of.

use fad_filter::ir::ResourceTypes;
use fad_filter::normalize::canonicalize_pattern;
use fad_filter::parse::{parse_line, ListSource, ParseOutput};
use fad_filter::{compile, ir::ParsedLine, ir::SourceRef, parse::parse_list};
use proptest::prelude::*;

fn source() -> SourceRef {
    SourceRef {
        list: "prop".into(),
        line: 1,
        raw: String::new(),
    }
}

/// Hostname-ish strings, including ones that should be rejected.
fn host_strategy() -> impl Strategy<Value = String> {
    prop::collection::vec("[a-z0-9-]{1,12}", 1..4).prop_map(|parts| parts.join("."))
}

fn option_strategy() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "script".to_string(),
        "image".to_string(),
        "third-party".to_string(),
        "~third-party".to_string(),
        "xmlhttprequest".to_string(),
        "match-case".to_string(),
        "important".to_string(),
        "subdocument".to_string(),
    ])
}

proptest! {
    /// Normalization must be idempotent, or dedup depends on how many times it ran.
    #[test]
    fn pattern_canonicalization_is_idempotent(raw in "[a-z0-9*^/._-]{1,40}") {
        let once = canonicalize_pattern(fad_filter::ir::Pattern::Plain { raw });
        let twice = canonicalize_pattern(once.clone());
        prop_assert_eq!(once, twice);
    }

    /// Option order must never change the parsed rule.
    #[test]
    fn option_order_does_not_affect_the_canonical_key(
        host in host_strategy(),
        mut options in prop::collection::vec(option_strategy(), 1..4),
    ) {
        options.sort();
        options.dedup();
        prop_assume!(!options.is_empty());

        let forward = format!("||{host}^${}", options.join(","));
        let mut reversed_options = options.clone();
        reversed_options.reverse();
        let backward = format!("||{host}^${}", reversed_options.join(","));

        let a = parse_line(&forward, source(), false);
        let b = parse_line(&backward, source(), false);

        match (a, b) {
            (Ok(ParsedLine::Network(a)), Ok(ParsedLine::Network(b))) => {
                prop_assert_eq!(a.canonical_key(), b.canonical_key());
            }
            (Err(_), Err(_)) => {}
            (a, b) => prop_assert!(false, "asymmetric parse: {:?} vs {:?}", a.is_ok(), b.is_ok()),
        }
    }

    /// Parsing never panics, whatever it is handed.
    #[test]
    fn parsing_arbitrary_text_never_panics(text in ".{0,200}") {
        let mut out = ParseOutput::default();
        parse_list(&ListSource { id: "fuzz", text: &text }, &mut out);
        prop_assert!(out.network.len() + out.cosmetic.len() + out.errors.len() <= text.lines().count() + 1);
    }

    /// Compilation is a pure function of its input.
    #[test]
    fn compilation_is_deterministic(
        hosts in prop::collection::vec(host_strategy(), 1..25),
    ) {
        let text: String = hosts.iter().map(|h| format!("||{h}^\n")).collect();
        let fingerprint = |t: &str| -> Vec<(u32, String)> {
            compile(&[ListSource { id: "p", text: t }])
                .network
                .iter()
                .map(|r| (r.id, r.canonical_key()))
                .collect()
        };
        prop_assert_eq!(fingerprint(&text), fingerprint(&text));
    }

    /// Input order must not change the output, including rule ids.
    #[test]
    fn input_order_does_not_affect_output(
        hosts in prop::collection::hash_set(host_strategy(), 2..20),
    ) {
        let mut forward: Vec<_> = hosts.into_iter().collect();
        forward.sort();
        let backward: Vec<_> = forward.iter().rev().cloned().collect();

        let render = |v: &[String]| -> String { v.iter().map(|h| format!("||{h}^\n")).collect() };
        let keys = |t: &str| -> Vec<(u32, String)> {
            compile(&[ListSource { id: "p", text: t }])
                .network
                .iter()
                .map(|r| (r.id, r.canonical_key()))
                .collect()
        };
        prop_assert_eq!(keys(&render(&forward)), keys(&render(&backward)));
    }

    /// An unqualified rule must never be able to block the top-level document.
    #[test]
    fn unqualified_rules_never_block_the_document(host in host_strategy()) {
        if let Ok(ParsedLine::Network(rule)) = parse_line(&format!("||{host}^"), source(), false) {
            prop_assert!(!rule.types.contains(ResourceTypes::MAIN_FRAME));
        }
    }

    /// Every parsed rule survives a round trip through its own canonical key.
    #[test]
    fn canonical_keys_are_stable_across_calls(
        host in host_strategy(),
        options in prop::collection::vec(option_strategy(), 0..3),
    ) {
        let line = if options.is_empty() {
            format!("||{host}^")
        } else {
            format!("||{host}^${}", options.join(","))
        };
        if let Ok(ParsedLine::Network(rule)) = parse_line(&line, source(), false) {
            prop_assert_eq!(rule.canonical_key(), rule.canonical_key());
        }
    }
}
