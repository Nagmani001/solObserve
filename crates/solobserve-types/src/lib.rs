use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawTxMsg {
    pub cluster: String,
    pub program_id: String,
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
    pub commitment: String,
    pub raw_blob_url: String,
    pub fetched_at: i64,
    #[serde(default)]
    pub rpc_source: String,
    #[serde(default)]
    pub backfill: bool,
    #[serde(default)]
    pub rollback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawAccountMsg {
    pub cluster: String,
    pub program_id: String,
    pub account: String,
    pub slot: u64,
    pub commitment: String,
    pub raw_blob_url: String,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestControlMsg {
    pub op: String,
    pub program_id_fk: String,
    pub cluster: String,
    pub hours: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_tx_msg_json_roundtrip() {
        let msg = RawTxMsg {
            cluster: "devnet".to_string(),
            program_id: "abc".to_string(),
            signature: "sig".to_string(),
            slot: 123,
            block_time: Some(10),
            commitment: "processed".to_string(),
            raw_blob_url: "s3://bucket/raw".to_string(),
            fetched_at: 999,
            rpc_source: "src".to_string(),
            backfill: false,
            rollback: false,
        };
        let enc = serde_json::to_string(&msg).expect("encode");
        let dec: RawTxMsg = serde_json::from_str(&enc).expect("decode");
        assert_eq!(dec.signature, msg.signature);
        assert_eq!(dec.slot, msg.slot);
    }
}
