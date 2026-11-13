use crate::{decode, encode, failure};
use halo_core::{core::tool_context::State, error::Error, js};
use napi::Result;
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[napi]
pub struct NativeToolDiscoveryState {
    pub(crate) inner: Arc<Mutex<State>>,
}

#[napi]
impl NativeToolDiscoveryState {
    #[napi(constructor)]
    pub fn new(payload: String) -> Result<Self> {
        let value = decode(&payload)?;
        let state = State::new(
            value["tools"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            &value["options"],
            js::number(&value["resultCharacters"]).unwrap_or(50_000.0) as usize,
            js::number(&value["recoveryTokens"]).unwrap_or(0.0),
            value["disallowed"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            value["historical"] == true,
        ).map_err(failure)?;
        Ok(Self { inner: Arc::new(Mutex::new(state)) })
    }

    #[napi(getter)]
    pub fn identity(&self) -> String { self.inner.lock().unwrap().identity().into() }

    #[napi]
    pub fn call(&self, method: String, payload: String) -> Result<String> {
        let args = decode(&payload)?;
        let mut state = self.inner.lock().unwrap();
        let value = match method.as_str() {
            "description" => json!({
                "catalog": { "eager": state.catalog.eager.iter().map(|tool| &tool["name"]).collect::<Vec<_>>(),
                    "deferred": state.catalog.deferred, "directory": state.catalog.directory, "generation": state.catalog.generation },
                "modelDefinitions": state.model_definitions,
                "discoveryEntries": state.discovery_entries,
                "searchDefinition": state.search_definition(),
            }),
            "enabled" => json!(state.enabled()),
            "needsBaseline" => json!(state.baseline_pending),
            "baselineCommitted" => { state.baseline_pending = false; Value::Null },
            "setRecoveryBudget" => { state.set_recovery_budget(js::number(&args[0]).unwrap_or(f64::NAN)); Value::Null },
            "snapshot" => state.snapshot(),
            "directoryMessage" => json!({"role":"user","content":state.catalog.directory,"isMeta":true,
                "toolContext":{"version":1,"baseline":state.snapshot(),"baselineAttachment":true}}),
            "restore" => { state.restore(&args[0]); Value::Null },
            "commit" => { state.commit(&args[0]).map_err(failure)?; Value::Null },
            "normalize" => {
                let (call, origin, error) = state.normalize(&args[0]);
                let mut value = json!({"call":call});
                if let Some(origin) = origin { value["origin"] = origin; }
                if let Some(error) = error { value["error"] = json!(error); }
                value
            },
            "search" => state.search(&args[0], args[1].as_str().unwrap_or("")),
            "catalog.search" => json!(state.catalog.search(args[0].as_str().unwrap_or(""), args[1].as_str())),
            "settle" => {
                let (result, record, replaced) = state.settle_receipt(args[0].as_str().unwrap_or(""), args[1].clone(),
                    args[2]["prefix"].as_str().unwrap_or(""), args[2]["suffix"].as_str().unwrap_or(""));
                let mut value = json!({"result":result,"replaced":replaced});
                if let Some(record) = record { value["record"] = record; }
                value
            },
            "recoveryMessage" => state.recovery_message(),
            "finalizeResults" => {
                let mut message = args[0].clone();
                let changed = state.finalize_results_receipt(&mut message).map_err(failure)?;
                json!({"message":message,"changedBlocks":changed})
            },
            "clear" => { state.clear(); Value::Null },
            "finishStep" => { state.finish_step(); Value::Null },
            "hasSearchResult" => json!(state.has_search_result(args[0].as_str().unwrap_or(""))),
            _ => return Err(failure(Error::new("UNKNOWN_OPERATION", "Unknown tool discovery operation"))),
        };
        encode(&value)
    }
}
