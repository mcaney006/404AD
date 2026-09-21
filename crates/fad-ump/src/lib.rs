//! Incremental parser for UMP-framed media responses.
//!
//! YouTube's web client increasingly serves media through SABR, its adaptive
//! streaming protocol, in which audio and video arrive inside UMP-framed
//! responses rather than as ordinary DASH or HLS segment URLs. A URL-matching
//! blocker cannot see inside that, which is why this parser exists.
//!
//! The framing is a flat sequence of parts:
//!
//! ```text
//! ┌───────────┬───────────┬──────────────┐
//! │ varint    │ varint    │ payload      │
//! │ part type │ part size │ size bytes   │
//! └───────────┴───────────┴──────────────┘
//! ```
//!
//! # Design
//!
//! The parser is a **push** state machine. Bytes arrive from a
//! `ReadableStream` in whatever sizes the network produced, and a part header
//! routinely straddles a chunk boundary. So:
//!
//! * [`UmpParser::push`] accepts any chunk size, including one byte.
//! * Completed parts are borrowed out of the internal buffer, never copied into
//!   a fresh `Vec` per part.
//! * The buffer compacts from the front once consumed, so a long stream does
//!   not grow memory without bound.
//! * Bulk media payloads are *always* skipped rather than buffered. 404AD reads
//!   the frames around media, never the media, so copying an 8 MB segment into
//!   a buffer to hand it to a callback that ignores it would be pure cost.
//!   [`UmpParser::max_part_size`] therefore guards metadata parts only.

pub mod varint;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// UMP part types.
///
/// The numeric values are observed on the wire, not published. Unknown types
/// are preserved rather than discarded: a part 404AD does not recognise still
/// has a length, and skipping it correctly is what keeps the stream aligned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PartType {
    OnesieHeader,
    OnesieData,
    MediaHeader,
    Media,
    MediaEnd,
    LiveMetadata,
    NextRequestPolicy,
    FormatInitializationMetadata,
    SabrRedirect,
    SabrError,
    SabrSeek,
    ReloadPlayerResponse,
    PlaybackStartPolicy,
    AllowedCachedFormats,
    StreamProtectionStatus,
    SabrContextUpdate,
    Unknown(u32),
}

impl PartType {
    pub const fn from_id(id: u32) -> Self {
        match id {
            10 => PartType::OnesieHeader,
            11 => PartType::OnesieData,
            20 => PartType::MediaHeader,
            21 => PartType::Media,
            22 => PartType::MediaEnd,
            23 => PartType::LiveMetadata,
            35 => PartType::NextRequestPolicy,
            42 => PartType::FormatInitializationMetadata,
            43 => PartType::SabrRedirect,
            44 => PartType::SabrError,
            45 => PartType::SabrSeek,
            46 => PartType::ReloadPlayerResponse,
            47 => PartType::PlaybackStartPolicy,
            48 => PartType::AllowedCachedFormats,
            57 => PartType::StreamProtectionStatus,
            58 => PartType::SabrContextUpdate,
            other => PartType::Unknown(other),
        }
    }

    pub const fn id(self) -> u32 {
        match self {
            PartType::OnesieHeader => 10,
            PartType::OnesieData => 11,
            PartType::MediaHeader => 20,
            PartType::Media => 21,
            PartType::MediaEnd => 22,
            PartType::LiveMetadata => 23,
            PartType::NextRequestPolicy => 35,
            PartType::FormatInitializationMetadata => 42,
            PartType::SabrRedirect => 43,
            PartType::SabrError => 44,
            PartType::SabrSeek => 45,
            PartType::ReloadPlayerResponse => 46,
            PartType::PlaybackStartPolicy => 47,
            PartType::AllowedCachedFormats => 48,
            PartType::StreamProtectionStatus => 57,
            PartType::SabrContextUpdate => 58,
            PartType::Unknown(id) => id,
        }
    }

    /// Is this part bulk media rather than metadata?
    ///
    /// Bulk media is the only thing worth skipping instead of buffering.
    pub const fn is_bulk(self) -> bool {
        matches!(self, PartType::Media | PartType::OnesieData)
    }
}

