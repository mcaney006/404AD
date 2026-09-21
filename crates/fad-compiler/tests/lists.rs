//! Quality gates on the shipped filter lists.
//!
//! These run against `lists/` itself, not against synthetic input. They are the
//! difference between "the compiler works" and "the lists we actually ship are
//! safe to enable by default".

use fad_filter::parse::ListSource;
use fad_filter::risk::{self, RiskBand};
use fad_filter::{CosmeticKind, ResourceTypes};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn lists_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lists")
}

struct Loaded {
    ids: Vec<String>,
    texts: Vec<(String, String)>,
}

fn load() -> Loaded {
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(lists_dir().join("manifest.json")).unwrap())
            .unwrap();
    let entries = manifest["lists"].as_array().unwrap();

    let mut ids = Vec::new();
    let mut texts = Vec::new();
    for entry in entries {
        let id = entry["id"].as_str().unwrap().to_string();
        let file = entry["file"].as_str().unwrap();
        let text =
            fs::read_to_string(lists_dir().join(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
        ids.push(id.clone());
        texts.push((id, text));
    }
    Loaded { ids, texts }
}

/// Ids of the lists that ship switched on.
fn enabled_lists() -> Vec<String> {
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(lists_dir().join("manifest.json")).unwrap())
            .unwrap();
    manifest["lists"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["enabled"].as_bool().unwrap_or(true))
        .map(|e| e["id"].as_str().unwrap().to_string())
        .collect()
}

fn compile() -> fad_filter::Compiled {
    let loaded = load();
    let sources: Vec<ListSource<'_>> = loaded
        .texts
        .iter()
        .map(|(id, text)| ListSource { id, text })
        .collect();
    fad_filter::compile(&sources)
}

#[test]
fn every_list_named_in_the_manifest_exists_and_parses() {
    let loaded = load();
    assert!(!loaded.ids.is_empty(), "the manifest declares no lists");
    let mut seen = BTreeMap::new();
    for id in &loaded.ids {
        assert!(
            seen.insert(id.clone(), ()).is_none(),
            "duplicate list id {id}"
        );
    }
}

#[test]
fn the_shipped_lists_have_no_parse_errors() {
    let compiled = compile();
    assert!(
        compiled.errors.is_empty(),
        "shipped lists must parse cleanly; got {:#?}",
        compiled.errors
    );
}

#[test]
fn every_rule_lowers_to_valid_dnr() {
    let compiled = compile();
    let lowered = fad_dnr::lower(&compiled.network);
    assert!(
        lowered.unsupported.is_empty(),
        "a shipped rule cannot be expressed in MV3: {:#?}",
        lowered.unsupported
    );
    for rule in &lowered.rules {
        serde_json::to_vec(rule).expect("every rule must serialize");
    }
}

#[test]
fn no_shipped_rule_uses_a_regex() {
    // Regex rules are capped at 1,000 by Chromium and are the slowest thing the
    // matcher can do. Zero is the target, and a rule that needs one should be
    // rewritten rather than silently spending the budget.
    let compiled = compile();
    let regexes: Vec<&str> = compiled
        .network
        .iter()
        .filter(|r| r.pattern.is_regex())
        .map(|r| r.source.raw.as_str())
        .collect();
    assert!(
        regexes.is_empty(),
        "shipped lists must not use regex rules: {regexes:#?}"
    );
}

