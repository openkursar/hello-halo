use super::anthropic_request::{build_body, build_headers};
use super::transport::AttemptClient;
use crate::{
    bridge::HostBridge,
    error::{Error, Result},
    js::{stringify, truthy},
};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AnthropicProvider {
    config: Value,
    bridge: Arc<dyn HostBridge>,
    http: AttemptClient,
}

pub fn resolve_model(request:&Value,config:&Value)->Result<String>{
    request["model"].as_str().filter(|value|!value.is_empty()).or(config["defaultModel"].as_str()).filter(|value|!value.is_empty()).map(str::to_owned)
        .ok_or_else(||Error::new("MISSING_MODEL","No model specified: set ProviderRequest.model or AnthropicProviderConfig.defaultModel."))
}

impl AnthropicProvider {
    pub fn new(config: Value, bridge: Arc<dyn HostBridge>, client: reqwest::Client) -> Self {
        Self::with_http(config, bridge, AttemptClient::supplied(client))
    }
    pub fn with_http(config: Value, bridge: Arc<dyn HostBridge>, http: AttemptClient) -> Self {
        Self {
            config,
            bridge,
            http,
        }
    }
    pub fn resolve_model(&self, request: &Value) -> Result<String> {
        resolve_model(request,&self.config)
    }
    pub async fn list_models(&self, cancellation: &CancellationToken) -> Result<Value> {
        if !truthy(&self.config["apiKey"]) {
            return Ok(json!([]));
        }
        let outcome = async {
            let mut headers = build_headers(&self.config, &json!({}), false, 0, self.bridge.as_ref(), cancellation).await?;
            headers.as_object_mut().unwrap().remove("content-type");
            let client = self.http.client(cancellation).await?;
            let mut request = client.get(format!("{}/v1/models?limit=100", self.config["baseUrl"].as_str().unwrap_or("https://api.anthropic.com").trim_end_matches('/')));
            for (key, value) in headers.as_object().into_iter().flatten() { if let Some(value)=value.as_str() { request=request.header(key,value); } }
            let response = tokio::select! { _=cancellation.cancelled()=>return Err(Error::cancelled()), response=request.send()=>response.map_err(|error|Error::new("PROVIDER_ERROR",error.without_url().to_string()))? };
            if !response.status().is_success() { tracing::warn!(status=response.status().as_u16(), "Provider model list request failed"); return Ok(json!([])); }
            let value:Value=tokio::select! { _=cancellation.cancelled()=>return Err(Error::cancelled()), value=response.json()=>value.map_err(|error|Error::new("PROVIDER_ERROR",error.without_url().to_string()))? };
            Ok(json!(value["data"].as_array().into_iter().flatten().filter(|model|model["id"].is_string()).map(|model|json!({"id":model["id"],"providerId":"anthropic","name":model.get("display_name").filter(|value|!value.is_null()).unwrap_or(&model["id"]),"contextWindow":200000,"maxOutputTokens":16384})).collect::<Vec<_>>()))
        }.await;
        match outcome {
            Ok(value) => Ok(value),
            Err(error) if cancellation.is_cancelled() => Err(error),
            Err(error) => {
                tracing::warn!(
                    code = error.code,
                    message = error.message,
                    "Provider model list unavailable"
                );
                Ok(json!([]))
            }
        }
    }
    pub fn health_check(&self) -> Value {
        if truthy(&self.config["apiKey"]) {
            json!({"status":"healthy"})
        } else {
            json!({"status":"unavailable","reason":"No API key configured"})
        }
    }

