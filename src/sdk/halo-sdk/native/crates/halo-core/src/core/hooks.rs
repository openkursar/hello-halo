use crate::{
    bridge::{EventSink, HostBridge},
    history::transcript_path,
    js::{to_string, truthy},
    llm::anthropic_request::invoke,
};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn matches(name: &str, pattern: &Value) -> bool {
    let Some(pattern) = pattern.as_str().filter(|s| !s.is_empty()) else {
        return true;
    };
    pattern == name
        || pattern
            .strip_suffix('*')
            .is_some_and(|prefix| name.starts_with(prefix))
}

fn output_field<'a>(output: &'a Value, event: &str, name: &str) -> &'a Value {
    let envelope = &output["hookSpecificOutput"];
    if envelope["hookEventName"] == event
        && !envelope[name].is_null()
        && (matches!(name, "updatedInput" | "updatedMCPToolOutput") || !crate::js::is_undefined(&envelope[name]))
    {
        &envelope[name]
    } else {
        &output[name]
    }
}

#[derive(Default)]
pub struct PreResult {
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub input: Option<Value>,
    pub context: Option<String>,
    pub original_input: Option<Value>,
    pub input_reference: Option<String>,
}

fn append_context(target: &mut Option<String>, value: &Value) {
    if !truthy(value) {
        return;
    }
    let text = to_string(value);
    match target {
        Some(previous) if !previous.is_empty() => {
            previous.push('\n');
            previous.push_str(&text);
        }
        _ => *target = Some(text),
    }
}

impl PreResult {
    fn merge(&mut self, out: &Value) {
        if out.get("hookError").is_some() {
            return;
        }
        let decision = output_field(out, "PreToolUse", "permissionDecision");
        if decision == "allow" || decision == "deny" {
            self.decision = decision.as_str().map(str::to_owned);
            let reason = output_field(out, "PreToolUse", "permissionDecisionReason");
            if truthy(reason) {
                self.reason = Some(to_string(reason));
            }
        }
        let input = output_field(out, "PreToolUse", "updatedInput");
        if input.is_object() || input.is_array() {
            self.input = Some(input.clone());
        }
        append_context(
            &mut self.context,
            output_field(out, "PreToolUse", "additionalContext"),
        );
    }
}

pub fn input(options: &Value, event: &str, session_id: &str) -> Value {
    json!({"hook_event_name":event,"session_id":session_id,"transcript_path":transcript_path(session_id, options),"cwd":options["cwd"]})
}

pub struct HookOutputs {
    pub outputs: Vec<Value>,
    pub references: Vec<Option<String>>,
    pub pre: PreResult,
}

pub async fn run(
    options: &Value,
    event: &str,
    input: Value,
    tool_use_id: Option<&str>,
    tool_name: Option<&str>,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
) -> Vec<Value> {
    run_observed(
        options,
        event,
        input,
        tool_use_id,
        tool_name,
        bridge,
        cancel,
        false,
        None,
    )
    .await
}

pub async fn run_observed(
    options: &Value,
    event: &str,
    input: Value,
    tool_use_id: Option<&str>,
    tool_name: Option<&str>,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
    thread_pre: bool,
    observer: Option<&Value>,
) -> Vec<Value> {
    run_protocol(
        options,
        event,
        input,
        tool_use_id,
        tool_name,
        bridge,
        cancel,
        thread_pre,
        observer,
        &crate::harness::baseline(),
    )
    .await
    .outputs
}

