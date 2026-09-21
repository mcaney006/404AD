//! Rule-set optimization.
//!
//! Three passes, each of which strictly preserves matching behaviour:
//!
//! 1. **Domain union** — rules identical except for their document-domain scope
//!    are merged into one rule with the union of those scopes.
//! 2. **Scope subsumption** — if an unscoped rule exists, every scoped rule that
//!    is otherwise identical is redundant and is dropped.
//! 3. **Pattern subsumption** — a broader literal pattern subsumes a narrower
//!    one that contains it, when every other field agrees.
//!
//! Each pass is deterministic: input order never affects the output.

use crate::ir::{CosmeticRule, NetworkRule, Pattern};
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct OptimizeStats {
    pub merged_by_domain: usize,
    pub dropped_scope_subsumed: usize,
    pub dropped_pattern_subsumed: usize,
}

pub fn optimize_network(rules: Vec<NetworkRule>) -> (Vec<NetworkRule>, OptimizeStats) {
    let mut stats = OptimizeStats::default();
    let rules = merge_by_domain(rules, &mut stats);
    let rules = drop_pattern_subsumed(rules, &mut stats);
    (assign_network_ids(rules), stats)
}

/// Pass 1 and 2: group on everything except the initiator-domain scope.
fn merge_by_domain(rules: Vec<NetworkRule>, stats: &mut OptimizeStats) -> Vec<NetworkRule> {
    let mut groups: BTreeMap<String, Vec<NetworkRule>> = BTreeMap::new();
    for rule in rules {
        groups.entry(rule.merge_key()).or_default().push(rule);
    }

    let mut out = Vec::new();
    for (_, mut group) in groups {
        if group.len() == 1 {
            out.push(group.pop().expect("len checked"));
            continue;
        }
        group.sort_by(|a, b| {
            (a.source.list.as_str(), a.source.line).cmp(&(b.source.list.as_str(), b.source.line))
        });

        // An unscoped rule already covers every document, so scoped siblings
        // add nothing.
        if let Some(pos) = group.iter().position(|r| r.initiator_domains.is_empty()) {
            stats.dropped_scope_subsumed += group.len() - 1;
            out.push(group.swap_remove(pos));
            continue;
        }

        stats.merged_by_domain += group.len() - 1;
        let mut merged = group.remove(0);
        for other in group {
            merged.initiator_domains.extend(other.initiator_domains);
        }
        merged.initiator_domains.sort();
        merged.initiator_domains.dedup();
        out.push(merged);
    }
    out
}

/// Pass 3: drop rules whose pattern is strictly narrower than a sibling's.
///
/// Only applied to unscoped, wildcard-free plain patterns, where substring
/// containment is a sound proof of subsumption.
fn drop_pattern_subsumed(rules: Vec<NetworkRule>, stats: &mut OptimizeStats) -> Vec<NetworkRule> {
    let mut buckets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, rule) in rules.iter().enumerate() {
        if !subsumption_eligible(rule) {
            continue;
        }
        buckets.entry(subsumption_key(rule)).or_default().push(i);
    }

    let mut drop = vec![false; rules.len()];
    for (_, idxs) in buckets {
        if idxs.len() < 2 {
            continue;
        }
        // Shortest literal first: a shorter substring matches a superset of URLs.
        let mut sorted = idxs.clone();
        sorted.sort_by_key(|&i| (plain_raw(&rules[i]).len(), plain_raw(&rules[i]).to_string()));
        for (a_pos, &a) in sorted.iter().enumerate() {
            if drop[a] {
                continue;
            }
            for &b in &sorted[a_pos + 1..] {
                if drop[b] {
                    continue;
                }
                if plain_raw(&rules[b]).contains(plain_raw(&rules[a])) {
                    drop[b] = true;
                    stats.dropped_pattern_subsumed += 1;
                }
            }
        }
    }

    rules
        .into_iter()
        .enumerate()
        .filter_map(|(i, r)| (!drop[i]).then_some(r))
        .collect()
}

