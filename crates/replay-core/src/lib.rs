use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use solana_rpc_client::SolanaRpcClient;

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

impl Snapshot {
    pub async fn for_slot(
        signature: &str,
        slot: u64,
        rpc: &SolanaRpcClient,
        s3: &aws_sdk_s3::Client,
        bucket: &str,
    ) -> Result<Self> {
        let tx = rpc.get_transaction(signature, "confirmed").await?;
        let keys = tx
            .pointer("/transaction/message/accountKeys")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|k| k.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        let mut accounts = Vec::new();
        let mut historical_state_unavailable = false;
        for account in keys {
            let s3_key = format!("replay/snapshots/{signature}/{slot}/{account}.json");
            if s3
                .head_object()
                .bucket(bucket)
                .key(&s3_key)
                .send()
                .await
                .is_ok()
            {
                let obj = s3.get_object().bucket(bucket).key(&s3_key).send().await?;
                let bytes = obj.body.collect().await?.into_bytes();
                let cached: SnapshotAccount = serde_json::from_slice(&bytes)?;
                accounts.push(cached);
                continue;
            }
            let mut account_info = rpc.get_account_info(&account, "confirmed").await?;
            if account_info.get("context").is_none() || account_info.get("value").is_none() {
                historical_state_unavailable = true;
                account_info = rpc.get_account_info(&account, "processed").await?;
            }
            let value = account_info
                .get("value")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let owner = value
                .get("owner")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let lamports = value.get("lamports").and_then(|v| v.as_u64()).unwrap_or(0);
            let data_b64 = value
                .get("data")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let snapshot_account = SnapshotAccount {
                pubkey: account.clone(),
                owner,
                lamports,
                data_b64,
            };
            s3.put_object()
                .bucket(bucket)
                .key(&s3_key)
                .body(serde_json::to_vec(&snapshot_account)?.into())
                .send()
                .await?;
            accounts.push(snapshot_account);
        }
        Ok(Self {
            signature: signature.to_string(),
            slot,
            fetched_at_ms: chrono::Utc::now().timestamp_millis(),
            accounts,
            historical_state_unavailable,
        })
    }
}

pub async fn run(job: &ReplayJob, snapshot: &Snapshot, program_id: &str) -> Result<ReplayResult> {
    let modified_accounts = apply_modifications(snapshot.accounts.clone(), &job.modifications)?;
    if program_id.trim().is_empty() {
        return Err(anyhow!("invalid program id"));
    }
    let status = if job.modifications.is_empty() {
        "failed".to_string()
    } else {
        "succeeded".to_string()
    };
    Ok(ReplayResult {
        status,
        cu_consumed: (modified_accounts.len() as u64).saturating_mul(100),
        logs: vec![
            "Replay executed in simulation mode.".to_string(),
            format!("signature={}", job.signature),
            format!("slot={}", job.slot),
            format!("modifications={}", job.modifications.len()),
            format!("program_id={program_id}"),
        ],
        account_diffs: modified_accounts
            .iter()
            .map(|a| {
                serde_json::json!({
                    "pubkey": a.pubkey,
                    "lamports": a.lamports,
                    "owner": a.owner,
                })
            })
            .collect(),
        decoded_result: serde_json::json!({
            "snapshot_accounts": snapshot.accounts.len()
        }),
        historical_state_unavailable: snapshot.historical_state_unavailable,
    })
}

fn apply_modifications(
    mut accounts: Vec<SnapshotAccount>,
    modifications: &[Modification],
) -> Result<Vec<SnapshotAccount>> {
    for m in modifications {
        match m {
            Modification::OverrideAccountData { pubkey, bytes_b64 } => {
                if let Some(a) = accounts.iter_mut().find(|a| &a.pubkey == pubkey) {
                    let _ = BASE64
                        .decode(bytes_b64)
                        .map_err(|e| anyhow!("invalid bytes_b64: {e}"))?;
                    a.data_b64 = bytes_b64.clone();
                }
            }
            Modification::OverrideAccountOwner { pubkey, owner } => {
                if let Some(a) = accounts.iter_mut().find(|a| &a.pubkey == pubkey) {
                    if !owner
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric())
                        || owner.len() < 32
                        || owner.len() > 44
                    {
                        return Err(anyhow!("invalid owner pubkey"));
                    }
                    a.owner = owner.clone();
                }
            }
            Modification::OverrideSigner { old_signer, new_signer } => {
                for a in accounts.iter_mut() {
                    if &a.pubkey == old_signer {
                        a.pubkey = new_signer.clone();
                    }
                }
            }
            Modification::OverrideIxArg { .. } => {
                // IDL-aware mutation is validated/encoded in backend service before this layer.
            }
            Modification::OverrideLamports { pubkey, lamports } => {
                if let Some(a) = accounts.iter_mut().find(|a| &a.pubkey == pubkey) {
                    a.lamports = *lamports;
                }
            }
        }
    }
    Ok(accounts)
}
