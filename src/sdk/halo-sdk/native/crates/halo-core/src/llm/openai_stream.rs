#[cfg(test)]
use super::openai_request::build_body;
use super::{
    model_quirks::{is_xml_think, ThinkTagParser},
    openai_request::{build_headers, finish_reason, parse_response_with_harness, parse_usage, resolve_model},
};
use super::transport::AttemptClient;
use crate::{
    error::{Error, Result},
    js::truthy,
};
#[cfg(test)]
use crate::js::stringify;
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    collections::{BTreeMap, VecDeque},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct OpenAiStream {
    config: Value,
    request: Value,
    body: Value,
    http: AttemptClient,
    cancellation: CancellationToken,
    response: Option<reqwest::Response>,
    decoder: super::sse::Decoder,
    events: VecDeque<Value>,
    mapper: ChunkMapper,
    done: bool,
    attempt: u32,
    response_started: bool,
    delay: Option<f64>,
    usage_deadline: Option<tokio::time::Instant>,
}

impl OpenAiStream {
    pub fn new(
        config: Value,
        request: Value,
        client: reqwest::Client,
        cancellation: CancellationToken,
    ) -> Result<Self> {
        Self::new_with_harness(
            config,
            request,
            client,
            cancellation,
            &crate::harness::baseline(),
        )
    }
    pub fn new_with_harness(
        config: Value,
        request: Value,
        client: reqwest::Client,
        cancellation: CancellationToken,
        harness: &crate::harness::ResolvedHarness,
    ) -> Result<Self> {
        Self::with_http(config, request, AttemptClient::supplied(client), cancellation, harness)
    }
    pub fn with_http(
        config: Value,
        request: Value,
        http: AttemptClient,
        cancellation: CancellationToken,
        harness: &crate::harness::ResolvedHarness,
    ) -> Result<Self> {
        let body =
            super::openai_request::build_body_with_harness(&request, &config, true, harness)?;
        let mapper = ChunkMapper::new(&config, &request)?;
        Ok(Self {
            config,
            request,
            body,
            http,
            cancellation,
            response: None,
            decoder: Default::default(),
            events: VecDeque::new(),
            mapper,
            done: false,
            attempt: 0,
            response_started: false,
            delay: None,
            usage_deadline: None,
        })
    }

    pub async fn next(&mut self) -> Result<Option<Value>> {
        if self.done {
            return Ok(None);
        }
        loop {
            if self.cancellation.is_cancelled() {
                self.response.take();
                self.done = true;
                return Err(Error::cancelled());
            }
            if let Some(event) = self.events.pop_front() {
                if event["type"] == "message_stop" {
                    self.done = true;
                    self.response.take();
                }
                return Ok(Some(event));
            }
            if let Some(delay) = self.delay.take() {
                sleep(delay, &self.cancellation).await?;
            }
            if self.response.is_none() {
                match send(
                    &self.http,
                    &self.config,
                    &self.body,
                    true,
                    &self.cancellation,
                    self.attempt,
                    self.response_started,
                )
                .await
                {
                    Ok(response) => {
                        self.response_started = true;
                        self.response = Some(response);
                    }
                    Err(error) => {
                        self.retry(error)?;
                        continue;
                    }
                }
            }
            let raw = self.read_record().await;
            match raw {
                Ok(Some(raw)) => match self.mapper.chunk(&raw) {
                    Ok(events) => {
                        self.events.extend(events);
                        if self.mapper.finished && self.usage_deadline.is_none() {
                            self.usage_deadline =
                                Some(tokio::time::Instant::now() + Duration::from_millis(1000));
                        }
                        if self.mapper.has_final_usage {
                            self.events.push_back(json!({"type":"message_stop"}));
                        }
                    }
                    Err(error) => {
                        if self.mapper.finished {
                            self.finish_tail(Some(error.message));
                        } else {
                            self.retry(error)?;
                        }
                    }
                },
                Ok(None) => {
                    if self.mapper.finished {
                        self.finish_tail(None);
                    } else {
                        self.retry(provider_template(
                            &self.config,
                            crate::harness::TextId::ProvidersStreamMissingOpenaiEnd,
                            &[],
                            None,
                            true,
                            false,
                        ))?;
                    }
                }
                Err(error) => {
                    if self.cancellation.is_cancelled() {
                        self.response.take();
                        self.done = true;
                        return Err(Error::cancelled());
                    }
                    if self.mapper.finished {
                        self.finish_tail(Some(error.message));
                    } else {
                        self.retry(error)?;
                    }
                }
            }
        }
    }

