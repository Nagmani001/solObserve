use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotAccount {
    pub pubkey: String,
    pub owner: String,
    pub lamports: u64,
    pub data_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub signature: String,
    pub slot: u64,
    pub fetched_at_ms: i64,
    pub accounts: Vec<SnapshotAccount>,
    pub historical_state_unavailable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Modification {
    OverrideAccountData {
        pubkey: String,
        bytes_b64: String,
    },
    OverrideAccountOwner {
        pubkey: String,
        owner: String,
    },
    OverrideSigner {
        old_signer: String,
        new_signer: String,
    },
    OverrideIxArg {
        ix_index: u16,
        arg_name: String,
        value: Value,
    },
    OverrideLamports {
        pubkey: String,
        lamports: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayJob {
    pub signature: String,
    pub slot: u64,
    pub modifications: Vec<Modification>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayResult {
    pub status: String,
    pub cu_consumed: u64,
    pub logs: Vec<String>,
    pub account_diffs: Vec<Value>,
    pub decoded_result: Value,
    pub historical_state_unavailable: bool,
}

pub fn run(job: &ReplayJob, snapshot: &Snapshot) -> Result<ReplayResult> {
    let modified = job.modifications.len();
    let status = if modified > 0 { "succeeded" } else { "failed" }.to_string();
    Ok(ReplayResult {
        status,
        cu_consumed: 100_000u64.saturating_sub((modified as u64) * 123),
        logs: vec![
            "Replay started (solana-program-test adapter placeholder).".to_string(),
            format!("signature={}", job.signature),
            format!("slot={}", job.slot),
            format!("modifications={modified}"),
        ],
        account_diffs: Vec::new(),
        decoded_result: serde_json::json!({
            "snapshot_accounts": snapshot.accounts.len(),
        }),
        historical_state_unavailable: snapshot.historical_state_unavailable,
    })
}
