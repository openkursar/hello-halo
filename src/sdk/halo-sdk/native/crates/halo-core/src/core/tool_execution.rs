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
                result["content"] = json!(self.truncate(result["content"].as_str().unwrap_or("")));
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
                result["content"] = json!(self.truncate(result["content"].as_str().unwrap_or("")));
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
        result["content"] = json!(self.truncate(result["content"].as_str().unwrap_or("")));
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
