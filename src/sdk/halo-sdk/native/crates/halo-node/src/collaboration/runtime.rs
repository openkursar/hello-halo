use super::{
    super::{decode, encode, failure},
    callbacks::{self, Callbacks},
    message_bus::NativeMessageBus,
};
use async_trait::async_trait;
use halo_core::{
    collaboration::{
        runtime::{
            CollaborationRuntime, MemberExecutionRequest, RuntimeOptions, SessionExecutor,
            SourceDelivery, TeamDelivery, TurnCompletion,
        },
        store::ScopeStore,
    },
    error::{Error as CoreError, Result as CoreResult},
};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
};
use tokio_util::sync::CancellationToken;

struct Execution {
    ready: Arc<dyn Fn() + Send + Sync>,
    finished: CancellationToken,
}
struct Host {
    team: String,
    epoch: String,
    callbacks: Arc<Callbacks>,
    runtime: Mutex<Weak<CollaborationRuntime>>,
    activity_generation: AtomicU64,
    executions: Arc<Mutex<HashMap<String, Execution>>>,
}
struct ExecutionLease {
    id: String,
    executions: Arc<Mutex<HashMap<String, Execution>>>,
    callbacks: Arc<Callbacks>,
}
impl Drop for ExecutionLease {
    fn drop(&mut self) {
        if let Some(execution) = self.executions.lock().unwrap().remove(&self.id) {
            execution.finished.cancel();
        }
        self.callbacks
            .notify("runtime.executionReleased", json!({"reference":self.id}));
    }
}
impl Host {
    fn change(&self, observe: bool) -> CoreResult<()> {
        let runtime = self.runtime.lock().unwrap().upgrade();
        if let Some(runtime) = runtime {
            let (generation, active) = runtime.activity();
            if self
                .activity_generation
                .fetch_max(generation, Ordering::AcqRel)
                < generation
            {
                self.callbacks.set_referenced(generation, active)?;
            }
        }
        if observe {
            self.callbacks.sync("runtime.onChange", json!({}))?;
        }
        Ok(())
    }
    fn read(&self, name: &str, input: Value) -> CoreResult<Value> {
        self.callbacks.sync(&format!("store.{name}"), input)
    }
    fn optional(&self, name: &str, input: Value) -> CoreResult<Option<Value>> {
        let value = self.read(name, input)?;
        Ok((!value.is_null()).then_some(value))
    }
    async fn text(&self, name: &str, input: Value) -> CoreResult<String> {
        self.callbacks
            .asynchronous(&format!("executor.{name}"), input)
            .await?
            .as_str()
            .map(String::from)
            .ok_or_else(|| {
                CoreError::new(
                    "COLLABORATION_CALLBACK",
                    format!("{name} must return a string"),
                )
            })
    }
}
#[async_trait]
impl ScopeStore for Host {
    fn team_id(&self) -> &str {
        &self.team
    }
    fn epoch_id(&self) -> &str {
        &self.epoch
    }
    fn rows(&self, kind: &str) -> Vec<Value> {
        self.try_rows(kind).unwrap_or_default()
    }
    fn get(&self, kind: &str, id: &str) -> Option<Value> {
        self.try_get(kind, id).ok().flatten()
    }
    fn find_member(&self, name: &str) -> Option<Value> {
        self.try_find_member(name).ok().flatten()
    }
    fn try_rows(&self, kind: &str) -> CoreResult<Vec<Value>> {
        Ok(self
            .read(
                match kind {
                    "member" => "members",
                    "task" => "tasks",
                    "finding" => "findings",
                    _ => "activities",
                },
                json!({}),
            )?
            .as_array()
            .cloned()
            .unwrap_or_default())
    }
    fn try_get(&self, kind: &str, id: &str) -> CoreResult<Option<Value>> {
        self.optional(
            if kind == "member" {
                "getMember"
            } else {
                "getTaskById"
            },
            json!({"id":id}),
        )
    }
    fn try_find_member(&self, name: &str) -> CoreResult<Option<Value>> {
        self.optional("findMember", json!({"name":name}))
    }
    fn record(&self, mutation: Value) -> CoreResult<()> {
        let name = match mutation["kind"].as_str() {
            Some("member") => "addMember",
            Some("remove_member") => "removeMember",
            Some("task") => "insertTask",
            Some("finding") => "insertFinding",
            _ => "insertActivity",
        };
        self.read(name, mutation).map(|_| ())
    }
    fn update_task(&self, id: &str, patch: Value, now: Value) -> CoreResult<()> {
        self.read("updateTask", json!({"id":id,"patch":patch,"now":now}))
            .map(|_| ())
    }
    async fn flush(&self) -> CoreResult<()> {
        self.callbacks
            .asynchronous("store.flush", json!({}))
            .await
            .map(|_| ())
    }
}
#[async_trait]
impl SessionExecutor for Host {
    async fn execute(&self, request: MemberExecutionRequest) -> CoreResult<TurnCompletion> {
        if request.cancellation.is_cancelled() {
            return Err(CoreError::cancelled());
        }
        let reference = halo_core::collaboration::protocol::id();
        let finished = CancellationToken::new();
        self.executions.lock().unwrap().insert(
            reference.clone(),
            Execution {
                ready: request.ready,
                finished: finished.clone(),
            },
        );
        let _lease = ExecutionLease {
            id: reference.clone(),
            executions: self.executions.clone(),
            callbacks: self.callbacks.clone(),
        };
        let signal = request.cancellation;
        let callbacks = self.callbacks.clone();
        let cancelled_id = reference.clone();
        halo_core::runtime::spawn(async move {
            tokio::select! { _=finished.cancelled()=>{}, _=signal.cancelled()=>callbacks.notify("runtime.executionCancelled", json!({"reference":cancelled_id})) }
        });
        let result = self.callbacks.asynchronous("executor.execute", json!({"reference":reference,"member":request.member,"deliveries":request.deliveries})).await?;
        serde_json::from_value(result).map_err(CoreError::from)
    }
    fn inject(&self, member: &str, deliveries: &[TeamDelivery]) -> bool {
        self.try_inject(member, deliveries).unwrap_or(false)
    }
    fn try_inject(&self, member: &str, deliveries: &[TeamDelivery]) -> CoreResult<bool> {
        Ok(self.callbacks.sync(
            "executor.inject",
            json!({"memberId":member,"deliveries":deliveries}),
        )? == true)
    }
    async fn interrupt(&self, member: &str) -> CoreResult<bool> {
        Ok(self
            .callbacks
            .asynchronous("executor.interrupt", json!({"memberId":member}))
            .await?
            == true)
    }
    async fn release(&self, member: &str) -> CoreResult<()> {
        self.callbacks
            .asynchronous("executor.release", json!({"memberId":member}))
            .await
            .map(|_| ())
    }
    async fn read_member(&self, member: &str, before: Option<u64>) -> CoreResult<String> {
        self.text("readMember", json!({"memberId":member,"before":before}))
            .await
    }
    async fn read_artifact(&self, reference: &str, requester: &str) -> CoreResult<String> {
        self.text(
            "readArtifact",
            json!({"ref":reference,"requesterId":requester}),
        )
        .await
    }
    async fn validate_artifact(&self, reference: &str, producer: &str) -> CoreResult<String> {
        self.text(
            "validateArtifact",
            json!({"ref":reference,"producerId":producer}),
        )
        .await
    }
}
#[async_trait]
impl SourceDelivery for Host {
    async fn deliver(&self, envelope: Value, trigger: Value) -> CoreResult<String> {
        self.callbacks
            .asynchronous(
                "runtime.deliverToSource",
                json!({"envelope":envelope,"trigger":trigger}),
            )
            .await?
            .as_str()
            .map(String::from)
            .ok_or_else(|| {
                CoreError::new(
                    "COLLABORATION_CALLBACK",
                    "deliverToSource must return a delivery disposition",
                )
            })
    }
}
fn positive(options: &Value, name: &str) -> CoreResult<usize> {
    let number = options[name].as_f64().unwrap_or(f64::NAN);
    if !number.is_finite()
        || number.fract() != 0.0
        || number < 1.0
        || number > 9_007_199_254_740_991.0
    {
        return Err(CoreError::new(
            "COLLABORATION_ARGUMENTS",
            format!("{name} must be a positive integer"),
        )
        .with_details(json!({"name":"TypeError"})));
    }
    Ok(number as usize)
}
#[napi]
pub struct NativeCollaborationRuntime {
    runtime: Arc<CollaborationRuntime>,
    host: Arc<Host>,
    operations: Arc<Mutex<HashMap<String, CancellationToken>>>,
}
#[napi]
impl NativeCollaborationRuntime {
    #[napi(constructor)]
    pub fn new(mut env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        let callbacks = Callbacks::new(env, &callback)?;
        let host = Arc::new(Host {
            team: options["teamId"].as_str().unwrap_or("").into(),
            epoch: options["epochId"].as_str().unwrap_or("").into(),
            callbacks: callbacks.clone(),
            runtime: Mutex::new(Weak::new()),
            activity_generation: AtomicU64::new(0),
            executions: Arc::new(Mutex::new(HashMap::new())),
        });
        let idle = options
            .get("idleTimeoutMs")
            .map(|value| {
                let value = value.as_f64().unwrap_or(f64::NAN);
                if !value.is_finite() || value < 1.0 {
                    return Err(failure(
                        CoreError::new("COLLABORATION_ARGUMENTS", "idleTimeoutMs must be positive")
                            .with_details(json!({"name":"TypeError"})),
                    ));
                }
                Ok(value as u64)
            })
            .transpose()?;
        let on_change = Some(Arc::new({
            let host = host.clone();
            let observe = options["onChange"] == true;
            move || host.change(observe)
        }) as Arc<dyn Fn() -> CoreResult<()> + Send + Sync>);
        let runtime = CollaborationRuntime::new(
            RuntimeOptions {
                store: host.clone(),
                max_concurrent_turns: positive(&options, "maxConcurrentTurns").map_err(failure)?,
                max_members: positive(&options, "maxMembers").map_err(failure)?,
                idle_timeout_ms: idle,
                origin: options["origin"].as_str().map(String::from),
                harness: halo_core::harness::baseline(),
                on_change,
            },
            host.clone(),
            host.clone(),
        )
        .map_err(failure)?;
        *host.runtime.lock().unwrap() = Arc::downgrade(&runtime);
        crate::environment::track(
            &mut env,
            &runtime,
            CollaborationRuntime::abort_now,
            "collaboration runtime",
        )?;
        Ok(Self {
            runtime,
            host,
            operations: Arc::new(Mutex::new(HashMap::new())),
        })
    }
    #[napi]
    pub fn bus(&self) -> NativeMessageBus {
        NativeMessageBus::from_runtime(self.runtime.clone(), self.host.callbacks.clone())
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
        let operation = || {
            self.host
                .callbacks
                .scoped(env, callback, || -> CoreResult<Value> {
                    Ok(match name.as_str() {
                        "coordinatorId" => self.runtime.coordinator_id.clone().into(),
                        "activeCount" => json!(self.runtime.active_count()),
                        "revision" => json!(self.runtime.revision()),
                        "beginRequest" => json!(self.runtime.begin_request()?),
                        "executionReady" => {
                            let ready = self
                                .host
                                .executions
                                .lock()
                                .unwrap()
                                .get(input["reference"].as_str().unwrap_or(""))
                                .map(|execution| execution.ready.clone());
                            if let Some(ready) = ready {
                                ready();
                            }
                            Value::Null
                        }
                        _ => {
                            return Err(CoreError::new(
                                "COLLABORATION_OPERATION",
                                format!("Unknown collaboration runtime operation: {name}"),
                            ))
                        }
                    })
                })
                .map_err(failure)
        };
        let result = if name == "executionReady" {
            crate::with_runtime(operation)
        } else {
            operation()
        }?;
        encode(&result)
    }
    #[napi]
    pub fn start(
        &self,
        env: Env,
        name: String,
        payload: String,
        operation_id: String,
        callback: JsFunction,
    ) -> Result<JsObject> {
        let input = decode(&payload)?;
        let runtime = self.runtime.clone();
        let operations = self.operations.clone();
        let shutdown = self.host.callbacks.clone();
        let cancellation = CancellationToken::new();
        operations
            .lock()
            .unwrap()
            .insert(operation_id.clone(), cancellation.clone());
        callbacks::start(env, self.host.callbacks.clone(), callback, async move {
            let caller = input["callerId"]
                .as_str()
                .unwrap_or(&runtime.coordinator_id);
            let result = async {
                match name.as_str() {
                    "spawn" => runtime
                        .spawn(caller, input["input"].clone(), &cancellation)
                        .await
                        .map(Value::String),
                    "send" => runtime
                        .send(
                            caller,
                            input["to"].as_str().unwrap_or(""),
                            input["message"].as_str().unwrap_or(""),
                            &cancellation,
                        )
                        .await
                        .map(Value::String),
                    "stop" => runtime
                        .stop(caller, input["to"].as_str().unwrap_or(""))
                        .await
                        .map(Value::String),
                    "tool" => {
                        runtime
                            .call(
                                caller,
                                input["name"].as_str().unwrap_or(""),
                                input["input"].clone(),
                                &cancellation,
                            )
                            .await
                    }
                    "waitForChange" => {
                        runtime
                            .wait_for_change(input["after"].as_u64().unwrap_or(0), &cancellation)
                            .await;
                        Ok(Value::Null)
                    }
                    "close" => {
                        runtime.close().await?;
                        Ok(Value::Null)
                    }
                    _ => Err(CoreError::new(
                        "COLLABORATION_OPERATION",
                        format!("Unknown collaboration runtime operation: {name}"),
                    )),
                }
            }
            .await;
            operations.lock().unwrap().remove(&operation_id);
            if name == "close" {
                shutdown.shutdown();
            }
            result
        })
    }
    #[napi]
    pub fn cancel(&self, operation_id: String) {
        if let Some(signal) = self.operations.lock().unwrap().get(&operation_id) {
            signal.cancel();
        }
    }
}