/// One completed part, borrowed from the parser's buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Part<'a> {
    pub kind: PartType,
    /// Declared payload length, which may exceed `payload.len()` when the part
    /// was skipped for being bulk media.
    pub declared_len: usize,
    /// Payload bytes, empty for a skipped part.
    pub payload: &'a [u8],
    /// True when the payload was skipped rather than buffered.
    pub skipped: bool,
    /// Byte offset of this part's first header byte within the whole stream.
    pub stream_offset: u64,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum UmpError {
    /// A part declared a length the parser refuses to hold in memory *and*
    /// which is not bulk media it is willing to skip.
    #[error("part {kind:?} declares {len} bytes, over the {limit} byte limit")]
    PartTooLarge {
        kind: PartType,
        len: usize,
        limit: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Between parts: the next bytes are a part-type varint.
    Header,
    /// Header read; consuming or skipping `remaining` payload bytes.
    Payload {
        kind: PartType,
        declared_len: usize,
        remaining: usize,
        offset: u64,
    },
}

/// Streaming statistics, useful for diagnostics and for the benchmark budget.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UmpStats {
    pub bytes_in: u64,
    pub parts: u64,
    pub bulk_bytes_skipped: u64,
    /// High-water mark of bytes *retained between pushes*.
    ///
    /// Measured after parsing, not before: the transient size of whatever
    /// chunk the caller handed over says nothing about whether the parser is
    /// accumulating, and this number exists to answer exactly that.
    pub peak_buffer: usize,
}

pub struct UmpParser {
    buffer: Vec<u8>,
    /// Bytes at the front of `buffer` already consumed. Compacted lazily.
    consumed: usize,
    state: State,
    stream_offset: u64,
    max_part_size: usize,
    stats: UmpStats,
}

impl UmpParser {
    /// Metadata parts are small; this ceiling is generous for them and far
    /// below any media payload.
    pub const DEFAULT_MAX_PART: usize = 1 << 20;

    /// Compact the front of the buffer once this much has been consumed.
    const COMPACT_THRESHOLD: usize = 64 * 1024;

    pub fn new() -> Self {
        Self::with_max_part(Self::DEFAULT_MAX_PART)
    }

    pub fn with_max_part(max_part_size: usize) -> Self {
        UmpParser {
            buffer: Vec::with_capacity(16 * 1024),
            consumed: 0,
            state: State::Header,
            stream_offset: 0,
            max_part_size,
            stats: UmpStats::default(),
        }
    }

    pub fn stats(&self) -> UmpStats {
        self.stats
    }

    pub fn max_part_size(&self) -> usize {
        self.max_part_size
    }

