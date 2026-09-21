//! Semantic deduplication.
//!
//! Filter lists overlap heavily. Removing byte-identical lines is not enough:
//! `||ads.com^$script,third-party` and `||ads.com^$third-party,script` are the
//! same rule written twice. Deduplication runs on the canonical key, so option
//! ordering, domain ordering, and case differences all collapse.

use crate::ir::{CosmeticRule, NetworkRule};
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DedupStats {
    pub network_in: usize,
    pub network_out: usize,
    pub cosmetic_in: usize,
    pub cosmetic_out: usize,
    pub badfiltered: usize,
}

impl DedupStats {
    pub fn network_removed(&self) -> usize {
        self.network_in - self.network_out
    }
    pub fn cosmetic_removed(&self) -> usize {
        self.cosmetic_in - self.cosmetic_out
    }
}

/// Collapse semantically identical rules and apply `$badfilter` cancellations.
///
/// When duplicates exist the survivor is chosen deterministically: lowest
/// (list, line) pair. That keeps diagnostics stable across runs.
pub fn dedup(
    network: Vec<NetworkRule>,
    cosmetic: Vec<CosmeticRule>,
    badfilters: &[String],
) -> (Vec<NetworkRule>, Vec<CosmeticRule>, DedupStats) {
    let mut stats = DedupStats {
        network_in: network.len(),
        cosmetic_in: cosmetic.len(),
        ..Default::default()
    };

    let cancelled: std::collections::BTreeSet<&str> =
        badfilters.iter().map(String::as_str).collect();

    let mut net_map: BTreeMap<String, NetworkRule> = BTreeMap::new();
    for rule in network {
        let key = rule.canonical_key();
        if cancelled.contains(key.as_str()) {
            stats.badfiltered += 1;
            continue;
        }
        match net_map.get(&key) {
            Some(existing) if source_order(existing) <= source_order(&rule) => {}
            _ => {
                net_map.insert(key, rule);
            }
        }
    }

    let mut cos_map: BTreeMap<String, CosmeticRule> = BTreeMap::new();
    for rule in cosmetic {
        let key = rule.canonical_key();
        match cos_map.get(&key) {
            Some(existing) if cosmetic_source_order(existing) <= cosmetic_source_order(&rule) => {}
            _ => {
                cos_map.insert(key, rule);
            }
        }
    }

    let network: Vec<_> = net_map.into_values().collect();
    let cosmetic: Vec<_> = cos_map.into_values().collect();
    stats.network_out = network.len();
    stats.cosmetic_out = cosmetic.len();
    (network, cosmetic, stats)
}

fn source_order(rule: &NetworkRule) -> (&str, u32) {
    (rule.source.list.as_str(), rule.source.line)
}

fn cosmetic_source_order(rule: &CosmeticRule) -> (&str, u32) {
    (rule.source.list.as_str(), rule.source.line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{parse_list, ListSource, ParseOutput};

    fn compile(text: &str) -> (Vec<NetworkRule>, Vec<CosmeticRule>, DedupStats) {
        let mut out = ParseOutput::default();
        parse_list(&ListSource { id: "t", text }, &mut out);
        dedup(out.network, out.cosmetic, &out.badfilters)
    }

    #[test]
    fn option_order_does_not_create_duplicates() {
        let (net, _, stats) =
            compile("||ads.com^$script,third-party\n||ads.com^$third-party,script");
        assert_eq!(net.len(), 1);
        assert_eq!(stats.network_removed(), 1);
        // The survivor is the first occurrence, so diagnostics stay stable.
        assert_eq!(net[0].source.line, 1);
    }

    #[test]
    fn domain_order_does_not_create_duplicates() {
        let (net, _, _) = compile("||x.com^$domain=b.org|a.org\n||x.com^$domain=a.org|b.org");
        assert_eq!(net.len(), 1);
    }

    #[test]
    fn badfilter_cancels_the_matching_rule() {
        let (net, _, stats) = compile("||ads.com^$script\n||ads.com^$script,badfilter");
        assert!(net.is_empty(), "rule should be cancelled, got {net:?}");
        assert_eq!(stats.badfiltered, 1);
    }

    #[test]
    fn distinct_rules_survive() {
        let (net, _, _) = compile("||ads.com^$script\n||ads.com^$image");
        assert_eq!(net.len(), 2);
    }
}
