use std::env;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required env var: {0}")]
    MissingVar(&'static str),
    #[error("invalid value for {0}: {1}")]
    InvalidValue(&'static str, String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostgresConfig {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClickhouseConfig {
    pub url: String,
    pub user: String,
    pub password: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NatsConfig {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    pub bucket: String,
    pub force_path_style: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SolanaRpcConfig {
    pub mainnet_rpc: Vec<String>,
    pub mainnet_ws: Vec<String>,
    pub devnet_rpc: Vec<String>,
    pub devnet_ws: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub postgres: PostgresConfig,
    pub clickhouse: ClickhouseConfig,
    pub nats: NatsConfig,
    pub s3: S3Config,
    pub solana_rpc: SolanaRpcConfig,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let _ = dotenvy::dotenv();

        Ok(Self {
            postgres: PostgresConfig {
                url: req("POSTGRES_URL")?,
            },
            clickhouse: ClickhouseConfig {
                url: req("CLICKHOUSE_URL")?,
                user: opt("CLICKHOUSE_USER", "default"),
                password: opt("CLICKHOUSE_PASSWORD", ""),
                database: opt("CLICKHOUSE_DB", "solobserve"),
            },
            nats: NatsConfig {
                url: req("NATS_URL")?,
            },
            s3: S3Config {
                endpoint: req("S3_ENDPOINT")?,
                region: opt("S3_REGION", "us-east-1"),
                access_key: req("S3_ACCESS_KEY")?,
                secret_key: req("S3_SECRET_KEY")?,
                bucket: opt("S3_BUCKET", "solobserve-raw"),
                force_path_style: bool_var("S3_FORCE_PATH_STYLE", true)?,
            },
            solana_rpc: SolanaRpcConfig {
                mainnet_rpc: list("SOLANA_MAINNET_RPC"),
                mainnet_ws: list("SOLANA_MAINNET_WS"),
                devnet_rpc: list("SOLANA_DEVNET_RPC"),
                devnet_ws: list("SOLANA_DEVNET_WS"),
            },
        })
    }
}

fn req(key: &'static str) -> Result<String, ConfigError> {
    env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or(ConfigError::MissingVar(key))
}

fn opt(key: &str, default: &str) -> String {
    env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn list(key: &str) -> Vec<String> {
    env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn bool_var(key: &'static str, default: bool) -> Result<bool, ConfigError> {
    match env::var(key) {
        Ok(v) if v.is_empty() => Ok(default),
        Ok(v) => match v.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(ConfigError::InvalidValue(key, v)),
        },
        Err(_) => Ok(default),
    }
}
