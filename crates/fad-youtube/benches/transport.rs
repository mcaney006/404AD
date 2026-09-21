//! Throughput measurement for the transport engine.
//!
//! The assertions live in `tests/budget.rs`; this reports the numbers behind
//! them so a change can be judged rather than merely permitted.

use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use fad_ump::{encode_part, PartType, UmpParser};
use fad_youtube::protobuf::{encode_bytes_field, encode_varint_field};
use fad_youtube::transport::TransportState;
use std::hint::black_box;

fn stream(seconds: usize, mbps: usize) -> Vec<u8> {
    let payload = mbps * 125_000;
    let mut out = Vec::with_capacity(seconds * payload);
    for i in 0..seconds {
        let mut header = Vec::new();
        encode_bytes_field(2, b"dQw4w9WgXcQ", &mut header);
        encode_varint_field(3, 137, &mut header);
        encode_varint_field(9, i as u64, &mut header);
        encode_varint_field(11, (i as u64) * 1_000, &mut header);
        encode_varint_field(12, 1_000, &mut header);
        encode_part(PartType::MediaHeader, &header, &mut out);
        encode_part(PartType::Media, &vec![0x5A; payload], &mut out);
    }
    out
}

fn framing(c: &mut Criterion) {
    let bytes = stream(60, 8);
    let mut group = c.benchmark_group("ump/framing");
    group.throughput(Throughput::Bytes(bytes.len() as u64));
    group.bench_function("parse_only", |b| {
        b.iter(|| {
            let mut parser = UmpParser::new();
            let mut parts = 0u64;
            for chunk in bytes.chunks(1400) {
                parser.push(chunk, |_| parts += 1).unwrap();
            }
            black_box(parts)
        })
    });
    group.finish();
}

fn full_pipeline(c: &mut Criterion) {
    let bytes = stream(60, 8);
    let mut group = c.benchmark_group("youtube/transport");
    group.throughput(Throughput::Bytes(bytes.len() as u64));
    group.bench_function("parse_classify", |b| {
        b.iter(|| {
            let mut state = TransportState::new();
            state.set_requested_video("dQw4w9WgXcQ");
            for chunk in bytes.chunks(1400) {
                state.push(chunk).unwrap();
            }
            black_box(state.verdict())
        })
    });
    group.finish();
}

criterion_group!(benches, framing, full_pipeline);
criterion_main!(benches);
