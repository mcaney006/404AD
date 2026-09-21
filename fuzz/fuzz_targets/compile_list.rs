#![no_main]
//! The whole compile pipeline must survive arbitrary list text, and its output
//! must stay lowerable to valid DNR JSON.

use fad_filter::parse::ListSource;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &str| {
    let compiled = fad_filter::compile(&[ListSource { id: "fuzz", text: data }]);

    // Ids must always be dense and one-based, whatever the input did.
    for (index, rule) in compiled.network.iter().enumerate() {
        assert_eq!(rule.id, index as u32 + 1, "network ids must stay dense");
    }
    for (index, rule) in compiled.cosmetic.iter().enumerate() {
        assert_eq!(rule.id, index as u32 + 1, "cosmetic ids must stay dense");
    }

    // Everything that lowers must serialize; Chromium rejects the ruleset
    // otherwise and the failure is opaque at load time.
    let lowered = fad_dnr::lower(&compiled.network);
    for rule in &lowered.rules {
        serde_json::to_vec(rule).expect("every lowered rule must serialize");
        assert!(rule.id >= 1, "DNR rule ids are one-based");
        assert!(
            rule.condition.url_filter.is_some() || rule.condition.regex_filter.is_some(),
            "a DNR rule needs something to match on",
        );
    }
});