    pub async fn stream(
        &self,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<AnthropicStream> {
        let mut body =
            build_body(&request, &self.config, self.bridge.as_ref(), &cancellation).await?;
        body["stream"] = json!(true);
        Ok(AnthropicStream {
            provider: self.clone(),
            request,
            cancellation,
            response: None,
            decoder: Default::default(),
            events: VecDeque::new(),
            done: false,
            attempt: 0,
            consecutive_overloads: 0,
            streaming_failures: 0,
            response_started: false,
            delay_ms: None,
            body,
            non_streaming_body: None,
        })
    }
}

pub struct AnthropicStream {
    provider: AnthropicProvider,
    request: Value,
    cancellation: CancellationToken,
    response: Option<reqwest::Response>,
    decoder: super::sse::Decoder,
    events: VecDeque<Value>,
    done: bool,
    attempt: u32,
    consecutive_overloads: u32,
    streaming_failures: u32,
    response_started: bool,
    delay_ms: Option<f64>,
    body: Value,
    non_streaming_body: Option<Value>,
}

impl AnthropicStream {
    pub async fn next(&mut self) -> Result<Option<Value>> {
        if self.done {
            return Ok(None);
        }
        if self.cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        loop {
            if let Some(event) = self.events.pop_front() {
                if event["type"] == "message_stop" {
                    self.done = true;
                }
                return Ok(Some(event));
            }
            if let Some(delay) = self.delay_ms.take() {
                tokio::select! {
                    _ = self.cancellation.cancelled() => return Err(Error::cancelled()),
                    _ = tokio::time::sleep(Duration::from_secs_f64(delay / 1000.0)) => {}
                }
            }
            if self.response.is_none() {
                if let Err(error) = self.open().await {
                    self.retry(error, None)?;
                    continue;
                }
                if !self.events.is_empty() {
                    continue;
                }
            }
            let result = self.read_event().await;
            match result {
                Ok(Some(raw)) => {
                    if let Some(event) = map_event(&raw) {
                        if event["type"] == "error" {
                            self.retry(stream_error(&event), None)?;
                            continue;
                        }
                        self.response_started = true;
                        if event["type"] == "message_stop" {
                            self.done = true;
                            self.response.take();
                        }
                        return Ok(Some(event));
                    }
                }
                Ok(None) => {
                    self.streaming_failures += 1;
                    self.retry(
                        provider_template(
                            crate::harness::TextId::ProvidersStreamMissingAnthropicEnd,
                            &[],
                            None,
                            true,
                            false,
                        ),
                        None,
                    )?;
                }
                Err(error) => {
                    if self.cancellation.is_cancelled() {
                        return Err(Error::cancelled());
                    }
                    self.streaming_failures += 1;
                    self.retry(error, None)?;
                }
            }
        }
    }

