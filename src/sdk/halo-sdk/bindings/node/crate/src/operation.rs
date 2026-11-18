use crate::{decode, encode, failure};
use halo_core::api::{start_public, PublicExecution};
use napi::{Env, JsObject, Result};
use napi_derive::napi;
use std::sync::Arc;

#[napi]
pub struct NativeOperation {
    inner: Arc<PublicExecution>,
}
impl NativeOperation {
    pub(crate) fn from_channel(inner: Arc<PublicExecution>) -> Self {
        Self { inner }
    }
}
#[napi]
impl NativeOperation {
    #[napi(constructor)]
    pub fn new(mut env: Env, operation: String, options: String, payload: String) -> Result<Self> {
        let options = decode(&options)?;
        let payload = decode(&payload)?;
        crate::with_runtime(|| {
            let services = halo_core::bridge::HostServices {
                http_trust: Some(crate::environment::http_trust(env)?),
                ..Default::default()
            };
            let inner = start_public(operation, options, payload, services).map_err(failure)?;
            crate::environment::track(
                &mut env,
                &inner,
                PublicExecution::abort_for_host_shutdown,
                "public SDK operation",
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
    pub fn interrupt(&self) {
        self.inner.interrupt();
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
        result: String,
        error: Option<String>,
    ) -> Result<()> {
        let (result, error) = crate::host_callbacks::decode_callback_reply(&result, error.as_deref());
        self.inner
            .callback_response(&id, result, error)
            .map_err(failure)
    }
}
impl Drop for NativeOperation {
    fn drop(&mut self) {
        self.inner.close();
    }
}
