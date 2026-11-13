use crate::{decode, failure, operation::NativeOperation};
use halo_core::{
    callback_channel::CallbackChannel,
    tools::{DirectToolOwner, FileAdmission},
};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use std::sync::Arc;

pub(crate) fn admit_context_file(
    env: Env,
    prepared: Option<halo_core::core::tool_context_bridge::PreparedContextFileCall>,
    read_state: Option<&JsFunction>,
) -> Result<Option<halo_core::core::tool_context_bridge::AdmittedContextFileCall>> {
    let Some(prepared) = prepared else {
        return Ok(None);
    };
    let receipt = if prepared.needs_external_read() {
        let Some(read_state) = read_state else {
            return prepared.admit(None).map(Some).map_err(failure);
        };
        read_state.call(
            None,
            &[env.create_string(&prepared.path().to_string_lossy())?],
        )?;
        Some(prepared.receipt().to_owned())
    } else {
        None
    };
    prepared.admit(receipt).map(Some).map_err(failure)
}

#[napi]
pub struct NativeToolOwner {
    inner: Arc<DirectToolOwner>,
}
#[napi]
impl NativeToolOwner {
    #[napi(constructor)]
    pub fn new(mut env: Env, session_id: String) -> Result<Self> {
        crate::with_runtime(|| {
            let inner = Arc::new(DirectToolOwner::new(session_id));
            crate::environment::track(
                &mut env,
                &inner,
                DirectToolOwner::abort_now,
                "direct tool owner",
            )?;
            Ok(Self { inner })
        })
    }
    #[napi]
    pub fn execute(
        &self,
        mut env: Env,
        implementation: String,
        input: String,
        context: String,
        read_state: Option<JsFunction>,
    ) -> Result<NativeOperation> {
        let owner = self.inner.clone();
        let input = decode(&input)?;
        let context = decode(&context)?;
        crate::with_runtime(|| {
            let admitted = FileAdmission::path(
                &implementation,
                &input,
                context["cwd"].as_str().unwrap_or(""),
            )
            .map(|path| {
                if FileAdmission::reads_state(&implementation, &input) {
                    if let Some(read_state) = &read_state {
                        read_state.call(None, &[env.create_string(&path.to_string_lossy())?])?;
                    }
                }
                Ok::<_, napi::Error>(FileAdmission::admit(&path))
            })
            .transpose()?;
            let services = halo_core::bridge::HostServices {
                http_trust: Some(crate::environment::http_trust(env)?),
                ..Default::default()
            };
            let channel = CallbackChannel::spawn(move |channel| async move {
                channel.set_host_services(services);
                owner
                    .execute_admitted(
                        implementation,
                        input,
                        context,
                        channel.clone(),
                        channel.clone(),
                        channel.interruption(),
                        admitted,
                    )
                    .await
                    .map(Some)
            })
            .map_err(failure)?;
            crate::environment::track(
                &mut env,
                &channel,
                CallbackChannel::abort_for_host_shutdown,
                "direct tool operation",
            )?;
            Ok(NativeOperation::from_channel(channel))
        })
    }
    #[napi]
    pub fn close(&self, env: Env) -> Result<JsObject> {
        let owner = self.inner.clone();
        crate::promises::spawn(
            env,
            async move {
                owner.close().await;
                Ok(())
            },
            |_env, value| Ok(value),
        )
    }
}
impl Drop for NativeToolOwner {
    fn drop(&mut self) {
        self.inner.abort_now();
    }
}
