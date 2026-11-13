use super::cost::CostTracker;
use crate::bridge::EventSink;
use crate::error::{Error, Result};
use crate::tools::{FileAdmission, FileAdmissionPreparation, ToolRuntime};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tokio_util::sync::CancellationToken;

struct ActiveContext {
    tools: Arc<ToolRuntime>,
    events: Arc<dyn EventSink>,
    harness: Arc<crate::harness::ResolvedHarness>,
    cost: Arc<Mutex<CostTracker>>,
}

struct ContextOperation {
    tool_use_id: String,
    cancellation: CancellationToken,
    cancel_on_return: bool,
    tools: Weak<ToolRuntime>,
    harness: Arc<crate::harness::ResolvedHarness>,
}

pub struct ToolContextBridge {
    cost: Mutex<Arc<Mutex<CostTracker>>>,
    active: Mutex<HashMap<String, ActiveContext>>,
    services: Mutex<Weak<ToolRuntime>>,
    operations: Mutex<HashMap<String, Arc<ContextOperation>>>,
}

struct OperationLease {
    bridge: Arc<ToolContextBridge>,
    id: String,
    operation: Arc<ContextOperation>,
    tools: Arc<ToolRuntime>,
}
impl Drop for OperationLease {
    fn drop(&mut self) {
        let mut operations = self.bridge.operations.lock().unwrap();
        if operations
            .get(&self.id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.operation))
        {
            operations.remove(&self.id);
        }
    }
}

pub struct PreparedContextFileCall {
    lease: OperationLease,
    name: String,
    file: FileAdmissionPreparation,
}
pub struct AdmittedContextFileCall {
    lease: OperationLease,
    name: String,
    file: FileAdmission,
}
impl PreparedContextFileCall {
    pub fn path(&self) -> &std::path::Path {
        self.file.path()
    }
    pub fn needs_external_read(&self) -> bool {
        self.file.needs_external_read()
    }
    pub fn receipt(&self) -> &str {
        &self.lease.id
    }
    pub fn admit(self, receipt: Option<String>) -> Result<AdmittedContextFileCall> {
        Ok(AdmittedContextFileCall {
            lease: self.lease,
            name: self.name,
            file: self.file.admit(receipt)?,
        })
    }
}
impl AdmittedContextFileCall {
    pub async fn execute(self, mut payload: Value) -> Result<Value> {
        let Self { lease, name, file } = self;
        let args = &mut payload["args"];
        let mut value = args[2].take();
        let context = crate::tools::ToolContext {
            session_id: value["sessionId"].as_str().unwrap_or("").into(),
            cwd: value["cwd"].as_str().unwrap_or("").into(),
            env: value["env"].take(),
            current_turn: value["currentTurn"].as_u64().unwrap_or(0) as u32,
            tool_use_id: value["toolUseId"]
                .as_str()
                .unwrap_or(&lease.operation.tool_use_id)
                .into(),
            cancellation: lease.operation.cancellation.clone(),
            harness: lease.operation.harness.clone(),
        };
        lease
            .tools
            .execute_builtin_admitted(&name, args[1].take(), context, Some(file))
            .await
    }
}

pub struct ToolContextGuard<'a> {
    bridge: &'a ToolContextBridge,
    tool_use_id: String,
}

