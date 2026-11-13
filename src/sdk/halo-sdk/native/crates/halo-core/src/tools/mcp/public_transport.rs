use super::{rpc::RpcHandler, Connection, Transport};
use crate::{
    bridge::HostBridge,
    error::{Error, Result},
    harness::TextId,
};
use futures::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
};
use tokio_util::sync::CancellationToken;

type Opening = Shared<BoxFuture<'static, Result<Arc<Connection>>>>;
struct Attempt {
    revision: u64,
    cancel: CancellationToken,
    future: Opening,
}
struct PendingConnection(Option<Arc<Connection>>);
impl Drop for PendingConnection {
    fn drop(&mut self) {
        if let Some(connection) = self.0.take() {
            connection.abort_now();
        }
    }
}
pub struct PublicTransport {
    config: Value,
    options: Value,
    bridge: Arc<dyn HostBridge>,
    processes: Arc<crate::processes::OwnedProcesses>,
    handlers: Arc<RwLock<HashMap<String, String>>>,
    connection: RwLock<Option<Arc<Connection>>>,
    opening: Mutex<Option<Attempt>>,
    revision: AtomicU64,
    retired: Mutex<Vec<Shared<BoxFuture<'static, ()>>>>,
}
impl PublicTransport {
    pub fn new(config: Value, options: Value, bridge: Arc<dyn HostBridge>) -> Self {
        Self {
            config,
            options,
            bridge,
            processes: Arc::new(crate::processes::OwnedProcesses::default()),
            handlers: Arc::new(RwLock::new(HashMap::new())),
            connection: RwLock::new(None),
            opening: Mutex::new(None),
            revision: AtomicU64::new(0),
            retired: Mutex::new(Vec::new()),
        }
    }
    pub fn set_request_handler(&self, method: String, callback: String) {
        self.handlers.write().unwrap().insert(method, callback);
    }
    pub fn connected(&self) -> bool {
        self.connection
            .read()
            .unwrap()
            .as_ref()
            .is_some_and(|connection| connection.connected())
    }
    fn cancelled(&self) -> Error {
        if self.config["type"] == "stdio" {
            return Error::template(
                "MCP_CONNECT_CANCELLED",
                TextId::ToolsMcpClosedDuringConnection,
                &[],
            );
        }
        if self.config["type"] == "sse" {
            return Error::template(
                "MCP_CONNECT_CANCELLED",
                TextId::ToolsMcpSseConnectionAborted,
                &[],
            )
            .with_details(serde_json::json!({"name":"AbortError","code":"ABORT_ERR"}));
        }
        Error::template(
            "MCP_CONNECT_CANCELLED",
            TextId::ToolsMcpConnectionCancelled,
            &[("transport", "HTTP".into())],
        )
    }
    fn begin_connect(&self) -> Option<(u64, Opening)> {
        if self.connected() {
            return None;
        }
        let prepared = {
            let mut opening = self.opening.lock().unwrap();
            if let Some(opening) = opening.as_ref() {
                (opening.revision, opening.future.clone())
            } else {
                let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
                let cancel = CancellationToken::new();
                let bridge = self.bridge.clone();
                let processes = self.processes.clone();
                let config = self.config.clone();
                let options = self.options.clone();
                let handler = Arc::new(RpcHandler {
                    bridge: bridge.clone(),
                    callback: None,
                    server: String::new(),
                    cancellation: CancellationToken::new(),
                    requests: Some(self.handlers.clone()),
                });
                let caller = cancel.clone();
                let retirement = if self.config["type"] == "http" {
                    self.retired.lock().unwrap().clone()
                } else {
                    Vec::new()
                };
                let future = async move {
                    futures::future::join_all(retirement).await;
                    if caller.is_cancelled() {
                        return Err(Error::cancelled());
                    }
                    let result = Connection::open(
                        bridge.clone(),
                        processes,
                        "",
                        &config,
                        &options,
                        &caller,
                        false,
                        Some(handler),
                    )
                    .await;
                    let mut pending = PendingConnection(result.as_ref().ok().cloned());
                    if config["nativeHostConnectionEvents"] == true {
                        if let Err(error) = bridge
                            .call("mcp.connectionReady", Value::Null, &caller)
                            .await
                        {
                            if let Some(connection) = pending.0.as_ref() {
                                connection.close().await;
                            }
                            return Err(error);
                        }
                    }
                    pending.0.take();
                    result
                }
                .boxed()
                .shared();
                *opening = Some(Attempt {
                    revision,
                    cancel,
                    future: future.clone(),
                });
                (revision, future)
            }
        };
        Some(prepared)
    }
    async fn finish_connect(&self, prepared: Option<(u64, Opening)>) -> Result<()> {
        let Some((revision,future))=prepared else {return Ok(());};
        let result = future.await;
        let current = {
            let mut opening = self.opening.lock().unwrap();
            if opening
                .as_ref()
                .is_some_and(|attempt| attempt.revision == revision)
            {
                opening.take();
            }
            let current = self.revision.load(Ordering::Acquire) == revision;
            if current {
                if let Ok(connection) = &result {
                    *self.connection.write().unwrap() = Some(connection.clone());
                }
            }
            current
        };
        match result {
            Ok(_) if current => Ok(()),
            Ok(connection) => {
                connection.close().await;
                Err(self.cancelled())
            }
            Err(_) if !current => Err(self.cancelled()),
            Err(error) => Err(error),
        }
    }
    pub fn connect(&self) -> impl std::future::Future<Output = Result<()>> + Send + '_ {
        let prepared = self.begin_connect();
        self.finish_connect(prepared)
    }
    pub fn prepare_connect(self: &Arc<Self>) -> BoxFuture<'static, Result<()>> {
        let prepared = self.begin_connect();
        let owner = self.clone();
        async move { owner.finish_connect(prepared).await }.boxed()
    }
    fn connection(&self) -> Result<Arc<Connection>> {
        self.connection
            .read()
            .unwrap()
            .clone()
            .filter(|connection| connection.connected())
            .ok_or_else(|| {
                Error::template(
                    "MCP_NOT_CONNECTED",
                    if self.config["type"] == "http" {
                        TextId::ToolsMcpHttpNotConnected
                    } else if self.config["type"] == "sse" {
                        TextId::ToolsMcpSseNotConnected
                    } else {
                        TextId::ToolsMcpStdioNotConnected
                    },
                    &[],
                )
            })
    }
    pub async fn send(&self, request: Value, cancel: &CancellationToken) -> Result<Value> {
        let connection = self.connection()?;
        let uncancelled = CancellationToken::new();
        connection
            .send(
                request,
                if matches!(connection.transport, Transport::Http(_)) {
                    cancel
                } else {
                    &uncancelled
                },
                false,
            )
            .await
    }
    pub async fn notify(&self, notification: Value) -> Result<()> {
        self.connection()?.notify_payload(notification).await
    }
    pub fn close(&self) -> Result<()> {
        let mut opening = self.opening.lock().unwrap();
        self.revision.fetch_add(1, Ordering::AcqRel);
        let attempt = opening.take();
        let connection = self.connection.write().unwrap().take();
        drop(opening);
        if let Some(attempt) = attempt {
            attempt.cancel.cancel();
        }
        if let Some(connection) = connection {
            let resource_lease = if matches!(connection.transport, Transport::Http(_)) {
                self.bridge
                    .resource_activity()
                    .map(|activity| activity.lease())
            } else {
                None
            };
            connection.lifetime.cancel();
            let close = async move {
                let _resource_lease = resource_lease;
                connection.close().await
            }
            .boxed()
            .shared();
            let mut retired = self.retired.lock().unwrap();
            retired.retain(|future| future.peek().is_none());
            retired.push(close.clone());
            drop(retired);
            crate::runtime::shared()?.spawn(close);
        }
        Ok(())
    }
    pub async fn when_closed(&self) {
        let retired = self.retired.lock().unwrap().clone();
        futures::future::join_all(retired).await;
    }
    pub fn abort_now(&self) {
        let mut opening = self.opening.lock().unwrap();
        self.revision.fetch_add(1, Ordering::AcqRel);
        let attempt = opening.take();
        let connection = self.connection.write().unwrap().take();
        drop(opening);
        if let Some(attempt) = attempt {
            attempt.cancel.cancel();
        }
        if let Some(connection) = connection {
            connection.abort_now();
        }
        self.processes.abort_now();
    }
}
impl Drop for PublicTransport {
    fn drop(&mut self) {
        self.abort_now();
    }
}
