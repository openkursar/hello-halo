use super::{
    super::{decode, encode, failure},
    callbacks::{self, Callbacks},
};
use async_trait::async_trait;
use halo_core::{
    collaboration::turn_gate::{
        BusyDisposition, DeliverDisposition, TurnGate, TurnGateHooks, TurnGateOptions,
    },
    error::{Error as CoreError, Result as CoreResult},
};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::Arc;

struct Hooks {
    callbacks: Arc<Callbacks>,
    merge: bool,
}
impl Hooks {
    fn call(&self, name: &str, input: Value) -> CoreResult<Value> {
        self.callbacks.sync(name, input)
    }
}
#[async_trait]
impl TurnGateHooks for Hooks {
    async fn dispatch(&self, key: &str, job: Value) -> CoreResult<()> {
        self.callbacks
            .asynchronous("dispatch", json!({"key":key,"job":job}))
            .await
            .map(|_| ())
    }
    fn is_busy(&self, key: &str) -> bool {
        self.try_is_busy(key).unwrap_or(true)
    }
    fn try_is_busy(&self, key: &str) -> CoreResult<bool> {
        Ok(self.call("isBusy", json!({"key":key}))? == true)
    }
    fn try_job_identity(&self, job: &Value) -> CoreResult<Option<String>> {
        Ok(self
            .call("getJobIdentity", json!({"job":job}))?
            .as_str()
            .map(String::from))
    }
    fn try_active_identity(&self, key: &str) -> CoreResult<Option<String>> {
        Ok(self
            .call("getActiveIdentity", json!({"key":key}))?
            .as_str()
            .map(String::from))
    }
    fn supports_merge(&self) -> bool {
        self.merge
    }
    fn try_merge_jobs(&self, jobs: &[Value]) -> CoreResult<Value> {
        self.call("mergeJobs", json!({"jobs":jobs}))
    }
    fn refresh_job(&self, job: &Value) -> CoreResult<Option<Value>> {
        let value = self.call("refreshJob", json!({"job":job}))?;
        Ok((!value.is_null()).then_some(value))
    }
    fn deliver_mid_turn(&self, key: &str, job: Value) -> CoreResult<bool> {
        Ok(self.call("deliverMidTurn", json!({"key":key,"job":job}))? == true)
    }
    fn try_retry_dispatch(&self, error: &CoreError, job: &Value) -> CoreResult<bool> {
        Ok(self.call("retryDispatch", json!({"error":error,"job":job}))? == true)
    }
    fn try_coalescing_key(&self, job: &Value) -> CoreResult<Option<String>> {
        Ok(self
            .call("getCoalescingKey", json!({"job":job}))?
            .as_str()
            .map(String::from))
    }
    fn discard(&self, job: Value, reason: &str) -> CoreResult<()> {
        self.call("onDiscard", json!({"job":job,"reason":reason}))
            .map(|_| ())
    }
    fn try_can_open_turn(&self, job: &Value) -> CoreResult<bool> {
        Ok(self.call("canOpenTurn", json!({"job":job}))? == true)
    }
    fn retain_job(&self, job: &Value) -> CoreResult<()> {
        self.call("retainJob", json!({"job":job})).map(|_| ())
    }
    fn release_job(&self, job: &Value) {
        self.callbacks.notify("releaseJob", json!({"job":job}));
    }
}
fn timeout(value: &Value, fallback: u64) -> u64 {
    let Some(value) = value.as_f64() else {
        return fallback;
    };
    if !value.is_finite() || value < 1.0 || value > 2_147_483_647.0 {
        1
    } else {
        value as u64
    }
}
#[napi]
pub struct NativeTurnGate {
    gate: Arc<TurnGate>,
    callbacks: Arc<Callbacks>,
}
#[napi]
impl NativeTurnGate {
    #[napi(constructor)]
    pub fn new(mut env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        let cap = options["bufferCap"].as_f64().unwrap_or(128.0);
        if cap < 1.0 || !cap.is_finite() || cap.fract() != 0.0 {
            return Err(failure(CoreError::new(
                "TURN_GATE_ARGUMENTS",
                "bufferCap must be a positive integer",
            )));
        }
        let callbacks = Callbacks::new(env, &callback)?;
        let gate = TurnGate::new(
            Arc::new(Hooks {
                callbacks: callbacks.clone(),
                merge: options["mergeJobs"] == true,
            }),
            TurnGateOptions {
                buffer_cap: cap.min(usize::MAX as f64) as usize,
                recheck_ms: timeout(&options["recheckMs"], 3000),
                reservation_ttl_ms: options
                    .get("reservationTtlMs")
                    .map(|value| timeout(value, 1)),
            },
        )
        .map_err(failure)?;
        crate::environment::track(&mut env, &gate, TurnGate::abort_now, "turn gate")?;
        Ok(Self { gate, callbacks })
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
        let key = input["key"].as_str().unwrap_or("");
        let reason = input["reason"].as_str().unwrap_or("");
        let operation = || -> CoreResult<Value> {
            let predicate = |name: &str, payload| {
                self.callbacks
                    .sync(name, payload)
                    .map(|value| value == true)
            };
            Ok(match name.as_str() {
                "tryDeliverLive" => json!(self
                    .gate
                    .checked_try_deliver_live(key, input["job"].clone())?),
                "release" => {
                    self.gate.release(key);
                    Value::Null
                }
                "drain" => {
                    self.gate.checked_drain(key)?;
                    Value::Null
                }
                "notifyReady" => {
                    self.gate.checked_notify_ready(key)?;
                    Value::Null
                }
                "isOccupied" => json!(self.gate.checked_is_occupied(key)?),
                "bufferedJobs" => json!(self.gate.buffered_jobs(key)),
                "bufferedCount" => json!(self.gate.buffered_count(key)),
                "hasAnyBuffered" => json!(self
                    .gate
                    .checked_has_any_buffered(|key| predicate("predicate", json!({"key":key})))?),
                "discard" => json!(self
                    .gate
                    .checked_discard(|key| predicate("predicate", json!({"key":key})), reason)?),
                "discardJobs" => json!(self.gate.checked_discard_jobs(
                    |key, job| predicate("predicate", json!({"key":key,"job":job})),
                    reason
                )?),
                "park" => {
                    self.gate.park(key);
                    Value::Null
                }
                "putBack" => {
                    self.gate.checked_put_back(
                        key,
                        input["jobs"].as_array().cloned().unwrap_or_default(),
                    )?;
                    Value::Null
                }
                _ => {
                    return Err(CoreError::new(
                        "TURN_GATE_OPERATION",
                        format!("Unknown turn gate operation: {name}"),
                    ))
                }
            })
        };
        let run = || {
            self.callbacks
                .scoped(env, callback, operation)
                .map_err(failure)
        };
        let value = if matches!(name.as_str(), "drain" | "notifyReady" | "putBack") {
            crate::with_runtime(run)
        } else {
            run()
        }?;
        encode(&value)
    }
    #[napi]
    pub fn start(
        &self,
        env: Env,
        name: String,
        payload: String,
        callback: JsFunction,
    ) -> Result<JsObject> {
        let input = decode(&payload)?;
        let gate = self.gate.clone();
        let callbacks = self.callbacks.clone();
        callbacks::start(env, callbacks.clone(), callback, async move {
            let key = input["key"].as_str().unwrap_or("");
            match name.as_str() {
                "deliver" => Ok(json!(match gate
                    .deliver(
                        key,
                        input["job"].clone(),
                        if input["onBusy"] == "skip" {
                            BusyDisposition::Skip
                        } else {
                            BusyDisposition::Buffer
                        }
                    )
                    .await?
                {
                    DeliverDisposition::Dispatched => "dispatched",
                    DeliverDisposition::MidTurn => "mid_turn",
                    DeliverDisposition::Buffered => "buffered",
                    DeliverDisposition::Skipped => "skipped",
                })),
                "runExclusive" => {
                    let run = input["run"].clone();
                    gate.run_exclusive(
                        key,
                        Box::new(move || {
                            Box::pin(async move {
                                callbacks
                                    .asynchronous("runExclusive", json!({"run":run}))
                                    .await
                            })
                        }),
                    )
                    .await
                }
                _ => Err(CoreError::new(
                    "TURN_GATE_OPERATION",
                    format!("Unknown turn gate operation: {name}"),
                )),
            }
        })
    }
}
