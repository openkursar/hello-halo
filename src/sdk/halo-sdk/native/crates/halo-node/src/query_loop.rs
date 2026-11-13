use crate::{decode, encode, failure, value};
use halo_core::core::public_loop::PublicLoop;
use napi::{Env, JsObject, Result};
use napi_derive::napi;
use std::sync::Arc;

#[napi]
pub struct NativeLoop {
    inner: Arc<PublicLoop>,
}
#[napi]
impl NativeLoop {
    #[napi(constructor)]
    pub fn new(
        mut env: Env,
        config: String,
        tools: String,
        initial: String,
        options: String,
        budget: Option<&value::NativeTokenBudget>,
        discovery: Option<&crate::tool_discovery::NativeToolDiscoveryState>,
    ) -> Result<Self> {
        let config = decode(&config)?;
        let tools = decode(&tools)?;
        let initial = decode(&initial)?;
        let options = decode(&options)?;
        let budget = budget.map(|budget| budget.inner.clone());
        let discovery = discovery.map(|state| state.inner.clone());
        crate::with_runtime(|| {
            let services = crate::environment::host_services(env)?;
            let inner = PublicLoop::start(config, tools, initial, options, budget, services, discovery)
                .map_err(failure)?;
            crate::environment::track(
                &mut env,
                &inner,
                PublicLoop::abort_for_host_shutdown,
                "public query loop",
            )?;
            Ok(Self { inner })
        })
    }
    #[napi]
    pub fn tool_discovery_state(&self) -> Option<crate::tool_discovery::NativeToolDiscoveryState> {
        self.inner.tool_discovery_state().map(|inner| crate::tool_discovery::NativeToolDiscoveryState { inner })
    }
    #[napi]
    pub fn token_budget(&self) -> value::NativeTokenBudget {
        value::NativeTokenBudget::from_shared(self.inner.token_budget())
    }
    #[napi]
    pub fn context_receipt(&self) -> Result<String> {
        encode(&self.inner.context_receipt())
    }
    #[napi]
    pub fn event_consumed(&self, id: String, error: Option<String>) -> Result<()> {
        self.inner
            .event_consumed(
                &id,
                error
                    .map(|value| decode(&value).map(halo_core::error::Error::from_host))
                    .transpose()?,
            )
            .map_err(failure)
    }
    #[napi]
    pub fn next(&self, env: Env) -> Result<JsObject> {
        let inner = self.inner.clone();
        crate::promises::spawn(
            env,
            async move {
                inner
                    .next()
                    .await
                    .map_err(failure)?
                    .map(|value| encode(&value))
                    .transpose()
            },
            |_env, value| Ok(value),
        )
    }
    #[napi]
    pub fn callback_response(
        &self,
        id: String,
        result: String,
        error: Option<String>,
    ) -> Result<()> {
        let (result, error) = crate::host_callbacks::decode_callback_reply(&result, error.as_deref());
        self.inner
            .callback_response(&id, result, error)
            .map_err(failure)
    }
    #[napi]
    pub fn interrupt(&self) {
        self.inner.interrupt();
    }
    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }
    #[napi]
    pub fn wait_closed(&self, env: Env) -> Result<JsObject> {
        let inner = self.inner.clone();
        crate::promises::spawn(
            env,
            async move { inner.wait_closed().await.map_err(failure) },
            |_env, value| Ok(value),
        )
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
                .inner
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
        let inner = self.inner.clone();
        let payload = decode(&payload)?;
        let admitted = crate::tools::admit_context_file(env,
            inner.prepare_context_file(&identity, &method, &payload).map_err(failure)?, read_state.as_ref())?;
        crate::promises::spawn(
            env,
            async move {
                if let Some(admitted) = admitted { return encode(&admitted.execute(payload).await.map_err(failure)?); }
                encode(
                    &inner
                        .context_async(&identity, &method, payload)
                        .await
                        .map_err(failure)?,
                )
            },
            |_env, value| Ok(value),
        )
    }
    #[napi]
    pub fn context_emit(&self, env: Env, identity: String, event: String) -> Result<JsObject> {
        let inner = self.inner.clone();
        let event = decode(&event)?;
        crate::promises::spawn(
            env,
            async move { inner.context_emit(&identity, event).await.map_err(failure) },
            |_env, value| Ok(value),
        )
    }
    #[napi]
    pub fn shared_context(&self, identity: String, expected_owner: Option<String>) -> Result<value::NativeSharedToolState> {
        self.inner
            .shared_context(&identity, expected_owner.as_deref())
            .map(value::shared_tool_state)
            .map_err(failure)
    }
}
impl Drop for NativeLoop {
    fn drop(&mut self) {
        self.inner.close();
    }
}
