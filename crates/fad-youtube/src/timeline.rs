//! Media timeline reconstruction.
//!
//! Two clocks matter, and conflating them is the single largest source of
//! wrong behaviour in a transport-level ad skipper:
//!
//! * **Transport time** `T_p` is where a byte sits in the stream the server
//!   sent, advertisements included.
//! * **Content time** `T_c` is where it sits in the video the viewer asked for.
//!
//! With ad intervals `A = {[a_1,b_1), [a_2,b_2), …}` the mapping is
//!
//! ```text
//! T_c(t) = t − Σ clamp(t − a_i, 0, b_i − a_i)
//! ```
//!
//! so a viewer at content time 120 s never conceptually enters a 15 s ad that
//! occupies transport 120 s to 135 s: 404AD maps across it.

use serde::{Deserialize, Serialize};

pub type Micros = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MediaType {
    Audio,
    Video,
    Unknown,
}

/// One observed media unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub format_id: u64,
    pub sequence: u64,
    pub start_us: Micros,
    pub duration_us: Micros,
    pub media_type: MediaType,
    pub byte_length: u64,
    pub init_id: u64,
    /// Which transport epoch produced this segment. A new epoch is evidence,
    /// not proof, that the server switched what it is sending.
    pub request_epoch: u64,
}

impl Segment {
    pub fn end_us(&self) -> Micros {
        self.start_us.saturating_add(self.duration_us)
    }
}

/// A half-open interval `[start, end)` on some clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Interval {
    pub start_us: Micros,
    pub end_us: Micros,
}

impl Interval {
    pub fn new(start_us: Micros, end_us: Micros) -> Self {
        Interval {
            start_us: start_us.min(end_us),
            end_us: start_us.max(end_us),
        }
    }

    pub fn duration_us(&self) -> Micros {
        self.end_us - self.start_us
    }

    pub fn contains(&self, at_us: Micros) -> bool {
        at_us >= self.start_us && at_us < self.end_us
    }

    pub fn is_empty(&self) -> bool {
        self.end_us <= self.start_us
    }
}

/// A sorted, disjoint set of intervals.
///
/// Kept normalised on insert so every query is a binary search rather than a
/// scan over playback history. Overlapping and adjacent inserts merge, which is
/// what makes repeated evidence about the same ad idempotent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntervalSet {
    intervals: Vec<Interval>,
}

impl IntervalSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn as_slice(&self) -> &[Interval] {
        &self.intervals
    }

    pub fn len(&self) -> usize {
        self.intervals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.intervals.is_empty()
    }

    pub fn total_us(&self) -> Micros {
        self.intervals.iter().map(Interval::duration_us).sum()
    }

    pub fn insert(&mut self, interval: Interval) {
        if interval.is_empty() {
            return;
        }
        // Find the first interval that could touch this one.
        let start = self
            .intervals
            .partition_point(|i| i.end_us < interval.start_us);
        let mut end = start;
        let mut merged = interval;
        while end < self.intervals.len() && self.intervals[end].start_us <= merged.end_us {
            merged.start_us = merged.start_us.min(self.intervals[end].start_us);
            merged.end_us = merged.end_us.max(self.intervals[end].end_us);
            end += 1;
        }
        self.intervals.splice(start..end, [merged]);
    }

    /// The interval containing `at_us`, in `O(log n)`.
    pub fn covering(&self, at_us: Micros) -> Option<Interval> {
        let idx = self.intervals.partition_point(|i| i.end_us <= at_us);
        self.intervals
            .get(idx)
            .copied()
            .filter(|i| i.contains(at_us))
    }

    pub fn contains(&self, at_us: Micros) -> bool {
        self.covering(at_us).is_some()
    }

    /// The first interval that starts at or after `at_us`.
    pub fn next_after(&self, at_us: Micros) -> Option<Interval> {
        let idx = self.intervals.partition_point(|i| i.start_us < at_us);
        self.intervals.get(idx).copied()
    }

    /// Transport time mapped to content time.
    ///
    /// `T_c(t) = t − Σ clamp(t − a_i, 0, b_i − a_i)`
    pub fn content_time(&self, transport_us: Micros) -> Micros {
        let mut elapsed_ads: Micros = 0;
        for interval in &self.intervals {
            if interval.start_us >= transport_us {
                break;
            }
            elapsed_ads += (transport_us - interval.start_us).min(interval.duration_us());
        }
        transport_us - elapsed_ads
    }

    /// Content time mapped back to transport time.
    ///
    /// The inverse is well defined because content time skips ad intervals
    /// entirely: every content instant has exactly one transport instant.
    pub fn transport_time(&self, content_us: Micros) -> Micros {
        let mut transport = content_us;
        for interval in &self.intervals {
            if interval.start_us > transport {
                break;
            }
            transport += interval.duration_us();
        }
        transport
    }

    pub fn clear(&mut self) {
        self.intervals.clear();
    }
}

/// Accumulated segments plus the continuity analysis over them.
#[derive(Debug, Clone, Default)]
pub struct Timeline {
    segments: Vec<Segment>,
    ads: IntervalSet,
}

