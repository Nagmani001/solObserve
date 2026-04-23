use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("invalid json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid idl: {0}")]
    Invalid(String),
    #[error("expected object at root")]
    ExpectedObject,
}

pub fn require_str<'a>(v: &'a Value, path: &str) -> Result<&'a str, ParseError> {
    v.as_str()
        .ok_or_else(|| ParseError::Invalid(format!("{path}: expected string")))
}

pub fn require_array<'a>(v: &'a Value, path: &str) -> Result<&'a Vec<Value>, ParseError> {
    v.as_array()
        .ok_or_else(|| ParseError::Invalid(format!("{path}: expected array")))
}

pub fn require_object<'a>(
    v: &'a Value,
    path: &str,
) -> Result<&'a serde_json::Map<String, Value>, ParseError> {
    v.as_object()
        .ok_or_else(|| ParseError::Invalid(format!("{path}: expected object")))
}
