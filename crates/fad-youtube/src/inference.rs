//! Sequential ad classification.
//!
//! A DOM selector is a dashboard light. The transport is the engine. So instead
//! of `if (document.querySelector('.ytp-ad-player-overlay'))`, evidence is
//! accumulated from several independent observations and tested with **Wald's
//! sequential probability ratio test**.
//!
//! For each observation `x_k` the log-likelihood ratio is
//!
//! ```text
//! L_n = Σ log( P(x_k | AD) / P(x_k | CONTENT) )
//! ```
//!
//! and the decision is
//!
//! ```text
//! L_n ≥ ln((1-β)/α)   ⇒  AD
//! L_n ≤ ln(β/(1-α))   ⇒  CONTENT
//! otherwise           ⇒  UNKNOWN
//! ```
//!
//! No model, no training, no opaque score. Every signal carries an explicit
//! `P(x|AD)` and `P(x|CONTENT)`, both visible in [`Evidence`], so the whole
//! decision can be printed and argued with.
//!
//! # Why the thresholds are asymmetric
//!
//! The two errors are not equally bad. Declaring content to be an ad skips part
//! of the video the viewer asked for, which is unacceptable. Declaring an ad to
//! be content shows an ad, which is merely the status quo. So `α`, the
//! false-ad rate, is set fifty times tighter than `β`.

use serde::{Deserialize, Serialize};

/// P(declare AD | actually CONTENT). Skipping real content is the bad error.
pub const ALPHA: f64 = 0.001;
/// P(declare CONTENT | actually AD). Showing an ad is the tolerable error.
pub const BETA: f64 = 0.05;

/// `ln((1-β)/α)` — cross this and the verdict is AD.
pub fn upper_threshold() -> f64 {
    ((1.0 - BETA) / ALPHA).ln()
}

/// `ln(β/(1-α))` — cross this and the verdict is CONTENT.
pub fn lower_threshold() -> f64 {
    (BETA / (1.0 - ALPHA)).ln()
}

/// An observation, with its likelihood under each hypothesis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Signal {
    /// The player's own state machine says an ad is showing.
    PlayerReportsAd,
    /// The player's own state machine says content is showing.
    PlayerReportsContent,
    /// The InnerTube response carried ad placement metadata for this position.
    AdPlacementMetadata,
    /// The media timeline jumped where it should have been continuous.
    TimelineDiscontinuity,
    /// A short, self-contained media epoch. Ads are short; videos usually are not.
    ShortIsolatedEpoch,
    /// The transport started a new request epoch mid-playback.
    NewTransportEpoch,
    /// An ad renderer became active in the page.
    AdRendererActivated,
    /// The set of available formats changed, which a mid-roll switch causes.
    FormatSetChanged,
    /// The media identity matches the video the viewer requested.
    ContentVideoIdentityMatch,
    /// The media header names a different video than the one requested. Strong,
    /// because content segments carry the requested id and ads do not.
    MediaIdentityMismatch,
    /// The timeline ran on with no discontinuity.
    ContinuousTimeline,
    /// The current media epoch is long enough that an ad is implausible.
    LongDurationEpoch,
}

impl Signal {
    /// `P(signal | AD)` and `P(signal | CONTENT)`.
    ///
    /// These are stated priors, not fitted parameters. They are chosen to be
    /// defensible from how the player behaves, and they are deliberately not
    /// extreme: no single signal should be able to decide on its own, except
    /// where the player itself has told us what it is doing.
    pub const fn likelihood(self) -> (f64, f64) {
        match self {
            Signal::PlayerReportsAd => (0.97, 0.02),
            Signal::AdPlacementMetadata => (0.95, 0.005),
            Signal::AdRendererActivated => (0.80, 0.10),
            Signal::ShortIsolatedEpoch => (0.65, 0.10),
            Signal::TimelineDiscontinuity => (0.70, 0.25),
            Signal::NewTransportEpoch => (0.55, 0.30),
            Signal::FormatSetChanged => (0.60, 0.35),
            Signal::ContinuousTimeline => (0.20, 0.90),
            Signal::PlayerReportsContent => (0.03, 0.98),
            Signal::ContentVideoIdentityMatch => (0.02, 0.95),
            Signal::MediaIdentityMismatch => (0.90, 0.03),
            Signal::LongDurationEpoch => (0.02, 0.60),
        }
    }

