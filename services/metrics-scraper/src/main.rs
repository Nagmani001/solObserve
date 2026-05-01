use anyhow::Result;
use chrono::Utc;
use clickhouse::Row;
use prometheus_parse::Scrape;
use solobserve_config::Config;
use solobserve_storage::{clickhouse_client, run_clickhouse_migrations};
use std::time::Duration;
use tracing::info;

#[derive(Row, serde::Serialize)]
struct PlatformMetricRow {
    cluster: String,
    source: String,
    metric_name: String,
    value: f64,
    labels_json: String,
    ts: u32,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let ch = clickhouse_client(&cfg);
    run_clickhouse_migrations(&ch).await?;

    let ingestor_url = std::env::var("INGESTOR_METRICS_URL")
        .unwrap_or_else(|_| "http://ingestor:9100/metrics".to_string());
    let decoder_url = std::env::var("DECODER_METRICS_URL")
        .unwrap_or_else(|_| "http://decoder:9191/metrics".to_string());

    loop {
        scrape_one(&ch, "ingestor", &ingestor_url).await.ok();
        scrape_one(&ch, "decoder", &decoder_url).await.ok();
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

async fn scrape_one(ch: &clickhouse::Client, source: &str, url: &str) -> Result<()> {
    let body = reqwest::get(url).await?.text().await?;
    let lines = body.lines().map(|l| Ok(l.to_string()));
    let scrape = Scrape::parse(lines)?;
    let observed = Utc::now().timestamp() as u32;

    let mut insert = ch.insert("platform_metrics")?;
    let mut rows = 0usize;
    for sample in scrape.samples {
        let value = match sample.value {
            prometheus_parse::Value::Counter(v) => v,
            prometheus_parse::Value::Gauge(v) => v,
            _ => continue,
        };
        let labels = format!("{}", sample.labels);
        insert
            .write(&PlatformMetricRow {
                cluster: std::env::var("SOLANA_CLUSTER").unwrap_or_else(|_| "mainnet".to_string()),
                source: source.to_string(),
                metric_name: sample.metric.to_string(),
                value,
                labels_json: labels,
                ts: observed,
            })
            .await?;
        rows += 1;
    }
    insert.end().await?;
    info!(source, rows, "platform metrics scraped");
    Ok(())
}
