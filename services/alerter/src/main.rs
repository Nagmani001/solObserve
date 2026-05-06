use anyhow::Result;
use axum::{response::IntoResponse, routing::get, Router};
use chrono::{DateTime, Utc};
use lettre::{
    message::{header::ContentType, Mailbox},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use prometheus::{Encoder, HistogramVec, IntCounter, IntCounterVec, IntGauge, Registry, TextEncoder};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
    notify_latency_ms: HistogramVec,
    notify_failed_total: IntCounterVec,
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
        let notify_latency_ms = HistogramVec::new(
            prometheus::HistogramOpts::new("alerter_notify_latency_ms", "Notification latency in ms"),
            &["channel"],
        )
        .expect("metric");
        let notify_failed_total = IntCounterVec::new(
            prometheus::Opts::new("alerter_notify_failed_total", "Notification failures"),
            &["channel", "reason"],
        )
        .expect("metric");
        registry.register(Box::new(rules_evaluated_total.clone())).ok();
        registry.register(Box::new(eval_latency_ms.clone())).ok();
        registry.register(Box::new(incidents_open.clone())).ok();
        registry.register(Box::new(notify_latency_ms.clone())).ok();
        registry.register(Box::new(notify_failed_total.clone())).ok();
        Self { registry, rules_evaluated_total, eval_latency_ms, incidents_open, notify_latency_ms, notify_failed_total }
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
        process_escalations(&pg).await?;
        process_pending_deliveries(&pg, &cfg, &metrics).await?;
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
        "treasury_balance_drop" => evaluate_treasury_balance_drop(definition, program_id, cluster, cfg).await,
        "authority_instruction_invoked" => evaluate_authority_instruction_invoked(definition, program_id, cluster, cfg).await,
        "program_upgrade_detected" => evaluate_program_upgrade_detected(definition, program_id, cluster, cfg).await,
        "upgrade_authority_changed" => evaluate_upgrade_authority_changed(definition, program_id, cluster, cfg).await,
        "vault_outflow_anomaly" => evaluate_vault_outflow_anomaly(definition, program_id, cluster, cfg).await,
        "tvl_drop" => evaluate_tvl_drop(definition, program_id, cluster, cfg).await,
        "mint_supply_jump" => evaluate_mint_supply_jump(definition, program_id, cluster, cfg).await,
        "compute_budget_exhausted_rate" => evaluate_compute_budget_exhausted_rate(definition, program_id, cluster, cfg).await,
        "address_tag_activity" => evaluate_address_tag_activity(definition, program_id, cluster, cfg).await,
        "field_watch" => evaluate_field_watch(definition, program_id, cluster, cfg).await,
        _ => Ok(EvalResult {
            firing: false,
            value: json!({ "kind": kind }),
            summary: format!("Template '{kind}' not firing"),
            labels: BTreeMap::new(),
        }),
    }
}

async fn evaluate_treasury_balance_drop(definition: &Value, program_id: &str, _cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let account = definition.get("account").and_then(|v| v.as_str()).unwrap_or("");
    let percent = definition.get("percent").and_then(|v| v.as_f64()).unwrap_or(5.0);
    let minutes = definition.get("window_minutes").and_then(|v| v.as_i64()).unwrap_or(5);
    if account.is_empty() {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "missing account".into(), labels: BTreeMap::new() });
    }
    let pg = PgPool::connect(&cfg.postgres.url).await?;
    let rows = sqlx::query(
        r#"
        SELECT h.decoded_json
        FROM account_state_history h
        JOIN programs p ON p.id = h.program_id_fk
        WHERE p.program_id = $1
          AND h.account = $2
          AND h.slot >= (
            SELECT max(slot) - 1000000 FROM account_state_history h2 WHERE h2.account = $2
          )
        ORDER BY h.slot DESC
        LIMIT 256
        "#,
    )
    .bind(program_id)
    .bind(account)
    .fetch_all(&pg)
    .await?;
    if rows.len() < 2 {
        return Ok(EvalResult { firing: false, value: json!({ "reason": "insufficient history" }), summary: "insufficient history".into(), labels: BTreeMap::new() });
    }
    let latest: Value = rows[0].try_get("decoded_json").unwrap_or(Value::Null);
    let old: Value = rows[(rows.len() - 1).min((minutes as usize).max(1))].try_get("decoded_json").unwrap_or(Value::Null);
    let latest_bal = json_number_at(&latest, &["lamports", "amount", "supply"]);
    let old_bal = json_number_at(&old, &["lamports", "amount", "supply"]);
    if old_bal <= 0.0 {
        return Ok(EvalResult { firing: false, value: json!({ "latest": latest_bal, "old": old_bal }), summary: "old balance unavailable".into(), labels: BTreeMap::new() });
    }
    let drop_pct = ((latest_bal - old_bal) / old_bal) * 100.0;
    let firing = drop_pct <= -percent;
    Ok(EvalResult {
        firing,
        value: json!({ "account": account, "drop_pct": drop_pct, "threshold_pct": percent, "latest": latest_bal, "old": old_bal }),
        summary: format!("treasury balance delta {drop_pct:.2}%"),
        labels: BTreeMap::from([("account".to_string(), account.to_string())]),
    })
}

