use crate::harness::{fixed_text, ResolvedHarness, ResourceId, TextId};
mod manager;
pub mod public_bridge;
pub mod public_client;
pub mod public_external;
pub mod public_transport;
pub(crate) mod rpc;
use super::{failure, utf16_prefix};
use crate::{
    bridge::HostBridge,
    error::{Error, Result},
};
pub use manager::{ConnectionFuture, ManagedTool, McpTools};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{oneshot, Mutex},
};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;
struct StdioConnection {
    input: Arc<Mutex<ChildStdin>>,
    process: Arc<crate::processes::OwnedProcess>,
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pending: Pending,
    reader: tokio::task::JoinHandle<()>,
    stderr: tokio::task::JoinHandle<()>,
}
struct PipeState {
    remaining: AtomicUsize,
    changed: tokio::sync::Notify,
}
struct PipeLease(Arc<PipeState>);
impl Drop for PipeLease {
    fn drop(&mut self) {
        self.0.remaining.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_waiters();
    }
}
struct HttpConnection {
    client: reqwest::Client,
    url: String,
    headers: Value,
    session_id: Mutex<Option<String>>,
    protocol_version: Mutex<Option<String>>,
    connected: AtomicBool,
}
enum Transport {
    Stdio(StdioConnection),
    Http(HttpConnection),
    Sse(super::mcp_sse::SseConnection),
    Host,
}
struct Connection {
    transport: Transport,
    next_id: AtomicU64,
    lifetime: CancellationToken,
    handler: Arc<rpc::RpcHandler>,
}
impl Connection {
    async fn open(
        bridge: Arc<dyn HostBridge>,
        processes: Arc<crate::processes::OwnedProcesses>,
        server: &str,
        config: &Value,
        options: &Value,
        cancel: &CancellationToken,
        hosted: bool,
        handler: Option<Arc<rpc::RpcHandler>>,
    ) -> Result<Arc<Self>> {
        let lifetime = handler
            .as_ref()
            .map(|handler| handler.cancellation.clone())
            .unwrap_or_else(CancellationToken::new);
        let handler = handler.unwrap_or_else(|| {
            Arc::new(rpc::RpcHandler {
                bridge: bridge.clone(),
                callback: options["onElicitation"]["__haloSdkNativeCallback"]
                    .as_str()
                    .map(str::to_owned),
                server: server.into(),
                cancellation: lifetime.clone(),
                requests: None,
            })
        });
        let transport = if hosted {
            Transport::Host
        } else if config["type"] == "sse" {
            Transport::Sse(
                tokio::time::timeout(
                    Duration::from_secs(15),
                    super::mcp_sse::SseConnection::connect(
                        config["url"].as_str().unwrap_or(""),
                        config["headers"].clone(),
                        cancel,
                        handler.clone(),
                    ),
                )
                .await
                .map_err(|_| {
                    Error::template("MCP_SSE_TIMEOUT", TextId::ToolsMcpSseConnectTimeout, &[])
                })??,
            )
        } else if config["type"] == "http" {
            Transport::Http(HttpConnection {
                client: reqwest::Client::new(),
                url: config["url"].as_str().unwrap_or("").into(),
                headers: config["headers"].clone(),
                session_id: Mutex::new(None),
                protocol_version: Mutex::new(None),
                connected: AtomicBool::new(true),
            })
        } else {
            let executable = config["command"].as_str().ok_or_else(|| {
                Error::template("MCP_CONFIG", TextId::ToolsMcpMissingCommand, &[])
            })?;
            let mut command = Command::new(executable);
            if let Some(args) = config["args"].as_array() {
                command.args(args.iter().filter_map(Value::as_str));
            }
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            if let Some(cwd) = config["cwd"].as_str() {
                command.current_dir(cwd);
            }
            let environment = crate::core::conventions::merged_environment(
                &crate::core::conventions::process_environment(options),
                &[&config["env"]],
                false,
            );
            command.env_clear().envs(environment);
            #[cfg(windows)]
            {
                command.creation_flags(0x08000000);
            }
            #[cfg(unix)]
            {
                command.process_group(0);
            }
            let mut child = command
                .spawn()
                .map_err(|e| Error::new("MCP_SPAWN", e.to_string()))?;
            let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let process = Arc::new(processes.track(child, cfg!(unix)));
            let pipes = Arc::new(PipeState {
                remaining: AtomicUsize::new(2),
                changed: tokio::sync::Notify::new(),
            });
            let observed = pipes.clone();
            let owned = process.clone();
            let resource_lease = bridge.resource_activity().map(|activity| activity.lease());
            let watcher = crate::runtime::spawn(async move {
                let _resource_lease = resource_lease;
                loop {
                    let notified = observed.changed.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if observed.remaining.load(Ordering::Acquire) == 0 {
                        break;
                    }
                    notified.await;
                }
                if let Err(error) = owned.wait().await {
                    tracing::warn!(error=%error,"MCP process exit could not be observed");
                }
            });
            let pending: Pending = Default::default();
            let read_pending = pending.clone();
            let read_input = input.clone();
            let reader_handler = handler.clone();
            let read_completion = PipeLease(pipes.clone());
            let reader = crate::runtime::spawn(async move {
                let _completion = read_completion;
                let mut lines = BufReader::new(stdout).lines();
                let mut callbacks = tokio::task::JoinSet::new();
                loop {
                    let line = tokio::select! {
                        line = lines.next_line() => match line { Ok(Some(line))=>line, Ok(None)=>break, Err(error)=>{tracing::warn!(error=%error,"MCP stdout read failed");break;} },
                        Some(result) = callbacks.join_next(), if !callbacks.is_empty() => { if let Err(error)=result { tracing::warn!(error=%error,"MCP callback task failed"); } continue; },
                    };
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) if value.get("method").is_some() && value.get("id").is_some() => {
                            let handler = reader_handler.clone();
                            let input = read_input.clone();
                            callbacks.spawn(async move {
                                let response = handler.answer(value).await;
                                if crate::js::is_undefined(&response) { return; }
                                let encoded = format!("{}\n",serde_json::to_string(&response).unwrap());
                                if let Err(error)=input.lock().await.write_all(encoded.as_bytes()).await { tracing::warn!(error=%error,"MCP request response could not be delivered"); }
                            }.with_current_subscriber());
                        }
                        Ok(value) => {
                            if let Some(id) = rpc_id(&value["id"]) {
                                if let Some(tx) = read_pending.lock().await.remove(&id) {
                                    let _ = tx.send(Ok(value));
                                }
                            }
                        }
                        Err(error) => {
                            tracing::warn!(error=%error,"MCP stdout contained malformed JSON")
                        }
                    }
                }
                for (_, tx) in read_pending.lock().await.drain() {
                    let _ = tx.send(Err(Error::template(
                        "MCP_CLOSED",
                        TextId::ToolsMcpConnectionClosed,
                        &[],
                    )));
                }
            });
            let stderr_completion = PipeLease(pipes);
            let stderr = crate::runtime::spawn(async move {
                let _completion = stderr_completion;
                let mut reader = BufReader::new(stderr);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match reader.read_until(b'\n', &mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
            });
            Transport::Stdio(StdioConnection {
                input,
                process,
                watcher: Mutex::new(Some(watcher)),
                pending,
                reader,
                stderr,
            })
        };
        Ok(Arc::new(Connection {
            transport,
            next_id: AtomicU64::new(1),
            lifetime,
            handler,
        }))
    }
    fn abort_now(&self) {
        self.lifetime.cancel();
        match &self.transport {
            Transport::Stdio(connection) => {
                connection.process.abort_now();
                connection.reader.abort();
                connection.stderr.abort();
            }
            Transport::Http(connection) => {
                connection.connected.store(false, Ordering::Release);
            }
            Transport::Sse(connection) => connection.abort_now(),
            Transport::Host => {}
        }
    }
    fn connected(&self) -> bool {
        !self.lifetime.is_cancelled()
            && match &self.transport {
                Transport::Stdio(connection) => !connection.reader.is_finished(),
                Transport::Http(connection) => connection.connected.load(Ordering::Acquire),
                Transport::Sse(connection) => connection.connected(),
                Transport::Host => true,
            }
    }
    async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut payload = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        if method == "tools/list" {
            payload.as_object_mut().unwrap().remove("params");
        }
        rpc_result(self.send(payload, cancel, true).await?)
    }
    async fn send(
        self: &Arc<Self>,
        payload: Value,
        cancel: &CancellationToken,
        cancellation_notice: bool,
    ) -> Result<Value> {
        let _request_activity = if matches!(self.transport, Transport::Http(_)) {
            self.handler
                .bridge
                .resource_activity()
                .map(|activity| activity.lease())
        } else {
            None
        };
        let id = payload["id"].clone();
        let key =
            rpc_id(&id).ok_or_else(|| Error::template("MCP_ID", TextId::ToolsMcpMissingId, &[]))?;
        let method = payload["method"].as_str().unwrap_or("").to_owned();
        let call = async {
            match &self.transport {
                Transport::Stdio(connection) => {
                    let (tx, rx) = oneshot::channel();
                    connection.pending.lock().await.insert(key.clone(), tx);
                    let encoded = serde_json::to_vec(&payload)?;
                    let write = async {
                        let mut input = connection.input.lock().await;
                        input.write_all(&encoded).await?;
                        input.write_all(b"\n").await?;
                        input.flush().await
                    };
                    if let Err(e) = write.await {
                        connection.pending.lock().await.remove(&key);
                        return Err(Error::new("MCP_WRITE", e.to_string()));
                    }
                    let value = rx.await.map_err(|_| {
                        Error::template("MCP_CLOSED", TextId::ToolsMcpConnectionClosed, &[])
                    })??;
                    Ok(value)
                }
                Transport::Http(connection) => {
                    let mut request = connection
                        .client
                        .post(&connection.url)
                        .header("Accept", "application/json, text/event-stream")
                        .header("Content-Type", "application/json")
                        .json(&payload);
                    if let Some(headers) = connection.headers.as_object() {
                        for (k, v) in headers {
                            if let Some(v) = v.as_str() {
                                request = request.header(k, v);
                            }
                        }
                    }
                    if let Some(session) = connection.session_id.lock().await.as_ref() {
                        request = request.header("Mcp-Session-Id", session);
                    }
                    if let Some(version) = connection.protocol_version.lock().await.as_ref() {
                        request = request.header("MCP-Protocol-Version", version);
                    }
                    let response = request
                        .send()
                        .await
                        .map_err(|e| Error::new("MCP_HTTP", e.to_string()))?;
                    if method == "initialize" {
                        *connection.session_id.lock().await = response
                            .headers()
                            .get("mcp-session-id")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                    }
                    if !response.status().is_success() {
                        if response.status().as_u16() == 404
                            && connection.session_id.lock().await.is_some()
                        {
                            connection.connected.store(false, Ordering::Release);
                        }
                        return Err(Error::template(
                            "MCP_HTTP",
                            TextId::ToolsMcpHttpError,
                            &[
                                ("status", response.status().as_u16().to_string().into()),
                                (
                                    "reason",
                                    response.status().canonical_reason().unwrap_or("").into(),
                                ),
                            ],
                        ));
                    }
                    let event_stream = response
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|v| v.contains("text/event-stream"));
                    let value: Value = if event_stream {
                        super::mcp_sse::response_message(
                            response,
                            id.clone(),
                            self.handler.clone(),
                            super::mcp_sse::ReplyTarget {
                                client: connection.client.clone(),
                                endpoint: connection.url.clone(),
                                headers: connection.headers.clone(),
                                session_id: connection.session_id.lock().await.clone(),
                                protocol_version: connection.protocol_version.lock().await.clone(),
                                lifetime: self.lifetime.clone(),
                                activity: self.handler.bridge.resource_activity(),
                            },
                        )
                        .await?
                    } else {
                        let body = response
                            .text()
                            .await
                            .map_err(|e| Error::new("MCP_HTTP", e.to_string()))?;
                        serde_json::from_str(&body)?
                    };
                    if method == "initialize" {
                        *connection.protocol_version.lock().await = value["result"]
                            ["protocolVersion"]
                            .as_str()
                            .map(str::to_owned);
                    }
                    Ok(value)
                }
                Transport::Sse(connection) => connection.request(&payload, cancel).await,
                Transport::Host => Err(Error::template(
                    "MCP_BRIDGE",
                    TextId::ToolsMcpBridgeRequired,
                    &[],
                )),
            }
        };
        let deadline = tokio::time::sleep(Duration::from_secs(30));
        let result = tokio::select! {
            result=call=>result,
            _=cancel.cancelled()=>Err(Error::template("MCP_CANCELLED", TextId::ToolsMcpCancelled, &[])),
            _=self.lifetime.cancelled()=>Err(Error::template("MCP_CLOSED", if matches!(self.transport,Transport::Http(_)){TextId::ToolsMcpHttpTransportClosed}else{TextId::ToolsMcpTransportClosed}, &[])),
            _=deadline=>Err(if matches!(self.transport,Transport::Http(_)){Error::template("MCP_TIMEOUT",TextId::ToolsMcpHttpTimedOut,&[])}else{Error::template("MCP_TIMEOUT", TextId::ToolsMcpTimeout, &[("method", method.clone().into()), ("id", crate::js::stringify(&id).into())])}),
        };
        if cancellation_notice
            && cancel.is_cancelled()
            && !self.lifetime.is_cancelled()
            && method == "tools/call"
        {
            let owner = self.clone();
            crate::runtime::spawn(async move {
                let notification = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":fixed_text(ResourceId::McpProtocol, &["cancelled_reason"])}});
                match tokio::time::timeout(
                    Duration::from_millis(1500),
                    owner.notify_payload(notification),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    _ => {
                        tracing::warn!(server=%owner.handler.server,"Tool cancellation could not be delivered")
                    }
                }
            });
        }
        if let Transport::Stdio(c) = &self.transport {
            c.pending.lock().await.remove(&key);
        }
        result
    }
    async fn notify(&self, method: &str) -> Result<()> {
        self.notify_payload(json!({"jsonrpc":"2.0","method":method}))
            .await
    }
    async fn notify_payload(&self, payload: Value) -> Result<()> {
        match &self.transport {
            Transport::Stdio(c) => {
                let mut input = c.input.lock().await;
                input
                    .write_all(format!("{}\n", serde_json::to_string(&payload)?).as_bytes())
                    .await?;
            }
            Transport::Http(c) => {
                let _request_activity = self
                    .handler
                    .bridge
                    .resource_activity()
                    .map(|activity| activity.lease());
                let mut req = c
                    .client
                    .post(&c.url)
                    .header("Accept", "application/json, text/event-stream")
                    .json(&payload);
                if let Some(headers) = c.headers.as_object() {
                    for (k, v) in headers {
                        if let Some(v) = v.as_str() {
                            req = req.header(k, v);
                        }
                    }
                }
                if let Some(session) = c.session_id.lock().await.as_ref() {
                    req = req.header("Mcp-Session-Id", session);
                }
                if let Some(version) = c.protocol_version.lock().await.as_ref() {
                    req = req.header("MCP-Protocol-Version", version);
                }
                let response = tokio::select! {
                    result=req.send()=>result.map_err(|error|Error::new("MCP_HTTP",error.to_string()))?,
                    _=self.lifetime.cancelled()=>return Err(Error::template("MCP_CLOSED",TextId::ToolsMcpHttpTransportClosed,&[])),
                    _=tokio::time::sleep(Duration::from_secs(30))=>return Err(Error::template("MCP_TIMEOUT",TextId::ToolsMcpHttpTimedOut,&[])),
                };
                if !response.status().is_success() {
                    return Err(Error::template(
                        "MCP_HTTP",
                        TextId::ToolsMcpHttpNotificationFailed,
                        &[("status", response.status().as_u16().to_string().into())],
                    ));
                }
            }
            Transport::Sse(connection) => connection.notify(&payload).await?,
            Transport::Host => {}
        }
        Ok(())
    }
    async fn close(&self) {
        let _retirement_activity = if matches!(self.transport, Transport::Http(_)) {
            self.handler
                .bridge
                .resource_activity()
                .map(|activity| activity.lease())
        } else {
            None
        };
        self.lifetime.cancel();
        if let Transport::Http(connection) = &self.transport {
            connection.connected.store(false, Ordering::Release);
            let session = connection.session_id.lock().await.take();
            if let Some(session) = session {
                let mut request = connection
                    .client
                    .delete(&connection.url)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream");
                if let Some(headers) = connection.headers.as_object() {
                    for (name, value) in headers {
                        if let Some(value) = value.as_str() {
                            request = request.header(name, value);
                        }
                    }
                }
                request = request.header("Mcp-Session-Id", session);
                if let Some(version) = connection.protocol_version.lock().await.take() {
                    request = request.header("MCP-Protocol-Version", version);
                }
                match tokio::time::timeout(Duration::from_millis(1500), request.send()).await {
                    Ok(Ok(response))
                        if response.status().is_success()
                            || [404, 405].contains(&response.status().as_u16()) => {}
                    Ok(Ok(response)) => tracing::warn!(
                        status = response.status().as_u16(),
                        "HTTP session retirement refused"
                    ),
                    _ => tracing::warn!("HTTP session retirement could not be confirmed"),
                }
            }
        }
        if let Transport::Sse(connection) = &self.transport {
            connection.close().await;
        }
        if let Transport::Stdio(c) = &self.transport {
            c.process.terminate(false).await;
            if let Some(mut watcher) = c.watcher.lock().await.take() {
                if tokio::time::timeout(Duration::from_secs(5), &mut watcher)
                    .await
                    .is_err()
                {
                    c.process.abort_now();
                    let _ = watcher.await;
                }
            }
            c.reader.abort();
            c.stderr.abort();
            let mut pending = c.pending.lock().await;
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err(Error::template(
                    "MCP_CLOSED",
                    TextId::ToolsMcpConnectionClosed,
                    &[],
                )));
            }
        }
    }
}
pub(super) fn rpc_id(value: &Value) -> Option<String> {
    value.is_number().then(|| crate::js::stringify(value))
}
fn rpc_result(value: Value) -> Result<Value> {
    if let Some(error) = value.get("error") {
        Err(match error["message"].as_str() {
            Some(message) => Error::new("MCP_RPC", message),
            None => Error::template("MCP_RPC", TextId::ToolsMcpRequestFailed, &[]),
        })
    } else {
        Ok(value["result"].clone())
    }
}
#[derive(Clone)]
pub struct McpTool {
    pub definition: Value,
    pub server: String,
    pub original: String,
    pub readonly: bool,
    pub idempotent: bool,
    pub fingerprint: String,
    pub mcp_source: Value,
    pub hosted: bool,
}
impl McpTool {
    pub fn definition_with_harness(&self, harness: &ResolvedHarness) -> Value {
        let mut definition = self.definition.clone();
        let description = self.mcp_source["toolDescription"].as_str().unwrap_or("");
        if description.encode_utf16().count() > 2048 {
            definition["description"] = json!(harness.render(
                TextId::ToolsMcpDescriptionTruncated,
                &[("description", &utf16_prefix(description, 2048))]
            ));
        }
        definition
    }
}
pub(super) struct Snapshot {
    bridge: Arc<dyn HostBridge>,
    connections: HashMap<String, Arc<Connection>>,
    pub tools: Vec<McpTool>,
    pub instructions: Vec<String>,
    processes: Arc<crate::processes::OwnedProcesses>,
}
impl Snapshot {
    pub fn new(
        bridge: Arc<dyn HostBridge>,
        processes: Arc<crate::processes::OwnedProcesses>,
    ) -> Self {
        Self {
            bridge,
            connections: HashMap::new(),
            tools: Vec::new(),
            instructions: Vec::new(),
            processes,
        }
    }
    pub(super) async fn connect(
        &mut self,
        server: &str,
        config: &Value,
        options: &Value,
        cancel: &CancellationToken,
        hosted: bool,
    ) -> Result<()> {
        let connection = Connection::open(
            self.bridge.clone(),
            self.processes.clone(),
            server,
            config,
            options,
            cancel,
            hosted,
            None,
        )
        .await?;
        self.connections.insert(server.into(), connection.clone());
        let result = async {
            let mut service_description = config["description"].as_str().or_else(||config["instance"]["description"].as_str()).map(str::to_owned);
            let mut service_instructions = config["instructions"].as_str().or_else(||config["instance"]["instructions"].as_str()).map(str::to_owned);
            let model_server = if hosted { config["name"].as_str().unwrap_or(server) } else { server };
            let tools = if hosted {
                if let Some(tools) = config["instance"].get("tools").or_else(||config.get("tools")).filter(|v|v.is_array()) {
                    tools.clone()
                } else {
                    let value = self.bridge.call("mcp.list", json!({"server":server}), cancel).await?;
                    if value.is_array() { value } else { value["tools"].clone() }
                }
            } else {
                let mut capabilities = json!({"roots":{"listChanged":false}});
                if options["onElicitation"]["__haloSdkNativeCallback"].is_string() { capabilities["elicitation"] = json!({}); }
                let init = connection.request("initialize", json!({"protocolVersion":"2024-11-05","capabilities":capabilities,"clientInfo":{"name":"agent-sdk","version":"1.0.0"}}), cancel).await.map_err(|error| if error.code=="MCP_RPC" {Error::template("MCP_INITIALIZE",TextId::ToolsMcpInitializeFailed,&[("server",server.into()),("error",error.as_harness_message())])}else{error})?;
                service_description = init["serverInfo"]["description"].as_str().map(str::to_owned);
                service_instructions = init["instructions"].as_str().map(str::to_owned);
                if let Some(instructions) = init["instructions"].as_str() { self.instructions.push(instructions.into()); }
                connection.notify("notifications/initialized").await?;
                if crate::js::truthy(&init["capabilities"]["tools"]) {
                    match connection.request("tools/list", json!({}), cancel).await {
                        Ok(page) => page["tools"].clone(),
                        Err(error) if error.code=="MCP_RPC" => { tracing::warn!(server,error=%error,"tools/list failed"); json!([]) }
                        Err(error)=>return Err(error),
                    }
                } else { json!([]) }
            };
            if let Some(instructions) = config["instructions"].as_str().or_else(||config["instance"]["instructions"].as_str()) { self.instructions.push(instructions.into()); }
            let mut names = std::collections::HashSet::new();
            if let Some(tools) = tools.as_array() {
                for tool in tools {
                    let original = tool["name"].as_str().unwrap_or("").to_owned();
                    let name = format!("mcp__{}__{}", normalize(model_server), normalize(&original));
                    if !names.insert(name.clone()) { return Err(Error::template("MCP_IDENTITY_COLLISION", TextId::ToolsMcpIdentityCollision, &[("name", name.into())])); }
                    let desc = tool["description"].as_str().unwrap_or("");
                    let description = if desc.encode_utf16().count()>2048 { crate::harness::baseline().render(TextId::ToolsMcpDescriptionTruncated, &[("description", &utf16_prefix(desc,2048))]) } else { desc.to_owned() };
                    let description_value=service_description.as_ref().map(|value|json!(value)).unwrap_or_else(crate::js::undefined);
                    let instructions_value=service_instructions.as_ref().map(|value|json!(value)).unwrap_or_else(crate::js::undefined);
                    let source=if hosted {json!({"server":server,"description":description_value,"instructions":instructions_value,"name":original,"toolDescription":desc})}else{json!({"server":server,"name":original,"description":description_value,"instructions":instructions_value,"toolDescription":desc})};
                    self.tools.push(McpTool {
                        definition: json!({"name":name,"description":description,"input_schema":tool["inputSchema"]}),
                        server: server.into(), original: original.clone(),
                        readonly: tool["annotations"]["readOnlyHint"] == true,
                        idempotent: tool["annotations"]["idempotentHint"] == true,
                        fingerprint: fingerprint(&json!({"name":original,"description":desc,"inputSchema":tool["inputSchema"],"annotations":tool["annotations"],"descriptionOfService":service_description.as_deref().unwrap_or(""),"instructions":service_instructions.as_deref().unwrap_or("")})),
                        mcp_source: source,
                        hosted,
                    });
                }
            }
            Ok(())
        }.await;
        if result.is_ok() {
            self.connections.insert(server.into(), connection);
        } else {
            connection.lifetime.cancel();
        }
        result
    }
    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
        harness: &ResolvedHarness,
    ) -> Result<Value> {
        let tool = self
            .tools
            .iter()
            .find(|t| t.definition["name"] == name)
            .ok_or_else(|| Error::template("MCP_TOOL", TextId::ToolsMcpUnknownMcpTool, &[]))?;
        let connection = self
            .connections
            .get(&tool.server)
            .ok_or_else(|| Error::template("MCP_CLOSED", TextId::ToolsMcpNotConnected, &[]))?;
        let result = match &connection.transport {
            Transport::Host => {
                self.bridge
                    .call(
                        "mcp.call",
                        json!({"server":tool.server,"name":tool.original,"input":input}),
                        cancel,
                    )
                    .await?
            }
            _ => {
                match connection
                    .request(
                        "tools/call",
                        json!({"name":tool.original,"arguments":input}),
                        cancel,
                    )
                    .await
                {
                    Ok(result) if result.is_null() || crate::js::is_undefined(&result) => {
                        json!({"content":[{"type":"text","text":""}],"isError":false})
                    }
                    Ok(result) => result,
                    Err(error) if error.code == "MCP_RPC" => {
                        return Ok(failure(harness.render(
                            TextId::ToolsMcpToolError,
                            &[
                                ("server", &tool.server),
                                ("tool", &tool.original),
                                ("error", &error.render_for(harness)),
                            ],
                        )))
                    }
                    Err(error) => return Err(error),
                }
            }
        };
        if !crate::js::truthy(&result) {
            return Ok(failure(harness.render(
                TextId::ToolsMcpToolNotFound,
                &[("tool", &tool.original), ("server", &tool.server)],
            )));
        }
        Ok(format_result_with_harness(&result, harness))
    }
    pub(super) fn hosted(&self) -> bool {
        self.connections
            .values()
            .all(|connection| matches!(connection.transport, Transport::Host))
    }
    pub(super) fn connected(&self) -> bool {
        self.connections
            .values()
            .all(|connection| connection.connected())
    }
    pub async fn close(&self) {
        for connection in self.connections.values() {
            connection.close().await;
        }
    }
    pub(super) fn begin_close(&self) {
        for connection in self.connections.values() {
            connection.lifetime.cancel();
        }
    }
    pub(super) fn retirement_lease(&self) -> Option<crate::resource_activity::ResourceLease> {
        self.connections
            .values()
            .any(|connection| matches!(connection.transport, Transport::Http(_)))
            .then(|| {
                self.bridge
                    .resource_activity()
                    .map(|activity| activity.lease())
            })
            .flatten()
    }
    pub(super) fn retirement_requires_wait(&self) -> bool {
        self.connections
            .values()
            .any(|connection| matches!(connection.transport, Transport::Http(_)))
    }
    pub fn abort_now(&self) {
        for connection in self.connections.values() {
            connection.abort_now();
        }
    }
}
fn normalize(name: &str) -> String {
    name.encode_utf16()
        .map(|c| {
            if c <= 127
                && ((c as u8).is_ascii_alphanumeric() || c == b'_' as u16 || c == b'-' as u16)
            {
                c as u8 as char
            } else {
                '_'
            }
        })
        .collect()
}
pub fn format_result(result: &Value) -> Value {
    format_result_with_harness(result, &crate::harness::baseline())
}
const MAX_MCP_IMAGE_BASE64_CHARS: usize = 6_990_508;
const MAX_MCP_IMAGE_BYTES: usize = 5_242_880;
const MAX_MCP_IMAGES: usize = 5;