/// How a segment sits against the one before it on the same track.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Continuity {
    /// First segment on this track; nothing to compare against.
    First,
    /// `|Δ| ≤ tolerance`: the normal case.
    Continuous { delta_us: Micros },
    /// A forward jump: bytes are missing, or a different stream started.
    Gap { delta_us: Micros },
    /// A backward jump: the timeline restarted or rewound.
    Overlap { delta_us: Micros },
}

impl Timeline {
    /// Segment timing is derived from frame counts and timescales, so exact
    /// equality never holds. 40 ms is under two frames at 50 fps and well
    /// inside normal rounding.
    pub const CONTINUITY_TOLERANCE_US: Micros = 40_000;

    pub fn new() -> Self {
        Self::default()
    }

    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    pub fn ads(&self) -> &IntervalSet {
        &self.ads
    }

    pub fn ads_mut(&mut self) -> &mut IntervalSet {
        &mut self.ads
    }

    /// Record a segment and report how it sits against its predecessor.
    pub fn observe(&mut self, segment: Segment) -> Continuity {
        let previous = self
            .segments
            .iter()
            .rev()
            .find(|s| s.media_type == segment.media_type && s.format_id == segment.format_id);

        let continuity = match previous {
            None => Continuity::First,
            Some(prev) => {
                let delta_us = segment.start_us - prev.end_us();
                if delta_us.abs() <= Self::CONTINUITY_TOLERANCE_US {
                    Continuity::Continuous { delta_us }
                } else if delta_us > 0 {
                    Continuity::Gap { delta_us }
                } else {
                    Continuity::Overlap { delta_us }
                }
            }
        };
        self.segments.push(segment);
        continuity
    }

    /// Total transport duration observed, i.e. the end of the last segment.
    pub fn transport_end_us(&self) -> Micros {
        self.segments.iter().map(Segment::end_us).max().unwrap_or(0)
    }

    pub fn content_time(&self, transport_us: Micros) -> Micros {
        self.ads.content_time(transport_us)
    }

    /// Drop history older than `before_us` in transport time.
    ///
    /// Segment history is only needed for continuity and for the interval map.
    /// Keeping every segment of a six-hour stream would be a memory leak with
    /// extra steps.
    pub fn prune(&mut self, before_us: Micros) {
        self.segments.retain(|s| s.end_us() >= before_us);
    }