    fn finish_tail(&mut self, reason: Option<String>) {
        if let Some(reason) = reason {
            tracing::warn!(
                provider = self.config["id"].as_str().unwrap_or(""),
                reason,
                "completed response usage tail unavailable"
            );
        }
        self.response.take();
        self.events.push_back(json!({"type":"message_stop"}));
    }

    fn retry(&mut self, mut error: Error) -> Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let details = error.details.as_ref().cloned().unwrap_or(Value::Null);
        if details["retryable"] != true {
            return Err(error);
        }
        if self.attempt >= 10 {
            error.details.as_mut().unwrap()["retriesExhausted"] = json!(true);
            return Err(error);
        }
        let delay = details["retryDelayMs"]
            .as_f64()
            .unwrap_or_else(|| backoff(self.attempt));
        self.attempt += 1;
        let reason = details["retryReason"].as_str().unwrap_or(&error.message);
        tracing::warn!(attempt=self.attempt,max_retries=10,delay_ms=delay.round(),status=?details["statusCode"],reason,"request failed; retrying");
        self.events.push_back(json!({"type":"retry","attempt":self.attempt,"maxRetries":10,"delayMs":delay,"status":details["statusCode"],"message":reason}));
        self.delay = Some(delay);
        self.response.take();
        self.decoder = Default::default();
        self.usage_deadline = None;
        self.mapper = ChunkMapper::new(&self.config, &self.request)?;
        Ok(())
    }

    async fn read_record(&mut self) -> Result<Option<Value>> {
        loop {
            match self.decoder.next().map_err(|id| provider_template(&self.config, id, &[], None, true, false))? {
                Some(super::sse::Record::Data(value)) => return Ok(Some(value)),
                Some(super::sse::Record::Done) => return Ok(None),
                None if self.decoder.ended() => return Ok(None),
                None => {}
            }
            let response = self.response.as_mut().ok_or_else(|| {
                provider_template(
                    &self.config,
                    crate::harness::TextId::ProvidersStreamUnreadableBody,
                    &[],
                    None,
                    true,
                    false,
                )
            })?;
            let chunk = if let Some(deadline) = self.usage_deadline {
                tokio::select! {
                    _=self.cancellation.cancelled()=>return Err(Error::cancelled()),
                    _=tokio::time::sleep_until(deadline)=>return Err(provider_template(&self.config,crate::harness::TextId::ProvidersStreamUsageDeadline,&[],None,false,false)),
                    chunk=response.chunk()=>chunk,
                }
            } else {
                tokio::select! {_=self.cancellation.cancelled()=>return Err(Error::cancelled()),chunk=response.chunk()=>chunk}
            };
            match chunk {
                Ok(Some(bytes)) => self.decoder.push(&bytes).map_err(|id| provider_template(&self.config, id, &[], None, true, false))?,
                Ok(None) => self.decoder.finish(),
                Err(error) => return Err(network_error(&self.config, &error, None, true, false)),
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

#[derive(Default)]
struct ToolChunk {
    index: usize,
    id: String,
    name: String,
    input: String,
    input_started: bool,
    structured_input: bool,
    announced: bool,
}

pub struct ChunkMapper {
    provider: Value,
    started: bool,
    next_index: usize,
    reasoning: Option<usize>,
    text: Option<usize>,
    tools: BTreeMap<u64, ToolChunk>,
    tool_order: Vec<u64>,
    announced_tools: usize,
    fields: Vec<String>,
    parser: Option<ThinkTagParser>,
    pub finished: bool,
    pub has_final_usage: bool,
}

impl ChunkMapper {
    pub fn new(config: &Value, request: &Value) -> Result<Self> {
        let model = resolve_model(request, config)?;
        let common = [
            "reasoning_content",
            "thinking_content",
            "reasoning_text",
            "reasoning",
        ];
        let mut fields = Vec::new();
        if let Some(field) = config["quirks"]["reasoningField"]
            .as_str()
            .filter(|field| !field.is_empty())
        {
            fields.push(field.to_owned());
        }
        for field in common {
            if !fields.iter().any(|entry| entry == field) {
                fields.push(field.to_owned());
            }
        }
        Ok(Self {
            provider: config.clone(),
            started: false,
            next_index: 0,
            reasoning: None,
            text: None,
            tools: BTreeMap::new(),
            tool_order: Vec::new(),
            announced_tools: 0,
            fields,
            parser: is_xml_think(&model).then(ThinkTagParser::default),
            finished: false,
            has_final_usage: false,
        })
    }
    fn close_prose(&mut self, events: &mut Vec<Value>) {
        if let Some(index) = self.reasoning.or(self.text) {
            events.push(json!({"type":"content_block_stop","index":index}));
        }
        self.reasoning = None;
        self.text = None;
    }
    fn prose(&mut self, reasoning: bool, events: &mut Vec<Value>) -> usize {
        if let Some(index) = if reasoning { self.reasoning } else { self.text } {
            return index;
        }
        self.close_prose(events);
        let index = self.next_index;
        self.next_index += 1;
        if reasoning {
            self.reasoning = Some(index);
            events.push(json!({"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":""}}));
        } else {
            self.text = Some(index);
            events.push(json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}));
        }
        index
    }
    fn tag_events(&mut self, incoming: Vec<Value>, events: &mut Vec<Value>) {
        for mut event in incoming {
            match event["type"].as_str() {
                Some("reasoning_delta") => event["index"] = json!(self.prose(true, events)),
                Some("text_delta") => event["index"] = json!(self.prose(false, events)),
                _ => {}
            }
            events.push(event);
        }
    }
    fn announce_tools(&mut self, events: &mut Vec<Value>, force: bool) -> Result<()> {
        // Announced metadata is immutable; retain name fragments until arguments start.
        while self.announced_tools < self.tool_order.len() {
            let key = self.tool_order[self.announced_tools];
            let tool = self.tools.get_mut(&key).unwrap();
            if tool.id.is_empty() || tool.name.is_empty() {
                if force { return Err(provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false)); }
                break;
            }
            if !force && !tool.input_started { break; }
            tool.announced = true;
            self.announced_tools += 1;
            events.push(json!({"type":"content_block_start","index":tool.index,"content_block":{"type":"tool_use","id":tool.id,"name":tool.name,"input":{}}}));
            if !tool.input.is_empty() {
                events.push(json!({"type":"input_json_delta","index":tool.index,"partialJson":std::mem::take(&mut tool.input)}));
            }
        }
        Ok(())
    }
    pub fn chunk(&mut self, chunk: &Value) -> Result<Vec<Value>> {
        if truthy(&chunk["error"]) {
            return Err(stream_error(&self.provider, &chunk["error"]));
        }
        let mut events = Vec::new();
        if self.finished {
            if truthy(&chunk["usage"]) {
                events.push(json!({"type":"message_delta","usage":parse_usage(&chunk["usage"])}));
                self.has_final_usage = true;
            }
            return Ok(events);
        }
        if !self.started {
            events.push(json!({"type":"message_start","id":chunk["id"].as_str().filter(|value|!value.is_empty()).unwrap_or("unknown"),"model":chunk["model"].as_str().unwrap_or(""),"usage":{"input_tokens":0,"output_tokens":0}}));
            self.started = true;
        }
        let Some(choice) = chunk["choices"]
            .as_array()
            .and_then(|choices| choices.first())
        else {
            if truthy(&chunk["usage"]) {
                events.push(json!({"type":"message_delta","usage":parse_usage(&chunk["usage"])}));
            }
            return Ok(events);
        };
        let delta = &choice["delta"];
        let reasoning = self
            .fields
            .iter()
            .find_map(|field| truthy(&delta[field]).then(|| delta[field].clone()));
        if reasoning.is_some() || truthy(&delta["content"]) || truthy(&delta["thinking"]["content"])
            || truthy(&delta["thinking"]["signature"]) || delta["refusal"].as_str().is_some_and(|value| !value.is_empty()) {
            self.announce_tools(&mut events, true)?;
        }
        if let Some(reasoning) = reasoning {
            let index = self.prose(true, &mut events);
            events.push(json!({"type":"reasoning_delta","index":index,"reasoning":reasoning}));
        } else if truthy(&delta["thinking"]) {
            if delta["thinking"]["content"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
            {
                let index = self.prose(true, &mut events);
                events.push(json!({"type":"reasoning_delta","index":index,"reasoning":delta["thinking"]["content"]}));
            }
            if delta["thinking"]["signature"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
            {
                let index = self.prose(true, &mut events);
                events.push(json!({"type":"signature_delta","index":index,"signature":delta["thinking"]["signature"]}));
            }
        }
        if let Some(refusal) = delta["refusal"].as_str().filter(|value| !value.is_empty() && !truthy(&delta["content"])) {
            if let Some(parser) = self.parser.as_mut() {
                let pending = parser.flush(0);
                *parser = ThinkTagParser::default();
                self.tag_events(pending, &mut events);
            }
            let index = self.prose(false, &mut events);
            events.push(json!({"type":"text_delta","index":index,"text":refusal}));
        } else if truthy(&delta["content"]) {
            if let Some(parser) = self.parser.as_mut() {
                let parsed = parser.process(delta["content"].as_str().unwrap_or(""), 0);
                self.tag_events(parsed, &mut events);
            } else {
                let index = self.prose(false, &mut events);
                events.push(json!({"type":"text_delta","index":index,"text":delta["content"]}));
            }
        }
        if let Some(tools) = delta["tool_calls"].as_array() {
            self.close_prose(&mut events);
            for tool in tools {
                let tool_index = tool["index"].as_u64().unwrap_or(0);
                if !self.tools.contains_key(&tool_index) {
                    let index = self.next_index;
                    self.next_index += 1;
                    self.tools.insert(tool_index, ToolChunk { index, ..Default::default() });
                    self.tool_order.push(tool_index);
                }
                let state = self.tools.get_mut(&tool_index).unwrap();
                if let Some(id) = tool.get("id").filter(|value| !value.is_null()) {
                    let id = id.as_str().ok_or_else(|| provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false))?;
                    if !id.is_empty() {
                        if state.id.is_empty() {
                            state.id.push_str(id);
                        } else if state.id != id {
                            return Err(provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false));
                        }
                    }
                }
                if let Some(name) = tool["function"].get("name").filter(|value| !value.is_null()) {
                    let name = name.as_str().ok_or_else(|| provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false))?;
                    if !name.is_empty() {
                        if state.announced {
                            return Err(provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false));
                        }
                        state.name.push_str(name);
                    }
                }
                if let Some(input) = tool["function"].get("arguments").filter(|value| !value.is_null() && value.as_str() != Some("")) {
                    let input = if let Some(input) = input.as_str() {
                        if state.structured_input {
                            return Err(provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false));
                        }
                        Cow::Borrowed(input)
                    } else {
                        if state.input_started {
                            return Err(provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false));
                        }
                        state.structured_input = true;
                        Cow::Owned(serde_json::to_string(input).map_err(|_| provider_template(&self.provider, crate::harness::TextId::ProvidersStreamInvalidToolMetadata, &[], None, true, false))?)
                    };
                    state.input_started = true;
                    if state.announced {
                        events.push(json!({"type":"input_json_delta","index":state.index,"partialJson":input}));
                    } else {
                        state.input.push_str(&input);
                    }
                }
                self.announce_tools(&mut events, false)?;
            }
        }
        if let Some(reason) = choice["finish_reason"]
            .as_str()
            .filter(|reason| !reason.is_empty() && *reason != "null")
        {
            self.announce_tools(&mut events, true)?;
            if let Some(parser) = self.parser.as_mut() {
                let parsed = parser.flush(0);
                self.tag_events(parsed, &mut events);
            }
            self.close_prose(&mut events);
            for key in &self.tool_order {
                events.push(json!({"type":"content_block_stop","index":self.tools[key].index}));
            }
            let mut final_event =
                json!({"type":"message_delta","stopReason":finish_reason(reason)});
            if truthy(&chunk["usage"]) {
                final_event["usage"] = parse_usage(&chunk["usage"]);
                self.has_final_usage = true;
            }
            events.push(final_event);
            self.finished = true;
        }
        Ok(events)
    }
}

