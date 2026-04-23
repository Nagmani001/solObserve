//! Anchor IDL 0.30+ parser: validate, compute discriminators, emit normalized JSON for decoder use.

mod discriminator;
mod error;
mod model;

pub use discriminator::anchor_discriminator;
pub use error::ParseError;
pub use model::{
    NormalizedAccountDef, NormalizedError, NormalizedEvent, NormalizedIdl, NormalizedInstruction,
    RawProgramSchema,
};

use error::{require_array, require_object, require_str};
use serde_json::{Map, Value};

#[cfg(test)]
use serde_json::json;

#[cfg(feature = "wasm")]
mod wasm_export;

/// Parse IDL JSON string; returns normalized JSON value for storage in `parsed_json`.
pub fn parse_idl_str(idl_json: &str) -> Result<Value, ParseError> {
    let v: Value = serde_json::from_str(idl_json)?;
    parse_idl_value(v)
}

pub fn parse_idl_value(v: Value) -> Result<Value, ParseError> {
    if let Some(true) = v
        .get("kind")
        .and_then(|k| k.as_str())
        .map(|s| s == "RawProgram")
    {
        let raw = RawProgramSchema {
            kind: "raw_program".to_string(),
            note: "placeholder for plan 4 (custom Borsh / raw decoding)".to_string(),
        };
        return Ok(serde_json::to_value(raw).expect("raw schema"));
    }

    let root = v.as_object().ok_or(ParseError::ExpectedObject)?;
    validate_anchor_root(root)?;

    let address = require_str(root.get("address").unwrap(), "address")?.to_string();
    let metadata = require_object(root.get("metadata").unwrap(), "metadata")?;
    let program_name = require_str(metadata.get("name").unwrap(), "metadata.name")?.to_string();

    let instructions_val = root.get("instructions").unwrap();
    let instructions_arr = require_array(instructions_val, "instructions")?;
    let mut instructions = Vec::with_capacity(instructions_arr.len());
    for (i, ix) in instructions_arr.iter().enumerate() {
        let obj = ix
            .as_object()
            .ok_or_else(|| ParseError::Invalid(format!("instructions[{i}]: expected object")))?;
        let name = require_str(
            obj.get("name")
                .ok_or_else(|| ParseError::Invalid(format!("instructions[{i}]: missing name")))?,
            &format!("instructions[{i}].name"),
        )?
        .to_string();
        let disc = discriminator::anchor_discriminator("global", &name);
        let accounts = obj.get("accounts").cloned().unwrap_or(Value::Array(vec![]));
        let args = obj
            .get("args")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default();
        instructions.push(NormalizedInstruction {
            name: name.clone(),
            discriminator: hex::encode(disc),
            discriminator_bytes: disc.to_vec(),
            accounts,
            args,
        });
    }

    let accounts_val = root.get("accounts").unwrap();
    let accounts_arr = require_array(accounts_val, "accounts")?;
    let mut accounts = Vec::with_capacity(accounts_arr.len());
    for (i, acc) in accounts_arr.iter().enumerate() {
        let obj = acc
            .as_object()
            .ok_or_else(|| ParseError::Invalid(format!("accounts[{i}]: expected object")))?;
        let name = require_str(
            obj.get("name")
                .ok_or_else(|| ParseError::Invalid(format!("accounts[{i}]: missing name")))?,
            &format!("accounts[{i}].name"),
        )?
        .to_string();
        let disc = discriminator::anchor_discriminator("account", &name);
        let mut definition: Map<String, Value> = Map::new();
        for (k, val) in obj.iter() {
            if k != "name" && k != "discriminator" {
                definition.insert(k.clone(), val.clone());
            }
        }
        accounts.push(NormalizedAccountDef {
            name: name.clone(),
            discriminator: hex::encode(disc),
            discriminator_bytes: disc.to_vec(),
            definition: Value::Object(definition),
        });
    }

    let events_val = root.get("events").unwrap();
    let events_arr = require_array(events_val, "events")?;
    let mut events = Vec::with_capacity(events_arr.len());
    for (i, ev) in events_arr.iter().enumerate() {
        let obj = ev
            .as_object()
            .ok_or_else(|| ParseError::Invalid(format!("events[{i}]: expected object")))?;
        let name = require_str(
            obj.get("name")
                .ok_or_else(|| ParseError::Invalid(format!("events[{i}]: missing name")))?,
            &format!("events[{i}].name"),
        )?
        .to_string();
        let disc = discriminator::anchor_discriminator("event", &name);
        let mut definition: Map<String, Value> = Map::new();
        for (k, val) in obj.iter() {
            if k != "name" && k != "discriminator" {
                definition.insert(k.clone(), val.clone());
            }
        }
        events.push(NormalizedEvent {
            name,
            discriminator: hex::encode(disc),
            discriminator_bytes: disc.to_vec(),
            definition: Value::Object(definition),
        });
    }

    let errors_val = root.get("errors").unwrap();
    let errors_arr = require_array(errors_val, "errors")?;
    let mut errors = Vec::with_capacity(errors_arr.len());
    for (i, e) in errors_arr.iter().enumerate() {
        let obj = e
            .as_object()
            .ok_or_else(|| ParseError::Invalid(format!("errors[{i}]: expected object")))?;
        let code = obj
            .get("code")
            .and_then(|c| c.as_i64())
            .ok_or_else(|| ParseError::Invalid(format!("errors[{i}]: missing numeric code")))?;
        let name = require_str(
            obj.get("name")
                .ok_or_else(|| ParseError::Invalid(format!("errors[{i}]: missing name")))?,
            &format!("errors[{i}].name"),
        )?
        .to_string();
        let msg = obj
            .get("msg")
            .and_then(|m| m.as_str())
            .map(std::string::ToString::to_string);
        errors.push(NormalizedError { code, name, msg });
    }

    let types_val = root.get("types").unwrap();
    if !types_val.is_array() {
        return Err(ParseError::Invalid("types: expected array".into()));
    }

    let normalized = NormalizedIdl {
        kind: "anchor_0_30".to_string(),
        program_address: address,
        program_name,
        instructions,
        accounts,
        events,
        errors,
        types: types_val.clone(),
    };

    serde_json::to_value(normalized).map_err(|e| ParseError::Invalid(e.to_string()))
}