pub async fn run_protocol(
    options: &Value,
    event: &str,
    mut input: Value,
    tool_use_id: Option<&str>,
    tool_name: Option<&str>,
    bridge: &dyn HostBridge,
    cancellation: &CancellationToken,
    thread_pre: bool,
    observer: Option<&Value>,
    harness: &crate::harness::ResolvedHarness,
) -> HookOutputs {
    let mut run = HookOutputs {
        outputs: Vec::new(),
        references: Vec::new(),
        pre: PreResult::default(),
    };
    let Some(matchers) = options["hooks"][event]
        .as_array()
        .filter(|matchers| !matchers.is_empty())
    else {
        return run;
    };
    let chain = uuid::Uuid::new_v4().to_string();
    let mut reference: Option<String> = None;
    for matcher in matchers {
        if tool_name.is_some_and(|name| !matches(name, &matcher["matcher"])) {
            continue;
        }
        let timeout = crate::js::number(&matcher["timeout"])
            .filter(|_| truthy(&matcher["timeout"]))
            .map(|seconds| seconds * 1000.0)
            .unwrap_or(60_000.0);
        let duration = Duration::from_millis(
            if timeout.is_finite() && timeout > 0.0 && timeout <= i32::MAX as f64 {
                timeout as u64
            } else {
                1
            },
        );
        let label = format!(
            "{event}{}",
            matcher["matcher"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| format!(":{s}"))
                .unwrap_or_default()
        );
        for hook in matcher["hooks"].as_array().into_iter().flatten() {
            if cancellation.is_cancelled() {
                break;
            }
            let signal = cancellation.child_token();
            let invocation = uuid::Uuid::new_v4().to_string();
            let params = json!({"callbackId":hook["__haloSdkNativeCallback"],"chainId":chain,"invocationId":invocation,"input":input,"toolUseId":tool_use_id.map(|id|json!(id)).unwrap_or_else(crate::js::undefined),"toolInputReference":reference});
            let call = bridge.call("hooks.call", params, &signal);
            tokio::pin!(call);
            let outcome = tokio::select! {biased;
                _=cancellation.cancelled()=>Err(harness.render(crate::harness::TextId::PermissionsHookAborted,&[("label",&label)])),
                _=tokio::time::sleep(duration)=>Err(harness.render(crate::harness::TextId::PermissionsHookTimeout,&[("label",&label),("timeout",&to_string(&crate::js::number_value(timeout)))])),
                result=&mut call=>result.map_err(|error|error.render_for(harness)),
            };
            let outcome = match outcome {
                Ok(reply) => {
                    if reply["input"].is_object() {
                        input = reply["input"].clone();
                    }
                    if let Some(original) = reply.get("originalToolInput") {
                        run.pre.original_input = Some(original.clone());
                    }
                    if thread_pre && run.pre.input.is_some() {
                        if let Some(threaded) = reply.get("threadedToolInput") {
                            run.pre.input = Some(threaded.clone());
                        }
                    }
                    if let Some(error) = reply.get("error").filter(|error| !error.is_null()) {
                        Err(crate::error::Error::from_host(error.clone()).render_for(harness))
                    } else {
                        let value = reply
                            .get("result")
                            .cloned()
                            .unwrap_or_else(crate::js::undefined);
                        let object = (value.is_object() || value.is_array())
                            && !crate::js::is_undefined(&value)
                            && crate::js::number(&value).is_none();
                        if object {
                            run.outputs.push(value.clone());
                            run.references.push(Some(invocation.clone()));
                            if thread_pre {
                                run.pre.merge(&value);
                                let update = output_field(&value, "PreToolUse", "updatedInput");
                                if update.is_object() || update.is_array() {
                                    let envelope = &value["hookSpecificOutput"];
                                    let key = if envelope["hookEventName"] == "PreToolUse"
                                        && !envelope["updatedInput"].is_null()
                                    {
                                        "envelopeUpdatedInput"
                                    } else {
                                        "flatUpdatedInput"
                                    };
                                    reference =
                                        reply["inputReferences"][key].as_str().map(str::to_owned);
                                    run.pre.input_reference = reference
                                        .as_ref()
                                        .map(|reference| format!("{chain}:{reference}"));
                                }
                                if let Some(updated) = &run.pre.input {
                                    input["tool_input"] = updated.clone();
                                }
                            }
                            if let Some(observer) = observer {
                                match invoke(bridge, observer, json!([value, invocation]), &signal)
                                    .await
                                {
                                    Ok(observed) => {
                                        if observed["input"].is_object() {
                                            input = observed["input"].clone();
                                        } else if observed.is_object() && !observed.is_null() {
                                            input = observed.clone();
                                        }
                                        if let Some(value) = observed.get("result") {
                                            *run.outputs.last_mut().unwrap() = value.clone();
                                        }
                                        Ok(())
                                    }
                                    Err(error) => Err(error.render_for(harness)),
                                }
                            } else {
                                Ok(())
                            }
                        } else {
                            Ok(())
                        }
                    }
                }
                Err(error) => Err(error),
            };
            if let Err(message) = outcome {
                signal.cancel();
                if !cancellation.is_cancelled() {
                    tracing::warn!(event,session_id=%input["session_id"],error=%message,"Hook failed");
                }
                run.outputs.push(json!({"hookError":message}));
                run.references.push(None);
            }
        }
    }
    if let Err(error) = bridge
        .call(
            "hooks.release",
            json!({"chainId":chain}),
            &CancellationToken::new(),
        )
        .await
    {
        tracing::warn!(event,code=%error.code,"Hook callback scope cleanup failed");
    }
    run
}

