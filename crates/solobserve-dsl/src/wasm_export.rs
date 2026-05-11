#![cfg(feature = "wasm")]

use crate::{compile, parse, CompileCtx};
use serde::Serialize;
use serde_wasm_bindgen::{from_value, Serializer};
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsValue> {
    let s = Serializer::new().serialize_maps_as_objects(true);
    v.serialize(&s)
        .map_err(|e| JsValue::from_str(&format!("DSL encode: {e}")))
}

#[wasm_bindgen(js_name = parse)]
pub fn parse_wasm(dsl: &str) -> Result<JsValue, JsValue> {
    parse(dsl)
        .map_err(|e| JsValue::from_str(&format!("DSL parse: {e}")))
        .and_then(|v| to_js(&v))
}

#[wasm_bindgen(js_name = compile)]
pub fn compile_wasm(dsl: &str, ctx: JsValue) -> Result<JsValue, JsValue> {
    let parsed_ctx: CompileCtx =
        from_value(ctx).map_err(|e| JsValue::from_str(&format!("DSL ctx decode: {e}")))?;
    compile(dsl, &parsed_ctx)
        .map_err(|e| JsValue::from_str(&format!("DSL compile: {e}")))
        .and_then(|v| to_js(&v))
}
