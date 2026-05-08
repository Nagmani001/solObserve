use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use litesvm::LiteSVM;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use solana_rpc_client::SolanaRpcClient;
use solana_account::Account;
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

type Pubkey = Address;

const BPF_LOADER_UPGRADEABLE_ID: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotAccount {
    pub pubkey: String,
    pub owner: String,
    pub lamports: u64,
    pub data_b64: String,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInstruction {
    pub program_id: String,
    pub accounts: Vec<u8>,
    pub data_b58: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub signature: String,
    pub slot: u64,
    pub fetched_at_ms: i64,
    pub accounts: Vec<SnapshotAccount>,
    pub instructions: Vec<SnapshotInstruction>,
    pub account_keys: Vec<String>,
    pub program_elf_b64: String,
    pub program_id: String,
    pub historical_state_unavailable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Modification {
    OverrideAccountData { pubkey: String, bytes_b64: String },
    OverrideAccountOwner { pubkey: String, owner: String },
    OverrideSigner { old_signer: String, new_signer: String },
    OverrideIxArg { ix_index: u16, arg_name: String, value: Value },
    OverrideLamports { pubkey: String, lamports: u64 },
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
        let s3_key = format!("replay/snapshots/{signature}/{slot}/snapshot.json");
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
            return Ok(serde_json::from_slice(&bytes)?);
        }

        let tx = rpc.get_transaction(signature, "confirmed").await?;
        let account_keys: Vec<String> = tx
            .pointer("/transaction/message/accountKeys")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|k| k.as_str().map(|s| s.to_string()))
            .collect();

        let mut instructions: Vec<SnapshotInstruction> = Vec::new();
        if let Some(ixs) = tx
            .pointer("/transaction/message/instructions")
            .and_then(|v| v.as_array())
        {
            for ix in ixs {
                let program_id = ix
                    .get("programId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        ix.get("programIdIndex")
                            .and_then(|v| v.as_u64())
                            .and_then(|idx| account_keys.get(idx as usize).cloned())
                    })
                    .unwrap_or_default();
                let accounts = ix
                    .get("accounts")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|v| v.as_u64().map(|n| n as u8))
                    .collect::<Vec<_>>();
                let data_b58 = ix
                    .get("data")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                instructions.push(SnapshotInstruction {
                    program_id,
                    accounts,
                    data_b58,
                });
            }
        }

        let program_id = instructions
            .iter()
            .find(|i| !i.program_id.is_empty() && !is_native_program(&i.program_id))
            .map(|i| i.program_id.clone())
            .or_else(|| account_keys.first().cloned())
            .ok_or_else(|| anyhow!("no candidate program id in transaction"))?;

        let mut accounts: Vec<SnapshotAccount> = Vec::new();
        let mut historical_state_unavailable = false;
        for account in &account_keys {
            match fetch_account_snapshot(rpc, account).await {
                Ok((snap, missing)) => {
                    if missing {
                        historical_state_unavailable = true;
                    }
                    accounts.push(snap);
                }
                Err(_) => {
                    historical_state_unavailable = true;
                    accounts.push(SnapshotAccount {
                        pubkey: account.clone(),
                        owner: solana_system_interface::program::ID.to_string(),
                        lamports: 0,
                        data_b64: String::new(),
                        executable: false,
                    });
                }
            }
        }

        let (program_elf_b64, elf_missing) = match fetch_program_elf(rpc, &program_id).await {
            Ok(bytes) => (BASE64.encode(bytes), false),
            Err(_) => (String::new(), true),
        };
        if elf_missing {
            historical_state_unavailable = true;
        }

        let snapshot = Self {
            signature: signature.to_string(),
            slot,
            fetched_at_ms: chrono::Utc::now().timestamp_millis(),
            accounts,
            instructions,
            account_keys,
            program_elf_b64,
            program_id,
            historical_state_unavailable,
        };

        s3.put_object()
            .bucket(bucket)
            .key(&s3_key)
            .body(serde_json::to_vec(&snapshot)?.into())
            .send()
            .await
            .ok();

        Ok(snapshot)
    }
}

async fn fetch_account_snapshot(
    rpc: &SolanaRpcClient,
    account: &str,
) -> Result<(SnapshotAccount, bool)> {
    let info = rpc.get_account_info(account, "confirmed").await?;
    let value = info.get("value").cloned().unwrap_or(Value::Null);
    if value.is_null() {
        return Ok((
            SnapshotAccount {
                pubkey: account.to_string(),
                owner: solana_system_interface::program::ID.to_string(),
                lamports: 0,
                data_b64: String::new(),
                executable: false,
            },
            true,
        ));
    }
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
    let executable = value
        .get("executable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok((
        SnapshotAccount {
            pubkey: account.to_string(),
            owner,
            lamports,
            data_b64,
            executable,
        },
        false,
    ))
}

