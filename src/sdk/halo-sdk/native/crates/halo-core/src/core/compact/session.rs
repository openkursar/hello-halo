use super::{
    check_cancel, compact_error_template, full_compact_with_harness, CompactCallbacks,
    CompactCandidate, CompactResult, SummaryProvider,
};
use crate::{
    bridge::EventSink,
    core::loop_owner::LoopExecution,
    core::{
        hooks,
        token_budget::{maintenance_output_budget, TokenBudget},
    },
    error::{Error, Result},
    llm::provider::Provider,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct ContextState {
    pub compacted_history_tokens: Option<f64>,
    pub deferred_history_tokens: Option<f64>,
}
impl ContextState {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
#[derive(Default)]
pub struct OutputAllowance {
    pub limit: Option<f64>,
    pub corrected: bool,
}
impl OutputAllowance {
    pub fn correct(&mut self, request: &Value, error: &Error, session: &str) -> Option<f64> {
        if self.corrected {
            return None;
        }
        let maximum = request["maxTokens"].as_f64()?;
        let details = error.details.as_ref()?;
        let status = details
            .get("statusCode")
            .or(details.get("status"))
            .and_then(Value::as_u64)?;
        if ![400, 422].contains(&status)
            || maximum < 1.0
            || maximum.fract() != 0.0
            || maximum > 9_007_199_254_740_991.0
        {
            return None;
        }
        static PREFIX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static RANGE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let message = PREFIX
            .get_or_init(|| {
                regex::Regex::new(
                    r"(?i)^(?:[a-z][a-z0-9 ._-]{0,80} )?API error \((?:400|422)\):\s*",
                )
                .unwrap()
            })
            .replace(crate::js::trim_js(&error.message), "");
        let message = message
            .strip_prefix("Upstream request failed:")
            .map(crate::js::trim_start_js)
            .unwrap_or(&message);
        let message = message
            .strip_prefix("[invalid_request_error]")
            .map(crate::js::trim_start_js)
            .unwrap_or(message);
        let captures=RANGE.get_or_init(||regex::Regex::new(r#"(?i)^(['"`]?)max_(?:tokens|completion_tokens|output_tokens)(['"`]?)\s+must\s+be\s+between\s+1\s+and\s+(\d+)(?:\s+\(request_id:\s*[a-z0-9_-]+\))?\.?\s*$"#).unwrap()).captures(message)?;
        if captures.get(1)?.as_str() != captures.get(2)?.as_str() {
            return None;
        }
        let ceiling = captures.get(3)?.as_str().parse::<f64>().ok()?;
        if ceiling < 1.0 || ceiling >= maximum || ceiling > 9_007_199_254_740_991.0 {
            return None;
        }
        if request["thinking"]["type"] == "enabled"
            && ceiling <= request["thinking"]["budgetTokens"].as_f64().unwrap_or(0.0)
        {
            tracing::warn!(session_id=session,model=%request["model"],limit=ceiling,"Output limit correction cannot preserve the effective thinking budget; request was not replayed");
            return None;
        }
        self.corrected = true;
        self.limit = Some(ceiling);
        tracing::warn!(session_id=session,model=%request["model"],requested_max_tokens=maximum,max_tokens=ceiling,"Provider rejected the output allowance; retrying once with its explicit limit");
        Some(ceiling)
    }
}
struct Summary<'a> {
    provider: &'a Provider,
    budget: Mutex<TokenBudget>,
    allowance: Arc<Mutex<OutputAllowance>>,
    session: &'a LoopExecution,
}
#[async_trait]
impl SummaryProvider for Summary<'_> {
    async fn complete(&self, sent: &mut Value, cancel: &CancellationToken) -> Result<Value> {
        let limit = self.allowance.lock().unwrap().limit;
        let ceiling = sent["maxTokens"]
            .as_f64()
            .unwrap_or(0.0)
            .min(limit.unwrap_or(f64::INFINITY));
        let input = self.budget.lock().unwrap().estimate_request(sent);
        let thinking = if sent["thinking"]["type"] == "enabled" {
            sent["thinking"]["budgetTokens"].as_f64().unwrap_or(0.0)
        } else {
            0.0
        };
        let minimum = thinking + 1024.0_f64.min((ceiling - thinking).max(1.0));
        let available = self
            .budget
            .lock()
            .unwrap()
            .request_max_tokens(input, Some(ceiling));
        sent["maxTokens"] = json!(if available >= minimum {
            available
        } else {
            ceiling
        });
        let mut attempt = 0u32;
        loop {
            check_cancel(cancel)?;
            let mut request = sent.clone();
            request["messages"] = json!(crate::core::tool_context::history::project(
                sent["messages"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[])
            ));
            match self.provider.complete(request, cancel.clone()).await {
                Ok(response) => return Ok(response),
                Err(error) => {
                    if cancel.is_cancelled() {
                        return Err(error);
                    }
                    let details = error.details.as_ref().unwrap_or(&Value::Null);
                    if details["requestRejected"] == true {
                        if let Some(limit) = self.allowance.lock().unwrap().correct(
                            sent,
                            &error,
                            &self.session.session_id,
                        ) {
                            self.budget
                                .lock()
                                .unwrap()
                                .configure_output(sent["thinking"].clone(), Some(limit));
                            sent["maxTokens"] = json!(limit);
                            continue;
                        }
                    }
                    let status = details
                        .get("statusCode")
                        .or(details.get("status"))
                        .and_then(Value::as_u64);
                    let retryable = details["retryable"].as_bool().unwrap_or_else(|| {
                        status.is_some_and(|status| crate::retry::retryable_status(status as u16))
                    });
                    if !retryable || details["retriesExhausted"] == true || attempt >= 10 {
                        return Err(error);
                    }
                    let delay = crate::retry::delay_for_attempt(attempt);
                    attempt += 1;
                    tracing::warn!(attempt,status,reason=%error.message,"Summary request failed; retrying the same summary segment");
                    self.session.emit(json!({"type":"system","subtype":"api_retry","attempt":attempt,"max_retries":10,"retry_delay_ms":delay,"error_status":status,"error":"unknown","error_message":error.message,"session_id":self.session.session_id,"uuid":uuid::Uuid::new_v4().to_string()})).await?;
                    tokio::select! {_=cancel.cancelled()=>return Err(Error::cancelled()),_=tokio::time::sleep(std::time::Duration::from_secs_f64(delay/1000.0))=>{}}
                }
            }
        }
    }
}
struct Callbacks<'a> {
    session: &'a LoopExecution,
    options: &'a Value,
    model: &'a str,
    budget: TokenBudget,
    request: Value,
    injected: &'a [Value],
    history: &'a [Value],
    discovery: Option<Value>,
    harness: Arc<crate::harness::ResolvedHarness>,
}
#[async_trait]
impl CompactCallbacks for Callbacks<'_> {
    fn has_estimator(&self) -> bool {
        true
    }
    async fn estimate(&self, messages: &[Value]) -> Result<f64> {
        let mut request = self.request.clone();
        let combined: Vec<_> = self.injected.iter().chain(messages).cloned().collect();
        request["messages"] = json!(crate::core::tool_context::history::project(&combined));
        Ok(self.budget.estimate_request(&request))
    }
    async fn prepare_candidate(&self, candidate: CompactCandidate) -> Result<CompactCandidate> {
        if self.discovery.is_some() {
            let messages = crate::core::tool_context::checkpoint::prepare_with_harness(
                &candidate.messages,
                self.history,
                self.discovery.as_ref(),
                &self.harness,
            )?;
            Ok(CompactCandidate::created(messages))
        } else {
            Ok(candidate)
        }
    }
    async fn response(&self, response: &mut Value) -> Result<()> {
        self.session
            .charge_usage(
                &response["usage"],
                response["model"]
                    .as_str()
                    .filter(|model| !model.is_empty())
                    .unwrap_or(self.model),
            )
            .await?;
        let spent = self.session.budget_spent().await?;
        let maximum = crate::js::number(&self.options["maxBudgetUsd"]).unwrap_or(f64::INFINITY);
        if spent >= maximum {
            return Err(Error::template(
                "BUDGET_EXCEEDED",
                crate::harness::TextId::ContextExecutionBudget,
                &[
                    ("spent", crate::js::to_fixed(spent, 4).into()),
                    ("maximum", crate::js::to_fixed(maximum, 4).into()),
                ],
            ));
        }
        Ok(())
    }
}
pub enum CompactTrigger<'a> {
    Automatic { reactive: bool },
    Manual { instructions: Option<&'a str> },
}
impl CompactTrigger<'_> {
    fn name(&self) -> &'static str {
        match self { Self::Automatic { .. } => "auto", Self::Manual { .. } => "manual" }
    }
    fn instructions(&self) -> Option<&str> {
        match self { Self::Manual { instructions } => *instructions, _ => None }
    }
    fn reduce_target(&self) -> bool {
        matches!(self, Self::Manual { .. } | Self::Automatic { reactive: true })
    }
}

