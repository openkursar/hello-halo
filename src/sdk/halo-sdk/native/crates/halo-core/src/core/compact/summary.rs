use super::{
    check_cancel, compact_error_template, is_context_exceeded,
    local::{self, KEEP_RECENT},
    summary_budget, CompactCallbacks, CompactCandidate, CompactResult, MessageOrigin, SummaryProvider,
};
use crate::{
    core::tokens::{estimate_message_tokens, estimate_tokens},
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    js::{stringify, to_string},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;
fn unchanged(snapshot: &[Value], messages: &[Value]) -> bool {
    messages.len() >= snapshot.len()
        && snapshot
            .iter()
            .zip(messages)
            .all(|(a, b)| Sha256::digest(stringify(a)) == Sha256::digest(stringify(b)))
}
async fn live_messages(original: &[Value], callbacks: &dyn CompactCallbacks) -> Result<Vec<Value>> {
    Ok(callbacks
        .snapshot()
        .await?
        .unwrap_or_else(|| original.to_vec()))
}
fn summary_text(
    response: &Value,
    max_tokens: f64,
    empty: TextId,
    harness: &ResolvedHarness,
) -> Result<String> {
    if response["stopReason"] == "max_tokens"
        || response["usage"]["output_tokens"].as_f64().unwrap_or(0.0) > max_tokens
    {
        return Err(compact_error_template(
            "truncated",
            TextId::ContextCompactionTruncated,
            &[],
        ));
    }
    let content = response["content"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if response["unreadableToolCall"].as_str().is_some_and(|detail| !detail.is_empty())
        || response["stopReason"] == "tool_use"
        || content.iter().any(|block| block["type"] == "tool_use")
    {
        return Err(compact_error_template(
            "tool_use",
            TextId::ContextCompactionToolUse,
            &[],
        ));
    }
    let text = local::format_summary_with_harness(
        &content
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        harness,
    );
    if text.is_empty() {
        return Err(compact_error_template("empty", empty, &[]));
    }
    if !response["usage"]["output_tokens"]
        .as_f64()
        .is_some_and(|tokens| tokens.is_finite() && tokens > 0.0)
        && estimate_tokens(&text) > max_tokens
    {
        return Err(compact_error_template(
            "truncated",
            TextId::ContextCompactionEstimatedTruncated,
            &[],
        ));
    }
    Ok(text)
}
fn summary_instruction(
    options: &Value,
    model: &str,
    scope: Option<&str>,
    instructions: Option<&str>,
    max_tokens: f64,
    harness: &ResolvedHarness,
) -> Result<String> {
    let mut config = json!({"maxTokens":max_tokens});
    if let Some(scope) = scope {
        config["scope"] = json!(scope);
    }
    if let Some(instructions) = instructions {
        config["instructions"] = json!(instructions);
    }
    crate::prompt::summary::for_model_with_harness(
        &config,
        model,
        &options["promptProfile"],
        harness,
    )
}
fn request_options(options: &Value) -> Value {
    let mut out = json!({});
    if let Some(effort) = options["reasoningEffort"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        out["reasoning_effort"] = json!(effort);
    }
    out
}
fn notice(
    text: &str,
    count: usize,
    tokens: Option<f64>,
    path: Option<&str>,
    harness: &ResolvedHarness,
) -> Value {
    let estimate = tokens
        .map(|tokens| {
            harness.render(
                TextId::ContextCompactionTokenEstimate,
                &[("tokens", &stringify(&json!(tokens)))],
            )
        })
        .unwrap_or_default();
    json!({"role":"user","content":harness.render(TextId::ContextCompactionNotice,&[("preamble",harness.text(TextId::ContextCompactionPreamble)),("count",&count.to_string()),("estimate",&estimate),("text",text),("reminder",&local::reminder_with_harness(path,harness))])})
}
async fn complete(
    provider: &dyn SummaryProvider,
    request: &mut Value,
    cancel: &CancellationToken,
) -> Result<Value> {
    tokio::select! {biased;response=provider.complete(request,cancel)=>response,_=cancel.cancelled()=>Err(Error::cancelled())}
}
struct Recovery<'a> {
    provider: &'a dyn SummaryProvider,
    callbacks: &'a dyn CompactCallbacks,
    cancel: &'a CancellationToken,
    options: &'a Value,
    model: &'a str,
    instructions: Option<&'a str>,
    calls: usize,
    last_request: Value,
    request: Value,
    prefix: Vec<Value>,
    prompt: String,
    envelope_max: Option<f64>,
    base_budget: f64,
    harness: Arc<ResolvedHarness>,
}
impl Recovery<'_> {
    async fn summarize(&mut self, mut sent: Value, ceiling: Option<f64>) -> Result<String> {
        check_cancel(self.cancel)?;
        self.calls += 1;
        if self.calls > 16 {
            return Err(compact_error_template(
                "capacity",
                TextId::ContextCompactionRequestLimit,
                &[],
            ));
        }
        let ceiling = ceiling
            .or(self.envelope_max)
            .unwrap_or_else(|| sent["maxTokens"].as_f64().unwrap_or(0.0));
        self.last_request = sent.clone();
        let response = complete(self.provider, &mut sent, self.cancel).await;
        self.last_request = sent.clone();
        let mut response = response?;
        self.callbacks.response(&mut response).await?;
        check_cancel(self.cancel)?;
        match summary_text(
            &response,
            sent["maxTokens"].as_f64().unwrap_or(0.0),
            TextId::ContextCompactionEmpty,
            &self.harness,
        ) {
            Ok(text) => Ok(text),
            Err(error) => {
                let reason = error
                    .details
                    .as_ref()
                    .and_then(|details| details["reason"].as_str())
                    .unwrap_or("");
                if !["empty", "truncated", "tool_use"].contains(&reason) {
                    return Err(error);
                }
                self.calls += 1;
                if self.calls > 16 {
                    return Err(error);
                }
                if reason == "truncated" {
                    sent["maxTokens"] = json!(ceiling.min(
                        (sent["maxTokens"].as_f64().unwrap_or(0.0) * 2.0).max(self.base_budget)
                    ));
                }
                let mut messages = sent["messages"].as_array().cloned().unwrap_or_default();
                let last = messages
                    .pop()
                    .and_then(|message| message.get("content").cloned())
                    .filter(|content| !content.is_null())
                    .map(|content| to_string(&content))
                    .unwrap_or_else(|| self.prompt.clone());
                messages.push(json!({"role":"user","content":self.harness.render(TextId::ContextCompactionRetryHandover,&[("prompt",&last)])}));
                sent["messages"] = json!(messages);
                self.last_request = sent.clone();
                let response = complete(self.provider, &mut sent, self.cancel).await;
                self.last_request = sent.clone();
                let mut response = response?;
                self.callbacks.response(&mut response).await?;
                check_cancel(self.cancel)?;
                summary_text(
                    &response,
                    sent["maxTokens"].as_f64().unwrap_or(0.0),
                    TextId::ContextCompactionEmpty,
                    &self.harness,
                )
            }
        }
    }
    async fn merge(&mut self, earlier: String, later: String) -> Result<String> {
        let mut handovers = vec![earlier, later];
        let request_max = self.request["maxTokens"].as_f64().unwrap();
        let mut limit = request_max;
        let thinking = if self.request["thinking"]["type"] == "enabled" {
            self.request["thinking"]["budgetTokens"]
                .as_f64()
                .unwrap_or(0.0)
                .min(request_max - 1.0)
        } else {
            0.0
        };
        let minimum = thinking + 1024.0_f64.min(request_max - thinking);
        loop {
            let mut candidate = self.request.clone();
            candidate["maxTokens"] = json!(limit);
            let mut messages = self.prefix.clone();
            messages.extend([json!({"role":"user","content":self.harness.render(TextId::ContextCompactionEarlierHandover,&[("text",&handovers[0])])}),json!({"role":"user","content":self.harness.render(TextId::ContextCompactionLaterHandover,&[("text",&handovers[1])])}),json!({"role":"user","content":self.harness.render(TextId::ContextCompactionMerge,&[("prompt",&self.prompt)])})]);
            candidate["messages"] = json!(messages);
            match self.summarize(candidate, Some(limit)).await {
                Ok(text) => return Ok(text),
                Err(error) => {
                    if !is_context_exceeded(&error) || self.cancel.is_cancelled() {
                        return Err(error);
                    }
                    let reduced = minimum.max(thinking + ((limit - thinking) / 2.0).floor());
                    if reduced < limit {
                        limit = reduced;
                        continue;
                    }
                    let mut shortened = Vec::new();
                    for text in &handovers {
                        let instructions = summary_instruction(
                            self.options,
                            self.model,
                            None,
                            self.instructions,
                            (estimate_tokens(text) / 2.0).floor().max(1.0),
                            &self.harness,
                        )?;
                        let mut candidate = self.request.clone();
                        candidate["maxTokens"] = json!(limit);
                        let mut messages = self.prefix.clone();
                        messages.extend([json!({"role":"user","content":self.harness.render(TextId::ContextCompactionRecordHandover,&[("text",text)])}),json!({"role":"user","content":self.harness.render(TextId::ContextCompactionShorten,&[("prompt",&instructions)])})]);
                        candidate["messages"] = json!(messages);
                        let result = self.summarize(candidate, Some(limit)).await?;
                        if estimate_tokens(&result) >= estimate_tokens(text) {
                            return Err(compact_error_template(
                                "no_progress",
                                TextId::ContextCompactionMergeNoProgress,
                                &[],
                            ));
                        }
                        shortened.push(result);
                    }
                    handovers = shortened;
                }
            }
        }
    }
    fn records<'a>(
        &'a mut self,
        records: Vec<Value>,
    ) -> Pin<Box<dyn Future<Output = Result<String>> + Send + 'a>> {
        Box::pin(async move {
            let mut sent = self.request.clone();
            let mut messages = self.prefix.clone();
            messages.extend(records.clone());
            messages.push(json!({"role":"user","content":self.harness.render(TextId::ContextCompactionOrderedRecords,&[("prompt",&self.prompt)])}));
            sent["messages"] = json!(messages);
            match self.summarize(sent, None).await {
                Ok(text) => Ok(text),
                Err(error) => {
                    if !is_context_exceeded(&error) || self.cancel.is_cancelled() {
                        return Err(error);
                    }
                    let mut pending = HashSet::new();
                    let mut boundary = 0;
                    for (index, message) in records
                        .iter()
                        .take(records.len().saturating_sub(1))
                        .enumerate()
                    {
                        for block in message["content"].as_array().into_iter().flatten() {
                            if message["role"] == "assistant" && block["type"] == "tool_use" {
                                pending.insert(block["id"].as_str().unwrap_or("").to_owned());
                            }
                            if message["role"] == "user" && block["type"] == "tool_result" {
                                pending.remove(block["tool_use_id"].as_str().unwrap_or(""));
                            }
                        }
                        if pending.is_empty()
                            && (boundary == 0
                                || ((index + 1) as f64 - records.len() as f64 / 2.0).abs()
                                    < (boundary as f64 - records.len() as f64 / 2.0).abs())
                        {
                            boundary = index + 1;
                        }
                    }
                    if boundary == 0 || boundary >= records.len() {
                        return Err(compact_error_template(
                            "capacity",
                            TextId::ContextCompactionIndivisibleCapacity,
                            &[],
                        ));
                    }
                    let earlier = self.records(records[..boundary].to_vec()).await?;
                    let later = self.records(records[boundary..].to_vec()).await?;
                    self.merge(earlier, later).await
                }
            }
        })
    }
}
async fn candidate(
    original: &[Value],
    snapshot: &[Value],
    summary: Value,
    attachments: &[Value],
    retained_request: Option<usize>,
    tail_start: usize,
    callbacks: &dyn CompactCallbacks,
) -> Result<(CompactCandidate, Vec<Value>)> {
    let current = live_messages(original, callbacks).await?;
    if !unchanged(snapshot, &current) {
        return Err(compact_error_template(
            "history_changed",
            TextId::ContextCompactionHistoryChanged,
            &[],
        ));
    }
    let mut output = CompactCandidate::created(vec![summary]);
    output.extend_attachments(attachments);
    if let Some(index) = retained_request {
        output.push(current[index].clone(), Some(MessageOrigin::History { index }));
    }
    output.extend_history(&current[tail_start..snapshot.len()], tail_start);
    output.extend_history(&current[snapshot.len()..], snapshot.len());
    let prepared = callbacks.prepare_candidate(output).await?;
    Ok((prepared, live_messages(original, callbacks).await?))
}
async fn shrinks(
    candidate: &CompactCandidate,
    current: &[Value],
    targeted: bool,
    callbacks: &dyn CompactCallbacks,
) -> Result<bool> {
    let mut source = CompactCandidate::history(current);
    source.reference = Some("history".into());
    Ok(
        estimate_message_tokens(&candidate.messages) < estimate_message_tokens(current)
            && (!targeted
                || callbacks.estimate_candidate(candidate).await?
                    < callbacks.estimate_candidate(&source).await?),
    )
}

