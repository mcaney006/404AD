//! The YouTube transport engine.
//!
//! ```text
//! ReadableStream<Uint8Array>
//!         │
//!         ▼
//!   UMP framing            fad-ump
//!         │
//!         ▼
//!   MEDIA_HEADER decode    protobuf scanner
//!         │
//!         ▼
//!   media timeline         segments, continuity, interval map
//!         │
//!         ▼
//!   sequential inference   SPRT over independent signals
//!         │
//!         ▼
//!   transport policy       ALLOW / SKIP / UNKNOWN
//! ```
//!
//! Evidence arrives from two places and is weighed the same way: the transport
//! itself, and observations handed in from the page. The DOM contributes
//! evidence; it is never truth. A verdict that rests only on a CSS class is one
//! class rename away from being wrong, whereas a timeline discontinuity is a
//! property of what the server actually sent.

use crate::inference::{Evidence, Signal, Sprt, Verdict};
use crate::protobuf;
use crate::timeline::{Continuity, Interval, IntervalSet, MediaType, Micros, Segment, Timeline};
use fad_ump::{Part, PartType, UmpError, UmpParser};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Fields of the UMP `MEDIA_HEADER` message that 404AD reads.
///
/// The message is not published; these numbers are observed on the wire and
/// corroborated across independent implementations. Every one is optional, and
/// a header missing all of them still parses to a usable, if uninformative,
/// segment.
mod media_header {
    pub const VIDEO_ID: u32 = 2;
    pub const ITAG: u32 = 3;
    pub const IS_INIT_SEGMENT: u32 = 8;
    pub const SEQUENCE_NUMBER: u32 = 9;
    pub const START_MS: u32 = 11;
    pub const DURATION_MS: u32 = 12;
    pub const CONTENT_LENGTH: u32 = 14;
}

/// Decoded `MEDIA_HEADER`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaHeader {
    pub video_id: Option<String>,
    pub itag: u64,
    pub is_init_segment: bool,
    pub sequence_number: u64,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub content_length: u64,
}

impl MediaHeader {
    pub fn decode(bytes: &[u8]) -> Self {
        let mut header = MediaHeader::default();
        protobuf::scan(bytes, |field, value| match field {
            media_header::VIDEO_ID => header.video_id = value.as_str().map(|s| s.into_owned()),
            media_header::ITAG => header.itag = value.as_u64().unwrap_or(0),
            media_header::IS_INIT_SEGMENT => {
                header.is_init_segment = value.as_bool().unwrap_or(false)
            }
            media_header::SEQUENCE_NUMBER => header.sequence_number = value.as_u64().unwrap_or(0),
            media_header::START_MS => header.start_ms = value.as_u64().unwrap_or(0) as i64,
            media_header::DURATION_MS => header.duration_ms = value.as_u64().unwrap_or(0) as i64,
            media_header::CONTENT_LENGTH => header.content_length = value.as_u64().unwrap_or(0),
            _ => {}
        });
        header
    }

    /// Audio and video itags are disjoint ranges in practice; anything else is
    /// reported as unknown rather than guessed at.
    pub fn media_type(&self) -> MediaType {
        match self.itag {
            // Common DASH video itags.
            133..=137
            | 160
            | 242..=248
            | 271
            | 278
            | 298
            | 299
            | 302
            | 303
            | 308
            | 315
            | 330..=337 => MediaType::Video,
            // Common DASH audio itags.
            139..=141 | 171 | 172 | 249..=251 | 256 | 258 | 327 | 338 | 380 => MediaType::Audio,
            _ => MediaType::Unknown,
        }
    }
}

/// What the buffer controller should do with media at a given point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    /// Append normally.
    Allow,
    /// Do not append; advance transport state past `until_us` instead.
    Skip { until_us: Micros },
    /// Not enough evidence. Append, because showing an ad is the recoverable
    /// error and dropping content is not.
    Unknown,
}

/// What one `push` produced, for diagnostics.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub parts: usize,
    pub headers: usize,
    pub bulk_bytes_skipped: u64,
    pub epoch: u64,
    pub verdict_changed: bool,
}

