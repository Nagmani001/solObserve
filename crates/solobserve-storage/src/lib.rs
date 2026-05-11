use anyhow::{Context, Result};
use aws_config::{BehaviorVersion, Region};
use aws_credential_types::Credentials;
use aws_sdk_s3::config::Builder as S3ConfigBuilder;
use solobserve_config::Config;
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::path::Path;

/// Apply sqlx migrations bundled with this crate (must run before Prisma app uses new tables).
pub async fn run_pg_migrations(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("postgres migrations")?;
    Ok(())
}

pub async fn pg_pool(cfg: &Config) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(10)
        .connect(&cfg.postgres.url)
        .await
        .context("connect postgres")
}

pub fn clickhouse_client(cfg: &Config) -> clickhouse::Client {
    let mut c = clickhouse::Client::default()
        .with_url(&cfg.clickhouse.url)
        .with_user(&cfg.clickhouse.user)
        .with_database(&cfg.clickhouse.database);
    if !cfg.clickhouse.password.is_empty() {
        c = c.with_password(&cfg.clickhouse.password);
    }
    c
}

/// Apply ClickHouse SQL migrations from `clickhouse-migrations/`.
pub async fn run_clickhouse_migrations(client: &clickhouse::Client) -> Result<()> {
    client
        .query(
            "CREATE TABLE IF NOT EXISTS _migrations (version String, applied_at DateTime DEFAULT now()) ENGINE=MergeTree ORDER BY (version)",
        )
        .execute()
        .await
        .context("create clickhouse _migrations table")?;

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("clickhouse-migrations");
    let mut entries: Vec<_> = std::fs::read_dir(&root)
        .context("read clickhouse migration directory")?
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("sql"))
                .unwrap_or(false)
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());

    #[derive(clickhouse::Row, serde::Deserialize)]
    struct M {
        version: String,
    }
    let applied: Vec<M> = client
        .query("SELECT version FROM _migrations")
        .fetch_all()
        .await
        .unwrap_or_default();
    let applied_set: std::collections::HashSet<String> =
        applied.into_iter().map(|m| m.version).collect();

    for e in entries {
        let version = e.file_name().to_string_lossy().to_string();
        if applied_set.contains(&version) {
            continue;
        }
        let sql = std::fs::read_to_string(e.path()).context("read clickhouse sql file")?;
        let stripped: String = sql
            .lines()
            .map(|l| {
                if let Some(idx) = l.find("--") {
                    &l[..idx]
                } else {
                    l
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        for stmt in stripped
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            client
                .query(stmt)
                .execute()
                .await
                .with_context(|| format!("apply clickhouse migration statement in {}", version))?;
        }
        client
            .query("INSERT INTO _migrations (version) VALUES (?)")
            .bind(version)
            .execute()
            .await
            .context("record clickhouse migration version")?;
    }
    Ok(())
}

pub async fn s3_client(cfg: &Config) -> aws_sdk_s3::Client {
    let creds = Credentials::new(
        &cfg.s3.access_key,
        &cfg.s3.secret_key,
        None,
        None,
        "solobserve-static",
    );
    let shared = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(cfg.s3.region.clone()))
        .credentials_provider(creds)
        .load()
        .await;
    let s3 = S3ConfigBuilder::from(&shared)
        .endpoint_url(cfg.s3.endpoint.clone())
        .force_path_style(cfg.s3.force_path_style)
        .build();
    aws_sdk_s3::Client::from_conf(s3)
}

pub async fn nats_jetstream(cfg: &Config) -> Result<async_nats::jetstream::Context> {
    let client = async_nats::connect(&cfg.nats.url)
        .await
        .context("connect nats")?;
    Ok(async_nats::jetstream::new(client))
}
