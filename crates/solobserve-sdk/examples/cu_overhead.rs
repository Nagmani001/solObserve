//! Smoke benchmark for the SDK macros.
//!
//! On the host (cargo bench / cargo run), we measure encode-then-format-line
//! latency for each variant. This is *not* the on-chain CU count — that
//! requires `solana-test-validator` and BPF execution and is documented in
//! `CU_COST.md`. The host bench guards against regressions in the encode hot
//! path that would also blow up on-chain.
//!
//! Run: `cargo run --release --example cu_overhead -p solobserve-sdk`.

use solobserve_sdk::{
    encode_log_line, EventMsg, MetricMsg, ShortStr, SobsMsg, SpanEndMsg, SpanStartMsg,
};
use std::time::Instant;

fn bench<F: Fn()>(label: &str, n: u32, f: F) {
    let t = Instant::now();
    for _ in 0..n {
        f();
    }
    let elapsed = t.elapsed();
    let per = elapsed.as_nanos() as f64 / n as f64;
    println!("{label:>14}  {per:>8.0} ns/op  (n={n})");
}

fn main() {
    let n = 100_000;
    bench("metric", n, || {
        let m = SobsMsg::Metric(MetricMsg {
            name: ShortStr::new("swap_count"),
            value: 1,
            labels: vec![(ShortStr::new("side"), ShortStr::new("buy"))],
        });
        let _ = encode_log_line(&m);
    });
    bench("event", n, || {
        let m = SobsMsg::Event(EventMsg {
            name: ShortStr::new("TradeExecuted"),
            payload: vec![0u8; 24],
            labels: vec![],
        });
        let _ = encode_log_line(&m);
    });
    bench("span_start", n, || {
        let m = SobsMsg::SpanStart(SpanStartMsg {
            id: 1,
            name: ShortStr::new("swap"),
            args: vec![],
        });
        let _ = encode_log_line(&m);
    });
    bench("span_end", n, || {
        let m = SobsMsg::SpanEnd(SpanEndMsg {
            id: 1,
            status: 0,
            result: vec![],
            cu_consumed: 1234,
        });
        let _ = encode_log_line(&m);
    });
}
