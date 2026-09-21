#![no_main]
//! A SABR response body must never panic the transport engine, and must never
//! mint a skip that silences the video.
//!
//! This is the most hostile input 404AD reads. `videoplayback` responses are
//! attacker-shaped in practice: the framing is undocumented, it changes without
//! notice, and not every response on the URL is UMP at all. A panic here takes
//! down the page's fetch hook; a runaway ad interval is worse, because it
//! refuses every later segment and the video simply stops.

use fad_youtube::timeline::Micros;
use fad_youtube::transport::TransportState;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // The first byte picks a chunking, so the fuzzer explores split points as
    // well as content. A header straddling a chunk boundary is the normal case.
    let Some((&first, body)) = data.split_first() else {
        return;
    };
    let chunk = usize::from(first).max(1);

    let mut state = TransportState::new();
    state.set_requested_video("dQw4w9WgXcQ");
    let stream = state.open_stream();

    for piece in body.chunks(chunk) {
        if state.push_stream(stream, piece).is_err() {
            break;
        }
    }
    state.close_stream(stream);

    for interval in state.ads().as_slice() {
        assert!(
            interval.duration_us() <= TransportState::MAX_AD_INTERVAL_US,
            "unbounded ad interval {interval:?}"
        );
        assert!(interval.start_us >= 0, "negative ad interval {interval:?}");
    }

    // The two clocks must stay consistent whatever was decoded.
    let probe: Micros = 60_000_000;
    assert!(state.content_time(probe) <= probe);
});
