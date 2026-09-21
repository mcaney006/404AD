#![no_main]
//! A single filter line must never panic the parser.
//!
//! Filter lists are attacker-adjacent input: a user subscribes to a list, or
//! pastes a rule they found. A panic in the service worker takes the whole
//! extension down until Chromium restarts it.

use fad_filter::ir::SourceRef;
use fad_filter::parse::parse_line;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &str| {
    let source = SourceRef { list: "fuzz".into(), line: 1, raw: data.to_string() };
    // The result is irrelevant; surviving is the property.
    let _ = parse_line(data, source, false);
});
