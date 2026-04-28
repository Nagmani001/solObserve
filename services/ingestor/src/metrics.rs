use anyhow::Result;
use once_cell::sync::Lazy;
use prometheus::{
    register_int_counter, register_int_counter_vec, register_int_gauge_vec, Encoder, IntCounter,
    IntCounterVec, IntGaugeVec, TextEncoder,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, warn};

pub static TX_FETCHED_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!("ingestor_tx_fetched_total", "Total transactions fetched").unwrap()
});

pub static TX_FAILED_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!(
        "ingestor_tx_failed_total",
        "Total transaction fetch failures"
    )
    .unwrap()
});

pub static REORGS_DETECTED_TOTAL: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!(
        "ingestor_reorgs_detected_total",
        "Total reorg rollbacks emitted"
    )
    .unwrap()
});

pub static LAG_SLOTS: Lazy<IntGaugeVec> = Lazy::new(|| {
    register_int_gauge_vec!(
        "ingestor_lag_slots",
        "Current slot lag per program/cluster",
        &["program_id", "cluster"]
    )
    .unwrap()
});

pub static ENDPOINT_ERRORS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
    register_int_counter_vec!(
        "ingestor_endpoint_errors_total",
        "Total RPC errors per endpoint",
        &["endpoint"]
    )
    .unwrap()
});

pub static ENDPOINT_CALLS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
    register_int_counter_vec!(
        "ingestor_endpoint_calls_total",
        "Total RPC calls per endpoint",
        &["endpoint"]
    )
    .unwrap()
});

/// Reports per-endpoint health observed via [`SolanaRpcClient::health_snapshot`].
/// Internal counter; tracks last-reported value so monotonic counters work despite
/// snapshot being absolute.
pub fn report_endpoint_health(snapshot: &[(String, u64, u64)]) {
    use std::collections::HashMap;
    use std::sync::Mutex;

    static LAST: Lazy<Mutex<HashMap<String, (u64, u64)>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    let mut last = LAST.lock().unwrap();
    for (ep, calls, errors) in snapshot {
        let (prev_calls, prev_errors) = last.get(ep).copied().unwrap_or((0, 0));
        if *calls > prev_calls {
            ENDPOINT_CALLS_TOTAL
                .with_label_values(&[ep])
                .inc_by(*calls - prev_calls);
        }
        if *errors > prev_errors {
            ENDPOINT_ERRORS_TOTAL
                .with_label_values(&[ep])
                .inc_by(*errors - prev_errors);
        }
        last.insert(ep.clone(), (*calls, *errors));
    }
}

pub async fn serve(port: u16) -> Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    info!(port, "metrics endpoint listening");
    loop {
        let (mut sock, _) = match listener.accept().await {
            Ok(p) => p,
            Err(e) => {
                warn!(error = ?e, "metrics accept failed");
                continue;
            }
        };
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let body = render();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n{}",
                prometheus::TEXT_FORMAT,
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
    }
}

fn render() -> String {
    let mfs = prometheus::gather();
    let mut buf = Vec::new();
    TextEncoder::new().encode(&mfs, &mut buf).ok();
    String::from_utf8(buf).unwrap_or_default()
}

/// Force registration of all lazies so /metrics shows them before first increment.
pub fn touch() {
    Lazy::force(&TX_FETCHED_TOTAL);
    Lazy::force(&TX_FAILED_TOTAL);
    Lazy::force(&REORGS_DETECTED_TOTAL);
    Lazy::force(&LAG_SLOTS);
    Lazy::force(&ENDPOINT_ERRORS_TOTAL);
    Lazy::force(&ENDPOINT_CALLS_TOTAL);
}
