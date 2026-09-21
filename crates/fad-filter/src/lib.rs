//! 404AD canonical filter representation.
//!
//! Pipeline: [`parse`] -> [`normalize`] -> [`dedup`] -> [`optimize`] ->
//! [`index`] / [`cosmetic_index`], with [`risk`] annotating every surviving rule
//! and [`matcher`] providing an independent implementation for diagnostics.
//!
//! The whole pipeline is deterministic. Compiling the same inputs twice
//! produces byte-identical output, including rule ids.

pub mod cosmetic_index;
pub mod dedup;
pub mod error;
pub mod index;
pub mod ir;
pub mod matcher;
pub mod normalize;
pub mod optimize;
pub mod parse;
pub mod risk;

pub use cosmetic_index::CosmeticIndex;
pub use error::{BuildError, ParseError};
pub use ir::{
    CosmeticKind, CosmeticRule, Modifier, NetworkRule, ParsedLine, Party, Pattern, Procedural,
    RemoveParam, ResourceTypes, SourceRef,
};
pub use matcher::{Action, Decision, MatchEngine, MatchRequest};
pub use risk::{RiskAssessment, RiskBand};

/// One end-to-end compile of a set of filter lists into the canonical form.
pub struct Compiled {
    pub network: Vec<NetworkRule>,
    pub cosmetic: Vec<CosmeticRule>,
    pub dedup: dedup::DedupStats,
    pub optimize: optimize::OptimizeStats,
    pub errors: Vec<(String, u32, String, ParseError)>,
    pub ignored: u32,
}

/// Parse, normalize, dedup and optimize a set of lists.
pub fn compile(lists: &[parse::ListSource<'_>]) -> Compiled {
    let mut out = parse::ParseOutput::default();
    for list in lists {
        parse::parse_list(list, &mut out);
    }
    let (network, cosmetic, dedup_stats) = dedup::dedup(out.network, out.cosmetic, &out.badfilters);
    let (network, optimize_stats) = optimize::optimize_network(network);
    let cosmetic = optimize::assign_cosmetic_ids(cosmetic);

    Compiled {
        network,
        cosmetic,
        dedup: dedup_stats,
        optimize: optimize_stats,
        errors: out.errors,
        ignored: out.ignored,
    }
}

#[cfg(test)]
mod determinism {
    use super::*;

    const SAMPLE: &str = "\
||doubleclick.net^$third-party
||googlesyndication.com^$third-party
/ads/$script,domain=b.com
/ads/$script,domain=a.com
@@||cdn.example.com^$domain=example.com
example.com##.promo
##.ad-banner
example.com##+js(set-constant, ads, false)
!#shadow on
||candidate-tracker.io^
!#shadow off
";

    fn fingerprint(text: &str) -> String {
        let c = compile(&[parse::ListSource { id: "s", text }]);
        let mut s = String::new();
        for r in &c.network {
            s.push_str(&format!("{}:{}\n", r.id, r.canonical_key()));
        }
        for r in &c.cosmetic {
            s.push_str(&format!("{}:{}\n", r.id, r.canonical_key()));
        }
        s
    }

    #[test]
    fn compilation_is_byte_for_byte_reproducible() {
        assert_eq!(fingerprint(SAMPLE), fingerprint(SAMPLE));
    }

    #[test]
    fn input_line_order_does_not_change_output() {
        let mut lines: Vec<&str> = SAMPLE.lines().collect();
        // Keep the shadow block contiguous; its directives are positional.
        let shadow_at = lines.iter().position(|l| *l == "!#shadow on").unwrap();
        let block: Vec<&str> = lines.drain(shadow_at..shadow_at + 3).collect();
        lines.reverse();
        lines.extend(block);
        assert_eq!(fingerprint(SAMPLE), fingerprint(&lines.join("\n")));
    }

    #[test]
    fn errors_are_collected_not_fatal() {
        let c = compile(&[parse::ListSource {
            id: "s",
            text: "||good.com^\n||bad.com^$popup\n||also-good.com^",
        }]);
        assert_eq!(c.network.len(), 2);
        assert_eq!(c.errors.len(), 1);
        assert_eq!(c.errors[0].1, 2);
    }
}
