use super::{McpTool, Snapshot};
use crate::harness::{ResolvedHarness, TextId};
use crate::{
    bridge::HostBridge,
    error::{Error, Result},
    tools::failure,
};
use futures::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, RwLock,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct Server {
    name: String,
    hosted: bool,
    config: RwLock<Value>,
    config_revision: AtomicU64,
    generation: AtomicU64,
    snapshot: RwLock<Option<Arc<Snapshot>>>,
    error: RwLock<Option<Error>>,
    serial: tokio::sync::Mutex<()>,
    attempt: Mutex<CancellationToken>,
    reconnect: Mutex<Option<CancellationToken>>,
    live: RwLock<LiveState>,
    binding: Mutex<()>,
    prepared: Mutex<Option<(u64, ConnectionFuture)>>,
}
pub type ConnectionFuture = Shared<BoxFuture<'static, Result<()>>>;
struct ServerUpdates {
    remaining: std::vec::IntoIter<(String, Value)>,
    added: Vec<String>,
    removed: Vec<String>,
    errors: Vec<(String, Error)>,
}
impl ServerUpdates {
    fn result(self, harness: &ResolvedHarness) -> Value {
        let errors: serde_json::Map<String, Value> = self
            .errors
            .into_iter()
            .map(|(name, error)| (name, json!(error.render_for(harness))))
            .collect();
        json!({"added":self.added,"removed":self.removed,"errors":errors})
    }
}
#[derive(Clone)]
enum LiveState {
    Disconnected,
    Connecting,
    Connected(usize),
    Retry(i64),
}
impl Server {
    fn new(name: String, config: Value, hosted: bool) -> Self {
        Self {
            name,
            hosted,
            config: RwLock::new(config),
            config_revision: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            snapshot: RwLock::new(None),
            error: RwLock::new(None),
            serial: tokio::sync::Mutex::new(()),
            attempt: Mutex::new(CancellationToken::new()),
            reconnect: Mutex::new(None),
            live: RwLock::new(LiveState::Disconnected),
            binding: Mutex::new(()),
            prepared: Mutex::new(None),
        }
    }
}
struct State {
    catalog: RwLock<()>,
    bridge: Arc<dyn HostBridge>,
    options: RwLock<Value>,
    servers: RwLock<IndexMap<String, Arc<Server>>>,
    hosted: RwLock<IndexMap<String, Arc<Server>>>,
    revision: AtomicU64,
    disposed: AtomicBool,
    processes: Arc<crate::processes::OwnedProcesses>,
    retired: Mutex<Vec<Retirement>>,
    preparations: AtomicUsize,
    settled: tokio::sync::Notify,
}
#[derive(Clone)]
struct Retirement {
    future: Shared<BoxFuture<'static, ()>>,
    logical: bool,
}
#[derive(Clone)]
pub struct McpTools {
    state: Arc<State>,
}
struct Preparation(Arc<State>);
impl Drop for Preparation {
    fn drop(&mut self) {
        self.0.preparations.fetch_sub(1, Ordering::AcqRel);
        self.0.settled.notify_waiters();
    }
}
#[derive(Clone)]
pub struct ManagedTool {
    manager: McpTools,
    server: Arc<Server>,
    tool: McpTool,
    config_revision: u64,
}
impl ManagedTool {
    pub fn definition(&self, harness: &ResolvedHarness) -> Value {
        let mut definition = self.tool.definition_with_harness(harness);
        definition["mcpSource"] = self.tool.mcp_source.clone();
        definition
    }
    pub fn descriptor(&self, harness: &ResolvedHarness) -> Value {
        let definition = self.definition(harness);
        json!({"name":definition["name"],"description":definition["description"],"inputSchema":definition["input_schema"],"mcpSource":definition["mcpSource"],"permissionLevel":"execute"})
    }
    pub async fn execute(
        &self,
        input: Value,
        cancel: &CancellationToken,
        harness: &ResolvedHarness,
    ) -> Result<Value> {
        self.manager
            .execute_bound(
                &self.tool,
                self.server.clone(),
                self.config_revision,
                input,
                cancel,
                harness,
                None,
            )
            .await
    }
    pub async fn execute_with_initial_error(
        &self,
        input: Value,
        cancel: &CancellationToken,
        harness: &ResolvedHarness,
        error: Option<Error>,
    ) -> Result<Value> {
        self.manager
            .execute_bound(
                &self.tool,
                self.server.clone(),
                self.config_revision,
                input,
                cancel,
                harness,
                error.as_ref(),
            )
            .await
    }
}
impl McpTools {
    pub fn new(bridge: Arc<dyn HostBridge>) -> Self {
        Self {
            state: Arc::new(State {
                catalog: RwLock::new(()),
                bridge,
                options: RwLock::new(Value::Null),
                servers: RwLock::new(IndexMap::new()),
                hosted: RwLock::new(IndexMap::new()),
                revision: AtomicU64::new(0),
                disposed: AtomicBool::new(false),
                processes: Arc::new(crate::processes::OwnedProcesses::default()),
                retired: Mutex::new(Vec::new()),
                preparations: AtomicUsize::new(0),
                settled: tokio::sync::Notify::new(),
            }),
        }
    }
    pub fn from_configs(
        configs: &Value,
        options: Value,
        bridge: Arc<dyn HostBridge>,
    ) -> Result<Self> {
        let manager = Self::new(bridge);
        *manager.state.options.write().unwrap() = options;
        if let Some(configs) = configs.as_object() {
            for (name, config) in configs {
                if config.is_object() && config["type"] != "sdk" {
                    manager.add_server(name.clone(), config.clone())?;
                }
            }
        }
        Ok(manager)
    }
    pub fn set_elicitation_handler(&self, callback: Value) {
        self.state.options.write().unwrap()["onElicitation"] = callback;
    }
    pub fn add_server(&self, name: String, config: Value) -> Result<()> {
        let _catalog = self.state.catalog.write().unwrap();
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        self.state
            .servers
            .write()
            .unwrap()
            .entry(name.clone())
            .or_insert_with(|| Arc::new(Server::new(name, config, false)));
        Ok(())
    }
    pub async fn connect_server(&self, name: &str, cancel: &CancellationToken) -> Result<()> {
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        self.connect(&self.server(name)?, cancel).await
    }
    pub async fn connect_all(&self, cancel: &CancellationToken) -> Result<()> {
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        let servers: Vec<_> = self
            .state
            .servers
            .read()
            .unwrap()
            .values()
            .cloned()
            .collect();
        futures::future::join_all(servers.into_iter().map(|server| async move {
            if let Err(error) = self.connect(&server, cancel).await {
                if !self.state.disposed.load(Ordering::Acquire) {
                    tracing::warn!(server=%server.name,error=%error,"MCP server connection failed");
                }
            }
        }))
        .await;
        Ok(())
    }
    fn retire(&self, snapshot: Arc<Snapshot>) {
        let logical = snapshot.retirement_requires_wait();
        let resource_lease = snapshot.retirement_lease();
        snapshot.begin_close();
        let future = async move {
            let _resource_lease = resource_lease;
            snapshot.close().await;
        }
        .boxed()
        .shared();
        let mut retired = self.state.retired.lock().unwrap();
        retired.retain(|retirement| retirement.future.peek().is_none());
        retired.push(Retirement {
            future: future.clone(),
            logical,
        });
        drop(retired);
        crate::runtime::spawn(future);
    }
    pub fn disconnect_server(&self, name: &str) {
        if let Ok(server) = self.server(name) {
            if let Some(snapshot) = self.detach(&server) {
                self.retire(snapshot);
            }
        }
    }
    pub fn remove_server(&self, name: &str) {
        self.disconnect_server(name);
        let _catalog = self.state.catalog.write().unwrap();
        self.state.servers.write().unwrap().shift_remove(name);
    }
    pub fn disconnect_all(&self) {
        self.state.disposed.store(true, Ordering::Release);
        for server in self.all_servers() {
            if let Some(snapshot) = self.detach(&server) {
                self.retire(snapshot);
            }
        }
    }
    pub async fn when_settled(&self) {
        loop {
            let notified = self.state.settled.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.preparations.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
        let retired = self
            .state
            .retired
            .lock()
            .unwrap()
            .iter()
            .filter(|retirement| retirement.logical)
            .map(|retirement| retirement.future.clone())
            .collect::<Vec<_>>();
        futures::future::join_all(retired).await;
    }
    pub fn owned_process_count(&self) -> usize {
        self.state.processes.count()
    }
    pub fn process_retirement(&self) -> crate::tools::ProcessRetirement {
        let closing = self
            .state
            .retired
            .lock()
            .unwrap()
            .iter()
            .map(|retirement| retirement.future.clone())
            .collect();
        crate::tools::ProcessRetirement::new(vec![self.state.processes.clone()], closing)
    }
    fn live_status_for(server: &Server, harness: &ResolvedHarness) -> Value {
        let _binding = server.binding.lock().unwrap();
        let error = server.error.read().unwrap().clone();
        match &*server.live.read().unwrap() {
            LiveState::Disconnected => {
                let mut status = json!({"state":"disconnected"});
                if let Some(error) = error {
                    status["lastError"] = json!(error.render_for(harness));
                }
                status
            }
            LiveState::Connecting => json!({"state":"connecting"}),
            LiveState::Connected(count) => json!({"state":"connected","toolCount":count}),
            LiveState::Retry(at) => {
                json!({"state":"failed","error":error.map(|error|error.render_for(harness)).unwrap_or_else(||harness.text(TextId::ToolsMcpConnectionLost).into()),"retryAt":at})
            }
        }
    }
    pub fn live_status(&self, name: &str, harness: &ResolvedHarness) -> Value {
        self.server(name)
            .ok()
            .map(|server| Self::live_status_for(&server, harness))
            .unwrap_or_else(crate::js::undefined)
    }
    pub fn all_live_statuses(&self, harness: &ResolvedHarness) -> Vec<Value> {
        let servers: Vec<_> = self
            .state
            .servers
            .read()
            .unwrap()
            .values()
            .cloned()
            .collect();
        servers
            .iter()
            .map(|server| json!([server.name, Self::live_status_for(server, harness)]))
            .collect()
    }
    pub fn server_names(&self) -> Vec<String> {
        self.state.servers.read().unwrap().keys().cloned().collect()
    }
    pub fn is_connected(&self, name: &str) -> bool {
        self.server(name).ok().is_some_and(|server| {
            matches!(*server.live.read().unwrap(), LiveState::Connected(_))
                && server.snapshot.read().unwrap().is_some()
        })
    }
    pub fn start_reconnect_loop(&self, name: &str) {
        if self.state.disposed.load(Ordering::Acquire) {
            return;
        }
        if let Ok(server) = self.server(name) {
            self.start_reconnect(server);
        }
    }
    pub fn bridged_tools(&self) -> Result<Vec<ManagedTool>> {
        let tools = self.selected_tools();
        let mut names = std::collections::HashSet::new();
        for tool in &tools {
            let name = tool.tool.definition["name"].as_str().unwrap_or("");
            if !names.insert(name) {
                return Err(Error::template(
                    "MCP_IDENTITY_COLLISION",
                    TextId::ToolsMcpIdentityCollision,
                    &[("name", name.into())],
                )
                .with_details(json!({"name":"McpToolIdentityError"})));
            }
        }
        Ok(tools)
    }
    pub async fn initialize(&mut self, options: &Value, cancel: &CancellationToken) -> Result<()> {
        *self.state.options.write().unwrap() = options.clone();
        if let Some(servers) = options["mcpServers"].as_object() {
            let slots: Vec<_> = servers
                .iter()
                .filter(|(_, config)| config.is_object())
                .map(|(name, config)| {
                    Arc::new(Server::new(
                        name.clone(),
                        config.clone(),
                        config["type"] == "sdk",
                    ))
                })
                .collect();
            {
                let _catalog = self.state.catalog.write().unwrap();
                *self.state.hosted.write().unwrap() = slots
                    .iter()
                    .filter(|server| server.hosted)
                    .map(|server| (server.name.clone(), server.clone()))
                    .collect();
                *self.state.servers.write().unwrap() = slots
                    .iter()
                    .filter(|server| !server.hosted)
                    .map(|server| (server.name.clone(), server.clone()))
                    .collect();
            }
            let attempts=slots.into_iter().map(|server|{let manager=self.clone();let cancel=cancel.clone();async move{let result=manager.connect(&server,&cancel).await;if let Err(error)=&result{tracing::warn!(server=%server.name,error=%error,"MCP server connection failed");}result}});
            let results = futures::future::join_all(attempts).await;
            for result in results {
                if let Err(error) = result {
                    if cancel.is_cancelled() || error.code == "MCP_IDENTITY_COLLISION" {
                        return Err(error);
                    }
                }
            }
        }
        self.validate_names()?;
        Ok(())
    }
    fn server(&self, name: &str) -> Result<Arc<Server>> {
        self.state
            .servers
            .read()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| {
                Error::template(
                    "MCP_SERVER",
                    TextId::ToolsMcpUnknownServer,
                    &[("name", name.into())],
                )
            })
    }
    fn current(&self, server: &Arc<Server>) -> bool {
        if self.state.disposed.load(Ordering::Acquire) {
            return false;
        }
        let servers = if server.hosted {
            &self.state.hosted
        } else {
            &self.state.servers
        };
        servers
            .read()
            .unwrap()
            .get(&server.name)
            .is_some_and(|current| Arc::ptr_eq(current, server))
    }
    fn all_servers(&self) -> Vec<Arc<Server>> {
        self.state
            .hosted
            .read()
            .unwrap()
            .values()
            .chain(self.state.servers.read().unwrap().values())
            .cloned()
            .collect()
    }
    fn tool_server(&self, tool: &McpTool) -> Result<Arc<Server>> {
        if !tool.hosted {
            return self.server(&tool.server);
        }
        self.state
            .hosted
            .read()
            .unwrap()
            .get(&tool.server)
            .cloned()
            .ok_or_else(|| {
                Error::template(
                    "MCP_SERVER",
                    TextId::ToolsMcpUnknownServer,
                    &[("name", tool.server.clone().into())],
                )
            })
    }
    fn prepare_connection(
        &self,
        server: Arc<Server>,
        caller: CancellationToken,
    ) -> Result<ConnectionFuture> {
        if caller.is_cancelled() {
            return Err(Error::cancelled());
        }
        let runtime = crate::runtime::shared()?;
        let mut opening = server.prepared.lock().unwrap();
        if let Some((_, future)) = opening.as_ref() {
            return Ok(future.clone());
        }
        let (generation, cancel, config, options) = {
            let _binding = server.binding.lock().unwrap();
            if !self.current(&server) {
                return Err(Error::template(
                    "MCP_DISPOSED",
                    TextId::ToolsMcpDisposed,
                    &[],
                ));
            }
            if server
                .snapshot
                .read()
                .unwrap()
                .as_ref()
                .is_some_and(|snapshot| snapshot.connected())
            {
                return Ok(futures::future::ready(Ok(())).boxed().shared());
            }
            let generation = server.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let cancel = CancellationToken::new();
            *server.attempt.lock().unwrap() = cancel.clone();
            *server.live.write().unwrap() = LiveState::Connecting;
            let config = server.config.read().unwrap().clone();
            let options = self.state.options.read().unwrap().clone();
            (generation, cancel, config, options)
        };
        self.state.preparations.fetch_add(1, Ordering::AcqRel);
        let preparation = Preparation(self.state.clone());
        let manager = self.clone();
        let owned = server.clone();
        let future = async move {
            let _preparation = preparation;
            let result = manager
                .connect_inner(&owned, &caller, generation, cancel, config, options)
                .await;
            let removed = {
                let mut opening = owned.prepared.lock().unwrap();
                if opening
                    .as_ref()
                    .is_some_and(|(current, _)| *current == generation)
                {
                    opening.take()
                } else {
                    None
                }
            };
            drop(removed);
            result
        }
        .boxed()
        .shared();
        *opening = Some((generation, future.clone()));
        drop(opening);
        runtime.spawn(future.clone());
        Ok(future)
    }
    pub fn prepare_connect_server(&self, name: &str) -> Result<ConnectionFuture> {
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        self.prepare_connection(self.server(name)?, CancellationToken::new())
    }
    pub fn prepare_connect_all(&self) -> Result<BoxFuture<'static, Result<()>>> {
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        let servers: Vec<_> = self
            .state
            .servers
            .read()
            .unwrap()
            .values()
            .cloned()
            .collect();
        let manager = self.clone();
        let prepared = servers
            .into_iter()
            .map(|server| {
                let name = server.name.clone();
                let future = self
                    .prepare_connection(server, CancellationToken::new())
                    .unwrap_or_else(|error| futures::future::ready(Err(error)).boxed().shared());
                (name, future)
            })
            .collect::<Vec<_>>();
        Ok(async move {
            futures::future::join_all(prepared.into_iter().map(|(name, future)| {
                let manager = manager.clone();
                async move {
                    if let Err(error) = future.await {
                        if !manager.state.disposed.load(Ordering::Acquire) {
                            tracing::warn!(server=name,error=%error,"MCP server connection failed");
                        }
                    }
                }
            }))
            .await;
            Ok(())
        }
        .boxed())
    }
    pub fn prepare_reconnect(&self, name: &str) -> Result<ConnectionFuture> {
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        self.disconnect_server(name);
        self.prepare_connect_server(name)
    }
    pub fn prepare_toggle(&self, name: &str, enabled: bool) -> Result<ConnectionFuture> {
        let server = self.server(name).map_err(|_| {
            Error::template(
                "MCP_SERVER",
                TextId::ToolsMcpUnregistered,
                &[("name", name.into())],
            )
        })?;
        if enabled && !matches!(*server.live.read().unwrap(), LiveState::Connected(_)) {
            return self.prepare_connection(server, CancellationToken::new());
        }
        if !enabled {
            self.disconnect_server(name);
        }
        Ok(futures::future::ready(Ok(())).boxed().shared())
    }
    async fn connect(&self, server: &Arc<Server>, caller: &CancellationToken) -> Result<()> {
        self.prepare_connection(server.clone(), caller.clone())?
            .await
    }
    async fn connect_inner(
        &self,
        server: &Arc<Server>,
        caller: &CancellationToken,
        generation: u64,
        cancel: CancellationToken,
        config: Value,
        options: Value,
    ) -> Result<()> {
        let stopped = || {
            Error::template(
                "MCP_CANCELLED",
                TextId::ToolsMcpNamedConnectionCancelled,
                &[("name", server.name.clone().into())],
            )
        };
        if cancel.is_cancelled() || server.generation.load(Ordering::Acquire) != generation {
            return Err(stopped());
        }
        let _serial = tokio::select! {guard=server.serial.lock()=>guard,_=caller.cancelled()=>return Err(Error::cancelled()),_=cancel.cancelled()=>return Err(stopped())};
        let existing = {
            let _binding = server.binding.lock().unwrap();
            if cancel.is_cancelled()
                || server.generation.load(Ordering::Acquire) != generation
                || !self.current(server)
            {
                return Err(stopped());
            }
            server.snapshot.read().unwrap().clone()
        };
        if let Some(existing) = &existing {
            self.retire(existing.clone());
        }
        let kind = match config.get("type") {
            None | Some(Value::Null) => "stdio",
            Some(value) if crate::js::is_undefined(value) => "stdio",
            Some(value) => value.as_str().unwrap_or(""),
        };
        if !server.hosted
            && (!matches!(kind, "stdio" | "sse" | "http")
                || kind == "stdio" && !crate::js::truthy(&config["command"])
                || matches!(kind, "sse" | "http") && !crate::js::truthy(&config["url"]))
        {
            let _binding = server.binding.lock().unwrap();
            if !self.current(server) || server.generation.load(Ordering::Acquire) != generation {
                return Err(Error::template(
                    "MCP_SUPERSEDED",
                    TextId::ToolsMcpSuperseded,
                    &[("name", server.name.clone().into())],
                ));
            }
            tracing::warn!(server=%server.name,"MCP server has unsupported or incomplete transport configuration");
            *server.error.write().unwrap() = Some(Error::template(
                "MCP_CONFIG",
                TextId::ToolsMcpUnsupportedTransport,
                &[],
            ));
            *server.live.write().unwrap() = LiveState::Disconnected;
            return Ok(());
        }
        let mut prepared = Snapshot::new(self.state.bridge.clone(), self.state.processes.clone());
        let result = tokio::select! {result=prepared.connect(&server.name,&config,&options,&cancel,server.hosted)=>result,_=caller.cancelled()=>{cancel.cancel();Err(Error::cancelled())}};
        let mut prepared = Some(prepared);
        let outcome = {
            let _catalog = self.state.catalog.write().unwrap();
            let _binding = server.binding.lock().unwrap();
            if self.current(server)
                && server.generation.load(Ordering::Acquire) == generation
                && !cancel.is_cancelled()
            {
                match result {
                    Ok(()) => {
                        let prepared = prepared.take().unwrap();
                        let before = existing
                            .as_ref()
                            .map(|snapshot| {
                                snapshot
                                    .tools
                                    .iter()
                                    .map(|tool| &tool.fingerprint)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        let after = prepared
                            .tools
                            .iter()
                            .map(|tool| &tool.fingerprint)
                            .collect::<Vec<_>>();
                        if !server.hosted && before != after {
                            self.state.revision.fetch_add(1, Ordering::AcqRel);
                        }
                        *server.live.write().unwrap() = LiveState::Connected(prepared.tools.len());
                        *server.snapshot.write().unwrap() = Some(Arc::new(prepared));
                        *server.error.write().unwrap() = None;
                        Ok(())
                    }
                    Err(error) => {
                        let old = server.snapshot.write().unwrap().take();
                        if !server.hosted
                            && old
                                .as_ref()
                                .is_some_and(|snapshot| !snapshot.tools.is_empty())
                        {
                            self.state.revision.fetch_add(1, Ordering::AcqRel);
                        }
                        *server.error.write().unwrap() = Some(error.clone());
                        *server.live.write().unwrap() = LiveState::Disconnected;
                        Err(error)
                    }
                }
            } else {
                Err(Error::template(
                    "MCP_SUPERSEDED",
                    TextId::ToolsMcpSuperseded,
                    &[("name", server.name.clone().into())],
                ))
            }
        };
        if let Some(prepared) = prepared {
            self.retire(Arc::new(prepared));
        }
        outcome
    }

    fn detach(&self, server: &Arc<Server>) -> Option<Arc<Snapshot>> {
        let mut opening = server.prepared.lock().unwrap();
        let prepared = opening.take();
        let old = {
            let _catalog = self.state.catalog.write().unwrap();
            let _binding = server.binding.lock().unwrap();
            server.generation.fetch_add(1, Ordering::AcqRel);
            server.attempt.lock().unwrap().cancel();
            if let Some(token) = server.reconnect.lock().unwrap().take() {
                token.cancel();
            }
            let old = server.snapshot.write().unwrap().take();
            if !server.hosted
                && old
                    .as_ref()
                    .is_some_and(|snapshot| !snapshot.tools.is_empty())
            {
                self.state.revision.fetch_add(1, Ordering::AcqRel);
            }
            *server.error.write().unwrap() = None;
            *server.live.write().unwrap() = LiveState::Disconnected;
            old
        };
        drop(opening);
        drop(prepared);
        old
    }
    pub fn tools(&self) -> Vec<McpTool> {
        let servers = self.all_servers();
        servers
            .iter()
            .flat_map(|server| {
                server
                    .snapshot
                    .read()
                    .unwrap()
                    .as_ref()
                    .map(|snapshot| snapshot.tools.clone())
                    .unwrap_or_default()
            })
            .collect()
    }
    pub fn selected_tools(&self) -> Vec<ManagedTool> {
        let _catalog = self.state.catalog.read().unwrap();
        self.all_servers()
            .into_iter()
            .flat_map(|server| {
                let _binding = server.binding.lock().unwrap();
                let snapshot = server.snapshot.read().unwrap().clone();
                let config_revision = server.config_revision.load(Ordering::Acquire);
                snapshot
                    .as_ref()
                    .map(|snapshot| {
                        snapshot
                            .tools
                            .iter()
                            .map(|tool| ManagedTool {
                                manager: self.clone(),
                                server: server.clone(),
                                tool: tool.clone(),
                                config_revision,
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            })
            .collect()
    }
    pub fn owns_tool(&self, tool: &ManagedTool) -> bool {
        Arc::ptr_eq(&self.state, &tool.manager.state)
    }
    pub fn statuses(&self) -> Vec<Value> {
        self.statuses_with_harness(&crate::harness::baseline())
    }
    pub fn statuses_with_harness(&self, harness: &ResolvedHarness) -> Vec<Value> {
        self.all_servers().iter().map(|server|{
            let live=Self::live_status_for(server,harness);
            if live["state"]=="connected" {json!({"name":server.name,"status":"connected"})}
            else {json!({"name":server.name,"status":"failed","error":live.get(if live["state"]=="disconnected" {"lastError"}else{"error"}).cloned().unwrap_or_else(crate::js::undefined)})}
        }).collect()
    }
    pub fn instructions(&self) -> String {
        self.all_servers()
            .iter()
            .flat_map(|server| {
                server
                    .snapshot
                    .read()
                    .unwrap()
                    .as_ref()
                    .map(|s| s.instructions.clone())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    pub fn revision(&self) -> u64 {
        self.state.revision.load(Ordering::Acquire)
    }
    pub(crate) fn validate_names(&self) -> Result<()> {
        let _catalog = self.state.catalog.read().unwrap();
        let mut names = std::collections::HashSet::new();
        for tool in self.tools() {
            let name = tool.definition["name"].as_str().unwrap_or("").to_owned();
            if !names.insert(name.clone()) {
                return Err(Error::template(
                    "MCP_IDENTITY_COLLISION",
                    TextId::ToolsMcpIdentityCollision,
                    &[("name", name.into())],
                )
                .with_details(json!({"name":"McpToolIdentityError"})));
            }
        }
        Ok(())
    }
    pub async fn reconnect(&self, name: &str, cancel: &CancellationToken) -> Result<()> {
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        self.disconnect_server(name);
        self.connect_server(name, cancel).await?;
        Ok(())
    }
    pub async fn toggle(
        &self,
        name: &str,
        enabled: bool,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let server = self.server(name).map_err(|_| {
            Error::template(
                "MCP_SERVER",
                TextId::ToolsMcpUnregistered,
                &[("name", name.into())],
            )
        })?;
        if enabled {
            if !matches!(*server.live.read().unwrap(), LiveState::Connected(_)) {
                self.connect(&server, cancel).await?;
            }
        } else {
            self.disconnect_server(name);
        }
        Ok(())
    }
    fn next_server_update(
        &self,
        updates: &mut ServerUpdates,
        cancel: &CancellationToken,
    ) -> Result<Option<(String, ConnectionFuture)>> {
        for (name, config) in updates.remaining.by_ref() {
            if self.state.disposed.load(Ordering::Acquire) {
                return Err(Error::template(
                    "MCP_DISPOSED",
                    TextId::ToolsMcpDisposed,
                    &[],
                ));
            }
            let server = match self.server(&name) {
                Ok(server) => {
                    if crate::js::stringify(&server.config.read().unwrap())
                        == crate::js::stringify(&config)
                    {
                        continue;
                    }
                    self.disconnect_server(&name);
                    {
                        let _catalog = self.state.catalog.write().unwrap();
                        let _binding = server.binding.lock().unwrap();
                        *server.config.write().unwrap() = config;
                        server.config_revision.fetch_add(1, Ordering::AcqRel);
                    }
                    server
                }
                Err(_) => {
                    let server = Arc::new(Server::new(name.clone(), config, false));
                    {
                        let _catalog = self.state.catalog.write().unwrap();
                        self.state
                            .servers
                            .write()
                            .unwrap()
                            .insert(name.clone(), server.clone());
                    }
                    updates.added.push(name.clone());
                    server
                }
            };
            let future = self
                .prepare_connection(server, cancel.clone())
                .unwrap_or_else(|error| futures::future::ready(Err(error)).boxed().shared());
            return Ok(Some((name, future)));
        }
        Ok(None)
    }
    fn prepare_server_updates(
        &self,
        configs: &Value,
        cancel: CancellationToken,
    ) -> Result<BoxFuture<'static, Result<ServerUpdates>>> {
        if self.state.disposed.load(Ordering::Acquire) {
            return Err(Error::template(
                "MCP_DISPOSED",
                TextId::ToolsMcpDisposed,
                &[],
            ));
        }
        let configs = configs.as_object().ok_or_else(|| {
            Error::template("MCP_CONFIG", TextId::ToolsMcpInvalidConfiguration, &[])
        })?;
        let mut removed = Vec::new();
        for name in self.server_names() {
            if !configs.contains_key(&name) {
                self.remove_server(&name);
                removed.push(name);
            }
        }
        let mut updates = ServerUpdates {
            remaining: configs
                .iter()
                .map(|(name, config)| (name.clone(), config.clone()))
                .collect::<Vec<_>>()
                .into_iter(),
            added: Vec::new(),
            removed,
            errors: Vec::new(),
        };
        let mut pending = self.next_server_update(&mut updates, &cancel)?;
        let manager = self.clone();
        Ok(async move {
            while let Some((name, future)) = pending {
                if let Err(error) = future.await {
                    updates.errors.push((name, error));
                }
                pending = manager.next_server_update(&mut updates, &cancel)?;
            }
            Ok(updates)
        }
        .boxed())
    }
    pub fn prepare_set_servers(
        &self,
        configs: Value,
        harness: Arc<ResolvedHarness>,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        let prepared = self.prepare_server_updates(&configs, CancellationToken::new())?;
        Ok(async move { Ok(prepared.await?.result(&harness)) }.boxed())
    }
    pub async fn set_servers(
        &self,
        configs: &Value,
        cancel: &CancellationToken,
        harness: &ResolvedHarness,
    ) -> Result<Value> {
        Ok(self
            .prepare_server_updates(configs, cancel.clone())?
            .await?
            .result(harness))
    }
    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
        expected: Option<&Value>,
        harness: &ResolvedHarness,
    ) -> Result<Value> {
        let tools = self.tools();
        let Some(tool) = tools.iter().find(|tool| tool.definition["name"] == name) else {
            return Ok(failure(
                harness.render(TextId::ToolsMcpUnknownTool, &[("name", name)]),
            ));
        };
        let server = self.tool_server(tool)?;
        let config_revision = server.config_revision.load(Ordering::Acquire);
        if expected.is_some_and(|expected| {
            let definition = tool.definition_with_harness(harness);
            ["name", "description", "input_schema"]
                .iter()
                .any(|key| definition[*key] != expected[*key])
        }) {
            return Ok(stale(tool, false, harness));
        }
        self.execute_bound(tool, server, config_revision, input, cancel, harness, None)
            .await
    }
    async fn execute_bound(
        &self,
        tool: &McpTool,
        server: Arc<Server>,
        config_revision: u64,
        input: Value,
        cancel: &CancellationToken,
        harness: &ResolvedHarness,
        initial_error: Option<&Error>,
    ) -> Result<Value> {
        let name = tool.definition["name"].as_str().unwrap_or("");
        let snapshot = {
            let _binding = server.binding.lock().unwrap();
            let snapshot = server.snapshot.read().unwrap().clone();
            if !self.current(&server)
                || server.config_revision.load(Ordering::Acquire) != config_revision
                || snapshot.as_ref().is_none_or(|snapshot| {
                    !snapshot.tools.iter().any(|current| {
                        current.original == tool.original && current.fingerprint == tool.fingerprint
                    })
                })
            {
                return Ok(stale(tool, false, harness));
            }
            snapshot
        };
        let Some(snapshot) = snapshot else {
            return Ok(failure(harness.render(
                TextId::ToolsMcpServerNotConnected,
                &[("server", &tool.server)],
            )));
        };
        if let Some(error) = initial_error {
            return Ok(failure(harness.render(
                TextId::ToolsMcpToolError,
                &[
                    ("server", &tool.server),
                    ("tool", &tool.original),
                    ("error", &error.render_for(harness)),
                ],
            )));
        }
        if snapshot.hosted() {
            return snapshot.execute(name, input, cancel, harness).await;
        }
        let generation = server.generation.load(Ordering::Acquire);
        let result = snapshot
            .execute(name, input.clone(), cancel, harness)
            .await
            .unwrap_or_else(|error| {
                failure(harness.render(
                    TextId::ToolsMcpToolError,
                    &[
                        ("server", &tool.server),
                        ("tool", &tool.original),
                        ("error", &error.render_for(harness)),
                    ],
                ))
            });
        if result["isError"] == true
            && !cancel.is_cancelled()
            && self.current(&server)
            && server.generation.load(Ordering::Acquire) == generation
            && !snapshot.connected()
        {
            tracing::warn!(server=%tool.server,tool=%tool.original,"server disconnected during tool call, attempting reconnect");
            match self.connect(&server, cancel).await {
                Ok(()) => {
                    let current = server.snapshot.read().unwrap().clone();
                    let valid = server.config_revision.load(Ordering::Acquire) == config_revision
                        && current.as_ref().is_some_and(|s| {
                            s.tools.iter().any(|t| {
                                t.original == tool.original && t.fingerprint == tool.fingerprint
                            })
                        });
                    if !valid {
                        return Ok(stale(tool, true, harness));
                    }
                    if tool.readonly || tool.idempotent {
                        return Ok(current
                            .unwrap()
                            .execute(name, input, cancel, harness)
                            .await
                            .unwrap_or_else(|error| {
                                failure(harness.render(
                                    TextId::ToolsMcpToolError,
                                    &[
                                        ("server", &tool.server),
                                        ("tool", &tool.original),
                                        ("error", &error.render_for(harness)),
                                    ],
                                ))
                            }));
                    }
                    let mut result = result;
                    result["content"] = json!(harness.render(
                        TextId::ToolsMcpNotReplayed,
                        &[("result", result["content"].as_str().unwrap_or(""))]
                    ));
                    return Ok(result);
                }
                Err(error) => {
                    tracing::warn!(server=%tool.server,error=%error,"reconnect failed");
                    self.start_reconnect(server);
                }
            }
        }
        Ok(result)
    }
    fn start_reconnect(&self, server: Arc<Server>) {
        let mut reconnect = server.reconnect.lock().unwrap();
        if reconnect.is_some() {
            return;
        }
        let token = CancellationToken::new();
        *reconnect = Some(token.clone());
        drop(reconnect);
        {
            let _binding = server.binding.lock().unwrap();
            if token.is_cancelled() || !self.current(&server) {
                return;
            }
            *server.live.write().unwrap() =
                LiveState::Retry(chrono::Utc::now().timestamp_millis() + 1000);
        }
        let weak = Arc::downgrade(&self.state);
        let resource_lease = self
            .state
            .bridge
            .resource_activity()
            .map(|activity| activity.lease());
        crate::runtime::spawn(async move {
            let _resource_lease = resource_lease;
            let mut delay = 1000;
            loop {
                tokio::select! {_=tokio::time::sleep(Duration::from_millis(delay))=>{},_=token.cancelled()=>return}
                let Some(state) = weak.upgrade() else {
                    return;
                };
                let manager = Self { state };
                if !manager.current(&server) {
                    return;
                }
                match manager.connect(&server, &token).await {
                    Ok(()) if manager.is_connected(&server.name) => {
                        server.reconnect.lock().unwrap().take();
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(server=%server.name,error=%error,"MCP reconnect attempt failed")
                    }
                    Ok(()) => {}
                };
                delay = (delay * 2).min(60000);
                {
                    let _binding = server.binding.lock().unwrap();
                    if token.is_cancelled() || !manager.current(&server) {
                        return;
                    }
                    *server.live.write().unwrap() =
                        LiveState::Retry(chrono::Utc::now().timestamp_millis() + delay as i64);
                }
            }
        });
    }
    pub async fn close(&self) {
        self.disconnect_all();
        self.when_settled().await;
    }
    pub fn abort_now(&self) {
        self.state.disposed.store(true, Ordering::Release);
        let servers = self.all_servers();
        for server in servers {
            server.attempt.lock().unwrap().cancel();
            if let Some(reconnect) = server.reconnect.lock().unwrap().take() {
                reconnect.cancel();
            }
            if let Some(snapshot) = server.snapshot.read().unwrap().as_ref() {
                snapshot.abort_now();
            }
        }
        self.state.processes.abort_now();
    }
}
fn stale(tool: &McpTool, attempted: bool, harness: &ResolvedHarness) -> Value {
    tracing::warn!(server=%tool.server,tool=%tool.original,attempted,"MCP call refused: tool definition changed or was removed");
    failure(harness.render(
        TextId::ToolsMcpStale,
        &[
            ("tool", &tool.original),
            ("server", &tool.server),
            (
                "guidance",
                harness.text(if attempted {
                    TextId::ToolsMcpStaleAttempted
                } else {
                    TextId::ToolsMcpStaleNotExecuted
                }),
            ),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    struct Host;
    #[async_trait]
    impl HostBridge for Host {
        async fn call(&self, method: &str, _: Value, _: &CancellationToken) -> Result<Value> {
            panic!("unexpected callback {method}")
        }
    }
    #[tokio::test]
    async fn public_manager_controls_and_statuses_match_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/public-mcp-manager.json")).unwrap();
        let manager =
            McpTools::from_configs(&fixture["configs"], json!({}), Arc::new(Host)).unwrap();
        let harness = crate::harness::baseline();
        for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
            let name = step["name"].as_str().unwrap_or("");
            let cancel = CancellationToken::new();
            let outcome: Result<Value> = match step["method"].as_str().unwrap() {
                "snapshot" => Ok(crate::js::undefined()),
                "addServer" => manager
                    .add_server(name.into(), step["config"].clone())
                    .map(|()| crate::js::undefined()),
                "connectAll" => manager
                    .connect_all(&cancel)
                    .await
                    .map(|()| crate::js::undefined()),
                "toggle" => manager
                    .toggle(name, step["enabled"] == true, &cancel)
                    .await
                    .map(|()| crate::js::undefined()),
                "removeServer" => {
                    manager.remove_server(name);
                    Ok(crate::js::undefined())
                }
                "setServers" => {
                    manager
                        .set_servers(&step["configs"], &cancel, &harness)
                        .await
                }
                "disconnectAll" => {
                    manager.disconnect_all();
                    manager.when_settled().await;
                    Ok(crate::js::undefined())
                }
                "restart" => manager
                    .reconnect(name, &cancel)
                    .await
                    .map(|()| crate::js::undefined()),
                _ => unreachable!(),
            };
            let mut actual = match outcome {
                Ok(value) => json!({ "result": value }),
                Err(error) => json!({"error":error.message}),
            };
            actual["state"] = json!({"names":manager.server_names(),"statuses":manager.statuses_with_harness(&harness),"live":manager.all_live_statuses(&harness),"revision":manager.revision(),"connected":manager.server_names().iter().map(|name|json!([name,manager.is_connected(name)])).collect::<Vec<_>>(),"tools":manager.bridged_tools().unwrap().iter().map(|tool|tool.descriptor(&harness)["name"].clone()).collect::<Vec<_>>()});
            assert_eq!(
                crate::js::stringify(&actual),
                crate::js::stringify(&fixture["expected"][index]),
                "step {index}"
            );
        }
    }
}
