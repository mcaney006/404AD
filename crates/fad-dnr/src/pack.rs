//! Ruleset packing.
//!
//! Chromium enforces hard ceilings on static rules, regex rules and enabled
//! rulesets. Blowing through any of them is a load-time failure with an opaque
//! message, so the packer enforces them here, where the error can name the
//! offending category.
//!
//! Packing is deterministic: rules are grouped by category in sorted order, and
//! each category is split into fixed-size chunks.

use crate::{limits, DnrRule};
use serde::Serialize;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum PackError {
    #[error("{count} static rules exceeds the Chromium guaranteed minimum of {limit}")]
    TooManyRules { count: usize, limit: usize },
    #[error("{count} regex rules exceeds the Chromium limit of {limit}")]
    TooManyRegex { count: usize, limit: usize },
    #[error("{count} enabled rulesets exceeds the Chromium limit of {limit}")]
    TooManyRulesets { count: usize, limit: usize },
}

/// One emitted ruleset file plus the manifest entry that declares it.
#[derive(Debug, Clone, Serialize)]
pub struct Ruleset {
    pub id: String,
    pub path: String,
    pub enabled: bool,
    #[serde(skip)]
    pub rules: Vec<DnrRule>,
}

/// Manifest shape for `declarative_net_request.rule_resources`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleResource {
    pub id: String,
    pub enabled: bool,
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PackStats {
    pub total_rules: usize,
    pub enabled_rules: usize,
    pub regex_rules: usize,
    pub ruleset_count: usize,
    pub enabled_ruleset_count: usize,
    pub per_category: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Packed {
    pub rulesets: Vec<Ruleset>,
    pub stats: PackStats,
}

impl Packed {
    pub fn rule_resources(&self) -> Vec<RuleResource> {
        self.rulesets
            .iter()
            .map(|r| RuleResource {
                id: r.id.clone(),
                enabled: r.enabled,
                path: r.path.clone(),
            })
            .collect()
    }
}

/// Split categorised rules into ruleset files.
///
/// `rules` pairs each lowered rule with the category it belongs to.
/// `enabled` decides which categories ship switched on.
pub fn pack(
    rules: Vec<(DnrRule, String)>,
    enabled: &BTreeMap<String, bool>,
    rules_dir: &str,
) -> Result<Packed, PackError> {
    let mut by_category: BTreeMap<String, Vec<DnrRule>> = BTreeMap::new();
    for (rule, category) in rules {
        by_category.entry(category).or_default().push(rule);
    }

    let mut stats = PackStats::default();
    let mut rulesets: Vec<Ruleset> = Vec::new();

    for (category, mut rules) in by_category {
        // Ids were already assigned globally and are unique; sorting keeps the
        // emitted JSON stable regardless of how the categories interleaved.
        rules.sort_by_key(|r| r.id);
        stats.per_category.insert(category.clone(), rules.len());
        let is_enabled = enabled.get(&category).copied().unwrap_or(true);

        for (chunk_idx, chunk) in rules.chunks(limits::RULES_PER_FILE).enumerate() {
            let id = if chunk_idx == 0 {
                category.clone()
            } else {
                format!("{category}-{chunk_idx}")
            };
            stats.total_rules += chunk.len();
            stats.regex_rules += chunk
                .iter()
                .filter(|r| r.condition.regex_filter.is_some())
                .count();
            if is_enabled {
                stats.enabled_rules += chunk.len();
                stats.enabled_ruleset_count += 1;
            }
            rulesets.push(Ruleset {
                path: format!("{rules_dir}/{id}.json"),
                id,
                enabled: is_enabled,
                rules: chunk.to_vec(),
            });
        }
    }

    stats.ruleset_count = rulesets.len();

    if stats.enabled_rules > limits::STATIC_RULES {
        return Err(PackError::TooManyRules {
            count: stats.enabled_rules,
            limit: limits::STATIC_RULES,
        });
    }
    if stats.regex_rules > limits::REGEX_RULES {
        return Err(PackError::TooManyRegex {
            count: stats.regex_rules,
            limit: limits::REGEX_RULES,
        });
    }
    if stats.enabled_ruleset_count > limits::ENABLED_RULESETS {
        return Err(PackError::TooManyRulesets {
            count: stats.enabled_ruleset_count,
            limit: limits::ENABLED_RULESETS,
        });
    }

    Ok(Packed { rulesets, stats })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActionKind, DnrAction, DnrCondition};

    fn rule(id: u32, regex: bool) -> DnrRule {
        DnrRule {
            id,
            priority: 10,
            action: DnrAction {
                kind: ActionKind::Block,
                redirect: None,
                response_headers: None,
            },
            condition: DnrCondition {
                url_filter: (!regex).then(|| format!("||host{id}.com^")),
                regex_filter: regex.then(|| format!("host{id}")),
                ..Default::default()
            },
        }
    }

    fn enabled_all() -> BTreeMap<String, bool> {
        BTreeMap::new()
    }

    #[test]
    fn categories_become_separate_rulesets() {
        let input = vec![
            (rule(1, false), "ads".to_string()),
            (rule(2, false), "tracking".to_string()),
            (rule(3, false), "ads".to_string()),
        ];
        let p = pack(input, &enabled_all(), "rules").unwrap();
        assert_eq!(p.rulesets.len(), 2);
        assert_eq!(p.rulesets[0].id, "ads");
        assert_eq!(p.rulesets[0].rules.len(), 2);
        assert_eq!(p.rulesets[1].id, "tracking");
        assert_eq!(p.stats.per_category["ads"], 2);
    }

    #[test]
    fn oversized_categories_split_into_numbered_chunks() {
        let input: Vec<_> = (1..=limits::RULES_PER_FILE as u32 + 10)
            .map(|i| (rule(i, false), "ads".to_string()))
            .collect();
        let p = pack(input, &enabled_all(), "rules").unwrap();
        assert_eq!(p.rulesets.len(), 2);
        assert_eq!(p.rulesets[0].id, "ads");
        assert_eq!(p.rulesets[1].id, "ads-1");
        assert_eq!(p.rulesets[1].rules.len(), 10);
    }

    #[test]
    fn disabled_categories_do_not_count_against_the_enabled_budget() {
        let input: Vec<_> = (1..=100)
            .map(|i| (rule(i, false), "annoyances".to_string()))
            .collect();
        let mut enabled = BTreeMap::new();
        enabled.insert("annoyances".to_string(), false);
        let p = pack(input, &enabled, "rules").unwrap();
        assert_eq!(p.stats.total_rules, 100);
        assert_eq!(p.stats.enabled_rules, 0);
        assert_eq!(p.stats.enabled_ruleset_count, 0);
        assert!(!p.rulesets[0].enabled);
    }

    #[test]
    fn the_regex_ceiling_is_enforced() {
        let input: Vec<_> = (1..=limits::REGEX_RULES as u32 + 1)
            .map(|i| (rule(i, true), "ads".to_string()))
            .collect();
        let err = pack(input, &enabled_all(), "rules").unwrap_err();
        assert!(matches!(err, PackError::TooManyRegex { .. }), "{err:?}");
    }

    #[test]
    fn the_static_rule_ceiling_is_enforced() {
        let input: Vec<_> = (1..=limits::STATIC_RULES as u32 + 1)
            .map(|i| (rule(i, false), format!("cat{}", i % 40)))
            .collect();
        let err = pack(input, &enabled_all(), "rules").unwrap_err();
        assert!(matches!(err, PackError::TooManyRules { .. }), "{err:?}");
    }

    #[test]
    fn packing_is_deterministic_regardless_of_input_order() {
        let mut a = vec![
            (rule(3, false), "b".to_string()),
            (rule(1, false), "a".to_string()),
            (rule(2, false), "b".to_string()),
        ];
        let b = {
            let mut v = a.clone();
            v.reverse();
            v
        };
        a.rotate_left(1);
        let pa = pack(a, &enabled_all(), "rules").unwrap();
        let pb = pack(b, &enabled_all(), "rules").unwrap();
        let ids = |p: &Packed| -> Vec<(String, Vec<u32>)> {
            p.rulesets
                .iter()
                .map(|r| (r.id.clone(), r.rules.iter().map(|x| x.id).collect()))
                .collect()
        };
        assert_eq!(ids(&pa), ids(&pb));
    }
}
