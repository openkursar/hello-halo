use crate::{decode, encode, failure};
use halo_core::{
    commands::{metadata, CommandRegistry},
    error::Error,
};
use napi::Result;
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::Mutex;

#[napi]
pub struct NativeCommandRegistry {
    inner: Mutex<CommandRegistry>,
}
#[napi]
impl NativeCommandRegistry {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CommandRegistry::default()),
        }
    }
    #[napi]
    pub fn call(&self, method: String, payload: String) -> Result<String> {
        let args = decode(&payload)?;
        let mut registry = self.inner.lock().unwrap();
        let value = match method.as_str() {
            "register" => registry
                .register_reference(
                    args["reference"].as_str().unwrap_or("").into(),
                    args["metadata"].clone(),
                    args.get("previous")
                        .cloned()
                        .filter(|value| !halo_core::js::is_undefined(value)),
                )
                .map_err(failure)?
                .map(|value| json!(value))
                .unwrap_or_else(halo_core::js::undefined),
            "unregister" => registry
                .unregister_reference(
                    args["name"].as_str().unwrap_or(""),
                    args.get("current")
                        .cloned()
                        .filter(|value| !halo_core::js::is_undefined(value)),
                )
                .map_err(failure)?
                .map(|value| json!(value))
                .unwrap_or_else(halo_core::js::undefined),
            "get" | "canonical" => registry
                .reference(args[0].as_str().unwrap_or(""), method == "canonical")
                .map(|value| json!(value))
                .unwrap_or_else(halo_core::js::undefined),
            "list" => json!(registry.references()),
            "size" => json!(registry.size()),
            "clear" => {
                registry.clear();
                Value::Null
            }
            _ => {
                return Err(failure(Error::new(
                    "UNKNOWN_OPERATION",
                    "Unknown command registry operation",
                )))
            }
        };
        encode(&value)
    }
}
#[napi]
pub fn command_value(method: String, payload: String) -> Result<String> {
    let args = decode(&payload)?;
    let value = match method.as_str() {
        "fields" => json!(halo_core::commands::builtins::fields(
            args[0].as_str().unwrap_or("")
        )),
        "builtin" => halo_core::commands::builtins::plan(
            args[0].as_str().unwrap_or(""),
            args[1].as_str().unwrap_or(""),
            &args[2],
            &halo_core::harness::baseline(),
        )
        .map_err(failure)?
        .ok_or_else(|| failure(Error::new("UNKNOWN_COMMAND", "Unknown built-in command")))?
        .value(),
        "isCommand" => json!(metadata::is_command(&args[0])),
        "eligible" => json!(metadata::static_invocable(&args[0])),
        "enabled" => metadata::enabled(&args[0]),
        "slash" => metadata::slash(&args[0]),
        "normalize" => json!(metadata::normalize_receipts(args.get(0))),
        _ => {
            return Err(failure(Error::new(
                "UNKNOWN_OPERATION",
                "Unknown command metadata operation",
            )))
        }
    };
    encode(&value)
}
