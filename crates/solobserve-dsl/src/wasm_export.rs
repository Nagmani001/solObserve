#![cfg(feature = "wasm")]

use crate::{compile, parse, CompileCtx};
use serde_wasm_bindgen::{from_value, to_value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = parse)]
pub fn parse_wasm(dsl: &str) -> Result<JsValue, JsValue> {
    parse(dsl)
        .map_err(|e| JsValue::from_str(&format!("DSL parse: {e}")))
        .and_then(|v| to_value(&v).map_err(|e| JsValue::from_str(&format!("DSL encode: {e}"))))
}

#[wasm_bindgen(js_name = compile)]
pub fn compile_wasm(dsl: &str, ctx: JsValue) -> Result<JsValue, JsValue> {
    let parsed_ctx: CompileCtx =
        from_value(ctx).map_err(|e| JsValue::from_str(&format!("DSL ctx decode: {e}")))?;
    compile(dsl, &parsed_ctx)
        .map_err(|e| JsValue::from_str(&format!("DSL compile: {e}")))
        .and_then(|v| to_value(&v).map_err(|e| JsValue::from_str(&format!("DSL encode: {e}"))))
}