impl ToolContextBridge {
    pub fn new(cost: Arc<Mutex<CostTracker>>) -> Self {
        Self {
            cost: Mutex::new(cost),
            active: Mutex::new(HashMap::new()),
            services: Mutex::new(Weak::new()),
            operations: Mutex::new(HashMap::new()),
        }
    }
    pub fn harness(&self, tool_use_id: &str) -> Result<Arc<crate::harness::ResolvedHarness>> {
        self.active
            .lock()
            .unwrap()
            .get(tool_use_id)
            .map(|context| context.harness.clone())
            .ok_or_else(|| Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available"))
    }
    pub fn set_cost(&self, cost: Arc<Mutex<CostTracker>>) {
        *self.cost.lock().unwrap() = cost;
    }

    pub fn enter(
        &self,
        tool_use_id: &str,
        tools: Arc<ToolRuntime>,
        events: Arc<dyn EventSink>,
    ) -> Result<ToolContextGuard<'_>> {
        self.enter_with_harness(tool_use_id, tools, events, crate::harness::baseline())
    }
    pub fn enter_with_harness(
        &self,
        tool_use_id: &str,
        tools: Arc<ToolRuntime>,
        events: Arc<dyn EventSink>,
        harness: Arc<crate::harness::ResolvedHarness>,
    ) -> Result<ToolContextGuard<'_>> {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(tool_use_id) {
            return Err(Error::new(
                "DUPLICATE_TOOL_CALL",
                "Tool context is already active",
            ));
        }
        *self.services.lock().unwrap() = Arc::downgrade(&tools);
        let cost = self.cost.lock().unwrap().clone();
        active.insert(
            tool_use_id.to_owned(),
            ActiveContext {
                tools,
                events,
                harness,
                cost,
            },
        );
        Ok(ToolContextGuard {
            bridge: self,
            tool_use_id: tool_use_id.to_owned(),
        })
    }

    pub fn call(&self, tool_use_id: &str, method: &str, args: Value) -> Result<Value> {
        if method == "context.cancel" || method == "context.end" {
            let mut operations = self.operations.lock().unwrap();
            let id = args[0].as_str().unwrap_or("");
            if operations
                .get(id)
                .is_some_and(|operation| operation.tool_use_id == tool_use_id)
            {
                if method == "context.end" {
                    operations.remove(id);
                } else {
                    operations[id].cancellation.cancel();
                }
            }
            return Ok(Value::Null);
        }
        if method == "context.begin" {
            let (tools, harness) = self.scope(tool_use_id, args[1].as_str().unwrap_or(""))?;
            let id = args[0].as_str().ok_or_else(|| {
                Error::new(
                    "INVALID_CONTEXT_OPERATION",
                    "Context operation identifier is missing",
                )
            })?;
            let mut operations = self.operations.lock().unwrap();
            if operations.contains_key(id) {
                return Err(Error::new(
                    "INVALID_CONTEXT_OPERATION",
                    "Context operation identifier is already active",
                ));
            }
            operations.insert(
                id.to_owned(),
                Arc::new(ContextOperation {
                    tool_use_id: tool_use_id.to_owned(),
                    cancellation: CancellationToken::new(),
                    cancel_on_return: args[1] == "backgroundTasks.start",
                    tools: Arc::downgrade(&tools),
                    harness,
                }),
            );
            return Ok(Value::Null);
        }
        let tools = self.tools(tool_use_id, method)?;
        if let Some(method) = method.strip_prefix("costTracker.") {
            let cost = self
                .active
                .lock()
                .unwrap()
                .get(tool_use_id)
                .map(|context| context.cost.clone())
                .ok_or_else(|| {
                    Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
                })?;
            let result = cost.lock().unwrap().call(method, &args);
            return result;
        }

        let harness = self
            .active
            .lock()
            .unwrap()
            .get(tool_use_id)
            .map(|context| context.harness.clone())
            .unwrap_or_else(|| tools.resolved_harness());
        tools.tool_context_call_with_harness(method, args, &harness)
    }

    fn tools(&self, tool_use_id: &str, method: &str) -> Result<Arc<ToolRuntime>> {
        self.active
            .lock()
            .unwrap()
            .get(tool_use_id)
            .map(|context| context.tools.clone())
            .or_else(|| {
                method
                    .starts_with("backgroundTasks.")
                    .then(|| self.services.lock().unwrap().upgrade())
                    .flatten()
            })
            .ok_or_else(|| Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available"))
    }

    fn scope(
        &self,
        tool_use_id: &str,
        method: &str,
    ) -> Result<(Arc<ToolRuntime>, Arc<crate::harness::ResolvedHarness>)> {
        if let Some(scope) = self
            .active
            .lock()
            .unwrap()
            .get(tool_use_id)
            .map(|context| (context.tools.clone(), context.harness.clone()))
        {
            return Ok(scope);
        }
        let tools = self.tools(tool_use_id, method)?;
        let harness = tools.resolved_harness();
        Ok((tools, harness))
    }

    pub fn prepare_file_call(
        self: &Arc<Self>,
        tool_use_id: &str,
        method: &str,
        payload: &Value,
    ) -> Result<Option<PreparedContextFileCall>> {
        if method != "builtin.execute" {
            return Ok(None);
        }
        let id = payload["operationId"].as_str().ok_or_else(|| {
            Error::new(
                "INVALID_CONTEXT_OPERATION",
                "Context operation identifier is missing",
            )
        })?;
        let operation = self
            .operations
            .lock()
            .unwrap()
            .get(id)
            .filter(|operation| operation.tool_use_id == tool_use_id)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    "INVALID_CONTEXT_OPERATION",
                    "Context operation is no longer active",
                )
            })?;
        let args = &payload["args"];
        let name = args[0].as_str().unwrap_or("");
        let tools = operation.tools.upgrade().ok_or_else(|| {
            Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
        })?;
        let Some(file) =
            tools.prepare_file_admission(name, &args[1], args[2]["cwd"].as_str().unwrap_or(""))
        else {
            return Ok(None);
        };
        Ok(Some(PreparedContextFileCall {
            lease: OperationLease {
                bridge: self.clone(),
                id: id.into(),
                operation,
                tools,
            },
            name: name.into(),
            file,
        }))
    }

    pub async fn async_call(
        &self,
        tool_use_id: &str,
        method: &str,
        payload: Value,
    ) -> Result<Value> {
        let tools = self.tools(tool_use_id, method)?;
        let operation_id = payload["operationId"].as_str().ok_or_else(|| {
            Error::new(
                "INVALID_CONTEXT_OPERATION",
                "Context operation identifier is missing",
            )
        })?;
        let cancellation = self
            .operations
            .lock()
            .unwrap()
            .get(operation_id)
            .filter(|operation| operation.tool_use_id == tool_use_id)
            .map(|operation| operation.cancellation.clone())
            .ok_or_else(|| {
                Error::new(
                    "INVALID_CONTEXT_OPERATION",
                    "Context operation is no longer active",
                )
            })?;
        let _operation = PendingOperation {
            bridge: self,
            id: operation_id.to_owned(),
        };
        let harness = self
            .active
            .lock()
            .unwrap()
            .get(tool_use_id)
            .map(|context| context.harness.clone())
            .unwrap_or_else(|| tools.resolved_harness());
        if method == "builtin.execute" {
            let args = &payload["args"];
            let context = &args[2];
            let context = crate::tools::ToolContext {
                session_id: context["sessionId"].as_str().unwrap_or("").into(),
                cwd: context["cwd"].as_str().unwrap_or("").into(),
                env: context["env"].clone(),
                current_turn: context["currentTurn"].as_u64().unwrap_or(0) as u32,
                tool_use_id: context["toolUseId"].as_str().unwrap_or(tool_use_id).into(),
                cancellation: cancellation.clone(),
                harness,
            };
            return tools
                .execute_builtin(args[0].as_str().unwrap_or(""), args[1].clone(), context)
                .await;
        }
        tools
            .tool_context_async_call_with_harness(
                method,
                payload["args"].clone(),
                &cancellation,
                harness,
            )
            .await
    }

    pub async fn emit(&self, tool_use_id: &str, event: Value) -> Result<()> {
        let events = self
            .active
            .lock()
            .unwrap()
            .get(tool_use_id)
            .map(|context| context.events.clone())
            .ok_or_else(|| {
                Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
            })?;
        events.emit(event).await
    }
}

