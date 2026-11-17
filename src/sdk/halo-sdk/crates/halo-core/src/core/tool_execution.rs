use super::{
    hooks, tool_input,
    truncate::{recovery_hint, truncate_content_with_harness},
};
use crate::{
    bridge::{EventSink, HostBridge},
    error::{Error, Result},
    harness::TextId,
    js::{stringify, trim_js, truthy, utf16_len},
    tools::{ToolContext, ToolRuntime, SelectedTool},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub struct Execution {
    pub options: Arc<Value>,
    pub tools: Arc<ToolRuntime>,
    pub bridge: Arc<dyn HostBridge>,
    pub events: Arc<dyn EventSink>,
    pub session_id: String,
    pub turn: u32,
    pub cancellation: CancellationToken,
    pub definitions: Vec<SelectedTool>,
    pub context: Arc<super::tool_context_bridge::ToolContextBridge>,
    pub harness: Arc<crate::harness::ResolvedHarness>,
    pub discovery: Option<Arc<Mutex<super::tool_context::State>>>,
    pub completed: Mutex<HashMap<String, Value>>,
    pub denials: Mutex<Vec<Value>>,
}

pub struct Prepared {
    pub call: Value,
    rejected: Option<Value>,
    pre: hooks::PreResult,
    note: Option<String>,
    definition: Option<SelectedTool>,
}

fn check(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::cancelled())
    } else {
        Ok(())
    }
}
fn denied(call: &Value, message: String) -> Value {
    json!({"toolUseId":call["id"],"content":message,"isError":true})
}
fn budgeted(result: &Value) -> bool {
    result.get("__haloSdkNativeOutput").is_some()
}

fn assign(target: &mut Value, update: &Value) {
    if let Some(target) = target.as_object_mut() {
        if let Some(update) = update.as_object() {
            target.extend(update.clone());
        } else if let Some(update) = update.as_array() {
            target.extend(
                update
                    .iter()
                    .enumerate()
                    .map(|(index, value)| (index.to_string(), value.clone())),
            );
        }
    }
}