async fn evaluate_authority_instruction_invoked(definition: &Value, program_id: &str, cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let names = definition
        .get("instruction_names")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();
    if names.is_empty() {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "no instruction names".into(), labels: BTreeMap::new() });
    }
    let rows = clickhouse_query(
        cfg,
        r#"
          SELECT any(signature) as signature, any(ix_index) as ix_index, count() AS c
          FROM instructions
          WHERE program_id = {program_id:String}
            AND cluster = {cluster:String}
            AND status = 'success'
            AND instruction_name IN ({instruction_names:Array(String)})
            AND block_time >= now() - INTERVAL 1 MINUTE
          GROUP BY signature, ix_index
          LIMIT 1
        "#,
        &BTreeMap::from([
            ("program_id".to_string(), json!(program_id)),
            ("cluster".to_string(), json!(cluster)),
            ("instruction_names".to_string(), json!(names)),
        ]),
    )
    .await?;
    let firing = !rows.is_empty();
    Ok(EvalResult {
        firing,
        value: json!({ "match_count": rows.len() }),
        summary: "authority instruction invoked".into(),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_program_upgrade_detected(_definition: &Value, program_id: &str, cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let loader = "BPFLoaderUpgradeable11111111111111111111111111";
    let rows = clickhouse_query(
        cfg,
        r#"
        SELECT signature
        FROM instructions
        WHERE program_id = {loader:String}
          AND cluster = {cluster:String}
          AND block_time >= now() - INTERVAL 10 MINUTE
          AND args_json LIKE concat('%', {target:String}, '%')
        LIMIT 1
        "#,
        &BTreeMap::from([
            ("loader".to_string(), json!(loader)),
            ("cluster".to_string(), json!(cluster)),
            ("target".to_string(), json!(program_id)),
        ]),
    )
    .await?;
    Ok(EvalResult {
        firing: !rows.is_empty(),
        value: json!({ "matches": rows.len() }),
        summary: "program upgrade detection".into(),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_upgrade_authority_changed(definition: &Value, _program_id: &str, _cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let account = definition.get("account").and_then(|v| v.as_str()).unwrap_or("");
    if account.is_empty() {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "missing account".into(), labels: BTreeMap::new() });
    }
    let pg = PgPool::connect(&cfg.postgres.url).await?;
    let rows = sqlx::query(
        r#"
        SELECT decoded_json
        FROM account_state_history
        WHERE account = $1
        ORDER BY slot DESC
        LIMIT 2
        "#,
    )
    .bind(account)
    .fetch_all(&pg)
    .await?;
    if rows.len() < 2 {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "insufficient history".into(), labels: BTreeMap::new() });
    }
    let latest: Value = rows[0].try_get("decoded_json").unwrap_or(Value::Null);
    let prev: Value = rows[1].try_get("decoded_json").unwrap_or(Value::Null);
    let l = latest.get("upgrade_authority").and_then(|v| v.as_str()).unwrap_or("");
    let p = prev.get("upgrade_authority").and_then(|v| v.as_str()).unwrap_or("");
    Ok(EvalResult {
        firing: !l.is_empty() && l != p,
        value: json!({ "previous": p, "latest": l }),
        summary: "upgrade authority changed".into(),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_vault_outflow_anomaly(definition: &Value, _program_id: &str, _cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let account = definition.get("account").and_then(|v| v.as_str()).unwrap_or("");
    let sensitivity = definition.get("sensitivity").and_then(|v| v.as_f64()).unwrap_or(3.0);
    if account.is_empty() {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "missing account".into(), labels: BTreeMap::new() });
    }
    let sql = r#"
      WITH base AS (
        SELECT
          toFloat64OrZero(JSONExtractString(decoded_json, 'lamports')) AS lamports,
          lagInFrame(toFloat64OrZero(JSONExtractString(decoded_json, 'lamports'))) OVER (ORDER BY slot ASC) AS prev_lamports
        FROM account_writes
        WHERE account = {account:String}
          AND block_time >= now() - INTERVAL 7 DAY
      ),
      diffs AS (
        SELECT greatest(prev_lamports - lamports, 0) AS outflow
        FROM base
        WHERE prev_lamports > 0
      ),
      stats AS (
        SELECT quantileExactExclusive(0.5)(outflow) AS p50, quantileExactExclusive(0.99)(outflow) AS p99
        FROM diffs
      ),
      latest AS (
        SELECT outflow AS latest_outflow
        FROM diffs
        ORDER BY outflow DESC
        LIMIT 1
      )
      SELECT latest_outflow, p50, p99, if(p99 > p50, (latest_outflow - p50)/(p99-p50), 0) AS zscore
      FROM latest CROSS JOIN stats
    "#;
    let rows = clickhouse_query(cfg, sql, &BTreeMap::from([("account".to_string(), json!(account))])).await?;
    let z = rows.first().and_then(|r| r.get("zscore")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    Ok(EvalResult {
        firing: z > sensitivity,
        value: rows.first().cloned().unwrap_or(json!({})),
        summary: format!("vault outflow zscore={z:.2}"),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_tvl_drop(definition: &Value, _program_id: &str, _cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let vaults = definition
        .get("vaults")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();
    let percent = definition.get("percent").and_then(|v| v.as_f64()).unwrap_or(5.0);
    if vaults.is_empty() {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "no vaults".into(), labels: BTreeMap::new() });
    }
    let pg = PgPool::connect(&cfg.postgres.url).await?;
    let rows = sqlx::query(
        "SELECT account, decoded_json FROM account_state WHERE account = ANY($1)",
    )
    .bind(&vaults)
    .fetch_all(&pg)
    .await?;
    let current_sum: f64 = rows
        .iter()
        .map(|r| {
            let j: Value = r.try_get("decoded_json").unwrap_or(Value::Null);
            json_number_at(&j, &["lamports", "amount"])
        })
        .sum();
    let baseline = definition.get("baseline").and_then(|v| v.as_f64()).unwrap_or(current_sum);
    let drop_pct = if baseline > 0.0 {
        ((current_sum - baseline) / baseline) * 100.0
    } else {
        0.0
    };
    Ok(EvalResult {
        firing: drop_pct <= -percent,
        value: json!({ "current": current_sum, "baseline": baseline, "drop_pct": drop_pct }),
        summary: "TVL drop".into(),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_mint_supply_jump(definition: &Value, _program_id: &str, _cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let mint = definition.get("mint").and_then(|v| v.as_str()).unwrap_or("");
    let threshold = definition.get("delta_threshold").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if mint.is_empty() {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "missing mint".into(), labels: BTreeMap::new() });
    }
    let sql = r#"
      SELECT
        anyLast(toFloat64OrZero(JSONExtractString(decoded_json, 'supply'))) AS latest_supply,
        any(toFloat64OrZero(JSONExtractString(decoded_json, 'supply'))) AS first_supply
      FROM account_writes
      WHERE account = {mint:String}
        AND block_time >= now() - INTERVAL 30 MINUTE
    "#;
    let rows = clickhouse_query(cfg, sql, &BTreeMap::from([("mint".to_string(), json!(mint))])).await?;
    let latest = rows.first().and_then(|r| r.get("latest_supply")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let first = rows.first().and_then(|r| r.get("first_supply")).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let delta = latest - first;
    Ok(EvalResult {
        firing: delta > threshold,
        value: json!({ "latest": latest, "first": first, "delta": delta }),
        summary: "mint supply jump".into(),
        labels: BTreeMap::new(),
    })
}

async fn evaluate_compute_budget_exhausted_rate(definition: &Value, program_id: &str, cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let threshold = definition.get("threshold").and_then(|v| v.as_f64()).unwrap_or(1.0);
    evaluate_dsl_rule(
        &json!({
            "dsl": "rate(errors_total{error_name=\"ComputeBudgetExceeded\"}[5m])",
            "threshold": threshold,
            "op": ">",
            "window_ms": 5 * 60_000
        }),
        program_id,
        cluster,
        cfg,
    )
    .await
}

async fn evaluate_address_tag_activity(definition: &Value, program_id: &str, cluster: &str, cfg: &Config) -> Result<EvalResult> {
    let addresses = definition
        .get("addresses")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Ok(EvalResult { firing: false, value: json!({}), summary: "no addresses".into(), labels: BTreeMap::new() });
    }
    let rows = clickhouse_query(
        cfg,
        r#"
        SELECT signature
        FROM transactions
        WHERE program_id = {program_id:String}
          AND cluster = {cluster:String}
          AND signer IN ({addresses:Array(String)})
          AND block_time >= now() - INTERVAL 5 MINUTE
        LIMIT 1
        "#,
        &BTreeMap::from([
            ("program_id".to_string(), json!(program_id)),
            ("cluster".to_string(), json!(cluster)),
            ("addresses".to_string(), json!(addresses)),
        ]),
    )
    .await?;
    Ok(EvalResult {
        firing: !rows.is_empty(),
        value: json!({ "matches": rows.len() }),
        summary: "address tag activity".into(),
        labels: BTreeMap::new(),
    })
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
        let silenced = is_silenced(pg, rule_id, &eval.labels).await?;
        sqlx::query(
            "INSERT INTO alert_incident_events(incident_id_fk, kind, payload) VALUES ($1::uuid, 'fired'::alert_incident_event_kind, $2::jsonb)",
        )
        .bind(incident_id)
        .bind(json!({ "summary": eval.summary, "value": eval_value, "labels": eval.labels }))
        .execute(pg)
        .await?;
        if silenced {
            sqlx::query(
                "INSERT INTO alert_incident_events(incident_id_fk, kind, payload) VALUES ($1::uuid, 'silenced'::alert_incident_event_kind, $2::jsonb)",
            )
            .bind(incident_id)
            .bind(json!({ "reason": "matched active silence" }))
            .execute(pg)
            .await?;
        } else {
            notify_incident(pg, incident_id, rule_name, severity, &eval.summary, &eval.labels, None).await?;
        }
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
    _rule_name: &str,
    severity: &str,
    _summary: &str,
    labels: &BTreeMap<String, String>,
    force_route: Option<uuid::Uuid>,
) -> Result<()> {
    let meta = sqlx::query(
        r#"
        SELECT i.id, i.rule_id_fk, i.dedup_key, r.program_id_fk, p.project_id, pr.org_id
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
    let dedup_key = meta.try_get::<String, _>("dedup_key")?;
    let routes = sqlx::query(
        "SELECT id, matchers, channel_ids, severity_min::text as severity_min, group_wait_seconds, group_interval_seconds, repeat_interval_seconds FROM notification_routes WHERE org_id_fk = $1::uuid ORDER BY id ASC",
    )
    .bind(org_id)
    .fetch_all(pg)
    .await?;
    let route = select_route(&routes, severity, labels, force_route)?;
    let Some(route) = route else {
        return Ok(());
    };
    let route_id = route.try_get::<uuid::Uuid, _>("id")?;
    let channel_ids = route.try_get::<Vec<uuid::Uuid>, _>("channel_ids").unwrap_or_default();
    let route_matchers: Value = route.try_get("matchers").unwrap_or(json!({}));
    let group_wait = route.try_get::<i32, _>("group_wait_seconds").unwrap_or(30).max(0) as i64;
    let group_interval = route.try_get::<i32, _>("group_interval_seconds").unwrap_or(300).max(1);
    let repeat_interval = route.try_get::<i32, _>("repeat_interval_seconds").unwrap_or(14400).max(1);
    let send_after = Utc::now() + chrono::Duration::seconds(group_wait);
    if let Some(schedule_id) = route_matchers
        .get("oncall_schedule_id")
        .and_then(|v| v.as_str())
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
    {
        if let Some(oncall_email) = resolve_oncall_email(pg, schedule_id).await? {
            let config = json!({ "to": oncall_email, "subject_prefix": "[SolObserve OnCall]" });
            let ch_id = uuid::Uuid::nil();
            let window = Utc::now().timestamp() / repeat_interval as i64;
            let idem = delivery_key(incident_id, ch_id, window);
            let inserted: Option<uuid::Uuid> = sqlx::query_scalar(
                r#"
                INSERT INTO alert_notification_deliveries(incident_id_fk, route_id_fk, channel_id_fk, idempotency_key, status, attempts, next_attempt_at)
                VALUES ($1::uuid, $2::uuid, NULL, $3, 'pending'::alert_delivery_status, 0, $4)
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING id
                "#,
            )
            .bind(incident_id)
            .bind(route_id)
            .bind(idem)
            .bind(send_after)
            .fetch_optional(pg)
            .await?;
            if inserted.is_some() {
                sqlx::query(
                    "INSERT INTO alert_incident_events(incident_id_fk, kind, payload) VALUES ($1::uuid, 'notified'::alert_incident_event_kind, $2::jsonb)",
                )
                .bind(incident_id)
                .bind(json!({ "channel_kind": "email", "queued": true, "oncall": true, "config": config }))
                .execute(pg)
                .await?;
            }
        }
    }
    for ch_id in channel_ids {
        let channel = sqlx::query(
            "SELECT id, kind::text as kind, config_encrypted FROM notification_channels WHERE id = $1::uuid",
        )
        .bind(ch_id)
        .fetch_optional(pg)
        .await?;
        let Some(channel) = channel else {
            continue;
        };
        let kind = channel.try_get::<String, _>("kind")?;
        let recent_count: i64 = sqlx::query_scalar(
            r#"
            SELECT count(*)
            FROM alert_notification_deliveries d
            JOIN alert_incidents i ON i.id = d.incident_id_fk
            WHERE d.route_id_fk = $1::uuid
              AND d.channel_id_fk = $2::uuid
              AND i.dedup_key = $3
              AND d.status = 'sent'::alert_delivery_status
              AND d.created_at >= NOW() - ($4 || ' seconds')::interval
            "#,
        )
        .bind(route_id)
        .bind(ch_id)
        .bind(&dedup_key)
        .bind(group_interval)
        .fetch_one(pg)
        .await
        .unwrap_or(0);
        if recent_count > 0 {
            continue;
        }
        let window = Utc::now().timestamp() / repeat_interval as i64;
        let idem = delivery_key(incident_id, ch_id, window);
        let inserted: Option<uuid::Uuid> = sqlx::query_scalar(
            r#"
            INSERT INTO alert_notification_deliveries(incident_id_fk, route_id_fk, channel_id_fk, idempotency_key, status, attempts, next_attempt_at)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pending'::alert_delivery_status, 0, $5)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
            "#,
        )
        .bind(incident_id)
        .bind(route_id)
        .bind(ch_id)
        .bind(idem)
        .bind(send_after)
        .fetch_optional(pg)
        .await?;
        if inserted.is_none() {
            continue;
        }
        sqlx::query(
            "INSERT INTO alert_incident_events(incident_id_fk, kind, payload) VALUES ($1::uuid, 'notified'::alert_incident_event_kind, $2::jsonb)",
        )
        .bind(incident_id)
        .bind(json!({ "channel_kind": kind, "queued": true }))
        .execute(pg)
        .await?;
    }
    Ok(())
}

async fn send_channel_notification(
    kind: &str,
    config: &Value,
    incident_id: uuid::Uuid,
    dedup_key: &str,
    rule_name: &str,
    severity: &str,
    summary: &str,
) -> Result<()> {
    let client = reqwest::Client::new();
    let incident_url = format!("{}/incident/{incident_id}", std::env::var("API_GATEWAY_URL").unwrap_or_else(|_| "http://localhost:8080".to_string()));
    let body = json!({
        "title": format!("[{severity}] {rule_name}"),
        "summary": summary,
        "severity": severity,
        "incident_id": incident_id,
        "dedup_key": dedup_key
    });
    match kind {
        "slack" => {
            let url = config.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() { return Ok(()); }
            let color = severity_color_hex(severity);
            let payload = json!({
                "attachments": [{ "color": color }],
                "blocks": [
                    { "type": "header", "text": { "type": "plain_text", "text": format!("[{severity}] {rule_name}") } },
                    { "type": "section", "text": { "type": "mrkdwn", "text": summary } },
                    { "type": "actions", "elements": [{ "type": "button", "text": { "type": "plain_text", "text": "Open incident" }, "url": incident_url }] }
                ]
            });
            client.post(url).json(&payload).send().await?;
        }
        "discord" => {
            let url = config.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() { return Ok(()); }
            let payload = json!({
                "embeds": [{
                    "title": format!("[{severity}] {rule_name}"),
                    "description": summary,
                    "color": severity_color_int(severity),
                    "fields": [{ "name": "Incident", "value": incident_url }]
                }]
            });
            client.post(url).json(&payload).send().await?;
        }
        "telegram" => {
            let token = config.get("bot_token").and_then(|v| v.as_str()).unwrap_or("");
            let chat_id = config.get("chat_id").and_then(|v| v.as_str()).unwrap_or("");
            if token.is_empty() || chat_id.is_empty() { return Ok(()); }
            let text = telegram_escape_markdown(&format!("*[{severity}]* {rule_name}\n{summary}\n{incident_url}"));
            let url = format!("https://api.telegram.org/bot{token}/sendMessage");
            client
                .post(url)
                .json(&json!({ "chat_id": chat_id, "parse_mode": "MarkdownV2", "text": text }))
                .send()
                .await?;
        }
        "pagerduty" => {
            let routing_key = config.get("routing_key").and_then(|v| v.as_str()).unwrap_or("");
            if routing_key.is_empty() { return Ok(()); }
            let action = config.get("event_action").and_then(|v| v.as_str()).unwrap_or("trigger");
            let payload = json!({
                "routing_key": routing_key,
                "event_action": action,
                "dedup_key": dedup_key,
                "payload": {
                    "summary": summary,
                    "severity": severity_pd(severity),
                    "source": rule_name,
                    "custom_details": body
                }
            });
            client.post("https://events.pagerduty.com/v2/enqueue").json(&payload).send().await?;
        }
        "webhook" => {
            let url = config.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() { return Ok(()); }
            let raw = serde_json::to_vec(&body)?;
            let mut req = client.post(url).header("Content-Type", "application/json");
            if let Some(secret) = config.get("signing_secret").and_then(|v| v.as_str()) {
                let sig = hmac_sha256_hex(secret.as_bytes(), &raw);
                req = req.header("X-SolObserve-Signature", format!("sha256={sig}"));
            }
            req.body(raw).send().await?;
        }
        "email" => {
            let to = config.get("to").and_then(|v| v.as_str()).unwrap_or("");
            if to.is_empty() {
                return Ok(());
            }
            send_email_alert(config, severity, rule_name, summary, &incident_url).await?;
        }
        _ => {}
    }
    Ok(())
}

async fn process_pending_deliveries(pg: &PgPool, _cfg: &Config, metrics: &Metrics) -> Result<()> {
    let rows = sqlx::query(
        r#"
        SELECT d.id, d.incident_id_fk, d.route_id_fk, d.channel_id_fk, d.idempotency_key, d.attempts, d.status::text as status,
               i.status::text as incident_status, i.summary, i.dedup_key, r.name as rule_name, i.severity::text as severity,
               c.kind::text as channel_kind, c.config_encrypted
        FROM alert_notification_deliveries d
        JOIN alert_incidents i ON i.id = d.incident_id_fk
        JOIN alert_rules r ON r.id = i.rule_id_fk
        LEFT JOIN notification_channels c ON c.id = d.channel_id_fk
        WHERE d.status = 'pending'::alert_delivery_status
          AND d.next_attempt_at <= NOW()
        ORDER BY d.created_at ASC
        LIMIT 200
        "#,
    )
    .fetch_all(pg)
    .await?;
    for row in rows {
        let id = row.try_get::<uuid::Uuid, _>("id")?;
        let incident_id = row.try_get::<uuid::Uuid, _>("incident_id_fk")?;
        let incident_status = row.try_get::<String, _>("incident_status")?;
        if incident_status == "acknowledged" || incident_status == "resolved" || incident_status == "silenced" {
            sqlx::query("UPDATE alert_notification_deliveries SET status='failed', last_error='incident closed' WHERE id=$1::uuid")
                .bind(id)
                .execute(pg)
                .await?;
            continue;
        }
        let channel_id = row.try_get::<Option<uuid::Uuid>, _>("channel_id_fk")?;
        let mut cfg_json = Value::Null;
        if channel_id.is_some() {
            let enc = row.try_get::<Option<Vec<u8>>, _>("config_encrypted")?.unwrap_or_default();
            cfg_json = decrypt_channel_config(&enc).unwrap_or(Value::Null);
        } else if let Some(v) = sqlx::query_scalar::<_, Value>(
            "SELECT payload->'config' FROM alert_incident_events WHERE incident_id_fk = $1::uuid AND kind='notified'::alert_incident_event_kind ORDER BY occurred_at DESC LIMIT 1",
        )
        .bind(incident_id)
        .fetch_optional(pg)
        .await?
        {
            cfg_json = v;
        }
        if cfg_json.is_null() {
            sqlx::query("UPDATE alert_notification_deliveries SET status='failed', attempts=attempts+1, last_error='missing channel config' WHERE id=$1::uuid")
                .bind(id)
                .execute(pg)
                .await?;
            continue;
        }
        let started = std::time::Instant::now();
        let kind = row.try_get::<String, _>("channel_kind")?;
        let dedup_key = row.try_get::<String, _>("dedup_key")?;
        let rule_name = row.try_get::<String, _>("rule_name")?;
        let severity = row.try_get::<String, _>("severity")?;
        let summary = row.try_get::<String, _>("summary")?;
        let send = send_channel_notification(
            &kind,
            &cfg_json,
            incident_id,
            &dedup_key,
            &rule_name,
            &severity,
            &summary,
        )
        .await;
        metrics.notify_latency_ms.with_label_values(&[&kind]).observe(started.elapsed().as_millis() as f64);
        match send {
            Ok(_) => {
                sqlx::query("UPDATE alert_notification_deliveries SET status='sent', attempts=attempts+1, last_error=NULL WHERE id=$1::uuid")
                    .bind(id)
                    .execute(pg)
                    .await?;
            }
            Err(e) => {
                let attempts = row.try_get::<i32, _>("attempts").unwrap_or(0) + 1;
                if attempts >= 5 {
                    sqlx::query("UPDATE alert_notification_deliveries SET status='failed', attempts=$2, last_error=$3 WHERE id=$1::uuid")
                        .bind(id)
                        .bind(attempts)
                        .bind(e.to_string())
                        .execute(pg)
                        .await?;
                } else {
                    let secs = match attempts {
                        1 => 1,
                        2 => 4,
                        3 => 16,
                        4 => 64,
                        _ => 256,
                    };
                    sqlx::query("UPDATE alert_notification_deliveries SET status='pending', attempts=$2, last_error=$3, next_attempt_at=NOW() + ($4 || ' seconds')::interval WHERE id=$1::uuid")
                        .bind(id)
                        .bind(attempts)
                        .bind(e.to_string())
                        .bind(secs)
                        .execute(pg)
                        .await?;
                }
                metrics.notify_failed_total.with_label_values(&[&kind, "send_error"]).inc();
            }
        }
    }
    Ok(())
}

async fn process_escalations(pg: &PgPool) -> Result<()> {
    let incidents = sqlx::query(
        r#"
        SELECT i.id, i.started_at, i.rule_id_fk, i.status::text as status, p.org_id
        FROM alert_incidents i
        JOIN alert_rules r ON r.id = i.rule_id_fk
        JOIN programs pr ON pr.id = r.program_id_fk
        JOIN projects p ON p.id = pr.project_id
        WHERE i.status = 'firing'::alert_incident_status
        "#,
    )
    .fetch_all(pg)
    .await?;
    for inc in incidents {
        let incident_id = inc.try_get::<uuid::Uuid, _>("id")?;
        let started_at = inc.try_get::<DateTime<Utc>, _>("started_at")?;
        let org_id = inc.try_get::<uuid::Uuid, _>("org_id")?;
        let routes = sqlx::query(
            "SELECT id, matchers FROM notification_routes WHERE org_id_fk = $1::uuid ORDER BY id ASC",
        )
        .bind(org_id)
        .fetch_all(pg)
        .await?;
        for route in routes {
            let route_id = route.try_get::<uuid::Uuid, _>("id")?;
            let matchers: Value = route.try_get("matchers").unwrap_or(json!({}));
            let policy_id = matchers
                .get("escalation_policy_id")
                .and_then(|v| v.as_str())
                .and_then(|s| uuid::Uuid::parse_str(s).ok());
            let Some(policy_id) = policy_id else {
                continue;
            };
            let steps: Value = sqlx::query_scalar(
                "SELECT steps FROM escalation_policies WHERE id = $1::uuid LIMIT 1",
            )
            .bind(policy_id)
            .fetch_optional(pg)
            .await?
            .unwrap_or(json!([]));
            let Some(step_arr) = steps.as_array() else {
                continue;
            };
            for (idx, step) in step_arr.iter().enumerate() {
                let wait_seconds = step.get("wait_seconds").and_then(|v| v.as_i64()).unwrap_or(0);
                if Utc::now().signed_duration_since(started_at).num_seconds() < wait_seconds {
                    continue;
                }
                let channels = step
                    .get("channel_ids")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|v| v.as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()))
                    .collect::<Vec<_>>();
                for ch in channels {
                    let idem = delivery_key(incident_id, ch, idx as i64);
                    sqlx::query(
                        r#"
                        INSERT INTO alert_notification_deliveries(incident_id_fk, route_id_fk, channel_id_fk, idempotency_key, status, attempts, next_attempt_at)
                        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pending'::alert_delivery_status, 0, NOW())
                        ON CONFLICT (idempotency_key) DO NOTHING
                        "#,
                    )
                    .bind(incident_id)
                    .bind(route_id)
                    .bind(ch)
                    .bind(idem)
                    .execute(pg)
                    .await?;
                }
            }
        }
    }
    Ok(())
}

fn select_route<'a>(
    routes: &'a [sqlx::postgres::PgRow],
    severity: &str,
    labels: &BTreeMap<String, String>,
    force_route: Option<uuid::Uuid>,
) -> Result<Option<&'a sqlx::postgres::PgRow>> {
    if let Some(force_id) = force_route {
        for r in routes {
            if r.try_get::<uuid::Uuid, _>("id").ok() == Some(force_id) {
                return Ok(Some(r));
            }
        }
        return Ok(None);
    }
    for r in routes {
        let sev_min = r.try_get::<String, _>("severity_min").unwrap_or_else(|_| "warn".to_string());
        if severity_rank(severity) < severity_rank(&sev_min) {
            continue;
        }
        let m: Value = r.try_get("matchers").unwrap_or(json!({}));
        if match_route_matchers(&m, labels) {
            return Ok(Some(r));
        }
    }
    Ok(routes.first())
}

fn match_route_matchers(m: &Value, labels: &BTreeMap<String, String>) -> bool {
    let Some(obj) = m.as_object() else { return true; };
    for (k, v) in obj {
        let expected = v.as_str().unwrap_or_default();
        let actual = labels.get(k).map(|s| s.as_str()).unwrap_or_default();
        if expected != actual {
            return false;
        }
    }
    true
}

async fn is_silenced(pg: &PgPool, rule_id: uuid::Uuid, labels: &BTreeMap<String, String>) -> Result<bool> {
    let rows = sqlx::query(
        r#"
        SELECT s.matcher
        FROM alert_silences s
        JOIN alert_rules r ON r.program_id_fk = s.program_id_fk
        WHERE r.id = $1::uuid
          AND s.starts_at <= NOW()
          AND s.ends_at >= NOW()
        "#,
    )
    .bind(rule_id)
    .fetch_all(pg)
    .await?;
    for row in rows {
        let matcher: Value = row.try_get("matcher").unwrap_or(json!({}));
        if match_route_matchers(&matcher, labels) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn delivery_key(incident_id: uuid::Uuid, channel_id: uuid::Uuid, group_window: i64) -> String {
    let mut h = Sha256::new();
    h.update(format!("{incident_id}:{channel_id}:{group_window}"));
    hex::encode(h.finalize())
}

fn severity_rank(s: &str) -> i32 {
    match s {
        "critical" => 3,
        "warn" => 2,
        "info" => 1,
        _ => 0,
    }
}

fn severity_color_hex(s: &str) -> &'static str {
    match s {
        "critical" => "#E53E3E",
        "warn" => "#DD6B20",
        _ => "#2F855A",
    }
}

fn severity_color_int(s: &str) -> i32 {
    match s {
        "critical" => 0xE53E3E,
        "warn" => 0xDD6B20,
        _ => 0x2F855A,
    }
}

fn severity_pd(s: &str) -> &'static str {
    match s {
        "critical" => "critical",
        "warn" => "warning",
        _ => "info",
    }
}

fn telegram_escape_markdown(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if "_*[]()~`>#+-=|{}.!".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn hmac_sha256_hex(secret: &[u8], body: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac key");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

async fn send_email_alert(config: &Value, severity: &str, rule_name: &str, summary: &str, incident_url: &str) -> Result<()> {
    let to = config.get("to").and_then(|v| v.as_str()).unwrap_or("");
    if to.is_empty() {
        return Ok(());
    }
    let smtp_host = std::env::var("SMTP_HOST").unwrap_or_default();
    if smtp_host.is_empty() {
        return Ok(());
    }
    let smtp_port = std::env::var("SMTP_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(587);
    let smtp_user = std::env::var("SMTP_USER").unwrap_or_default();
    let smtp_password = std::env::var("SMTP_PASSWORD").unwrap_or_default();
    let from = std::env::var("SMTP_FROM").unwrap_or_else(|_| "alerts@solobserve.local".to_string());
    let subject_prefix = config
        .get("subject_prefix")
        .and_then(|v| v.as_str())
        .unwrap_or("[SolObserve]");
    let html = format!(
        "<h2>{subject_prefix} [{severity}] {rule_name}</h2><p>{summary}</p><p><a href=\"{incident_url}\">Open incident</a></p>"
    );
    let email = Message::builder()
        .from(from.parse::<Mailbox>()?)
        .to(to.parse::<Mailbox>()?)
        .subject(format!("{subject_prefix} [{severity}] {rule_name}"))
        .header(ContentType::TEXT_HTML)
        .body(html)?;
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp_host)?
        .port(smtp_port)
        .credentials(Credentials::new(smtp_user, smtp_password))
        .build();
    mailer.send(email).await?;
    Ok(())
}

fn json_number_at(v: &Value, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(n) = v
            .get(*k)
            .and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse::<f64>().ok())))
        {
            return n;
        }
    }
    0.0
}

async fn resolve_oncall_email(pg: &PgPool, schedule_id: uuid::Uuid) -> Result<Option<String>> {
    let override_row = sqlx::query(
        r#"
        SELECT u.email
        FROM oncall_shifts s
        JOIN users u ON u.id = s.user_id
        WHERE s.schedule_id_fk = $1::uuid
          AND s.starts_at <= NOW()
          AND s.ends_at > NOW()
          AND s.override = TRUE
        ORDER BY s.starts_at DESC
        LIMIT 1
        "#,
    )
    .bind(schedule_id)
    .fetch_optional(pg)
    .await?;
    if let Some(r) = override_row {
        return Ok(r.try_get::<String, _>("email").ok());
    }
    let normal = sqlx::query(
        r#"
        SELECT u.email
        FROM oncall_shifts s
        JOIN users u ON u.id = s.user_id
        WHERE s.schedule_id_fk = $1::uuid
          AND s.starts_at <= NOW()
          AND s.ends_at > NOW()
        ORDER BY s.starts_at DESC
        LIMIT 1
        "#,
    )
    .bind(schedule_id)
    .fetch_optional(pg)
    .await?;
    Ok(normal.and_then(|r| r.try_get::<String, _>("email").ok()))
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
