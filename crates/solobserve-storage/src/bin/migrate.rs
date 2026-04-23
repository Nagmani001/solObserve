use anyhow::{Context, Result};
use solobserve_storage::run_pg_migrations;
use sqlx::postgres::PgPoolOptions;
use std::env;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    let url = env::var("DATABASE_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| env::var("POSTGRES_URL").ok().filter(|u| !u.is_empty()))
        .context("set DATABASE_URL or POSTGRES_URL")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .context("connect postgres")?;
    run_pg_migrations(&pool).await?;
    Ok(())
}