impl Drop for ToolContextGuard<'_> {
    fn drop(&mut self) {
        self.bridge.active.lock().unwrap().remove(&self.tool_use_id);
        for operation in self.bridge.operations.lock().unwrap().values() {
            if operation.tool_use_id == self.tool_use_id && operation.cancel_on_return {
                operation.cancellation.cancel();
            }
        }
    }
}

struct PendingOperation<'a> {
    bridge: &'a ToolContextBridge,
    id: String,
}
impl Drop for PendingOperation<'_> {
    fn drop(&mut self) {
        self.bridge.operations.lock().unwrap().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;

    struct Host;
    #[async_trait]
    impl crate::bridge::HostBridge for Host {
        async fn call(&self, _: &str, _: Value, _: &CancellationToken) -> Result<Value> {
            unreachable!()
        }
    }
    #[async_trait]
    impl EventSink for Host {
        async fn emit(&self, _: Value) -> Result<()> {
            Ok(())
        }
    }
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[tokio::test]
    async fn an_admitted_file_call_retains_its_owner_and_cannot_remove_a_reused_operation() {
        let directory = Directory(
            std::env::temp_dir().join(format!("halo-context-admission-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir(&directory.0).unwrap();
        let path = directory.0.join("file.txt");
        std::fs::write(&path, "original").unwrap();
        let options = json!({"cwd":directory.0,"persistSession":false,"nativeProcessEnv":{}});
        let original = Arc::new(ToolRuntime::new(
            options.clone(),
            Arc::new(Host),
            Arc::new(Host),
        ));
        let mut options = options;
        options["nativeOwner"] = json!({"readFileStatePresent":false});
        let replacement = Arc::new(ToolRuntime::new(options, Arc::new(Host), Arc::new(Host)));
        let bridge = Arc::new(ToolContextBridge::new(Arc::new(Mutex::new(
            CostTracker::new("fixture", 200_000., json!({})),
        ))));
        let first = bridge
            .enter("same-tool", original.clone(), Arc::new(Host))
            .unwrap();
        bridge
            .call(
                "same-tool",
                "context.begin",
                json!(["same-operation", "builtin.execute"]),
            )
            .unwrap();
        let payload = json!({"operationId":"same-operation","args":["Write",{"file_path":path,"content":"replaced"},{"cwd":directory.0,"sessionId":"original","toolUseId":"same-tool","env":{}}]});
        let admitted = bridge
            .prepare_file_call("same-tool", "builtin.execute", &payload)
            .unwrap()
            .unwrap()
            .admit(None)
            .unwrap();
        bridge
            .call("same-tool", "context.end", json!(["same-operation"]))
            .unwrap();
        drop(first);
        let second = bridge
            .enter("same-tool", replacement.clone(), Arc::new(Host))
            .unwrap();
        bridge
            .call(
                "same-tool",
                "context.begin",
                json!(["same-operation", "builtin.execute"]),
            )
            .unwrap();
        let next_operation = bridge.operations.lock().unwrap()["same-operation"].clone();
        let result = admitted.execute(payload).await.unwrap();
        assert_eq!(result["isError"], true);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
        assert!(Arc::ptr_eq(
            &bridge.operations.lock().unwrap()["same-operation"],
            &next_operation
        ));
        bridge
            .call("same-tool", "context.end", json!(["same-operation"]))
            .unwrap();
        drop(second);
        original.close().await.unwrap();
        replacement.close().await.unwrap();
    }
}
