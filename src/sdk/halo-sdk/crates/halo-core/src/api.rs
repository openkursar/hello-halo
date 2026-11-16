use crate::{
    callback_channel::CallbackChannel,
    core::compact::{self, CompactCallbacks, CompactCandidate, SummaryProvider},
    error::{Error, Result},
    llm::{anthropic_request::invoke, provider::Provider},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

pub type PublicExecution = CallbackChannel;

struct LazyProvider {
    options: Value,
    bridge: Arc<CallbackChannel>,
    provider: OnceLock<Provider>,
    response_reference: Arc<Mutex<Option<String>>>,
}
#[async_trait]
impl SummaryProvider for LazyProvider {
    async fn complete(&self, request: &mut Value, cancel: &CancellationToken) -> Result<Value> {
        let callback = &self.options["helperCallbacks"]["complete"];
        if callback["__haloSdkNativeCallback"].is_string() {
            let mut sent = request.clone();
            if !sent["providerOptions"].is_object() {
                sent["providerOptions"] = json!({});
            }
            sent["providerOptions"]["signal"] = json!({"__haloSdkNativeSignal":true});
            let value = invoke(self.bridge.as_ref(), callback, json!([sent]), cancel).await?;
            if let Some(updated) = value.get("request") {
                *request = updated.clone();
                if let Some(options) = request["providerOptions"].as_object_mut() {
                    options.remove("signal");
                }
            }
            *self.response_reference.lock().unwrap() = value["reference"].as_str().map(str::to_owned);
            if let Some(error) = value.get("error") {
                return Err(Error::from_host(error.clone()));
            }
            return Ok(value["response"].clone());
        }
        if self.provider.get().is_none() {
            let provider = Provider::new(&self.options, self.bridge.clone())?;
            let _ = self.provider.set(provider);
        }
        self.provider
            .get()
            .unwrap()
            .complete(request.clone(), cancel.clone())
            .await
    }
}
struct PublicCompactCallbacks {
    references: Value,
    bridge: Arc<CallbackChannel>,
    cancellation: CancellationToken,
    response_reference: Arc<Mutex<Option<String>>>,
}
#[async_trait]
impl CompactCallbacks for PublicCompactCallbacks {
    fn has_estimator(&self) -> bool {
        self.references["estimate"]["__haloSdkNativeCallback"].is_string()
    }
    async fn estimate(&self, messages: &[Value]) -> Result<f64> {
        if !self.has_estimator() {
            return Ok(crate::core::tokens::estimate_message_tokens(messages));
        }
        let value = invoke(
            self.bridge.as_ref(),
            &self.references["estimate"],
            json!([messages]),
            &self.cancellation,
        )
        .await?;
        crate::js::number(&value["value"])
            .ok_or_else(|| Error::new("INVALID_ESTIMATE", "Context estimator must return a number"))
    }
    async fn estimate_candidate(&self, candidate: &CompactCandidate) -> Result<f64> {
        if !self.has_estimator() {
            return Ok(crate::core::tokens::estimate_message_tokens(&candidate.messages));
        }
        let value = invoke(
            self.bridge.as_ref(),
            &self.references["estimate"],
            json!([candidate.messages, candidate.origins, candidate.reference]),
            &self.cancellation,
        ).await?;
        crate::js::number(&value["value"])
            .ok_or_else(|| Error::new("INVALID_ESTIMATE", "Context estimator must return a number"))
    }
    async fn prepare_candidate(&self, candidate: CompactCandidate) -> Result<CompactCandidate> {
        if !self.references["prepare"]["__haloSdkNativeCallback"].is_string() {
            return Ok(candidate);
        }
        let value = invoke(
            self.bridge.as_ref(),
            &self.references["prepare"],
            json!([candidate.messages, candidate.origins, candidate.reference]),
            &self.cancellation,
        )
        .await?;
        if value
            .get("value")
            .is_none_or(|value| value.is_null() || crate::js::is_undefined(value))
        {
            return Ok(candidate);
        }
        let messages = value["value"].as_array().cloned().ok_or_else(|| {
            Error::new(
                "INVALID_CANDIDATE",
                "Context preparation must return messages",
            )
        })?;
        let origins = serde_json::from_value(value["origins"].clone())
            .unwrap_or_else(|_| vec![None; messages.len()]);
        Ok(CompactCandidate { messages, origins, reference: value["reference"].as_str().map(str::to_owned) })
    }
    async fn response(&self, response: &mut Value) -> Result<()> {
        if self.references["response"]["__haloSdkNativeCallback"].is_string() {
            let reference = self.response_reference.lock().unwrap().take();
            let value = invoke(
                self.bridge.as_ref(),
                &self.references["response"],
                json!([response, reference]),
                &self.cancellation,
            )
            .await?;
            if let Some(updated) = value.get("value") {
                *response = updated.clone();
            }
        }
        Ok(())
    }
    async fn snapshot(&self) -> Result<Option<Vec<Value>>> {
        if !self.references["snapshot"]["__haloSdkNativeCallback"].is_string() {
            return Ok(None);
        }
        let value = invoke(
            self.bridge.as_ref(),
            &self.references["snapshot"],
            json!([]),
            &self.cancellation,
        )
        .await?;
        value.as_array().cloned().map(Some).ok_or_else(|| {
            Error::new(
                "INVALID_HISTORY",
                "Conversation snapshot must return messages",
            )
        })
    }
}

pub fn start_public(
    operation: String,
    options: Value,
    payload: Value,
    services: crate::bridge::HostServices,
) -> Result<Arc<PublicExecution>> {
    CallbackChannel::spawn(move |channel| async move {
        channel.set_host_services(services);
        let cancellation = channel.cancellation();
        if let Some(operation) = operation.strip_prefix("history.") {
            return Ok(Some(
                crate::history::admin::execute(operation, &options, &payload, &cancellation)
                    .await?,
            ));
        }
        match operation.as_str() {
            "hooks.run" | "hooks.pre" | "hooks.post" | "hooks.failure" => {
                use crate::core::hooks;
                let event = payload["event"].as_str().unwrap_or("");
                let mut input = if operation == "hooks.run" {
                    payload["input"].clone()
                } else {
                    let mut input =
                        hooks::input(&options, event, payload["sessionId"].as_str().unwrap_or(""));
                    input["tool_name"] = payload["toolName"].clone();
                    input["tool_input"] = payload["toolInput"].clone();
                    input["tool_use_id"] = payload["toolUseId"].clone();
                    input
                };
                if operation == "hooks.post" {
                    input["tool_response"] = payload["toolResponse"].clone();
                }
                if operation == "hooks.failure" {
                    input["error"] = payload["error"].clone();
                }
                let outputs = hooks::run_protocol(
                    &options,
                    event,
                    input,
                    payload["toolUseId"].as_str(),
                    payload["toolName"].as_str(),
                    channel.as_ref(),
                    &channel.interruption(),
                    operation == "hooks.pre",
                    options.get("helperObserver"),
                    &crate::harness::baseline(),
                )
                .await;
                let mut result = json!({"outputs":outputs.outputs,"references":outputs.references});
                if operation == "hooks.pre" {
                    let mut pre = serde_json::Map::new();
                    if let Some(value) = outputs.pre.decision {
                        pre.insert("decision".into(), json!(value));
                    }
                    if let Some(value) = outputs.pre.reason {
                        pre.insert("decisionReason".into(), json!(value));
                    }
                    if let Some(value) = outputs.pre.input {
                        pre.insert("updatedInput".into(), value);
                    }
                    if let Some(value) = outputs.pre.context {
                        pre.insert("additionalContext".into(), json!(value));
                    }
                    result["pre"] = Value::Object(pre);
                    result["inputReference"] = json!(outputs.pre.input_reference);
                } else if operation == "hooks.post" {
                    let post = hooks::merge_post(result["outputs"].as_array().unwrap());
                    let mut value = serde_json::Map::new();
                    if let Some(context) = post.context {
                        value.insert("additionalContext".into(), json!(context));
                    }
                    if let Some(output) = post.output {
                        value.insert("updatedToolOutput".into(), output);
                    }
                    result["post"] = Value::Object(value);
                    result["outputIndex"] = json!(post.output_index);
                    result["outputField"] = json!(post.output_field);
                }
                Ok(Some(result))
            }
            "compact.full" | "compact.partial" | "compact.auto" => {
                if operation == "compact.auto"
                    && (crate::js::truthy(&payload["disabled"])
                        || !(crate::js::number(&payload["inputTokens"]).unwrap_or(f64::NAN)
                            >= (crate::js::number(&payload["contextWindow"]).unwrap_or(f64::NAN)
                                * 0.9)
                                .floor()))
                {
                    return Ok(Some(Value::Null));
                }
                let response_reference = Arc::new(Mutex::new(None));
                let provider = LazyProvider {
                    options: options.clone(),
                    bridge: channel.clone(),
                    provider: OnceLock::new(),
                    response_reference: response_reference.clone(),
                };
                let callbacks = PublicCompactCallbacks {
                    references: options["helperCallbacks"].clone(),
                    bridge: channel.clone(),
                    cancellation: cancellation.clone(),
                    response_reference,
                };
                let messages = payload["messages"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let model = payload["model"].as_str().unwrap_or("");
                let result = if operation != "compact.partial" {
                    compact::full_compact(
                        messages,
                        &provider,
                        model,
                        payload["attachments"]
                            .as_array()
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                        payload["instructions"].as_str(),
                        payload["transcriptPath"].as_str(),
                        &options["helperOptions"],
                        &callbacks,
                        &cancellation,
                    )
                    .await
                } else {
                    compact::partial_compact(
                        messages,
                        &provider,
                        model,
                        &options["helperOptions"],
                        &callbacks,
                        &cancellation,
                    )
                    .await
                };
                if operation != "compact.auto" {
                    return Ok(Some(result?.receipt()));
                }
                let outcome: Result<Option<Value>> = async {
                    let result = result?;
                    if result.summary.is_empty() {
                        return Ok(None);
                    }
                    invoke(
                        channel.as_ref(),
                        &options["stateCallbacks"]["success"],
                        json!([]),
                        &cancellation,
                    )
                    .await?;
                    Ok(Some(result.receipt()))
                }
                .await;
                match outcome {
                    Ok(result) => Ok(Some(result.unwrap_or(Value::Null))),
                    Err(error) => {
                        if cancellation.is_cancelled() {
                            return Err(error);
                        }
                        let state = invoke(
                            channel.as_ref(),
                            &options["stateCallbacks"]["failure"],
                            json!([]),
                            &cancellation,
                        )
                        .await?;
                        tracing::warn!(error=%error.display_for(&crate::harness::baseline()),failures=%state["consecutiveFailures"],disabled=%state["disabled"],"automatic compaction failed; retaining current history");
                        Ok(Some(Value::Null))
                    }
                }
            }
            _ => Err(Error::new(
                "UNKNOWN_OPERATION",
                format!("Unknown public SDK operation: {operation}"),
            )),
        }
    })
}