    pub fn reset(&mut self) {
        self.segments.clear();
        self.ads.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const SEC: Micros = 1_000_000;

    fn segment(seq: u64, start_s: i64, dur_s: i64) -> Segment {
        Segment {
            format_id: 140,
            sequence: seq,
            start_us: start_s * SEC,
            duration_us: dur_s * SEC,
            media_type: MediaType::Video,
            byte_length: 1024,
            init_id: 1,
            request_epoch: 0,
        }
    }

    #[test]
    fn intervals_merge_on_insert() {
        let mut set = IntervalSet::new();
        set.insert(Interval::new(10, 20));
        set.insert(Interval::new(30, 40));
        set.insert(Interval::new(15, 35));
        assert_eq!(set.as_slice(), &[Interval::new(10, 40)]);
    }

    #[test]
    fn adjacent_intervals_merge_so_repeated_evidence_is_idempotent() {
        let mut set = IntervalSet::new();
        set.insert(Interval::new(0, 10));
        set.insert(Interval::new(10, 20));
        assert_eq!(set.len(), 1);

        set.insert(Interval::new(5, 15));
        assert_eq!(set.as_slice(), &[Interval::new(0, 20)]);
    }

    #[test]
    fn empty_intervals_are_ignored() {
        let mut set = IntervalSet::new();
        set.insert(Interval::new(10, 10));
        assert!(set.is_empty());
    }

    #[test]
    fn covering_finds_the_interval_around_a_point() {
        let mut set = IntervalSet::new();
        set.insert(Interval::new(10, 20));
        set.insert(Interval::new(40, 50));

        assert_eq!(set.covering(15), Some(Interval::new(10, 20)));
        assert_eq!(
            set.covering(10),
            Some(Interval::new(10, 20)),
            "start is inclusive"
        );
        assert_eq!(set.covering(20), None, "end is exclusive");
        assert_eq!(set.covering(45), Some(Interval::new(40, 50)));
        assert_eq!(set.covering(100), None);
    }

    #[test]
    fn next_after_finds_the_upcoming_ad() {
        let mut set = IntervalSet::new();
        set.insert(Interval::new(120 * SEC, 135 * SEC));
        assert_eq!(set.next_after(0), Some(Interval::new(120 * SEC, 135 * SEC)));
        assert_eq!(set.next_after(200 * SEC), None);
    }

    #[test]
    fn content_time_maps_across_an_ad() {
        // transport 0────120────135────────600
        //                  [ AD ]
        // content   0────120──────────────585
        let mut set = IntervalSet::new();
        set.insert(Interval::new(120 * SEC, 135 * SEC));

        assert_eq!(set.content_time(0), 0);
        assert_eq!(set.content_time(120 * SEC), 120 * SEC);
        // Anywhere inside the ad collapses to its start.
        assert_eq!(set.content_time(130 * SEC), 120 * SEC);
        assert_eq!(set.content_time(135 * SEC), 120 * SEC);
        assert_eq!(set.content_time(600 * SEC), 585 * SEC);
    }

    #[test]
    fn content_time_handles_several_ads() {
        let mut set = IntervalSet::new();
        set.insert(Interval::new(60 * SEC, 75 * SEC));
        set.insert(Interval::new(300 * SEC, 330 * SEC));
        assert_eq!(set.content_time(400 * SEC), (400 - 15 - 30) * SEC);
    }

    #[test]
    fn transport_time_inverts_content_time() {
        let mut set = IntervalSet::new();
        set.insert(Interval::new(120 * SEC, 135 * SEC));
        set.insert(Interval::new(400 * SEC, 430 * SEC));

        for content in [0, 50 * SEC, 119 * SEC, 120 * SEC, 300 * SEC, 500 * SEC] {
            let transport = set.transport_time(content);
            assert_eq!(set.content_time(transport), content, "content {content}");
        }
    }

    #[test]
    fn continuity_recognises_the_normal_case() {
        let mut timeline = Timeline::new();
        assert_eq!(timeline.observe(segment(0, 0, 10)), Continuity::First);
        assert!(matches!(
            timeline.observe(segment(1, 10, 10)),
            Continuity::Continuous { .. }
        ));
    }

    #[test]
    fn rounding_inside_two_frames_is_still_continuous() {
        let mut timeline = Timeline::new();
        timeline.observe(segment(0, 0, 10));
        let mut next = segment(1, 10, 10);
        next.start_us += 30_000;
        assert!(matches!(
            timeline.observe(next),
            Continuity::Continuous { .. }
        ));
    }

    #[test]
    fn a_forward_jump_is_a_gap_and_a_backward_jump_is_an_overlap() {
        let mut timeline = Timeline::new();
        timeline.observe(segment(0, 0, 10));
        assert!(matches!(
            timeline.observe(segment(1, 25, 10)),
            Continuity::Gap { .. }
        ));

        let mut other = Timeline::new();
        other.observe(segment(0, 100, 10));
        assert!(matches!(
            other.observe(segment(1, 50, 10)),
            Continuity::Overlap { .. }
        ));
    }

    #[test]
    fn continuity_is_tracked_per_track() {
        // Audio and video interleave; comparing one against the other would
        // report a discontinuity on every single segment.
        let mut timeline = Timeline::new();
        timeline.observe(segment(0, 0, 10));

        let mut audio = segment(0, 0, 10);
        audio.media_type = MediaType::Audio;
        audio.format_id = 251;
        assert_eq!(timeline.observe(audio), Continuity::First);

        assert!(matches!(
            timeline.observe(segment(1, 10, 10)),
            Continuity::Continuous { .. }
        ));
    }

    #[test]
    fn pruning_drops_only_history_behind_the_cursor() {
        let mut timeline = Timeline::new();
        for i in 0..10 {
            timeline.observe(segment(i, i as i64 * 10, 10));
        }
        timeline.prune(50 * SEC);
        assert!(timeline.segments().iter().all(|s| s.end_us() >= 50 * SEC));
        assert!(!timeline.segments().is_empty());
    }

    proptest! {
        /// Content time must never run backwards as transport time advances.
        #[test]
        fn content_time_is_monotonic(
            spans in prop::collection::vec((0i64..500, 1i64..40), 0..8),
            probe in 0i64..600,
        ) {
            let mut set = IntervalSet::new();
            for (start, len) in spans {
                set.insert(Interval::new(start * SEC, (start + len) * SEC));
            }
            let a = set.content_time(probe * SEC);
            let b = set.content_time((probe + 1) * SEC);
            prop_assert!(b >= a, "content time went backwards: {a} then {b}");
        }

        /// Content time can never exceed transport time: skipping only removes.
        #[test]
        fn content_time_never_exceeds_transport_time(
            spans in prop::collection::vec((0i64..500, 1i64..40), 0..8),
            probe in 0i64..600,
        ) {
            let mut set = IntervalSet::new();
            for (start, len) in spans {
                set.insert(Interval::new(start * SEC, (start + len) * SEC));
            }
            prop_assert!(set.content_time(probe * SEC) <= probe * SEC);
        }

        /// Insert order must not change the resulting set.
        #[test]
        fn insert_order_does_not_matter(
            mut spans in prop::collection::vec((0i64..200, 1i64..30), 1..10),
        ) {
            let build = |items: &[(i64, i64)]| {
                let mut set = IntervalSet::new();
                for (start, len) in items {
                    set.insert(Interval::new(start * SEC, (start + len) * SEC));
                }
                set
            };
            let forward = build(&spans);
            spans.reverse();
            prop_assert_eq!(forward, build(&spans));
        }
    }
}
