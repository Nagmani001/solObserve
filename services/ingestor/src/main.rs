use anyhow::{Context, Result};
use async_nats::jetstream::stream::Config as StreamConfig;
use async_nats::jetstream::{self};
use chrono::Utc;
use solana_rpc_client::{RpcEndpoint, SolanaRpcClient};
use solobserve_config::Config;
use solobserve_storage::{nats_jetstream, pg_pool, s3_client};
use solobserve_types::RawTxMsg;
use sqlx::{PgPool, Row};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

mod metrics;

#[derive(Debug, Clone)]
struct ProgramConfig {
    id: String,
    program_id: String,
    cluster: String,
    enabled: bool,
    primary_endpoint: String,
    fallback_endpoints: Vec<String>,
    backfill_window_hours: i32,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let pg = pg_pool(&cfg).await.context("postgres pool")?;
    let js = nats_jetstream(&cfg).await.context("nats jetstream")?;
    let s3 = s3_client(&cfg).await;

    ensure_streams(&js).await?;

    metrics::touch();
    let metrics_port: u16 = std::env::var("INGESTOR_METRICS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9100);
    tokio::spawn(async move {
        if let Err(e) = metrics::serve(metrics_port).await {
            error!(error = ?e, "metrics server failed");
        }
    });

    let workers: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // TODO(plan-future): pluggable Geyser source
    loop {
        reconcile_workers(&pg, &cfg, &js, &s3, workers.clone()).await?;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn ensure_streams(js: &jetstream::Context) -> Result<()> {
    upsert_stream(
        js,
        StreamConfig {
            name: "RAW_TX".into(),
            subjects: vec!["raw.tx.>".into()],
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
            ..Default::default()
        },
    )
    .await?;
    upsert_stream(
        js,
        StreamConfig {
            name: "RAW_ACCOUNT".into(),
            subjects: vec!["raw.account.>".into()],
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
            ..Default::default()
        },
    )
    .await?;
    upsert_stream(
        js,
        StreamConfig {
            name: "INGEST_CONTROL".into(),
            subjects: vec!["ingest.control.>".into()],
            max_age: Duration::from_secs(7 * 24 * 60 * 60),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

async fn upsert_stream(js: &jetstream::Context, cfg: StreamConfig) -> Result<()> {
    if js.get_stream(&cfg.name).await.is_err() {
        js.create_stream(cfg).await?;
    }
    Ok(())
}

async fn reconcile_workers(
    pg: &PgPool,
    cfg: &Config,
    js: &jetstream::Context,
    s3: &aws_sdk_s3::Client,
    workers: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
) -> Result<()> {
    let rows = sqlx::query(
        r#"
        SELECT p.id, p.program_id, ic.cluster::text as cluster, ic.enabled,
               ic.primary_endpoint, ic.fallback_endpoints, ic.backfill_window_hours
        FROM ingestion_configs ic
        JOIN programs p ON p.id = ic.program_id_fk
        "#,
    )
    .fetch_all(pg)
    .await?;

    let mut wanted = HashMap::new();
    for row in rows {
        let c = ProgramConfig {
            id: row.try_get::<uuid::Uuid, _>("id")?.to_string(),
            program_id: row.try_get::<String, _>("program_id")?,
            cluster: row.try_get::<String, _>("cluster")?,
            enabled: row.try_get::<bool, _>("enabled")?,
            primary_endpoint: row.try_get::<String, _>("primary_endpoint")?,
            fallback_endpoints: row
                .try_get::<Vec<String>, _>("fallback_endpoints")
                .unwrap_or_default(),
            backfill_window_hours: row.try_get::<i32, _>("backfill_window_hours").unwrap_or(24),
        };
        wanted.insert(c.id.clone(), c);
    }

    let mut lock = workers.lock().await;
    let current_ids: Vec<String> = lock.keys().cloned().collect();
    for id in current_ids {
        let disabled = wanted.get(&id).map(|c| !c.enabled).unwrap_or(true);
        if disabled {
            if let Some(handle) = lock.remove(&id) {
                handle.abort();
                info!(program_id_fk = %id, "stopped worker");
            }
        }
    }

    for c in wanted.values() {
        if !c.enabled || lock.contains_key(&c.id) {
            continue;
        }
        let pg = pg.clone();
        let js = js.clone();
        let s3 = s3.clone();
        let bucket = cfg.s3.bucket.clone();
        let c = c.clone();
        let worker_cfg = c.clone();
        let handle = tokio::spawn(async move {
            if let Err(e) = run_program_worker(pg, js, s3, &bucket, worker_cfg).await {
                error!(error = ?e, "program worker crashed");
            }
        });
        lock.insert(c.id.clone(), handle);
        info!(program_id_fk = %c.id, "started worker");
    }
    Ok(())
}

async fn run_program_worker(
    pg: PgPool,
    js: jetstream::Context,
    s3: aws_sdk_s3::Client,
    bucket: &str,
    cfg: ProgramConfig,
) -> Result<()> {
    let endpoints = std::iter::once(cfg.primary_endpoint.clone())
        .chain(cfg.fallback_endpoints.clone())
        .map(|u| RpcEndpoint {
            http_url: u,
            rate_limit_rps: 10,
        })
        .collect();
    let rpc = SolanaRpcClient::new(endpoints)?;
    let seen = Arc::new(Mutex::new(VecDeque::new()));
    backfill_window(&pg, &js, &s3, bucket, &rpc, &cfg).await?;

    let pending: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    loop {
        let logs = rpc
            .poll_logs_like(
                cfg.program_id.clone(),
                "processed".to_string(),
                seen.clone(),
            )
            .await
            .unwrap_or_default();
        for n in logs {
            if let Err(e) = ingest_signature(
                &pg,
                &js,
                &s3,
                bucket,
                &rpc,
                &cfg,
                &n.signature,
                n.slot,
                false,
            )
            .await
            {
                warn!(error = ?e, signature = %n.signature, "failed ingest signature");
                metrics::TX_FAILED_TOTAL.inc();
                record_error(
                    &pg,
                    &cfg,
                    "ingest",
                    &e.to_string(),
                    Some(&n.signature),
                    Some(n.slot as i64),
                )
                .await
                .ok();
            } else {
                pending.lock().await.insert(n.signature.clone(), n.slot);
            }
        }
        ingest_tracked_accounts(&pg, &js, &s3, bucket, &rpc, &cfg)
            .await
            .ok();
        promote_or_rollback(&pg, &js, &cfg, &pending, &rpc).await?;
        metrics::report_endpoint_health(&rpc.health_snapshot().await);
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn ingest_tracked_accounts(
    pg: &PgPool,
    js: &jetstream::Context,
    s3: &aws_sdk_s3::Client,
    bucket: &str,
    rpc: &SolanaRpcClient,
    cfg: &ProgramConfig,
) -> Result<()> {
    let rows = rpc
        .get_signatures_for_address(&cfg.program_id, None, None, 1)
        .await
        .unwrap_or_default();
    let slot = rows.first().map(|r| r.slot).unwrap_or(0);
    let db_accounts: Vec<String> = sqlx::query_scalar::<_, String>(
        r#"SELECT account FROM tracked_accounts WHERE program_id_fk = $1::uuid"#,
    )
    .bind(uuid::Uuid::parse_str(&cfg.id)?)
    .fetch_all(pg)
    .await
    .unwrap_or_default();
    if db_accounts.is_empty() {
        return Ok(());
    }
    for account in db_accounts {
        let raw = rpc.get_account_info(&account, "processed").await?;
        let blob_key = format!(
            "raw/{}/{}/{}/account-{}.json.zst",
            cfg.cluster, cfg.program_id, slot, account
        );
        let compressed =
            zstd::stream::encode_all(std::io::Cursor::new(serde_json::to_vec(&raw)?), 1)?;
        s3.put_object()
            .bucket(bucket)
            .key(&blob_key)
            .body(compressed.into())
            .content_type("application/zstd")
            .send()
            .await?;
        let payload = serde_json::json!({
            "cluster": cfg.cluster,
            "program_id": cfg.program_id,
            "account": account,
            "slot": slot,
            "commitment": "processed",
            "raw_blob_url": format!("s3://{}/{}", bucket, blob_key),
            "fetched_at": Utc::now().timestamp(),
        });
        js.publish(
            format!("raw.account.{}.{}", cfg.cluster, cfg.program_id),
            serde_json::to_vec(&payload)?.into(),
        )
        .await?;
    }
    Ok(())
}

async fn backfill_window(
    pg: &PgPool,
    js: &jetstream::Context,
    s3: &aws_sdk_s3::Client,
    bucket: &str,
    rpc: &SolanaRpcClient,
    cfg: &ProgramConfig,
) -> Result<()> {
    let cutoff = Utc::now().timestamp() - (cfg.backfill_window_hours as i64 * 3600);
    let mut before: Option<String> = None;
    loop {
        let batch = rpc
            .get_signatures_for_address(&cfg.program_id, before.as_deref(), None, 100)
            .await?;
        if batch.is_empty() {
            break;
        }
        let mut reached_cutoff = false;
        for b in &batch {
            if b.block_time.unwrap_or(i64::MAX) < cutoff {
                reached_cutoff = true;
                break;
            }
            ingest_signature(pg, js, s3, bucket, rpc, cfg, &b.signature, b.slot, true).await?;
        }
        before = batch.last().map(|s| s.signature.clone());
        if reached_cutoff {
            break;
        }
    }
    Ok(())
}

async fn ingest_signature(
    pg: &PgPool,
    js: &jetstream::Context,
    s3: &aws_sdk_s3::Client,
    bucket: &str,
    rpc: &SolanaRpcClient,
    cfg: &ProgramConfig,
    signature: &str,
    slot: u64,
    backfill: bool,
) -> Result<()> {
    let blob_key = format!(
        "raw/{}/{}/{}/{}.json.zst",
        cfg.cluster, cfg.program_id, slot, signature
    );
    let exists = s3
        .head_object()
        .bucket(bucket)
        .key(&blob_key)
        .send()
        .await
        .is_ok();
    if !exists {
        let raw = rpc.get_transaction(signature, "processed").await?;
        let data = serde_json::to_vec(&raw)?;
        let compressed = zstd::stream::encode_all(std::io::Cursor::new(data), 1)?;
        s3.put_object()
            .bucket(bucket)
            .key(&blob_key)
            .body(compressed.into())
            .content_type("application/zstd")
            .send()
            .await?;
    }
    let block_time = rpc.get_block_time(slot).await.unwrap_or(None);
    let msg = RawTxMsg {
        cluster: cfg.cluster.clone(),
        program_id: cfg.program_id.clone(),
        signature: signature.to_string(),
        slot,
        block_time,
        commitment: "processed".to_string(),
        raw_blob_url: format!("s3://{}/{}", bucket, blob_key),
        fetched_at: Utc::now().timestamp(),
        backfill,
        rollback: false,
    };
    js.publish(
        format!("raw.tx.{}.{}", cfg.cluster, cfg.program_id),
        serde_json::to_vec(&msg)?.into(),
    )
    .await?;
    metrics::TX_FETCHED_TOTAL.inc();

    let now_slot = rpc.get_slot().await.unwrap_or(slot);
    metrics::LAG_SLOTS
        .with_label_values(&[&cfg.program_id, &cfg.cluster])
        .set(now_slot.saturating_sub(slot) as i64);
    sqlx::query(
        r#"
        INSERT INTO ingestion_state(program_id_fk, cluster, last_processed_slot, last_processed_signature, last_seen_at, lag_slots)
        VALUES ($1::uuid, $2::solana_cluster, $3, $4, NOW(), $5)
        ON CONFLICT (program_id_fk, cluster)
        DO UPDATE SET
            last_processed_slot = EXCLUDED.last_processed_slot,
            last_processed_signature = EXCLUDED.last_processed_signature,
            last_seen_at = NOW(),
            lag_slots = EXCLUDED.lag_slots
        "#,
    )
    .bind(uuid::Uuid::parse_str(&cfg.id)?)
    .bind(&cfg.cluster)
    .bind(slot as i64)
    .bind(signature)
    .bind((now_slot.saturating_sub(slot)) as i32)
    .execute(pg)
    .await?;
    Ok(())
}

async fn promote_or_rollback(
    pg: &PgPool,
    js: &jetstream::Context,
    cfg: &ProgramConfig,
    pending: &Arc<Mutex<HashMap<String, u64>>>,
    rpc: &SolanaRpcClient,
) -> Result<()> {
    let current_slot = rpc.get_slot().await.unwrap_or(0);
    let keys: Vec<String> = pending.lock().await.keys().cloned().collect();
    if keys.is_empty() {
        return Ok(());
    }
    let statuses = rpc.get_signature_statuses(&keys).await.unwrap_or_default();
    let mut lock = pending.lock().await;
    for (idx, sig) in keys.iter().enumerate() {
        let seen_slot = *lock.get(sig).unwrap_or(&0);
        let status = statuses.get(idx).and_then(|s| s.clone());
        if let Some(st) = status {
            if matches!(
                st.confirmation_status.as_deref(),
                Some("confirmed" | "finalized")
            ) {
                let msg = RawTxMsg {
                    cluster: cfg.cluster.clone(),
                    program_id: cfg.program_id.clone(),
                    signature: sig.clone(),
                    slot: st.slot.max(seen_slot),
                    block_time: None,
                    commitment: "confirmed".to_string(),
                    raw_blob_url: String::new(),
                    fetched_at: Utc::now().timestamp(),
                    backfill: false,
                    rollback: false,
                };
                js.publish(
                    format!("raw.tx.{}.{}", cfg.cluster, cfg.program_id),
                    serde_json::to_vec(&msg)?.into(),
                )
                .await?;
                lock.remove(sig);
                continue;
            }
        }
        if current_slot.saturating_sub(seen_slot) > 32 {
            let rollback = RawTxMsg {
                cluster: cfg.cluster.clone(),
                program_id: cfg.program_id.clone(),
                signature: sig.clone(),
                slot: seen_slot,
                block_time: None,
                commitment: "processed".to_string(),
                raw_blob_url: String::new(),
                fetched_at: Utc::now().timestamp(),
                backfill: false,
                rollback: true,
            };
            js.publish(
                format!("raw.tx.{}.{}", cfg.cluster, cfg.program_id),
                serde_json::to_vec(&rollback)?.into(),
            )
            .await?;
            metrics::REORGS_DETECTED_TOTAL.inc();
            record_error(
                pg,
                cfg,
                "rollback",
                "signature not confirmed within reorg window",
                Some(sig),
                Some(seen_slot as i64),
            )
            .await?;
            lock.remove(sig);
        }
    }
    Ok(())
}

async fn record_error(
    pg: &PgPool,
    cfg: &ProgramConfig,
    kind: &str,
    message: &str,
    signature: Option<&str>,
    slot: Option<i64>,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO ingestion_errors(program_id_fk, cluster, kind, message, signature, slot)
        VALUES ($1::uuid, $2::solana_cluster, $3, $4, $5, $6)
        "#,
    )
    .bind(uuid::Uuid::parse_str(&cfg.id)?)
    .bind(&cfg.cluster)
    .bind(kind)
    .bind(message)
    .bind(signature)
    .bind(slot)
    .execute(pg)
    .await?;
    Ok(())
}
