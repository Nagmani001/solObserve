use anyhow::Result;
use solobserve_config::Config;
use solobserve_storage::{clickhouse_client, run_clickhouse_migrations};

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let client = clickhouse_client(&cfg);
    run_clickhouse_migrations(&client).await?;
    Ok(())
}
