mod collaboration;
mod commands;
mod environment;
mod host_callbacks;
mod host_bridge;
mod mcp_client;
mod mcp_transport;
mod mcp_manager;
mod mcp_bridge;
mod operation;
mod promises;
mod provider;
mod query_loop;
mod retirement;
mod redaction;
mod search;
mod text;
mod tools;
mod tool_discovery;
mod value;
mod xml;
use halo_core::session::NativeSession as CoreSession;
use napi::{Env, Error, JsObject, Result, Status};
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::Arc;

fn failure(error: halo_core::error::Error) -> Error {
    Error::new(
        Status::GenericFailure,
        serde_json::to_string(&error).unwrap_or(error.message),
    )
}

fn decode(value: &str) -> Result<Value> {
    serde_json::from_str(value).map_err(|error| Error::new(Status::InvalidArg, error.to_string()))
}

fn encode(value: &Value) -> Result<String> {
    serde_json::to_string(value)
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

#[napi]
pub fn runtime_info() -> String {
    json!({
        "implementation": "rust",
        "abiVersion": 1,
        "version": env!("CARGO_PKG_VERSION"),
        "targetArch": std::env::consts::ARCH,
        "targetOs": std::env::consts::OS,
        "buildId": option_env!("HALO_SDK_BUILD_ID").unwrap_or("development")
    })
    .to_string()
}

#[napi]
pub fn runtime_diagnostics() -> String {
    halo_core::runtime::diagnostics().to_string()
}

#[napi]
pub fn configure_http_trust(env: Env, certificates: String) -> Result<u64> {
    let certificates: Vec<String> = serde_json::from_str(&certificates)
        .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
    environment::http_trust(env)?.update_certificates(certificates).map_err(failure)
}

#[napi]
pub fn read_session_tool_context_mode(
    env: Env,
    session_id: String,
    options: String,
) -> Result<JsObject> {
    let options = decode(&options)?;
    promises::spawn(
        env,
        async move {
            halo_core::history::read_session_tool_context_mode(&session_id, options)
                .await
                .map_err(failure)
        },
        |_env, value| Ok(value),
    )
}

#[napi]
pub struct NativeSession {
    inner: Arc<CoreSession>,
    retirement_registered: Arc<std::sync::atomic::AtomicBool>,
    activity: Arc<host_callbacks::Callbacks>,
    catalog_release: bool,
    _execution: halo_core::resource_activity::ResourceSubscription,
    _resources: Option<halo_core::resource_activity::ResourceSubscription>,
}
impl NativeSession {
    fn refresh_activity(&self, env: Env) -> Result<()> {
        let snapshot = self.inner.execution_activity().snapshot();
        self.activity
            .set_referenced_at(env, snapshot.generation, snapshot.active)
            .map_err(failure)
    }
}

#[napi]
impl NativeSession {
    #[napi(constructor)]
    pub fn new(mut env: Env, options: String, release: Option<napi::JsFunction>) -> Result<Self> {
        let options = decode(&options)?;
        with_runtime(|| {
            let services = environment::host_services(env)?;
            let activity = match release.as_ref() {
                Some(callback) => host_callbacks::Callbacks::new_named(env, callback, "Halo native activity")?,
                None => host_callbacks::Callbacks::new_activity(env)?,
            };
            let inner = CoreSession::new_with_services(options, services).map_err(failure)?;
            let execution =
                host_callbacks::bind_execution_activity(&inner.execution_activity(), &activity);
            let resources = inner
                .resource_activity()
                .map(|resources| host_callbacks::bind_resource_activity(&resources, &activity));
            environment::track(
                &mut env,
                &inner,
                CoreSession::abort_for_host_shutdown,
                "session",
            )?;
            Ok(Self {
                inner,
                retirement_registered: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                activity,
                catalog_release: release.is_some(),
                _execution: execution,
                _resources: resources,
            })
        })
    }

    #[napi]
    pub fn start_stream(&self, env: Env) -> Result<()> {
        let result = self.inner.start_stream().map_err(failure);
        self.refresh_activity(env)?;
        result
    }

    #[napi]
    pub fn shared_context(&self, identity: String, expected_owner: Option<String>) -> Result<value::NativeSharedToolState> {
        let state = self.inner.shared_context(&identity, expected_owner.as_deref()).map_err(failure)?;
        if self.catalog_release {
            state.skills.owner.observe_release(|| {
                let activity = Arc::downgrade(&self.activity);
                let owner = state.skills.owner.identity().to_owned();
                Box::new(move || {
                    if let Some(activity) = activity.upgrade() {
                        activity.notify("context.releaseOwner", json!({"owner":owner}));
                    }
                })
            }).map_err(failure)?;
        }
        Ok(value::shared_tool_state(state))
    }

    #[napi]
    pub fn send(&self, env: Env, input: String, input_id: String, live: bool) -> Result<bool> {
        let result = self
            .inner
            .send(decode(&input)?, input_id, live)
            .map_err(failure);
        self.refresh_activity(env)?;
        result
    }

    #[napi]
    pub fn has_pending_input(&self) -> bool {
        self.inner.has_pending_input()
    }

    #[napi]
    pub fn withdraw_unread_input(&self) -> Result<String> {
        self.inner
            .withdraw_unread_input()
            .map(|ids| json!(ids).to_string())
            .map_err(failure)
    }

    #[napi]
    pub fn interrupt(&self) {
        self.inner.interrupt();
    }

    #[napi]
    pub fn abort_cleanup(&self) {
        self.inner.cancel_end_hooks();
    }

    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }

    #[napi]
    pub fn wait_closed(&self, env: Env) -> Result<JsObject> {
        let inner = self.inner.clone();
        let registered = self.retirement_registered.clone();
        promises::spawn(
            env,
            async move { inner.wait_closed().await.map_err(failure)?; Ok(inner.process_retirement()) },
            move |env, retired| {
                if !registered.swap(true, std::sync::atomic::Ordering::AcqRel) { retirement::retain(*env, retired)?; }
                Ok(())
            },
        )
    }

    #[napi]
    pub fn owned_process_count(&self) -> u32 { self.inner.owned_process_count() as u32 }

    #[napi]
    pub fn reap_owned_processes(&self, env: Env) -> Result<JsObject> {
        let inner = self.inner.clone();
        promises::spawn(env, async move { inner.reap_owned_processes().await.map_err(failure) }, |_env, value| Ok(value))
    }

    #[napi]
    pub fn flush(&self, env: Env) -> Result<JsObject> {
        let inner = self.inner.clone();
        promises::spawn(
            env,
            async move { inner.flush().await.map_err(failure) },
            |_env, value| Ok(value),
        )
    }

    #[napi]
    pub fn event_consumed(&self, id: Option<String>, error: Option<String>) -> Result<()> {
        if let Some(id) = id {
            self.inner.event_consumed(&id, error.map(|value| decode(&value).map(halo_core::error::Error::from_host)).transpose()?);
        } else { self.inner.output_consumed(); }
        Ok(())
    }

    #[napi]
    pub fn next(&self, env: Env) -> Result<JsObject> {
        let inner = self.inner.clone();
        promises::spawn_unref(
            env,
            async move {
                inner
                    .next()
                    .await
                    .map_err(failure)?
                    .map(|event| encode(&event))
                    .transpose()
            },
            |_env, value| Ok(value),
        )
    }

    #[napi]
    pub fn command(&self, env: Env, name: String, payload: String) -> Result<JsObject> {
        let inner = self.inner.clone();
        let payload = decode(&payload)?;
        promises::spawn(
            env,
            async move { encode(&inner.command(&name, payload).await.map_err(failure)?) },
            |_env, value| Ok(value),
        )
    }

    #[napi]
    pub fn context_call(
        &self,
        tool_use_id: String,
        method: String,
        payload: String,
    ) -> Result<String> {
        encode(
            &self
                .inner
                .context_call(&tool_use_id, &method, decode(&payload)?)
                .map_err(failure)?,
        )
    }

    #[napi]
    pub fn context_async(
        &self,
        env: Env,
        tool_use_id: String,
        method: String,
        payload: String,
        read_state: Option<napi::JsFunction>,
    ) -> Result<JsObject> {
        let inner = self.inner.clone();
        let payload = decode(&payload)?;
        let admitted = crate::tools::admit_context_file(env,
            inner.prepare_context_file(&tool_use_id, &method, &payload).map_err(failure)?, read_state.as_ref())?;
        promises::spawn(
            env,
            async move {
                if let Some(admitted) = admitted { return encode(&admitted.execute(payload).await.map_err(failure)?); }
                encode(
                    &inner
                        .context_async(&tool_use_id, &method, payload)
                        .await
                        .map_err(failure)?,
                )
            },
            |_env, value| Ok(value),
        )
    }

    #[napi]
    pub fn context_emit(&self, env: Env, tool_use_id: String, event: String) -> Result<JsObject> {
        let inner = self.inner.clone();
        let event = decode(&event)?;
        promises::spawn(
            env,
            async move {
                inner
                    .context_emit(&tool_use_id, event)
                    .await
                    .map_err(failure)
            },
            |_env, value| Ok(value),
        )
    }

    #[napi]
    pub fn get_goal(&self) -> Result<String> {
        encode(&self.inner.goal())
    }

    #[napi]
    pub fn set_goal(&self, goal: String) -> Result<String> {
        encode(&self.inner.set_goal(decode(&goal)?).map_err(failure)?)
    }

    #[napi]
    pub fn callback_response(
        &self,
        id: String,
        result: String,
        error: Option<String>,
    ) -> Result<()> {
        let (result, error) = host_callbacks::decode_callback_reply(&result, error.as_deref());
        self.inner
            .callback_response(&id, result, error)
            .map_err(failure)
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.inner.close();
    }
}

