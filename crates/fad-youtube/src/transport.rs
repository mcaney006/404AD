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
use fad_ump::{Part, PartType, UmpError, UmpParser, UmpStats};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

    /// Longest plausible single media segment.
    ///
    /// Real SABR segments are seconds long. This ceiling is deliberately
    /// generous; it exists because a misparsed header must not be able to mint
    /// a multi-hour ad interval, which would silence the rest of the video.
    pub const MAX_DURATION_MS: i64 = 120_000;

    /// Longest plausible position on a media timeline: two days of live.
    pub const MAX_START_MS: i64 = 48 * 3_600 * 1_000;

    /// Could a real server have sent this header?
    ///
    /// Not every response on a `videoplayback` URL is UMP, and not every
    /// protobuf scan of a non-UMP body fails. A header that survives the
    /// framing check but describes an impossible segment is a decode artefact,
    /// and trusting it is how a classifier ends up skipping the whole video.
    pub fn is_plausible(&self) -> bool {
        self.start_ms >= 0
            && self.duration_ms >= 0
            && self.start_ms <= Self::MAX_START_MS
            && self.duration_ms <= Self::MAX_DURATION_MS
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
    /// Headers that decoded but described an impossible segment.
    pub rejected_headers: usize,
    /// The response was found not to be UMP and is no longer being read.
    pub not_ump: bool,
}

/// One in-flight SABR response.
///
/// Each response is its own UMP stream, so each gets its own parser. Sharing
/// one parser across responses breaks in two ways that both happen on a real
/// page: the player cancels requests mid-part, which leaves the parser
/// expecting a payload that never arrives and consuming the next response as
/// its tail; and responses overlap, which interleaves two framings into one
/// buffer.
struct ResponseStream {
    id: u32,
    parser: UmpParser,
    /// A part of a type 404AD recognises has been seen: this really is UMP.
    confirmed: bool,
    /// The body is not UMP. Nothing more is read from it.
    rejected: bool,
}

impl ResponseStream {
    fn new(id: u32) -> Self {
        ResponseStream {
            id,
            parser: UmpParser::new(),
            confirmed: false,
            rejected: false,
        }
    }
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

/// Stream id used by the single-response [`TransportState::push`] shortcut.
pub const DEFAULT_STREAM: u32 = 0;

pub struct TransportState {
    streams: Vec<ResponseStream>,
    next_stream_id: u32,
    /// Framing statistics from responses that have already closed.
    closed_stats: UmpStats,
    non_ump_responses: u64,
    truncated_responses: u64,
    rejected_headers: u64,

    timeline: Timeline,
    sprt: Sprt,

    epoch: u64,
    epoch_start_us: Option<Micros>,
    epoch_end_us: Micros,
    epoch_segments: usize,
    emitted_short: bool,
    emitted_long: bool,

    requested_video_id: Option<String>,
    /// The format in flight per track. A *switch* within a track is evidence;
    /// a stream simply having both an audio and a video format is not.
    formats: BTreeMap<MediaType, u64>,
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

    /// Ceiling on one classified ad interval.
    ///
    /// YouTube's longest ad pod is minutes. Past this the classifier is wrong,
    /// and an unbounded interval does not merely mis-skip an ad: it silences
    /// every segment after it.
    pub const MAX_AD_INTERVAL_US: Micros = 360_000_000;

    /// Responses read concurrently. The player pipelines; it does not pipeline
    /// eight deep.
    const MAX_STREAMS: usize = 8;

