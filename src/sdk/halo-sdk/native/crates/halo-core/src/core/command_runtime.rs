use super::{loop_runtime::LoopContext, loop_owner::LoopExecution, token_budget::TokenBudget, tool_context};
use crate::{
    bridge::HostBridge,
    commands::{CommandHost, CommandRegistry, DispatchOutcome},
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    history::Journal,
    session::{Command, NativeSession},
    tools::ToolRuntime,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
#[path = "command_runtime/tests.rs"]
mod tests;

#[derive(Default)]
struct Overrides {
    model: Option<String>,
    permission_mode: Option<Value>,
    thinking: Option<Value>,
    model_revision: u64,
}
#[derive(Default)]
struct Costs {
    total_cost: f64,
    duration: f64,
    api_duration: f64,
    turns: u64,
    tokens: [f64; 4],
}
pub(crate) struct PreparedCommands {
    pub registry: CommandRegistry,
    advertised: Vec<String>,
    initial_mcp: Vec<Value>,
}
pub(crate) struct SessionControls {
    initial_model: String,
    adaptive_thinking: bool,
    values: Mutex<Overrides>,
    costs: Mutex<Costs>,
    prepared: OnceLock<PreparedCommands>,
}
impl SessionControls {
    pub fn new(options: &Value) -> Self {
        let saved = &options["nativeCheckpoint"]["costs"];
        Self {
            initial_model: options["model"].as_str().unwrap_or("").into(),
            adaptive_thinking: options["adaptiveThinking"] == true,
            values: Mutex::new(Overrides::default()),
            costs: Mutex::new(Costs {
                total_cost: saved["totalCostUsd"].as_f64().unwrap_or(0.0),
                duration: saved["totalDurationMs"].as_f64().unwrap_or(0.0),
                api_duration: saved["totalApiDurationMs"].as_f64().unwrap_or(0.0),
                turns: saved["numTurns"].as_u64().unwrap_or(0),
                tokens: ["input", "output", "cacheCreate", "cacheRead"].map(|key| saved["tokens"][key].as_f64().unwrap_or(0.0)),
            }),
            prepared: OnceLock::new(),
        }
    }
    pub fn update(&self, name: &str, payload: &Value) -> bool {
        let mut values = self.values.lock().unwrap();
        match name {
            "setModel" => {
                values.model = Some(payload[0].as_str().unwrap_or(&self.initial_model).into());
                values.model_revision = values.model_revision.wrapping_add(1);
            }
            "setPermissionMode" => values.permission_mode = Some(payload[0].clone()),
            "setMaxThinkingTokens" => {
                values.thinking = Some(
                    if payload[0].is_null()
                        || crate::js::is_undefined(&payload[0])
                        || crate::js::number(&payload[0]).unwrap_or(0.0) <= 0.0
                    {
                        json!({"type":"disabled"})
                    } else if self.adaptive_thinking {
                        json!({"type":"adaptive"})
                    } else {
                        json!({"type":"enabled","budgetTokens":payload[0]})
                    },
                );
            }
            _ => return false,
        }
        true
    }
    pub fn apply(&self, options: &mut Value) -> u64 {
        let values = self.values.lock().unwrap();
        if let Some(model) = &values.model {
            options["model"] = json!(model);
        }
        if let Some(mode) = &values.permission_mode {
            options["permissionMode"] = mode.clone();
        }
        if let Some(thinking) = &values.thinking {
            options["thinking"] = thinking.clone();
            options["thinkingExplicit"] = json!(true);
        }
        values.model_revision
    }
    pub fn options(&self, original: &Value) -> Value {
        let mut options = original.clone();
        self.apply(&mut options);
        options
    }
    pub async fn prepare(
        &self,
        options: &Value,
        tools: &ToolRuntime,
        bridge: &dyn HostBridge,
        cancellation: &CancellationToken,
        harness: &ResolvedHarness,
    ) -> Result<()> {
        let skills = tools.skill_catalog_with_harness(harness);
        let registry = CommandRegistry::from_options_with_harness(
            options,
            &skills,
            tools
                .definitions()
                .iter()
                .any(|tool| tool["name"] == "Skill"),
            harness,
        )?;
        let advertised = registry
            .list_with_harness(bridge, cancellation, harness)
            .await?
            .iter()
            .map(|command| command["name"].as_str().unwrap().to_owned())
            .collect();
        self.prepared
            .set(PreparedCommands {
                registry,
                advertised,
                initial_mcp: tools.mcp_statuses(),
            })
            .map_err(|_| {
                Error::template(
                    "COMMANDS_ALREADY_PREPARED",
                    TextId::CommandsRuntimeAlreadyPrepared,
                    &[],
                )
            })
    }
    pub fn prepared(&self) -> Option<&PreparedCommands> {
        self.prepared.get()
    }
    pub fn supported_commands(&self, harness: &ResolvedHarness) -> Vec<Value> {
        self.prepared
            .get()
            .map(|prepared| {
                prepared
                    .registry
                    .advertised_with_harness(&prepared.advertised, harness)
            })
            .unwrap_or_default()
    }
    pub fn initial_mcp(&self) -> Vec<Value> {
        self.prepared
            .get()
            .map(|prepared| prepared.initial_mcp.clone())
            .unwrap_or_default()
    }
    pub fn record_result(&self, result: &Value) {
        let mut costs = self.costs.lock().unwrap();
        costs.total_cost += result["total_cost_usd"].as_f64().unwrap_or(0.0);
        costs.duration += result["duration_ms"].as_f64().unwrap_or(0.0);
        costs.api_duration += result["duration_api_ms"].as_f64().unwrap_or(0.0);
        costs.turns += 1;
        for (index, key) in [
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ]
        .iter()
        .enumerate()
        {
            costs.tokens[index] += result["usage"][key].as_f64().unwrap_or(0.0);
        }
    }
    pub fn cost_snapshot(&self) -> Value {
        let costs = self.costs.lock().unwrap();
        json!({"totalCostUsd":costs.total_cost,"totalDurationMs":costs.duration,"totalApiDurationMs":costs.api_duration,"numTurns":costs.turns,"tokens":{"input":costs.tokens[0],"output":costs.tokens[1],"cacheCreate":costs.tokens[2],"cacheRead":costs.tokens[3]}})
    }
}

pub(crate) fn configured_models(options: &Value) -> Value {
    let mut models = Vec::new();
    for key in ["model", "fallbackModel"] {
        if let Some(model) = options[key].as_str().filter(|model| !model.is_empty()) {
            if !models.iter().any(|value: &Value| value["value"] == model) {
                models.push(json!({"value":model,"displayName":model,"description":""}));
            }
        }
    }
    json!(models)
}

pub(crate) struct ActorState<'a> {
    pub options: &'a Value,
    pub tools: &'a ToolRuntime,
    pub journal: &'a Journal,
    pub budget: &'a mut TokenBudget,
    pub messages: &'a mut Vec<Value>,
    pub discovery: &'a Option<Arc<Mutex<tool_context::State>>>,
    pub context: &'a mut LoopContext,
    pub manual: Option<(&'a Arc<LoopExecution>, &'a crate::llm::provider::Provider)>,
    pub compacted: Option<bool>,
}
impl ActorState<'_> {
    async fn clear(&mut self, cancellation: &CancellationToken) -> Result<()> {
        if self.options["nativeQuery"] == true {
            return Ok(());
        }
        if cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        if let Some(current) = self.discovery {
            let mut snapshot = current.lock().unwrap().snapshot();
            snapshot["definitions"] = json!([]);
            snapshot["discoveryEntries"] = json!(false);
            snapshot
                .as_object_mut()
                .unwrap()
                .shift_remove("historicalDefinitions");
            let seed = json!({"role":"user","content":"","isMeta":true,"toolContext":{"version":1,"baselineAttachment":true,"baseline":snapshot}});
            let mut next =
                tool_context::prepare_with_harness(self.options, &self.tools.catalog_tools(), &[seed], false, self.context.harness.clone())?
                    .ok_or_else(|| {
                    Error::template(
                        "COMMAND_CLEAR",
                        TextId::CommandsRuntimeClearContextFailed,
                        &[],
                    )
                })?;
            let mut baseline = next.recovery_message();
            if baseline["content"] == "" {
                baseline["content"] =
                    json!(self.context.harness.text(TextId::CommandsRuntimeContextCleared));
                baseline["toolContext"]["baselineAttachment"] = json!(false);
            }
            if cancellation.is_cancelled() {
                return Err(Error::cancelled());
            }
            self.journal
                .checkpoint(
                    &[baseline.clone()],
                    self.context.harness.text(TextId::CommandsRuntimeContextCleared),
                )
                .await?;
            *self.messages = vec![baseline];
            next.baseline_pending = false;
            *current.lock().unwrap() = next;
        } else {
            self.messages.clear();
        }
        self.tools
            .tool_context_call("readFileState.clear", json!([]))?;
        self.budget.reset();
        self.context.compaction.reset();
        Ok(())
    }
    async fn compact(&mut self, instructions: Option<&str>, cancellation: &CancellationToken) -> Result<bool> {
        use super::{compact::session::{compact_request, CompactTrigger, OutputAllowance}, loop_budget::LoopBudget, loop_runtime};
        let (execution, provider) = self.manual.ok_or_else(|| Error::template(
            "NATIVE_CAPABILITY_UNAVAILABLE", TextId::CommandsRuntimeOperationUnavailable, &[("name", "compactSession".into())]
        ))?;
        if self.messages.len() < 2 { return Ok(false); }
        let spent = execution.budget_spent().await?;
        let maximum = crate::js::number(&self.options["maxBudgetUsd"]).unwrap_or(f64::INFINITY);
        if spent >= maximum {
            return Err(Error::template("BUDGET_EXCEEDED", TextId::ContextExecutionBudget,
                &[("spent", crate::js::to_fixed(spent,4).into()), ("maximum", crate::js::to_fixed(maximum,4).into())]));
        }
        let model = self.options["model"].as_str().unwrap_or("");
        let (definitions, eager) = match self.discovery {
            Some(state) => { let state = state.lock().unwrap(); (state.model_definitions.clone(), state.catalog.eager.clone()) },
            None => (self.tools.definitions(), self.tools.catalog_tools()),
        };
        let system = loop_runtime::system_prompt(self.options, &self.context.environment, &definitions, &eager, &self.context.harness)?;
        let mut injected = Vec::new();
        let mut memory = self.context.memory.user_context_with_harness(self.options, &self.context.harness).await;
        if !memory.is_null() { memory["isMeta"] = json!(true); injected.push(memory); }
        if let Some(skills) = &self.context.skill_context { let mut skills = skills.clone(); skills["isMeta"] = json!(true); injected.push(skills); }
        let combined: Vec<_> = injected.iter().chain(self.messages.iter()).cloned().collect();
        let mut projected = tool_context::history::project(&super::messages::repair_with_harness(&combined, &self.context.harness).0);
        self.context.image_input.project(model, provider.capabilities["imageInput"] != false, &mut projected, &self.context.harness, &execution.session_id);
        if provider.capabilities["caching"] == true { projected = super::messages::cache_breakpoint(projected); }
        let effort = super::effort::resolve(self.options);
        let thinking = super::token_budget::effective_thinking(&effort.thinking, self.budget.max_output_tokens);
        let mut budget = LoopBudget::Borrowed(self.budget);
        budget.configure_output(thinking.clone(), None);
        let mut request = json!({"model":model,"messages":projected,"systemPrompt":system,"tools":definitions,
            "thinking":thinking,"maxTokens":budget.max_output_tokens(),"stream":true,"providerOptions":{"fallbackModelAvailable":false}});
        if let Some(temperature) = effort.temperature { request["temperature"] = json!(temperature); }
        if let Some(reasoning) = effort.reasoning { request["providerOptions"]["reasoning_effort"] = json!(reasoning); }
        if crate::js::truthy(&self.options["effort"]) { request["providerOptions"]["effort"] = self.options["effort"].clone(); }
        else if self.options["nativeResolvedConfig"] != true { request["providerOptions"]["effort"] = json!("high"); }
        if crate::js::truthy(&self.options["taskBudget"]) { request["providerOptions"]["taskBudget"] = self.options["taskBudget"].clone(); }
        let attachments = loop_runtime::working_attachments(execution, self.tools, self.discovery, self.messages, &mut Vec::new(), &self.context.harness).await?;
        let snapshot = self.discovery.as_ref().map(|state| state.lock().unwrap().snapshot());
        let result = compact_request(execution, self.options, provider, self.messages, &mut budget, &request, &injected, &attachments,
            snapshot, Arc::new(Mutex::new(OutputAllowance::default())), cancellation, CompactTrigger::Manual { instructions }).await;
        match result {
            Ok(_) => {
                self.context.compaction.reset();
                self.context.compaction.compacted_history_tokens = Some(budget.estimate_request(&json!({"messages":self.messages})));
                Ok(true)
            }
            Err(error) if error.code == "COMPACT_ERROR" && error.details.as_ref().is_some_and(|details| details["reason"] == "no_progress") => {
                tracing::warn!(session_id=%execution.session_id, "Manual compaction kept the original history because no safe reduction was available");
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }
    pub async fn command(
        &mut self,
        name: &str,
        payload: &Value,
        session: &NativeSession,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        match name {
            "clearMessages" => {
                self.clear(cancellation).await?;
                Ok(Value::Null)
            }
            "compactSession" => {
                let compacted = self.compact(payload[0].as_str(), cancellation).await?;
                self.compacted = Some(compacted);
                Ok(Value::Null)
            }
            "readHistory" => Ok(json!(self.messages)),
            "captureCheckpoint" => {
                self.journal.flush().await?;
                let complete = self.journal.has_complete_history().await;
                let mut checkpoint = json!({"sessionId":session.session_id,"cwd":self.options["cwd"],"costs":session.controls.cost_snapshot(),"reads":self.tools.tool_context_call("readFileState.entries",json!([]))?});
                if !complete {
                    checkpoint["messages"] = json!(self.messages);
                }
                Ok(checkpoint)
            }
            "flush" => {
                self.journal.flush().await?;
                Ok(Value::Null)
            }
            _ => session
                .immediate_command(name, payload)
                .await
                .unwrap_or_else(|| {
                    Err(Error::template(
                        "NATIVE_CAPABILITY_UNAVAILABLE",
                        TextId::CommandsRuntimeOperationUnavailable,
                        &[("name", name.into())],
                    ))
                }),
        }
    }
}
struct SessionCommandHost<'a> {
    session: &'a NativeSession,
    one_shot: bool,
}
#[async_trait]
impl CommandHost for SessionCommandHost<'_> {
    async fn clear_messages(&self) -> Result<()> {
        if !self.one_shot {
            self.session.command("clearMessages", json!([])).await?;
        }
        Ok(())
    }
    async fn compact_session(&self, instructions: Option<String>) -> Result<()> {
        self.session.command("compactSession", json!([instructions])).await?;
        Ok(())
    }
    async fn set_model(&self, model: String) -> Result<()> {
        if !self.one_shot {
            self.session.command("setModel", json!([model])).await?;
        }
        Ok(())
    }
}

