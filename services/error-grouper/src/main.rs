use anyhow::Result;
use async_nats::jetstream::{self, consumer::pull::Config as PullConfig};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use solobserve_config::Config;
use solobserve_storage::{nats_jetstream, pg_pool};
use solobserve_types::DecodedFailureMsg;
use sqlx::{PgPool, Row};
use tracing::warn;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let pg = pg_pool(&cfg).await?;
    let js = nats_jetstream(&cfg).await?;

    ensure_failure_stream(&js).await?;
    let stream = js.get_stream("DECODED_FAILURES").await?;
    let consumer = stream
        .get_or_create_consumer(
            "error-grouper",
            PullConfig {
                durable_name: Some("error-grouper".to_string()),
                ..Default::default()
            },
        )
        .await?;

    loop {
        let mut messages = consumer.fetch().max_messages(50).messages().await?;
        while let Some(msg) = messages.next().await {
            let msg = match msg {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = ?e, "decoded failure fetch error");
                    continue;
                }
            };
            let payload = std::str::from_utf8(&msg.payload)?;
            let failure: DecodedFailureMsg = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = ?e, "bad decoded failure payload");
                    msg.ack().await.ok();
                    continue;
                }
            };
            if let Err(e) = upsert_issue_and_sample(&pg, &failure).await {
                warn!(error = ?e, signature = %failure.signature, "upsert issue failed");
            }
            msg.ack().await.ok();
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn ensure_failure_stream(js: &jetstream::Context) -> Result<()> {
    if js.get_stream("DECODED_FAILURES").await.is_ok() {
        return Ok(());
    }
    js.create_stream(jetstream::stream::Config {
        name: "DECODED_FAILURES".to_string(),
        subjects: vec!["decoded.failures.*.*".to_string()],
        ..Default::default()
    })
    .await?;
    Ok(())
}

fn fingerprint_for_failure(msg: &DecodedFailureMsg) -> String {
    let mut hasher = Sha256::new();
    let code = msg.error_code.map(|v| v.to_string()).unwrap_or_default();
    hasher.update(msg.program_id.as_bytes());
    hasher.update(b"|");
    hasher.update(msg.instruction_name.as_bytes());
    hasher.update(b"|");
    hasher.update(code.as_bytes());
    hasher.update(b"|");
    hasher.update(msg.constraint_kind.clone().unwrap_or_default().as_bytes());
    format!("{:x}", hasher.finalize())
}

async fn upsert_issue_and_sample(pg: &PgPool, msg: &DecodedFailureMsg) -> Result<()> {
    let program_fk = sqlx::query("SELECT id FROM programs WHERE program_id = $1 LIMIT 1")
        .bind(&msg.program_id)
        .fetch_optional(pg)
        .await?
        .and_then(|r| r.try_get::<uuid::Uuid, _>("id").ok());
    let Some(program_fk) = program_fk else {
        return Ok(());
    };

    let fp = fingerprint_for_failure(msg);
    let classification = if msg.constraint_kind.is_some() {
        "anchor_constraint"
    } else if msg.error_code.is_some() {
        "anchor_custom"
    } else {
        "runtime"
    };
    let issue_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO error_issues(program_id_fk, fingerprint, instruction_name, error_code, error_name, classification, top_constraint_kind, first_seen_at, last_seen_at, total_count)
        VALUES ($1::uuid, $2, $3, $4, $5, $6::error_classification, $7, NOW(), NOW(), 1)
        ON CONFLICT (program_id_fk, fingerprint)
        DO UPDATE SET
          last_seen_at = NOW(),
          total_count = error_issues.total_count + 1,
          instruction_name = COALESCE(EXCLUDED.instruction_name, error_issues.instruction_name),
          error_code = COALESCE(EXCLUDED.error_code, error_issues.error_code),
          error_name = COALESCE(EXCLUDED.error_name, error_issues.error_name),
          top_constraint_kind = COALESCE(EXCLUDED.top_constraint_kind, error_issues.top_constraint_kind)
        RETURNING id
        "#,
    )
    .bind(program_fk)
    .bind(fp)
    .bind(Some(msg.instruction_name.as_str()))
    .bind(msg.error_code)
    .bind(msg.error_name.clone())
    .bind(classification)
    .bind(msg.constraint_kind.clone())
    .fetch_one(pg)
    .await?;

    let sample_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM error_samples WHERE issue_id_fk = $1::uuid")
        .bind(issue_id)
        .fetch_one(pg)
        .await?;
    if sample_count >= 50 {
        sqlx::query(
            r#"
            DELETE FROM error_samples
            WHERE id IN (
              SELECT id FROM error_samples
              WHERE issue_id_fk = $1::uuid
              ORDER BY created_at ASC
              LIMIT 1
            )
            "#,
        )
        .bind(issue_id)
        .execute(pg)
        .await?;
    }

    sqlx::query(
        r#"
        INSERT INTO error_samples(issue_id_fk, signature, slot, block_time, signer, decoded_args, decoded_accounts, log_lines, constraint_kind, constraint_expected, constraint_got, cu_consumed)
        VALUES (
          $1::uuid, $2, $3, to_timestamp($4), $5, $6::jsonb, '{}'::jsonb, $7, $8, NULL, NULL, $9
        )
        "#,
    )
    .bind(issue_id)
    .bind(&msg.signature)
    .bind(msg.slot as i64)
    .bind(msg.block_time.unwrap_or_else(|| chrono::Utc::now().timestamp()))
    .bind(&msg.signer)
    .bind(serde_json::to_string(&msg.args_json)?)
    .bind(msg.log_lines.clone())
    .bind(msg.constraint_kind.clone())
    .bind(msg.cu_consumed.map(|v| v as i64))
    .execute(pg)
    .await?;

    Ok(())
}