/// A closed decision about one media epoch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochDecision {
    pub epoch: u64,
    pub interval: Interval,
    pub verdict: Verdict,
    pub log_lr: f64,
    pub evidence: Vec<Evidence>,
}

pub struct TransportState {
    parser: UmpParser,
    timeline: Timeline,
    sprt: Sprt,

    epoch: u64,
    epoch_start_us: Option<Micros>,
    epoch_end_us: Micros,
    epoch_segments: usize,
    emitted_short: bool,
    emitted_long: bool,

    requested_video_id: Option<String>,
    formats: BTreeSet<u64>,
    verdict: Verdict,
    decisions: Vec<EpochDecision>,
}

impl Default for TransportState {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportState {
    /// Longest epoch still plausibly an ad. YouTube's unskippable breaks top
    /// out well under this; a real video rarely arrives as one short epoch.
    pub const AD_PLAUSIBLE_MAX_US: Micros = 40_000_000;
    /// Beyond this, an ad is implausible enough to be evidence against.
    pub const AD_IMPLAUSIBLE_MIN_US: Micros = 300_000_000;
    /// An epoch needs at least this many segments before its length is evidence.
    const MIN_SEGMENTS_FOR_LENGTH_EVIDENCE: usize = 2;
    /// Bound on retained epoch decisions.
    const MAX_DECISIONS: usize = 32;

    pub fn new() -> Self {
        TransportState {
            parser: UmpParser::new(),
            timeline: Timeline::new(),
            sprt: Sprt::new(),
            epoch: 0,
            epoch_start_us: None,
            epoch_end_us: 0,
            epoch_segments: 0,
            emitted_short: false,
            emitted_long: false,
            requested_video_id: None,
            formats: BTreeSet::new(),
            verdict: Verdict::Unknown,
            decisions: Vec::new(),
        }
    }

    /// The video the viewer asked for. Media that names a different id is
    /// strong evidence of an ad.
    pub fn set_requested_video(&mut self, video_id: &str) {
        let changed = self.requested_video_id.as_deref() != Some(video_id);
        self.requested_video_id = Some(video_id.to_string());
        if changed {
            // A different video means a different stream. Nothing learned about
            // the previous one carries over.
            self.reset();
        }
    }

    pub fn requested_video(&self) -> Option<&str> {
        self.requested_video_id.as_deref()
    }

    /// Feed transport bytes.
    pub fn push(&mut self, chunk: &[u8]) -> Result<PushOutcome, UmpError> {
        let before = self.verdict;
        let mut outcome = PushOutcome {
            epoch: self.epoch,
            ..Default::default()
        };
        let bulk_before = self.parser.stats().bulk_bytes_skipped;

        // Collected rather than handled inline because the parser borrows its
        // buffer for the callback's lifetime, and the handlers need `&mut self`.
        let mut headers: Vec<MediaHeader> = Vec::new();
        let mut epoch_markers = 0usize;
        let mut parts = 0usize;

        self.parser.push(chunk, |part: Part<'_>| {
            parts += 1;
            match part.kind {
                PartType::MediaHeader => headers.push(MediaHeader::decode(part.payload)),
                // Each of these means the server changed what it is sending.
                PartType::FormatInitializationMetadata
                | PartType::SabrContextUpdate
                | PartType::SabrSeek
                | PartType::SabrRedirect
                | PartType::ReloadPlayerResponse => epoch_markers += 1,
                _ => {}
            }
        })?;

        for _ in 0..epoch_markers {
            self.begin_epoch();
        }
        for header in headers {
            self.observe_header(&header);
            outcome.headers += 1;
        }

        outcome.parts = parts;
        outcome.bulk_bytes_skipped = self.parser.stats().bulk_bytes_skipped - bulk_before;
        outcome.epoch = self.epoch;
        outcome.verdict_changed = self.verdict != before;
        Ok(outcome)
    }

