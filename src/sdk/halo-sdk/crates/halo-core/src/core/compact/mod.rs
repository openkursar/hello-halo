pub mod local;
pub mod session;
mod summary;
use crate::{
    error::{Error, Result},
    llm::provider::Provider,
};
use async_trait::async_trait;
pub use local::{api_compact, format_summary, micro_compact};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub use summary::{
    full_compact, full_compact_with_harness, partial_compact, partial_compact_with_harness,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct AutoCompactState {
    pub compaction_count: u64,
    pub consecutive_failures: u64,
    pub disabled: bool,
}
impl AutoCompactState {
    pub fn success(&mut self) {
        self.compaction_count += 1;
        self.consecutive_failures = 0;
    }
    pub fn failure(&mut self) {
        self.consecutive_failures += 1;
        if self.consecutive_failures >= 3 {
            self.disabled = true;
        }
    }
}
pub fn token_warning(input: f64, window: f64) -> &'static str {
    let ratio = input / window;
    if ratio >= 0.95 {
        "critical"
    } else if ratio >= 0.8 {
        "warning"
    } else {
        "ok"
    }
}
pub fn should_auto_compact(input: f64, window: f64, state: &AutoCompactState) -> bool {
    !state.disabled && input >= (window * 0.9).floor()
}
pub fn compact_error(reason: &str, message: &str) -> Error {
    Error::new("COMPACT_ERROR", message)
        .with_details(json!({"name":"CompactionError","reason":reason}))
}
pub fn compact_error_template(
    reason: &str,
    id: crate::harness::TextId,
    values: &[(&str, crate::harness::Message)],
) -> Error {
    Error::template("COMPACT_ERROR", id, values)
        .with_details(json!({"name":"CompactionError","reason":reason}))
}
pub fn is_context_exceeded(error: &Error) -> bool {
    let details = error.details.as_ref().unwrap_or(&Value::Null);
    let status = details
        .get("statusCode")
        .or(details.get("status"))
        .and_then(Value::as_u64);
    if ![Some(400), Some(413), Some(422)].contains(&status) {
        return false;
    }
    let message = error.message.to_lowercase();
    [
        "prompt is too long",
        "context_window_exceeded",
        "context_length_exceeded",
        "prompt_too_long",
        "maximum context length",
        "context window",
        "exceeds the available context size",
    ]
    .iter()
    .any(|phrase| message.contains(phrase))
}
#[async_trait]
pub trait SummaryProvider: Send + Sync {
    async fn complete(
        &self,
        request: &mut Value,
        cancellation: &CancellationToken,
    ) -> Result<Value>;
}
#[async_trait]
impl SummaryProvider for Provider {
    async fn complete(
        &self,
        request: &mut Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        self.complete(request.clone(), cancellation.clone()).await
    }
}
#[async_trait]
pub trait CompactCallbacks: Send + Sync {
    fn has_estimator(&self) -> bool {
        false
    }
    async fn estimate(&self, messages: &[Value]) -> Result<f64> {
        Ok(super::tokens::estimate_message_tokens(messages))
    }
    async fn estimate_candidate(&self, candidate: &CompactCandidate) -> Result<f64> {
        self.estimate(&candidate.messages).await
    }
    async fn prepare_candidate(&self, candidate: CompactCandidate) -> Result<CompactCandidate> {
        Ok(candidate)
    }
    async fn response(&self, _response: &mut Value) -> Result<()> {
        Ok(())
    }
    async fn snapshot(&self) -> Result<Option<Vec<Value>>> {
        Ok(None)
    }
}
pub struct DefaultCallbacks;
#[async_trait]
impl CompactCallbacks for DefaultCallbacks {}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MessageOrigin {
    History { index: usize },
    Attachment { index: usize },
    Callback { reference: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CompactCandidate {
    pub messages: Vec<Value>,
    pub origins: Vec<Option<MessageOrigin>>,
    #[serde(default)]
    pub reference: Option<String>,
}
impl CompactCandidate {
    pub fn created(messages: Vec<Value>) -> Self {
        Self { origins: vec![None; messages.len()], messages, reference: None }
    }
    pub fn history(messages: &[Value]) -> Self {
        let mut candidate = Self::created(Vec::new());
        candidate.extend_history(messages, 0);
        candidate
    }
    pub fn push(&mut self, message: Value, origin: Option<MessageOrigin>) {
        self.messages.push(message);
        self.origins.push(origin);
    }
    pub fn extend_history(&mut self, messages: &[Value], start: usize) {
        for (offset, message) in messages.iter().enumerate() {
            self.push(message.clone(), Some(MessageOrigin::History { index: start + offset }));
        }
    }
    pub fn extend_attachments(&mut self, messages: &[Value]) {
        for (index, message) in messages.iter().enumerate() {
            self.push(message.clone(), Some(MessageOrigin::Attachment { index }));
        }
    }
}
#[derive(Clone, Debug)]
pub struct CompactResult {
    pub messages: Vec<Value>,
    pub origins: Vec<Option<MessageOrigin>>,
    pub array_reference: Option<String>,
    pub summary: String,
    pub tokens_freed: f64,
}
impl CompactResult {
    pub fn value(&self) -> Value {
        json!({"messages":self.messages,"summary":self.summary,"tokensFreed":self.tokens_freed})
    }
    pub fn receipt(&self) -> Value {
        let mut value = self.value();
        value["origins"] = json!(self.origins);
        value["arrayReference"] = json!(self.array_reference);
        value
    }
    pub fn retained_indices(&self, original: &std::collections::HashSet<usize>) -> std::collections::HashSet<usize> {
        self.origins.iter().enumerate().filter_map(|(index, origin)| {
            match origin {
                Some(MessageOrigin::History { index: previous }) if original.contains(previous) => Some(index),
                _ => None,
            }
        }).collect()
    }
}
pub fn check_cancel(cancellation: &CancellationToken) -> Result<()> {
    if cancellation.is_cancelled() {
        Err(Error::cancelled())
    } else {
        Ok(())
    }
}
pub fn summary_budget(options: &Value) -> Result<f64> {
    let budget = options
        .get("maxTokens")
        .and_then(Value::as_f64)
        .unwrap_or(20_000.0);
    if !budget.is_finite()
        || budget.fract() != 0.0
        || budget < 1.0
        || budget > 9_007_199_254_740_991.0
    {
        return Err(Error::template(
            "INVALID_ARGUMENT",
            crate::harness::TextId::ContextCompactionInvalidBudget,
            &[],
        )
        .with_details(json!({"name":"RangeError"})));
    }
    Ok(budget)
}
pub async fn auto_compact(
    messages: &[Value],
    input: f64,
    window: f64,
    model: &str,
    provider: &dyn SummaryProvider,
    state: &mut AutoCompactState,
    attachments: &[Value],
    path: Option<&str>,
    options: &Value,
    callbacks: &dyn CompactCallbacks,
    cancel: &CancellationToken,
) -> Result<Option<CompactResult>> {
    if !should_auto_compact(input, window, state) {
        return Ok(None);
    }
    match full_compact(
        messages,
        provider,
        model,
        attachments,
        None,
        path,
        options,
        callbacks,
        cancel,
    )
    .await
    {
        Ok(result) if result.summary.is_empty() => Ok(None),
        Ok(result) => {
            state.success();
            Ok(Some(result))
        }
        Err(error) if cancel.is_cancelled() => Err(error),
        Err(error) => {
            state.failure();
            tracing::warn!(error=%error.message,failures=state.consecutive_failures,disabled=state.disabled,"Automatic compaction failed; retaining current history");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    struct FixtureProvider {
        behavior: String,
        calls: Mutex<usize>,
        requests: Mutex<Vec<Value>>,
        live: Arc<Mutex<Vec<Value>>>,
    }
    #[async_trait]
    impl SummaryProvider for FixtureProvider {
        async fn complete(
            &self,
            request: &mut Value,
            _cancel: &CancellationToken,
        ) -> Result<Value> {
            self.requests.lock().unwrap().push(request.clone());
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            if self.behavior == "segment" && request["messages"].as_array().unwrap().len() > 6 {
                return Err(Error::new("PROVIDER_ERROR", "context window exceeded")
                    .with_details(json!({"status":400})));
            }
            if *calls == 1 && self.behavior == "append" {
                self.live.lock().unwrap().push(
                    json!({"role":"user","content":"New correction arrived during summarization."}),
                );
            }
            if *calls == 1 && self.behavior == "replace" {
                self.live.lock().unwrap()[0] =
                    json!({"role":"user","content":"Replaced original request"});
            }
            let tool = self.behavior == "tool_then_text" && *calls == 1;
            Ok(
                json!({"id":"summary","model":"fixture","content":if tool{json!([{"type":"tool_use","id":"unexpected","name":"Read","input":{}}])}else{json!([{"type":"text","text":"Prepared handover. Verify the remaining change."}])},"stopReason":if tool{"tool_use"}else{"end_turn"},"usage":{"input_tokens":100,"output_tokens":10}}),
            )
        }
    }
    struct Callbacks {
        estimate: bool,
        deduplicate: bool,
        live: Arc<Mutex<Vec<Value>>>,
        observations: Mutex<Vec<Value>>,
    }
    #[async_trait]
    impl CompactCallbacks for Callbacks {
        fn has_estimator(&self) -> bool {
            self.estimate
        }
        async fn prepare_candidate(&self, candidate: CompactCandidate) -> Result<CompactCandidate> {
            let mut output = CompactCandidate::created(Vec::new());
            for (index, message) in candidate.messages.iter().enumerate() {
                if !self.deduplicate || candidate.messages[..index].iter()
                    .all(|other| other["content"] != message["content"])
                {
                    output.push(message.clone(), candidate.origins[index].clone());
                }
            }
            Ok(output)
        }
        async fn response(&self, response: &mut Value) -> Result<()> {
            self.observations.lock().unwrap().push(response.clone());
            Ok(())
        }
        async fn snapshot(&self) -> Result<Option<Vec<Value>>> {
            Ok(Some(self.live.lock().unwrap().clone()))
        }
    }
    fn same(actual: &Value, expected: &Value, label: &str) {
        let actual = crate::js::stringify(actual);
        let expected = crate::js::stringify(expected);
        if actual != expected {
            let offset = actual
                .chars()
                .zip(expected.chars())
                .position(|(a, b)| a != b)
                .unwrap_or_else(|| actual.chars().count().min(expected.chars().count()));
            panic!(
                "{label}: mismatch at character {offset}; actual={:?}, expected={:?}",
                actual
                    .chars()
                    .skip(offset.saturating_sub(60))
                    .take(200)
                    .collect::<String>(),
                expected
                    .chars()
                    .skip(offset.saturating_sub(60))
                    .take(200)
                    .collect::<String>()
            );
        }
    }
    #[tokio::test]
    async fn summary_requests_recovery_and_results_match_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/golden.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let original = case["history"].as_array().unwrap().clone();
            let live = Arc::new(Mutex::new(original.clone()));
            let provider = FixtureProvider {
                behavior: case["behavior"].as_str().unwrap_or("").into(),
                calls: Mutex::new(0),
                requests: Mutex::new(Vec::new()),
                live: live.clone(),
            };
            let callbacks = Callbacks {
                estimate: case["estimate"] == true,
                deduplicate: case["prepare"] == "deduplicate",
                live: live.clone(),
                observations: Mutex::new(Vec::new()),
            };
            let cancel = CancellationToken::new();
            let result = if case["mode"] == "partial" {
                partial_compact(
                    &original,
                    &provider,
                    "fixture",
                    &case["options"],
                    &callbacks,
                    &cancel,
                )
                .await
            } else {
                full_compact(
                    &original,
                    &provider,
                    "fixture",
                    case["attachments"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                    None,
                    None,
                    &case["options"],
                    &callbacks,
                    &cancel,
                )
                .await
            };
            let label = case["name"].as_str().unwrap();
            match result {
                Ok(result) => same(&result.value(), &case["expected"]["result"], label),
                Err(error) => {
                    let mut result = json!({"code":error.code,"name":error.details.as_ref().and_then(|details|details["name"].as_str()).unwrap_or("Error"),"message":error.message});
                    if let Some(reason) = error
                        .details
                        .as_ref()
                        .and_then(|details| details.get("reason"))
                    {
                        result["reason"] = reason.clone();
                    }
                    let expected = &case["expected"]["error"];
                    for key in ["code", "name", "message", "reason"] {
                        same(&result[key], &expected[key], label);
                    }
                }
            }
            same(
                &json!(*provider.requests.lock().unwrap()),
                &case["expected"]["requests"],
                &format!("{label} requests"),
            );
            same(
                &json!(*callbacks.observations.lock().unwrap()),
                &case["expected"]["observations"],
                &format!("{label} observed usage"),
            );
            same(
                &json!(*live.lock().unwrap()),
                &case["expected"]["live"],
                &format!("{label} live history"),
            );
        }
    }
    #[test]
    fn local_reductions_preserve_pairing_and_match_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/golden.json")).unwrap();
        for case in fixture["localCases"].as_array().unwrap() {
            let actual = match case["kind"].as_str().unwrap() {
                "format" => json!(format_summary(case["input"].as_str().unwrap())),
                "api" => json!(api_compact(
                    case["input"].as_array().unwrap(),
                    None,
                    case["window"].as_f64()
                )),
                "micro" => {
                    let (messages, count) = micro_compact(
                        case["input"].as_array().unwrap(),
                        case["budget"].as_f64().unwrap(),
                    );
                    json!({"messages":messages,"truncatedCount":count})
                }
                _ => unreachable!(),
            };
            same(&actual, &case["expected"], case["kind"].as_str().unwrap());
        }
    }
}