fn validate_anchor_root(root: &serde_json::Map<String, Value>) -> Result<(), ParseError> {
    for key in [
        "address",
        "metadata",
        "instructions",
        "accounts",
        "types",
        "events",
        "errors",
    ] {
        if !root.contains_key(key) {
            return Err(ParseError::Invalid(format!(
                "missing required field `{key}`"
            )));
        }
    }
    require_object(root.get("metadata").unwrap(), "metadata")?;
    require_str(
        root.get("metadata").and_then(|m| m.get("name")).unwrap(),
        "metadata.name",
    )?;
    require_array(root.get("instructions").unwrap(), "instructions")?;
    require_array(root.get("accounts").unwrap(), "accounts")?;
    require_array(root.get("types").unwrap(), "types")?;
    require_array(root.get("events").unwrap(), "events")?;
    require_array(root.get("errors").unwrap(), "errors")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("read {path}"))
    }

    #[test]
    fn parses_counter_like_idl_and_matches_embedded_discriminators() {
        let s = fixture("counter.json");
        let v = parse_idl_str(&s).unwrap();
        let ix0 = &v["instructions"][0];
        assert_eq!(ix0["name"], "initialize");
        let arr: Vec<u8> = serde_json::from_value(ix0["discriminatorBytes"].clone()).unwrap();
        let want = anchor_discriminator("global", "initialize");
        assert_eq!(arr, want);
    }

    #[test]
    fn rejects_missing_field() {
        let j = json!({
            "address": "x",
            "metadata": {"name": "p"},
            "instructions": [],
            "accounts": [],
            "types": [],
            "events": [],
        });
        let err = parse_idl_value(j).unwrap_err();
        assert!(err.to_string().contains("errors"));
    }

    #[test]
    fn raw_program_placeholder() {
        let j = json!({"kind": "RawProgram"});
        let v = parse_idl_value(j).unwrap();
        assert_eq!(v["kind"], "raw_program");
    }
}