async fn fetch_program_elf(rpc: &SolanaRpcClient, program_id: &str) -> Result<Vec<u8>> {
    let info = rpc.get_account_info(program_id, "confirmed").await?;
    let value = info
        .get("value")
        .cloned()
        .ok_or_else(|| anyhow!("missing program account"))?;
    let owner = value
        .get("owner")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let data_b64 = value
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let bytes = BASE64.decode(data_b64).context("decode program data")?;
    if owner == BPF_LOADER_UPGRADEABLE_ID {
        if bytes.len() < 36 {
            return Err(anyhow!("program account too small"));
        }
        let programdata_pubkey = bs58::encode(&bytes[4..36]).into_string();
        let data_info = rpc
            .get_account_info(&programdata_pubkey, "confirmed")
            .await?;
        let data_value = data_info
            .get("value")
            .cloned()
            .ok_or_else(|| anyhow!("missing programdata account"))?;
        let pd_b64 = data_value
            .get("data")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let pd_bytes = BASE64.decode(pd_b64).context("decode programdata")?;
        if pd_bytes.len() < 45 {
            return Err(anyhow!("programdata account too small"));
        }
        Ok(pd_bytes[45..].to_vec())
    } else {
        // BPFLoader 2 (non-upgradeable): ELF is the account data verbatim.
        Ok(bytes)
    }
}

fn is_native_program(id: &str) -> bool {
    matches!(
        id,
        "11111111111111111111111111111111"
            | "Vote111111111111111111111111111111111111111"
            | "Stake11111111111111111111111111111111111111"
            | "Config1111111111111111111111111111111111111"
            | "BPFLoader1111111111111111111111111111111111"
            | "BPFLoader2111111111111111111111111111111111"
            | "BPFLoaderUpgradeab1e11111111111111111111111"
            | "ComputeBudget111111111111111111111111111111"
            | "AddressLookupTab1e1111111111111111111111111"
    )
}

pub async fn run(
    job: &ReplayJob,
    snapshot: &Snapshot,
    program_id: &str,
) -> Result<ReplayResult> {
    if program_id.trim().is_empty() {
        return Err(anyhow!("invalid program id"));
    }
    if snapshot.program_elf_b64.is_empty() {
        return Ok(stub_result(
            job,
            snapshot,
            "snapshot_missing_elf",
            "Program ELF unavailable (free-RPC history exceeded). Replay not executed.",
        ));
    }
    let elf = BASE64
        .decode(&snapshot.program_elf_b64)
        .context("decode program elf")?;
    let modified_accounts = apply_account_modifications(snapshot.accounts.clone(), &job.modifications);

    let program_pubkey =
        Pubkey::from_str(program_id).context("parse program_id as pubkey")?;
    let mut svm = LiteSVM::new();
    svm.add_program(program_pubkey, &elf)
        .map_err(|e| anyhow!("add_program failed: {e:?}"))?;

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000)
        .map_err(|e| anyhow!("airdrop failed: {e:?}"))?;

    let signer_override = job
        .modifications
        .iter()
        .find_map(|m| match m {
            Modification::OverrideSigner {
                old_signer,
                new_signer,
            } => Some((old_signer.clone(), new_signer.clone())),
            _ => None,
        });

    let original_signer = snapshot
        .account_keys
        .first()
        .cloned()
        .unwrap_or_default();
    let effective_signer = signer_override
        .as_ref()
        .filter(|(old, _)| *old == original_signer)
        .map(|(_, new)| new.clone())
        .unwrap_or_else(|| payer.pubkey().to_string());

    let pre_state: Vec<(Pubkey, Option<Account>)> = modified_accounts
        .iter()
        .filter_map(|acc| {
            let pk = Pubkey::from_str(&acc.pubkey).ok()?;
            let data = BASE64.decode(&acc.data_b64).unwrap_or_default();
            let owner = Pubkey::from_str(&acc.owner)
                .unwrap_or(solana_system_interface::program::ID);
            let mut account = Account {
                lamports: acc.lamports,
                data,
                owner,
                executable: acc.executable,
                rent_epoch: 0,
            };
            if pk == program_pubkey {
                // Program account is added via add_program; skip set_account.
                return None;
            }
            if acc.pubkey == effective_signer {
                account.lamports = account.lamports.max(10_000_000_000);
                account.owner = solana_system_interface::program::ID;
                account.data = Vec::new();
                account.executable = false;
            }
            svm.set_account(pk, account.clone()).ok()?;
            Some((pk, Some(account)))
        })
        .collect();

    let original_blockhash = svm.latest_blockhash();
    let blockhash: Hash = original_blockhash;

    let mut log_messages: Vec<String> = Vec::new();
    let mut total_cu: u64 = 0;
    let mut last_err: Option<String> = None;

    for (ix_index, ix_snap) in snapshot.instructions.iter().enumerate() {
        if ix_snap.program_id != program_id {
            // Plan 10 v1: execute only the tracked program's top-level
            // instructions in isolation. Cross-program coordination would
            // require building a full message; documented as a known limit.
            continue;
        }
        let mut data = bs58::decode(&ix_snap.data_b58)
            .into_vec()
            .unwrap_or_default();
        apply_ix_data_overrides(ix_index as u16, &mut data, &job.modifications);
        let accounts: Vec<AccountMeta> = ix_snap
            .accounts
            .iter()
            .filter_map(|&idx| {
                let pk_str = snapshot.account_keys.get(idx as usize)?;
                let pk = Pubkey::from_str(pk_str).ok()?;
                let is_signer = pk_str == &effective_signer;
                Some(AccountMeta {
                    pubkey: pk,
                    is_signer,
                    is_writable: true,
                })
            })
            .collect();
        let ix = Instruction {
            program_id: program_pubkey,
            accounts,
            data,
        };
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            blockhash,
        );
        match svm.send_transaction(tx) {
            Ok(meta) => {
                total_cu = total_cu.saturating_add(meta.compute_units_consumed);
                log_messages.extend(meta.logs);
            }
            Err(failed) => {
                total_cu = total_cu.saturating_add(failed.meta.compute_units_consumed);
                log_messages.extend(failed.meta.logs);
                last_err = Some(format!("{:?}", failed.err));
                break;
            }
        }
    }

    let mut account_diffs = Vec::new();
    for (pk, before) in pre_state {
        let after = svm.get_account(&pk);
        let before_data_len = before.as_ref().map(|a| a.data.len()).unwrap_or(0);
        let before_lamports = before.as_ref().map(|a| a.lamports).unwrap_or(0);
        let (after_lamports, after_data_len) = match after {
            Some(a) => (a.lamports, a.data.len()),
            None => (0, 0),
        };
        if before_lamports != after_lamports || before_data_len != after_data_len {
            account_diffs.push(serde_json::json!({
                "pubkey": pk.to_string(),
                "before_lamports": before_lamports,
                "after_lamports": after_lamports,
                "before_data_len": before_data_len,
                "after_data_len": after_data_len
            }));
        }
    }

    let status = if last_err.is_some() {
        "failed".to_string()
    } else {
        "succeeded".to_string()
    };

    Ok(ReplayResult {
        status,
        cu_consumed: total_cu,
        logs: log_messages,
        account_diffs,
        decoded_result: serde_json::json!({
            "snapshot_accounts": snapshot.accounts.len(),
            "instructions_executed": snapshot
                .instructions
                .iter()
                .filter(|i| i.program_id == program_id)
                .count(),
            "error": last_err,
        }),
        historical_state_unavailable: snapshot.historical_state_unavailable,
    })
}