pub async fn pre_tool(
    options: &Value,
    name: &str,
    tool_input: &Value,
    tool_id: &str,
    session: &str,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
) -> PreResult {
    let mut payload = input(options, "PreToolUse", session);
    payload["tool_name"] = json!(name);
    payload["tool_input"] = tool_input.clone();
    payload["tool_use_id"] = json!(tool_id);
    run_protocol(
        options,
        "PreToolUse",
        payload,
        Some(tool_id),
        Some(name),
        bridge,
        cancel,
        true,
        None,
        &crate::harness::baseline(),
    )
    .await
    .pre
}

pub async fn pre_tool_with_harness(
    options: &Value,
    name: &str,
    tool_input: &Value,
    tool_id: &str,
    session: &str,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
    harness: &crate::harness::ResolvedHarness,
) -> PreResult {
    let mut payload = input(options, "PreToolUse", session);
    payload["tool_name"] = json!(name);
    payload["tool_input"] = tool_input.clone();
    payload["tool_use_id"] = json!(tool_id);
    run_protocol(
        options,
        "PreToolUse",
        payload,
        Some(tool_id),
        Some(name),
        bridge,
        cancel,
        true,
        None,
        harness,
    )
    .await
    .pre
}

#[derive(Default)]
pub struct PostResult {
    pub output: Option<Value>,
    pub context: Option<String>,
    pub output_index: Option<usize>,
    pub output_field: Option<&'static str>,
}

pub async fn post_tool(
    options: &Value,
    name: &str,
    tool_input: &Value,
    response: &str,
    tool_id: &str,
    session: &str,
    failed: bool,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
) -> PostResult {
    post_tool_value(
        options,
        name,
        tool_input,
        &json!(response),
        tool_id,
        session,
        failed,
        bridge,
        cancel,
    )
    .await
}

pub async fn post_tool_value(
    options: &Value,
    name: &str,
    tool_input: &Value,
    response: &Value,
    tool_id: &str,
    session: &str,
    failed: bool,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
) -> PostResult {
    post_tool_value_with_harness(
        options,
        name,
        tool_input,
        response,
        tool_id,
        session,
        failed,
        bridge,
        cancel,
        &crate::harness::baseline(),
    )
    .await
}

pub async fn post_tool_with_harness(
    options: &Value,
    name: &str,
    tool_input: &Value,
    response: &str,
    tool_id: &str,
    session: &str,
    failed: bool,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
    harness: &crate::harness::ResolvedHarness,
) -> PostResult {
    post_tool_value_with_harness(
        options,
        name,
        tool_input,
        &json!(response),
        tool_id,
        session,
        failed,
        bridge,
        cancel,
        harness,
    )
    .await
}

pub async fn post_tool_value_with_harness(
    options: &Value,
    name: &str,
    tool_input: &Value,
    response: &Value,
    tool_id: &str,
    session: &str,
    failed: bool,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
    harness: &crate::harness::ResolvedHarness,
) -> PostResult {
    let event = if failed {
        "PostToolUseFailure"
    } else {
        "PostToolUse"
    };
    let mut payload = input(options, event, session);
    payload["tool_name"] = json!(name);
    payload["tool_input"] = tool_input.clone();
    payload["tool_use_id"] = json!(tool_id);
    payload[if failed { "error" } else { "tool_response" }] = response.clone();
    let outputs = run_protocol(
        options,
        event,
        payload,
        Some(tool_id),
        Some(name),
        bridge,
        cancel,
        false,
        None,
        harness,
    )
    .await
    .outputs;
    if failed {
        PostResult::default()
    } else {
        merge_post(&outputs)
    }
}

