//! SolObserve instrumentation SDK.
//!
//! Drop this into an Anchor / raw Rust Solana program and use the
//! [`metric!`], [`event!`], [`span_start!`] and [`span_end!`] macros to emit
//! structured telemetry. Payloads land on-chain as `msg!()` log lines with a
//! magic prefix that the SolObserve decoder service recognizes.
//!
//! ## Feature flags
//!
//! - `dev` (default): macros expand to full encode + `msg!` calls.
//! - `release`: macros expand to no-ops. CU cost: 0.
//!
//! Either feature can be chosen via `Cargo.toml`:
//! ```toml
//! solobserve-sdk = { version = "0.1", default-features = false, features = ["release"] }
//! ```

pub use solobserve_types::{
    EventMsg, MetricMsg, ShortStr, SobsMsg, SpanEndMsg, SpanStartMsg, SpanStatus, SOBS_PREFIX,
};

#[doc(hidden)]
pub use base64;
#[doc(hidden)]
pub use borsh;

/// Encode a [`SobsMsg`] into the prefixed log line format expected by the
/// decoder.
///
/// Useful for tests and the local CLI harness; macros call this internally.
pub fn encode_log_line(msg: &SobsMsg) -> alloc::string::String {
    use base64::Engine;
    let frame = msg.encode_frame();
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(frame);
    alloc::format!("{}{}:{}", SOBS_PREFIX, msg.tag(), b64)
}

extern crate alloc;

/// Emit a metric: counter or gauge sample.
///
/// ```ignore
/// use solobserve_sdk::metric;
/// metric!("swap_count", 1, [("status", "ok")]);
/// ```
#[macro_export]
macro_rules! metric {
    ($name:expr, $value:expr) => {
        $crate::__metric_impl($name, $value as i64, &[])
    };
    ($name:expr, $value:expr, [$(($lk:expr, $lv:expr)),* $(,)?]) => {
        $crate::__metric_impl($name, $value as i64, &[$(($lk, $lv)),*])
    };
}

/// Emit a typed event with a Borsh-serializable payload.
///
/// ```ignore
/// use solobserve_sdk::event;
/// #[derive(borsh::BorshSerialize)] struct Trade { size: u64 }
/// event!("TradeExecuted", &Trade { size: 100 });
/// ```
#[macro_export]
macro_rules! event {
    ($name:expr, $payload:expr) => {
        $crate::__event_impl($name, $payload, &[])
    };
    ($name:expr, $payload:expr, [$(($lk:expr, $lv:expr)),* $(,)?]) => {
        $crate::__event_impl($name, $payload, &[$(($lk, $lv)),*])
    };
}

/// Open a span. Returns a `u64` span id; pair with [`span_end!`].
#[macro_export]
macro_rules! span_start {
    ($name:expr) => {
        $crate::__span_start_impl($name, &[])
    };
    ($name:expr, $args:expr) => {
        $crate::__span_start_impl($name, $args)
    };
}

/// Close a span opened by [`span_start!`].
#[macro_export]
macro_rules! span_end {
    ($id:expr, $status:expr) => {
        $crate::__span_end_impl($id, $status, &[], 0)
    };
    ($id:expr, $status:expr, $result:expr, $cu:expr) => {
        $crate::__span_end_impl($id, $status, $result, $cu)
    };
}

// ---------------------------------------------------------------------------
// dev-mode implementations
// ---------------------------------------------------------------------------

#[cfg(all(feature = "dev", not(feature = "release")))]
#[allow(unexpected_cfgs)]
mod imp {
    use super::*;
    use borsh::BorshSerialize;

    fn labels(pairs: &[(&str, &str)]) -> alloc::vec::Vec<(ShortStr, ShortStr)> {
        pairs
            .iter()
            .map(|(k, v)| (ShortStr::new(*k), ShortStr::new(*v)))
            .collect()
    }

    #[doc(hidden)]
    pub fn metric(name: &str, value: i64, label_pairs: &[(&str, &str)]) {
        let msg = SobsMsg::Metric(MetricMsg {
            name: ShortStr::new(name),
            value,
            labels: labels(label_pairs),
        });
        emit(&msg);
    }

    #[doc(hidden)]
    pub fn event<T: BorshSerialize + ?Sized>(
        name: &str,
        payload: &T,
        label_pairs: &[(&str, &str)],
    ) {
        let mut buf = alloc::vec::Vec::new();
        let _ = payload.serialize(&mut buf);
        let msg = SobsMsg::Event(EventMsg {
            name: ShortStr::new(name),
            payload: buf,
            labels: labels(label_pairs),
        });
        emit(&msg);
    }