    /// `log( P(x|AD) / P(x|CONTENT) )`.
    pub fn log_likelihood_ratio(self) -> f64 {
        let (ad, content) = self.likelihood();
        (ad / content).ln()
    }

    pub const fn name(self) -> &'static str {
        match self {
            Signal::PlayerReportsAd => "player reports an ad",
            Signal::PlayerReportsContent => "player reports content",
            Signal::AdPlacementMetadata => "ad placement metadata present",
            Signal::TimelineDiscontinuity => "media timeline discontinuity",
            Signal::ShortIsolatedEpoch => "short isolated media epoch",
            Signal::NewTransportEpoch => "new transport epoch",
            Signal::AdRendererActivated => "ad renderer activated",
            Signal::FormatSetChanged => "format set changed",
            Signal::ContentVideoIdentityMatch => "media identity matches the request",
            Signal::MediaIdentityMismatch => "media identity differs from the request",
            Signal::ContinuousTimeline => "timeline continuous",
            Signal::LongDurationEpoch => "epoch too long to be an ad",
        }
    }
}

/// One accumulated observation, kept so the decision can be shown and argued with.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    pub signal: Signal,
    pub p_ad: f64,
    pub p_content: f64,
    pub log_lr: f64,
    /// Running total after this observation.
    pub cumulative: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Ad,
    Content,
    Unknown,
}

/// A sequential test over one media epoch.
#[derive(Debug, Clone)]
pub struct Sprt {
    log_lr: f64,
    evidence: Vec<Evidence>,
    upper: f64,
    lower: f64,
    /// Bound on retained evidence. A long session must not accumulate forever.
    max_evidence: usize,
}

impl Default for Sprt {
    fn default() -> Self {
        Self::new()
    }
}

impl Sprt {
    const MAX_EVIDENCE: usize = 64;

    pub fn new() -> Self {
        Sprt {
            log_lr: 0.0,
            evidence: Vec::new(),
            upper: upper_threshold(),
            lower: lower_threshold(),
            max_evidence: Self::MAX_EVIDENCE,
        }
    }

    pub fn observe(&mut self, signal: Signal) -> Verdict {
        let (p_ad, p_content) = signal.likelihood();
        let log_lr = signal.log_likelihood_ratio();
        self.log_lr += log_lr;

        // Clamp the accumulator. Without this a long stream of weak evidence
        // pins the test so far past a threshold that contrary evidence can
        // never pull it back, and the classifier stops responding to reality.
        let ceiling = self.upper.abs().max(self.lower.abs()) * 3.0;
        self.log_lr = self.log_lr.clamp(-ceiling, ceiling);

        self.evidence.push(Evidence {
            signal,
            p_ad,
            p_content,
            log_lr,
            cumulative: self.log_lr,
        });
        if self.evidence.len() > self.max_evidence {
            self.evidence.remove(0);
        }
        self.verdict()
    }

    pub fn verdict(&self) -> Verdict {
        if self.log_lr >= self.upper {
            Verdict::Ad
        } else if self.log_lr <= self.lower {
            Verdict::Content
        } else {
            Verdict::Unknown
        }
    }

    pub fn log_lr(&self) -> f64 {
        self.log_lr
    }

    pub fn thresholds(&self) -> (f64, f64) {
        (self.lower, self.upper)
    }

    pub fn evidence(&self) -> &[Evidence] {
        &self.evidence
    }

    /// How far the accumulator is past the threshold it crossed, in nats.
    ///
    /// Reported rather than converted to a percentage: this is a likelihood
    /// ratio, and dressing it up as a confidence score would be pretending to
    /// a calibration the test does not have.
    pub fn margin(&self) -> f64 {
        match self.verdict() {
            Verdict::Ad => self.log_lr - self.upper,
            Verdict::Content => self.lower - self.log_lr,
            Verdict::Unknown => 0.0,
        }
    }

