use anyhow::{Context, Result};
use aws_config::{BehaviorVersion, Region};
use aws_credential_types::Credentials;
use aws_sdk_s3::config::Builder as S3ConfigBuilder;
use solobserve_config::Config;
use sqlx::postgres::{PgPool, PgPoolOptions};

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
