use super::{
    compact::session::ContextState,
    cost::CostTracker,
    loop_budget::LoopBudget,
    loop_owner::{LoopExecution, LoopOutput, LoopOwner, ProgressTiming, SharedToolState},
    loop_runtime::{self, LoopContext},
    token_budget::TokenBudget,
    tool_context_bridge::ToolContextBridge,
};
use crate::{
    bridge::{EventSink, HostBridge},
    callback_channel::CallbackChannel,
    error::{Error, Result},
    harness::Harness,
    js::{is_undefined, number},
    llm::provider::Provider,
    tools::ToolRuntime,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};
use tokio_util::sync::CancellationToken;

type DiscoverySlot = Arc<Mutex<Option<Arc<Mutex<super::tool_context::State>>>>>;

pub struct PublicLoop {
    discovery: DiscoverySlot,
    channel: Arc<CallbackChannel>,
    execution: Arc<LoopExecution>,
    budget: Arc<Mutex<TokenBudget>>,
    replaced_budget: bool,
    run_id: String,
    catalog_views: Arc<super::skill_catalog_view::SkillCatalogOwner>,
    tools: Mutex<Option<Arc<ToolRuntime>>>,
    flow: Arc<FlowOutput>,
}

impl PublicLoop {
    pub fn start(
        mut config: Value,
        tools: Value,
        initial: Value,
        options: Value,
        supplied_budget: Option<Arc<Mutex<TokenBudget>>>,
        services: crate::bridge::HostServices,
        supplied_discovery: Option<Arc<Mutex<super::tool_context::State>>>,
    ) -> Result<Arc<Self>> {
        let session_id = options
            .get("sessionId")
            .filter(|value| !value.is_null() && !is_undefined(value))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let model = config["model"].as_str().unwrap_or("").to_owned();
        let window = number(&config["contextWindow"]).unwrap_or(200_000.0);
        let output = number(&config["maxTokens"]).unwrap_or(16_384.0);
        config["maxOutputTokens"] = crate::js::number_value(output);
        config["nativeResolvedConfig"] = json!(true);
        config["nativeLoop"] = json!(true);
        config["sessionId"] = json!(session_id);
        config["nativeSuppliedTools"] = tools;
        if let Some(catalog) = options
            .get("skillCatalog")
            .filter(|value| !is_undefined(value))
        {
            config["skillCatalog"] = catalog.clone();
        }
        let reusable = supplied_budget.as_ref().is_some_and(|budget| {
            let budget = budget.lock().unwrap();
            options["contextState"]["sameProvider"] == true
                && options["contextState"]["model"] == model
                && budget.context_window == window
                && budget.max_output_tokens == output
        });
        let replaced_budget = supplied_budget.is_some() && !reusable;
        let budget = if reusable {
            supplied_budget.unwrap()
        } else {
            if let Some(previous) = supplied_budget {
                previous.lock().unwrap().reset();
            }
            Arc::new(Mutex::new(TokenBudget::new(window, output)))
        };
        let harness = Harness::from_config(&config["harnessText"])?;
        let cost = Arc::new(Mutex::new(CostTracker::new(
            &model,
            window,
            config["modelPricing"].clone(),
        )));
        let context = Arc::new(ToolContextBridge::new(cost.clone()));
        let run_id = uuid::Uuid::new_v4().to_string();
        config["nativeCatalogOwner"] = json!(run_id);
        let (start, receiver) = tokio::sync::oneshot::channel::<Arc<PublicLoop>>();
        let run_options = options.clone();
        let channel = CallbackChannel::spawn_graceful(move |_| async move {
            let execution = receiver.await.map_err(|_| Error::cancelled())?;
            let _cleanup = RunCleanup(execution.clone());
            let result = execution.run(config, initial, run_options, reusable).await;
            let tools = execution.tools.lock().unwrap().clone();
            if let Some(tools) = tools {
                if let Err(error) = tools.close().await {
                    tools.abort_now();
                    tracing::warn!(session_id=%execution.execution.session_id,code=%error.code,"Public loop resource cleanup failed");
                }
            }
            execution.tools.lock().unwrap().take();
            execution.catalog_views.close();
            result.map(|_| None)
        })?;
        channel.set_host_services(services);
        let discovery = Arc::new(Mutex::new(supplied_discovery));
        let owner = Arc::new(CallbackOwner {
            discovery: discovery.clone(),
            channel: channel.clone(),
            options,
            revision: AtomicU64::new(0),
        });
        let flow = Arc::new(FlowOutput {
            channel: channel.clone(),
            flow: super::event_flow::EventFlow::default(),
        });
        let execution = Arc::new(LoopExecution {
            session_id,
            harness,
            cost,
            tool_context: context,
            api_time_ms: Arc::new(AtomicU64::new(0)),
            turn_count: Arc::new(AtomicU32::new(0)),
            permission_denials: Arc::new(Mutex::new(Vec::new())),
            lifetime: channel.cancellation(),
            bridge: channel.clone(),
            events: flow.clone(),
            owner,
        });
        let result = Arc::new(Self {
            discovery,
            channel,
            execution,
            budget,
            replaced_budget,
            catalog_views: Arc::new(super::skill_catalog_view::SkillCatalogOwner::new(run_id.clone())),
            run_id,
            tools: Mutex::new(None),
            flow,
        });
        start.send(result.clone()).map_err(|_| Error::cancelled())?;
        Ok(result)
    }