pub async fn compact_request(
    session: &Arc<LoopExecution>,
    options: &Value,
    provider: &Provider,
    messages: &mut Vec<Value>,
    budget: &mut crate::core::loop_budget::LoopBudget<'_>,
    request: &Value,
    injected: &[Value],
    attachments: &[Value],
    discovery: Option<Value>,
    allowance: Arc<Mutex<OutputAllowance>>,
    cancel: &CancellationToken,
    trigger: CompactTrigger<'_>,
) -> Result<CompactResult> {
    let harness = session
        .harness
        .for_model(request["model"].as_str().unwrap_or(""));
    let pre_tokens = budget.estimate_request(request);
    let window = budget.context_window();
    let output = budget.max_output_tokens();
    let mut summary_budget = TokenBudget::new(window, output);
    summary_budget.configure_output(request["thinking"].clone(), allowance.lock().unwrap().limit);
    let archive = session.owner.transcript_path(options, &session.session_id);
    let mut input = hooks::input(options, "PreCompact", &session.session_id);
    input["transcript_path"] = json!(archive);
    input["trigger"] = json!(trigger.name());
    input["custom_instructions"] = trigger.instructions().map(|value| json!(value)).unwrap_or(Value::Null);
    hooks::run_protocol(
        options,
        "PreCompact",
        input,
        None,
        None,
        session.as_ref(),
        cancel,
        false,
        None,
        &harness,
    )
    .await;
    check_cancel(cancel)?;
    let started = Instant::now();
    let mut envelope = request.clone();
    envelope["maxTokens"] = json!(maintenance_output_budget(window, &request["thinking"])
        .min(allowance.lock().unwrap().limit.unwrap_or(f64::INFINITY)));
    let compact_options = json!({"maxTokens":maintenance_output_budget(window,&Value::Null),"promptProfile":options["promptProfile"],"request":envelope,"injectedMessages":injected,"targetInputTokens":if trigger.reduce_target(){budget.target_input_tokens().min((pre_tokens/2.0).floor())}else{budget.target_input_tokens()},"maxInputTokens":budget.available_input_tokens()});
    let mut estimator = TokenBudget::new(window, output);
    estimator.configure_output(request["thinking"].clone(), allowance.lock().unwrap().limit);
    let summary_provider = Summary {
        provider,
        budget: Mutex::new(summary_budget),
        allowance,
        session,
    };
    let callbacks = Callbacks {
        session,
        options,
        model: request["model"].as_str().unwrap_or(""),
        budget: estimator,
        request: request.clone(),
        injected,
        history: messages,
        discovery,
        harness: harness.clone(),
    };
    let result = full_compact_with_harness(
        messages,
        &summary_provider,
        request["model"].as_str().unwrap_or(""),
        attachments,
        trigger.instructions(),
        Some(&archive),
        &compact_options,
        &callbacks,
        cancel,
        harness.clone(),
    )
    .await;
    session
        .api_time_ms
        .fetch_add(started.elapsed().as_millis() as u64, Ordering::Relaxed);
    let result = result?;
    if result.summary.is_empty() || result.tokens_freed <= 0.0 {
        return Err(compact_error_template(
            "no_progress",
            crate::harness::TextId::ContextCompactionUnsafeReduction,
            &[],
        ));
    }
    check_cancel(cancel)?;
    if let Err(error) = session
        .owner
        .compact(&result.messages, &result.summary)
        .await
    {
        if cancel.is_cancelled() {
            return Err(error);
        }
        return Err(Error::template(
            "COMPACT_CHECKPOINT",
            crate::harness::TextId::ContextCompactionCheckpointFailed,
            &[("error", error.as_harness_message())],
        ));
    }
    *messages = result.messages.clone();
    session.owner.history_replaced(messages).await?;
    budget.reset();
    session
        .owner
        .context_state(
            request["model"].as_str().unwrap_or(""),
            Some(budget.estimate_request(&json!({"messages":messages}))),
            None,
        )
        .await?;
    let mut input = hooks::input(options, "PostCompact", &session.session_id);
    input["transcript_path"] = json!(archive);
    input["trigger"] = json!(trigger.name());
    input["compact_summary"] = json!(result.summary);
    hooks::run_protocol(
        options,
        "PostCompact",
        input,
        None,
        None,
        session.as_ref(),
        cancel,
        false,
        None,
        &harness,
    )
    .await;
    tracing::info!(
        pre_tokens,
        tokens_freed = result.tokens_freed,
        "Context compacted"
    );
    session.emit(json!({"type":"system","subtype":"compact_boundary","summary":result.summary,"compact_metadata":{"trigger":trigger.name(),"pre_tokens":pre_tokens},"session_id":session.session_id,"uuid":uuid::Uuid::new_v4().to_string()})).await?;
    Ok(result)
}
