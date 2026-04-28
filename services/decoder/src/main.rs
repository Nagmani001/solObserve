use anyhow::Result;
use async_nats::jetstream::{self, consumer::pull::Config as PullConfig};
use axum::{response::IntoResponse, routing::get, Router};
use base64::Engine;
use chrono::Utc;
use clickhouse::Row;
use futures::StreamExt;
use idl_parser::{decode_account_payload, decode_event_payload, decode_instruction_args};
use once_cell::sync::Lazy;
use prometheus::{Encoder, HistogramVec, IntCounterVec, IntGauge, Registry, TextEncoder};
use regex::Regex;
use schema_registry::SchemaRegistry;
use serde::Serialize;
use serde_json::Value;
use solobserve_config::Config;
use solobserve_storage::{
    clickhouse_client, nats_jetstream, pg_pool, run_clickhouse_migrations, s3_client,
};
use solobserve_types::{RawAccountMsg, RawTxMsg};
use sqlx::{PgPool, Row as SqlxRow};
use std::{sync::Arc, time::Duration};
use tracing::warn;

static INVOKE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^Program (\w+) invoke \[(\d+)\]").expect("invoke regex"));
static CU_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^Program (\w+) consumed (\d+) of (\d+) compute units").expect("cu regex")
});

#[derive(Row, Serialize)]
struct ChTxRow {
    cluster: String,
    program_id: String,
    signature: String,
    slot: u64,
    block_time: u32,
    status: String,
    signer: String,
    fee_lamports: u64,
    priority_fee_lamports: u64,
    compute_budget_consumed: u32,
    error_code: Option<i32>,
    error_name: Option<String>,
    commitment: String,
    rpc_source: String,
    idl_version: u32,
    schema_hash: String,
    raw_blob_url: String,
}

#[derive(Row, Serialize)]
struct ChInstructionRow {
    cluster: String,
    program_id: String,
    signature: String,
    slot: u64,
    block_time: u32,
    ix_index: u16,
    parent_ix_index: Option<u16>,
    depth: u8,
    instruction_name: String,
    args_json: String,
    args_raw_hex: String,
    decode_error: Option<String>,
    status: String,
    idl_version: u32,
}

#[derive(Row, Serialize)]
struct ChEventRow {
    cluster: String,
    program_id: String,
    signature: String,
    slot: u64,
    block_time: u32,
    event_index: u16,
    ix_index: u16,
    source: String,
    event_name: String,
    payload_json: String,
    raw_payload: String,
    idl_version: u32,
}

#[derive(Row, Serialize)]
struct CpiEdgeRow {
    cluster: String,
    program_id: String,
    signature: String,
    parent_ix_index: u16,
    child_ix_index: u16,
    callee_program: String,
    cu_consumed: u32,
    status: String,
    depth: u8,
    slot: u64,
    block_time: u32,
}

#[derive(Row, Serialize)]
struct AccountWriteRow {
    cluster: String,
    program_id: String,
    account: String,
    signature: String,
    slot: u64,
    block_time: u32,
    account_type: Option<String>,
    decoded_json: String,
    raw_blob_url: String,
    commitment: String,
    idl_version: u32,
}

#[derive(Clone)]
struct Metrics {
    registry: Registry,
    consumed: IntCounterVec,
    decode_failures: IntCounterVec,
    unknown_disc: IntCounterVec,
    decode_latency: HistogramVec,
    insert_batch: IntGauge,
    lag_messages: IntGauge,
}