fn supported_image_mime(mime: &str) -> bool {
    ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime)
}

fn decoded_image_bytes(length: usize, units: impl Iterator<Item = u16>) -> Option<usize> {
    if length == 0 || length % 4 != 0 {
        return None;
    }
    let mut padding = 0;
    for unit in units {
        if unit == b'=' as u16 {
            padding += 1;
            if padding > 2 { return None; }
        } else if padding != 0 || unit > 127
            || !((unit as u8).is_ascii_alphanumeric() || unit == b'+' as u16 || unit == b'/' as u16)
        {
            return None;
        }
    }
    Some(length / 4 * 3 - padding)
}

pub fn format_result_with_harness(result: &Value, harness: &ResolvedHarness) -> Value {
    let mut text = Vec::new();
    let mut images = Vec::new();
    if let Some(blocks) = result["content"].as_array() {
        for block in blocks {
            match block["type"].as_str() {
                Some("text") if block["text"].is_string() => {
                    text.push(block["text"].as_str().unwrap().to_owned())
                }
                Some("image") => {
                    let mime = &block["mimeType"];
                    let mime_text = mime.as_str().unwrap_or("");
                    let mime_json = if crate::js::is_undefined(mime) {
                        "null".into()
                    } else {
                        crate::js::stringify(mime)
                    };
                    let Some(data) = block["data"].as_str() else {
                        text.push(
                            harness
                                .render(TextId::ToolsMcpImageMissingData, &[("mime", &mime_json)]),
                        );
                        tracing::warn!("MCP image rejected: missing data");
                        continue;
                    };
                    if !supported_image_mime(mime_text) {
                        text.push(
                            harness
                                .render(TextId::ToolsMcpImageInvalidMime, &[("mime", &mime_json)]),
                        );
                        tracing::warn!("MCP image rejected: unsupported MIME type");
                    } else {
                        let chars = data.encode_utf16().count();
                        let bytes = decoded_image_bytes(chars, data.encode_utf16());
                        if chars > MAX_MCP_IMAGE_BASE64_CHARS || bytes.is_some_and(|bytes| bytes > MAX_MCP_IMAGE_BYTES) {
                            text.push(
                                harness.render(TextId::ToolsMcpImageLimit, &[("mime", mime_text)]),
                            );
                            tracing::warn!("MCP image rejected: size limit");
                        } else if bytes.is_none() {
                            text.push(harness.render(
                                TextId::ToolsMcpImageInvalidBase64,
                                &[("mime", mime_text)],
                            ));
                            tracing::warn!("MCP image rejected: invalid base64");
                        } else if images.len() >= MAX_MCP_IMAGES {
                            text.push(harness.text(TextId::ToolsMcpImageCount).into());
                            tracing::warn!("MCP image rejected: per-result count limit");
                        } else {
                            images.push(json!({"mimeType":mime,"data":data}));
                            text.push(
                                harness.render(TextId::ToolsMcpImage, &[("mime", mime_text)]),
                            );
                        }
                    }
                }
                _ => text.push(crate::js::stringify(block)),
            }
        }
    }
    let mut output =
        json!({"content":text.join("\n"),"isError":result["isError"].as_bool().unwrap_or(false)});
    if !images.is_empty() {
        output["images"] = Value::Array(images);
    }
    output
}

fn fingerprint(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                let mut out = serde_json::Map::new();
                for key in keys {
                    out.insert(key.clone(), sorted(&map[key]));
                }
                Value::Object(out)
            }
            Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
            _ => value.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&sorted(value)).unwrap())
    )
}