pub fn merge_post(outputs: &[Value]) -> PostResult {
    let mut result = PostResult::default();
    for (index, out) in outputs.iter().enumerate() {
        if out.get("hookError").is_some() {
            continue;
        }
        append_context(
            &mut result.context,
            output_field(out, "PostToolUse", "additionalContext"),
        );
        let envelope = &out["hookSpecificOutput"];
        let enveloped = if envelope["hookEventName"] == "PostToolUse" {
            envelope
                .get("updatedMCPToolOutput")
                .filter(|value| !crate::js::is_undefined(value))
        } else {
            None
        };
        let (updated, field) = if let Some(value) = enveloped {
            (Some(value), "envelope")
        } else {
            (
                out.get("updatedMCPToolOutput")
                    .filter(|value| !crate::js::is_undefined(value)),
                "flat",
            )
        };
        if let Some(value) = updated {
            result.output = Some(value.clone());
            result.output_index = Some(index);
            result.output_field = Some(field);
        }
    }
    result
}

pub async fn prepare_input(
    options: &Value,
    mut payload: Value,
    session: &str,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
) -> Value {
    let text = if let Some(text) = payload.as_str() {
        text.to_owned()
    } else if let Some(blocks) = payload["content"].as_array() {
        blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .map(|b| to_string(&b["text"]))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        to_string(&payload["content"])
    };
    let mut input = input(options, "UserPromptSubmit", session);
    input["prompt"] = json!(text);
    let outputs = run(
        options,
        "UserPromptSubmit",
        input,
        None,
        None,
        bridge,
        cancel,
    )
    .await;
    let context = outputs
        .iter()
        .filter(|o| o.get("hookError").is_none() && truthy(&o["additionalContext"]))
        .map(|o| to_string(&o["additionalContext"]))
        .collect::<Vec<_>>()
        .join("\n");
    if !context.is_empty() {
        if let Some(text) = payload.as_str() {
            payload = json!(format!("{text}\n\n{context}"));
        } else if let Some(blocks) = payload["content"].as_array_mut() {
            blocks.push(json!({"type":"text","text":context}));
        } else {
            payload = json!(format!("{}\n\n{context}", to_string(&payload["content"])));
        }
    }
    payload
}

pub async fn stop(
    options: &Value,
    session: &str,
    bridge: &dyn HostBridge,
    events: &dyn EventSink,
    cancel: &CancellationToken,
) -> crate::error::Result<(bool, Vec<Value>)> {
    stop_with_harness(
        options,
        session,
        bridge,
        events,
        cancel,
        &crate::harness::baseline(),
    )
    .await
}