impl Metrics {
    fn new() -> Self {
        let registry = Registry::new();
        let consumed = IntCounterVec::new(
            prometheus::Opts::new("decoder_messages_consumed_total", "Consumed messages"),
            &["stream"],
        )
        .expect("metric");
        let decode_failures = IntCounterVec::new(
            prometheus::Opts::new("decoder_decode_failures_total", "Decode failures"),
            &["program_id"],
        )
        .expect("metric");
        let unknown_disc = IntCounterVec::new(
            prometheus::Opts::new(
                "decoder_unknown_discriminator_total",
                "Unknown discriminator",
            ),
            &["program_id"],
        )
        .expect("metric");
        let decode_latency = HistogramVec::new(
            prometheus::HistogramOpts::new(
                "decoder_decode_latency_ms",
                "Decode latency in milliseconds",
            ),
            &["stream"],
        )
        .expect("metric");
        let insert_batch = IntGauge::new(
            "decoder_clickhouse_insert_batch_size",
            "ClickHouse insert batch size",
        )
        .expect("metric");
        let lag_messages =
            IntGauge::new("decoder_lag_messages", "NATS pending lag").expect("metric");

        registry.register(Box::new(consumed.clone())).ok();
        registry.register(Box::new(decode_failures.clone())).ok();
        registry.register(Box::new(unknown_disc.clone())).ok();
        registry.register(Box::new(decode_latency.clone())).ok();
        registry.register(Box::new(insert_batch.clone())).ok();
        registry.register(Box::new(lag_messages.clone())).ok();

        Self {
            registry,
            consumed,
            decode_failures,
            unknown_disc,
            decode_latency,
            insert_batch,
            lag_messages,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let pg = pg_pool(&cfg).await?;
    let ch = clickhouse_client(&cfg);
    run_clickhouse_migrations(&ch).await?;
    let js = nats_jetstream(&cfg).await?;
    let s3 = s3_client(&cfg).await;

    let registry = SchemaRegistry::new();
    registry.refresh_from_postgres(&pg).await?;
    registry
        .clone()
        .start_listener(pg.clone(), cfg.postgres.url.clone())
        .await;

    let metrics = Metrics::new();
    spawn_metrics_server(metrics.clone());

    let tx_stream = js.get_stream("RAW_TX").await?;
    let tx_consumer = tx_stream
        .get_or_create_consumer(
            "decoder-main",
            PullConfig {
                durable_name: Some("decoder-main".to_string()),
                ..Default::default()
            },
        )
        .await?;
    let account_stream = js.get_stream("RAW_ACCOUNT").await?;
    let account_consumer = account_stream
        .get_or_create_consumer(
            "decoder-account",
            PullConfig {
                durable_name: Some("decoder-account".to_string()),
                ..Default::default()
            },
        )
        .await?;

    let tx_loop = run_tx_loop(
        tx_consumer,
        ch.clone(),
        pg.clone(),
        s3.clone(),
        cfg.s3.bucket.clone(),
        registry.clone(),
        metrics.clone(),
    );
    let account_loop = run_account_loop(
        account_consumer,
        ch,
        pg,
        s3,
        cfg.s3.bucket.clone(),
        registry,
        metrics.clone(),
    );

    tokio::try_join!(tx_loop, account_loop)?;
    Ok(())
}

fn spawn_metrics_server(metrics: Metrics) {
    tokio::spawn(async move {
        async fn metrics_handler(metrics: Arc<Metrics>) -> impl IntoResponse {
            let mut buffer = Vec::new();
            let encoder = TextEncoder::new();
            let metric_families = metrics.registry.gather();
            if encoder.encode(&metric_families, &mut buffer).is_err() {
                return (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "encode error",
                )
                    .into_response();
            }
            (
                axum::http::StatusCode::OK,
                String::from_utf8_lossy(&buffer).to_string(),
            )
                .into_response()
        }
        let shared = Arc::new(metrics);
        let app = Router::new().route(
            "/metrics",
            get({
                let shared = shared.clone();
                move || metrics_handler(shared.clone())
            }),
        );
        let addr = format!(
            "0.0.0.0:{}",
            std::env::var("DECODER_METRICS_PORT")
                .ok()
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(9191)
        );
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .expect("bind metrics");
        axum::serve(listener, app).await.expect("metrics server");
    });
}

async fn run_tx_loop(
    consumer: jetstream::consumer::Consumer<jetstream::consumer::pull::Config>,
    ch: clickhouse::Client,
    pg: PgPool,
    s3: aws_sdk_s3::Client,
    bucket: String,
    registry: SchemaRegistry,
    metrics: Metrics,
) -> Result<()> {
    loop {
        metrics.lag_messages.set(0);
        let mut messages = consumer.fetch().max_messages(50).messages().await?;
        while let Some(message) = messages.next().await {
            let message = match message {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = ?e, "RAW_TX fetch message error");
                    continue;
                }
            };
            let started = std::time::Instant::now();
            let payload = std::str::from_utf8(&message.payload)?;
            let raw: RawTxMsg = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = ?e, "bad RAW_TX payload");
                    message.ack().await.ok();
                    continue;
                }
            };
            if raw.rollback {
                ch.query("INSERT INTO rollbacks (signature) VALUES (?)")
                    .bind(raw.signature.clone())
                    .execute()
                    .await
                    .ok();
                message.ack().await.ok();
                continue;
            }
            if raw.commitment == "confirmed" {
                ch.query("INSERT INTO commitment_promotions (signature, commitment) VALUES (?, ?)")
                    .bind(raw.signature.clone())
                    .bind("confirmed")
                    .execute()
                    .await
                    .ok();
                message.ack().await.ok();
                continue;
            }
            match decode_tx_message(&ch, &pg, &s3, &bucket, &registry, &raw, &metrics).await {
                Ok(_) => {
                    metrics.consumed.with_label_values(&["raw_tx"]).inc();
                }
                Err(e) => {
                    warn!(error = ?e, signature = %raw.signature, "decode tx failed");
                    record_decode_error(&pg, &raw, "tx_decode", &e.to_string())
                        .await
                        .ok();
                    metrics
                        .decode_failures
                        .with_label_values(&[raw.program_id.as_str()])
                        .inc();
                }
            }
            metrics
                .decode_latency
                .with_label_values(&["raw_tx"])
                .observe(started.elapsed().as_millis() as f64);
            message.ack().await.ok();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn decode_tx_message(
    ch: &clickhouse::Client,
    _pg: &PgPool,
    s3: &aws_sdk_s3::Client,
    bucket: &str,
    registry: &SchemaRegistry,
    raw: &RawTxMsg,
    metrics: &Metrics,
) -> Result<()> {
    let key = raw
        .raw_blob_url
        .trim_start_matches(&format!("s3://{}/", bucket))
        .to_string();
    let obj = s3.get_object().bucket(bucket).key(&key).send().await?;
    let bytes = obj.body.collect().await?.into_bytes();
    let decoded = zstd::stream::decode_all(std::io::Cursor::new(bytes))?;
    let json: Value = serde_json::from_slice(&decoded)?;

    let block_ts = raw.block_time.unwrap_or_else(|| Utc::now().timestamp()) as u32;
    let schema = registry
        .resolve_for_slot(&raw.program_id, raw.block_time)
        .await;
    let (idl_version, schema_hash) = schema
        .clone()
        .map(|s| (s.version as u32, s.schema_hash))
        .unwrap_or((0, String::new()));

    let logs = json
        .pointer("/meta/logMessages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();
    let account_keys = extract_account_keys(&json);
    let compiled_ixs = extract_compiled_instructions(&json, &account_keys);

    let signer = json
        .pointer("/transaction/message/accountKeys/0")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let fee = json
        .pointer("/meta/fee")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let status =
        if json.pointer("/meta/err").is_some() && !json.pointer("/meta/err").unwrap().is_null() {
            "failed".to_string()
        } else {
            "success".to_string()
        };

    let mut ix_rows = Vec::new();
    let mut event_rows = Vec::new();
    let mut edges = Vec::new();

    // Parse canonical CPI invoke/consumed lines.
    let mut invoke_stack: Vec<(u16, String, u8)> = Vec::new();
    let mut next_child_ix: u16 = 0;
    for (i, line) in logs.iter().enumerate() {
        if let Some(cap) = INVOKE_RE.captures(line) {
            let callee = cap
                .get(1)
                .map(|m| m.as_str())
                .unwrap_or_default()
                .to_string();
            let depth = cap
                .get(2)
                .and_then(|m| m.as_str().parse::<u8>().ok())
                .unwrap_or(1);
            let parent = invoke_stack.last().map(|s| s.0).unwrap_or(0);
            let child = next_child_ix;
            next_child_ix = next_child_ix.saturating_add(1);
            invoke_stack.push((child, callee.clone(), depth));
            edges.push(CpiEdgeRow {
                cluster: raw.cluster.clone(),
                program_id: raw.program_id.clone(),
                signature: raw.signature.clone(),
                parent_ix_index: parent,
                child_ix_index: child,
                callee_program: callee,
                cu_consumed: 0,
                status: "invoke".to_string(),
                depth,
                slot: raw.slot,
                block_time: block_ts,
            });
            let _ = i;
            continue;
        }
        if let Some(cap) = CU_RE.captures(line) {
            let callee = cap.get(1).map(|m| m.as_str()).unwrap_or_default();
            let cu = cap
                .get(2)
                .and_then(|m| m.as_str().parse::<u32>().ok())
                .unwrap_or(0);
            if let Some(last) = edges.iter_mut().rev().find(|e| e.callee_program == callee) {
                last.cu_consumed = cu;
                last.status = "consumed".to_string();
            }
            continue;
        }
        if let Some(payload) = line.strip_prefix("Program data: ") {
            let mut event_name = "__raw__".to_string();
            let mut payload_json = "{}".to_string();
            if let Ok(ev_bytes) = base64::engine::general_purpose::STANDARD.decode(payload) {
                if ev_bytes.len() >= 8 {
                    if let Some(schema_ref) = schema.as_ref() {
                        if let Ok((n, p)) = decode_event_payload(
                            &schema_ref.parsed_json,
                            &ev_bytes[..8],
                            &ev_bytes[8..],
                        ) {
                            event_name = n;
                            payload_json =
                                serde_json::to_string(&p).unwrap_or_else(|_| "{}".to_string());
                        }
                    }
                }
            }
            event_rows.push(ChEventRow {
                cluster: raw.cluster.clone(),
                program_id: raw.program_id.clone(),
                signature: raw.signature.clone(),
                slot: raw.slot,
                block_time: block_ts,
                event_index: event_rows.len() as u16,
                ix_index: invoke_stack.last().map(|x| x.0).unwrap_or(0),
                source: "anchor".to_string(),
                event_name,
                payload_json,
                raw_payload: payload.to_string(),
                idl_version,
            });
            continue;
        }
        if let Some(payload) = line.strip_prefix("Program log: __SOBS__:") {
            event_rows.push(ChEventRow {
                cluster: raw.cluster.clone(),
                program_id: raw.program_id.clone(),
                signature: raw.signature.clone(),
                slot: raw.slot,
                block_time: block_ts,
                event_index: event_rows.len() as u16,
                ix_index: invoke_stack.last().map(|x| x.0).unwrap_or(0),
                source: "sdk".to_string(),
                event_name: "__sdk__".to_string(),
                payload_json: "{}".to_string(),
                raw_payload: payload.to_string(),
                idl_version,
            });
            continue;
        }
    }

    for ix in &compiled_ixs {
        if ix.program_id != raw.program_id {
            continue;
        }
        let mut instruction_name = "__unknown__".to_string();
        let mut args_json = "null".to_string();
        let mut decode_error = Some("unrecognized discriminator".to_string());
        let args_raw_hex = hex::encode(&ix.data);

        if ix.data.len() >= 8 {
            if let Some(schema_ref) = schema.as_ref() {
                match decode_instruction_args(&schema_ref.parsed_json, &ix.data[..8], &ix.data[8..])
                {
                    Ok((name, args)) => {
                        instruction_name = name;
                        args_json =
                            serde_json::to_string(&args).unwrap_or_else(|_| "null".to_string());
                        decode_error = None;
                    }
                    Err(e) => {
                        if e == "unrecognized discriminator" {
                            metrics
                                .unknown_disc
                                .with_label_values(&[raw.program_id.as_str()])
                                .inc();
                        } else {
                            metrics
                                .decode_failures
                                .with_label_values(&[raw.program_id.as_str()])
                                .inc();
                        }
                        decode_error = Some(e);
                    }
                }
            }
        } else {
            metrics
                .unknown_disc
                .with_label_values(&[raw.program_id.as_str()])
                .inc();
        }

        ix_rows.push(ChInstructionRow {
            cluster: raw.cluster.clone(),
            program_id: raw.program_id.clone(),
            signature: raw.signature.clone(),
            slot: raw.slot,
            block_time: block_ts,
            ix_index: ix.ix_index,
            parent_ix_index: ix.parent_ix_index,
            depth: ix.depth,
            instruction_name,
            args_json,
            args_raw_hex,
            decode_error,
            status: status.clone(),
            idl_version,
        });
    }
    if ix_rows.is_empty() {
        metrics
            .unknown_disc
            .with_label_values(&[raw.program_id.as_str()])
            .inc();
    }

    let (error_code, error_name) = parse_meta_error(
        json.pointer("/meta/err"),
        schema.as_ref().map(|s| &s.parsed_json),
    );
    let compute_budget_consumed = json
        .pointer("/meta/computeUnitsConsumed")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or_else(|| edges.iter().map(|e| e.cu_consumed).sum());
    let priority_fee_lamports =
        extract_priority_fee_lamports(&compiled_ixs, compute_budget_consumed);

    let tx_row = ChTxRow {
        cluster: raw.cluster.clone(),
        program_id: raw.program_id.clone(),
        signature: raw.signature.clone(),
        slot: raw.slot,
        block_time: block_ts,
        status: status.clone(),
        signer,
        fee_lamports: fee,
        priority_fee_lamports,
        compute_budget_consumed,
        error_code,
        error_name,
        commitment: raw.commitment.clone(),
        rpc_source: if raw.rpc_source.is_empty() {
            "unknown".to_string()
        } else {
            raw.rpc_source.clone()
        },
        idl_version,
        schema_hash,
        raw_blob_url: raw.raw_blob_url.clone(),
    };

    let mut tx_insert = ch.insert("transactions")?;
    tx_insert.write(&tx_row).await?;
    tx_insert.end().await?;

    metrics.insert_batch.set(ix_rows.len() as i64);
    let mut ix_insert = ch.insert("instructions")?;
    for r in &ix_rows {
        ix_insert.write(r).await?;
    }
    ix_insert.end().await?;

    let mut ev_insert = ch.insert("events")?;
    for e in &event_rows {
        ev_insert.write(e).await?;
    }
    ev_insert.end().await?;

    let mut edge_insert = ch.insert("cpi_edges")?;
    for e in &edges {
        edge_insert.write(e).await?;
    }
    edge_insert.end().await?;
    Ok(())
}

fn parse_instruction_name_from_log(logs: &[String], invoke_index: usize) -> Option<String> {
    for line in logs.iter().skip(invoke_index).take(4) {
        if let Some(name) = line.strip_prefix("Program log: Instruction: ") {
            return Some(name.trim().to_string());
        }
    }
    None
}

#[derive(Debug, Clone)]
struct CompiledIx {
    program_id: String,
    data: Vec<u8>,
    ix_index: u16,
    parent_ix_index: Option<u16>,
    depth: u8,
}

fn extract_account_keys(json: &Value) -> Vec<String> {
    json.pointer("/transaction/message/accountKeys")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| {
            if let Some(s) = v.as_str() {
                Some(s.to_string())
            } else {
                v.get("pubkey")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            }
        })
        .collect()
}