pub async fn complete(
    config: &Value,
    request: &Value,
    client: &reqwest::Client,
    cancellation: &CancellationToken,
) -> Result<Value> {
    complete_with_harness(
        config,
        request,
        client,
        cancellation,
        &crate::harness::baseline(),
    )
    .await
}
pub async fn complete_with_harness(
    config: &Value,
    request: &Value,
    client: &reqwest::Client,
    cancellation: &CancellationToken,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Value> {
    complete_with_http(config, request, &AttemptClient::supplied(client.clone()), cancellation, harness).await
}
pub async fn complete_with_http(
    config: &Value,
    request: &Value,
    http: &AttemptClient,
    cancellation: &CancellationToken,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Value> {
    let body = super::openai_request::build_body_with_harness(request, config, false, harness)?;
    let mut started = false;
    let mut last_error = None;
    for attempt in 0..=10 {
        if attempt > 0 {
            let error = last_error.as_ref().unwrap();
            let details: Value = error_details(error);
            let delay = details["retryDelayMs"]
                .as_f64()
                .unwrap_or_else(|| backoff(attempt - 1));
            tracing::warn!(attempt, delay_ms = delay, "request failed; retrying");
            sleep(delay, cancellation).await?;
        }
        let result=async{
            let response=send(http,config,&body,false,cancellation,attempt,started).await?;started=true;
            let json:Value=tokio::select!{_=cancellation.cancelled()=>return Err(Error::cancelled()),value=response.json()=>value.map_err(|error|network_error(config,&error,None,true,false))?};
            parse_response_with_harness(&json,request["model"].as_str().unwrap_or(""),harness)
        }.await;
        match result {
            Ok(value) => return Ok(value),
            Err(error) => {
                if cancellation.is_cancelled() {
                    return Err(Error::cancelled());
                }
                if error_details(&error)["retryable"] != true {
                    return Err(error);
                }
                last_error = Some(error);
            }
        }
    }
    let mut error = last_error.unwrap();
    error.details.as_mut().unwrap()["retriesExhausted"] = json!(true);
    Err(error)
}
fn error_details(error: &Error) -> Value {
    error.details.clone().unwrap_or(Value::Null)
}

async fn send(
    http: &AttemptClient,
    config: &Value,
    body: &Value,
    stream: bool,
    cancellation: &CancellationToken,
    attempt: u32,
    started: bool,
) -> Result<reqwest::Response> {
    let url = format!(
        "{}/chat/completions",
        config["baseUrl"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
    );
    let mut headers = build_headers(config);
    if stream {
        headers["Accept"] = json!("text/event-stream");
    }
    let client = http.client(cancellation).await?;
    let mut request = client.post(url).body(super::transport::serialize_model_request(body));
    for (name, value) in headers.as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            request = request.header(name, value);
        }
    }
    let response = tokio::select! {_=cancellation.cancelled()=>return Err(Error::cancelled()),response=request.send()=>response.map_err(|error|network_error(config,&error,None,true,false))?};
    let status = response.status().as_u16();
    if response.status().is_success() {
        return Ok(response);
    }
    let delay = retry_delay(response.headers(), status, attempt);
    let text = tokio::select! {_=cancellation.cancelled()=>return Err(Error::cancelled()),body=response.text()=>body.unwrap_or_else(|error|{tracing::warn!(status,error=%error.without_url(),"HTTP error body unavailable");String::new()})};
    let reason = api_message(&text);
    let name = config["name"].as_str().unwrap_or("");
    let mut error = if let Some(reason) = &reason {
        provider_template(
            config,
            crate::harness::TextId::ProvidersHttpError,
            &[
                ("provider", name.into()),
                ("status", status.to_string().into()),
                ("reason", reason.clone().into()),
            ],
            Some(status),
            delay.is_some(),
            !started,
        )
    } else {
        provider_template(
            config,
            crate::harness::TextId::ProvidersHttpErrorWithoutBody,
            &[
                ("provider", name.into()),
                ("status", status.to_string().into()),
            ],
            Some(status),
            delay.is_some(),
            !started,
        )
    };
    let message = error.message.clone();
    error.details.as_mut().unwrap()["retryDelayMs"] = json!(delay);
    error.details.as_mut().unwrap()["retryReason"] = json!(reason.unwrap_or(message));
    Err(error)
}

pub async fn list_models(config: &Value, client: &reqwest::Client) -> Value {
    match models_response(config,client).await{
        Ok(response) if response.status().is_success()=>match response.json::<Value>().await{
            Ok(value)=>json!(value["data"].as_array().into_iter().flatten().filter(|model|truthy(&model["id"])).map(|model|json!({"id":model["id"],"providerId":config["id"],"name":model["id"],"contextWindow":128000,"maxOutputTokens":16384})).collect::<Vec<_>>()),
            Err(error)=>{tracing::warn!(error=%error.without_url(),"Provider model list unreadable");json!([])}
        },
        Ok(response)=>{tracing::warn!(status=response.status().as_u16(),"Provider model list request failed");json!([])}
        Err(error)=>{tracing::warn!(error=%error.without_url(),"Provider model list unavailable");json!([])}
    }
}

fn has_health_credentials(config: &Value) -> bool {
    let url = config["baseUrl"].as_str().unwrap_or("");
    truthy(&config["apiKey"]) || url.contains("localhost") || url.contains("127.0.0.1") || url.contains("::1")
}

pub async fn health_check_with_http(config: &Value, http: &AttemptClient, cancellation: &CancellationToken) -> Result<Value> {
    if !has_health_credentials(config) { return Ok(json!({"status":"unavailable","reason":"No API key configured"})); }
    let client = http.client(cancellation).await?;
    Ok(health_check(config, &client).await)
}

pub async fn health_check(config: &Value, client: &reqwest::Client) -> Value {
    if !has_health_credentials(config) {
        return json!({"status":"unavailable","reason":"No API key configured"});
    }
    match models_response(config, client).await {
        Ok(response) if response.status().is_success() => json!({"status":"healthy"}),
        Ok(response) => {
            json!({"status":"unavailable","reason":format!("models endpoint returned {}",response.status().as_u16())})
        }
        Err(error) => {
            json!({"status":"unavailable","reason":format!("TypeError: {}",network_reason(&error))})
        }
    }
}
async fn models_response(
    config: &Value,
    client: &reqwest::Client,
) -> std::result::Result<reqwest::Response, reqwest::Error> {
    let mut request = client.get(format!(
        "{}/models",
        config["baseUrl"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
    ));
    for (key, value) in build_headers(config).as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            request = request.header(key, value);
        }
    }
    request.send().await
}