    async fn run(
        &self,
        config: Value,
        initial: Value,
        options: Value,
        reusable: bool,
    ) -> Result<()> {
        let started = std::time::Instant::now();
        let cancellation = self.channel.interruption();
        let resolved = self
            .execution
            .harness
            .for_model(config["model"].as_str().unwrap_or(""));
        let provider = Provider::new(&config, self.channel.clone())?;
        let mut tools =
            ToolRuntime::new(config.clone(), self.channel.clone(), self.channel.clone());
        tools.set_harness(resolved.clone());
        if let Some(roots) = config["readDenyRoots"].as_array() {
            tools.attach_read_deny_floor(
                &roots
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            );
        }
        if let Err(error) = tools.initialize(&self.channel.cancellation()).await {
            tools.abort_now();
            tools.close().await?;
            return Err(error);
        }
        let tools = Arc::new(tools);
        *self.tools.lock().unwrap() = Some(tools.clone());
        let mut messages = if initial.is_string() {
            vec![json!({"role":"user","content":initial})]
        } else {
            initial.as_array().cloned().unwrap_or_default()
        };
        let initial_tool_revision = tools.tool_catalog_revision();
        let initial_catalog: Vec<_> = tools
            .selected_tools()
            .iter()
            .map(crate::tools::SelectedTool::catalog_entry)
            .collect();
        let supplied_discovery = self.discovery.lock().unwrap().clone();
        let mut discovery = if supplied_discovery.is_some() {
            supplied_discovery
        } else if options.get("toolContext").is_some_and(Value::is_null) {
            None
        } else {
            let mut state = super::tool_context::prepare_with_harness(
                &config,
                &initial_catalog,
                &messages,
                false,
                resolved.clone(),
            )?;
            if let (Some(state), Some(snapshot)) =
                (&mut state, options["toolContext"].get("snapshot"))
            {
                state.restore(snapshot);
            }
            state.map(|state| Arc::new(Mutex::new(state)))
        };
        *self.discovery.lock().unwrap() = discovery.clone();
        if let Some(state) = &discovery {
            let notice = {
                let state = state.lock().unwrap();
                state.baseline_pending.then(|| state.recovery_message())
            };
            if let Some(notice) = notice {
                if notice["content"] == ""
                    && !messages.is_empty()
                    && !messages
                        .iter()
                        .any(|message| message.get("toolContext").is_some())
                {
                    messages[0]["toolContext"] = notice["toolContext"].clone();
                    messages[0]["toolContext"]["baselineAttachment"] = json!(false);
                } else {
                    self.execution.owner.context_message(&notice).await?;
                    if messages
                        .iter()
                        .any(|message| message.get("toolContext").is_some())
                    {
                        messages.push(notice);
                    } else {
                        messages.insert(0, notice);
                    }
                }
                state.lock().unwrap().baseline_pending = false;
            }
            state.lock().unwrap().finish_step();
        }
        let mut environment = if config["systemPrompt"].is_string() {
            json!({})
        } else {
            crate::prompt::probe_environment(&config).await
        };
        environment["tools"] = json!(tools.definitions());
        let mut context = LoopContext {
            environment,
            memory: Default::default(),
            skill_context: if tools
                .definitions()
                .iter()
                .any(|tool| tool["name"] == "Skill")
            {
                crate::prompt::skill_context::build_with_harness(
                    &tools.skill_catalog_with_harness(&resolved),
                    &resolved,
                )
            } else {
                None
            },
            compaction: ContextState {
                compacted_history_tokens: reusable
                    .then(|| number(&options["contextState"]["compactedHistoryTokens"]))
                    .flatten(),
                deferred_history_tokens: reusable
                    .then(|| number(&options["contextState"]["deferredCompactionTokens"]))
                    .flatten(),
            },
            tool_revision: initial_tool_revision,
            image_input: Default::default(),
            harness: resolved,
            model: config["model"].as_str().unwrap_or("").into(),
            thinking: loop_runtime::thinking(&config),
        };
        let mut definitions = tools.definitions();
        if discovery
            .as_ref()
            .is_some_and(|state| state.lock().unwrap().enabled())
        {
            definitions
                .push(super::tool_context::state::definitions_with_harness(&context.harness).0);
        }
        let mut init = json!({"type":"system","subtype":"init","session_id":self.execution.session_id,
            "tools":definitions.iter().map(|tool|&tool["name"]).collect::<Vec<_>>(),"model":config["model"],"cwd":config["cwd"],"permissionMode":config["permissionMode"],
            "mcp_servers":options.get("mcpServerStatuses").cloned().unwrap_or_else(||json!([])),
            "slash_commands":options.get("slashCommands").cloned().unwrap_or_else(||json!([])),
            "skills":options.get("skills").cloned().unwrap_or_else(||json!([])),"apiKeySource":"user","sdk_version":"1.0.0","uuid":uuid::Uuid::new_v4().to_string()});
        if let Some(betas) = config.get("betas").filter(|value| !is_undefined(value)) {
            init["betas"] = betas.clone();
        }
        self.execution.emit(init).await?;
        let mut budget = LoopBudget::Shared(self.budget.clone());
        let outcome = loop_runtime::turn(
            &self.execution,
            &config,
            &mut context,
            &tools,
            &provider,
            &mut messages,
            &mut budget,
            cancellation.clone(),
            options["completedTurns"].as_u64().unwrap_or(0),
            &mut discovery,
        )
        .await;
        let terminal = outcome.is_err();
        if cancellation.is_cancelled() {
            tools.interrupt().await;
        }
        let event =
            loop_runtime::conclude(&self.execution, outcome, &context, started, &cancellation)
                .await?;
        if let Some(mut event) = event {
            event["permission_denials"] = json!(*self.execution.permission_denials.lock().unwrap());
            if !self.channel.cancellation().is_cancelled() {
                self.execution.emit(event).await?;
                if terminal {
                    loop_runtime::terminal_hooks(
                        &self.execution,
                        &config,
                        &context.harness,
                        &cancellation,
                    )
                    .await;
                }
            }
        }
        Ok(())
    }

