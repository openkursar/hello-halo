use super::{
    super::{decode, encode, failure},
    callbacks::{self, Callbacks},
};
use async_trait::async_trait;
use halo_core::{
    core::collaboration_adapter::{
        SdkCollaboration, SourceOptions, SourceOptionsLease, SourceOwner, SourceTools,
    },
    error::{Error as CoreError, Result as CoreResult},
    resource_activity::{ResourceActivity, ResourceSubscription},
    session::NativeSession,
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

struct Child {
    session: Weak<NativeSession>,
    scope: Value,
}
struct Owner {
    id: String,
    resources: Arc<ResourceActivity>,
    services: halo_core::bridge::HostServices,
    callbacks: Arc<Callbacks>,
    children: Mutex<HashMap<String, Child>>,
    retirements: Mutex<Vec<Arc<halo_core::tools::ProcessRetirement>>>,
    activity_generation: AtomicU64,
}
struct OptionsLease {
    id: Value,
    callbacks: Arc<Callbacks>,
}
impl SourceOptionsLease for OptionsLease {}
impl Drop for OptionsLease {
    fn drop(&mut self) {
        self.callbacks
            .notify_scoped("releaseOptions", json!({"reference":self.id}));
    }
}
struct PendingCall {
    id: String,
    scope: Value,
    callbacks: Arc<Callbacks>,
    complete: bool,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        if !self.complete {
            self.callbacks
                .notify("cancelCallback", json!({"id":self.id,"scope":self.scope}));
        }
    }
}
impl Owner {
    fn retain_processes(&self, retirement: Arc<halo_core::tools::ProcessRetirement>) {
        let mut retained = self.retirements.lock().unwrap();
        retained.retain(|owner| !owner.is_settled());
        if !retirement.is_settled() { retained.push(retirement); }
    }
    fn retiring_processes(&self) -> Vec<Arc<halo_core::tools::ProcessRetirement>> {
        let mut retained = self.retirements.lock().unwrap();
        retained.retain(|owner| !owner.is_settled());
        retained.clone()
    }
    fn abort_retirements(&self) {
        for retirement in self.retiring_processes() { retirement.abort_now(); }
    }
    fn child(&self, id: &str) -> CoreResult<Arc<NativeSession>> {
        self.children
            .lock()
            .unwrap()
            .get(id)
            .and_then(|child| child.session.upgrade())
            .ok_or_else(|| {
                CoreError::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
            })
    }
    fn context(&self, identity: &str) -> CoreResult<Arc<NativeSession>> {
        let pair: Vec<String> = serde_json::from_str(identity).map_err(|_| {
            CoreError::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
        })?;
        pair.first()
            .and_then(|id| {
                self.children
                    .lock()
                    .unwrap()
                    .get(id)
                    .and_then(|child| child.session.upgrade())
            })
            .ok_or_else(|| {
                CoreError::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
            })
    }
}
#[async_trait]
impl SourceOwner for Owner {
    fn session_id(&self) -> &str {
        &self.id
    }
    fn resource_activity(&self) -> Option<Arc<ResourceActivity>> {
        Some(self.resources.clone())
    }
    fn host_services(&self) -> halo_core::bridge::HostServices {
        self.services.clone()
    }
    fn activity_changed(&self, generation: u64, active: bool) -> CoreResult<()> {
        if self
            .activity_generation
            .fetch_max(generation, Ordering::AcqRel)
            >= generation
        {
            return Ok(());
        }
        self.callbacks.set_referenced(generation, active)
    }
    fn options(&self, _current: &Value) -> CoreResult<SourceOptions> {
        let value = self.callbacks.sync("getOptions", json!({}))?;
        let lease = Arc::new(OptionsLease {
            id: value["nativeOptionsRef"].clone(),
            callbacks: self.callbacks.clone(),
        });
        Ok(SourceOptions {
            value,
            lease: Some(lease),
        })
    }
    fn prepare_child_options(&self, options: Value) -> CoreResult<Value> {
        self.callbacks
            .sync("prepareOptions", json!({"options":options}))
    }
    fn inherited_tools(&self, options: &Value) -> CoreResult<SourceTools> {
        Ok(SourceTools {
            mcp: None,
            search: None,
            read_deny_roots: halo_core::tools::resolve_read_deny_roots(options)?,
        })
    }
    fn read_deny_roots(&self, options: &Value) -> CoreResult<Vec<String>> {
        halo_core::tools::resolve_read_deny_roots(options)
    }
    fn register_child(&self, child: Arc<NativeSession>, options: &Value) {
        let scope = options["nativeCallbackScope"].clone();
        let id = child.id();
        self.children.lock().unwrap().insert(
            id.into(),
            Child {
                session: Arc::downgrade(&child),
                scope: scope.clone(),
            },
        );
        self.callbacks
            .notify("attachScope", json!({"scope":scope,"sessionId":id}));
    }
    fn unregister_child(&self, session_id: &str) {
        let child = {
            let mut children = self.children.lock().unwrap();
            if let Some(session) = children.get(session_id).and_then(|child| child.session.upgrade()) {
                self.retain_processes(session.process_retirement());
            }
            children.remove(session_id)
        };
        if let Some(child) = child {
            self.callbacks.notify(
                "detachScope",
                json!({"scope":child.scope,"sessionId":session_id}),
            );
        }
    }
    fn log(&self, record: Value) {
        self.callbacks.notify("log", json!({"record":record}));
    }
    async fn call_child(
        &self,
        session_id: &str,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> CoreResult<Value> {
        let scope = self
            .children
            .lock()
            .unwrap()
            .get(session_id)
            .map(|child| child.scope.clone())
            .ok_or_else(CoreError::cancelled)?;
        let id = format!("{session_id}:{}", halo_core::collaboration::protocol::id());
        let mut pending = PendingCall {
            id: id.clone(),
            scope: scope.clone(),
            callbacks: self.callbacks.clone(),
            complete: false,
        };
        let result = tokio::select! {
            _ = cancellation.cancelled() => return Err(CoreError::cancelled()),
            result = self.callbacks.asynchronous("hostCall", json!({"scope":scope,"id":id,"method":method,"params":params})) => result,
        };
        pending.complete = true;
        result
    }
    async fn deliver(&self, envelope: Value, trigger: Value) -> CoreResult<String> {
        Ok(self
            .callbacks
            .asynchronous(
                "deliverToSource",
                json!({"envelope":envelope,"trigger":trigger}),
            )
            .await?
            .as_str()
            .unwrap_or("buffered")
            .into())
    }
}
#[napi]
pub struct NativeSdkCollaboration {
    adapter: Arc<SdkCollaboration>,
    owner: Arc<Owner>,
    operations: Arc<Mutex<HashMap<String, CancellationToken>>>,
    resource_subscription: Arc<Mutex<Option<ResourceSubscription>>>,
}
#[napi]
impl NativeSdkCollaboration {
    #[napi(constructor)]
    pub fn new(mut env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        let callbacks = Callbacks::new(env, &callback)?;
        let owner = Arc::new(Owner {
            id: options["sessionId"].as_str().unwrap_or("").into(),
            resources: Arc::new(ResourceActivity::new()),
            services: crate::environment::host_services(env)?,
            callbacks,
            children: Mutex::new(HashMap::new()),
            retirements: Mutex::new(Vec::new()),
            activity_generation: AtomicU64::new(0),
        });
        let resource_subscription =
            crate::host_callbacks::bind_resource_activity(&owner.resources, &owner.callbacks);
        let adapter = SdkCollaboration::new_with_source(
            owner.clone(),
            json!({}),
            options["settings"].clone(),
        )
        .map_err(failure)?;
        crate::environment::track(&mut env, &owner, Owner::abort_retirements, "SDK collaborator process retirement")?;
        crate::environment::track(
            &mut env,
            &adapter,
            SdkCollaboration::abort_now,
            "SDK collaboration",
        )?;
        Ok(Self {
            adapter,
            owner,
            operations: Arc::new(Mutex::new(HashMap::new())),
            resource_subscription: Arc::new(Mutex::new(Some(resource_subscription))),
        })
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
        let value = self
            .owner
            .callbacks
            .scoped(env, callback, || -> CoreResult<Value> {
                Ok(match name.as_str() {
                    "definitions" | "cancelled" | "operationFailed" => {
                        let options = self.owner.options(&Value::Null)?;
                        let harness = self.owner.harness(&options)?;
                        if name == "definitions" {
                            json!(
                                halo_core::collaboration::tool_contract::definitions_with_harness(
                                    &harness
                                )
                            )
                        } else {
                            halo_core::collaboration::tool_contract::text(
                                harness.text(if name == "cancelled" {
                                    halo_core::harness::TextId::CollaborationFeedbackCancelled
                                } else {
                                    halo_core::harness::TextId::CollaborationFeedbackOperationFailed
                                }),
                                true,
                            )
                        }
                    }
                    "activeCount" => json!(self.adapter.active_count()),
                    "residentCount" => json!(self.adapter.resident_count()),
                    "retainedCount" => json!(self.adapter.retained_count()),
                    "revision" => json!(self.adapter.revision()),
                    "drainUsage" => self.adapter.drain_usage(),
                    "beginRequest" => {
                        self.adapter.begin_request();
                        Value::Null
                    }
                    "budget.spent" => json!(self.adapter.budget.spent()),
                    "budget.total" => json!(self.adapter.budget.total()),
                    "budget.resetRequest" => {
                        self.adapter.budget.reset_request();
                        Value::Null
                    }
                    "budget.observe" => {
                        self.adapter.budget.observe(&input);
                        Value::Null
                    }
                    _ => {
                        return Err(CoreError::new(
                            "COLLABORATION_OPERATION",
                            format!("Unknown SDK collaboration operation: {name}"),
                        ))
                    }
                })
            })
            .map_err(failure)?;
        encode(&value)
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
        let adapter = self.adapter.clone();
        let operations = self.operations.clone();
        let owner = self.owner.clone();
        let closing = name == "close";
        let resource_subscription = self.resource_subscription.clone();
        let cancellation = CancellationToken::new();
        operations
            .lock()
            .unwrap()
            .insert(operation_id.clone(), cancellation.clone());
        callbacks::start_with_completion(env, self.owner.callbacks.clone(), callback, async move {
            let result = async {
                match name.as_str() {
                    "tool" => {
                        adapter
                            .call_server(
                                input["name"].as_str().unwrap_or(""),
                                input["input"].clone(),
                                &cancellation,
                            )
                            .await
                    }
                    "waitForChange" => {
                        adapter
                            .wait_for_change(input["after"].as_u64().unwrap_or(0), &cancellation)
                            .await;
                        Ok(Value::Null)
                    }
                    "stopAll" => {
                        adapter.stop_all().await?;
                        Ok(Value::Null)
                    }
                    "flush" => {
                        adapter.flush().await?;
                        Ok(Value::Null)
                    }
                    "close" => {
                        adapter.close().await?;
                        Ok(Value::Null)
                    }
                    _ => Err(CoreError::new(
                        "COLLABORATION_OPERATION",
                        format!("Unknown SDK collaboration operation: {name}"),
                    )),
                }
            }
            .await;
            operations.lock().unwrap().remove(&operation_id);
            result
        }, move |env| {
            if closing {
                let retained = owner.retiring_processes().into_iter()
                    .try_for_each(|retirement| crate::retirement::retain(*env, retirement));
                if let Err(error) = &retained {
                    eprintln!("[SDK:Native] Collaborator process retirement registration failed: status={}", error.status);
                    owner.abort_retirements();
                }
                owner.resources.close();
                resource_subscription.lock().unwrap().take();
                owner.callbacks.shutdown();
                retained?;
            }
            Ok(())
        })
    }
    #[napi]
    pub fn cancel(&self, operation_id: String) {
        if let Some(cancellation) = self.operations.lock().unwrap().get(&operation_id) {
            cancellation.cancel();
        }
    }
    #[napi]
    pub fn shared_context(&self, identity: String, expected_owner: Option<String>) -> Result<crate::value::NativeSharedToolState> {
        self.owner
            .context(&identity)
            .map_err(failure)?
            .shared_context(&identity, expected_owner.as_deref())
            .map(crate::value::shared_tool_state)
            .map_err(failure)
    }
    #[napi]
    pub fn context_call(
        &self,
        identity: String,
        method: String,
        payload: String,
    ) -> Result<String> {
        encode(
            &self
                .owner
                .context(&identity)
                .map_err(failure)?
                .context_call(&identity, &method, decode(&payload)?)
                .map_err(failure)?,
        )
    }
    #[napi]
    pub fn context_async(
        &self,
        env: Env,
        identity: String,
        method: String,
        payload: String,
        read_state: Option<napi::JsFunction>,
    ) -> Result<JsObject> {
        let context = self.owner.context(&identity).map_err(failure)?;
        let payload = decode(&payload)?;
        let admitted = crate::tools::admit_context_file(env,
            context.prepare_context_file(&identity, &method, &payload).map_err(failure)?, read_state.as_ref())?;
        crate::promises::spawn(
            env,
            async move {
                if let Some(admitted) = admitted { return encode(&admitted.execute(payload).await.map_err(failure)?); }
                encode(
                    &context
                        .context_async(&identity, &method, payload)
                        .await
                        .map_err(failure)?,
                )
            },
            |env, value| env.create_string(&value),
        )
    }
    #[napi]
    pub fn context_emit(&self, env: Env, identity: String, event: String) -> Result<JsObject> {
        let owner = self.owner.clone();
        crate::promises::spawn(
            env,
            async move {
                owner
                    .context(&identity)
                    .map_err(failure)?
                    .context_emit(&identity, decode(&event)?)
                    .await
                    .map_err(failure)
            },
            |_env, value| Ok(value),
        )
    }
    #[napi]
    pub fn command(&self, env: Env, name: String, payload: String) -> Result<JsObject> {
        let owner = self.owner.clone();
        crate::promises::spawn(
            env,
            async move {
                if name != "commandContext" {
                    return Err(failure(CoreError::new(
                        "COMMAND_CONTEXT",
                        "Unknown collaboration command context operation",
                    )));
                }
                let arguments = decode(&payload)?;
                let session = owner
                    .child(arguments[0].as_str().unwrap_or(""))
                    .map_err(failure)?;
                encode(&session.command(&name, arguments).await.map_err(failure)?)
            },
            |env, value| env.create_string(&value),
        )
    }
}
impl Drop for NativeSdkCollaboration {
    fn drop(&mut self) {
        for token in self.operations.lock().unwrap().values() {
            token.cancel();
        }
        self.resource_subscription.lock().unwrap().take();
        self.owner.resources.close();
        self.adapter.abort_now();
        self.owner.abort_retirements();
        self.owner.callbacks.shutdown();
    }
}