pub async fn stop_with_harness(
    options: &Value,
    session: &str,
    bridge: &dyn HostBridge,
    events: &dyn EventSink,
    cancel: &CancellationToken,
    harness: &crate::harness::ResolvedHarness,
) -> crate::error::Result<(bool, Vec<Value>)> {
    if cancel.is_cancelled() {
        return Ok((true, vec![]));
    }
    if options["hooks"]["Stop"]
        .as_array()
        .is_none_or(|hooks| hooks.is_empty())
    {
        return Ok((false, vec![]));
    }
    let hook_id = uuid::Uuid::new_v4().to_string();
    let mut notification = json!({"type":"system","subtype":"hook_started","hook_id":hook_id,"hook_name":"Stop","hook_event":"Stop","uuid":uuid::Uuid::new_v4().to_string(),"session_id":session});
    events.emit(notification.clone()).await?;
    let mut payload = input(options, "Stop", session);
    payload["stop_hook_active"] = json!(false);
    let outputs = run_protocol(
        options, "Stop", payload, None, None, bridge, cancel, false, None, harness,
    )
    .await
    .outputs;
    if cancel.is_cancelled() {
        return Ok((true, vec![]));
    }
    notification["subtype"] = json!("hook_response");
    notification["output"] = json!("");
    notification["stdout"] = json!("");
    notification["stderr"] = json!("");
    notification["outcome"] = json!("success");
    notification["uuid"] = json!(uuid::Uuid::new_v4().to_string());
    events.emit(notification.clone()).await?;
    let mut blocked = Vec::new();
    let mut prevent = false;
    for out in outputs {
        prevent |= out["preventContinuation"] == true;
        let message = out["blockingError"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                (out["decision"] == "block").then(|| {
                    out["reason"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or(out["systemMessage"].as_str().filter(|s| !s.is_empty()))
                        .unwrap_or_else(|| {
                            harness.text(crate::harness::TextId::PermissionsStopBlocked)
                        })
                })
            });
        if let Some(message) = message {
            blocked.push(json!({"role":"user","content":message}));
            notification["output"] = json!(message);
            notification["stdout"] = json!(message);
            notification["outcome"] = json!("error");
            notification["uuid"] = json!(uuid::Uuid::new_v4().to_string());
            events.emit(notification.clone()).await?;
        }
    }
    Ok((prevent, if prevent { vec![] } else { blocked }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct Bridge {
        calls: Mutex<Vec<Value>>,
        signals: Mutex<Vec<CancellationToken>>,
        releases: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl HostBridge for Bridge {
        async fn call(
            &self,
            method: &str,
            params: Value,
            cancel: &CancellationToken,
        ) -> crate::error::Result<Value> {
            if method == "hooks.release" {
                self.releases
                    .lock()
                    .unwrap()
                    .push(params["chainId"].as_str().unwrap().into());
                return Ok(Value::Null);
            }
            assert_eq!(method, "hooks.call");
            self.calls.lock().unwrap().push(params.clone());
            self.signals.lock().unwrap().push(cancel.clone());
            let mut input = params["input"].clone();
            let result = match params["callbackId"].as_str().unwrap() {
                "first" => {
                    json!({"permissionDecision":"deny","updatedInput":{"path":"first"},"additionalContext":"first"})
                }
                "second" => {
                    assert_eq!(input["tool_input"], json!({"path":"first"}));
                    assert_eq!(params["toolInputReference"], "first-input");
                    json!({"permissionDecision":"deny","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"path":"second"},"additionalContext":"second"}})
                }
                "mutate_fail" => {
                    input["tool_input"]["mutation"] = json!(true);
                    return Ok(
                        json!({"input":input,"originalToolInput":input["tool_input"],"error":{"message":"fixture failure","name":"Error"}}),
                    );
                }
                "observe_mutation" => {
                    assert_eq!(input["tool_input"]["mutation"], true);
                    json!({"permissionDecision":"allow"})
                }
                "replace" => {
                    json!({"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedMCPToolOutput":null,"additionalContext":"after"}})
                }
                "timeout" => {
                    std::future::pending::<()>().await;
                    unreachable!()
                }
                _ => panic!("unexpected hook"),
            };
            Ok(
                json!({"result":result,"input":input,"inputReferences":{"flatUpdatedInput":"first-input","envelopeUpdatedInput":"second-input"}}),
            )
        }
    }
    fn bridge() -> Bridge {
        Bridge {
            calls: Mutex::new(vec![]),
            signals: Mutex::new(vec![]),
            releases: Mutex::new(vec![]),
        }
    }

    /// A callback that records every call and answers from a per-callback table.
    struct Scripted {
        answers: std::collections::HashMap<String, Value>,
        calls: Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl HostBridge for Scripted {
        async fn call(&self, method: &str, params: Value, _: &CancellationToken) -> crate::error::Result<Value> {
            if method == "hooks.release" {
                return Ok(Value::Null);
            }
            assert_eq!(method, "hooks.call");
            self.calls.lock().unwrap().push(params.clone());
            let result = self.answers[params["callbackId"].as_str().unwrap()].clone();
            Ok(json!({"result":result,"input":params["input"]}))
        }
    }
    fn scripted(answers: &[(&str, Value)]) -> Scripted {
        Scripted {
            answers: answers.iter().map(|(id, value)| ((*id).to_owned(), value.clone())).collect(),
            calls: Mutex::new(vec![]),
        }
    }
    fn hooks(event: &str, matchers: Value) -> Value {
        json!({"cwd":"/tmp/fixture","hooks":{event:matchers}})
    }

    #[tokio::test]
    async fn wildcard_and_exact_matchers_select_only_matching_tools() {
        let bridge = scripted(&[("wild", json!({"additionalContext":"wild"}))]);
        let options = hooks("PreToolUse", json!([
            {"matcher":"Bash","hooks":[{"__haloSdkNativeCallback":"wild"}]},
            {"matcher":"mcp__*","hooks":[{"__haloSdkNativeCallback":"wild"}]}
        ]));
        let miss = run(&options, "PreToolUse", json!({"tool_name":"Read"}), Some("id"), Some("Read"), &bridge, &CancellationToken::new()).await;
        assert!(miss.is_empty());
        assert!(bridge.calls.lock().unwrap().is_empty());
        let hit = run(&options, "PreToolUse", json!({"tool_name":"mcp__records__lookup"}), Some("id"), Some("mcp__records__lookup"), &bridge, &CancellationToken::new()).await;
        assert_eq!(hit.len(), 1);
        assert_eq!(bridge.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_matcher_without_a_pattern_runs_for_every_tool() {
        let bridge = scripted(&[("any", json!({"permissionDecision":"deny"}))]);
        let options = hooks("PreToolUse", json!([{"hooks":[{"__haloSdkNativeCallback":"any"}]}]));
        for name in ["Read", "Bash", "mcp__records__lookup"] {
            let result = run(&options, "PreToolUse", json!({"tool_name":name}), Some("id"), Some(name), &bridge, &CancellationToken::new()).await;
            assert_eq!(result.len(), 1, "{name}");
        }
        assert_eq!(bridge.calls.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn no_registered_matchers_skip_the_bridge() {
        let bridge = scripted(&[]);
        let post = post_tool(&Value::Null, "Read", &json!({}), "ok", "id", "session", false, &bridge, &CancellationToken::new()).await;
        assert!(post.output.is_none() && post.context.is_none());
        let result = run(&Value::Null, "PreToolUse", json!({}), None, Some("Read"), &bridge, &CancellationToken::new()).await;
        assert!(result.is_empty());
        assert!(bridge.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn post_tool_merges_context_from_every_hook_in_order() {
        let bridge = scripted(&[("first", json!({"additionalContext":"one"})), ("second", json!({"additionalContext":"two"}))]);
        let options = hooks("PostToolUse", json!([{"hooks":[{"__haloSdkNativeCallback":"first"},{"__haloSdkNativeCallback":"second"}]}]));
        let post = post_tool(&options, "Read", &json!({}), "ok", "id", "session", false, &bridge, &CancellationToken::new()).await;
        assert_eq!(post.context.as_deref(), Some("one\ntwo"));
    }

    #[tokio::test]
    async fn pre_tool_keeps_no_decision_when_hooks_have_no_opinion() {
        let bridge = scripted(&[("quiet", json!({"additionalContext":"note"}))]);
        let options = hooks("PreToolUse", json!([{"hooks":[{"__haloSdkNativeCallback":"quiet"}]}]));
        let result = pre_tool(&options, "Read", &json!({"path":"a"}), "id", "session", &bridge, &CancellationToken::new()).await;
        assert!(result.decision.is_none());
        assert!(result.input.is_none());
        assert_eq!(result.context.as_deref(), Some("note"));
    }

    #[tokio::test]
    async fn stop_resolves_blocking_text_and_continuation() {
        for (answer, blocked, prevent, text) in [
            (json!({"blockingError":"please retry"}), true, false, Some("please retry")),
            (json!({"decision":"block","reason":"finish #42"}), true, false, Some("finish #42")),
            (json!({"decision":"block","systemMessage":"system notice"}), true, false, Some("system notice")),
            (json!({"decision":"block"}), true, false, Some(harness_text(crate::harness::TextId::PermissionsStopBlocked).as_str())),
            (json!({"decision":"approve","reason":"ok"}), false, false, None),
            (json!({"preventContinuation":true,"blockingError":"ignored"}), false, true, None),
        ] {
            let bridge = scripted(&[("stop", answer.clone())]);
            let options = hooks("Stop", json!([{"hooks":[{"__haloSdkNativeCallback":"stop"}]}]));
            let (prevented, messages) = stop(&options, "session", &bridge, &NoEvents, &CancellationToken::new()).await.unwrap();
            assert_eq!(prevented, prevent, "{answer}");
            assert_eq!(!messages.is_empty(), blocked, "{answer}");
            if let Some(text) = text {
                assert_eq!(messages[0]["role"], "user");
                assert_eq!(messages[0]["content"], json!(text), "{answer}");
            }
        }
    }

    #[tokio::test]
    async fn stop_fast_paths_without_hooks_and_short_circuits_on_cancellation() {
        let bridge = scripted(&[("stop", json!({"blockingError":"never"}))]);
        let (prevented, messages) = stop(&hooks("Stop", json!([])), "session", &bridge, &NoEvents, &CancellationToken::new()).await.unwrap();
        assert!(!prevented && messages.is_empty());
        assert!(bridge.calls.lock().unwrap().is_empty());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let options = hooks("Stop", json!([{"hooks":[{"__haloSdkNativeCallback":"stop"}]}]));
        let (prevented, messages) = stop(&options, "session", &bridge, &NoEvents, &cancelled).await.unwrap();
        assert!(prevented && messages.is_empty());
        assert!(bridge.calls.lock().unwrap().is_empty());
    }

    fn harness_text(id: crate::harness::TextId) -> String {
        crate::harness::baseline().text(id).to_owned()
    }

    struct NoEvents;
    #[async_trait]
    impl EventSink for NoEvents {
        async fn emit(&self, _event: Value) -> crate::error::Result<()> { Ok(()) }
    }

    #[tokio::test]
    async fn input_threads_and_envelope_wins_in_registration_order() {
        let bridge = bridge();
        let options = json!({"cwd":"/tmp/fixture","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"__haloSdkNativeCallback":"unused"}]},{"matcher":"Re*","hooks":[{"__haloSdkNativeCallback":"first"},{"__haloSdkNativeCallback":"second"}]}]}});
        let result = pre_tool(
            &options,
            "Read",
            &json!({"path":"original"}),
            "call",
            "session",
            &bridge,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(result.decision.as_deref(), Some("allow"));
        assert_eq!(result.input, Some(json!({"path":"second"})));
        assert_eq!(result.context.as_deref(), Some("first\nsecond"));
        assert_eq!(bridge.calls.lock().unwrap().len(), 2);
        let chain = bridge.releases.lock().unwrap()[0].clone();
        assert_eq!(
            result.input_reference.as_deref(),
            Some(format!("{chain}:second-input").as_str())
        );
    }

    #[tokio::test]
    async fn failed_hook_mutations_are_visible_to_later_hooks() {
        let bridge = bridge();
        let options = json!({"cwd":"/tmp/fixture","hooks":{"PreToolUse":[{"hooks":[{"__haloSdkNativeCallback":"mutate_fail"},{"__haloSdkNativeCallback":"observe_mutation"}]}]}});
        let result = pre_tool(
            &options,
            "Read",
            &json!({"path":"original"}),
            "id",
            "session",
            &bridge,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(
            result.original_input,
            Some(json!({"path":"original","mutation":true}))
        );
        assert_eq!(result.decision.as_deref(), Some("allow"));
        assert_eq!(bridge.releases.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn output_can_be_replaced_with_null_and_timeout_cancels_callback() {
        let bridge = bridge();
        let options = json!({"cwd":"/tmp/fixture","hooks":{"PostToolUse":[{"hooks":[{"__haloSdkNativeCallback":"replace"}]}],"PreToolUse":[{"timeout":0.001,"hooks":[{"__haloSdkNativeCallback":"timeout"}]}]}});
        let post = post_tool(
            &options,
            "Read",
            &json!({}),
            "content",
            "id",
            "session",
            false,
            &bridge,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(post.output, Some(Value::Null));
        assert_eq!(post.context.as_deref(), Some("after"));
        let outputs = run(
            &options,
            "PreToolUse",
            json!({"session_id":"session"}),
            Some("id"),
            Some("Read"),
            &bridge,
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(
            outputs,
            json!([{"hookError":"Hook \"PreToolUse\" timed out after 1ms"}])
                .as_array()
                .unwrap()
                .clone()
        );
        assert!(bridge.signals.lock().unwrap()[1].is_cancelled());
    }
}
