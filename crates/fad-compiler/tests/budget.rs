//! Performance budgets for lowering, enforced as tests.
//!
//! Lives here rather than in `fad-filter` because `fad-dnr` depends on
//! `fad-filter`, and a crate should not reach back across its own dependency
//! edge even in a dev-dependency.

use fad_filter::parse::ListSource;
use std::time::Instant;

fn synthetic_list(network: usize) -> String {
    let mut text = String::with_capacity(network * 32);
    for i in 0..network {
        text.push_str(&format!("||tracker{i}.example^$third-party\n"));
        if i % 5 == 0 {
            text.push_str(&format!("/ad-unit-{i}/*$script,third-party\n"));
        }
    }
    text
}

#[test]
fn lowering_a_large_rule_set_is_not_the_slow_part() {
    let text = synthetic_list(40_000);
    let compiled = fad_filter::compile(&[ListSource {
        id: "bench",
        text: &text,
    }]);

    let started = Instant::now();
    let lowered = fad_dnr::lower(&compiled.network);
    let elapsed = started.elapsed();

    println!("lower: {} rules in {:?}", lowered.rules.len(), elapsed);
    assert!(elapsed.as_secs_f64() < 3.0, "lowering took {elapsed:?}");
    assert!(lowered.unsupported.is_empty());
}