    pub fn resource_activity(&self) -> Arc<crate::resource_activity::ResourceActivity> {
        self.channel.resource_activity()
    }
    pub fn tool_discovery_state(&self) -> Option<Arc<Mutex<super::tool_context::State>>> {
        self.discovery.lock().unwrap().clone()
    }
    pub fn token_budget(&self) -> Arc<Mutex<TokenBudget>> {
        self.budget.clone()
    }
    pub fn context_receipt(&self) -> Value {
        json!({"budgetReplaced":self.replaced_budget,"runId":self.run_id,"sessionId":self.execution.session_id})
    }
    pub async fn next(&self) -> Result<Option<Value>> {
        self.channel.next().await
    }
    pub fn callback_response(&self, id: &str, value: Value, error: Option<Value>) -> Result<()> {
        self.channel.callback_response(id, value, error)
    }
    pub fn event_consumed(&self, id: &str, error: Option<Error>) -> Result<()> {
        self.flow.consume(id, error);
        Ok(())
    }
    pub fn interrupt(&self) {
        self.channel.interrupt();
    }
    pub fn close(&self) {
        self.channel.close();
    }
    pub async fn wait_closed(&self) -> Result<()> {
        self.channel.wait_closed().await
    }
    pub fn abort_for_host_shutdown(&self) {
        self.catalog_views.close();
        if let Some(tools) = self.tools.lock().unwrap().as_ref() {
            tools.abort_now();
        }
        self.channel.abort_for_host_shutdown();
    }
    fn context_id(&self, identity: &str) -> Result<String> {
        if let Ok(value) = serde_json::from_str::<Value>(identity) {
            if let Some(values) = value.as_array().filter(|values| values.len() == 2) {
                if values[0] != self.execution.session_id {
                    return Err(Error::new(
                        "TOOL_CONTEXT_CLOSED",
                        "Tool context is no longer available",
                    ));
                }
                return Ok(values[1].as_str().unwrap_or("").into());
            }
        }
        Ok(identity.into())
    }
    pub fn context_call(&self, identity: &str, method: &str, args: Value) -> Result<Value> {
        self.execution
            .tool_context
            .call(&self.context_id(identity)?, method, args)
    }
    pub async fn context_async(&self, identity: &str, method: &str, args: Value) -> Result<Value> {
        self.execution
            .tool_context
            .async_call(&self.context_id(identity)?, method, args)
            .await
    }
    pub fn prepare_context_file(&self, identity: &str, method: &str, args: &Value) -> Result<Option<super::tool_context_bridge::PreparedContextFileCall>> {
        self.execution.tool_context.prepare_file_call(&self.context_id(identity)?, method, args)
    }
    pub async fn context_emit(&self, identity: &str, event: Value) -> Result<()> {
        self.execution
            .tool_context
            .emit(&self.context_id(identity)?, event)
            .await
    }
    pub fn shared_context(&self, identity: &str, expected_owner: Option<&str>) -> Result<SharedToolState> {
        if expected_owner.is_some_and(|owner| owner != self.catalog_views.identity()) {
            return Err(Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available"));
        }
        let id = self.context_id(identity)?;
        let tools = self
            .tools
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::new("LOOP_NOT_READY", "Loop is not ready"))?;
        let text = self.execution.tool_context.harness(&id)?;
        let skills = self.catalog_views.snapshot(tools.skill_catalog_scope(&text), || tools.skill_catalog_with_harness(&text))?;
        Ok(SharedToolState {
            run_id: self.run_id.clone(),
            read_identity: self.run_id.clone(),
            cost: self.execution.cost.clone(),
            reads: tools.shared_read_state(),
            text,
            skills,
        })
    }
}
impl Drop for PublicLoop {
    fn drop(&mut self) { self.catalog_views.close(); }
}
struct RunCleanup(Arc<PublicLoop>);
impl Drop for RunCleanup {
    fn drop(&mut self) {
        if self.0.tools.lock().unwrap().is_some() {
            self.0.abort_for_host_shutdown();
        }
    }
}