fn decode_ix_data(data: &str) -> Vec<u8> {
    bs58::decode(data).into_vec().unwrap_or_default()
}

fn extract_compiled_instructions(json: &Value, account_keys: &[String]) -> Vec<CompiledIx> {
    let mut out = Vec::new();
    let top = json
        .pointer("/transaction/message/instructions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for (i, ix) in top.into_iter().enumerate() {
        let program_id = ix
            .get("programId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                ix.get("programIdIndex")
                    .and_then(|v| v.as_u64())
                    .and_then(|idx| account_keys.get(idx as usize).cloned())
            })
            .unwrap_or_default();
        let data = ix
            .get("data")
            .and_then(|v| v.as_str())
            .map(decode_ix_data)
            .unwrap_or_default();
        out.push(CompiledIx {
            program_id,
            data,
            ix_index: i as u16,
            parent_ix_index: None,
            depth: 1,
        });
    }
    let inner = json
        .pointer("/meta/innerInstructions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut next_idx = 1000u16;
    for group in inner {
        let parent = group
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|v| v as u16);
        for ix in group
            .get("instructions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let program_id = ix
                .get("programId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    ix.get("programIdIndex")
                        .and_then(|v| v.as_u64())
                        .and_then(|idx| account_keys.get(idx as usize).cloned())
                })
                .unwrap_or_default();
            let data = ix
                .get("data")
                .and_then(|v| v.as_str())
                .map(decode_ix_data)
                .unwrap_or_default();
            out.push(CompiledIx {
                program_id,
                data,
                ix_index: next_idx,
                parent_ix_index: parent,
                depth: 2,
            });
            next_idx = next_idx.saturating_add(1);
        }
    }
    out
}