    async fn open(&mut self) -> Result<()> {
        let config = &self.provider.config;
        let url = format!(
            "{}/v1/messages{}",
            config["baseUrl"]
                .as_str()
                .unwrap_or("https://api.anthropic.com")
                .trim_end_matches('/'),
            if truthy(&config["requestIdentity"]["betaQueryParam"]) {
                "?beta=true"
            } else {
                ""
            }
        );
        let headers = build_headers(
            config,
            &self.request["providerOptions"],
            self.request["thinking"]["type"] == "enabled",
            self.attempt,
            self.provider.bridge.as_ref(),
            &self.cancellation,
        )
        .await?;
        let streaming = self.streaming_failures < 1;
        let mut body = if streaming {
            self.body.clone()
        } else if let Some(body) = &self.non_streaming_body {
            body.clone()
        } else {
            let mut body = build_body(
                &self.request,
                config,
                self.provider.bridge.as_ref(),
                &self.cancellation,
            )
            .await?;
            body["max_tokens"] = json!(body["max_tokens"].as_f64().unwrap_or(16384.0).min(64000.0));
            if body["thinking"]["type"] == "enabled"
                && body["thinking"]["budget_tokens"].as_f64().unwrap_or(0.0)
                    >= body["max_tokens"].as_f64().unwrap()
            {
                body["thinking"]["budget_tokens"] =
                    json!(body["max_tokens"].as_f64().unwrap() - 1.0);
            }
            self.non_streaming_body = Some(body.clone());
            body
        };
        body["stream"] = json!(streaming);
        let client = self.provider.http.client(&self.cancellation).await?;
        let mut request = client.post(url).body(super::transport::serialize_model_request(&body));
        for (key, value) in headers.as_object().into_iter().flatten() {
            if let Some(value) = value.as_str() {
                request = request.header(key, value);
            }
        }
        let response = tokio::select! {
            _ = self.cancellation.cancelled() => return Err(Error::cancelled()),
            response = request.send() => response.map_err(|error| provider_error(&error.without_url().to_string(), None, true, false))?,
        };
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let delay = retry_delay(response.headers(), status, self.attempt);
            let body = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(Error::cancelled()),
                body = response.text() => body.unwrap_or_else(|error| { tracing::warn!(status, error=%error.without_url(), "HTTP error body unavailable"); String::new() }),
            };
            let reason = api_error_message(&body);
            let mut error = if let Some(reason) = &reason {
                provider_template(
                    crate::harness::TextId::ProvidersHttpError,
                    &[
                        ("provider", "Anthropic".into()),
                        ("status", status.to_string().into()),
                        ("reason", reason.clone().into()),
                    ],
                    Some(status),
                    delay.is_some(),
                    !self.response_started,
                )
            } else {
                provider_template(
                    crate::harness::TextId::ProvidersHttpErrorWithoutBody,
                    &[
                        ("provider", "Anthropic".into()),
                        ("status", status.to_string().into()),
                    ],
                    Some(status),
                    delay.is_some(),
                    !self.response_started,
                )
            };
            let message = error.message.clone();
            error.details.as_mut().unwrap()["retryDelayMs"] = json!(delay);
            error.details.as_mut().unwrap()["retryReason"] =
                json!(reason.unwrap_or_else(|| message.clone()));
            return Err(error);
        }
        if streaming {
            self.response = Some(response);
        } else {
            self.response_started = true;
            let complete: Value = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(Error::cancelled()),
                response = response.json() => response.map_err(|error| provider_error(&error.without_url().to_string(), None, true, false))?,
            };
            if truthy(&complete["error"]) {
                return Err(stream_error(
                    &json!({"errorType":complete["error"]["type"],"message":complete["error"]["message"]}),
                ));
            }
            if !truthy(&complete["stop_reason"]) || !complete["content"].is_array() {
                return Err(provider_template(
                    crate::harness::TextId::ProvidersStreamIncompleteResponse,
                    &[],
                    None,
                    true,
                    false,
                ));
            }
            let mut request = self.request.clone();
            request["model"] = json!(self.provider.resolve_model(&request)?);
            self.events
                .extend(non_streaming_events(&complete, &request));
        }
        Ok(())
    }

    fn retry(&mut self, mut error: Error, delay: Option<f64>) -> Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let details = error.details.as_ref().cloned().unwrap_or(Value::Null);
        if details["retryable"] != true {
            return Err(error);
        }
        let status = details["statusCode"].as_u64();
        if status == Some(529) {
            if self.request["providerOptions"]["querySource"] == "background" {
                error.details.as_mut().unwrap()["retriesExhausted"] = json!(true);
                return Err(error);
            }
            if self.consecutive_overloads >= 3
                && self.request["providerOptions"]["fallbackModelAvailable"] == true
            {
                let mut fallback = provider_template(
                    crate::harness::TextId::ProvidersHttpOverloaded,
                    &[("retries", self.consecutive_overloads.to_string().into())],
                    Some(529),
                    true,
                    false,
                );
                fallback.details.as_mut().unwrap()["name"] = json!("ModelFallbackError");
                fallback.details.as_mut().unwrap()["retriesExhausted"] = json!(true);
                return Err(fallback);
            }
            self.consecutive_overloads += 1;
        } else {
            self.consecutive_overloads = 0;
        }
        if self.attempt >= 10 {
            error.details.as_mut().unwrap()["retriesExhausted"] = json!(true);
            return Err(error);
        }
        let delay = delay
            .or(details["retryDelayMs"].as_f64())
            .unwrap_or_else(|| backoff(self.attempt));
        self.attempt += 1;
        self.response.take();
        self.decoder = Default::default();
        self.delay_ms = Some(delay);
        tracing::warn!(
            attempt = self.attempt,
            status,
            delay_ms = delay,
            "Provider request failed; retrying"
        );
        self.events.push_back(json!({"type":"retry","attempt":self.attempt,"maxRetries":10,"delayMs":delay,"status":status,"message":details["retryReason"].as_str().unwrap_or(&error.message)}));
        Ok(())
    }

    async fn read_event(&mut self) -> Result<Option<Value>> {
        loop {
            match self.decoder.next().map_err(|id| provider_template(id, &[], None, true, false))? {
                Some(super::sse::Record::Data(value)) => return Ok(Some(value)),
                Some(super::sse::Record::Done) => return Ok(None),
                None if self.decoder.ended() => return Ok(None),
                None => {}
            }
            let response = self.response.as_mut().ok_or_else(|| {
                provider_template(
                    crate::harness::TextId::ProvidersStreamUnreadableBody,
                    &[],
                    None,
                    true,
                    false,
                )
            })?;
            let chunk = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(Error::cancelled()),
                chunk = response.chunk() => chunk.map_err(|error| provider_error(&error.without_url().to_string(), None, true, false))?,
            };
            match chunk {
                Some(bytes) => self.decoder.push(&bytes).map_err(|id| provider_template(id, &[], None, true, false))?,
                None => self.decoder.finish(),
            }
        }
    }

    pub async fn close(&mut self) -> Result<()> {
        self.response.take();
        self.decoder = Default::default();
        self.done = true;
        Ok(())
    }
}