    /// Feed a chunk and drain every part it completed.
    ///
    /// `on_part` is called once per completed part, in order. The borrow ends
    /// when the callback returns, which is what allows the payload to be a
    /// slice of the internal buffer instead of a fresh allocation.
    pub fn push<F>(&mut self, chunk: &[u8], mut on_part: F) -> Result<(), UmpError>
    where
        F: FnMut(Part<'_>),
    {
        self.stats.bytes_in += chunk.len() as u64;
        self.buffer.extend_from_slice(chunk);

        loop {
            match self.state {
                State::Header => {
                    let available = &self.buffer[self.consumed..];
                    // A part header is two varints. Both must be present.
                    let Ok((type_id, type_width)) = varint::read(available) else {
                        break;
                    };
                    let Ok((size, size_width)) = varint::read(&available[type_width..]) else {
                        break;
                    };

                    let kind = PartType::from_id(type_id as u32);
                    let declared_len = size as usize;
                    if declared_len > self.max_part_size && !kind.is_bulk() {
                        return Err(UmpError::PartTooLarge {
                            kind,
                            len: declared_len,
                            limit: self.max_part_size,
                        });
                    }

                    let offset = self.stream_offset;
                    self.advance(type_width + size_width);
                    self.state = State::Payload {
                        kind,
                        declared_len,
                        remaining: declared_len,
                        offset,
                    };
                }

                State::Payload {
                    kind,
                    declared_len,
                    remaining,
                    offset,
                } => {
                    let available = self.buffer.len() - self.consumed;

                    // Bulk media is skipped: 404AD needs the headers that frame
                    // it, never the encoded frames themselves.
                    // Bulk media is always skipped, whatever its size: 404AD
                    // needs the headers that frame it, never the frames.
                    if kind.is_bulk() {
                        let take = remaining.min(available);
                        self.advance(take);
                        self.stats.bulk_bytes_skipped += take as u64;
                        let left = remaining - take;
                        if left > 0 {
                            self.state = State::Payload {
                                kind,
                                declared_len,
                                remaining: left,
                                offset,
                            };
                            break;
                        }
                        self.stats.parts += 1;
                        on_part(Part {
                            kind,
                            declared_len,
                            payload: &[],
                            skipped: true,
                            stream_offset: offset,
                        });
                        self.state = State::Header;
                        continue;
                    }

                    if available < remaining {
                        break;
                    }
                    let start = self.consumed;
                    let end = start + declared_len;
                    self.stats.parts += 1;
                    on_part(Part {
                        kind,
                        declared_len,
                        payload: &self.buffer[start..end],
                        skipped: false,
                        stream_offset: offset,
                    });
                    self.advance(declared_len);
                    self.state = State::Header;
                }
            }
        }

        self.compact();
        self.stats.peak_buffer = self.stats.peak_buffer.max(self.pending());
        Ok(())
    }

    fn advance(&mut self, bytes: usize) {
        self.consumed += bytes;
        self.stream_offset += bytes as u64;
    }

    /// Drop consumed bytes from the front once they are worth reclaiming.
    ///
    /// ponytail: `drain` shifts the tail, which is O(remaining). It runs at most
    /// once per 64 KB consumed, so the amortised cost is a fraction of a copy
    /// per byte. Upgrade path: a real ring buffer, if profiling ever shows this
    /// on top.
    fn compact(&mut self) {
        if self.consumed >= Self::COMPACT_THRESHOLD || self.consumed == self.buffer.len() {
            self.buffer.drain(..self.consumed);
            self.consumed = 0;
        }
    }

    /// Bytes buffered but not yet parsed.
    pub fn pending(&self) -> usize {
        self.buffer.len() - self.consumed
    }

    /// Byte offset of the next unparsed byte in the whole stream.
    pub fn offset(&self) -> u64 {
        self.stream_offset
    }

    /// True when the parser is between parts, i.e. the stream could end here.
    pub fn at_boundary(&self) -> bool {
        matches!(self.state, State::Header) && self.pending() == 0
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        self.consumed = 0;
        self.state = State::Header;
        self.stream_offset = 0;
    }
}

impl Default for UmpParser {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a UMP part. Used by tests and fixtures.
pub fn encode_part(kind: PartType, payload: &[u8], out: &mut Vec<u8>) {
    varint::write(u64::from(kind.id()), out);
    varint::write(payload.len() as u64, out);
    out.extend_from_slice(payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn collect(chunks: &[&[u8]]) -> Vec<(PartType, Vec<u8>, bool)> {
        let mut parser = UmpParser::new();
        let mut parts = Vec::new();
        for chunk in chunks {
            parser
                .push(chunk, |p| {
                    parts.push((p.kind, p.payload.to_vec(), p.skipped))
                })
                .expect("parses");
        }
        parts
    }

    fn stream(parts: &[(PartType, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (kind, payload) in parts {
            encode_part(*kind, payload, &mut out);
        }
        out
    }

    #[test]
    fn parses_a_simple_sequence() {
        let bytes = stream(&[
            (PartType::MediaHeader, vec![1, 2, 3]),
            (PartType::Media, vec![9; 64]),
            (PartType::MediaEnd, vec![]),
        ]);
        let parts = collect(&[&bytes]);

        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].0, PartType::MediaHeader);
        assert_eq!(parts[0].1, vec![1, 2, 3]);
        assert_eq!(parts[1].0, PartType::Media);
        assert_eq!(parts[2].0, PartType::MediaEnd);
        assert!(parts[2].1.is_empty());
    }

    #[test]
    fn a_header_split_across_chunks_is_reassembled() {
        // The whole reason this is a push parser: chunk boundaries land inside
        // headers constantly.
        let bytes = stream(&[(PartType::MediaHeader, vec![7; 300])]);
        for split in 1..bytes.len().min(12) {
            let parts = collect(&[&bytes[..split], &bytes[split..]]);
            assert_eq!(parts.len(), 1, "split at {split}");
            assert_eq!(parts[0].1.len(), 300);
        }
    }

    #[test]
    fn one_byte_at_a_time_produces_the_same_parts() {
        let bytes = stream(&[
            (PartType::MediaHeader, vec![1, 2, 3, 4]),
            (PartType::NextRequestPolicy, vec![5, 6]),
        ]);
        let whole = collect(&[&bytes]);

        let mut parser = UmpParser::new();
        let mut drip = Vec::new();
        for byte in &bytes {
            parser
                .push(&[*byte], |p| {
                    drip.push((p.kind, p.payload.to_vec(), p.skipped))
                })
                .unwrap();
        }
        assert_eq!(whole, drip);
    }

    #[test]
    fn unknown_part_types_are_preserved_and_stay_aligned() {
        // Skipping an unknown part by its declared length is what keeps every
        // *known* part after it parseable.
        let bytes = stream(&[
            (PartType::Unknown(9_999), vec![0xAB; 40]),
            (PartType::MediaHeader, vec![1]),
        ]);
        let parts = collect(&[&bytes]);
        assert_eq!(parts[0].0, PartType::Unknown(9_999));
        assert_eq!(parts[0].1.len(), 40);
        assert_eq!(parts[1].0, PartType::MediaHeader);
    }

    #[test]
    fn small_bulk_media_is_skipped_too() {
        // Size is not the criterion: media bytes are never interesting.
        let mut parser = UmpParser::new();
        let mut bytes = Vec::new();
        encode_part(PartType::Media, &[1, 2, 3, 4], &mut bytes);
        encode_part(PartType::MediaHeader, &[9], &mut bytes);

        let mut seen = Vec::new();
        parser
            .push(&bytes, |p| seen.push((p.kind, p.declared_len, p.skipped)))
            .unwrap();
        assert_eq!(seen[0], (PartType::Media, 4, true));
        assert_eq!(seen[1], (PartType::MediaHeader, 1, false));
        assert_eq!(parser.stats().bulk_bytes_skipped, 4);
    }

    #[test]
    fn bulk_media_is_skipped_rather_than_buffered() {
        let mut parser = UmpParser::with_max_part(64);
        let mut bytes = Vec::new();
        encode_part(PartType::Media, &vec![0u8; 4096], &mut bytes);
        encode_part(PartType::MediaHeader, &[1, 2], &mut bytes);

        let mut seen = Vec::new();
        // Feed in small chunks so the skip path spans several pushes.
        for chunk in bytes.chunks(97) {
            parser
                .push(chunk, |p| {
                    seen.push((p.kind, p.declared_len, p.skipped, p.payload.len()))
                })
                .unwrap();
        }

        assert_eq!(seen[0], (PartType::Media, 4096, true, 0));
        assert_eq!(seen[1], (PartType::MediaHeader, 2, false, 2));
        assert_eq!(parser.stats().bulk_bytes_skipped, 4096);
        // The point of skipping: nothing of the payload is retained.
        assert!(
            parser.stats().peak_buffer < 200,
            "{}",
            parser.stats().peak_buffer
        );
    }

    #[test]
    fn an_oversized_metadata_part_is_an_error_not_an_allocation() {
        let mut parser = UmpParser::with_max_part(16);
        let mut bytes = Vec::new();
        varint::write(u64::from(PartType::MediaHeader.id()), &mut bytes);
        varint::write(1_000_000, &mut bytes);

        let err = parser.push(&bytes, |_| {}).unwrap_err();
        assert!(matches!(err, UmpError::PartTooLarge { .. }), "{err:?}");
    }

    #[test]
    fn stream_offsets_point_at_each_part_header() {
        let bytes = stream(&[
            (PartType::MediaHeader, vec![1, 2, 3]),
            (PartType::Media, vec![4, 5]),
        ]);
        let mut parser = UmpParser::new();
        let mut offsets = Vec::new();
        parser
            .push(&bytes, |p| offsets.push(p.stream_offset))
            .unwrap();

        assert_eq!(offsets[0], 0);
        // type varint + size varint + 3 payload bytes.
        assert_eq!(offsets[1], 5);
    }

    #[test]
    fn the_buffer_does_not_grow_without_bound() {
        let mut parser = UmpParser::new();
        let one = stream(&[(PartType::MediaHeader, vec![0; 512])]);
        for _ in 0..2_000 {
            parser.push(&one, |_| {}).unwrap();
        }
        assert_eq!(parser.pending(), 0);
        assert!(
            parser.stats().peak_buffer < 512 * 1024,
            "peak buffer {} suggests the parser is accumulating",
            parser.stats().peak_buffer
        );
    }

    #[test]
    fn at_boundary_reports_whether_the_stream_may_end_here() {
        let mut parser = UmpParser::new();
        assert!(parser.at_boundary());

        let bytes = stream(&[(PartType::MediaHeader, vec![1, 2, 3])]);
        parser.push(&bytes[..2], |_| {}).unwrap();
        assert!(!parser.at_boundary(), "mid-part");

        parser.push(&bytes[2..], |_| {}).unwrap();
        assert!(parser.at_boundary());
    }

    proptest! {
        /// Whatever the chunking, the parts must come out identical.
        #[test]
        fn chunking_never_changes_the_parse(
            payloads in prop::collection::vec(prop::collection::vec(any::<u8>(), 0..80), 1..10),
            chunk_size in 1usize..64,
        ) {
            let parts: Vec<(PartType, Vec<u8>)> = payloads
                .iter()
                .enumerate()
                .map(|(i, p)| (PartType::from_id(20 + (i as u32 % 4)), p.clone()))
                .collect();
            let bytes = stream(&parts);

            let whole = collect(&[&bytes]);
            let chunks: Vec<&[u8]> = bytes.chunks(chunk_size).collect();
            let split = collect(&chunks);
            prop_assert_eq!(whole, split);
        }

        /// Arbitrary bytes must never panic the parser.
        #[test]
        fn arbitrary_input_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
            let mut parser = UmpParser::with_max_part(4096);
            let _ = parser.push(&bytes, |_| {});
        }
    }
}