#[napi]
pub struct NativeHistoryRead {
    cancellation: Arc<tokio_util::sync::CancellationToken>,
    result:
        std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<halo_core::error::Result<String>>>>,
}

#[napi]
impl NativeHistoryRead {
    #[napi(constructor)]
    pub fn new(mut env: Env, session_id: String, options: String) -> Result<Self> {
        let options = decode(&options)?;
        let cancellation = Arc::new(tokio_util::sync::CancellationToken::new());
        environment::track(
            &mut env,
            &cancellation,
            tokio_util::sync::CancellationToken::cancel,
            "history read",
        )?;
        let token = cancellation.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        with_runtime(|| -> Result<()> {
            halo_core::runtime::shared().map_err(failure)?.spawn(async move {
                let result = tokio::select! {
                    _ = token.cancelled() => Err(halo_core::error::Error::cancelled()),
                    result = halo_core::history::read_session_tool_context_mode(&session_id, options) => result,
                };
                let _ = send.send(result);
            });
            Ok(())
        })?;
        Ok(Self {
            cancellation,
            result: std::sync::Mutex::new(Some(receive)),
        })
    }

    #[napi]
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    #[napi]
    pub fn result(&self, env: Env) -> Result<JsObject> {
        let receive = self.result.lock().unwrap().take().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                "History read result was already consumed",
            )
        })?;
        promises::spawn(
            env,
            async move {
                receive
                    .await
                    .map_err(|_| failure(halo_core::error::Error::cancelled()))?
                    .map_err(failure)
            },
            |_env, value| Ok(value),
        )
    }
}

impl Drop for NativeHistoryRead {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

pub(crate) fn with_runtime<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    napi::bindgen_prelude::within_runtime_if_available(|| {
        halo_core::runtime::register_current().map_err(failure)?;
        operation()
    })
}
