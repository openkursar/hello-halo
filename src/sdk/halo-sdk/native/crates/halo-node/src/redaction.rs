use halo_core::{
    js::{value::JsValue, wire::WireDocument},
    redaction,
};
use napi::{Error, Result, Status};
use napi_derive::napi;

fn invalid(message: impl ToString) -> Error {
    Error::new(Status::InvalidArg, message.to_string())
}

#[napi]
pub fn redaction_value(method: String, payload: String) -> Result<String> {
    let input = WireDocument::from_json_str(&payload)
        .map_err(invalid)?
        .decode()
        .map_err(invalid)?;
    let output = match method.as_str() {
        "headers" => JsValue::Object(redaction::redact_headers(
            input
                .as_object()
                .ok_or_else(|| invalid("Header references must be an object"))?,
        )),
        "secrets" => JsValue::String(redaction::redact_secrets(
            input
                .as_text()
                .ok_or_else(|| invalid("Redaction input must be a string"))?,
        )),
        "truncate" => {
            let args = input
                .as_array()
                .filter(|args| args.len() == 2)
                .ok_or_else(|| invalid("Truncation requires a value and a length"))?;
            let text = args[0]
                .as_text()
                .ok_or_else(|| invalid("Truncation input must be a string"))?;
            let length = args[1]
                .as_number()
                .ok_or_else(|| invalid("Truncation length must be a number"))?;
            JsValue::String(redaction::truncate_field(text, length))
        }
        _ => return Err(invalid("Unknown redaction operation")),
    };
    Ok(WireDocument::encode(&output).to_json_string())
}