pub(crate) enum InputOutcome {
    Continue(Vec<Value>),
    Local { markdown: String, is_error: bool },
}
pub(crate) async fn intercept(
    session: &NativeSession,
    payloads: Vec<Value>,
    state: &mut ActorState<'_>,
    cancellation: &CancellationToken,
) -> Result<InputOutcome> {
    if payloads.len() != 1 {
        return Ok(InputOutcome::Continue(payloads));
    }
    let plain = payloads[0].as_str().or_else(|| {
        let blocks = payloads[0]["content"].as_array()?;
        (blocks.len() == 1 && blocks[0]["type"] == "text").then(|| blocks[0]["text"].as_str()).flatten()
    });
    let Some(plain) = plain else {
        return Ok(InputOutcome::Continue(payloads));
    };
    let Some(invocation) = crate::commands::parse(plain) else {
        return Ok(InputOutcome::Continue(payloads));
    };
    let prepared = session
        .controls
        .prepared()
        .expect("commands are prepared before streams start");
    let harness = state.context.harness.clone();
    let commands = prepared
        .registry
        .list_with_harness(session, cancellation, &harness)
        .await?;
    let snapshot = json!({"sessionId":session.session_id,"cwd":state.options["cwd"],"model":state.options["model"],"mcpServerStatuses":state.tools.mcp_statuses().iter().map(|server| json!({"name":server["name"],"status":server["status"]})).collect::<Vec<_>>(),"messages":state.messages,"cost":session.controls.cost_snapshot(),"commands":commands,"nativeQuery":state.options["nativeQuery"] == true});
    let host = SessionCommandHost {
        session,
        one_shot: state.options["nativeQuery"] == true,
    };
    let future = crate::commands::dispatch_with_harness(
        &prepared.registry,
        &invocation.name,
        &invocation.args,
        &snapshot,
        &host,
        session,
        cancellation,
        &harness,
    );
    tokio::pin!(future);
    let mut receiver = session.command_receiver.lock().await;
    let outcome = loop {
        tokio::select! {
            result = &mut future => break result,
            Some(Command{name,payload,result}) = receiver.recv() => {
                let response = state.command(&name, &payload, session, cancellation).await;
                let _ = result.send(response);
            }
            _ = cancellation.cancelled() => break Err(Error::cancelled()),
        }
    };
    match outcome {
        Ok(DispatchOutcome::LocalResult { markdown, command }) => Ok(InputOutcome::Local {
            markdown: if command["source"] == "builtin" && command["name"] == "compact" {
                state.compacted.map(|compacted| state.context.harness.text(if compacted {
                    TextId::CommandsRuntimeCompacted
                } else { TextId::CommandsRuntimeCompactUnchanged }).to_owned()).unwrap_or(markdown)
            } else { markdown },
            is_error: false,
        }),
        Ok(DispatchOutcome::Disabled(_)) => Ok(InputOutcome::Local {
            markdown: state.context.harness.render(
                TextId::CommandsRuntimeUnavailable,
                &[("name", &invocation.name)],
            ),
            is_error: true,
        }),
        Ok(DispatchOutcome::PromptReplacement { messages, .. }) => {
            let messages: Vec<_> = messages
                .into_iter()
                .filter(|message| message["role"] == "user")
                .collect();
            if state.options["nativeQuery"] == true {
                if messages.is_empty() {
                    return Ok(InputOutcome::Continue(payloads));
                }
                let text = messages
                    .iter()
                    .map(|message| {
                        message["content"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                message["content"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter(|block| block["type"] == "text")
                                    .filter_map(|block| block["text"].as_str())
                                    .collect::<String>()
                            })
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                Ok(InputOutcome::Continue(vec![json!(text)]))
            } else {
                Ok(InputOutcome::Continue(if messages.is_empty() { vec![json!({"role":"user","content":[]})] } else { messages }))
            }
        }
        Ok(DispatchOutcome::HostHandled(_) | DispatchOutcome::Unknown) => {
            Ok(InputOutcome::Continue(payloads))
        }
        Err(error) => {
            tracing::warn!(command=%invocation.name,code=%error.code,"Slash command failed");
            Ok(InputOutcome::Local {
                markdown: state.context.harness.render(
                    TextId::CommandsRuntimeFailed,
                    &[
                        ("name", &invocation.name),
                        ("error", &error.render_for(&harness)),
                    ],
                ),
                is_error: true,
            })
        }
    }
}

pub(crate) fn local_events(
    session: &NativeSession,
    options: &Value,
    tools: &ToolRuntime,
    markdown: &str,
    is_error: bool,
    execution: &LoopExecution,
    started: std::time::Instant,
) -> Vec<Value> {
    let harness = session
        .harness
        .for_model(options["model"].as_str().unwrap_or(""));
    let commands = session.controls.supported_commands(&harness);
    let mut events = Vec::new();
    if options["nativeQuery"] != true {
        events.push(json!({"type":"system","subtype":"init","session_id":session.session_id,"model":options["model"],"cwd":options["cwd"],"mcp_servers":tools.mcp_statuses(),"slash_commands":commands.iter().map(|command| &command["name"]).collect::<Vec<_>>(),"uuid":uuid::Uuid::new_v4().to_string()}));
    }
    events.push(json!({"type":"system","subtype":"local_command_output","content":markdown,"session_id":session.session_id,"uuid":uuid::Uuid::new_v4().to_string()}));
    let mut result = json!({"type":"result","subtype":if is_error{"error_during_execution"}else{"success"},"result":markdown,"is_error":is_error,"num_turns":0,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{},"session_id":session.session_id,"stop_reason":if is_error{Value::Null}else{json!("end_turn")},"duration_ms":0,"duration_api_ms":0,"permission_denials":[],"uuid":uuid::Uuid::new_v4().to_string()});
    if is_error {
        result["errors"] = json!([markdown]);
    }
    {
        let cost = execution.cost.lock().unwrap();
        result["total_cost_usd"] = json!(cost.total_cost_usd());
        result["usage"] = cost.usage();
        result["modelUsage"] = cost.model_usage();
        if !result["modelUsage"].as_object().unwrap().is_empty() {
            result["duration_ms"] = json!(started.elapsed().as_millis() as u64);
            result["duration_api_ms"] = json!(execution.api_time_ms.load(std::sync::atomic::Ordering::Relaxed));
        }
    }
    events.push(result);
    events
}