fn provider_template(
    id: crate::harness::TextId,
    values: &[(&str, crate::harness::Message)],
    status: Option<u16>,
    retryable: bool,
    rejected: bool,
) -> Error {
    provider_error("", status, retryable, rejected).with_harness(id, values)
}
fn provider_error(message: &str, status: Option<u16>, retryable: bool, rejected: bool) -> Error {
    let mut details = json!({"name":"ProviderError","provider":"Anthropic","retryable":retryable,"requestRejected":rejected,"retriesExhausted":false});
    if let Some(status) = status {
        details["statusCode"] = json!(status);
    }
    Error::new("PROVIDER_ERROR", message).with_details(details)
}

fn stream_error(event: &Value) -> Error {
    let status = match event["errorType"].as_str().unwrap_or("") {
        "overloaded_error" => Some(529),
        "rate_limit_error" => Some(429),
        "api_error" | "server_error" => Some(500),
        "authentication_error" => Some(401),
        "permission_error" => Some(403),
        "invalid_request_error" => Some(400),
        "not_found_error" => Some(404),
        _ => None,
    };
    if let Some(message) = event["message"].as_str() {
        let mut error =
            provider_error(message, status, status.is_some_and(retryable_status), false);
        if let Some(message) = event
            .get("harness")
            .and_then(|value| serde_json::from_value::<crate::harness::Message>(value.clone()).ok())
            .filter(crate::harness::Message::is_valid)
        {
            error.harness = Some(message);
        }
        error
    } else {
        provider_template(
            crate::harness::TextId::ProvidersStreamUnknownApiError,
            &[],
            status,
            status.is_some_and(retryable_status),
            false,
        )
    }
}

fn retryable_status(status: u16) -> bool {
    crate::retry::retryable_status(status)
}
fn backoff(attempt: u32) -> f64 {
    crate::retry::delay_for_attempt(attempt)
}
fn retry_delay(headers: &reqwest::header::HeaderMap, status: u16, attempt: u32) -> Option<f64> {
    crate::retry::http_retry_delay(
        attempt,
        status,
        headers
            .get("x-should-retry")
            .and_then(|value| value.to_str().ok()),
        headers
            .get("retry-after")
            .and_then(|value| value.to_str().ok()),
        chrono::Utc::now().timestamp_millis(),
    )
}

fn api_error_message(body: &str) -> Option<String> {
    match serde_json::from_str::<Value>(body) {
        Ok(value) => [
            &value["error"]["message"],
            &value["error"]["error"]["message"],
            &value["message"],
            &value["detail"],
        ]
        .into_iter()
        .find(|value| !value.is_null())
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned),
        Err(_) => (!body.is_empty())
            .then(|| String::from_utf16_lossy(&body.encode_utf16().take(500).collect::<Vec<_>>())),
    }
}

pub fn map_event(raw: &Value) -> Option<Value> {
    let kind = raw["__event"]
        .as_str()
        .or(raw["type"].as_str())
        .unwrap_or("");
    let index = raw["index"].as_u64().unwrap_or(0);
    Some(match kind {
        "message_start" => {
            json!({"type":kind,"id":raw["message"]["id"].as_str().unwrap_or("unknown"),"model":raw["message"]["model"].as_str().unwrap_or(""),"usage":usage(&raw["message"]["usage"])})
        }
        "content_block_start" => {
            json!({"type":kind,"index":index,"content_block":map_block(&raw["content_block"])})
        }
        "content_block_delta" => {
            let delta = &raw["delta"];
            let (field, source) = match delta["type"].as_str()? {
                "text_delta" => ("text", "text"),
                "thinking_delta" => ("thinking", "thinking"),
                "input_json_delta" => ("partialJson", "partial_json"),
                "signature_delta" => ("signature", "signature"),
                _ => return None,
            };
            let mut event = json!({"type":delta["type"],"index":index});
            event[field] = json!(delta[source].as_str().unwrap_or(""));
            event
        }
        "content_block_stop" => json!({"type":kind,"index":index}),
        "message_delta" => {
            let mut event = json!({"type":kind});
            if truthy(&raw["delta"]["stop_reason"]) {
                event["stopReason"] = raw["delta"]["stop_reason"].clone();
            }
            if let Some(input) = raw.get("usage").filter(|v| truthy(v)) {
                let mut usage = serde_json::Map::new();
                for key in [
                    "input_tokens",
                    "output_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                ] {
                    if input[key].is_number() {
                        usage.insert(key.into(), input[key].clone());
                    }
                }
                event["usage"] = Value::Object(usage);
            }
            event
        }
        "message_stop" => json!({"type":kind}),
        "error" => {
            let mut event = json!({"type":kind,"errorType":raw["error"]["type"].as_str().unwrap_or("unknown_error"),"message":raw["error"]["message"].as_str().unwrap_or(crate::harness::TextId::ProvidersStreamUnknownError.default_text())});
            if raw["error"]["message"].as_str().is_none() {
                event["harness"] = serde_json::to_value(crate::harness::Message::template(
                    crate::harness::TextId::ProvidersStreamUnknownError,
                    &[],
                ))
                .unwrap();
            }
            event
        }
        _ => return None,
    })
}

