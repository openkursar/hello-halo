use super::{
    super::{decode, encode, failure},
    callbacks::{self, Callbacks},
};
use async_trait::async_trait;
use halo_core::{
    collaboration::store::{JournalSink, MemoryStore, ScopeStore},
    error::{Error as CoreError, Result as CoreResult},
};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use serde_json::{json, Map, Value};
use std::sync::Arc;

fn scalar_record(input: &Value) -> CoreResult<Value> {
    let mut fields = Map::new();
    for entry in input.as_array().into_iter().flatten() {
        let key = entry[0].as_str().unwrap_or("");
        let value = match entry[1].as_str() {
            Some("undefined") => json!({"__haloSdkNativeUndefined":true}),
            Some("string" | "boolean" | "null") => entry[2].clone(),
            Some("number") if entry[2].is_number() => entry[2].clone(),
            Some("number") => {
                return Err(CoreError::new(
                    "COLLABORATION_RECORD",
                    "Collaboration numbers must be finite.",
                )
                .with_details(json!({"name":"TypeError"})))
            }
            _ => {
                return Err(CoreError::new(
                    "COLLABORATION_RECORD",
                    "Collaboration records contain only scalar fields.",
                )
                .with_details(json!({"name":"TypeError"})))
            }
        };
        fields.insert(key.into(), value);
    }
    Ok(fields.into())
}
fn limit(options: &Value, field: &str, fallback: usize) -> CoreResult<usize> {
    let value = options.get(field).filter(|value| !value.is_null());
    let number = value.and_then(Value::as_f64).unwrap_or(if value.is_none() {
        fallback as f64
    } else {
        f64::NAN
    });
    if !number.is_finite()
        || number < 1.0
        || number.fract() != 0.0
        || number > 9_007_199_254_740_991.0
    {
        return Err(CoreError::new(
            "COLLABORATION_ARGUMENTS",
            format!("{field} must be a positive integer"),
        )
        .with_details(json!({"name":"TypeError"})));
    }
    Ok(number as usize)
}
struct Journal(Arc<Callbacks>);
#[async_trait]
impl JournalSink for Journal {
    async fn persist(&self, mutations: &[Value]) -> CoreResult<()> {
        self.0
            .asynchronous("persist", json!({"mutations":mutations}))
            .await
            .map(|_| ())
    }
}
#[napi]
pub struct NativeCollaborationStore {
    pub(crate) store: Arc<MemoryStore>,
    callbacks: Arc<Callbacks>,
}
#[napi]
impl NativeCollaborationStore {
    #[napi(constructor)]
    pub fn new(env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        let callbacks = Callbacks::new(env, &callback)?;
        let store = MemoryStore::new(
            options["teamId"].as_str().unwrap_or("").into(),
            options["epochId"].as_str().unwrap_or("").into(),
            limit(&options, "maxRecords", 10_000).map_err(failure)?,
            limit(&options, "maxBytes", 32 * 1024 * 1024).map_err(failure)?,
            (options["persist"] == true)
                .then(|| Arc::new(Journal(callbacks.clone())) as Arc<dyn JournalSink>),
        )
        .map_err(failure)?;
        Ok(Self {
            store: Arc::new(store),
            callbacks,
        })
    }
    #[napi]
    pub fn call(&self, name: String, payload: String) -> Result<String> {
        let input = decode(&payload)?;
        let kind = input["kind"].as_str().unwrap_or("");
        let id = input["id"].as_str().unwrap_or("");
        let value = match name.as_str() {
            "rows" => json!(self.store.rows(kind)),
            "get" => self.store.get(kind, id).unwrap_or(Value::Null),
            "findMember" => self
                .store
                .find_member(input["name"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null),
            "apply" | "record" => {
                let mutation = if kind == "remove_member" {
                    json!({"kind":kind,"id":id})
                } else {
                    json!({"kind":kind,"value":scalar_record(&input["row"]).map_err(failure)?})
                };
                self.store
                    .apply_encoded_scalars(&mutation, name != "apply")
                    .map_err(failure)?;
                Value::Null
            }
            "updateTask" => {
                let mut task = self.store.get("task", id).ok_or_else(|| {
                    failure(CoreError::new(
                        "COLLABORATION_RECORD",
                        "Unknown collaboration task",
                    ))
                })?;
                if let Some(patch) = scalar_record(&input["patch"]).map_err(failure)?.as_object() {
                    task.as_object_mut().unwrap().extend(patch.clone());
                }
                task["updatedAt"] = input["now"].clone();
                self.store
                    .apply_encoded_scalars(&json!({"kind":"task","value":task}), true)
                    .map_err(failure)?;
                Value::Null
            }
            _ => {
                return Err(failure(CoreError::new(
                    "COLLABORATION_STORE_OPERATION",
                    format!("Unknown collaboration store operation: {name}"),
                )))
            }
        };
        encode(&value)
    }
    #[napi]
    pub fn flush(&self, env: Env, callback: JsFunction) -> Result<JsObject> {
        let store = self.store.clone();
        callbacks::start(env, self.callbacks.clone(), callback, async move {
            store.flush().await?;
            Ok(Value::Null)
        })
    }
}
