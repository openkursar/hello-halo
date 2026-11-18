use crate::{decode, encode, failure};
use halo_core::llm::execution::{start_provider, ProviderExecution, ProviderTransport};
use napi::{Env, JsObject, Result};
use napi_derive::napi;
use std::sync::Arc;

#[napi]
pub struct NativeProviderTransport {
    inner: Arc<ProviderTransport>,
}
#[napi]
impl NativeProviderTransport {
    #[napi(constructor)]
    pub fn new(mut env: Env) -> Result<Self> {
        crate::with_runtime(|| {
            let inner = ProviderTransport::new(Some(crate::environment::http_trust(env)?)).map_err(failure)?;
            crate::environment::track(
                &mut env,
                &inner,
                ProviderTransport::close,
                "provider transport",
            )?;
            Ok(Self { inner })
        })
    }
}

#[napi]
pub struct NativeProviderRequest {
    inner: Arc<ProviderExecution>,
}
#[napi]
impl NativeProviderRequest {
    #[napi(constructor)]
    pub fn new(
        mut env: Env,
        options: String,
        request: String,
        mode: String,
        transport: &NativeProviderTransport,
    ) -> Result<Self> {
        let options = decode(&options)?;
        let request = decode(&request)?;
        crate::with_runtime(|| {
            let inner =
                start_provider(options, request, mode, transport.inner.clone()).map_err(failure)?;
            crate::environment::track(
                &mut env,
                &inner,
                ProviderExecution::abort_for_host_shutdown,
                "provider request",
            )?;
            Ok(Self { inner })
        })
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
    pub fn callback_response(
        &self,
        id: String,
        value: String,
        error: Option<String>,
    ) -> Result<()> {
        let (value, error) = crate::host_callbacks::decode_callback_reply(&value, error.as_deref());
        self.inner
            .callback_response(&id, value, error)
            .map_err(failure)
    }
}
impl Drop for NativeProviderRequest {
    fn drop(&mut self) {
        self.inner.close();
    }
}
