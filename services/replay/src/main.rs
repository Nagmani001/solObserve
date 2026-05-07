use axum::{extract::State, response::IntoResponse, routing::get, routing::post, Json, Router};
use replay_core::{run, Modification, ReplayJob, Snapshot};
use serde::{Deserialize, Serialize};
use solana_rpc_client::{RpcEndpoint, SolanaRpcClient};
use solobserve_config::Config;
use solobserve_storage::s3_client;
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::Semaphore;

#[derive(Clone)]
struct AppState {
    max_parallel_jobs: usize,
    semaphore: Arc<Semaphore>,
    rpc: Arc<SolanaRpcClient>,
    s3: aws_sdk_s3::Client,
    bucket: String,
}

#[derive(Debug, Deserialize)]
struct ReplayRequest {
    program_id: String,
    cluster: Option<String>,
    signature: String,
    slot: Option<u64>,
    modifications: Option<Vec<Modification>>,
}

#[derive(Debug, Serialize)]
struct ReplayResponse {
    status: String,
    cu_consumed: u64,
    logs: Vec<String>,
    historical_state_unavailable: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let cfg = Config::from_env().map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let max_parallel_jobs = std::env::var("REPLAY_MAX_PARALLEL")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(4);
    let primary = cfg
        .solana_rpc
        .devnet_rpc
        .first()
        .cloned()
        .or_else(|| cfg.solana_rpc.mainnet_rpc.first().cloned())
        .unwrap_or_else(|| "https://api.devnet.solana.com".to_string());
    let rpc = SolanaRpcClient::new(vec![RpcEndpoint {
        http_url: primary,
        rate_limit_rps: 10,
    }])?;
    let state = Arc::new(AppState {
        max_parallel_jobs,
        semaphore: Arc::new(Semaphore::new(max_parallel_jobs)),
        rpc: Arc::new(rpc),
        s3: s3_client(&cfg).await,
        bucket: cfg.s3.bucket.clone(),
    });

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/replay", post(replay))
        .with_state(state);

    let port = std::env::var("REPLAY_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(9292);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%port, "replay service listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "max_parallel_jobs": state.max_parallel_jobs,
    }))
}

async fn replay(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReplayRequest>,
) -> impl IntoResponse {
    let _permit = match state.semaphore.clone().acquire_owned().await {
        Ok(p) => p,
        Err(err) => {
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({ "error": err.to_string() })),
            )
                .into_response()
        }
    };
    let slot = req.slot.unwrap_or_default();
    let snapshot = match Snapshot::for_slot(
        &req.signature,
        slot,
        state.rpc.as_ref(),
        &state.s3,
        &state.bucket,
    )
    .await
    {
        Ok(s) => s,
        Err(err) => {
            return (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": format!("snapshot_failed: {err}") })),
            )
                .into_response()
        }
    };
    let job = ReplayJob {
        signature: req.signature.clone(),
        slot,
        modifications: req.modifications.unwrap_or_default(),
    };
    match run(&job, &snapshot, &req.program_id).await {
        Ok(result) => Json(ReplayResponse {
            status: result.status,
            cu_consumed: result.cu_consumed,
            logs: result.logs,
            historical_state_unavailable: result.historical_state_unavailable,
        })
        .into_response(),
        Err(err) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": err.to_string(),
                "cluster": req.cluster.unwrap_or_else(|| "unknown".to_string())
            })),
        )
            .into_response(),
    }
}
