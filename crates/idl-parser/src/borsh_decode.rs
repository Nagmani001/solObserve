use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug)]
pub struct DecodeCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> DecodeCursor<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.offset + n > self.bytes.len() {
            return Err("unexpected EOF".to_string());
        }
        let start = self.offset;
        self.offset += n;
        Ok(&self.bytes[start..start + n])
    }
    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn read_u16(&mut self) -> Result<u16, String> {
        let mut b = [0u8; 2];
        b.copy_from_slice(self.take(2)?);
        Ok(u16::from_le_bytes(b))
    }
    fn read_u32(&mut self) -> Result<u32, String> {
        let mut b = [0u8; 4];
        b.copy_from_slice(self.take(4)?);
        Ok(u32::from_le_bytes(b))
    }
    fn read_u64(&mut self) -> Result<u64, String> {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(b))
    }
    fn read_i64(&mut self) -> Result<i64, String> {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.take(8)?);
        Ok(i64::from_le_bytes(b))
    }
    fn read_bool(&mut self) -> Result<bool, String> {
        match self.read_u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("invalid bool".to_string()),
        }
    }
    fn read_string(&mut self) -> Result<String, String> {
        let len = self.read_u32()? as usize;
        let data = self.take(len)?;
        String::from_utf8(data.to_vec()).map_err(|e| e.to_string())
    }
}

fn types_map(types: &Value) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    for t in types.as_array().cloned().unwrap_or_default() {
        if let Some(name) = t.get("name").and_then(|x| x.as_str()) {
            out.insert(name.to_string(), t.clone());
        }
    }
    out
}

pub fn decode_instruction_args(
    parsed_idl: &Value,
    discriminator: &[u8],
    bytes: &[u8],
) -> Result<(String, Value), String> {
    let types = parsed_idl.get("types").cloned().unwrap_or(json!([]));
    let map = types_map(&types);
    let instructions = parsed_idl
        .get("instructions")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "missing instructions".to_string())?;
    for ix in instructions {
        let disc = ix
            .get("discriminatorBytes")
            .and_then(|x| x.as_array())
            .ok_or_else(|| "missing discriminatorBytes".to_string())?;
        let d: Vec<u8> = disc
            .iter()
            .filter_map(|x| x.as_u64().map(|v| v as u8))
            .collect();
        if d == discriminator {
            let name = ix
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("__unknown__")
                .to_string();
            let mut c = DecodeCursor::new(bytes);
            let mut obj = serde_json::Map::new();
            for arg in ix
                .get("args")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
            {
                let arg_name = arg
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("arg")
                    .to_string();
                let arg_ty = arg
                    .get("type")
                    .cloned()
                    .unwrap_or(Value::String("u8".to_string()));
                let v = decode_type(&arg_ty, &map, &mut c)?;
                obj.insert(arg_name, v);
            }
            return Ok((name, Value::Object(obj)));
        }
    }
    Err("unrecognized discriminator".to_string())
}

pub fn decode_event_payload(
    parsed_idl: &Value,
    discriminator: &[u8],
    bytes: &[u8],
) -> Result<(String, Value), String> {
    let types = parsed_idl.get("types").cloned().unwrap_or(json!([]));
    let map = types_map(&types);
    let events = parsed_idl
        .get("events")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "missing events".to_string())?;
    for ev in events {
        let disc = ev
            .get("discriminatorBytes")
            .and_then(|x| x.as_array())
            .ok_or_else(|| "missing discriminatorBytes".to_string())?;
        let d: Vec<u8> = disc
            .iter()
            .filter_map(|x| x.as_u64().map(|v| v as u8))
            .collect();
        if d == discriminator {
            let name = ev
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("__unknown__")
                .to_string();
            let mut c = DecodeCursor::new(bytes);
            let mut out = serde_json::Map::new();
            for f in ev
                .get("definition")
                .and_then(|x| x.get("fields"))
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
            {
                let n = f
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("field")
                    .to_string();
                let ty = f
                    .get("type")
                    .cloned()
                    .unwrap_or(Value::String("u8".to_string()));
                out.insert(n, decode_type(&ty, &map, &mut c)?);
            }
            return Ok((name, Value::Object(out)));
        }
    }
    Err("unrecognized event discriminator".to_string())
}

pub fn decode_account_payload(
    parsed_idl: &Value,
    discriminator: &[u8],
    bytes: &[u8],
) -> Result<(String, Value), String> {
    let types = parsed_idl.get("types").cloned().unwrap_or(json!([]));
    let map = types_map(&types);
    let accounts = parsed_idl
        .get("accounts")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "missing accounts".to_string())?;
    for acc in accounts {
        let disc = acc
            .get("discriminatorBytes")
            .and_then(|x| x.as_array())
            .ok_or_else(|| "missing discriminatorBytes".to_string())?;
        let d: Vec<u8> = disc
            .iter()
            .filter_map(|x| x.as_u64().map(|v| v as u8))
            .collect();
        if d == discriminator {
            let name = acc
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("__unknown__")
                .to_string();
            let mut c = DecodeCursor::new(bytes);
            let fields = acc
                .get("definition")
                .and_then(|x| x.get("type"))
                .and_then(|x| x.get("fields"))
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            let mut out = serde_json::Map::new();
            for f in fields {
                let n = f
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("field")
                    .to_string();
                let ty = f
                    .get("type")
                    .cloned()
                    .unwrap_or(Value::String("u8".to_string()));
                out.insert(n, decode_type(&ty, &map, &mut c)?);
            }
            return Ok((name, Value::Object(out)));
        }
    }
    Err("unrecognized account discriminator".to_string())
}

