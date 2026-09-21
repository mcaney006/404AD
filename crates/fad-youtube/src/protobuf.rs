//! A minimal protobuf field scanner.
//!
//! UMP metadata parts carry protobuf messages. 404AD needs perhaps eight fields
//! out of them, all scalars, from messages whose `.proto` is not published. A
//! full protobuf runtime would add a code-generation step and a dependency to
//! decode structures that are reverse-engineered anyway.
//!
//! So: scan fields, hand back the ones asked for, skip the rest correctly.
//! Skipping correctly is the part that matters, because an unknown field with a
//! mis-computed length desynchronises everything after it.

use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireType {
    Varint,
    Fixed64,
    LengthDelimited,
    Fixed32,
    /// Groups are deprecated and never appear here, but they still have to be
    /// recognised to be skipped.
    StartGroup,
    EndGroup,
}

impl WireType {
    fn from_bits(bits: u64) -> Option<Self> {
        Some(match bits {
            0 => WireType::Varint,
            1 => WireType::Fixed64,
            2 => WireType::LengthDelimited,
            3 => WireType::StartGroup,
            4 => WireType::EndGroup,
            5 => WireType::Fixed32,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value<'a> {
    Varint(u64),
    Fixed64(u64),
    Fixed32(u32),
    Bytes(&'a [u8]),
    /// A group marker. Present for completeness; never interpreted.
    Group,
}

impl<'a> Value<'a> {
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::Varint(v) => Some(*v),
            Value::Fixed64(v) => Some(*v),
            Value::Fixed32(v) => Some(u64::from(*v)),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        self.as_u64().map(|v| v != 0)
    }

    /// Lossy on purpose: a corrupt string must not fail a whole decode.
    pub fn as_str(&self) -> Option<Cow<'a, str>> {
        match self {
            Value::Bytes(b) => Some(String::from_utf8_lossy(b)),
            _ => None,
        }
    }

    pub fn as_bytes(&self) -> Option<&'a [u8]> {
        match self {
            Value::Bytes(b) => Some(b),
            _ => None,
        }
    }
}

/// Standard protobuf base-128 varint, distinct from the UMP one.
fn read_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    for (index, byte) in bytes.iter().take(10).enumerate() {
        value |= u64::from(byte & 0x7F) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}

/// Visit every field in a message.
///
/// Returns `false` if the message is malformed, after visiting whatever was
/// readable. A partially readable metadata part is more useful than none.
pub fn scan<'a, F>(mut bytes: &'a [u8], mut visit: F) -> bool
where
    // The lifetime is tied to the input so a caller can keep a borrowed field
    // rather than being forced to copy every string out of the closure.
    F: FnMut(u32, Value<'a>),
{
    while !bytes.is_empty() {
        let Some((tag, tag_len)) = read_varint(bytes) else {
            return false;
        };
        let Some(wire) = WireType::from_bits(tag & 0x07) else {
            return false;
        };
        let field = (tag >> 3) as u32;
        if field == 0 {
            return false;
        }
        bytes = &bytes[tag_len..];

        match wire {
            WireType::Varint => {
                let Some((value, len)) = read_varint(bytes) else {
                    return false;
                };
                visit(field, Value::Varint(value));
                bytes = &bytes[len..];
            }
            WireType::Fixed64 => {
                if bytes.len() < 8 {
                    return false;
                }
                let value = u64::from_le_bytes(bytes[..8].try_into().expect("checked"));
                visit(field, Value::Fixed64(value));
                bytes = &bytes[8..];
            }
            WireType::Fixed32 => {
                if bytes.len() < 4 {
                    return false;
                }
                let value = u32::from_le_bytes(bytes[..4].try_into().expect("checked"));
                visit(field, Value::Fixed32(value));
                bytes = &bytes[4..];
            }
            WireType::LengthDelimited => {
                let Some((len, len_width)) = read_varint(bytes) else {
                    return false;
                };
                let len = len as usize;
                let rest = &bytes[len_width..];
                if rest.len() < len {
                    return false;
                }
                visit(field, Value::Bytes(&rest[..len]));
                bytes = &rest[len..];
            }
            WireType::StartGroup | WireType::EndGroup => {
                visit(field, Value::Group);
            }
        }
    }
    true
}

/// Encode a field. Test and fixture support only.
pub fn encode_varint_field(field: u32, value: u64, out: &mut Vec<u8>) {
    write_varint(u64::from(field) << 3, out);
    write_varint(value, out);
}

pub fn encode_bytes_field(field: u32, value: &[u8], out: &mut Vec<u8>) {
    write_varint((u64::from(field) << 3) | 2, out);
    write_varint(value.len() as u64, out);
    out.extend_from_slice(value);
}

fn write_varint(mut value: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7F) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn fields(bytes: &[u8]) -> Vec<(u32, Value<'_>)> {
        let mut out = Vec::new();
        scan(bytes, |field, value| out.push((field, value)));
        out
    }

    #[test]
    fn reads_varint_and_string_fields() {
        let mut buf = Vec::new();
        encode_varint_field(3, 140, &mut buf);
        encode_bytes_field(2, b"dQw4w9WgXcQ", &mut buf);
        encode_varint_field(12, 15_000, &mut buf);

        let parsed = fields(&buf);
        assert_eq!(parsed[0], (3, Value::Varint(140)));
        assert_eq!(parsed[1].0, 2);
        assert_eq!(parsed[1].1.as_str().unwrap(), "dQw4w9WgXcQ");
        assert_eq!(parsed[2], (12, Value::Varint(15_000)));
    }

    #[test]
    fn an_unknown_field_is_skipped_without_desynchronising_the_rest() {
        // The whole reason this scanner exists: the messages are
        // reverse-engineered, so unknown fields are the normal case.
        let mut buf = Vec::new();
        encode_bytes_field(99, &[0xFF; 40], &mut buf);
        encode_varint_field(3, 251, &mut buf);

        let parsed = fields(&buf);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1], (3, Value::Varint(251)));
    }

    #[test]
    fn multi_byte_varints_decode() {
        let mut buf = Vec::new();
        encode_varint_field(1, 300, &mut buf);
        encode_varint_field(2, u64::from(u32::MAX), &mut buf);
        let parsed = fields(&buf);
        assert_eq!(parsed[0].1.as_u64(), Some(300));
        assert_eq!(parsed[1].1.as_u64(), Some(u64::from(u32::MAX)));
    }

    #[test]
    fn a_truncated_message_yields_what_was_readable() {
        let mut buf = Vec::new();
        encode_varint_field(3, 140, &mut buf);
        encode_bytes_field(2, b"abcdef", &mut buf);
        buf.truncate(buf.len() - 3);

        let mut seen = Vec::new();
        let ok = scan(&buf, |field, _| seen.push(field));
        assert!(!ok, "a truncated message is reported as malformed");
        assert_eq!(seen, vec![3], "but the readable prefix still came through");
    }

    #[test]
    fn field_zero_is_rejected_rather_than_treated_as_data() {
        assert!(!scan(&[0x00, 0x01], |_, _| {}));
    }

    #[test]
    fn a_length_longer_than_the_buffer_is_refused() {
        // Otherwise a hostile length would index out of bounds.
        let mut buf = Vec::new();
        write_varint((2u64 << 3) | 2, &mut buf);
        write_varint(1_000_000, &mut buf);
        buf.extend_from_slice(b"short");
        assert!(!scan(&buf, |_, _| {}));
    }

    proptest! {
        #[test]
        fn scanning_arbitrary_bytes_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..256)) {
            let _ = scan(&bytes, |_, _| {});
        }

        #[test]
        fn varint_fields_round_trip(field in 1u32..2000, value in any::<u32>()) {
            let mut buf = Vec::new();
            encode_varint_field(field, u64::from(value), &mut buf);
            let parsed = fields(&buf);
            prop_assert_eq!(parsed.len(), 1);
            prop_assert_eq!(parsed[0].0, field);
            prop_assert_eq!(parsed[0].1.as_u64(), Some(u64::from(value)));
        }
    }
}
