//! Built with `wasm-pack ... --features wasm`.

use serde_wasm_bindgen::to_value;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = parseIdl)]
pub fn parse_idl_wasm(js: &str) -> Result<JsValue, JsValue> {
    crate::parse_idl_str(js)
        .map_err(|e| JsValue::from_str(&format!("IDL parse: {e}")))
        .and_then(|v| to_value(&v).map_err(|e| JsValue::from_str(&format!("IDL encode: {e}"))))
}