#[test]
fn generic_cosmetic_selectors_are_anchored_and_specific() {
    // A generic selector with no class or id token is injected on every page.
    // A short class token collides with utility classes on sites nobody tested.
    // Both are how a cosmetic list starts breaking pages it has never heard of.
    //
    // Ids get a lower floor than classes on purpose: an id is unique within a
    // document and `#ads` is unambiguous, whereas a class named `ad` shows up
    // inside unrelated design systems.
    //
    // A list that ships DISABLED is exempt. The annoyances list deliberately
    // overrides `body { overflow }` to undo a modal's scroll lock, which is
    // exactly the kind of blunt instrument a user opts into rather than
    // inherits.
    const MIN_CLASS_LEN: usize = 6;
    const MIN_ID_LEN: usize = 3;

    let enabled = enabled_lists();
    let compiled = compile();
    let mut offenders = Vec::new();

    for rule in compiled.cosmetic.iter().filter(|r| r.is_generic()) {
        if !enabled.contains(&rule.source.list) {
            continue;
        }
        if matches!(rule.kind, CosmeticKind::Unhide | CosmeticKind::UnScriptlet) {
            continue;
        }
        let where_ = format!("{}:{}", rule.source.list, rule.source.line);
        match rule.anchor_token() {
            None => offenders.push(format!(
                "{where_} has no class or id anchor: {}",
                rule.source.raw
            )),
            Some(token) => {
                // The token carries its leading `.` or `#`.
                let floor = if token.starts_with('#') {
                    MIN_ID_LEN
                } else {
                    MIN_CLASS_LEN
                };
                if token.len() < floor + 1 {
                    offenders.push(format!(
                        "{where_} anchor `{token}` is shorter than {floor} characters: {}",
                        rule.source.raw
                    ));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "brittle generic selectors:\n{}",
        offenders.join("\n")
    );
}

#[test]
fn no_shipped_rule_is_rated_critical() {
    let compiled = compile();
    let mut offenders = Vec::new();

    for rule in &compiled.network {
        let assessment = risk::score_network(rule);
        if assessment.band == RiskBand::Critical {
            offenders.push(format!(
                "{}:{} scored {} ({:?}): {} [{}]",
                rule.source.list,
                rule.source.line,
                assessment.score,
                assessment.band,
                rule.source.raw,
                assessment.reasons().join(", ")
            ));
        }
    }
    for rule in &compiled.cosmetic {
        let assessment = risk::score_cosmetic(rule);
        if assessment.band == RiskBand::Critical {
            offenders.push(format!(
                "{}:{} scored {} ({:?}): {} [{}]",
                rule.source.list,
                rule.source.line,
                assessment.score,
                assessment.band,
                rule.source.raw,
                assessment.reasons().join(", ")
            ));
        }
    }
    assert!(
        offenders.is_empty(),
        "critical-risk rules ship enabled:\n{}",
        offenders.join("\n")
    );
}

#[test]
fn no_unqualified_rule_can_block_a_top_level_document() {
    let compiled = compile();
    let offenders: Vec<&str> = compiled
        .network
        .iter()
        .filter(|r| {
            !r.exception
                && matches!(r.modifier, fad_filter::Modifier::Block)
                && r.types.contains(ResourceTypes::MAIN_FRAME)
        })
        .map(|r| r.source.raw.as_str())
        .collect();
    assert!(
        offenders.is_empty(),
        "a shipped rule would block a whole page: {offenders:#?}"
    );
}

#[test]
fn the_enabled_rule_set_fits_inside_chromium_budgets() {
    let compiled = compile();
    let lowered = fad_dnr::lower(&compiled.network);
    assert!(
        lowered.rules.len() <= fad_dnr::limits::STATIC_RULES,
        "{} rules exceeds the {} static-rule ceiling",
        lowered.rules.len(),
        fad_dnr::limits::STATIC_RULES
    );
    assert!(lowered.regex_count <= fad_dnr::limits::REGEX_RULES);
}

#[test]
fn shadow_rules_can_never_outrank_a_real_block() {
    use fad_filter::matcher::{match_priority, priority};
    let compiled = compile();
    let shadow: Vec<_> = compiled.network.iter().filter(|r| r.shadow).collect();
    assert!(
        !shadow.is_empty(),
        "the candidate list should contain shadow rules"
    );

    let lowest_real = compiled
        .network
        .iter()
        .filter(|r| !r.shadow)
        .map(match_priority)
        .min()
        .expect("there are enforced rules");

    for rule in shadow {
        let p = match_priority(rule);
        assert_eq!(p, priority::SHADOW, "{}", rule.source.raw);
        assert!(
            p < lowest_real,
            "a shadow rule outranks an enforced one: {}",
            rule.source.raw
        );
    }
}