fn parse_meta_error(
    meta_err: Option<&Value>,
    parsed_idl: Option<&Value>,
) -> (Option<i32>, Option<String>) {
    let err = match meta_err {
        Some(v) if !v.is_null() => v,
        _ => return (None, None),
    };
    if let Some(obj) = err.as_object() {
        if let Some(ix_err) = obj.get("InstructionError").and_then(|v| v.as_array()) {
            if ix_err.len() >= 2 {
                if let Some(custom) = ix_err[1].get("Custom").and_then(|v| v.as_i64()) {
                    if let Some(idl) = parsed_idl {
                        if let Some(errors) = idl.get("errors").and_then(|v| v.as_array()) {
                            for e in errors {
                                if e.get("code").and_then(|x| x.as_i64()) == Some(custom) {
                                    return (
                                        Some(custom as i32),
                                        e.get("name")
                                            .and_then(|x| x.as_str())
                                            .map(|s| s.to_string()),
                                    );
                                }
                            }
                        }
                    }
                    return (Some(custom as i32), Some(format!("Custom({custom})")));
                }
                if let Some(builtin) = ix_err[1].as_str() {
                    return (None, Some(builtin.to_string()));
                }
            }
        }
        for key in [
            "ComputeBudgetExceeded",
            "ArithmeticOverflow",
            "AccountConstraintMut",
            "AccountConstraintSeeds",
            "InsufficientFundsForRent",
            "AccountNotFound",
        ] {
            if obj.contains_key(key) {
                return (None, Some(key.to_string()));
            }
        }
    }
    if let Some(s) = err.as_str() {
        return (None, Some(s.to_string()));
    }
    (None, Some("UnknownError".to_string()))
}