struct CallbackOwner {
    discovery: DiscoverySlot,
    channel: Arc<CallbackChannel>,
    options: Value,
    revision: AtomicU64,
}
impl CallbackOwner {
    fn has(&self, name: &str) -> bool {
        self.options["callbacks"][name] == true
    }
    async fn call(&self, name: &str, args: Value) -> Result<Value> {
        if !self.has(name) {
            return Ok(crate::js::undefined());
        }
        self.channel
            .call(
                "loop.call",
                json!({"name":name,"args":args}),
                &CancellationToken::new(),
            )
            .await
    }
    async fn value(&self, name: &str, default: Value) -> Result<Value> {
        let value = self.call(name, json!([])).await?;
        Ok(if value.is_null() || is_undefined(&value) {
            default
        } else {
            value
        })
    }
    async fn observe(&self, name: &str, args: Value) -> Result<()> {
        self.call(name, args).await?;
        Ok(())
    }
}
#[async_trait]
impl LoopOwner for CallbackOwner {
    async fn apply_controls(&self, options: &mut Value) -> Result<Option<u64>> {
        if self.options["hasConfigOverrides"] != true {
            return Ok(None);
        }
        let overrides = self
            .channel
            .call("loop.overrides", json!({}), &CancellationToken::new())
            .await?;
        let mut revision = self.revision.load(Ordering::Relaxed);
        if let Some(model) = overrides.get("model").filter(|value| !is_undefined(value)) {
            options["model"] = model.clone();
            revision = self.revision.fetch_add(1, Ordering::Relaxed) + 1;
        }
        if let Some(mode) = overrides
            .get("permissionMode")
            .filter(|value| !is_undefined(value))
        {
            options["permissionMode"] = mode.clone();
        }
        if let Some(tokens) = overrides
            .get("maxThinkingTokens")
            .filter(|value| !is_undefined(value))
        {
            options["maxThinkingTokens"] = tokens.clone();
            options["thinkingExplicit"] = json!(true);
            options["thinking"] =
                if tokens.is_null() || number(tokens).is_some_and(|tokens| tokens <= 0.0) {
                    json!({"type":"disabled"})
                } else if options["adaptiveThinking"] == true {
                    json!({"type":"adaptive"})
                } else {
                    json!({"type":"enabled","budgetTokens":tokens})
                };
        }
        self.channel.call("loop.configApplied",json!({"permissionMode":options["permissionMode"],"thinking":options["thinking"],"thinkingExplicit":options["thinkingExplicit"]}),&CancellationToken::new()).await?;
        Ok(Some(revision))
    }
    async fn pending_usage(&self) -> Result<Value> {
        self.value("getPendingUsage", json!({})).await
    }
    async fn budget_spent(&self) -> Result<Option<f64>> {
        Ok(number(&self.call("getBudgetSpent", json!([])).await?))
    }
    async fn usage(&self, usage: Value, model: &str) -> Result<()> {
        self.observe("onUsage", json!([usage, model])).await
    }
    async fn pending_input(&self, _options: &Value) -> Result<Option<Value>> {
        let value = self.call("getPendingUserMessage", json!([])).await?;
        Ok((!value.is_null() && !is_undefined(&value)).then_some(value))
    }
    async fn changed_tools(&self) -> Result<Option<Vec<Value>>> {
        Ok(self
            .call("getToolState", json!([]))
            .await?
            .as_array()
            .cloned())
    }
    async fn notices(&self, _tools: &ToolRuntime) -> Result<Value> {
        self.value("getPendingNotices", json!([])).await
    }
    async fn goal_change(&self, _tools: &ToolRuntime) -> Result<Value> {
        self.value("drainGoalChange", Value::Null).await
    }
    async fn goal(&self, _tools: &ToolRuntime) -> Result<Value> {
        self.value("getGoal", Value::Null).await
    }
    async fn todos(&self, _tools: &ToolRuntime) -> Result<Value> {
        self.value("getPendingTodos", json!([])).await
    }
    async fn todo_attachment(&self, _tools: &ToolRuntime) -> Result<Value> {
        self.value("getTodoAttachment", Value::Null).await
    }
    async fn context_message(&self, message: &Value) -> Result<()> {
        self.observe("onContextMessage", json!([message])).await
    }
    async fn assistant_block(&self, message: &Value, response: &str) -> Result<()> {
        self.observe("onAssistantBlock", json!([message, response]))
            .await
    }
    async fn assistant_message(&self, message: &Value) -> Result<()> {
        self.observe("onAssistantMessage", json!([message])).await
    }
    async fn tool_result_message(&self, message: &Value) -> Result<()> {
        self.observe("onToolResultMessage", json!([message])).await
    }
    async fn compact(&self, messages: &[Value], summary: &str) -> Result<()> {
        self.observe("onCompact", json!([messages, summary])).await
    }
    async fn history_replaced(&self, messages: &[Value]) -> Result<()> {
        self.observe("onHistoryCompacted", json!([messages])).await
    }
    async fn context_state(
        &self,
        model: &str,
        compacted: Option<f64>,
        deferred: Option<f64>,
    ) -> Result<()> {
        if self.options["contextState"].is_object() {
            let mut state = json!({"model":model});
            if let Some(tokens) = compacted {
                state["compactedHistoryTokens"] = crate::js::number_value(tokens);
            }
            if let Some(tokens) = deferred {
                state["deferredCompactionTokens"] = crate::js::number_value(tokens);
            }
            self.channel
                .call("loop.contextState", state, &CancellationToken::new())
                .await?;
        }
        Ok(())
    }
    async fn tool_context_changed(
        &self,
        state: Arc<Mutex<super::tool_context::State>>,
    ) -> Result<()> {
        *self.discovery.lock().unwrap() = Some(state);
        self.observe("onToolContextChange", json!([])).await
    }
    fn transcript_path(&self, options: &Value, session: &str) -> String {
        self.options["transcriptPath"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                crate::history::transcript_path(session, options)
                    .to_string_lossy()
                    .into_owned()
            })
    }
}

struct FlowOutput {
    channel: Arc<CallbackChannel>,
    flow: super::event_flow::EventFlow,
}
impl FlowOutput {
    fn consume(&self, id: &str, error: Option<Error>) {
        self.flow.consume(id, error);
    }
}
#[async_trait]
impl LoopOutput for FlowOutput {
    async fn publish(&self, event: Value, progress: ProgressTiming) -> Result<()> {
        self.flow
            .publish(event, progress, &self.channel.cancellation(), |envelope| {
                self.channel.envelope(envelope)
            })
            .await
    }
}