    fn begin_epoch(&mut self) {
        self.close_epoch();
        self.epoch += 1;
        self.epoch_start_us = None;
        self.epoch_end_us = 0;
        self.epoch_segments = 0;
        self.emitted_short = false;
        self.emitted_long = false;
        self.sprt.reset();
        self.verdict = Verdict::Unknown;
        // A fresh epoch mid-playback is itself weak evidence.
        if self.epoch > 1 {
            self.observe(Signal::NewTransportEpoch);
        }
    }

    /// Record the closing epoch's decision, and its interval if it was an ad.
    fn close_epoch(&mut self) {
        let (Some(start), end) = (self.epoch_start_us, self.epoch_end_us) else {
            return;
        };
        if end <= start {
            return;
        }
        let interval = Interval::new(start, end);
        let decision = EpochDecision {
            epoch: self.epoch,
            interval,
            verdict: self.verdict,
            log_lr: self.sprt.log_lr(),
            evidence: self.sprt.evidence().to_vec(),
        };
        if decision.verdict == Verdict::Ad {
            self.timeline.ads_mut().insert(interval);
        }
        self.decisions.push(decision);
        if self.decisions.len() > Self::MAX_DECISIONS {
            self.decisions.remove(0);
        }
    }

    fn observe_header(&mut self, header: &MediaHeader) {
        // Init segments carry no timeline; they only announce a format.
        if header.is_init_segment {
            if self.formats.insert(header.itag) && self.formats.len() > 1 {
                self.observe(Signal::FormatSetChanged);
            }
            return;
        }

        let segment = Segment {
            format_id: header.itag,
            sequence: header.sequence_number,
            start_us: header.start_ms.saturating_mul(1_000),
            duration_us: header.duration_ms.saturating_mul(1_000),
            media_type: header.media_type(),
            byte_length: header.content_length,
            init_id: header.itag,
            request_epoch: self.epoch,
        };

        let continuity = self.timeline.observe(segment.clone());
        match continuity {
            Continuity::Continuous { .. } => {
                self.observe(Signal::ContinuousTimeline);
            }
            Continuity::Gap { .. } | Continuity::Overlap { .. } => {
                self.observe(Signal::TimelineDiscontinuity);
            }
            Continuity::First => {}
        }

        // Resolved before observing so the borrow of `requested_video_id` ends
        // before `observe` takes `&mut self`.
        let identity = match (
            self.requested_video_id.as_deref(),
            header.video_id.as_deref(),
        ) {
            (Some(requested), Some(actual)) if requested == actual => {
                Some(Signal::ContentVideoIdentityMatch)
            }
            (Some(_), Some(_)) => Some(Signal::MediaIdentityMismatch),
            _ => None,
        };
        if let Some(signal) = identity {
            self.observe(signal);
        }

        self.epoch_segments += 1;
        self.epoch_start_us = Some(
            self.epoch_start_us
                .map_or(segment.start_us, |s| s.min(segment.start_us)),
        );
        self.epoch_end_us = self.epoch_end_us.max(segment.end_us());
        self.evaluate_epoch_length();
        self.sync_ad_interval();
    }

    /// Keep the recorded ad interval covering the whole epoch seen so far.
    ///
    /// An epoch grows as its segments arrive. Recording the interval only at
    /// the moment the verdict flipped froze it at whatever had been seen by
    /// then, so playback resumed in the middle of the ad rather than after it.
    fn sync_ad_interval(&mut self) {
        if self.verdict != Verdict::Ad {
            return;
        }
        let Some(start) = self.epoch_start_us else {
            return;
        };
        if self.epoch_end_us > start {
            self.timeline
                .ads_mut()
                .insert(Interval::new(start, self.epoch_end_us));
        }
    }

    /// Epoch length is evidence, emitted once each way.
    fn evaluate_epoch_length(&mut self) {
        if self.epoch_segments < Self::MIN_SEGMENTS_FOR_LENGTH_EVIDENCE {
            return;
        }
        let Some(start) = self.epoch_start_us else {
            return;
        };
        let span = self.epoch_end_us - start;

        if !self.emitted_long && span >= Self::AD_IMPLAUSIBLE_MIN_US {
            self.emitted_long = true;
            self.observe(Signal::LongDurationEpoch);
        } else if !self.emitted_short && span > 0 && span <= Self::AD_PLAUSIBLE_MAX_US {
            self.emitted_short = true;
            self.observe(Signal::ShortIsolatedEpoch);
        }
    }

