use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedIdl {
    pub kind: String,
    pub program_address: String,
    pub program_name: String,
    pub instructions: Vec<NormalizedInstruction>,
    pub accounts: Vec<NormalizedAccountDef>,
    pub events: Vec<NormalizedEvent>,
    pub errors: Vec<NormalizedError>,
    pub types: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedInstruction {
    pub name: String,
    pub discriminator: String,
    pub discriminator_bytes: Vec<u8>,
    pub accounts: Value,
    pub args: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedAccountDef {
    pub name: String,
    pub discriminator: String,
    pub discriminator_bytes: Vec<u8>,
    pub definition: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedEvent {
    pub name: String,
    pub discriminator: String,
    pub discriminator_bytes: Vec<u8>,
    pub definition: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedError {
    pub code: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProgramSchema {
    pub kind: String,
    pub note: String,
}