    #[doc(hidden)]
    pub fn span_start(name: &str, args: &[u8]) -> u64 {
        let id = next_span_id();
        let msg = SobsMsg::SpanStart(SpanStartMsg {
            id,
            name: ShortStr::new(name),
            args: args.to_vec(),
        });
        emit(&msg);
        id
    }

    #[doc(hidden)]
    pub fn span_end(id: u64, status: SpanStatus, result: &[u8], cu_consumed: u32) {
        let msg = SobsMsg::SpanEnd(SpanEndMsg {
            id,
            status: status as u8,
            result: result.to_vec(),
            cu_consumed,
        });
        emit(&msg);
    }

    fn emit(msg: &SobsMsg) {
        // Default: print the line via std (works on host + tests).
        // On-chain users typically override via a `__sobs_msg` shim that calls
        // `solana_program::msg!`; we keep it simple by writing to stderr so
        // both regular Rust binaries and `solana-program-test` log capture see
        // the same lines.
        let line = encode_log_line(msg);
        #[cfg(not(target_os = "solana"))]
        {
            // Host: write to stderr for visibility in tests + bench harness.
            // Tests parse stderr or call `encode_log_line` directly.
            eprintln!("Program log: {}", line);
        }
        #[cfg(target_os = "solana")]
        {
            // On-chain BPF target. We can't depend on solana-program from here
            // (the host build would pull in its giant tree). Instead, the SDK
            // re-uses the program's `solana_program` via an extern fn shim
            // declared in the consumer crate. Anchor's `#[program]` macro
            // already brings `solana_program` into scope, so we emit the
            // textual log via the standard sol_log syscall import.
            unsafe {
                extern "C" {
                    fn sol_log_(message: *const u8, length: u64);
                }
                let bytes = line.as_bytes();
                sol_log_(bytes.as_ptr(), bytes.len() as u64);
            }
        }
    }

    fn next_span_id() -> u64 {
        use core::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        COUNTER.fetch_add(1, Ordering::Relaxed)
    }
}

// ---------------------------------------------------------------------------
// release-mode (no-op) implementations
// ---------------------------------------------------------------------------

#[cfg(any(feature = "release", not(feature = "dev")))]
mod imp {
    use super::*;
    use borsh::BorshSerialize;

    #[doc(hidden)]
    pub fn metric(_n: &str, _v: i64, _l: &[(&str, &str)]) {}
    #[doc(hidden)]
    pub fn event<T: BorshSerialize + ?Sized>(_n: &str, _p: &T, _l: &[(&str, &str)]) {}
    #[doc(hidden)]
    pub fn span_start(_n: &str, _a: &[u8]) -> u64 {
        0
    }
    #[doc(hidden)]
    pub fn span_end(_id: u64, _s: SpanStatus, _r: &[u8], _cu: u32) {}
}

#[doc(hidden)]
pub fn __metric_impl(name: &str, value: i64, labels: &[(&str, &str)]) {
    imp::metric(name, value, labels)
}

#[doc(hidden)]
pub fn __event_impl<T: borsh::BorshSerialize + ?Sized>(
    name: &str,
    payload: &T,
    labels: &[(&str, &str)],
) {
    imp::event(name, payload, labels)
}

#[doc(hidden)]
pub fn __span_start_impl(name: &str, args: &[u8]) -> u64 {
    imp::span_start(name, args)
}

#[doc(hidden)]
pub fn __span_end_impl(id: u64, status: SpanStatus, result: &[u8], cu_consumed: u32) {
    imp::span_end(id, status, result, cu_consumed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_metric_log_line() {
        let msg = SobsMsg::Metric(MetricMsg {
            name: ShortStr::new("foo"),
            value: 1,
            labels: vec![],
        });
        let line = encode_log_line(&msg);
        assert!(line.starts_with("__SOBS__:m:"));
        let prefix_end = line.rfind(':').unwrap();
        let payload = &line[prefix_end + 1..];
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(payload)
            .unwrap();
        let back = SobsMsg::decode_frame(&bytes).unwrap();
        assert_eq!(back, msg);
    }

    #[test]
    fn metric_macro_compiles_with_labels() {
        metric!("x", 1);
        metric!("y", 2u32, [("a", "b"), ("c", "d")]);
    }

    #[test]
    fn span_pair() {
        let id = span_start!("op");
        span_end!(id, SpanStatus::Ok);
    }
}
