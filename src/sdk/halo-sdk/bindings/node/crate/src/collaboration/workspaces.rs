use super::super::{decode, encode, failure};
use halo_core::{
    collaboration::workspaces,
    error::{Error as CoreError, Result as CoreResult},
};
use napi::{Env, Error, JsObject, Result, Status};
use napi_derive::napi;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[napi]
pub struct NativeCollaborationWorkspace {
    cancellation: Arc<CancellationToken>,
    result: Arc<Mutex<Option<oneshot::Receiver<CoreResult<Value>>>>>,
}
#[napi]
impl NativeCollaborationWorkspace {
    #[napi(constructor)]
    pub fn new(mut env: Env, operation: String, payload: String) -> Result<Self> {
        let input = decode(&payload)?;
        let cancellation = Arc::new(CancellationToken::new());
        crate::environment::track(
            &mut env,
            &cancellation,
            CancellationToken::cancel,
            "collaboration workspace",
        )?;
        let token = cancellation.clone();
        let (sender, receiver) = oneshot::channel();
        crate::with_runtime(|| -> Result<()> {
            halo_core::runtime::shared()
                .map_err(failure)?
                .spawn(async move {
                    let result = async {
                        match operation.as_str() {
                            "open" => {
                                let roots = input["additionalDirectories"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(Value::as_str)
                                    .map(PathBuf::from)
                                    .collect::<Vec<_>>();
                                let workspace = workspaces::open_member_workspace(
                                    &input["member"],
                                    Path::new(input["parentCwd"].as_str().unwrap_or("")),
                                    &roots,
                                    input["metadataDirectory"].as_str().map(Path::new),
                                    &token,
                                )
                                .await?;
                                serde_json::to_value(workspace).map_err(CoreError::from)
                            }
                            "release" => {
                                let workspace = serde_json::from_value(input)?;
                                workspaces::release_member_workspace(&workspace).await;
                                Ok(Value::Null)
                            }
                            _ => Err(CoreError::new(
                                "WORKSPACE_OPERATION",
                                format!("Unknown collaboration workspace operation: {operation}"),
                            )),
                        }
                    }
                    .await;
                    let _ = sender.send(result);
                });
            Ok(())
        })?;
        Ok(Self {
            cancellation,
            result: Arc::new(Mutex::new(Some(receiver))),
        })
    }
    #[napi]
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }
    #[napi]
    pub fn result(&self, env: Env) -> Result<JsObject> {
        let result = self.result.clone();
        crate::promises::spawn(
            env,
            async move {
                let receiver = result.lock().unwrap().take().ok_or_else(|| {
                    Error::new(
                        Status::GenericFailure,
                        "Workspace result was already consumed",
                    )
                })?;
                encode(
                    &receiver
                        .await
                        .map_err(|_| failure(CoreError::cancelled()))?
                        .map_err(failure)?,
                )
            },
            |env, value| env.create_string(&value),
        )
    }
}
impl Drop for NativeCollaborationWorkspace {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}