    /// Record an observation from outside the transport, such as the player's
    /// own state or an ad renderer appearing.
    pub fn observe(&mut self, signal: Signal) -> Verdict {
        self.verdict = self.sprt.observe(signal);
        self.sync_ad_interval();
        self.verdict
    }

    pub fn verdict(&self) -> Verdict {
        self.verdict
    }

    pub fn log_lr(&self) -> f64 {
        self.sprt.log_lr()
    }

    pub fn evidence(&self) -> &[Evidence] {
        self.sprt.evidence()
    }

    pub fn decisions(&self) -> &[EpochDecision] {
        &self.decisions
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn ads(&self) -> &IntervalSet {
        self.timeline.ads()
    }

    pub fn timeline(&self) -> &Timeline {
        &self.timeline
    }

    pub fn content_time(&self, transport_us: Micros) -> Micros {
        self.timeline.content_time(transport_us)
    }

    pub fn transport_time(&self, content_us: Micros) -> Micros {
        self.timeline.ads().transport_time(content_us)
    }

    /// What to do with media at `transport_us`.
    ///
    /// `Unknown` resolves to append. Dropping content is the error worth
    /// avoiding; showing an ad is the error worth tolerating.
    pub fn policy_at(&self, transport_us: Micros) -> Policy {
        if let Some(interval) = self.timeline.ads().covering(transport_us) {
            return Policy::Skip {
                until_us: interval.end_us,
            };
        }
        match self.verdict {
            Verdict::Ad => {
                let until = self.epoch_end_us.max(transport_us);
                Policy::Skip { until_us: until }
            }
            Verdict::Content => Policy::Allow,
            Verdict::Unknown => Policy::Unknown,
        }
    }

    /// The MediaSource gate: may this segment enter the SourceBuffer?
    pub fn should_append(&self, transport_us: Micros) -> bool {
        !matches!(self.policy_at(transport_us), Policy::Skip { .. })
    }

    /// Where playback should resume if it is currently inside an ad.
    pub fn resume_target(&self, transport_us: Micros) -> Option<Micros> {
        self.timeline.ads().covering(transport_us).map(|i| i.end_us)
    }

    pub fn parser_stats(&self) -> fad_ump::UmpStats {
        self.parser.stats()
    }

    /// Drop timeline history behind the playback cursor.
    pub fn prune(&mut self, before_us: Micros) {
        self.timeline.prune(before_us);
    }

    pub fn reset(&mut self) {
        self.parser.reset();
        self.timeline.reset();
        self.sprt.reset();
        self.epoch = 0;
        self.epoch_start_us = None;
        self.epoch_end_us = 0;
        self.epoch_segments = 0;
        self.emitted_short = false;
        self.emitted_long = false;
        self.formats.clear();
        self.verdict = Verdict::Unknown;
        self.decisions.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protobuf::{encode_bytes_field, encode_varint_field};
    use fad_ump::encode_part;

    const MS: i64 = 1;
    const SEC_US: Micros = 1_000_000;

    fn media_header_bytes(
        video_id: &str,
        itag: u64,
        sequence: u64,
        start_ms: i64,
        duration_ms: i64,
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_bytes_field(media_header::VIDEO_ID, video_id.as_bytes(), &mut buf);
        encode_varint_field(media_header::ITAG, itag, &mut buf);
        encode_varint_field(media_header::SEQUENCE_NUMBER, sequence, &mut buf);
        encode_varint_field(media_header::START_MS, start_ms as u64, &mut buf);
        encode_varint_field(media_header::DURATION_MS, duration_ms as u64, &mut buf);
        encode_varint_field(media_header::CONTENT_LENGTH, 4096, &mut buf);
        buf
    }

    fn stream_with(headers: &[(&str, u64, u64, i64, i64)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (video_id, itag, seq, start, dur) in headers {
            encode_part(
                PartType::MediaHeader,
                &media_header_bytes(video_id, *itag, *seq, *start, *dur),
                &mut out,
            );
            // Bulk media the parser is expected to skip.
            encode_part(PartType::Media, &vec![0u8; 8192], &mut out);
        }
        out
    }

    #[test]
    fn decodes_a_media_header() {
        let header = MediaHeader::decode(&media_header_bytes("dQw4w9WgXcQ", 137, 4, 12_000, 5_000));
        assert_eq!(header.video_id.as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(header.itag, 137);
        assert_eq!(header.sequence_number, 4);
        assert_eq!(header.start_ms, 12_000);
        assert_eq!(header.duration_ms, 5_000);
        assert_eq!(header.media_type(), MediaType::Video);
    }

    #[test]
    fn an_empty_header_decodes_to_defaults_rather_than_failing() {
        let header = MediaHeader::decode(&[]);
        assert_eq!(header, MediaHeader::default());
        assert_eq!(header.media_type(), MediaType::Unknown);
    }

    #[test]
    fn itags_classify_audio_and_video() {
        let audio = MediaHeader {
            itag: 251,
            ..Default::default()
        };
        let video = MediaHeader {
            itag: 248,
            ..Default::default()
        };
        assert_eq!(audio.media_type(), MediaType::Audio);
        assert_eq!(video.media_type(), MediaType::Video);
    }

    #[test]
    fn continuous_content_stays_content_and_is_appended() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");

        let bytes = stream_with(&[
            ("abc", 137, 0, 0, 5_000 * MS),
            ("abc", 137, 1, 5_000, 5_000 * MS),
            ("abc", 137, 2, 10_000, 5_000 * MS),
        ]);
        state.push(&bytes).unwrap();

        assert_eq!(state.verdict(), Verdict::Content, "L={}", state.log_lr());
        assert!(state.should_append(7 * SEC_US));
        assert!(state.ads().is_empty());
    }

    #[test]
    fn media_from_a_different_video_after_a_discontinuity_is_classified_as_an_ad() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");

        // Content, then a new epoch carrying a different video id for 15 s.
        state
            .push(&stream_with(&[
                ("abc", 137, 0, 0, 5_000),
                ("abc", 137, 1, 5_000, 5_000),
            ]))
            .unwrap();

        let mut ad = Vec::new();
        encode_part(PartType::FormatInitializationMetadata, &[1, 2, 3], &mut ad);
        ad.extend(stream_with(&[
            ("AD-CREATIVE", 137, 0, 120_000, 5_000),
            ("AD-CREATIVE", 137, 1, 125_000, 5_000),
            ("AD-CREATIVE", 137, 2, 130_000, 5_000),
        ]));
        state.push(&ad).unwrap();

        assert_eq!(state.verdict(), Verdict::Ad, "L={}", state.log_lr());
        assert!(
            !state.should_append(125 * SEC_US),
            "ad media must not be appended"
        );
        assert!(state.ads().contains(125 * SEC_US));
    }

    #[test]
    fn bulk_media_never_enters_the_parser_buffer() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        let bytes = stream_with(&[("abc", 137, 0, 0, 5_000); 8]);
        // Pushed in network-sized chunks, which is how bytes actually arrive.
        let mut outcome = PushOutcome::default();
        for chunk in bytes.chunks(1400) {
            let step = state.push(chunk).unwrap();
            outcome.headers += step.headers;
            outcome.bulk_bytes_skipped += step.bulk_bytes_skipped;
        }

        assert_eq!(outcome.headers, 8);
        assert_eq!(outcome.bulk_bytes_skipped, 8 * 8_192);
        // Nothing of the 64 KB of media is retained between pushes.
        assert!(
            state.parser_stats().peak_buffer < 1_400,
            "peak retained {} means media was buffered",
            state.parser_stats().peak_buffer
        );
    }

    #[test]
    fn chunking_does_not_change_the_verdict() {
        let bytes = stream_with(&[
            ("abc", 137, 0, 0, 5_000),
            ("abc", 137, 1, 5_000, 5_000),
            ("abc", 137, 2, 10_000, 5_000),
        ]);

        let mut whole = TransportState::new();
        whole.set_requested_video("abc");
        whole.push(&bytes).unwrap();

        let mut dripped = TransportState::new();
        dripped.set_requested_video("abc");
        for chunk in bytes.chunks(7) {
            dripped.push(chunk).unwrap();
        }
        assert_eq!(whole.verdict(), dripped.verdict());
        assert_eq!(whole.log_lr().to_bits(), dripped.log_lr().to_bits());
    }

    #[test]
    fn the_dom_contributes_evidence_but_cannot_decide_alone() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        // An ad renderer appearing is a dashboard light, not the engine.
        assert_eq!(state.observe(Signal::AdRendererActivated), Verdict::Unknown);
        // The player's own state machine plus placement metadata is decisive.
        state.observe(Signal::PlayerReportsAd);
        assert_eq!(state.observe(Signal::AdPlacementMetadata), Verdict::Ad);
    }

