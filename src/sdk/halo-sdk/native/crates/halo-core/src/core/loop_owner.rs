use super::{cost::CostTracker, tool_context_bridge::ToolContextBridge};
use crate::{
    bridge::{EventSink, HostBridge},
    error::Result,
    harness::Harness,
    tools::ToolRuntime,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU32, AtomicU64},
    Arc, Mutex,
};
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait LoopOwner: Send + Sync {
    async fn apply_controls(&self, _options: &mut Value) -> Result<Option<u64>> {
        Ok(None)
    }
    async fn pending_usage(&self) -> Result<Value> {
        Ok(json!({}))
    }
    async fn budget_spent(&self) -> Result<Option<f64>> {
        Ok(None)
    }
    async fn usage(&self, _usage: Value, _model: &str) -> Result<()> {
        Ok(())
    }
    fn replay_pending_input(&self) -> bool { true }
    async fn pending_input(&self, _options: &Value) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn changed_tools(&self) -> Result<Option<Vec<Value>>> {
        Ok(None)
    }
    async fn notices(&self, tools: &ToolRuntime) -> Result<Value> {
        Ok(json!(tools.drain_background_notices().await))
    }
    async fn goal_change(&self, tools: &ToolRuntime) -> Result<Value> {
        Ok(tools.drain_goal_change())
    }
    async fn goal(&self, tools: &ToolRuntime) -> Result<Value> {
        Ok(tools.get_goal())
    }
    async fn todos(&self, tools: &ToolRuntime) -> Result<Value> {
        Ok(tools.todos())
    }
    async fn todo_attachment(&self, tools: &ToolRuntime) -> Result<Value> {
        Ok(tools.todo_attachment().unwrap_or(Value::Null))
    }
    async fn context_message(&self, _message: &Value) -> Result<()> {
        Ok(())
    }
    async fn assistant_block(&self, _message: &Value, _response_uuid: &str) -> Result<()> {
        Ok(())
    }
    async fn assistant_message(&self, _message: &Value) -> Result<()> {
        Ok(())
    }
    async fn discarded_response(&self, _message: &Value) -> Result<()> {
        Ok(())
    }
    async fn tool_result_message(&self, _message: &Value) -> Result<()> {
        Ok(())
    }
    async fn compact(&self, _messages: &[Value], _summary: &str) -> Result<()> {
        Ok(())
    }
    async fn history_replaced(&self, _messages: &[Value]) -> Result<()> {
        Ok(())
    }
    async fn context_state(
        &self,
        _model: &str,
        _compacted: Option<f64>,
        _deferred: Option<f64>,
    ) -> Result<()> {
        Ok(())
    }
    async fn tool_context_changed(&self, _state: Arc<Mutex<super::tool_context::State>>) -> Result<()> {
        Ok(())
    }
    fn transcript_path(&self, options: &Value, session_id: &str) -> String {
        crate::history::transcript_path(session_id, options)
            .to_string_lossy()
            .into_owned()
    }
}

#[derive(Clone, Copy)]
pub enum ProgressTiming {
    Before,
    After,
    None,
}
impl ProgressTiming {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
            Self::None => "none",
        }
    }
}
#[async_trait]
pub trait LoopOutput: Send + Sync {
    async fn publish(&self, event: Value, progress: ProgressTiming) -> Result<()>;
}
pub struct DirectOutput(pub Arc<dyn EventSink>);
#[async_trait]
impl LoopOutput for DirectOutput {
    async fn publish(&self, event: Value, _progress: ProgressTiming) -> Result<()> {
        self.0.emit(event).await
    }
}
struct ToolOutput(Arc<dyn LoopOutput>);
#[async_trait]
impl EventSink for ToolOutput {
    async fn emit(&self, event: Value) -> Result<()> {
        self.0.publish(event, ProgressTiming::Before).await
    }
}

pub struct SharedToolState {
    pub run_id: String,
    pub read_identity: String,
    pub cost: Arc<Mutex<CostTracker>>,
    pub reads: Arc<crate::tools::FileReadStateStore>,
    pub text: Arc<crate::harness::ResolvedHarness>,
    pub skills: super::skill_catalog_view::SkillCatalogSnapshot,
}

#[derive(Clone)]
pub struct LoopExecution {
    pub session_id: String,
    pub harness: Arc<Harness>,
    pub cost: Arc<Mutex<CostTracker>>,
    pub tool_context: Arc<ToolContextBridge>,
    pub api_time_ms: Arc<AtomicU64>,
    pub turn_count: Arc<AtomicU32>,
    pub permission_denials: Arc<Mutex<Vec<Value>>>,
    pub lifetime: CancellationToken,
    pub bridge: Arc<dyn HostBridge>,
    pub events: Arc<dyn LoopOutput>,
    pub owner: Arc<dyn LoopOwner>,
}

impl LoopExecution {
    pub fn tool_events(&self) -> Arc<dyn EventSink> {
        Arc::new(ToolOutput(self.events.clone()))
    }
    pub async fn emit_unobserved(&self, event: Value) -> Result<()> {
        self.events.publish(event, ProgressTiming::None).await
    }
    pub async fn collect_usage(&self) -> Result<()> {
        let usage = self.owner.pending_usage().await?;
        self.cost.lock().unwrap().add_reported_usage(&usage);
        Ok(())
    }
    pub async fn budget_spent(&self) -> Result<f64> {
        Ok(self
            .owner
            .budget_spent()
            .await?
            .unwrap_or_else(|| self.cost.lock().unwrap().total_cost_usd()))
    }
    pub async fn charge_usage(&self, usage: &Value, model: &str) -> Result<()> {
        let receipt = self.cost.lock().unwrap().add(usage, Some(model));
        self.owner.usage(receipt, model).await
    }
}

#[async_trait]
impl HostBridge for LoopExecution {
    fn code_search_pool(&self)->Option<Arc<crate::search::CodeSearchPool>>{self.bridge.code_search_pool()}
    fn http_trust(&self)->Option<Arc<crate::http::HostTrust>>{self.bridge.http_trust()}
    fn resource_activity(&self)->Option<Arc<crate::resource_activity::ResourceActivity>>{self.bridge.resource_activity()}
    async fn call(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        self.bridge.call(method, params, cancellation).await
    }
}

#[async_trait]
impl EventSink for LoopExecution {
    async fn emit(&self, event: Value) -> Result<()> {
        self.events.publish(event, ProgressTiming::After).await
    }
}
