//! The UMP variable-length integer.
//!
//! UMP does not use protobuf LEB128. It uses a prefix-length encoding where the
//! first byte announces the total width and carries the low bits of the value:
//!
//! ```text
//! prefix < 0x80   1 byte    value = prefix
//! prefix < 0xC0   2 bytes   value = (prefix & 0x3F) | b1 << 6
//! prefix < 0xE0   3 bytes   value = (prefix & 0x1F) | b1 << 5  | b2 << 13
//! prefix < 0xF0   4 bytes   value = (prefix & 0x0F) | b1 << 4  | b2 << 12 | b3 << 20
//! otherwise       5 bytes   value = b1 | b2 << 8 | b3 << 16 | b4 << 24
//! ```
//!
//! The five-byte form discards the prefix entirely and reads a little-endian
//! u32, which is why values above 2^32-1 cannot be expressed at all.
//!
//! This encoding is not published by Google. It is reconstructed from the wire
//! format and cross-checked against independent implementations, so it is
//! treated here as an observation rather than a specification: every decode
//! path is total, and a malformed input yields [`VarintError`] rather than a
//! panic or a silently wrong number.

use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum VarintError {
    /// The buffer ends before the announced width. Not fatal for a stream: the
    /// caller should wait for more bytes and retry.
    #[error("need {needed} bytes, have {have}")]
    Incomplete { needed: usize, have: usize },
}

/// Bytes a varint occupies, given its first byte.
#[inline]
pub const fn width_of(prefix: u8) -> usize {
    match prefix {
        0x00..=0x7F => 1,
        0x80..=0xBF => 2,
        0xC0..=0xDF => 3,
        0xE0..=0xEF => 4,
        _ => 5,
    }
}

/// Decode a varint at the start of `bytes`, returning the value and its width.
pub fn read(bytes: &[u8]) -> Result<(u64, usize), VarintError> {
    let Some(&prefix) = bytes.first() else {
        return Err(VarintError::Incomplete { needed: 1, have: 0 });
    };
    let width = width_of(prefix);
    if bytes.len() < width {
        return Err(VarintError::Incomplete {
            needed: width,
            have: bytes.len(),
        });
    }

    let value = match width {
        1 => u64::from(prefix),
        2 => u64::from(prefix & 0x3F) | (u64::from(bytes[1]) << 6),
        3 => u64::from(prefix & 0x1F) | (u64::from(bytes[1]) << 5) | (u64::from(bytes[2]) << 13),
        4 => {
            u64::from(prefix & 0x0F)
                | (u64::from(bytes[1]) << 4)
                | (u64::from(bytes[2]) << 12)
                | (u64::from(bytes[3]) << 20)
        }
        // The prefix contributes nothing in the widest form.
        _ => u64::from(u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]])),
    };
    Ok((value, width))
}

/// Encode a value. Used by the tests and by fixture construction, not on any
/// hot path, so it favours clarity over cleverness.
pub fn write(value: u64, out: &mut Vec<u8>) {
    match value {
        0..=0x7F => out.push(value as u8),
        0x80..=0x3FFF => {
            out.push(0x80 | (value & 0x3F) as u8);
            out.push((value >> 6) as u8);
        }
        0x4000..=0x1F_FFFF => {
            out.push(0xC0 | (value & 0x1F) as u8);
            out.push((value >> 5) as u8);
            out.push((value >> 13) as u8);
        }
        0x20_0000..=0x0FFF_FFFF => {
            out.push(0xE0 | (value & 0x0F) as u8);
            out.push((value >> 4) as u8);
            out.push((value >> 12) as u8);
            out.push((value >> 20) as u8);
        }
        _ => {
            out.push(0xFF);
            out.extend_from_slice(&(value as u32).to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn roundtrip(value: u64) -> u64 {
        let mut buf = Vec::new();
        write(value, &mut buf);
        let (decoded, width) = read(&buf).expect("decodes");
        assert_eq!(
            width,
            buf.len(),
            "width must match the encoding for {value}"
        );
        decoded
    }

    #[test]
    fn each_width_boundary_round_trips() {
        for value in [
            0,
            1,
            0x7F,
            0x80,
            0x3FFF,
            0x4000,
            0x1F_FFFF,
            0x20_0000,
            0x0FFF_FFFF,
            0x1000_0000,
            u64::from(u32::MAX),
        ] {
            assert_eq!(roundtrip(value), value, "value {value:#x}");
        }
    }

    #[test]
    fn width_is_a_pure_function_of_the_prefix() {
        assert_eq!(width_of(0x00), 1);
        assert_eq!(width_of(0x7F), 1);
        assert_eq!(width_of(0x80), 2);
        assert_eq!(width_of(0xBF), 2);
        assert_eq!(width_of(0xC0), 3);
        assert_eq!(width_of(0xDF), 3);
        assert_eq!(width_of(0xE0), 4);
        assert_eq!(width_of(0xEF), 4);
        assert_eq!(width_of(0xF0), 5);
        assert_eq!(width_of(0xFF), 5);
    }

    #[test]
    fn a_truncated_varint_asks_for_more_bytes_instead_of_guessing() {
        // This is the single most common condition in a streaming parser: the
        // chunk boundary landed inside a header.
        assert_eq!(
            read(&[]),
            Err(VarintError::Incomplete { needed: 1, have: 0 })
        );
        assert_eq!(
            read(&[0x80]),
            Err(VarintError::Incomplete { needed: 2, have: 1 })
        );
        assert_eq!(
            read(&[0xFF, 1, 2]),
            Err(VarintError::Incomplete { needed: 5, have: 3 })
        );
    }

    #[test]
    fn the_five_byte_form_ignores_the_prefix_bits() {
        // Every prefix at or above 0xF0 must decode identically.
        let tail = [0x78, 0x56, 0x34, 0x12];
        let expected = u64::from(u32::from_le_bytes(tail));
        for prefix in [0xF0u8, 0xF7, 0xFF] {
            let mut buf = vec![prefix];
            buf.extend_from_slice(&tail);
            assert_eq!(read(&buf).unwrap().0, expected, "prefix {prefix:#x}");
        }
    }

    proptest! {
        #[test]
        fn every_u32_round_trips(value in 0u32..=u32::MAX) {
            prop_assert_eq!(roundtrip(u64::from(value)), u64::from(value));
        }

        #[test]
        fn decoding_arbitrary_bytes_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..8)) {
            let _ = read(&bytes);
        }

        /// A decoded varint must never claim to consume more than it was given.
        #[test]
        fn width_never_exceeds_the_input(bytes in prop::collection::vec(any::<u8>(), 1..8)) {
            if let Ok((_, width)) = read(&bytes) {
                prop_assert!(width <= bytes.len());
            }
        }
    }
}