fn extract_priority_fee_lamports(ixs: &[CompiledIx], compute_units_consumed: u32) -> u64 {
    const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";
    for ix in ixs {
        if ix.program_id != COMPUTE_BUDGET_PROGRAM || ix.data.len() < 9 {
            continue;
        }
        // SetComputeUnitPrice: tag 0x03 + u64 micro-lamports/CU.
        if ix.data[0] == 0x03 {
            let mut b = [0u8; 8];
            b.copy_from_slice(&ix.data[1..9]);
            let micro_lamports_per_cu = u64::from_le_bytes(b);
            return micro_lamports_per_cu.saturating_mul(compute_units_consumed as u64) / 1_000_000;
        }
    }
    0
}

async fn run_account_loop(
    consumer: jetstream::consumer::Consumer<jetstream::consumer::pull::Config>,
    ch: clickhouse::Client,
    pg: PgPool,
    s3: aws_sdk_s3::Client,
    bucket: String,
    registry: SchemaRegistry,
    metrics: Metrics,
) -> Result<()> {
    loop {
        metrics.lag_messages.set(0);
        let mut messages = consumer.fetch().max_messages(50).messages().await?;
        while let Some(message) = messages.next().await {
            let message = match message {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = ?e, "RAW_ACCOUNT fetch message error");
                    continue;
                }
            };
            let payload = std::str::from_utf8(&message.payload)?;
            let raw: RawAccountMsg = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = ?e, "bad RAW_ACCOUNT payload");
                    message.ack().await.ok();
                    continue;
                }
            };
            if let Err(e) = decode_account_message(&ch, &pg, &s3, &bucket, &registry, &raw).await {
                warn!(error = ?e, "decode account failed");
                metrics
                    .decode_failures
                    .with_label_values(&[raw.program_id.as_str()])
                    .inc();
            } else {
                metrics.consumed.with_label_values(&["raw_account"]).inc();
            }
            message.ack().await.ok();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn decode_account_message(
    ch: &clickhouse::Client,
    pg: &PgPool,
    s3: &aws_sdk_s3::Client,
    bucket: &str,
    registry: &SchemaRegistry,
    raw: &RawAccountMsg,
) -> Result<()> {
    let key = raw
        .raw_blob_url
        .trim_start_matches(&format!("s3://{}/", bucket))
        .to_string();
    let obj = s3.get_object().bucket(bucket).key(&key).send().await?;
    let bytes = obj.body.collect().await?.into_bytes();
    let decoded = zstd::stream::decode_all(std::io::Cursor::new(bytes))?;
    let json: Value = serde_json::from_slice(&decoded)?;
    let schema = registry.resolve_for_slot(&raw.program_id, None).await;
    let idl_version = schema.as_ref().map(|s| s.version as u32).unwrap_or(0);
    let mut account_type = None::<String>;
    let mut decoded_payload = json.clone();
    if let Some(data_b64) = json
        .get("value")
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
    {
        if let Ok(acc_bytes) = base64::engine::general_purpose::STANDARD.decode(data_b64) {
            if acc_bytes.len() >= 8 {
                if let Some(schema_ref) = schema.as_ref() {
                    if let Ok((name, payload)) = decode_account_payload(
                        &schema_ref.parsed_json,
                        &acc_bytes[..8],
                        &acc_bytes[8..],
                    ) {
                        account_type = Some(name);
                        decoded_payload = payload;
                    }
                }
            }
        }
    }

    let row = AccountWriteRow {
        cluster: raw.cluster.clone(),
        program_id: raw.program_id.clone(),
        account: raw.account.clone(),
        signature: String::new(),
        slot: raw.slot,
        block_time: Utc::now().timestamp() as u32,
        account_type: account_type.clone(),
        decoded_json: serde_json::to_string(&decoded_payload)?,
        raw_blob_url: raw.raw_blob_url.clone(),
        commitment: raw.commitment.clone(),
        idl_version,
    };
    let mut ins = ch.insert("account_writes")?;
    ins.write(&row).await?;
    ins.end().await?;

    let program_id_fk = sqlx::query("SELECT id FROM programs WHERE program_id = $1 LIMIT 1")
        .bind(&raw.program_id)
        .fetch_optional(pg)
        .await?
        .and_then(|r| r.try_get::<uuid::Uuid, _>("id").ok());
    if let Some(program_fk) = program_id_fk {
        sqlx::query(
            r#"
            INSERT INTO account_state(account, program_id_fk, cluster, account_type, decoded_json, slot, updated_at)
            VALUES ($1, $2::uuid, $3::solana_cluster, $4, $5::jsonb, $6, NOW())
            ON CONFLICT (account) DO UPDATE
            SET decoded_json = EXCLUDED.decoded_json,
                slot = EXCLUDED.slot,
                updated_at = NOW(),
                account_type = EXCLUDED.account_type
            "#,
        )
        .bind(&raw.account)
        .bind(program_fk)
        .bind(&raw.cluster)
        .bind(account_type.clone())
        .bind(serde_json::to_string(&decoded_payload)?)
        .bind(raw.slot as i64)
        .execute(pg)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO account_state_history(account, program_id_fk, cluster, slot, account_type, decoded_json)
            VALUES ($1, $2::uuid, $3::solana_cluster, $4, $5, $6::jsonb)
            ON CONFLICT (account, slot) DO NOTHING
            "#,
        )
        .bind(&raw.account)
        .bind(program_fk)
        .bind(&raw.cluster)
        .bind(raw.slot as i64)
        .bind(account_type)
        .bind(serde_json::to_string(&decoded_payload)?)
        .execute(pg)
        .await?;
    }
    Ok(())
}

