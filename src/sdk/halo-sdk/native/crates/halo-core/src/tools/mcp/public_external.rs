use super::{McpTool, Snapshot};
use crate::{
    bridge::HostBridge,
    error::Result,
    harness::{ResolvedHarness, TextId},
    tools::failure,
};
use futures::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio_util::sync::CancellationToken;

struct Entry {
    tool: McpTool,
    snapshot: Arc<Snapshot>,
}
struct State {
    entries: Vec<Entry>,
    snapshots: Vec<Arc<Snapshot>>,
    statuses: Vec<Value>,
    connected: AtomicBool,
    retired: Mutex<Vec<Shared<BoxFuture<'static, ()>>>>,
    processes: Arc<crate::processes::OwnedProcesses>,
}
#[derive(Clone)]
pub struct ExternalConnections {
    state: Arc<State>,
}
#[derive(Clone)]
pub struct ExternalTool {
    state: Arc<State>,
    index: usize,
}
impl ExternalTool {
    pub fn descriptor(&self, harness: &ResolvedHarness) -> Value {
        let entry = &self.state.entries[self.index];
        let definition = entry.tool.definition_with_harness(harness);
        json!({"name":definition["name"],"description":definition["description"],"inputSchema":definition["input_schema"],"mcpSource":entry.tool.mcp_source,"permissionLevel":"execute","concurrencySafe":entry.tool.readonly})
    }
    pub async fn execute(&self, input: Value, harness: &ResolvedHarness) -> Result<Value> {
        let entry = &self.state.entries[self.index];
        if !self.state.connected.load(Ordering::Acquire) {
            return Ok(failure(harness.render(
                TextId::ToolsMcpNotInitialized,
                &[("server", &entry.tool.server)],
            )));
        }
        entry
            .snapshot
            .execute(
                entry.tool.definition["name"].as_str().unwrap_or(""),
                input,
                &CancellationToken::new(),
                harness,
            )
            .await
    }
}
impl ExternalConnections {
    pub async fn connect(
        configs: &Value,
        mut options: Value,
        bridge: Arc<dyn HostBridge>,
    ) -> Result<Self> {
        if let Some(options) = options.as_object_mut() {
            options.remove("onElicitation");
        }
        let processes = Arc::new(crate::processes::OwnedProcesses::default());
        let mut entries = Vec::new();
        let mut snapshots = Vec::new();
        let mut statuses = Vec::new();
        if let Some(configs) = configs.as_object() {
            for (name, config) in configs {
                if !config.is_object() || config["type"] == "sdk" {
                    continue;
                }
                let kind = match config.get("type") {
                    None | Some(Value::Null) => "stdio",
                    Some(value) if crate::js::is_undefined(value) => "stdio",
                    Some(value) => value.as_str().unwrap_or(""),
                };
                if !matches!(kind, "stdio" | "sse" | "http")
                    || kind == "stdio" && !crate::js::truthy(&config["command"])
                    || matches!(kind, "sse" | "http") && !crate::js::truthy(&config["url"])
                {
                    tracing::warn!(
                        server = name,
                        "MCP server has unsupported or incomplete transport configuration"
                    );
                    continue;
                }
                let mut snapshot = Snapshot::new(bridge.clone(), processes.clone());
                match snapshot
                    .connect(name, config, &options, &CancellationToken::new(), false)
                    .await
                {
                    Ok(()) => {
                        let snapshot = Arc::new(snapshot);
                        for tool in &snapshot.tools {
                            entries.push(Entry {
                                tool: tool.clone(),
                                snapshot: snapshot.clone(),
                            });
                        }
                        snapshots.push(snapshot);
                        statuses.push(json!({"name":name,"status":"connected"}));
                    }
                    Err(error) => {
                        snapshot.close().await;
                        if error.code == "MCP_IDENTITY_COLLISION" {
                            for connected in &snapshots {
                                connected.close().await;
                            }
                            return Err(error.with_details(json!({"name":"McpToolIdentityError"})));
                        }
                        tracing::warn!(server=name,error=%error,"failed to connect MCP server");
                        statuses.push(json!({"name":name,"status":"failed","error":error.message}));
                    }
                }
            }
        }
        let connections = Self {
            state: Arc::new(State {
                entries,
                snapshots,
                statuses,
                connected: AtomicBool::new(true),
                retired: Mutex::new(Vec::new()),
                processes,
            }),
        };
        let descriptors = connections
            .tools()
            .iter()
            .map(|tool| tool.descriptor(&crate::harness::baseline()))
            .collect::<Vec<_>>();
        if let Err(error) = super::public_bridge::assert_unique(&descriptors) {
            connections.disconnect();
            connections.when_closed().await;
            return Err(error);
        }
        Ok(connections)
    }
    pub fn tools(&self) -> Vec<ExternalTool> {
        (0..self.state.entries.len())
            .map(|index| ExternalTool {
                state: self.state.clone(),
                index,
            })
            .collect()
    }
    pub fn statuses(&self) -> Vec<Value> {
        self.state.statuses.clone()
    }
    pub fn disconnect(&self) {
        if !self.state.connected.swap(false, Ordering::AcqRel) {
            return;
        }
        for snapshot in &self.state.snapshots {
            let resource_lease = snapshot.retirement_lease();
            snapshot.begin_close();
            let snapshot = snapshot.clone();
            let future = async move {
                let _resource_lease = resource_lease;
                snapshot.close().await
            }
            .boxed()
            .shared();
            self.state.retired.lock().unwrap().push(future.clone());
            crate::runtime::spawn(future);
        }
    }
    pub async fn when_closed(&self) {
        let retired = self.state.retired.lock().unwrap().clone();
        futures::future::join_all(retired).await;
    }
    pub fn abort_now(&self) {
        self.state.connected.store(false, Ordering::Release);
        for snapshot in &self.state.snapshots {
            snapshot.abort_now();
        }
        self.state.processes.abort_now();
    }
}
impl Drop for State {
    fn drop(&mut self) {
        for snapshot in &self.snapshots {
            snapshot.abort_now();
        }
        self.processes.abort_now();
    }
}
