use crate::{decode, encode, failure, host_bridge::CallbackBridge, host_callbacks};
use halo_core::{
    error::{Error as CoreError, Result as CoreResult},
    harness, js,
    tools::mcp::{
        public_external::{ExternalConnections, ExternalTool},
        ManagedTool, McpTools,
    },
};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

type Operation = Pin<Box<dyn Future<Output = CoreResult<Value>> + Send + 'static>>;
type Operations = Arc<Mutex<HashMap<String, CancellationToken>>>;
struct OperationLease {
    id: String,
    operations: Operations,
}
impl Drop for OperationLease {
    fn drop(&mut self) {
        let cancel = self.operations.lock().unwrap().remove(&self.id);
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
    }
}
struct ManagerOwner {
    manager: McpTools,
    bridge: Arc<CallbackBridge>,
    operations: Operations,
}
impl ManagerOwner {
    fn abort(&self) {
        let operations = std::mem::take(&mut *self.operations.lock().unwrap());
        for cancel in operations.into_values() {
            cancel.cancel();
        }
        self.manager.abort_now();
        self.bridge.abort();
    }
}
impl Drop for ManagerOwner {
    fn drop(&mut self) {
        self.abort();
    }
}

#[napi]
pub struct NativeMcpManager {
    owner: Arc<ManagerOwner>,
}
#[napi]
impl NativeMcpManager {
    #[napi(constructor)]
    pub fn new(
        mut env: Env,
        configs: String,
        options: String,
        callback: JsFunction,
    ) -> Result<Self> {
        let configs = decode(&configs)?;
        let options = decode(&options)?;
        crate::with_runtime(|| {
            let bridge = CallbackBridge::new(env, &callback)?;
            let manager =
                McpTools::from_configs(&configs, options, bridge.clone()).map_err(failure)?;
            let owner = Arc::new(ManagerOwner {
                manager,
                bridge,
                operations: Default::default(),
            });
            crate::environment::track(&mut env, &owner, ManagerOwner::abort, "MCP manager")?;
            Ok(Self { owner })
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
        let args = decode(&payload)?;
        let manager = &self.owner.manager;
        self.owner.bridge.callbacks.scoped(env, callback, || {
            let value = match name.as_str() {
                "addServer" => {
                    manager
                        .add_server(args[0].as_str().unwrap_or("").into(), args[1].clone())
                        .map_err(failure)?;
                    js::undefined()
                }
                "setElicitationHandler" => {
                    manager.set_elicitation_handler(args[0].clone());
                    js::undefined()
                }
                "disconnect" => {
                    manager.disconnect_server(args[0].as_str().unwrap_or(""));
                    js::undefined()
                }
                "disconnectAll" => {
                    manager.disconnect_all();
                    js::undefined()
                }
                "removeServer" => {
                    manager.remove_server(args[0].as_str().unwrap_or(""));
                    js::undefined()
                }
                "getStatus" => {
                    manager.live_status(args[0].as_str().unwrap_or(""), &harness::baseline())
                }
                "getAllStatuses" => json!(manager.all_live_statuses(&harness::baseline())),
                "getStatuses" => json!(manager.statuses()),
                "isConnected" => json!(manager.is_connected(args[0].as_str().unwrap_or(""))),
                "serverNames" => json!(manager.server_names()),
                "getToolCatalogRevision" => json!(manager.revision()),
                "startReconnectLoop" => {
                    manager.start_reconnect_loop(args[0].as_str().unwrap_or(""));
                    js::undefined()
                }
                _ => {
                    return Err(failure(CoreError::new(
                        "MCP_OPERATION",
                        format!("Unknown MCP manager operation: {name}"),
                    )))
                }
            };
            encode(&value)
        })
    }
    #[napi]
    pub fn start(
        &self,
        env: Env,
        name: String,
        payload: String,
        callback: JsFunction,
    ) -> Result<JsObject> {
        let args = decode(&payload)?;
        let owner = self.owner.clone();
        let prepared: Operation = match name.as_str() {
            "connect" => {
                let ready = owner
                    .manager
                    .prepare_connect_server(args[0].as_str().unwrap_or(""))
                    .map_err(failure)?;
                Box::pin(async move {
                    ready.await?;
                    Ok(js::undefined())
                })
            }
            "connectAll" => {
                let ready = owner.manager.prepare_connect_all().map_err(failure)?;
                Box::pin(async move {
                    ready.await?;
                    Ok(js::undefined())
                })
            }
            "restart" => {
                let ready = owner
                    .manager
                    .prepare_reconnect(args[0].as_str().unwrap_or(""))
                    .map_err(failure)?;
                Box::pin(async move {
                    ready.await?;
                    Ok(js::undefined())
                })
            }
            "toggle" => {
                let ready = owner
                    .manager
                    .prepare_toggle(args[0].as_str().unwrap_or(""), js::truthy(&args[1]))
                    .map_err(failure)?;
                Box::pin(async move {
                    ready.await?;
                    Ok(js::undefined())
                })
            }
            "setServers" => Box::pin(
                owner
                    .manager
                    .prepare_set_servers(args[0].clone(), harness::baseline())
                    .map_err(failure)?,
            ),
            "whenSettled" => {
                let manager = owner.manager.clone();
                Box::pin(async move {
                    manager.when_settled().await;
                    Ok(js::undefined())
                })
            }
            _ => {
                return Err(failure(CoreError::new(
                    "MCP_OPERATION",
                    format!("Unknown MCP manager operation: {name}"),
                )))
            }
        };
        host_callbacks::start(env, owner.bridge.callbacks.clone(), callback, async move {
            let _owner = owner;
            prepared.await
        })
    }
    #[napi]
    pub fn tools(&self) -> Result<Vec<NativeMcpManagedTool>> {
        self.owner
            .manager
            .bridged_tools()
            .map(|tools| {
                tools
                    .into_iter()
                    .map(|tool| NativeMcpManagedTool {
                        tool: Arc::new(tool),
                        owner: self.owner.clone(),
                    })
                    .collect()
            })
            .map_err(failure)
    }
    #[napi]
    pub fn owns_tool(&self, tool: &NativeMcpManagedTool) -> bool {
        self.owner.manager.owns_tool(&tool.tool)
    }
    #[napi]
    pub fn abort(&self) {
        self.owner.abort();
    }
}

#[napi]
pub struct NativeMcpManagedTool {
    tool: Arc<ManagedTool>,
    owner: Arc<ManagerOwner>,
}
#[napi]
impl NativeMcpManagedTool {
    #[napi]
    pub fn descriptor(&self) -> Result<String> {
        encode(&self.tool.descriptor(&harness::baseline()))
    }
    #[napi]
    pub fn start(
        &self,
        env: Env,
        input: String,
        operation_id: String,
        callback: JsFunction,
        initial_error: Option<String>,
    ) -> Result<JsObject> {
        let input = decode(&input)?;
        let initial_error = initial_error
            .map(|value| decode(&value).map(CoreError::from_host))
            .transpose()?;
        let cancel = CancellationToken::new();
        if initial_error.is_some() {
            cancel.cancel();
        }
        self.owner
            .operations
            .lock()
            .unwrap()
            .insert(operation_id.clone(), cancel.clone());
        let lease = OperationLease {
            id: operation_id,
            operations: self.owner.operations.clone(),
        };
        let tool = self.tool.clone();
        let owner = self.owner.clone();
        host_callbacks::start(env, owner.bridge.callbacks.clone(), callback, async move {
            let _owner = owner;
            let _lease = lease;
            tool.execute_with_initial_error(input, &cancel, &harness::baseline(), initial_error)
                .await
        })
    }
    #[napi]
    pub fn cancel(&self, operation_id: String) {
        if let Some(cancel) = self
            .owner
            .operations
            .lock()
            .unwrap()
            .get(&operation_id)
            .cloned()
        {
            cancel.cancel();
        }
    }
}

struct ExternalOwner {
    connections: Mutex<Option<ExternalConnections>>,
    bridge: Arc<CallbackBridge>,
    options: Value,
    closed: std::sync::atomic::AtomicBool,
}
impl ExternalOwner {
    fn abort(&self) {
        let connections = {
            let connections = self.connections.lock().unwrap();
            self.closed
                .store(true, std::sync::atomic::Ordering::Release);
            connections.clone()
        };
        if let Some(connections) = connections {
            connections.abort_now();
        }
        self.bridge.abort();
    }
}
impl Drop for ExternalOwner {
    fn drop(&mut self) {
        self.abort();
    }
}

#[napi]
pub struct NativeExternalMcp {
    owner: Arc<ExternalOwner>,
}
#[napi]
impl NativeExternalMcp {
    #[napi(constructor)]
    pub fn new(mut env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        crate::with_runtime(|| {
            let bridge = CallbackBridge::new(env, &callback)?;
            let owner = Arc::new(ExternalOwner {
                connections: Mutex::new(None),
                bridge,
                options,
                closed: std::sync::atomic::AtomicBool::new(false),
            });
            crate::environment::track(
                &mut env,
                &owner,
                ExternalOwner::abort,
                "external MCP connection",
            )?;
            Ok(Self { owner })
        })
    }
    #[napi]
    pub fn connect(&self, env: Env, configs: String, callback: JsFunction) -> Result<JsObject> {
        let configs = decode(&configs)?;
        let owner = self.owner.clone();
        host_callbacks::start(env, owner.bridge.callbacks.clone(), callback, async move {
            let connections =
                ExternalConnections::connect(&configs, owner.options.clone(), owner.bridge.clone())
                    .await?;
            let published = {
                let mut current = owner.connections.lock().unwrap();
                if owner.closed.load(std::sync::atomic::Ordering::Acquire) {
                    false
                } else {
                    *current = Some(connections.clone());
                    true
                }
            };
            if !published {
                connections.abort_now();
                return Err(CoreError::cancelled());
            }
            Ok(json!(connections.statuses()))
        })
    }
    #[napi]
    pub fn tools(&self) -> Vec<NativeExternalMcpTool> {
        let connections = self.owner.connections.lock().unwrap().clone();
        connections
            .map(|connections| {
                connections
                    .tools()
                    .into_iter()
                    .map(|tool| NativeExternalMcpTool {
                        tool: Arc::new(tool),
                        owner: self.owner.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    #[napi]
    pub fn disconnect(&self) {
        let connections = {
            let connections = self.owner.connections.lock().unwrap();
            self.owner
                .closed
                .store(true, std::sync::atomic::Ordering::Release);
            connections.clone()
        };
        if let Some(connections) = connections {
            connections.disconnect();
        }
    }
    #[napi]
    pub fn when_closed(&self, env: Env, callback: JsFunction) -> Result<JsObject> {
        let owner = self.owner.clone();
        host_callbacks::start(env, owner.bridge.callbacks.clone(), callback, async move {
            let connections = owner.connections.lock().unwrap().clone();
            if let Some(connections) = connections {
                connections.when_closed().await;
            }
            Ok(js::undefined())
        })
    }
    #[napi]
    pub fn abort(&self) {
        self.owner.abort();
    }
}

#[napi]
pub struct NativeExternalMcpTool {
    tool: Arc<ExternalTool>,
    owner: Arc<ExternalOwner>,
}
#[napi]
impl NativeExternalMcpTool {
    #[napi]
    pub fn descriptor(&self) -> Result<String> {
        encode(&self.tool.descriptor(&harness::baseline()))
    }
    #[napi]
    pub fn start(&self, env: Env, input: String, callback: JsFunction) -> Result<JsObject> {
        let input = decode(&input)?;
        let owner = self.owner.clone();
        let tool = self.tool.clone();
        host_callbacks::start(env, owner.bridge.callbacks.clone(), callback, async move {
            let _owner = owner;
            tool.execute(input, &harness::baseline()).await
        })
    }
}