    #[test]
    fn unknown_resolves_to_appending_because_dropping_content_is_worse() {
        let state = TransportState::new();
        assert_eq!(state.policy_at(0), Policy::Unknown);
        assert!(
            state.should_append(0),
            "an undecided segment must still play"
        );
    }

    #[test]
    fn a_classified_ad_yields_a_resume_target_and_a_content_mapping() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        state
            .push(&stream_with(&[
                ("abc", 137, 0, 0, 5_000),
                ("abc", 137, 1, 5_000, 5_000),
            ]))
            .unwrap();

        let mut ad = Vec::new();
        encode_part(PartType::SabrContextUpdate, &[9], &mut ad);
        ad.extend(stream_with(&[
            ("AD", 137, 0, 120_000, 5_000),
            ("AD", 137, 1, 125_000, 5_000),
            ("AD", 137, 2, 130_000, 5_000),
        ]));
        state.push(&ad).unwrap();
        assert_eq!(state.verdict(), Verdict::Ad);

        // Regression: the interval used to freeze at whatever had arrived when
        // the verdict flipped, so playback resumed inside the ad.
        let resume = state.resume_target(125 * SEC_US).expect("inside an ad");
        assert_eq!(resume, 135 * SEC_US);
        assert!(
            !state.should_append(134 * SEC_US),
            "the last ad segment too"
        );
        // The viewer's clock never enters the ad.
        assert_eq!(state.content_time(600 * SEC_US), (600 - 15) * SEC_US);
    }

    #[test]
    fn switching_video_discards_everything_learned_about_the_previous_one() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        state.observe(Signal::PlayerReportsAd);
        state.observe(Signal::AdPlacementMetadata);
        assert_eq!(state.verdict(), Verdict::Ad);

        state.set_requested_video("xyz");
        assert_eq!(state.verdict(), Verdict::Unknown);
        assert!(state.ads().is_empty());
        assert_eq!(state.epoch(), 0);
    }

    #[test]
    fn epoch_decisions_are_recorded_and_bounded() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        for i in 0..50i64 {
            let mut bytes = Vec::new();
            encode_part(PartType::FormatInitializationMetadata, &[1], &mut bytes);
            bytes.extend(stream_with(&[
                ("abc", 137, 0, i * 20_000, 5_000),
                ("abc", 137, 1, i * 20_000 + 5_000, 5_000),
            ]));
            state.push(&bytes).unwrap();
        }
        assert!(state.decisions().len() <= 32, "decisions must be bounded");
        assert!(state.decisions().iter().all(|d| !d.evidence.is_empty()));
    }

    #[test]
    fn a_long_epoch_is_evidence_against_an_ad() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        // Ten minutes of continuous media from the requested video.
        let headers: Vec<(&str, u64, u64, i64, i64)> = (0..8)
            .map(|i| ("abc", 137u64, i as u64, i * 60_000, 60_000i64))
            .collect();
        state.push(&stream_with(&headers)).unwrap();

        assert_eq!(state.verdict(), Verdict::Content);
        assert!(
            state
                .evidence()
                .iter()
                .any(|e| e.signal == Signal::LongDurationEpoch),
            "a ten-minute epoch should have been noticed"
        );
    }
}
