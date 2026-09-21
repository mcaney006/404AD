#![no_main]
//! The cosmetic index is serialized with postcard and decoded in WASM. A round
//! trip that loses or corrupts data shows up as missing cosmetic filtering with
//! no error anywhere, so it is checked directly.

use fad_filter::cosmetic_index::CosmeticIndex;
use fad_filter::optimize::assign_cosmetic_ids;
use fad_filter::parse::{parse_list, ListSource, ParseOutput};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &str| {
    let mut out = ParseOutput::default();
    parse_list(&ListSource { id: "fuzz", text: data }, &mut out);

    let index = CosmeticIndex::build(&assign_cosmetic_ids(out.cosmetic), "fuzz");

    let bytes = postcard::to_allocvec(&index).expect("index must serialize");
    let decoded: CosmeticIndex = postcard::from_bytes(&bytes).expect("index must decode");
    assert_eq!(index, decoded, "postcard round trip must be lossless");

    // Lookups must not panic on any host shape.
    for host in ["example.com", "a.b.c.example.co.uk", "", ".", "localhost"] {
        let _ = decoded.lookup_host(host);
    }
});
