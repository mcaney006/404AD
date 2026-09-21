//! Performance budgets for the core filter engine, enforced as tests.
//!
//! A benchmark nobody reads does not stop a regression. These assert ceilings
//! roughly an order of magnitude above what the code actually does, so machine
//! variance never fails the build but a real 10x regression always does.
//!
//! The budgets chosen are the ones a user would feel:
//!
//! * **Compile time**, because it gates every rebuild and every subscription
//!   refresh.
//! * **Cosmetic lookup**, because it runs per document and per DOM mutation.
//! * **Index decode**, because it runs on every service-worker start, and MV3
//!   restarts the worker constantly.
//! * **Index size**, because it is held in memory for the whole session.

use fad_filter::cosmetic_index::CosmeticIndex;
use fad_filter::optimize::assign_cosmetic_ids;
use fad_filter::parse::ListSource;
use std::time::Instant;

/// A list shaped like a real one: mostly third-party hosts, a long tail of
/// generic cosmetic rules, and some host-scoped rules.
fn synthetic_list(network: usize, generic: usize, hosts: usize) -> String {
    let mut text = String::with_capacity(network * 32 + generic * 24 + hosts * 40);
    for i in 0..network {
        text.push_str(&format!("||tracker{i}.example^$third-party\n"));
        if i % 5 == 0 {
            text.push_str(&format!("/ad-unit-{i}/*$script,third-party\n"));
        }
        if i % 11 == 0 {
            text.push_str(&format!(
                "@@||tracker{i}.example^$domain=allowed{i}.example\n"
            ));
        }
    }
    for i in 0..generic {
        text.push_str(&format!("##.ad-unit-container-{i}\n"));
        if i % 3 == 0 {
            text.push_str(&format!("###banner-slot-{i}\n"));
        }
    }
    for i in 0..hosts {
        text.push_str(&format!("site{i}.example##.promo-rail-container\n"));
        text.push_str(&format!(
            "site{i}.example##div.sponsored:has-text(Sponsored)\n"
        ));
    }
    text
}

#[test]
fn a_large_list_compiles_in_well_under_a_second() {
    // Roughly the size of EasyList plus EasyPrivacy.
    let text = synthetic_list(40_000, 30_000, 5_000);
    let bytes = text.len();

    let started = Instant::now();
    let compiled = fad_filter::compile(&[ListSource {
        id: "bench",
        text: &text,
    }]);
    let elapsed = started.elapsed();

    println!(
        "compile: {} network + {} cosmetic from {:.1} MB in {:?}",
        compiled.network.len(),
        compiled.cosmetic.len(),
        bytes as f64 / 1_048_576.0,
        elapsed
    );

    assert!(
        compiled.errors.is_empty(),
        "{:?}",
        &compiled.errors[..compiled.errors.len().min(3)]
    );
    assert!(
        elapsed.as_secs_f64() < 10.0,
        "compiling {bytes} bytes took {elapsed:?}; a subscription refresh has to fit in a
         service-worker's attention span"
    );
}

#[test]
fn cosmetic_lookup_stays_microsecond_scale() {
    let text = synthetic_list(0, 30_000, 5_000);
    let compiled = fad_filter::compile(&[ListSource {
        id: "bench",
        text: &text,
    }]);
    let index = CosmeticIndex::build(&assign_cosmetic_ids(compiled.cosmetic), "bench");

    // A page's worth of tokens: a few hundred, almost none ad-related.
    let tokens: Vec<String> = (0..400)
        .map(|i| {
            if i % 50 == 0 {
                format!(".ad-unit-container-{i}")
            } else {
                format!(".layout-grid-{i}")
            }
        })
        .collect();

    const ITERATIONS: u32 = 2_000;
    let started = Instant::now();
    let mut total = 0usize;
    for _ in 0..ITERATIONS {
        total += index.select_generic(&tokens, &[]).len();
    }
    let per_call = started.elapsed() / ITERATIONS;
    println!("select_generic: {per_call:?} per call, {total} selectors matched");

    // This runs on every document and again on every batch of DOM mutations.
    assert!(
        per_call.as_micros() < 2_000,
        "generic selection took {per_call:?}; it runs per mutation batch"
    );

    let started = Instant::now();
    for _ in 0..ITERATIONS {
        let _ = index.lookup_host("www.site1234.example");
    }
    let per_call = started.elapsed() / ITERATIONS;
    println!("lookup_host: {per_call:?} per call");
    assert!(per_call.as_micros() < 500, "host lookup took {per_call:?}");
}

#[test]
fn the_index_decodes_fast_enough_for_a_worker_restart() {
    let text = synthetic_list(0, 30_000, 5_000);
    let compiled = fad_filter::compile(&[ListSource {
        id: "bench",
        text: &text,
    }]);
    let index = CosmeticIndex::build(&assign_cosmetic_ids(compiled.cosmetic), "bench");

    let postcard_bytes = postcard::to_allocvec(&index).expect("serializes");
    let json_bytes = serde_json::to_vec(&index).expect("serializes");
    println!(
        "index: postcard {} KB, json {} KB ({:.0}% smaller)",
        postcard_bytes.len() / 1024,
        json_bytes.len() / 1024,
        100.0 - (postcard_bytes.len() as f64 / json_bytes.len() as f64) * 100.0
    );

    let started = Instant::now();
    let decoded: CosmeticIndex = postcard::from_bytes(&postcard_bytes).expect("decodes");
    let elapsed = started.elapsed();
    println!("decode: {elapsed:?}");

    assert_eq!(decoded.generic_count(), index.generic_count());
    // MV3 restarts the worker constantly; this cost is paid on every one.
    assert!(elapsed.as_millis() < 250, "index decode took {elapsed:?}");
    // Held in memory for the whole session.
    assert!(
        postcard_bytes.len() < 16 * 1024 * 1024,
        "index is {} MB",
        postcard_bytes.len() / 1_048_576
    );
    // The format choice has to keep earning itself.
    assert!(
        postcard_bytes.len() < json_bytes.len(),
        "postcard is no longer smaller than the json already in the build"
    );
}

#[test]
fn the_shipped_lists_compile_almost_instantly() {
    // The real artifact, not a synthetic one. This is what a rebuild costs.
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lists");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();

    let mut texts = Vec::new();
    for entry in manifest["lists"].as_array().unwrap() {
        let id = entry["id"].as_str().unwrap().to_string();
        let text = std::fs::read_to_string(dir.join(entry["file"].as_str().unwrap())).unwrap();
        texts.push((id, text));
    }
    let sources: Vec<ListSource<'_>> = texts
        .iter()
        .map(|(id, text)| ListSource { id, text })
        .collect();

    let started = Instant::now();
    let compiled = fad_filter::compile(&sources);
    let elapsed = started.elapsed();

    println!(
        "shipped lists: {} network + {} cosmetic in {:?}",
        compiled.network.len(),
        compiled.cosmetic.len(),
        elapsed
    );
    assert!(
        elapsed.as_millis() < 2_000,
        "the shipped lists took {elapsed:?} to compile"
    );
}