fn decode_type(
    ty: &Value,
    types: &HashMap<String, Value>,
    c: &mut DecodeCursor<'_>,
) -> Result<Value, String> {
    if let Some(s) = ty.as_str() {
        return decode_primitive(s, c);
    }
    if let Some(obj) = ty.as_object() {
        if let Some(v) = obj.get("vec") {
            let n = c.read_u32()? as usize;
            let mut arr = Vec::with_capacity(n);
            for _ in 0..n {
                arr.push(decode_type(v, types, c)?);
            }
            return Ok(Value::Array(arr));
        }
        if let Some(v) = obj.get("option") {
            let present = c.read_u8()?;
            if present == 0 {
                return Ok(Value::Null);
            }
            return decode_type(v, types, c);
        }
        if let Some(v) = obj.get("array").and_then(|x| x.as_array()) {
            if v.len() == 2 {
                let inner = &v[0];
                let n = v[1].as_u64().unwrap_or(0) as usize;
                let mut arr = Vec::with_capacity(n);
                for _ in 0..n {
                    arr.push(decode_type(inner, types, c)?);
                }
                return Ok(Value::Array(arr));
            }
        }
        if let Some(defined) = obj
            .get("defined")
            .and_then(|x| x.get("name"))
            .and_then(|x| x.as_str())
        {
            if let Some(t) = types.get(defined) {
                return decode_defined(t, types, c);
            }
        }
    }
    Err(format!("unsupported type shape: {ty}"))
}

fn decode_defined(
    def: &Value,
    types: &HashMap<String, Value>,
    c: &mut DecodeCursor<'_>,
) -> Result<Value, String> {
    let kind = def
        .get("type")
        .and_then(|x| x.get("kind"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    match kind {
        "struct" => {
            let mut out = serde_json::Map::new();
            for f in def
                .get("type")
                .and_then(|x| x.get("fields"))
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default()
            {
                let n = f
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("field")
                    .to_string();
                let t = f
                    .get("type")
                    .cloned()
                    .unwrap_or(Value::String("u8".to_string()));
                out.insert(n, decode_type(&t, types, c)?);
            }
            Ok(Value::Object(out))
        }
        "enum" => {
            let variant_idx = c.read_u8()? as usize;
            let variants = def
                .get("type")
                .and_then(|x| x.get("variants"))
                .and_then(|x| x.as_array())
                .ok_or_else(|| "enum variants missing".to_string())?;
            let v = variants
                .get(variant_idx)
                .ok_or_else(|| "enum variant out of bounds".to_string())?;
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("Variant")
                .to_string();
            let mut payload = Value::Null;
            if let Some(fields) = v.get("fields").and_then(|x| x.as_array()) {
                let mut out = Vec::new();
                for f in fields {
                    if let Some(obj) = f.as_object() {
                        let t = obj
                            .get("type")
                            .cloned()
                            .unwrap_or(Value::String("u8".into()));
                        out.push(decode_type(&t, types, c)?);
                    } else {
                        out.push(decode_type(f, types, c)?);
                    }
                }
                payload = Value::Array(out);
            }
            Ok(json!({ "variant": name, "value": payload }))
        }
        _ => Err(format!("unsupported defined kind: {kind}")),
    }
}

fn decode_primitive(name: &str, c: &mut DecodeCursor<'_>) -> Result<Value, String> {
    match name {
        "u8" => Ok(json!(c.read_u8()?)),
        "u16" => Ok(json!(c.read_u16()?)),
        "u32" => Ok(json!(c.read_u32()?)),
        "u64" => Ok(json!(c.read_u64()?)),
        "i64" => Ok(json!(c.read_i64()?)),
        "bool" => Ok(json!(c.read_bool()?)),
        "string" => Ok(json!(c.read_string()?)),
        "pubkey" => Ok(json!(bs58::encode(c.take(32)?).into_string())),
        _ => Err(format!("unsupported primitive: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_idl_str;

    #[test]
    fn decodes_simple_u64_arg() {
        let idl = r#"{
            "address":"A",
            "metadata":{"name":"x"},
            "instructions":[{"name":"set","accounts":[],"args":[{"name":"v","type":"u64"}]}],
            "accounts":[],"types":[],"events":[],"errors":[]
        }"#;
        let parsed = parse_idl_str(idl).expect("parse");
        let disc = crate::anchor_discriminator("global", "set");
        let mut data = Vec::new();
        data.extend_from_slice(&disc);
        data.extend_from_slice(&7u64.to_le_bytes());
        let (name, args) =
            decode_instruction_args(&parsed, &data[..8], &data[8..]).expect("decode");
        assert_eq!(name, "set");
        assert_eq!(args["v"], json!(7u64));
    }
}
