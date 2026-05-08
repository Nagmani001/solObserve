//! Round-trip test: SDK macro emits a log line; the decoder's parser (mirrored
//! here as a small helper) reads it back into the same `SobsMsg` variant.

use base64::Engine;
use solobserve_sdk::{
    encode_log_line, EventMsg, MetricMsg, ShortStr, SobsMsg, SpanEndMsg, SpanStartMsg,
};

/// Mirror of the parser in `services/decoder/src/main.rs` — kept tiny and
/// self-contained so we can keep them in lock-step.
fn parse_line(line: &str) -> Option<SobsMsg> {
    let payload = line.strip_prefix("__SOBS__:")?;
    let (_tag, b64) = payload.split_once(':')?;
    let frame = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(b64.trim())
        .ok()?;
    SobsMsg::decode_frame(&frame).ok()
}

#[test]
fn metric_roundtrip() {
    let msg = SobsMsg::Metric(MetricMsg {
        name: ShortStr::new("swap_count"),
        value: 7,
        labels: vec![(ShortStr::new("side"), ShortStr::new("buy"))],
    });
    let line = encode_log_line(&msg);
    let back = parse_line(&line).expect("parse");
    assert_eq!(back, msg);
}

#[test]
fn event_roundtrip() {
    let msg = SobsMsg::Event(EventMsg {
        name: ShortStr::new("TradeExecuted"),
        payload: b"hello".to_vec(),
        labels: vec![],
    });
    let line = encode_log_line(&msg);
    assert_eq!(parse_line(&line).unwrap(), msg);
}

#[test]
fn span_pair_roundtrip() {
    let start = SobsMsg::SpanStart(SpanStartMsg {
        id: 42,
        name: ShortStr::new("swap"),
        args: vec![1, 2, 3],
    });
    let end = SobsMsg::SpanEnd(SpanEndMsg {
        id: 42,
        status: 0,
        result: vec![],
        cu_consumed: 1500,
    });
    assert_eq!(parse_line(&encode_log_line(&start)).unwrap(), start);
    assert_eq!(parse_line(&encode_log_line(&end)).unwrap(), end);
}

#[test]
fn bad_line_returns_none() {
    assert!(parse_line("not a sobs line").is_none());
    assert!(parse_line("__SOBS__:m:!!notbase64!!").is_none());
}
