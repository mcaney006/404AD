//! WASM bindings for the YouTube transport engine.
//!
//! Shipped as a **separate** module from the main 404AD runtime and loaded only
//! when a SABR media request is first seen, so no cost is paid on any site that
//! is not YouTube, and none on YouTube until playback actually starts.
//!
//! The boundary is deliberately thin. JavaScript owns the stream plumbing,
//! which it is good at; Rust owns framing, timeline reconstruction and
//! inference, which it is good at. Nothing crosses the boundary per byte: the
//! only hot call is [`TransportEngine::push`], once per network chunk.

use fad_youtube::inference::Signal;
use fad_youtube::inference::{Evidence, Verdict};
use fad_youtube::timeline::Micros;
use fad_youtube::transport::{Policy, PushOutcome, TransportState};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    std::panic::set_hook(Box::new(|info| {
        web_error(&format!("404AD youtube wasm panic: {info}"));
    }));
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn web_error(msg: &str);
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Signal names accepted by [`TransportEngine::observe`].
///
/// Strings rather than an exported enum so the caller stays readable and a
/// rename on either side fails loudly instead of silently shifting an index.
fn signal_from_name(name: &str) -> Option<Signal> {
    Some(match name {
        "player-ad" => Signal::PlayerReportsAd,
        "player-content" => Signal::PlayerReportsContent,
        "ad-placement-metadata" => Signal::AdPlacementMetadata,
        "timeline-discontinuity" => Signal::TimelineDiscontinuity,
        "short-epoch" => Signal::ShortIsolatedEpoch,
        "new-epoch" => Signal::NewTransportEpoch,
        "ad-renderer" => Signal::AdRendererActivated,
        "format-change" => Signal::FormatSetChanged,
        "identity-match" => Signal::ContentVideoIdentityMatch,
        "identity-mismatch" => Signal::MediaIdentityMismatch,
        "continuous-timeline" => Signal::ContinuousTimeline,
        "long-epoch" => Signal::LongDurationEpoch,
        _ => return None,
    })
}

fn verdict_name(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Ad => "ad",
        Verdict::Content => "content",
        Verdict::Unknown => "unknown",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyReport {
    action: &'static str,
    until_us: Option<Micros>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceReport {
    signal: &'static str,
    p_ad: f64,
    p_content: f64,
    log_lr: f64,
    cumulative: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateReport {
    verdict: &'static str,
    log_lr: f64,
    lower_threshold: f64,
    upper_threshold: f64,
    epoch: u64,
    ad_intervals: Vec<(Micros, Micros)>,
    total_ad_us: Micros,
    evidence: Vec<EvidenceReport>,
    bytes_in: u64,
    parts: u64,
    bulk_bytes_skipped: u64,
    peak_buffer: usize,
}

fn describe(evidence: &[Evidence]) -> Vec<EvidenceReport> {
    evidence
        .iter()
        .map(|e| EvidenceReport {
            signal: e.signal.name(),
            p_ad: e.p_ad,
            p_content: e.p_content,
            log_lr: e.log_lr,
            cumulative: e.cumulative,
        })
        .collect()
}

#[wasm_bindgen]
pub struct TransportEngine {
    state: TransportState,
}

#[wasm_bindgen]
impl TransportEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TransportEngine {
        TransportEngine {
            state: TransportState::new(),
        }
    }

    /// The video the viewer asked for. Changing it discards everything learned
    /// about the previous stream.
    #[wasm_bindgen(js_name = setRequestedVideo)]
    pub fn set_requested_video(&mut self, video_id: &str) {
        self.state.set_requested_video(video_id);
    }

    /// Feed one network chunk. The only per-chunk call across the boundary.
    pub fn push(&mut self, chunk: &[u8]) -> Result<JsValue, JsValue> {
        let outcome: PushOutcome = self
            .state
            .push(chunk)
            .map_err(|e| JsValue::from_str(&format!("ump: {e}")))?;
        to_js(&outcome)
    }

    /// Record an observation from the page.
    ///
    /// Returns the verdict after the observation. An unknown signal name is an
    /// error rather than a silent no-op: a typo here would quietly remove
    /// evidence from the test.
    pub fn observe(&mut self, signal: &str) -> Result<String, JsValue> {
        let signal = signal_from_name(signal)
            .ok_or_else(|| JsValue::from_str(&format!("unknown signal `{signal}`")))?;
        Ok(verdict_name(self.state.observe(signal)).to_string())
    }

    pub fn verdict(&self) -> String {
        verdict_name(self.state.verdict()).to_string()
    }

    /// What to do with media at this transport timestamp, in microseconds.
    #[wasm_bindgen(js_name = policyAt)]
    pub fn policy_at(&self, transport_us: f64) -> Result<JsValue, JsValue> {
        let report = match self.state.policy_at(transport_us as Micros) {
            Policy::Allow => PolicyReport {
                action: "allow",
                until_us: None,
            },
            Policy::Unknown => PolicyReport {
                action: "unknown",
                until_us: None,
            },
            Policy::Skip { until_us } => PolicyReport {
                action: "skip",
                until_us: Some(until_us),
            },
        };
        to_js(&report)
    }

    /// The MediaSource gate.
    #[wasm_bindgen(js_name = shouldAppend)]
    pub fn should_append(&self, transport_us: f64) -> bool {
        self.state.should_append(transport_us as Micros)
    }

    /// Where playback should resume if this point is inside an ad.
    #[wasm_bindgen(js_name = resumeTarget)]
    pub fn resume_target(&self, transport_us: f64) -> Option<f64> {
        self.state
            .resume_target(transport_us as Micros)
            .map(|v| v as f64)
    }

    /// Transport time mapped to the viewer's clock.
    #[wasm_bindgen(js_name = contentTime)]
    pub fn content_time(&self, transport_us: f64) -> f64 {
        self.state.content_time(transport_us as Micros) as f64
    }

    /// The viewer's clock mapped back to transport time.
    #[wasm_bindgen(js_name = transportTime)]
    pub fn transport_time(&self, content_us: f64) -> f64 {
        self.state.transport_time(content_us as Micros) as f64
    }

    /// Everything the diagnostics panel needs, in one call.
    pub fn state(&self) -> Result<JsValue, JsValue> {
        let stats = self.state.parser_stats();
        let ads = self.state.ads();
        to_js(&StateReport {
            verdict: verdict_name(self.state.verdict()),
            log_lr: self.state.log_lr(),
            lower_threshold: fad_youtube::inference::lower_threshold(),
            upper_threshold: fad_youtube::inference::upper_threshold(),
            epoch: self.state.epoch(),
            ad_intervals: ads
                .as_slice()
                .iter()
                .map(|i| (i.start_us, i.end_us))
                .collect(),
            total_ad_us: ads.total_us(),
            evidence: describe(self.state.evidence()),
            bytes_in: stats.bytes_in,
            parts: stats.parts,
            bulk_bytes_skipped: stats.bulk_bytes_skipped,
            peak_buffer: stats.peak_buffer,
        })
    }

    /// Drop timeline history behind the playback cursor.
    pub fn prune(&mut self, before_us: f64) {
        self.state.prune(before_us as Micros);
    }

    pub fn reset(&mut self) {
        self.state.reset();
    }
}

impl Default for TransportEngine {
    fn default() -> Self {
        Self::new()
    }
}