impl Execution {
    pub async fn concurrency_safe(&self, call: &Value) -> bool {
        if call["name"] == "ToolSearch"
            && self
                .discovery
                .as_ref()
                .is_some_and(|state| state.lock().unwrap().enabled())
        {
            return true;
        }
        self.tools
            .concurrency_safe(
                call["name"].as_str().unwrap_or(""),
                &call["input"],
                &self.cancellation,
            )
            .await
    }
    fn truncate(&self, text: &str) -> String {
        truncate_content_with_harness(
            text,
            self.options["toolResultBudget"].as_u64().unwrap_or(50_000) as usize,
            recovery_hint(&self.harness),
            &self.harness,
        )
    }
    pub async fn prepare(&self, call: Value, unreadable: Option<&str>, format_recovery: bool) -> Result<Prepared> {
        let mut prepared = Prepared {
            call,
            rejected: None,
            pre: Default::default(),
            note: None,
            definition: None,
        };
        let outcome = self.prepare_inner(&mut prepared, unreadable).await;
        if let Err(error) = outcome {
            if self.cancellation.is_cancelled() || error.is_abort() {
                return Err(error);
            }
            tracing::warn!(tool=%prepared.call["name"],session_id=%self.session_id,code=%error.code,"Tool result processing failed");
            prepared.rejected = Some(denied(
                &prepared.call,
                self.truncate(&self.harness.render(
                    TextId::ContextToolsFailedBeforeResult,
                    &[("error", &error.display_for(&self.harness))],
                )),
            ));
        }
        if format_recovery {
            if let Some(result) = &mut prepared.rejected { result["formatRecovery"] = json!(true); }
        }
        Ok(prepared)
    }
    async fn prepare_inner(&self, prepared: &mut Prepared, unreadable: Option<&str>) -> Result<()> {
        check(&self.cancellation)?;
        let name = prepared.call["name"].as_str().unwrap_or("").to_owned();
        let tool_id = prepared.call["id"].as_str().unwrap_or("").to_owned();
        if let Some(unreadable) = unreadable {
            let result = denied(&prepared.call, unreadable.into());
            prepared.rejected = Some(result);
            return Ok(());
        }
        prepared.definition = self.definitions.iter().find(|tool| tool.definition["name"] == name).cloned();
        if prepared.definition.is_none() {
            prepared.rejected = Some(denied(
                &prepared.call,
                self.harness.render(
                    TextId::ContextToolsNotFound,
                    &[
                        ("tool", &name),
                        (
                            "available",
                            &self
                                .definitions
                                .iter()
                                .filter_map(|selected| selected.definition["name"].as_str())
                                .collect::<Vec<_>>()
                                .join(", "),
                        ),
                    ],
                ),
            ));
            return Ok(());
        }
        crate::tools::drop_host_owned_input(&name, &mut prepared.call["input"]);
        let original = crate::js::data::stringify(&prepared.call["input"]);
        prepared.pre = hooks::pre_tool_with_harness(
            &self.options,
            &name,
            &prepared.call["input"],
            &tool_id,
            &self.session_id,
            self.bridge.as_ref(),
            &self.cancellation,
            &self.harness,
        )
        .await;
        if let Some(original) = &prepared.pre.original_input {
            prepared.call["input"] = original.clone();
        }
        check(&self.cancellation)?;
        if prepared.pre.decision.as_deref() == Some("deny") {
            let reason = prepared
                .pre
                .reason
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| self.harness.text(TextId::PermissionsNoReason));
            let guidance = prepared
                .pre
                .context
                .as_deref()
                .unwrap_or_else(|| self.harness.text(TextId::PermissionsAdjustApproach));
            prepared.rejected = Some(denied(
                &prepared.call,
                self.harness.render(
                    TextId::PermissionsPreHookDenied,
                    &[("reason", reason), ("guidance", guidance)],
                ),
            ));
            return Ok(());
        }
        if let Some(input) = &prepared.pre.input {
            assign(&mut prepared.call["input"], input);
        }
        let after_hooks = crate::js::data::stringify(&prepared.call["input"]);
        let rules: Vec<&str> = self.options["allowedTools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(trim_js)
            .collect();
        let skip = !self.tools.requires_user_interaction(&name)
            && (self.options["permissionMode"] == "bypassPermissions"
                || rules.iter().any(|rule| *rule == name));
        let can_use_tool = self.options.get("canUseTool").is_some_and(truthy);
        if !skip
            && !can_use_tool
            && rules
                .iter()
                .any(|rule| rule.starts_with(&format!("{name}(")))
        {
            tracing::warn!(tool=%name,session_id=%self.session_id,"Conditional tool permission requires a host checker");
            prepared.rejected = Some(denied(
                &prepared.call,
                self.harness
                    .text(TextId::PermissionsConditionalCheckerRequired)
                    .into(),
            ));
            return Ok(());
        }
        if !skip && can_use_tool {
            let decision = self.bridge.call("permissions.call", json!({"callbackId":self.options["canUseTool"]["__haloSdkNativeCallback"],"name":name,"input":prepared.call["input"],"toolUseId":tool_id,"sessionId":self.session_id}), &self.cancellation).await;
            let decision = decision.and_then(|reply| {
                if let Some(input) = reply.get("input") {
                    prepared.call["input"] = input.clone();
                }
                if let Some(error) = reply.get("error") {
                    Err(Error::from_host(error.clone()))
                } else {
                    Ok(reply
                        .get("result")
                        .cloned()
                        .unwrap_or_else(crate::js::undefined))
                }
            });
            check(&self.cancellation)?;
            match decision {
                Ok(decision) => {
                    if decision["behavior"] == "deny" {
                        self.denials.lock().unwrap().push(json!({"tool_name":name,"tool_use_id":tool_id,"tool_input":prepared.call["input"]}));
                        let text = if truthy(&decision["message"]) {
                            self.harness.render(
                                TextId::PermissionsDeniedReason,
                                &[("reason", &crate::js::to_string(&decision["message"]))],
                            )
                        } else {
                            self.harness.text(TextId::PermissionsDenied).into()
                        };
                        let mut result = denied(&prepared.call, text);
                        result["interrupt"] = json!(truthy(&decision["interrupt"]));
                        prepared.rejected = Some(result);
                        return Ok(());
                    }
                    if crate::js::data::truthy(&decision["updatedInput"]) {
                        assign(&mut prepared.call["input"], &decision["updatedInput"]);
                    }
                }
                Err(error) => {
                    if error.is_abort() {
                        return Err(error);
                    }
                    tracing::warn!(tool=%name,session_id=%self.session_id,code=%error.code,"Tool permission check failed");
                    prepared.rejected = Some(denied(
                        &prepared.call,
                        self.harness.render(
                            TextId::PermissionsCheckError,
                            &[("error", &error.render_for(&self.harness))],
                        ),
                    ));
                    return Ok(());
                }
            }
        }
        let effective = crate::js::data::stringify(&prepared.call["input"]);
        if effective != original {
            let source = match (after_hooks != original, effective != after_hooks) {
                (true, true) => self.harness.text(TextId::PermissionsSourceHookAndCallback),
                (true, false) => self.harness.text(TextId::PermissionsSourceHook),
                _ => self.harness.text(TextId::PermissionsSourceCallback),
            };
            let preview = if utf16_len(&effective) > 200 {
                format!(
                    "{}{}",
                    crate::js::utf16_prefix(&effective, 200),
                    self.harness.text(TextId::ContextTruncationEllipsis)
                )
            } else {
                effective
            };
            prepared.note = Some(self.harness.render(
                TextId::PermissionsAdjustedInput,
                &[("source", source), ("input", &preview)],
            ));
        }
        let deferred = self.discovery.as_ref().is_some_and(|state| state.lock().unwrap().catalog.deferred.contains_key(&name));
        let schema = &prepared.definition.as_ref().unwrap().definition["input_schema"];
        let problem = if deferred {
            super::tool_context::feedback::invalid_arguments(&name, schema, &prepared.call["input"], &self.harness)
        } else {
            tool_input::validate_with_harness(&name, schema, &prepared.call["input"], &self.harness)
        };
        if let Some(problem) = problem {
            prepared.rejected = Some(denied(
                &prepared.call,
                prepared
                    .note
                    .as_ref()
                    .map(|note| format!("{note}\n\n{problem}"))
                    .unwrap_or(problem),
            ));
            if deferred {
                prepared.rejected.as_mut().unwrap()["formatRecovery"] = json!(true);
            }
        }
        Ok(())
    }
    async fn progress(&self, call: &Value, elapsed: Option<f64>) -> Result<()> {
        let mut event = json!({"type":"tool_progress","tool_name":call["name"],"tool_use_id":call["id"],"parent_tool_use_id":null,"uuid":uuid::Uuid::new_v4().to_string(),"session_id":self.session_id});
        if let Some(elapsed) = elapsed {
            event["elapsed_time_seconds"] = json!(elapsed);
        }
        self.events.emit(event).await
    }
    pub async fn run(&self, prepared: Prepared) -> Result<Value> {
        check(&self.cancellation)?;
        let started = Instant::now();
        self.progress(&prepared.call, None).await?;
        let result = self.run_inner(&prepared).await;
        let result = match result {
            Ok(mut result) => {
                if !budgeted(&result) {
                    result["content"] = json!(self.truncate(result["content"].as_str().unwrap_or("")));
                }
                if prepared.call["name"] == "ToolSearch" {
                    if let Some(state) = &self.discovery {
                        let envelope = result
                            .as_object_mut()
                            .unwrap()
                            .shift_remove("discoveryEnvelope")
                            .unwrap_or(Value::Null);
                        let (settled, record) = state.lock().unwrap().settle(
                            prepared.call["id"].as_str().unwrap_or(""),
                            result,
                            envelope["prefix"].as_str().unwrap_or(""),
                            envelope["suffix"].as_str().unwrap_or(""),
                        );
                        result = settled;
                        result["toolUseId"] = prepared.call["id"].clone();
                        if let Some(record) = record {
                            result["toolContext"] = record;
                        }
                    }
                }
                Ok(result)
            }
            Err(error) if self.cancellation.is_cancelled() || error.is_abort() => Err(error),
            Err(error) => {
                tracing::warn!(tool=%prepared.call["name"],session_id=%self.session_id,code=%error.code,"Tool result processing failed");
                let existing = self
                    .completed
                    .lock()
                    .unwrap()
                    .get(prepared.call["id"].as_str().unwrap_or(""))
                    .cloned();
                let mut result = existing.unwrap_or_else(|| {
                    denied(
                        &prepared.call,
                        self.harness.render(
                            TextId::ContextToolsFailedBeforeResult,
                            &[("error", &error.display_for(&self.harness))],
                        ),
                    )
                });
                if self
                    .completed
                    .lock()
                    .unwrap()
                    .contains_key(prepared.call["id"].as_str().unwrap_or(""))
                {
                    result["content"] = json!(self.harness.render(
                        TextId::ContextToolsProcessingFailed,
                        &[("content", result["content"].as_str().unwrap_or(""))]
                    ));
                }
                if !budgeted(&result) {
                    result["content"] = json!(self.truncate(result["content"].as_str().unwrap_or("")));
                }
                Ok(result)
            }
        };
        if let Ok(result) = &result {
            self.completed.lock().unwrap().insert(
                prepared.call["id"].as_str().unwrap_or("").into(),
                result.clone(),
            );
        }
        self.progress(&prepared.call, Some(started.elapsed().as_secs_f64()))
            .await?;
        result
    }
    async fn run_inner(&self, prepared: &Prepared) -> Result<Value> {
        check(&self.cancellation)?;
        if let Some(result) = &prepared.rejected {
            return Ok(result.clone());
        }
        let call = &prepared.call;
        let name = call["name"].as_str().unwrap_or("");
        let tool_id = call["id"].as_str().unwrap_or("");
        let _context_guard = self.context.enter_with_harness(
            tool_id,
            self.tools.clone(),
            self.events.clone(),
            self.harness.clone(),
        )?;
        let context = ToolContext {
            session_id: self.session_id.clone(),
            cwd: self.options["cwd"].as_str().unwrap_or("").into(),
            env: self.options["env"].clone(),
            current_turn: self.turn,
            tool_use_id: tool_id.into(),
            cancellation: self.cancellation.clone(),
            harness: self.harness.clone(),
        };
        let discovery = name == "ToolSearch"
            && self
                .discovery
                .as_ref()
                .is_some_and(|state| state.lock().unwrap().enabled());
        let result = if discovery {
            Ok(self
                .discovery
                .as_ref()
                .unwrap()
                .lock()
                .unwrap()
                .search(&call["input"], tool_id))
        } else {
            let execution = self.tools.execute_selected(
                prepared.definition.as_ref().unwrap(),
                call["input"].clone(),
                context,
            );
            tokio::select! { _ = self.cancellation.cancelled() => return Err(Error::cancelled()), result = execution => result }
        };
        let mut result = match result {
            Ok(result) => {
                let mut clean = json!({"content":result["content"]});
                for key in ["isError", "images"] {
                    if let Some(value) = result.get(key) {
                        clean[key] = value.clone();
                    }
                }
                if let Some(kind) = prepared
                    .definition
                    .as_ref()
                    .and_then(|tool| self.tools.trusted_output_kind(tool, &result))
                {
                    clean["__haloSdkNativeOutput"] = json!(kind);
                    if let Some(path) = result.get("__haloSdkNativeSavedOutput") {
                        clean["__haloSdkNativeSavedOutput"] = path.clone();
                    }
                }
                clean
            }
            Err(error) if self.cancellation.is_cancelled() || error.is_abort() => {
                return Err(error)
            }
            Err(error) => {
                tracing::warn!(tool=name,session_id=%self.session_id,code=%error.code,"Tool execution failed");
                json!({"content":self.harness.render(TextId::ContextToolsExecutionError, &[("error", &error.render_for(&self.harness))]),"isError":true})
            }
        };
        result["toolUseId"] = call["id"].clone();
        if !budgeted(&result) {
            result["content"] = json!(self.truncate(result["content"].as_str().unwrap_or("")));
        }
        self.completed
            .lock()
            .unwrap()
            .insert(tool_id.into(), result.clone());
        let post = hooks::post_tool_with_harness(
            &self.options,
            name,
            &call["input"],
            result["content"].as_str().unwrap_or(""),
            tool_id,
            &self.session_id,
            result["isError"] == true,
            self.bridge.as_ref(),
            &self.cancellation,
            &self.harness,
        )
        .await;
        if let Some(output) = post.output {
            if result["__haloSdkNativeOutput"].as_str() != Some("skill_instructions") {
                result
                    .as_object_mut()
                    .unwrap()
                    .shift_remove("__haloSdkNativeOutput");
            }
            if let Some(path) = result
                .as_object_mut()
                .unwrap()
                .shift_remove("__haloSdkNativeSavedOutput")
                .and_then(|value| value.as_str().map(str::to_owned))
            {
                if let Err(error) = tokio::fs::remove_file(&path).await {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(tool=%name,session_id=%self.session_id,error=%error,"Replaced tool output could not remove its saved copy");
                    }
                }
            }
            result["content"] = json!(output
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| stringify(&output)));
        }
        let mut prefix = String::new();
        let mut suffix = String::new();
        if let Some(context) = post.context.filter(|context| !context.is_empty()) {
            suffix = format!("\n\n{context}");
            result["content"] = json!(format!(
                "{}{suffix}",
                result["content"].as_str().unwrap_or("")
            ));
        }
        check(&self.cancellation)?;
        if let Some(context) = prepared
            .pre
            .context
            .as_ref()
            .filter(|context| !context.is_empty())
        {
            prefix = format!("{context}\n\n");
            result["content"] = json!(format!(
                "{prefix}{}",
                result["content"].as_str().unwrap_or("")
            ));
        }
        if let Some(note) = &prepared.note {
            prefix = format!("{note}\n\n{prefix}");
            result["content"] = json!(format!(
                "{note}\n\n{}",
                result["content"].as_str().unwrap_or("")
            ));
        }
        if discovery {
            result["discoveryEnvelope"] = json!({"prefix":prefix,"suffix":suffix});
        }
        Ok(result)
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use async_trait::async_trait;
    use tokio::sync::{mpsc, oneshot};

    pub struct Request {
        pub method: String,
        pub params: Value,
        pub reply: oneshot::Sender<Result<Value>>,
    }
    struct Host(mpsc::UnboundedSender<Request>);
    #[async_trait]
    impl HostBridge for Host {
        async fn call(&self, method: &str, params: Value, cancel: &CancellationToken) -> Result<Value> {
            let (reply, receiver) = oneshot::channel();
            self.0.send(Request { method: method.into(), params, reply }).unwrap();
            tokio::select! {
                _ = cancel.cancelled() => Err(Error::cancelled()),
                value = receiver => value.unwrap(),
            }
        }
    }
    pub struct Events(pub Mutex<Vec<Value>>);
    #[async_trait]
    impl EventSink for Events {
        async fn emit(&self, event: Value) -> Result<()> {
            self.0.lock().unwrap().push(event);
            Ok(())
        }
    }
    pub fn fixture(mut options: Value) -> (Arc<Execution>, mpsc::UnboundedReceiver<Request>, Arc<Events>) {
        options["cwd"] = json!(std::env::temp_dir());
        options["permissionMode"] = options.get("permissionMode").cloned().unwrap_or(json!("bypassPermissions"));
        options["tools"] = json!([]);
        options["customTools"] = json!([
            {"name":"Safe","description":"safe","inputSchema":{"type":"object","properties":{"value":{"type":"string"}}},"isConcurrencySafe":{"__haloSdkNativeCallback":"safe"}},
            {"name":"Exclusive","description":"exclusive","inputSchema":{"type":"object"}}
        ]);
        let (sender, receiver) = mpsc::unbounded_channel();
        let bridge = Arc::new(Host(sender));
        let events = Arc::new(Events(Mutex::new(Vec::new())));
        let tools = Arc::new(ToolRuntime::new(options.clone(), bridge.clone(), events.clone()));
        let execution = Arc::new(Execution {
            options: Arc::new(options), definitions: tools.selected_tools(),
            harness: tools.resolved_harness(), tools, bridge, events: events.clone(),
            session_id: "test".into(), turn: 1, cancellation: CancellationToken::new(),
            context: Arc::new(super::super::tool_context_bridge::ToolContextBridge::new(Arc::new(Mutex::new(super::super::cost::CostTracker::new("test", 100000.0, json!({})))))),
            discovery: None, completed: Default::default(), denials: Default::default(),
        });
        (execution, receiver, events)
    }
    pub fn call(id: &str, name: &str) -> Value {
        json!({"type":"tool_use","id":id,"name":name,"input":{"value":"original"}})
    }
    pub async fn request(receiver: &mut mpsc::UnboundedReceiver<Request>, method: &str) -> Request {
        let request = tokio::time::timeout(std::time::Duration::from_secs(3), receiver.recv()).await.unwrap().unwrap();
        assert_eq!(request.method, method);
        request
    }

    #[tokio::test]
    async fn preparation_preserves_input_and_validates_permission_adjustments() {
        for (value, valid) in [(json!("effective"), true), (json!(3), false)] {
            let (execution, mut receiver, events) = fixture(json!({"permissionMode":"default","canUseTool":{"__haloSdkNativeCallback":"permission"}}));
            let original = call("0", "Safe");
            let preparing = { let execution = execution.clone(); let call = original.clone(); tokio::spawn(async move { execution.prepare(call, None, false).await }) };
            let permission = request(&mut receiver, "permissions.call").await;
            permission.reply.send(Ok(json!({"result":{"behavior":"allow","updatedInput":{"value":value}}}))).unwrap();
            let prepared = preparing.await.unwrap().unwrap();
            assert_eq!(prepared.call["input"]["value"], value);
            assert_eq!(original["input"]["value"], "original");
            assert!(events.0.lock().unwrap().is_empty());
            let running = { let execution = execution.clone(); tokio::spawn(async move { execution.run(prepared).await }) };
            if valid {
                let operation = request(&mut receiver, "tools.execute").await;
                assert_eq!(operation.params["input"]["value"], value);
                operation.reply.send(Ok(json!({"content":"Saved.","isError":false}))).unwrap();
            }
            assert_eq!(running.await.unwrap().unwrap()["isError"], !valid);
            assert_eq!(events.0.lock().unwrap().len(), 2);
            assert!(receiver.try_recv().is_err());
        }
    }
    #[tokio::test]
    async fn unreadable_arguments_bypass_hooks_permissions_and_execution() {
        let (execution, mut receiver, _) = fixture(json!({"permissionMode":"default","canUseTool":{"__haloSdkNativeCallback":"permission"},"hooks":{"PreToolUse":[{"hooks":[{"__haloSdkNativeCallback":"pre"}]}]}}));
        let prepared = execution.prepare(call("0", "Safe"), Some("Malformed tool input."), false).await.unwrap();
        let result = execution.run(prepared).await.unwrap();
        assert_eq!(result["content"], "Malformed tool input.");
        assert_eq!(result["isError"], true);
        assert!(receiver.try_recv().is_err());
    }
    #[tokio::test]
    async fn cancellation_after_preparation_never_executes() {
        let (execution, mut receiver, events) = fixture(json!({}));
        let prepared = execution.prepare(call("0", "Safe"), None, false).await.unwrap();
        execution.cancellation.cancel();
        assert!(execution.run(prepared).await.unwrap_err().is_abort());
        assert!(receiver.try_recv().is_err());
        assert!(events.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn denial_records_original_input_and_interrupt_without_execution() {
        let (execution, mut receiver, _) = fixture(json!({"permissionMode":"default","canUseTool":{"__haloSdkNativeCallback":"permission"}}));
        let preparing = { let execution = execution.clone(); tokio::spawn(async move { execution.prepare(call("0", "Safe"), None, false).await }) };
        request(&mut receiver, "permissions.call").await.reply.send(Ok(json!({"result":{"behavior":"deny","message":"Not permitted.","interrupt":true}}))).unwrap();
        let result = execution.run(preparing.await.unwrap().unwrap()).await.unwrap();
        assert_eq!(result["isError"], true);
        assert_eq!(result["interrupt"], true);
        assert_eq!(*execution.denials.lock().unwrap(), vec![json!({"tool_name":"Safe","tool_use_id":"0","tool_input":{"value":"original"}})]);
        assert!(receiver.try_recv().is_err());
    }
    #[tokio::test]
    async fn cancellation_discards_late_tool_result() {
        let (execution, mut receiver, _) = fixture(json!({}));
        let prepared = execution.prepare(call("0", "Safe"), None, false).await.unwrap();
        let running = { let execution = execution.clone(); tokio::spawn(async move { execution.run(prepared).await }) };
        let operation = request(&mut receiver, "tools.execute").await;
        execution.cancellation.cancel();
        assert!(running.await.unwrap().unwrap_err().is_abort());
        assert!(operation.reply.send(Ok(json!({"content":"Late.","isError":false}))).is_err());
        assert!(execution.completed.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn hooks_and_permissions_preserve_recorded_nested_input() {
        let (execution, mut receiver, _) = fixture(json!({"permissionMode":"default","canUseTool":{"__haloSdkNativeCallback":"permission"},"hooks":{"PreToolUse":[{"hooks":[{"__haloSdkNativeCallback":"pre"}]}]}}));
        let mut original = call("0", "Safe");
        original["input"]["nested"] = json!({"value":"original"});
        let preparing = { let execution = execution.clone(); let call = original.clone(); tokio::spawn(async move { execution.prepare(call, None, false).await }) };
        request(&mut receiver, "hooks.call").await.reply.send(Ok(json!({"originalToolInput":{"value":"original","nested":{"value":"hook mutation"}},"result":{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"value":"hook"}}}}))).unwrap();
        request(&mut receiver, "hooks.release").await.reply.send(Ok(json!(null))).unwrap();
        let permission = request(&mut receiver, "permissions.call").await;
        assert_eq!(permission.params["input"]["value"], "hook");
        permission.reply.send(Ok(json!({"result":{"behavior":"allow","updatedInput":{"value":"permitted"}}}))).unwrap();
        let prepared = preparing.await.unwrap().unwrap();
        assert_eq!(prepared.call["input"], json!({"value":"permitted","nested":{"value":"hook mutation"}}));
        let running = { let execution = execution.clone(); tokio::spawn(async move { execution.run(prepared).await }) };
        let mut operation = request(&mut receiver, "tools.execute").await;
        operation.params["input"]["nested"]["value"] = json!("tool mutation");
        operation.reply.send(Ok(json!({"content":"Saved.","isError":false}))).unwrap();
        assert_eq!(running.await.unwrap().unwrap()["isError"], false);
        assert_eq!(original["input"], json!({"value":"original","nested":{"value":"original"}}));
    }
    #[tokio::test]
    async fn cancellation_in_output_hook_retains_completed_effect() {
        let (execution, mut receiver, _) = fixture(json!({"hooks":{"PostToolUse":[{"hooks":[{"__haloSdkNativeCallback":"post"}]}]}}));
        let prepared = execution.prepare(call("0", "Safe"), None, false).await.unwrap();
        let running = { let execution = execution.clone(); tokio::spawn(async move { execution.run(prepared).await }) };
        request(&mut receiver, "tools.execute").await.reply.send(Ok(json!({"content":"Saved.","isError":false}))).unwrap();
        let hook = request(&mut receiver, "hooks.call").await;
        execution.cancellation.cancel();
        request(&mut receiver, "hooks.release").await.reply.send(Ok(json!(null))).unwrap();
        assert!(running.await.unwrap().unwrap_err().is_abort());
        assert_eq!(execution.completed.lock().unwrap()["0"]["content"], "Saved.");
        drop(hook);
    }
    struct GatedEvents {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        count: std::sync::atomic::AtomicUsize,
    }
    #[async_trait]
    impl EventSink for GatedEvents {
        async fn emit(&self, _event: Value) -> Result<()> {
            if self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                self.entered.notify_one();
                self.release.notified().await;
            }
            Ok(())
        }
    }
    #[tokio::test]
    async fn progress_delivery_blocks_execution_and_rechecks_cancellation() {
        let (mut execution, mut receiver, _) = fixture(json!({}));
        let events = Arc::new(GatedEvents { entered: tokio::sync::Notify::new(), release: tokio::sync::Notify::new(), count: std::sync::atomic::AtomicUsize::new(0) });
        Arc::get_mut(&mut execution).unwrap().events = events.clone();
        let prepared = execution.prepare(call("0", "Safe"), None, false).await.unwrap();
        let running = { let execution = execution.clone(); tokio::spawn(async move { execution.run(prepared).await }) };
        events.entered.notified().await;
        assert!(receiver.try_recv().is_err());
        execution.cancellation.cancel();
        events.release.notify_one();
        assert!(running.await.unwrap().unwrap_err().is_abort());
        assert!(receiver.try_recv().is_err());
        assert_eq!(events.count.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn cancellation_with_allowing_permission_response_never_executes() {
        let (execution, mut receiver, events) = fixture(json!({"permissionMode":"default","canUseTool":{"__haloSdkNativeCallback":"permission"}}));
        let preparing = { let execution = execution.clone(); tokio::spawn(async move { execution.prepare(call("0", "Safe"), None, false).await }) };
        let permission = request(&mut receiver, "permissions.call").await;
        execution.cancellation.cancel();
        let _ = permission.reply.send(Ok(json!({"result":{"behavior":"allow","updatedInput":{}}})));
        assert!(preparing.await.unwrap().err().unwrap().is_abort());
        assert!(events.0.lock().unwrap().is_empty());
        assert!(execution.completed.lock().unwrap().is_empty());
        assert!(receiver.try_recv().is_err());
    }
}
