//! Performance budgets, enforced as tests rather than only measured.
//!
//! A benchmark that nobody reads does not stop a regression. These assert hard
//! ceilings, set roughly an order of magnitude above what the code actually
//! does, so ordinary machine-to-machine variance never fails the build but a
//! genuine 10x regression always does.
//!
//! The budgets that matter for a media pipeline are throughput and *retention*.
//! A parser that keeps up but grows its buffer is a slow leak into a tab that
//! stays open for hours.

use fad_ump::{encode_part, PartType};
use fad_youtube::protobuf::{encode_bytes_field, encode_varint_field};
use fad_youtube::transport::TransportState;
use std::time::Instant;

/// One second of media: a header plus a payload of roughly a megabit.
fn segment(video_id: &str, sequence: u64, start_ms: i64, payload_bytes: usize) -> Vec<u8> {
    let mut header = Vec::new();
    encode_bytes_field(2, video_id.as_bytes(), &mut header);
    encode_varint_field(3, 137, &mut header);
    encode_varint_field(9, sequence, &mut header);
    encode_varint_field(11, start_ms as u64, &mut header);
    encode_varint_field(12, 1_000, &mut header);
    encode_varint_field(14, payload_bytes as u64, &mut header);

    let mut out = Vec::new();
    encode_part(PartType::MediaHeader, &header, &mut out);
    encode_part(PartType::Media, &vec![0x5A; payload_bytes], &mut out);
    out
}

/// A stream of `seconds` seconds at roughly `mbps` megabits per second.
fn stream(seconds: usize, mbps: usize) -> Vec<u8> {
    let payload = mbps * 125_000;
    let mut out = Vec::with_capacity(seconds * payload);
    for i in 0..seconds {
        out.extend(segment("dQw4w9WgXcQ", i as u64, i as i64 * 1_000, payload));
    }
    out
}

#[test]
fn transport_parsing_keeps_far_ahead_of_playback() {
    // Ten minutes of 8 Mbps video: roughly 600 MB, which is more than a 4K
    // stream delivers in that time.
    let bytes = stream(600, 8);
    let total = bytes.len();

    let mut state = TransportState::new();
    state.set_requested_video("dQw4w9WgXcQ");

    let started = Instant::now();
    // Pushed at MTU-ish sizes, which is how bytes actually arrive.
    for chunk in bytes.chunks(1400) {
        state.push(chunk).expect("parses");
    }
    let elapsed = started.elapsed();

    let throughput_mb_s = (total as f64 / 1_048_576.0) / elapsed.as_secs_f64();
    println!(
        "transport: {:.1} MB in {:?} = {throughput_mb_s:.0} MB/s",
        total as f64 / 1_048_576.0,
        elapsed
    );

    // Ten minutes of media must parse in well under a second of CPU; the budget
    // is set at five seconds so only a real regression trips it.
    assert!(
        elapsed.as_secs_f64() < 5.0,
        "parsing 10 minutes of 8 Mbps media took {elapsed:?}"
    );
    assert!(
        throughput_mb_s > 50.0,
        "throughput fell to {throughput_mb_s:.0} MB/s"
    );
}

#[test]
fn the_parser_retains_almost_nothing_between_chunks() {
    let bytes = stream(120, 8);
    let mut state = TransportState::new();
    state.set_requested_video("dQw4w9WgXcQ");

    for chunk in bytes.chunks(1400) {
        state.push(chunk).expect("parses");
    }

    let stats = state.parser_stats();
    println!(
        "retention: peak {} bytes over {} MB in, {} MB of media skipped",
        stats.peak_buffer,
        stats.bytes_in / 1_048_576,
        stats.bulk_bytes_skipped / 1_048_576
    );

    // The only thing ever retained is a partial part header.
    assert!(
        stats.peak_buffer < 8 * 1024,
        "peak retention {} bytes suggests media is being buffered",
        stats.peak_buffer
    );
    // Practically all of it is media, and practically all of that is skipped.
    assert!(stats.bulk_bytes_skipped > (stats.bytes_in / 10) * 9);
}

#[test]
fn state_stays_bounded_across_a_long_session() {
    // Six hours of navigation, epoch changes and playback.
    let mut state = TransportState::new();
    state.set_requested_video("dQw4w9WgXcQ");

    for hour in 0..6i64 {
        for minute in 0..60i64 {
            let mut bytes = Vec::new();
            encode_part(PartType::FormatInitializationMetadata, &[1], &mut bytes);
            let base = (hour * 3_600 + minute * 60) * 1_000;
            for second in 0..4i64 {
                bytes.extend(segment(
                    "dQw4w9WgXcQ",
                    second as u64,
                    base + second * 1_000,
                    4_096,
                ));
            }
            state.push(&bytes).expect("parses");
        }
        // The page prunes behind the playback cursor once an hour.
        state.prune(hour * 3_600 * 1_000_000);
    }

    assert!(
        state.decisions().len() <= 32,
        "decision history must be bounded"
    );
    assert!(state.evidence().len() <= 64, "evidence must be bounded");
    assert!(
        state.timeline().segments().len() < 10_000,
        "segment history grew to {}",
        state.timeline().segments().len()
    );
}

#[test]
fn a_long_ad_break_does_not_grow_the_interval_set_without_bound() {
    let mut state = TransportState::new();
    state.set_requested_video("content");

    // Two hundred ad epochs, each adjacent to the last. They must coalesce.
    for i in 0..200i64 {
        let mut bytes = Vec::new();
        encode_part(PartType::FormatInitializationMetadata, &[1], &mut bytes);
        for second in 0..3i64 {
            bytes.extend(segment(
                "AD",
                second as u64,
                i * 3_000 + second * 1_000,
                4_096,
            ));
        }
        state.push(&bytes).expect("parses");
    }

    assert!(
        state.ads().len() < 20,
        "adjacent ad intervals should merge, got {}",
        state.ads().len()
    );
}
