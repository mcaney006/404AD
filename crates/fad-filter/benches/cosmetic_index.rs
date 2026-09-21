//! Benchmarks that decide two shipped design choices.
//!
//! 1. **Serialization format.** The cosmetic index is loaded once per browser
//!    session in the service worker. `postcard` is only worth the dependency if
//!    it is measurably faster to decode than `serde_json`, which is already in
//!    the build. This measures both.
//! 2. **Token gating.** The claim behind the WASM runtime is that filtering
//!    generic selectors by the tokens present in a document is far cheaper than
//!    shipping every selector to the content script. This measures the lookup
//!    at a realistic index size.

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use fad_filter::cosmetic_index::CosmeticIndex;
use fad_filter::optimize::assign_cosmetic_ids;
use fad_filter::parse::{parse_list, ListSource, ParseOutput};
use std::hint::black_box;

/// A list shaped like a real one: mostly generic selectors, a long tail of
/// host-specific rules.
fn synthetic_list(generic: usize, hosts: usize) -> String {
    let mut text = String::with_capacity(generic * 24 + hosts * 40);
    for i in 0..generic {
        text.push_str(&format!("##.ad-unit-{i}\n"));
        if i % 3 == 0 {
            text.push_str(&format!("###banner-slot-{i}\n"));
        }
    }
    for i in 0..hosts {
        text.push_str(&format!("site{i}.example##.promo-rail\n"));
        text.push_str(&format!(
            "site{i}.example##div.sponsored:has-text(Sponsored)\n"
        ));
    }
    text
}

fn build_index(text: &str) -> CosmeticIndex {
    let mut out = ParseOutput::default();
    parse_list(&ListSource { id: "bench", text }, &mut out);
    CosmeticIndex::build(&assign_cosmetic_ids(out.cosmetic), "bench")
}

fn serialization(c: &mut Criterion) {
    let index = build_index(&synthetic_list(20_000, 2_000));
    let postcard_bytes = postcard::to_allocvec(&index).unwrap();
    let json_bytes = serde_json::to_vec(&index).unwrap();

    println!(
        "cosmetic index: postcard {} bytes, json {} bytes ({:.1}% smaller)",
        postcard_bytes.len(),
        json_bytes.len(),
        100.0 - (postcard_bytes.len() as f64 / json_bytes.len() as f64) * 100.0
    );

    let mut group = c.benchmark_group("cosmetic_index/decode");
    group.bench_function("postcard", |b| {
        b.iter(|| {
            let decoded: CosmeticIndex = postcard::from_bytes(black_box(&postcard_bytes)).unwrap();
            black_box(decoded.selectors.len())
        })
    });
    group.bench_function("serde_json", |b| {
        b.iter(|| {
            let decoded: CosmeticIndex = serde_json::from_slice(black_box(&json_bytes)).unwrap();
            black_box(decoded.selectors.len())
        })
    });
    group.finish();
}

fn lookup(c: &mut Criterion) {
    let index = build_index(&synthetic_list(20_000, 2_000));

    // A page's worth of tokens: a few hundred, almost none of them ad-related.
    let tokens: Vec<String> = (0..400)
        .map(|i| {
            if i % 50 == 0 {
                format!(".ad-unit-{i}")
            } else {
                format!(".layout-{i}")
            }
        })
        .collect();

    let mut group = c.benchmark_group("cosmetic_index/lookup");
    group.bench_function("select_generic (token-gated)", |b| {
        b.iter(|| black_box(index.select_generic(black_box(&tokens), &[]).len()))
    });
    group.bench_function("ship_every_generic_selector (baseline)", |b| {
        b.iter_batched(
            || (),
            |()| {
                // What the content script would receive without gating.
                let all: Vec<&String> = index
                    .generic_by_token
                    .values()
                    .flatten()
                    .filter_map(|id| index.selectors.get(*id as usize))
                    .collect();
                black_box(all.len())
            },
            BatchSize::SmallInput,
        )
    });
    group.bench_function("lookup_host", |b| {
        b.iter(|| {
            black_box(
                index
                    .lookup_host(black_box("www.site1234.example"))
                    .hide
                    .len(),
            )
        })
    });
    group.finish();
}

criterion_group!(benches, serialization, lookup);
criterion_main!(benches);