fn provider_template(
    config: &Value,
    id: crate::harness::TextId,
    values: &[(&str, crate::harness::Message)],
    status: Option<u16>,
    retryable: bool,
    rejected: bool,
) -> Error {
    provider_error(config, "", status, retryable, rejected).with_harness(id, values)
}
fn provider_error(
    config: &Value,
    message: &str,
    status: Option<u16>,
    retryable: bool,
    rejected: bool,
) -> Error {
    let mut details = json!({"name":"ProviderError","provider":config["name"],"retryable":retryable,"requestRejected":rejected,"retriesExhausted":false});
    if let Some(status) = status {
        details["statusCode"] = json!(status);
    }
    Error::new("PROVIDER_ERROR", message).with_details(details)
}
fn stream_error(config: &Value, error: &Value) -> Error {
    let status = match error["type"].as_str().unwrap_or("unknown_error") {
        "overloaded_error" => Some(529),
        "rate_limit_error" => Some(429),
        "api_error" | "server_error" => Some(500),
        "authentication_error" => Some(401),
        "permission_error" => Some(403),
        "invalid_request_error" => Some(400),
        "not_found_error" => Some(404),
        _ => None,
    };
    if let Some(message) = error["message"].as_str() {
        provider_error(
            config,
            message,
            status,
            status.is_some_and(retryable_status),
            false,
        )
    } else {
        provider_template(
            config,
            crate::harness::TextId::ProvidersStreamUnknownStreamError,
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

async fn sleep(delay: f64, cancellation: &CancellationToken) -> Result<()> {
    tokio::select! {_=cancellation.cancelled()=>Err(Error::cancelled()),_=tokio::time::sleep(Duration::from_secs_f64(delay/1000.0))=>Ok(())}
}
fn api_message(body: &str) -> Option<String> {
    match serde_json::from_str::<Value>(body) {
        Ok(value) => [
            &value["error"]["message"],
            &value["error"]["error"]["message"],
            &value["message"],
            &value["detail"],
        ]
        .into_iter()
        .find(|value| !value.is_null())
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned),
        Err(_) => {
            if body.is_empty() {
                None
            } else {
                Some(
                    body.chars()
                        .scan(0, |count, character| {
                            *count += character.len_utf16();
                            (*count <= 500).then_some(character)
                        })
                        .collect(),
                )
            }
        }
    }
}
fn network_reason(error: &reqwest::Error) -> String {
    network_message(error).render(&crate::harness::baseline())
}
fn network_error(
    config: &Value,
    error: &reqwest::Error,
    status: Option<u16>,
    retryable: bool,
    rejected: bool,
) -> Error {
    let message = network_message(error);
    let mut error = provider_error(
        config,
        &message.render(&crate::harness::baseline()),
        status,
        retryable,
        rejected,
    );
    error.harness = Some(message);
    error
}
fn network_message(error: &reqwest::Error) -> crate::harness::Message {
    use std::error::Error as _;
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            let code = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
                std::io::ErrorKind::ConnectionReset => Some("ECONNRESET"),
                std::io::ErrorKind::TimedOut => Some("ETIMEDOUT"),
                std::io::ErrorKind::BrokenPipe => Some("EPIPE"),
                _ => None,
            };
            if let Some(code) = code {
                return crate::harness::Message::template(
                    crate::harness::TextId::ProvidersNetworkFetchFailedCode,
                    &[("code", code.into())],
                );
            }
        }
        source = cause.source();
    }
    if error.is_connect() {
        crate::harness::Message::template(crate::harness::TextId::ProvidersNetworkFetchFailed, &[])
    } else if error.is_body() {
        crate::harness::Message::template(
            crate::harness::TextId::ProvidersNetworkSocketTerminated,
            &[],
        )
    } else {
        error
            .source()
            .map(|error| error.to_string().into())
            .unwrap_or_else(|| {
                crate::harness::Message::template(
                    crate::harness::TextId::ProvidersNetworkFetchFailed,
                    &[],
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_events_match_baseline() {
        let fixtures: Value =
            serde_json::from_str(include_str!("fixtures/openai-baseline.json")).unwrap();
        for fixture in fixtures["streams"].as_array().unwrap() {
            let mut mapper = ChunkMapper::new(&fixture["config"], &fixture["request"]).unwrap();
            let mut events = Vec::new();
            for chunk in fixture["chunks"].as_array().unwrap() {
                events.extend(mapper.chunk(chunk).unwrap());
            }
            assert!(mapper.finished, "{}", fixture["name"]);
            events.push(json!({"type":"message_stop"}));
            assert_eq!(
                stringify(&json!(events)),
                stringify(&fixture["expected"]),
                "{}",
                fixture["name"]
            );
        }
    }

    async fn request_body(socket: &mut tokio::net::TcpStream) -> Value {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let header_end = loop {
            let read = socket.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let length: usize = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse().unwrap())
            .unwrap_or(0);
        while bytes.len() < header_end + length {
            let read = socket.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&buffer[..read]);
        }
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    }

    #[tokio::test]
    async fn http_retry_and_usage_tail_keep_actual_requests_and_events() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(request_body(&mut socket).await);
                let (status, headers, body) = if attempt == 0 {
                    (
                        "429 Too Many Requests",
                        "Retry-After: 0.001\r\n",
                        r#"{"error":{"message":"try again"}}"#.to_owned(),
                    )
                } else {
                    ("200 OK","Content-Type: text/event-stream\r\n",[
                    json!({"id":"response","model":"fixture","choices":[{"delta":{"content":"answer"}}]}),
                    json!({"choices":[{"finish_reason":"stop"}]}),
                    json!({"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":5}}}),
                ].iter().map(|chunk|format!("data: {}\n\n",stringify(chunk))).collect::<String>()+"data: [DONE]\n\n")
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        let config = json!({"id":"fixture","name":"Fixture","baseUrl":format!("http://{address}/v1"),"quirks":{"includeUsageInStream":true}});
        let request = json!({"model":"fixture","messages":[{"role":"user","content":"hello"}],"maxTokens":50});
        let mut stream = OpenAiStream::new(
            config.clone(),
            request.clone(),
            reqwest::Client::new(),
            CancellationToken::new(),
        )
        .unwrap();
        let mut events = Vec::new();
        while let Some(event) = stream.next().await.unwrap() {
            events.push(event);
        }
        assert_eq!(
            events[0],
            json!({"type":"retry","attempt":1,"maxRetries":10,"delayMs":1000.0,"status":429,"message":"try again"})
        );
        assert!(events
            .iter()
            .any(|event| event["usage"]["cache_read_input_tokens"] == 5.0));
        assert_eq!(events.last().unwrap()["type"], "message_stop");
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
        assert_eq!(requests[0], build_body(&request, &config, true).unwrap());
    }

    #[tokio::test]
    async fn completed_response_releases_body_when_usage_never_arrives() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            request_body(&mut socket).await;
            let body = format!(
                "data: {}\n\n",
                stringify(
                    &json!({"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]})
                )
            );
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()+100).as_bytes()).await.unwrap();
            let mut probe = [0u8; 1];
            tokio::time::timeout(Duration::from_secs(5), socket.read(&mut probe))
                .await
                .unwrap()
                .unwrap()
        });
        let mut stream = OpenAiStream::new(
            json!({"id":"fixture","name":"Fixture","baseUrl":format!("http://{address}/v1")}),
            json!({"model":"fixture","messages":[],"maxTokens":20}),
            reqwest::Client::new(),
            CancellationToken::new(),
        )
        .unwrap();
        let events = tokio::time::timeout(Duration::from_secs(4), async {
            let mut events = Vec::new();
            while let Some(event) = stream.next().await.unwrap() {
                events.push(event);
            }
            events
        })
        .await
        .unwrap();
        assert_eq!(events.last().unwrap()["type"], "message_stop");
        assert_eq!(server.await.unwrap(), 0);
    }
}