    pub fn new() -> Self {
        TransportState {
            streams: Vec::new(),
            next_stream_id: 1,
            closed_stats: UmpStats::default(),
            non_ump_responses: 0,
            truncated_responses: 0,
            rejected_headers: 0,
            timeline: Timeline::new(),
            sprt: Sprt::new(),
            epoch: 0,
            epoch_start_us: None,
            epoch_end_us: 0,
            epoch_segments: 0,
            emitted_short: false,
            emitted_long: false,
            requested_video_id: None,
            formats: BTreeMap::new(),
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

    /// Begin reading one SABR response, returning its stream id.
    ///
    /// Callers that read several responses concurrently must open one stream
    /// per response; framing state is per response and cannot be shared.
    pub fn open_stream(&mut self) -> u32 {
        if self.streams.len() >= Self::MAX_STREAMS {
            // The oldest still-open response is the one least likely to be
            // finished; dropping it loses framing, never timeline or evidence.
            let evicted = self.streams.remove(0);
            self.retire(evicted);
        }
        let id = self.next_stream_id;
        self.next_stream_id = self.next_stream_id.wrapping_add(1).max(1);
        self.streams.push(ResponseStream::new(id));
        id
    }

    /// Finish a response. Returns true when it ended on a part boundary.
    ///
    /// A false here is a truncated or cancelled response, which is ordinary on
    /// a real page and is exactly why framing does not outlive a response.
    pub fn close_stream(&mut self, id: u32) -> bool {
        let Some(index) = self.streams.iter().position(|s| s.id == id) else {
            return false;
        };
        let stream = self.streams.remove(index);
        let clean = stream.parser.at_boundary();
        self.retire(stream);
        clean
    }

    fn retire(&mut self, stream: ResponseStream) {
        if !stream.parser.at_boundary() {
            self.truncated_responses += 1;
        }
        let stats = stream.parser.stats();
        self.closed_stats.bytes_in += stats.bytes_in;
        self.closed_stats.parts += stats.parts;
        self.closed_stats.bulk_bytes_skipped += stats.bulk_bytes_skipped;
        self.closed_stats.peak_buffer = self.closed_stats.peak_buffer.max(stats.peak_buffer);
    }

    /// Feed bytes belonging to one response.
    ///
    /// An unknown id opens a stream under that id, so a caller that lost track
    /// of `open_stream` still gets isolated framing rather than shared framing.
    pub fn push_stream(&mut self, id: u32, chunk: &[u8]) -> Result<PushOutcome, UmpError> {
        let before = self.verdict;
        let mut outcome = PushOutcome {
            epoch: self.epoch,
            ..Default::default()
        };

        let index = match self.streams.iter().position(|s| s.id == id) {
            Some(index) => index,
            None => {
                if self.streams.len() >= Self::MAX_STREAMS {
                    let evicted = self.streams.remove(0);
                    self.retire(evicted);
                }
                self.streams.push(ResponseStream::new(id));
                self.next_stream_id = self.next_stream_id.max(id.wrapping_add(1)).max(1);
                self.streams.len() - 1
            }
        };

        if self.streams[index].rejected {
            outcome.not_ump = true;
            return Ok(outcome);
        }

        // Collected rather than handled inline because the parser borrows its
        // buffer for the callback's lifetime, and the handlers need `&mut self`.
        let mut headers: Vec<MediaHeader> = Vec::new();
        let mut epoch_markers = 0usize;
        let mut parts = 0usize;

        let stream = &mut self.streams[index];
        let bulk_before = stream.parser.stats().bulk_bytes_skipped;
        let was_confirmed = stream.confirmed;
        let mut first_kind = None;

        let result = stream.parser.push(chunk, |part: Part<'_>| {
            parts += 1;
            first_kind.get_or_insert(part.kind);
            match part.kind {
                PartType::MediaHeader => headers.push(MediaHeader::decode(part.payload)),
                // Each of these means the server changed what it is sending.
                // A redirect is deliberately absent: it moves the same media to
                // another host, and counting a CDN handoff as a content change
                // is how an ordinary watch accrues evidence of an ad.
                PartType::FormatInitializationMetadata
                | PartType::SabrContextUpdate
                | PartType::SabrSeek
                | PartType::ReloadPlayerResponse => epoch_markers += 1,
                _ => {}
            }
        });

        let bulk = stream.parser.stats().bulk_bytes_skipped - bulk_before;

        // A real SABR response opens with a part type 404AD knows. An MP4, a
        // JSON error page or a plain range response does not, and reading one
        // as UMP fabricates segments — the one failure mode that ends with
        // content being skipped. The check is on the first part *header*, not
        // the first completed part, so a response is judged within its opening
        // bytes rather than after a multi-megabyte media payload.
        //
        // ponytail: the cost of being wrong is asymmetric, so an unrecognised
        // leading part type means "stop analysing", not "guess". A new part
        // type at the head of a response would quietly disable transport
        // classification until the type is added to `PartType`.
        let leading = first_kind.or_else(|| stream.parser.current_part());
        let mut confirmed = was_confirmed;
        let mut unidentified = false;
        if !confirmed {
            match leading {
                Some(PartType::Unknown(_)) => unidentified = true,
                Some(_) => confirmed = true,
                None => {}
            }
        }
        stream.confirmed = confirmed;

        // A framing error and an unidentified body mean the same thing: this
        // response is not what we took it for. Neither may contribute evidence.
        if result.is_err() || unidentified {
            stream.rejected = true;
            self.non_ump_responses += 1;
            outcome.not_ump = true;
            outcome.parts = parts;
            outcome.bulk_bytes_skipped = bulk;
            result?;
            return Ok(outcome);
        }
        if !confirmed {
            // Still inside the window. Hold the parts back rather than acting
            // on a body that has not identified itself yet.
            outcome.parts = parts;
            outcome.bulk_bytes_skipped = bulk;
            return Ok(outcome);
        }

        for _ in 0..epoch_markers {
            self.begin_epoch();
        }
        for header in headers {
            if !header.is_plausible() {
                self.rejected_headers += 1;
                outcome.rejected_headers += 1;
                continue;
            }
            self.observe_header(&header);
            outcome.headers += 1;
        }

        outcome.parts = parts;
        outcome.bulk_bytes_skipped = bulk;
        outcome.epoch = self.epoch;
        outcome.verdict_changed = self.verdict != before;
        Ok(outcome)
    }

    /// Feed transport bytes on the default stream.
    ///
    /// Convenience for a caller reading one response at a time.
    pub fn push(&mut self, chunk: &[u8]) -> Result<PushOutcome, UmpError> {
        self.push_stream(DEFAULT_STREAM, chunk)
    }

    pub fn open_streams(&self) -> usize {
        self.streams.len()
    }

    pub fn non_ump_responses(&self) -> u64 {
        self.non_ump_responses
    }

    pub fn truncated_responses(&self) -> u64 {
        self.truncated_responses
    }

    pub fn rejected_headers(&self) -> u64 {
        self.rejected_headers
    }

    /// The viewer seeked.
    ///
    /// A scrub makes the server start sending from somewhere else, which is a
    /// new media epoch by every measure the transport can take. But the viewer
    /// caused it, so it is evidence of nothing: without this, scrubbing through
    /// a video charges one timeline discontinuity after another against it.
    pub fn notify_seek(&mut self) {
        self.timeline.seek_barrier();
        self.start_epoch(false);
    }

    fn begin_epoch(&mut self) {
        self.start_epoch(true);
    }

    fn start_epoch(&mut self, is_evidence: bool) {
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
        if is_evidence && self.epoch > 1 {
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
        let interval = Self::bounded_ad_interval(start, end);
        let verdict_was_ad = self.verdict == Verdict::Ad;
        let decision = EpochDecision {
            epoch: self.epoch,
            interval,
            verdict: self.verdict,
            log_lr: self.sprt.log_lr(),
            evidence: self.sprt.evidence().to_vec(),
        };
        if verdict_was_ad {
            self.insert_ad(interval.start_us, interval.end_us);
        }
        self.decisions.push(decision);
        if self.decisions.len() > Self::MAX_DECISIONS {
            self.decisions.remove(0);
        }
    }

    fn observe_header(&mut self, header: &MediaHeader) {
        // Init segments carry no timeline; they only announce a format.
        if header.is_init_segment {
            let track = header.media_type();
            // Regression: keyed on a flat set, the second track's first format
            // looked like a switch, so every ordinary stream that had both
            // audio and video opened with evidence of an ad.
            if let Some(previous) = self.formats.insert(track, header.itag) {
                if previous != header.itag {
                    self.observe(Signal::FormatSetChanged);
                }
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
            // Already accounted for. A replay carries no new information about
            // what the server is sending, and the epoch it belongs to has
            // already been measured over these bytes.
            Continuity::Retransmission => return,
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
            self.insert_ad(start, self.epoch_end_us);
        }
    }

    /// Record an ad interval, refusing to grow a refused region past the cap.
    ///
    /// Merging is what makes repeated evidence about one ad idempotent, and it
    /// is also how adjacent intervals compound: two capped insertions that
    /// touch become one interval twice the cap, and enough of them silence the
    /// video the bound existed to protect. So the cap is enforced on the
    /// contiguous region, not on the insertion.
    ///
    /// The trade is deliberate. Past six minutes of continuously refused media
    /// the classifier is wrong far more often than YouTube is running a
    /// six-minute pod, and showing an ad is recoverable where silence is not.
    fn insert_ad(&mut self, start: Micros, end: Micros) {
        let interval = Self::bounded_ad_interval(start, end);
        if interval.is_empty() {
            return;
        }
        // Merging absorbs neighbours on both sides, so the bound is checked
        // against what the insertion would actually produce.
        if self.timeline.ads().merged_extent(interval).duration_us() > Self::MAX_AD_INTERVAL_US {
            return;
        }
        self.timeline.ads_mut().insert(interval);
    }

    /// An ad interval, never longer than [`Self::MAX_AD_INTERVAL_US`].
    ///
    /// The bound is a safety net, not a classification rule. An unbounded
    /// interval built from one bad header would not merely mis-skip an ad; it
    /// would refuse every segment after it, and the video would never play.
    fn bounded_ad_interval(start: Micros, end: Micros) -> Interval {
        Interval::new(
            start,
            end.min(start.saturating_add(Self::MAX_AD_INTERVAL_US)),
        )
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
            // Never ask playback to jump further than the cap in one step. A
            // region that somehow grew longer is skipped in hops, and each hop
            // re-consults the classifier rather than trusting a stale extent.
            return Policy::Skip {
                until_us: interval
                    .end_us
                    .min(transport_us.saturating_add(Self::MAX_AD_INTERVAL_US)),
            };
        }
        match self.verdict {
            // The verdict is about the epoch that produced it. It says nothing
            // about a position outside that media, and the bound is what stops
            // one classified epoch from refusing the rest of the video.
            Verdict::Ad => match self.epoch_start_us {
                Some(start) => {
                    let bound = Self::bounded_ad_interval(start, self.epoch_end_us);
                    if bound.contains(transport_us) {
                        Policy::Skip {
                            until_us: bound.end_us,
                        }
                    } else {
                        Policy::Unknown
                    }
                }
                None => Policy::Unknown,
            },
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

    /// Framing statistics across every response, open and closed.
    pub fn parser_stats(&self) -> UmpStats {
        let mut total = self.closed_stats;
        for stream in &self.streams {
            let stats = stream.parser.stats();
            total.bytes_in += stats.bytes_in;
            total.parts += stats.parts;
            total.bulk_bytes_skipped += stats.bulk_bytes_skipped;
            total.peak_buffer = total.peak_buffer.max(stats.peak_buffer);
        }
        total
    }

    /// Drop timeline history behind the playback cursor.
    pub fn prune(&mut self, before_us: Micros) {
        self.timeline.prune(before_us);
    }

    pub fn reset(&mut self) {
        // Counters survive a reset: they describe what this page has served,
        // which is diagnostic history, not state about one video.
        for stream in std::mem::take(&mut self.streams) {
            self.retire(stream);
        }
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
    fn a_body_that_is_not_ump_contributes_no_evidence() {
        // Not every response on a `videoplayback` URL is SABR. A JSON error
        // page or a plain range response parses into fabricated parts, and
        // fabricated segments are how a classifier ends up skipping content.
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        let id = state.open_stream();

        let body = br#"{"error":{"code":403,"message":"forbidden","status":"PERMISSION_DENIED"}}"#;
        let mut outcome = PushOutcome::default();
        for chunk in body.chunks(8) {
            match state.push_stream(id, chunk) {
                Ok(step) => outcome.not_ump |= step.not_ump,
                // A framing error is the same verdict by another route.
                Err(_) => {
                    outcome.not_ump = true;
                    break;
                }
            }
        }

        assert!(outcome.not_ump, "a non-UMP body must be recognised as one");
        assert_eq!(state.non_ump_responses(), 1);
        assert_eq!(state.verdict(), Verdict::Unknown);
        assert!(state.ads().is_empty(), "no evidence may come from it");
        assert!(state.should_append(0), "and playback must be untouched");
    }

    #[test]
    fn a_rejected_body_stops_being_read_at_all() {
        let mut state = TransportState::new();
        let id = state.open_stream();
        let junk = vec![0x80u8; 512];
        let _ = state.push_stream(id, &junk);

        let before = state.parser_stats().bytes_in;
        let after = state
            .push_stream(id, &junk)
            .expect("a rejected stream reports, it does not error");
        assert!(after.not_ump);
        assert_eq!(
            state.parser_stats().bytes_in,
            before,
            "no further bytes are parsed"
        );
    }

    #[test]
    fn a_truncated_response_does_not_desynchronise_the_next_one() {
        // The player cancels requests constantly. With framing shared across
        // responses, the first cancellation leaves the parser waiting for a
        // payload that never arrives and eating the next response as its tail.
        let mut state = TransportState::new();
        state.set_requested_video("abc");

        let full = stream_with(&[("abc", 137, 0, 0, 5_000)]);
        let cancelled = state.open_stream();
        state
            .push_stream(cancelled, &full[..full.len() / 2])
            .unwrap();
        assert!(
            !state.close_stream(cancelled),
            "a half-delivered response is not clean"
        );
        assert_eq!(state.truncated_responses(), 1);

        let fresh = state.open_stream();
        let outcome = state
            .push_stream(
                fresh,
                &stream_with(&[
                    ("abc", 137, 1, 5_000, 5_000),
                    ("abc", 137, 2, 10_000, 5_000),
                ]),
            )
            .unwrap();

        assert_eq!(outcome.headers, 2, "the next response must parse cleanly");
        assert!(state.close_stream(fresh));
    }

    #[test]
    fn concurrent_responses_do_not_interleave_into_one_framing() {
        let first = stream_with(&[("abc", 137, 0, 0, 5_000), ("abc", 137, 1, 5_000, 5_000)]);
        let second = stream_with(&[("abc", 140, 0, 0, 5_000), ("abc", 140, 1, 5_000, 5_000)]);

        let mut state = TransportState::new();
        state.set_requested_video("abc");
        let a = state.open_stream();
        let b = state.open_stream();

        // Chunks arrive from two in-flight responses in whatever order the
        // network produced, which is exactly what `tee` delivers.
        let mut headers = 0;
        let mut left = first.chunks(11);
        let mut right = second.chunks(13);
        loop {
            let mut progressed = false;
            if let Some(chunk) = left.next() {
                headers += state.push_stream(a, chunk).unwrap().headers;
                progressed = true;
            }
            if let Some(chunk) = right.next() {
                headers += state.push_stream(b, chunk).unwrap().headers;
                progressed = true;
            }
            if !progressed {
                break;
            }
        }

        assert_eq!(headers, 4, "every header from both responses");
        assert_eq!(state.non_ump_responses(), 0);
        assert_eq!(state.verdict(), Verdict::Content, "L={}", state.log_lr());
    }

    #[test]
    fn an_implausible_header_is_dropped_rather_than_trusted() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");

        let mut bytes = Vec::new();
        // A duration no real segment carries: a decode artefact, and left
        // alone it would mint an ad interval hours long.
        encode_part(
            PartType::MediaHeader,
            &media_header_bytes("abc", 137, 0, 0, 9_000_000),
            &mut bytes,
        );
        bytes.extend(stream_with(&[("abc", 137, 1, 0, 5_000)]));

        let outcome = state.push(&bytes).unwrap();
        assert_eq!(outcome.rejected_headers, 1);
        assert_eq!(outcome.headers, 1, "the sound header still counts");
        assert_eq!(state.rejected_headers(), 1);
        assert_eq!(state.timeline().transport_end_us(), 5 * SEC_US);
    }

    #[test]
    fn a_negative_timestamp_is_implausible() {
        let mut header = MediaHeader {
            itag: 137,
            start_ms: -1,
            duration_ms: 5_000,
            ..Default::default()
        };
        assert!(!header.is_plausible());
        header.start_ms = 0;
        assert!(header.is_plausible());
    }

    #[test]
    fn a_classified_ad_can_never_silence_the_rest_of_the_video() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");

        // Twelve minutes of media from a different video, each segment sound on
        // its own. Whatever the classifier makes of it, the interval it records
        // has to stay bounded: refusing every later segment is not a mis-skip,
        // it is a broken player.
        let headers: Vec<(&str, u64, u64, i64, i64)> = (0..6)
            .map(|i| ("OTHER", 137u64, i as u64, i * 120_000, 120_000i64))
            .collect();
        state.push(&stream_with(&headers)).unwrap();

        assert_eq!(state.verdict(), Verdict::Ad, "L={}", state.log_lr());
        for interval in state.ads().as_slice() {
            assert!(
                interval.duration_us() <= TransportState::MAX_AD_INTERVAL_US,
                "interval {interval:?} would mute the video"
            );
        }
        assert!(
            state.should_append(11 * 60 * SEC_US),
            "media past the cap must still play"
        );
    }

    #[test]
    fn adjacent_ad_intervals_cannot_compound_past_the_cap() {
        // Regression, found by `scripts/fuzz.sh sabr_stream`: each insertion
        // was capped, then two capped intervals that touched merged into one
        // twice as long, and the bound that was supposed to keep the video
        // playing did not hold.
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        state.observe(Signal::PlayerReportsAd);
        state.observe(Signal::AdPlacementMetadata);
        assert_eq!(state.verdict(), Verdict::Ad);

        let cap = TransportState::MAX_AD_INTERVAL_US;
        // Both orders: an insertion can be absorbed from either side.
        state.insert_ad(80_000, cap + 80_000);
        state.insert_ad(0, 80_000);
        state.insert_ad(cap + 80_000, cap * 2);

        for interval in state.ads().as_slice() {
            assert!(
                interval.duration_us() <= cap,
                "{interval:?} would silence the video"
            );
        }
        assert_eq!(state.ads().len(), 1, "{:?}", state.ads().as_slice());
        assert!(
            state.should_append(cap + 80_001),
            "media past the refused region has to play"
        );
    }

    #[test]
    fn a_sabr_redirect_is_not_a_content_change() {
        // A redirect moves the same media to another host. Counting a CDN
        // handoff as a new epoch threw away the accumulated evidence that the
        // stream was content and charged it as evidence of an ad.
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        state
            .push(&stream_with(&[
                ("abc", 137, 0, 0, 5_000),
                ("abc", 137, 1, 5_000, 5_000),
                ("abc", 137, 2, 10_000, 5_000),
            ]))
            .unwrap();
        assert_eq!(state.verdict(), Verdict::Content);
        let epoch = state.epoch();

        let mut redirect = Vec::new();
        encode_part(
            PartType::SabrRedirect,
            b"https://rr5---other.googlevideo.com/",
            &mut redirect,
        );
        state.push(&redirect).unwrap();

        assert_eq!(state.epoch(), epoch, "a redirect starts no new epoch");
        assert_eq!(state.verdict(), Verdict::Content);
        assert!(
            !state
                .evidence()
                .iter()
                .any(|e| e.signal == Signal::NewTransportEpoch),
            "and contributes no evidence of an ad"
        );
    }

    #[test]
    fn media_replayed_after_a_redirect_is_not_a_discontinuity() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        let content = stream_with(&[("abc", 137, 0, 0, 5_000), ("abc", 137, 1, 5_000, 5_000)]);
        state.push(&content).unwrap();
        let before = state.log_lr();

        // The client re-issues the request it had in flight, so the same
        // segments arrive a second time.
        let replay = state.open_stream();
        state.push_stream(replay, &content).unwrap();

        assert!(
            !state
                .evidence()
                .iter()
                .any(|e| e.signal == Signal::TimelineDiscontinuity),
            "a replay is not a rewind"
        );
        assert_eq!(state.log_lr(), before, "and moves the test not at all");
    }

    #[test]
    fn having_both_an_audio_and_a_video_format_is_not_a_format_switch() {
        // Regression: keyed on a flat set of itags, the second track's first
        // format read as a switch, so every ordinary stream opened with
        // evidence of an ad.
        let mut state = TransportState::new();
        state.set_requested_video("abc");

        let mut bytes = Vec::new();
        for itag in [137u64, 140] {
            let mut header = Vec::new();
            encode_varint_field(media_header::ITAG, itag, &mut header);
            encode_varint_field(media_header::IS_INIT_SEGMENT, 1, &mut header);
            encode_part(PartType::MediaHeader, &header, &mut bytes);
        }
        state.push(&bytes).unwrap();

        assert_eq!(state.log_lr(), 0.0, "{:?}", state.evidence());

        // A real switch on an established track still registers.
        let mut switch = Vec::new();
        encode_varint_field(media_header::ITAG, 136, &mut switch);
        encode_varint_field(media_header::IS_INIT_SEGMENT, 1, &mut switch);
        let mut part = Vec::new();
        encode_part(PartType::MediaHeader, &switch, &mut part);
        state.push(&part).unwrap();
        assert!(
            state
                .evidence()
                .iter()
                .any(|e| e.signal == Signal::FormatSetChanged),
            "a video format replacing another is a switch"
        );
    }

    /// Build a continuous content stream with redirects and replays sprinkled
    /// through it, which is what a real watch on a shaky connection looks like.
    fn noisy_content_stream(segments: usize, redirect_after: &[usize]) -> Vec<u8> {
        let mut out = Vec::new();
        for index in 0..segments {
            let start = (index as i64) * 5_000;
            let header = media_header_bytes("abc", 137, index as u64, start, 5_000);
            encode_part(PartType::MediaHeader, &header, &mut out);
            encode_part(PartType::Media, &vec![0u8; 512], &mut out);

            if redirect_after.contains(&index) {
                encode_part(
                    PartType::SabrRedirect,
                    b"https://rr1.googlevideo.com/",
                    &mut out,
                );
                // The client re-issues the request, so this segment arrives
                // a second time, byte for byte.
                encode_part(PartType::MediaHeader, &header, &mut out);
                encode_part(PartType::Media, &vec![0u8; 512], &mut out);
            }
        }
        out
    }

    proptest::proptest! {
        /// The invariant a daily driver lives or dies by: media that is plainly
        /// content must never be classified as an ad, however the network
        /// chopped it up and however often the CDN moved it.
        #[test]
        fn ordinary_content_never_classifies_as_an_ad(
            segments in 3usize..20,
            redirects in proptest::collection::vec(0usize..20, 0..5),
            chunk in 1usize..400,
        ) {
            let bytes = noisy_content_stream(segments, &redirects);
            let mut state = TransportState::new();
            state.set_requested_video("abc");
            let id = state.open_stream();
            for piece in bytes.chunks(chunk) {
                state.push_stream(id, piece).unwrap();
            }

            proptest::prop_assert_ne!(state.verdict(), Verdict::Ad, "L={}", state.log_lr());
            proptest::prop_assert!(state.ads().is_empty(), "{:?}", state.ads().as_slice());
            for at in 0..segments {
                proptest::prop_assert!(
                    state.should_append((at as Micros) * 5 * SEC_US),
                    "segment {} refused", at
                );
            }
        }

        /// And the invariant that bounds the damage when it is wrong: no amount
        /// of arbitrary input may produce a skip that swallows the video.
        #[test]
        fn arbitrary_bytes_never_mint_an_unbounded_skip(
            bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..3072),
            chunk in 1usize..129,
        ) {
            let mut state = TransportState::new();
            state.set_requested_video("abc");
            let id = state.open_stream();
            for piece in bytes.chunks(chunk) {
                if state.push_stream(id, piece).is_err() {
                    break;
                }
            }
            for interval in state.ads().as_slice() {
                proptest::prop_assert!(
                    interval.duration_us() <= TransportState::MAX_AD_INTERVAL_US,
                    "{:?}", interval
                );
            }
            proptest::prop_assert!(
                state.ads().total_us() <= TransportState::MAX_AD_INTERVAL_US
                    * (state.ads().len() as Micros).max(1)
            );
        }
    }

    #[test]
    fn scrubbing_is_not_evidence_of_an_ad() {
        let mut state = TransportState::new();
        state.set_requested_video("abc");
        state
            .push(&stream_with(&[
                ("abc", 137, 0, 0, 5_000),
                ("abc", 137, 1, 5_000, 5_000),
            ]))
            .unwrap();

        // The viewer drags the scrubber to ten minutes in. What arrives next is
        // discontinuous with everything before it, and none of that is a fact
        // about whether the server is sending an ad.
        state.notify_seek();
        assert!(state.evidence().is_empty(), "{:?}", state.evidence());

        state
            .push(&stream_with(&[
                ("abc", 137, 120, 600_000, 5_000),
                ("abc", 137, 121, 605_000, 5_000),
            ]))
            .unwrap();
        assert!(
            !state
                .evidence()
                .iter()
                .any(|e| e.signal == Signal::TimelineDiscontinuity),
            "the seek absorbed the discontinuity: {:?}",
            state.evidence()
        );
        assert_ne!(state.verdict(), Verdict::Ad, "L={}", state.log_lr());
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