fn subsumption_eligible(rule: &NetworkRule) -> bool {
    // Exceptions are never merged away: dropping one changes behaviour.
    !rule.exception
        && !rule.is_scoped()
        && rule.excluded_initiator_domains.is_empty()
        && matches!(&rule.pattern, Pattern::Plain { raw } if !raw.contains('*') && !raw.contains('^') && !raw.is_empty())
}

fn plain_raw(rule: &NetworkRule) -> &str {
    match &rule.pattern {
        Pattern::Plain { raw } => raw,
        _ => "",
    }
}

fn subsumption_key(rule: &NetworkRule) -> String {
    format!(
        "{:08x}|{:?}|{:?}|{}|{}|{}",
        rule.types.bits(),
        rule.party,
        rule.modifier,
        u8::from(rule.important),
        u8::from(rule.match_case),
        u8::from(rule.shadow),
    )
}

/// Assign stable ids by sorting on the canonical key.
///
/// Ids are a pure function of rule content, so an unchanged list always
/// compiles to the same ids and the diagnostics map stays valid.
pub fn assign_network_ids(mut rules: Vec<NetworkRule>) -> Vec<NetworkRule> {
    rules.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));
    for (i, rule) in rules.iter_mut().enumerate() {
        rule.id = i as u32 + 1;
    }
    rules
}

pub fn assign_cosmetic_ids(mut rules: Vec<CosmeticRule>) -> Vec<CosmeticRule> {
    rules.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));
    for (i, rule) in rules.iter_mut().enumerate() {
        rule.id = i as u32 + 1;
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedup::dedup;
    use crate::parse::{parse_list, ListSource, ParseOutput};

    fn run(text: &str) -> (Vec<NetworkRule>, OptimizeStats) {
        let mut out = ParseOutput::default();
        parse_list(&ListSource { id: "t", text }, &mut out);
        let (net, _, _) = dedup(out.network, out.cosmetic, &out.badfilters);
        optimize_network(net)
    }

    #[test]
    fn scoped_rules_merge_into_one_domain_union() {
        let (rules, stats) = run("||ads.com^$domain=a.com\n||ads.com^$domain=b.com");
        assert_eq!(rules.len(), 1);
        assert_eq!(
            rules[0].initiator_domains,
            vec!["a.com".to_string(), "b.com".to_string()]
        );
        assert_eq!(stats.merged_by_domain, 1);
    }

    #[test]
    fn unscoped_rule_subsumes_scoped_siblings() {
        let (rules, stats) = run("||ads.com^\n||ads.com^$domain=a.com\n||ads.com^$domain=b.com");
        assert_eq!(rules.len(), 1);
        assert!(rules[0].initiator_domains.is_empty());
        assert_eq!(stats.dropped_scope_subsumed, 2);
    }

    #[test]
    fn broader_literal_subsumes_narrower_one() {
        // Note: `/ads/` would be a *regex* in filter syntax, so use plain text.
        let (rules, stats) = run("banner\nbanner/300\nbanner/300x250");
        assert_eq!(rules.len(), 1, "got {rules:?}");
        assert_eq!(stats.dropped_pattern_subsumed, 2);
    }

    #[test]
    fn exceptions_are_never_subsumed_away() {
        let (rules, _) = run("@@banner\n@@banner/300");
        assert_eq!(rules.len(), 2);
    }

    #[test]
    fn subsumption_respects_resource_type() {
        // Different types match different requests; neither subsumes the other.
        let (rules, _) = run("banner$script\nbanner/300$image");
        assert_eq!(rules.len(), 2);
    }

    #[test]
    fn ids_are_a_pure_function_of_content() {
        let a = run("||b.com^\n||a.com^").0;
        let b = run("||a.com^\n||b.com^").0;
        let ids_a: Vec<_> = a.iter().map(|r| (r.id, r.canonical_key())).collect();
        let ids_b: Vec<_> = b.iter().map(|r| (r.id, r.canonical_key())).collect();
        assert_eq!(ids_a, ids_b);
    }
}