fn usage(raw: &Value) -> Value {
    let mut value = json!({"input_tokens":raw["input_tokens"].as_f64().unwrap_or(0.0),"output_tokens":raw["output_tokens"].as_f64().unwrap_or(0.0)});
    for key in ["cache_creation_input_tokens", "cache_read_input_tokens"] {
        if let Some(item) = raw.get(key) {
            value[key] = item.clone();
        }
    }
    value
}

fn map_block(raw: &Value) -> Value {
    match raw["type"].as_str().unwrap_or("") {
        "text" => json!({"type":"text","text":raw["text"].as_str().unwrap_or("")}),
        "thinking" => {
            let mut block =
                json!({"type":"thinking","thinking":raw["thinking"].as_str().unwrap_or("")});
            if truthy(&raw["signature"]) {
                block["signature"] = raw["signature"].clone();
            }
            block
        }
        "tool_use" => {
            json!({"type":"tool_use","id":raw["id"].as_str().unwrap_or(""),"name":raw["name"].as_str().unwrap_or(""),"input":raw.get("input").filter(|v| !v.is_null()).cloned().unwrap_or(json!({}))})
        }
        "signature" => {
            json!({"type":"signature","signature":raw["signature"].as_str().unwrap_or("")})
        }
        _ => json!({"type":"text","text":""}),
    }
}

fn non_streaming_events(response: &Value, request: &Value) -> Vec<Value> {
    let usage = usage(&response["usage"]);
    let stop = response["delta"]
        .get("stop_reason")
        .filter(|value| !value.is_null())
        .or_else(|| response.get("stop_reason").filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or(Value::Null);
    let mut events = vec![
        json!({"type":"message_start","id":response["id"].as_str().unwrap_or("unknown"),"model":response.get("model").filter(|value| !value.is_null()).unwrap_or(&request["model"]),"usage":usage,"stopReason":stop}),
    ];
    for (index, block) in response["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let kind = block["type"].as_str().unwrap_or("");
        let mut start = map_block(block);
        if kind == "text" {
            start["text"] = json!("");
        }
        if kind == "thinking" {
            start = json!({"type":"thinking","thinking":""});
        }
        if !["text", "thinking", "tool_use"].contains(&kind) {
            start = json!({"type":"text","text":""});
        }
        events.push(json!({"type":"content_block_start","index":index,"content_block":start}));
        match kind {
            "text" => {
                if truthy(&block["text"]) {
                    events.push(json!({"type":"text_delta","index":index,"text":block["text"]}));
                }
            }
            "thinking" => {
                for (field, event) in [
                    ("thinking", "thinking_delta"),
                    ("signature", "signature_delta"),
                ] {
                    if truthy(&block[field]) {
                        let mut value = json!({"type":event,"index":index});
                        value[field] = block[field].clone();
                        events.push(value);
                    }
                }
            }
            "tool_use" => {
                let input = crate::js::data::stringify(
                    block
                        .get("input")
                        .filter(|value| !value.is_null())
                        .unwrap_or(&json!({})),
                );
                if input != "{}" {
                    events
                        .push(json!({"type":"input_json_delta","index":index,"partialJson":input}));
                }
            }
            _ => events.push(json!({"type":"text_delta","index":index,"text":stringify(block)})),
        }
        events.push(json!({"type":"content_block_stop","index":index}));
    }
    events.push(json!({"type":"message_delta","stopReason":stop,"usage":usage}));
    events.push(json!({"type":"message_stop"}));
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mapped_events_and_nonstreaming_fallback_match_baseline() {
        let fixtures: Value =
            serde_json::from_str(include_str!("fixtures/anthropic-baseline.json")).unwrap();
        for fixture in fixtures["events"].as_array().unwrap() {
            assert_eq!(
                stringify(&map_event(&fixture["input"]).unwrap_or(Value::Null)),
                stringify(&fixture["expected"])
            );
        }
        for fixture in fixtures["fallbacks"].as_array().unwrap() {
            assert_eq!(
                stringify(&json!(non_streaming_events(
                    &fixture["response"],
                    &fixture["request"]
                ))),
                stringify(&fixture["expected"]),
                "{}",
                fixture["name"]
            );
        }
    }
}