    /// Start a fresh test. Called when a new media epoch begins.
    pub fn reset(&mut self) {
        self.log_lr = 0.0;
        self.evidence.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn run(signals: &[Signal]) -> Sprt {
        let mut sprt = Sprt::new();
        for signal in signals {
            sprt.observe(*signal);
        }
        sprt
    }

    #[test]
    fn thresholds_come_from_the_stated_error_rates() {
        // ln(0.95/0.001) and ln(0.05/0.999).
        assert!(
            (upper_threshold() - 6.856_461).abs() < 1e-5,
            "{}",
            upper_threshold()
        );
        assert!(
            (lower_threshold() + 2.994_732).abs() < 1e-5,
            "{}",
            lower_threshold()
        );
        // Asymmetric on purpose: skipping content is worse than showing an ad.
        assert!(upper_threshold() > lower_threshold().abs());
    }

    #[test]
    fn nothing_observed_is_unknown_rather_than_a_guess() {
        assert_eq!(Sprt::new().verdict(), Verdict::Unknown);
    }

    #[test]
    fn no_single_weak_signal_decides_on_its_own() {
        for signal in [
            Signal::TimelineDiscontinuity,
            Signal::NewTransportEpoch,
            Signal::FormatSetChanged,
            Signal::ShortIsolatedEpoch,
            Signal::AdRendererActivated,
        ] {
            assert_eq!(
                run(&[signal]).verdict(),
                Verdict::Unknown,
                "{}",
                signal.name()
            );
        }
    }

    #[test]
    fn the_player_and_the_metadata_agreeing_is_enough() {
        let sprt = run(&[Signal::PlayerReportsAd, Signal::AdPlacementMetadata]);
        assert_eq!(sprt.verdict(), Verdict::Ad);
        assert!(sprt.log_lr() > upper_threshold());
    }

    #[test]
    fn transport_evidence_alone_does_not_reach_the_ad_threshold() {
        // Five independent weak signals sum to about 6.13 nats against an upper
        // threshold of 6.86. That gap is the asymmetry doing its job: skipping
        // content is the error worth being conservative about, so circumstantial
        // transport evidence is not allowed to decide by itself.
        let sprt = run(&[
            Signal::TimelineDiscontinuity,
            Signal::ShortIsolatedEpoch,
            Signal::NewTransportEpoch,
            Signal::FormatSetChanged,
            Signal::AdRendererActivated,
        ]);
        assert_eq!(sprt.verdict(), Verdict::Unknown, "L={}", sprt.log_lr());
        assert!(
            sprt.log_lr() > 5.0,
            "but it should get close: L={}",
            sprt.log_lr()
        );
    }

    #[test]
    fn one_corroborating_signal_tips_accumulated_transport_evidence_over() {
        let sprt = run(&[
            Signal::TimelineDiscontinuity,
            Signal::ShortIsolatedEpoch,
            Signal::NewTransportEpoch,
            Signal::FormatSetChanged,
            Signal::AdRendererActivated,
            Signal::PlayerReportsAd,
        ]);
        assert_eq!(sprt.verdict(), Verdict::Ad, "L={}", sprt.log_lr());
    }

    #[test]
    fn transport_evidence_alone_can_still_decide_when_it_repeats() {
        // A genuine ad break produces the same discontinuity evidence on every
        // segment it delivers, so the test converges without the DOM ever being
        // consulted. That is the whole point of doing this at the transport
        // layer.
        let sprt = run(&[
            Signal::TimelineDiscontinuity,
            Signal::ShortIsolatedEpoch,
            Signal::NewTransportEpoch,
            Signal::TimelineDiscontinuity,
            Signal::ShortIsolatedEpoch,
            Signal::TimelineDiscontinuity,
        ]);
        assert_eq!(sprt.verdict(), Verdict::Ad, "L={}", sprt.log_lr());
        // Six observations, not two. Converging slowly on circumstantial
        // evidence is the intended shape of this test.
        assert_eq!(sprt.evidence().len(), 6);
    }

    #[test]
    fn content_evidence_reaches_the_lower_threshold() {
        let sprt = run(&[
            Signal::ContentVideoIdentityMatch,
            Signal::ContinuousTimeline,
        ]);
        assert_eq!(sprt.verdict(), Verdict::Content);
    }

    #[test]
    fn contrary_evidence_can_pull_a_verdict_back() {
        let mut sprt = Sprt::new();
        sprt.observe(Signal::TimelineDiscontinuity);
        sprt.observe(Signal::ShortIsolatedEpoch);
        sprt.observe(Signal::NewTransportEpoch);
        assert_eq!(sprt.verdict(), Verdict::Unknown);

        // The player says it is playing the requested video after all.
        sprt.observe(Signal::ContentVideoIdentityMatch);
        sprt.observe(Signal::PlayerReportsContent);
        assert_eq!(sprt.verdict(), Verdict::Content, "L={}", sprt.log_lr());
    }

    #[test]
    fn the_accumulator_is_clamped_so_it_can_always_be_argued_with() {
        // Without a clamp, a long ad break pins the test so far positive that
        // no amount of content evidence could ever move it back.
        let mut sprt = Sprt::new();
        for _ in 0..500 {
            sprt.observe(Signal::PlayerReportsAd);
        }
        assert_eq!(sprt.verdict(), Verdict::Ad);

        for _ in 0..20 {
            sprt.observe(Signal::PlayerReportsContent);
        }
        assert_eq!(sprt.verdict(), Verdict::Content, "L={}", sprt.log_lr());
    }

    #[test]
    fn evidence_is_retained_for_inspection_and_bounded() {
        let mut sprt = Sprt::new();
        for _ in 0..200 {
            sprt.observe(Signal::TimelineDiscontinuity);
        }
        assert!(sprt.evidence().len() <= 64);

        let last = sprt.evidence().last().unwrap();
        assert_eq!(last.signal, Signal::TimelineDiscontinuity);
        assert!((last.p_ad - 0.70).abs() < 1e-9);
        assert!((last.p_content - 0.25).abs() < 1e-9);
    }

    #[test]
    fn every_signal_points_the_way_its_name_implies() {
        for signal in [
            Signal::PlayerReportsAd,
            Signal::AdPlacementMetadata,
            Signal::AdRendererActivated,
            Signal::ShortIsolatedEpoch,
            Signal::TimelineDiscontinuity,
            Signal::NewTransportEpoch,
            Signal::FormatSetChanged,
            Signal::MediaIdentityMismatch,
        ] {
            assert!(
                signal.log_likelihood_ratio() > 0.0,
                "{} should favour AD",
                signal.name()
            );
        }
        for signal in [
            Signal::ContinuousTimeline,
            Signal::PlayerReportsContent,
            Signal::ContentVideoIdentityMatch,
            Signal::LongDurationEpoch,
        ] {
            assert!(
                signal.log_likelihood_ratio() < 0.0,
                "{} should favour CONTENT",
                signal.name()
            );
        }
    }

    #[test]
    fn a_media_identity_mismatch_is_strong_but_not_sufficient_alone() {
        // ln(0.90/0.03) is about 3.4 nats: heavy evidence, still short of the
        // 6.86 needed to act.
        let sprt = run(&[Signal::MediaIdentityMismatch]);
        assert_eq!(sprt.verdict(), Verdict::Unknown, "L={}", sprt.log_lr());

        let sprt = run(&[
            Signal::MediaIdentityMismatch,
            Signal::TimelineDiscontinuity,
            Signal::ShortIsolatedEpoch,
            Signal::NewTransportEpoch,
        ]);
        assert_eq!(sprt.verdict(), Verdict::Ad, "L={}", sprt.log_lr());
    }

    #[test]
    fn reset_starts_a_fresh_epoch() {
        let mut sprt = run(&[Signal::PlayerReportsAd, Signal::AdPlacementMetadata]);
        assert_eq!(sprt.verdict(), Verdict::Ad);
        sprt.reset();
        assert_eq!(sprt.verdict(), Verdict::Unknown);
        assert!(sprt.evidence().is_empty());
    }

    proptest! {
        /// Order of observation must not change the verdict: addition commutes.
        #[test]
        fn observation_order_does_not_change_the_verdict(
            indices in prop::collection::vec(0usize..12, 1..12),
        ) {
            const ALL: [Signal; 12] = [
                Signal::PlayerReportsAd,
                Signal::PlayerReportsContent,
                Signal::AdPlacementMetadata,
                Signal::TimelineDiscontinuity,
                Signal::ShortIsolatedEpoch,
                Signal::NewTransportEpoch,
                Signal::AdRendererActivated,
                Signal::FormatSetChanged,
                Signal::ContentVideoIdentityMatch,
                Signal::MediaIdentityMismatch,
                Signal::ContinuousTimeline,
                Signal::LongDurationEpoch,
            ];
            let signals: Vec<Signal> = indices.iter().map(|i| ALL[*i]).collect();
            let forward = run(&signals).verdict();
            let mut reversed = signals.clone();
            reversed.reverse();
            prop_assert_eq!(forward, run(&reversed).verdict());
        }

        /// The accumulator must stay finite whatever arrives.
        #[test]
        fn the_accumulator_never_diverges(count in 0usize..2000) {
            let mut sprt = Sprt::new();
            for i in 0..count {
                sprt.observe(if i % 2 == 0 { Signal::PlayerReportsAd } else { Signal::AdPlacementMetadata });
            }
            prop_assert!(sprt.log_lr().is_finite());
        }
    }
}
