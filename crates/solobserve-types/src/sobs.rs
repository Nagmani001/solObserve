//! SobsMsg — shared wire format for the SolObserve instrumentation SDK.
//!
//! Used by both the SDK emitter (in-program) and the decoder parser.
//! Layout: leading version byte (currently 1) + Borsh-serialized [`SobsMsg`].
//! The whole frame is then base64-encoded and emitted via `msg!()` with the
//! prefix `__SOBS__:<tag>:<base64>` where `<tag>` is one of `m|e|s+|s-` to
//! allow cheap classification by the decoder before Borsh-decoding.

use borsh::{BorshDeserialize, BorshSerialize};

pub const SOBS_VERSION: u8 = 1;
pub const SOBS_PREFIX: &str = "__SOBS__:";

/// Short bounded string (max 64 bytes). Length-prefixed in Borsh form.
#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ShortStr(pub String);

impl ShortStr {
    pub fn new(s: impl Into<String>) -> Self {
        let mut v: String = s.into();
        if v.len() > 64 {
            v.truncate(64);
        }
        Self(v)
    }
}

impl From<&str> for ShortStr {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

/// Status code for span termination.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
pub enum SpanStatus {
    Ok = 0,
    Err = 1,
    Panic = 2,
}

#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct MetricMsg {
    pub name: ShortStr,
    pub value: i64,
    pub labels: Vec<(ShortStr, ShortStr)>,
}

#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct EventMsg {
    pub name: ShortStr,
    pub payload: Vec<u8>,
    pub labels: Vec<(ShortStr, ShortStr)>,
}

#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct SpanStartMsg {
    pub id: u64,
    pub name: ShortStr,
    pub args: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct SpanEndMsg {
    pub id: u64,
    pub status: u8,
    pub result: Vec<u8>,
    pub cu_consumed: u32,
}

#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub enum SobsMsg {
    Metric(MetricMsg),
    Event(EventMsg),
    SpanStart(SpanStartMsg),
    SpanEnd(SpanEndMsg),
}

impl SobsMsg {
    pub fn tag(&self) -> &'static str {
        match self {
            SobsMsg::Metric(_) => "m",
            SobsMsg::Event(_) => "e",
            SobsMsg::SpanStart(_) => "s+",
            SobsMsg::SpanEnd(_) => "s-",
        }
    }

    /// Encode as a versioned Borsh frame.
    pub fn encode_frame(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64);
        out.push(SOBS_VERSION);
        BorshSerialize::serialize(self, &mut out).expect("borsh serialize");
        out
    }

    /// Decode a frame produced by [`encode_frame`].
    pub fn decode_frame(bytes: &[u8]) -> Result<Self, SobsDecodeError> {
        if bytes.is_empty() {
            return Err(SobsDecodeError::Empty);
        }
        let version = bytes[0];
        if version != SOBS_VERSION {
            return Err(SobsDecodeError::Version(version));
        }
        BorshDeserialize::try_from_slice(&bytes[1..]).map_err(SobsDecodeError::Borsh)
    }
}

#[derive(Debug)]
pub enum SobsDecodeError {
    Empty,
    Version(u8),
    Borsh(std::io::Error),
}

impl std::fmt::Display for SobsDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SobsDecodeError::Empty => f.write_str("empty SobsMsg frame"),
            SobsDecodeError::Version(v) => write!(f, "unsupported SobsMsg version {v}"),
            SobsDecodeError::Borsh(e) => write!(f, "borsh decode: {e}"),
        }
    }
}

impl std::error::Error for SobsDecodeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_metric() {
        let msg = SobsMsg::Metric(MetricMsg {
            name: ShortStr::new("swap_count"),
            value: 42,
            labels: vec![(ShortStr::new("status"), ShortStr::new("ok"))],
        });
        let frame = msg.encode_frame();
        assert_eq!(frame[0], SOBS_VERSION);
        let back = SobsMsg::decode_frame(&frame).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn roundtrip_span() {
        let start = SobsMsg::SpanStart(SpanStartMsg {
            id: 7,
            name: ShortStr::new("swap"),
            args: vec![1, 2, 3],
        });
        let end = SobsMsg::SpanEnd(SpanEndMsg {
            id: 7,
            status: SpanStatus::Ok as u8,
            result: vec![],
            cu_consumed: 1234,
        });
        assert_eq!(SobsMsg::decode_frame(&start.encode_frame()).unwrap(), start);
        assert_eq!(SobsMsg::decode_frame(&end.encode_frame()).unwrap(), end);
    }

    #[test]
    fn reject_bad_version() {
        let bytes = [99u8, 0, 0, 0];
        assert!(matches!(
            SobsMsg::decode_frame(&bytes).unwrap_err(),
            SobsDecodeError::Version(99)
        ));
    }

    #[test]
    fn short_str_truncates() {
        let big = "x".repeat(200);
        let s = ShortStr::new(big);
        assert_eq!(s.0.len(), 64);
    }
}