fn stub_result(
    job: &ReplayJob,
    snapshot: &Snapshot,
    error_key: &str,
    explanation: &str,
) -> ReplayResult {
    ReplayResult {
        status: "skipped".to_string(),
        cu_consumed: 0,
        logs: vec![explanation.to_string()],
        account_diffs: Vec::new(),
        decoded_result: serde_json::json!({
            "skipped_reason": error_key,
            "modifications": job.modifications.len(),
            "snapshot_accounts": snapshot.accounts.len(),
        }),
        historical_state_unavailable: true,
    }
}

fn apply_account_modifications(
    mut accounts: Vec<SnapshotAccount>,
    modifications: &[Modification],
) -> Vec<SnapshotAccount> {
    for m in modifications {
        match m {
            Modification::OverrideAccountData { pubkey, bytes_b64 } => {
                if let Some(a) = accounts.iter_mut().find(|a| &a.pubkey == pubkey) {
                    a.data_b64 = bytes_b64.clone();
                }
            }
            Modification::OverrideAccountOwner { pubkey, owner } => {
                if let Some(a) = accounts.iter_mut().find(|a| &a.pubkey == pubkey) {
                    a.owner = owner.clone();
                }
            }
            Modification::OverrideLamports { pubkey, lamports } => {
                if let Some(a) = accounts.iter_mut().find(|a| &a.pubkey == pubkey) {
                    a.lamports = *lamports;
                }
            }
            _ => {}
        }
    }
    accounts
}

fn apply_ix_data_overrides(
    ix_index: u16,
    data: &mut Vec<u8>,
    modifications: &[Modification],
) {
    for m in modifications {
        if let Modification::OverrideIxArg {
            ix_index: i,
            value,
            ..
        } = m
        {
            if *i != ix_index {
                continue;
            }
            // v1: support raw byte override under `value.bytes_b64`. The
            // upstream IDL-aware re-encoder is in apps/backend's
            // validateReplayModifications path; if a structured value
            // arrives here, ignore it (already validated server-side).
            if let Some(bytes_b64) = value.get("bytes_b64").and_then(|v| v.as_str()) {
                if let Ok(raw) = BASE64.decode(bytes_b64) {
                    *data = raw;
                }
            }
        }
    }
}
