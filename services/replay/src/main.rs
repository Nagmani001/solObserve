use axum::{extract::State, response::IntoResponse, routing::get, routing::post, Json, Router};
use chrono::Utc;
use replay_core::{run, ReplayJob, Snapshot};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};

#[derive(Clone)]
struct AppState {
    max_parallel_jobs: usize,
}

#[derive(Debug, Deserialize)]
struct ReplayRequest {
    signature: String,
    slot: Option<u64>,
    modifications: Option<Vec<serde_json::Value>>,
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
    let max_parallel_jobs = std::env::var("REPLAY_MAX_PARALLEL")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(4);
    let state = Arc::new(AppState { max_parallel_jobs });

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
    State(_state): State<Arc<AppState>>,
    Json(req): Json<ReplayRequest>,
) -> impl IntoResponse {
    let job = ReplayJob {
        signature: req.signature.clone(),
        slot: req.slot.unwrap_or_default(),
        modifications: Vec::new(),
    };
    let snapshot = Snapshot {
        signature: req.signature,
        slot: req.slot.unwrap_or_default(),
        fetched_at_ms: Utc::now().timestamp_millis(),
        accounts: Vec::new(),
        historical_state_unavailable: req
            .modifications
            .as_ref()
            .map(|m| m.len() > 10)
            .unwrap_or(false),
    };
    match run(&job, &snapshot) {
        Ok(result) => Json(ReplayResponse {
            status: result.status,
            cu_consumed: result.cu_consumed,
            logs: result.logs,
            historical_state_unavailable: result.historical_state_unavailable,
        })
        .into_response(),
        Err(err) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}