async fn record_decode_error(pg: &PgPool, raw: &RawTxMsg, kind: &str, message: &str) -> Result<()> {
    let program_id_fk = sqlx::query("SELECT id FROM programs WHERE program_id = $1 LIMIT 1")
        .bind(&raw.program_id)
        .fetch_optional(pg)
        .await?
        .and_then(|r| r.try_get::<uuid::Uuid, _>("id").ok());
    if let Some(program_fk) = program_id_fk {
        sqlx::query(
            "INSERT INTO decode_errors(program_id_fk, signature, slot, kind, message) VALUES ($1::uuid, $2, $3, $4, $5)",
        )
        .bind(program_fk)
        .bind(&raw.signature)
        .bind(raw.slot as i64)
        .bind(kind)
        .bind(message)
        .execute(pg)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_invoke_and_cu_lines() {
        let logs = vec![
            "Program A invoke [1]".to_string(),
            "Program log: Instruction: initialize".to_string(),
            "Program B invoke [2]".to_string(),
            "Program B consumed 123 of 1000 compute units".to_string(),
            "Program B success".to_string(),
            "Program A consumed 456 of 2000 compute units".to_string(),
        ];
        let mut edges = Vec::<(String, u8, u32)>::new();
        for line in logs {
            if let Some(cap) = INVOKE_RE.captures(&line) {
                let callee = cap.get(1).map(|m| m.as_str()).unwrap_or_default();
                let depth = cap
                    .get(2)
                    .and_then(|m| m.as_str().parse::<u8>().ok())
                    .unwrap_or(1);
                edges.push((callee.to_string(), depth, 0));
            }
            if let Some(cap) = CU_RE.captures(&line) {
                let callee = cap.get(1).map(|m| m.as_str()).unwrap_or_default();
                let cu = cap
                    .get(2)
                    .and_then(|m| m.as_str().parse::<u32>().ok())
                    .unwrap_or(0);
                if let Some(last) = edges.iter_mut().rev().find(|e| e.0 == callee) {
                    last.2 = cu;
                }
            }
        }
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[1].0, "B");
        assert_eq!(edges[1].2, 123);
    }

    #[test]
    fn recognizes_instruction_name_from_logs() {
        let logs = vec![
            "Program ABC invoke [1]".to_string(),
            "Program log: Instruction: deposit".to_string(),
        ];
        let name = parse_instruction_name_from_log(&logs, 0);
        assert_eq!(name.as_deref(), Some("deposit"));
    }
}
