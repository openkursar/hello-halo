use super::{
    super::{decode, encode, failure},
    callbacks::Callbacks,
};
use halo_core::{
    collaboration::board_writes::{BlackboardStore, BlackboardWriter, BoardObserver},
    error::{Error as CoreError, Result as CoreResult},
};
use napi::{Env, JsFunction, Result};
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::Arc;

struct Store(Arc<Callbacks>);
impl BlackboardStore for Store {
    fn insert_task(&self, task: Value) -> CoreResult<()> {
        self.0.sync("insertTask", json!({"task":task})).map(|_| ())
    }
    fn get_task(&self, id: &str) -> Option<Value> {
        self.try_get_task(id).ok().flatten()
    }
    fn try_get_task(&self, id: &str) -> CoreResult<Option<Value>> {
        let task = self.0.sync("getTaskById", json!({"id":id}))?;
        Ok((!task.is_null()).then_some(task))
    }
    fn update_task(&self, id: &str, patch: Value, now: Value) -> CoreResult<()> {
        self.0
            .sync("updateTask", json!({"id":id,"patch":patch,"now":now}))
            .map(|_| ())
    }
    fn insert_finding(&self, finding: Value) -> CoreResult<()> {
        self.0
            .sync("insertFinding", json!({"finding":finding}))
            .map(|_| ())
    }
    fn insert_activity(&self, activity: Value) -> CoreResult<()> {
        self.0
            .sync("insertActivity", json!({"activity":activity}))
            .map(|_| ())
    }
}
#[napi]
pub struct NativeBlackboardWriter {
    writer: BlackboardWriter,
    callbacks: Arc<Callbacks>,
}
#[napi]
impl NativeBlackboardWriter {
    #[napi(constructor)]
    pub fn new(env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        let callbacks = Callbacks::new(env, &callback)?;
        let observer = |name: &'static str| -> Option<BoardObserver> {
            if options[name] != true {
                return None;
            }
            let callbacks = callbacks.clone();
            Some(Arc::new(move |input| {
                callbacks.sync(name, json!({"value":input})).map(|_| ())
            }))
        };
        let clock = (options["clock"] == true).then(|| {
            let callbacks = callbacks.clone();
            Arc::new(move || callbacks.sync("clock", json!({})))
                as Arc<dyn Fn() -> CoreResult<Value> + Send + Sync>
        });
        let create_id = (options["createId"] == true).then(|| {
            let callbacks = callbacks.clone();
            Arc::new(move || {
                Ok(callbacks
                    .sync("createId", json!({}))?
                    .as_str()
                    .unwrap_or("")
                    .into())
            }) as Arc<dyn Fn() -> CoreResult<String> + Send + Sync>
        });
        let writer = BlackboardWriter::new(
            Arc::new(Store(callbacks.clone())),
            observer("onChange"),
            observer("onWrite"),
        )
        .with_fallible_clock_and_ids(clock, create_id);
        Ok(Self { writer, callbacks })
    }
    #[napi]
    pub fn call(
        &self,
        env: Env,
        name: String,
        payload: String,
        callback: JsFunction,
    ) -> Result<String> {
        let input = decode(&payload)?;
        let result = self
            .callbacks
            .scoped(env, callback, || match name.as_str() {
                "postTask" => self.writer.post_task(&input),
                "updateTask" => self.writer.update_task(&input).map(|_| Value::Null),
                "postFinding" => self.writer.post_finding(&input),
                "postActivity" => self.writer.post_activity(&input),
                _ => Err(CoreError::new(
                    "BLACKBOARD_OPERATION",
                    format!("Unknown blackboard operation: {name}"),
                )),
            })
            .map_err(failure)?;
        encode(&result)
    }
}
