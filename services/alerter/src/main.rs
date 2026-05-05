use anyhow::Result;
use axum::{response::IntoResponse, routing::get, Router};
use chrono::{DateTime, Utc};
use prometheus::{Encoder, HistogramVec, IntCounter, IntGauge, Registry, TextEncoder};
use serde_json::{json, Value};
use solobserve_config::Config;
use solobserve_dsl::{compile, CompileCtx};
use sqlx::{PgPool, Row};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

#[derive(Clone)]
struct Metrics {
    registry: Registry,
    rules_evaluated_total: IntCounter,
    eval_latency_ms: HistogramVec,
    incidents_open: IntGauge,
}

impl Metrics {
    fn new() -> Self {
        let registry = Registry::new();
        let rules_evaluated_total = IntCounter::new("alerter_rules_evaluated_total", "Rules evaluated").expect("metric");
        let eval_latency_ms = HistogramVec::new(
            prometheus::HistogramOpts::new("alerter_eval_latency_ms", "Eval latency in ms"),
            &["kind"],
        )
        .expect("metric");
        let incidents_open = IntGauge::new("alerter_incidents_open", "Open incidents").expect("metric");
        registry.register(Box::new(rules_evaluated_total.clone())).ok();
        registry.register(Box::new(eval_latency_ms.clone())).ok();
        registry.register(Box::new(incidents_open.clone())).ok();
        Self { registry, rules_evaluated_total, eval_latency_ms, incidents_open }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let pg = PgPool::connect(&cfg.postgres.url).await?;
    let metrics = Metrics::new();
    spawn_metrics_server(metrics.clone());
    loop {
        evaluate_due_rules(&pg, &cfg, &metrics).await?;
        update_open_incidents_metric(&pg, &metrics).await.ok();
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn spawn_metrics_server(metrics: Metrics) {
    tokio::spawn(async move {
        async fn handler(metrics: Arc<Metrics>) -> impl IntoResponse {
            let mut buffer = Vec::new();
            let encoder = TextEncoder::new();
            let families = metrics.registry.gather();
            if encoder.encode(&families, &mut buffer).is_err() {
                return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "encode error").into_response();
            }
            (axum::http::StatusCode::OK, String::from_utf8_lossy(&buffer).to_string()).into_response()
        }
        let shared = Arc::new(metrics);
        let app = Router::new().route("/metrics", get({
            let shared = shared.clone();
            move || handler(shared.clone())
        }));
        let listener = tokio::net::TcpListener::bind("0.0.0.0:9292").await.expect("bind");
        axum::serve(listener, app).await.expect("serve");
    });
}

async fn evaluate_due_rules(pg: &PgPool, cfg: &Config, metrics: &Metrics) -> Result<()> {
    let rows = sqlx::query(
        r#"
        SELECT r.id, r.program_id_fk, r.name, r.kind::text as kind, r.definition, r.evaluation_interval_seconds, r.severity::text as severity, r.enabled,
               p.program_id, p.cluster::text as cluster, p.project_id
        FROM alert_rules r
        JOIN programs p ON p.id = r.program_id_fk
        LEFT JOIN alert_rule_state s ON s.rule_id = r.id
        WHERE r.enabled = TRUE
          AND (s.last_eval_at IS NULL OR s.last_eval_at + make_interval(secs => r.evaluation_interval_seconds) <= NOW())
        ORDER BY r.created_at ASC
        LIMIT 100
        "#,
    )
    .fetch_all(pg)
    .await?;

    for row in rows {
        let started = std::time::Instant::now();
        let rule_id = row.try_get::<uuid::Uuid, _>("id")?;
        if !try_rule_lock(pg, rule_id).await? {
            continue;
        }
        let kind = row.try_get::<String, _>("kind")?;
        let name = row.try_get::<String, _>("name")?;
        let severity = row.try_get::<String, _>("severity")?;
        let definition = row.try_get::<Value, _>("definition")?;
        let program_id = row.try_get::<String, _>("program_id")?;
        let cluster = row.try_get::<String, _>("cluster")?;
        let eval = evaluate_rule(kind.as_str(), &definition, &program_id, &cluster, cfg).await?;
        apply_state_machine(
            pg,
            rule_id,
            &name,
            &severity,
            &definition,
            eval,
        )
        .await?;
        unlock_rule(pg, rule_id).await.ok();
        metrics.rules_evaluated_total.inc();
        metrics
            .eval_latency_ms
            .with_label_values(&[kind.as_str()])
            .observe(started.elapsed().as_millis() as f64);
    }
    Ok(())
}

struct EvalResult {
    firing: bool,
    value: Value,
    summary: String,
    labels: BTreeMap<String, String>,
}

async fn evaluate_rule(
    kind: &str,
    definition: &Value,
    program_id: &str,
    cluster: &str,
    cfg: &Config,
) -> Result<EvalResult> {
    match kind {
        "dsl" => evaluate_dsl_rule(definition, program_id, cluster, cfg).await,
        "template" => evaluate_template_rule(definition, program_id, cluster, cfg).await,
        _ => Ok(EvalResult {
            firing: false,
            value: json!({ "reason": "unknown kind" }),
            summary: "Unknown rule kind".to_string(),
            labels: BTreeMap::new(),
        }),
    }
}

async fn evaluate_dsl_rule(
    definition: &Value,
    program_id: &str,
    cluster: &str,
    cfg: &Config,
) -> Result<EvalResult> {
    let dsl = definition.get("dsl").and_then(|v| v.as_str()).unwrap_or("");
    if dsl.is_empty() {
        return Ok(EvalResult {
            firing: false,
            value: json!({}),
            summary: "No DSL configured".to_string(),
            labels: BTreeMap::new(),
        });
    }
    let threshold = definition.get("threshold").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let op = definition.get("op").and_then(|v| v.as_str()).unwrap_or(">");
    let now_ms = Utc::now().timestamp_millis();
    let window_ms = definition.get("window_ms").and_then(|v| v.as_i64()).unwrap_or(5 * 60_000);
    let compiled = compile(
        dsl,
        &CompileCtx {
            program_id: program_id.to_string(),
            cluster: cluster.to_string(),
            from_ms: now_ms - window_ms,
            to_ms: now_ms,
            step_ms: 60_000,
        },
    )?;
    let rows = clickhouse_query(cfg, &compiled.sql, &compiled.params).await?;
    let val = rows
        .iter()
        .filter_map(|r| r.get("v").and_then(|v| v.as_f64()))
        .last()
        .unwrap_or(0.0);
    let firing = compare_numeric(val, threshold, op);
    Ok(EvalResult {
        firing,
        value: json!({ "value": val, "threshold": threshold, "op": op }),
        summary: format!(
            "DSL rule {} threshold ({op} {threshold})",
            if firing { "crossed" } else { "below" }
        ),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_template_rule(
    definition: &Value,
    program_id: &str,
    cluster: &str,
    cfg: &Config,
) -> Result<EvalResult> {
    let kind = definition.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "error_rate_spike" => evaluate_dsl_rule(
            &json!({
                "dsl": definition.get("dsl").and_then(|v| v.as_str()).unwrap_or("rate(errors_total[5m])"),
                "threshold": definition.get("threshold").and_then(|v| v.as_f64()).unwrap_or(1.0),
                "op": ">",
                "window_ms": 5 * 60_000
            }),
            program_id,
            cluster,
            cfg,
        )
        .await,
        "cu_regression" => evaluate_cu_regression(definition, program_id, cluster, cfg).await,
        "field_watch" => evaluate_field_watch(definition, program_id, cluster, cfg).await,
        _ => Ok(EvalResult {
            firing: false,
            value: json!({ "kind": kind }),
            summary: format!("Template '{kind}' not firing"),
            labels: BTreeMap::new(),
        }),
    }
}

async fn evaluate_cu_regression(
    definition: &Value,
    program_id: &str,
    cluster: &str,
    cfg: &Config,
) -> Result<EvalResult> {
    let instruction = definition
        .get("instruction")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let multiplier = definition.get("multiplier").and_then(|v| v.as_f64()).unwrap_or(1.5);
    let sql = r#"
        WITH
          current AS (
            SELECT quantileTDigestMerge(0.95)(cu_tdigest_state) AS p95
            FROM metrics_instruction_calls_minute
            WHERE program_id = {program_id:String}
              AND cluster = {cluster:String}
              AND instruction_name = {instruction:String}
              AND minute >= now() - INTERVAL 30 MINUTE
          ),
          baseline AS (
            SELECT quantileTDigestMerge(0.95)(cu_tdigest_state) AS p95
            FROM metrics_instruction_calls_minute
            WHERE program_id = {program_id:String}
              AND cluster = {cluster:String}
              AND instruction_name = {instruction:String}
              AND minute >= now() - INTERVAL 7 DAY
              AND minute < now() - INTERVAL 30 MINUTE
          )
        SELECT current.p95 AS current_p95, baseline.p95 AS baseline_p95
        FROM current CROSS JOIN baseline
    "#;
    let params = BTreeMap::from([
        ("program_id".to_string(), json!(program_id)),
        ("cluster".to_string(), json!(cluster)),
        ("instruction".to_string(), json!(instruction)),
    ]);
    let rows = clickhouse_query(cfg, sql, &params).await?;
    let current = rows
        .first()
        .and_then(|r| r.get("current_p95"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let baseline = rows
        .first()
        .and_then(|r| r.get("baseline_p95"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let firing = baseline > 0.0 && current > baseline * multiplier;
    Ok(EvalResult {
        firing,
        value: json!({ "current_p95": current, "baseline_p95": baseline, "multiplier": multiplier }),
        summary: format!("CU regression check current={current:.2} baseline={baseline:.2}"),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_field_watch(
    definition: &Value,
    _program_id: &str,
    _cluster: &str,
    cfg: &Config,
) -> Result<EvalResult> {
    let pg = PgPool::connect(&cfg.postgres.url).await?;
    let watch_id = definition.get("watch_id").and_then(|v| v.as_str()).unwrap_or("");
    let row = sqlx::query(
        r#"
        SELECT id, account, field_path, threshold_numeric
        FROM pending_field_watches
        WHERE ($1 = '' OR id::text = $1)
        ORDER BY created_at ASC
        LIMIT 1
        "#,
    )
    .bind(watch_id)
    .fetch_optional(&pg)
    .await?;
    let Some(row) = row else {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "No pending field watch".into(), labels: BTreeMap::new() });
    };
    let account = row.try_get::<String, _>("account")?;
    let field_path = row.try_get::<String, _>("field_path")?;
    let threshold = row.try_get::<Option<f64>, _>("threshold_numeric")?;
    let current = sqlx::query(
        "SELECT decoded_json FROM account_state WHERE account = $1 LIMIT 1",
    )
    .bind(&account)
    .fetch_optional(&pg)
    .await?;
    let firing = if let (Some(r), Some(t)) = (current, threshold) {
        let json: Value = r.try_get("decoded_json").unwrap_or(Value::Null);
        json.get(&field_path)
            .and_then(|v| v.as_f64())
            .map(|v| v > t)
            .unwrap_or(false)
    } else {
        false
    };
    Ok(EvalResult {
        firing,
        value: json!({ "account": account, "field_path": field_path, "threshold": threshold }),
        summary: "Field watch evaluation".into(),
        labels: BTreeMap::new(),
    })
}

fn compare_numeric(v: f64, threshold: f64, op: &str) -> bool {
    match op {
        ">" => v > threshold,
        ">=" => v >= threshold,
        "<" => v < threshold,
        "<=" => v <= threshold,
        "==" => (v - threshold).abs() < f64::EPSILON,
        "!=" => (v - threshold).abs() > f64::EPSILON,
        _ => v > threshold,
    }
}

async fn clickhouse_query(
    cfg: &Config,
    sql: &str,
    params: &BTreeMap<String, Value>,
) -> Result<Vec<Value>> {
    let url = format!(
        "{}?database={}&user={}&password={}",
        cfg.clickhouse.url, cfg.clickhouse.database, cfg.clickhouse.user, cfg.clickhouse.password
    );
    let mut req = reqwest::Client::new()
        .post(url)
        .header("Content-Type", "text/plain");
    for (k, v) in params {
        let val = v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string());
        req = req.query(&[(format!("param_{k}"), val)]);
    }
    let body = format!("{sql}\nFORMAT JSONEachRow");
    let res = req.body(body).send().await?;
    if !res.status().is_success() {
        return Err(anyhow::anyhow!("clickhouse query failed: {}", res.status()));
    }
    let text = res.text().await?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect())
}

async fn apply_state_machine(
    pg: &PgPool,
    rule_id: uuid::Uuid,
    rule_name: &str,
    severity: &str,
    definition: &Value,
    eval: EvalResult,
) -> Result<()> {
    let for_seconds = definition.get("for_seconds").and_then(|v| v.as_i64()).unwrap_or(0);
    let prev = sqlx::query(
        "SELECT last_status::text as last_status, since_ts FROM alert_rule_state WHERE rule_id = $1::uuid",
    )
    .bind(rule_id)
    .fetch_optional(pg)
    .await?;
    let prev_status = prev
        .as_ref()
        .and_then(|r| r.try_get::<String, _>("last_status").ok())
        .unwrap_or_else(|| "ok".to_string());
    let since = prev
        .as_ref()
        .and_then(|r| r.try_get::<Option<DateTime<Utc>>, _>("since_ts").ok())
        .flatten()
        .unwrap_or_else(Utc::now);
    let now = Utc::now();
    let mut next_status = prev_status.clone();
    let eval_value = eval.value.clone();
    if eval.firing {
        if prev_status == "ok" {
            next_status = "pending".to_string();
        } else if prev_status == "pending" && now.signed_duration_since(since).num_seconds() >= for_seconds {
            next_status = "firing".to_string();
        } else if prev_status == "firing" {
            next_status = "firing".to_string();
        }
    } else {
        next_status = "ok".to_string();
    }

    sqlx::query(
        r#"
        INSERT INTO alert_rule_state(rule_id, last_eval_at, last_value, last_status, since_ts)
        VALUES ($1::uuid, NOW(), $2::jsonb, $3::alert_state_status, CASE WHEN $3 IN ('pending','firing')::text[] THEN NOW() ELSE NULL END)
        ON CONFLICT (rule_id)
        DO UPDATE SET
          last_eval_at = NOW(),
          last_value = EXCLUDED.last_value,
          last_status = EXCLUDED.last_status,
          since_ts = CASE
             WHEN EXCLUDED.last_status IN ('pending','firing') THEN COALESCE(alert_rule_state.since_ts, NOW())
             ELSE NULL
          END
        "#,
    )
    .bind(rule_id)
    .bind(eval_value.clone())
    .bind(next_status.clone())
    .execute(pg)
    .await?;

    if prev_status != "firing" && next_status == "firing" {
        let dedup_key = format!("{rule_id}:default");
        let incident_id: uuid::Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO alert_incidents(rule_id_fk, fingerprint, status, severity, summary, dedup_key)
            VALUES ($1::uuid, $2, 'firing'::alert_incident_status, $3::alert_severity, $4, $5)
            ON CONFLICT (rule_id_fk, dedup_key)
            DO UPDATE SET status = 'firing', resolved_at = NULL, summary = EXCLUDED.summary
            RETURNING id
            "#,
        )
        .bind(rule_id)
        .bind(dedup_key.clone())
        .bind(severity)
        .bind(eval.summary.clone())
        .bind(dedup_key.clone())
        .fetch_one(pg)
        .await?;
        sqlx::query(
            "INSERT INTO alert_incident_events(incident_id_fk, kind, payload) VALUES ($1::uuid, 'fired'::alert_incident_event_kind, $2::jsonb)",
        )
        .bind(incident_id)
        .bind(json!({ "summary": eval.summary, "value": eval_value, "labels": eval.labels }))
        .execute(pg)
        .await?;
        notify_incident(pg, incident_id, rule_name, severity, &eval.summary).await?;
    }

    if prev_status == "firing" && next_status == "ok" {
        if let Some(incident_id) = sqlx::query_scalar::<_, uuid::Uuid>(
            "SELECT id FROM alert_incidents WHERE rule_id_fk = $1::uuid AND status = 'firing'::alert_incident_status ORDER BY started_at DESC LIMIT 1",
        )
        .bind(rule_id)
        .fetch_optional(pg)
        .await?
        {
            sqlx::query(
                "UPDATE alert_incidents SET status='resolved'::alert_incident_status, resolved_at=NOW() WHERE id = $1::uuid",
            )
            .bind(incident_id)
            .execute(pg)
            .await?;
            sqlx::query(
                "INSERT INTO alert_incident_events(incident_id_fk, kind, payload) VALUES ($1::uuid, 'resolved'::alert_incident_event_kind, $2::jsonb)",
            )
            .bind(incident_id)
            .bind(json!({ "auto": true }))
            .execute(pg)
            .await?;
        }
    }
    Ok(())
}

async fn notify_incident(
    pg: &PgPool,
    incident_id: uuid::Uuid,
    rule_name: &str,
    severity: &str,
    summary: &str,
) -> Result<()> {
    let meta = sqlx::query(
        r#"
        SELECT i.id, i.rule_id_fk, r.program_id_fk, p.project_id, pr.org_id
        FROM alert_incidents i
        JOIN alert_rules r ON r.id = i.rule_id_fk
        JOIN programs p ON p.id = r.program_id_fk
        JOIN projects pr ON pr.id = p.project_id
        WHERE i.id = $1::uuid
        "#,
    )
    .bind(incident_id)
    .fetch_one(pg)
    .await?;
    let org_id = meta.try_get::<uuid::Uuid, _>("org_id")?;
    let channels = sqlx::query(
        "SELECT id, kind::text as kind, config_encrypted FROM notification_channels WHERE org_id_fk = $1::uuid",
    )
    .bind(org_id)
    .fetch_all(pg)
    .await?;
    for ch in channels {
        let kind = ch.try_get::<String, _>("kind")?;
        let enc = ch.try_get::<Vec<u8>, _>("config_encrypted")?;
        let cfg = decrypt_channel_config(&enc).unwrap_or(Value::Null);
        if cfg.is_null() {
            continue;
        }
        let sent = send_channel_notification(&kind, &cfg, rule_name, severity, summary).await.is_ok();
        sqlx::query(
            "INSERT INTO alert_incident_events(incident_id_fk, kind, payload) VALUES ($1::uuid, 'notified'::alert_incident_event_kind, $2::jsonb)",
        )
        .bind(incident_id)
        .bind(json!({ "channel_kind": kind, "sent": sent }))
        .execute(pg)
        .await?;
    }
    Ok(())
}

async fn send_channel_notification(
    kind: &str,
    config: &Value,
    rule_name: &str,
    severity: &str,
    summary: &str,
) -> Result<()> {
    let client = reqwest::Client::new();
    let body = json!({
        "title": format!("[{severity}] {rule_name}"),
        "summary": summary,
        "severity": severity
    });
    match kind {
        "slack" | "discord" | "webhook" | "telegram" | "pagerduty" => {
            let url = config.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() {
                return Ok(());
            }
            client.post(url).json(&body).send().await?;
        }
        "email" => {
            // v1 email adapter: writes event only; SMTP sender can be added without schema changes.
        }
        _ => {}
    }
    Ok(())
}

fn decrypt_channel_config(data: &[u8]) -> Result<Value> {
    if data.is_empty() {
        return Ok(Value::Null);
    }
    let key_raw = std::env::var("ALERT_ENCRYPTION_KEY").unwrap_or_default();
    if key_raw.is_empty() {
        return Ok(Value::Null);
    }
    let key_bytes = if let Ok(b) = hex::decode(&key_raw) {
        b
    } else {
        key_raw.as_bytes().to_vec()
    };
    if key_bytes.len() < 32 || data.len() < 12 {
        return Ok(Value::Null);
    }
    let nonce = &data[..12];
    let ciphertext = &data[12..];
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Key, Nonce,
    };
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes[..32]);
    let cipher = Aes256Gcm::new(key);
    let plain = cipher.decrypt(Nonce::from_slice(nonce), ciphertext).unwrap_or_default();
    if plain.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_slice(&plain)?)
}

async fn try_rule_lock(pg: &PgPool, rule_id: uuid::Uuid) -> Result<bool> {
    let r: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtext($1))")
        .bind(rule_id.to_string())
        .fetch_one(pg)
        .await?;
    Ok(r)
}

async fn unlock_rule(pg: &PgPool, rule_id: uuid::Uuid) -> Result<()> {
    let _: bool = sqlx::query_scalar("SELECT pg_advisory_unlock(hashtext($1))")
        .bind(rule_id.to_string())
        .fetch_one(pg)
        .await?;
    Ok(())
}

async fn update_open_incidents_metric(pg: &PgPool, metrics: &Metrics) -> Result<()> {
    let c: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM alert_incidents WHERE status IN ('firing'::alert_incident_status, 'acknowledged'::alert_incident_status)",
    )
    .fetch_one(pg)
    .await?;
    metrics.incidents_open.set(c);
    Ok(())
}