pub async fn full_compact(
    messages: &[Value],
    provider: &dyn SummaryProvider,
    model: &str,
    attachments: &[Value],
    instructions: Option<&str>,
    path: Option<&str>,
    options: &Value,
    callbacks: &dyn CompactCallbacks,
    cancel: &CancellationToken,
) -> Result<CompactResult> {
    let harness = crate::harness::Harness::from_config(&options["harnessText"])?.for_model(model);
    full_compact_with_harness(
        messages,
        provider,
        model,
        attachments,
        instructions,
        path,
        options,
        callbacks,
        cancel,
        harness,
    )
    .await
}
pub async fn full_compact_with_harness(
    messages: &[Value],
    provider: &dyn SummaryProvider,
    model: &str,
    attachments: &[Value],
    instructions: Option<&str>,
    path: Option<&str>,
    options: &Value,
    callbacks: &dyn CompactCallbacks,
    cancel: &CancellationToken,
    harness: Arc<ResolvedHarness>,
) -> Result<CompactResult> {
    check_cancel(cancel)?;
    let total = messages.len();
    let targeted = options.get("targetInputTokens").is_some() && callbacks.has_estimator();
    if total < 2 || (!targeted && total <= KEEP_RECENT + 1) {
        return Ok(CompactResult {
            messages: messages.to_vec(),
            origins: CompactCandidate::history(messages).origins,
            array_reference: None,
            summary: String::new(),
            tokens_freed: 0.0,
        });
    }
    let snapshot = messages.to_vec();
    let latest = snapshot.iter().rposition(|message| {
        message["role"] == "user"
            && message["isMeta"] != true
            && (message["content"].is_string()
                || !message["content"].as_array().is_some_and(|blocks| {
                    blocks.iter().any(|block| block["type"] == "tool_result")
                }))
    });
    let mut max_tokens = summary_budget(options)?;
    let mut keep_from = total.saturating_sub(KEEP_RECENT);
    if targeted {
        let mut fixed = CompactCandidate::created(vec![notice(
            "",
            total,
            Some(estimate_message_tokens(&snapshot)),
            path,
            &harness,
        )]);
        fixed.extend_attachments(attachments);
        if let Some(index) = latest {
            fixed.push(snapshot[index].clone(), Some(MessageOrigin::History { index }));
        }
        let fixed = callbacks
            .estimate_candidate(&callbacks.prepare_candidate(fixed).await?)
            .await?;
        let capacity = options["maxInputTokens"].as_f64().unwrap_or(f64::INFINITY);
        if fixed >= capacity {
            return Err(compact_error_template(
                "capacity",
                TextId::ContextCompactionFixedCapacity,
                &[],
            ));
        }
        let remaining = capacity - fixed;
        let target = options["targetInputTokens"].as_f64().unwrap_or(f64::NAN);
        let preferred = if target > fixed {
            target - fixed
        } else {
            remaining.min(max_tokens * 3.0)
        };
        let space = preferred.min(remaining).max(0.0);
        max_tokens = max_tokens.min(
            (remaining / 2.0)
                .min(1024.0_f64.max(space / 3.0))
                .floor()
                .max(1.0),
        );
        let tail_budget = space / 3.0;
        let mut tail_tokens = 0.0;
        keep_from = total;
        for index in (1..total).rev() {
            let size = estimate_message_tokens(std::slice::from_ref(&snapshot[index]));
            if tail_tokens + size > tail_budget {
                break;
            }
            tail_tokens += size;
            keep_from = index;
        }
    }
    let split = local::adjust_pairing(&snapshot, keep_from).min(local::unfinished_tail(&snapshot));
    if split == 0 {
        return Ok(CompactResult {
            messages: messages.to_vec(),
            origins: CompactCandidate::history(messages).origins,
            array_reference: None,
            summary: String::new(),
            tokens_freed: 0.0,
        });
    }
    let head = &snapshot[..split];
    let tail = &snapshot[split..];
    let retained_request = latest.filter(|index| *index < split);
    let original_tokens = estimate_message_tokens(head);
    let prompt = summary_instruction(options, model, None, instructions, max_tokens, &harness)?;
    let envelope = options.get("request").filter(|request| request.is_object());
    let instruction = if envelope.is_some() {
        harness.render(
            TextId::ContextCompactionRetainedTail,
            &[("prompt", &prompt), ("count", &tail.len().to_string())],
        )
    } else {
        harness.render(
            TextId::ContextCompactionTranscriptRequest,
            &[
                ("prompt", &prompt),
                ("count", &head.len().to_string()),
                ("tokens", &stringify(&json!(original_tokens))),
                (
                    "transcript",
                    &local::transcript_with_harness(head, &harness),
                ),
            ],
        )
    };
    let mut request = if let Some(envelope) = envelope {
        let mut request = envelope.clone();
        let mut messages = request["messages"].as_array().cloned().unwrap_or_default();
        messages.push(json!({"role":"user","content":instruction}));
        request["messages"] = json!(messages);
        request["maxTokens"] = json!(max_tokens);
        if !request["providerOptions"].is_object() {
            request["providerOptions"] = json!({});
        }
        request["providerOptions"]["skipCacheWrite"] = json!(true);
        request["stream"] = json!(false);
        request
    } else {
        let mut request = json!({"model":model,"messages":[{"role":"user","content":instruction}],"systemPrompt":crate::prompt::summary::system_prompt(&harness),"tools":[],"maxTokens":max_tokens,"providerOptions":request_options(options),"stream":false});
        if let Some(thinking) = options.get("thinking") {
            request["thinking"] = thinking.clone();
        }
        request
    };
    if request["thinking"]["type"] == "adaptive" {
        request["maxTokens"] = json!(summary_budget(options)?);
    }
    if request["thinking"]["type"] == "enabled" {
        request["maxTokens"] = json!(envelope
            .and_then(|envelope| envelope["maxTokens"].as_f64())
            .unwrap_or(summary_budget(options)?)
            .min(max_tokens + request["thinking"]["budgetTokens"].as_f64().unwrap_or(0.0)));
    }
    let prefix_length = envelope
        .map(|envelope| {
            envelope["messages"].as_array().map(Vec::len).unwrap_or(0) as isize
                - snapshot.len() as isize
        })
        .unwrap_or(0);
    let prefix = options["injectedMessages"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            envelope
                .and_then(|envelope| envelope["messages"].as_array())
                .map(|messages| {
                    messages
                        .iter()
                        .take(prefix_length.max(0) as usize)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        });
    let mut recovery = Recovery {
        provider,
        callbacks,
        cancel,
        options,
        model,
        instructions,
        calls: 0,
        last_request: request.clone(),
        request: request.clone(),
        prefix,
        prompt,
        envelope_max: envelope.and_then(|envelope| envelope["maxTokens"].as_f64()),
        base_budget: summary_budget(options)?,
        harness: harness.clone(),
    };
    let mut summary = match recovery.summarize(request, None).await {
        Ok(summary) => summary,
        Err(error) => {
            if envelope.is_none()
                || prefix_length < 0
                || cancel.is_cancelled()
                || !is_context_exceeded(&error)
            {
                return Err(error);
            }
            tracing::warn!(head_messages=head.len(),retained_messages=tail.len(),"Summary input exceeded the provider window; summarizing ordered records without dropping evidence");
            recovery.records(head.to_vec()).await?
        }
    };
    let (mut new_messages, mut current) = candidate(
        messages,
        &snapshot,
        notice(&summary, head.len(), Some(original_tokens), path, &harness),
        attachments,
        retained_request,
        split,
        callbacks,
    )
    .await?;
    if targeted && !shrinks(&new_messages, &current, targeted, callbacks).await? {
        let mut request = recovery.last_request.clone();
        let max = request["maxTokens"].as_f64().unwrap();
        let mut sent = request["messages"].as_array().cloned().unwrap_or_default();
        let last = sent
            .pop()
            .and_then(|message| message.get("content").cloned())
            .filter(|value| !value.is_null())
            .map(|content| to_string(&content))
            .unwrap_or_else(|| recovery.prompt.clone());
        sent.push(json!({"role":"user","content":harness.render(TextId::ContextCompactionReduceRetry,&[("prompt",&last)])}));
        request["messages"] = json!(sent);
        summary = recovery.summarize(request, Some(max)).await?;
        (new_messages, current) = candidate(
            messages,
            &snapshot,
            notice(&summary, head.len(), Some(original_tokens), path, &harness),
            attachments,
            retained_request,
            split,
            callbacks,
        )
        .await?;
    }
    let tokens_freed =
        (estimate_message_tokens(&current) - estimate_message_tokens(&new_messages.messages)).max(0.0);
    if targeted && !shrinks(&new_messages, &current, targeted, callbacks).await? {
        return Err(compact_error_template(
            "no_progress",
            TextId::ContextCompactionNoProgress,
            &[],
        ));
    }
    if let Some(max) = options["maxInputTokens"].as_f64() {
        if callbacks.has_estimator() && callbacks.estimate_candidate(&new_messages).await? >= max {
            return Err(compact_error_template(
                "capacity",
                TextId::ContextCompactionFinalCapacity,
                &[],
            ));
        }
    }
    Ok(CompactResult {
        messages: new_messages.messages,
        origins: new_messages.origins,
        array_reference: new_messages.reference,
        summary,
        tokens_freed,
    })
}

pub async fn partial_compact(
    messages: &[Value],
    provider: &dyn SummaryProvider,
    model: &str,
    options: &Value,
    callbacks: &dyn CompactCallbacks,
    cancel: &CancellationToken,
) -> Result<CompactResult> {
    let harness = crate::harness::Harness::from_config(&options["harnessText"])?.for_model(model);
    partial_compact_with_harness(
        messages, provider, model, options, callbacks, cancel, harness,
    )
    .await
}
pub async fn partial_compact_with_harness(
    messages: &[Value],
    provider: &dyn SummaryProvider,
    model: &str,
    options: &Value,
    callbacks: &dyn CompactCallbacks,
    cancel: &CancellationToken,
    harness: Arc<ResolvedHarness>,
) -> Result<CompactResult> {
    check_cancel(cancel)?;
    let pivot = options["pivotIndex"].as_f64().unwrap_or(f64::NAN);
    if !pivot.is_finite() || pivot.fract() != 0.0 || pivot < 0.0 || pivot > messages.len() as f64 {
        return Err(Error::template(
            "INVALID_ARGUMENT",
            TextId::ContextCompactionInvalidBoundary,
            &[],
        )
        .with_details(json!({"name":"RangeError"})));
    }
    let snapshot = messages.to_vec();
    let max_tokens = summary_budget(options)?;
    let tail_start = local::unfinished_tail(&snapshot);
    let boundary = local::adjust_pairing(&snapshot, pivot as usize);
    let direction = options["direction"].as_str().unwrap_or("from");
    let end = if direction == "up_to" {
        boundary.min(tail_start)
    } else {
        tail_start
    };
    let selected = if direction == "up_to" {
        &snapshot[..end]
    } else if boundary <= end {
        &snapshot[boundary..end]
    } else {
        &[]
    };
    if selected.is_empty() {
        return Err(Error::template(
            "COMPACT_ERROR",
            TextId::ContextCompactionEmptySlice,
            &[
                ("direction", direction.into()),
                ("boundary", boundary.to_string().into()),
            ],
        ));
    }
    let instructions = options["userFeedback"]
        .as_str()
        .filter(|feedback| !feedback.is_empty())
        .map(|feedback| {
            harness.render(
                TextId::ContextCompactionUserContext,
                &[("feedback", feedback)],
            )
        });
    let prompt = summary_instruction(
        options,
        model,
        Some(if direction == "up_to" {
            "prefix"
        } else {
            "suffix"
        }),
        instructions.as_deref(),
        max_tokens,
        &harness,
    )?;
    let user = harness.render(
        TextId::ContextCompactionPartialRequest,
        &[
            ("prompt", &prompt),
            ("count", &selected.len().to_string()),
            (
                "transcript",
                &local::transcript_with_harness(selected, &harness),
            ),
        ],
    );
    let mut request = json!({"model":model,"messages":[{"role":"user","content":user}],"systemPrompt":crate::prompt::summary::system_prompt(&harness),"tools":[],"maxTokens":max_tokens,"providerOptions":request_options(options),"stream":false});
    if let Some(thinking) = options.get("thinking") {
        request["thinking"] = thinking.clone();
    }
    let response = complete(provider, &mut request, cancel).await?;
    check_cancel(cancel)?;
    let summary = summary_text(
        &response,
        max_tokens,
        TextId::ContextCompactionPartialEmpty,
        &harness,
    )?;
    let current = live_messages(messages, callbacks).await?;
    if !unchanged(&snapshot, &current) {
        return Err(compact_error_template(
            "history_changed",
            TextId::ContextCompactionHistoryChanged,
            &[],
        ));
    }
    let message = notice(
        &summary,
        selected.len(),
        None,
        options["transcriptPath"].as_str(),
        &harness,
    );
    let attachments = options["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut candidate = CompactCandidate::created(Vec::new());
    if direction != "up_to" {
        candidate.extend_history(&current[..boundary], 0);
    }
    candidate.push(message, None);
    candidate.extend_attachments(&attachments);
    candidate.extend_history(&current[end..snapshot.len()], end);
    candidate.extend_history(&current[snapshot.len()..], snapshot.len());
    let new_messages = callbacks.prepare_candidate(candidate).await?;
    let current = live_messages(messages, callbacks).await?;
    let tokens_freed =
        (estimate_message_tokens(&current) - estimate_message_tokens(&new_messages.messages)).max(0.0);
    Ok(CompactResult {
        messages: new_messages.messages,
        origins: new_messages.origins,
        array_reference: new_messages.reference,
        summary,
        tokens_freed,
    })
}
