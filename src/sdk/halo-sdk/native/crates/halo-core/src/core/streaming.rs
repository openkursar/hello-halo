use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    js::utf16_len,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
};

struct Block {
    content: Value,
    parts: String,
    signatures: String,
    frame: Option<Value>,
}

pub struct Accumulator {
    blocks: BTreeMap<u64, Block>,
    pub unreadable: HashMap<String, String>,
    pub format_rejections: HashSet<String>,
    pub format_fingerprints: HashMap<String, String>,
    pub id: String,
    pub model: String,
    pub response_id: String,
    pub usage: Value,
    pub stop: Option<String>,
    pub unreadable_tool_call: Option<String>,
    initial_stop: Option<String>,
    message_started: bool,
    highest: Option<u64>,
    session: String,
    initial_model: String,
    pub committed: usize,
    pub discovery: Option<Arc<Mutex<super::tool_context::State>>>,
    deferred: HashSet<u64>,
    harness: Arc<ResolvedHarness>,
}

impl Accumulator {
    pub fn new(session: &str, model: &str) -> Self {
        Self::new_with_harness(session, model, crate::harness::baseline())
    }
    pub fn new_with_harness(session: &str, model: &str, harness: Arc<ResolvedHarness>) -> Self {
        Self {
            blocks: Default::default(),
            unreadable: Default::default(),
            format_rejections: Default::default(),
            format_fingerprints: Default::default(),
            id: uuid::Uuid::new_v4().to_string(),
            model: model.into(),
            response_id: uuid::Uuid::new_v4().to_string(),
            usage: json!({"input_tokens":0,"output_tokens":0}),
            stop: Some("end_turn".into()),
            unreadable_tool_call: None,
            initial_stop: None,
            message_started: false,
            highest: None,
            session: session.into(),
            initial_model: model.into(),
            committed: 0,
            discovery: None,
            deferred: HashSet::new(),
            harness,
        }
    }
    pub fn reset(&mut self) -> Result<()> {
        if self.committed > 0 {
            return Err(Error::template(
                "PROVIDER_ERROR",
                TextId::ContextStreamReplayStopped,
                &[],
            ));
        }
        let discovery = self.discovery.clone();
        *self = Self::new_with_harness(&self.session, &self.initial_model, self.harness.clone());
        self.discovery = discovery;
        Ok(())
    }
    pub fn accept(&mut self, event: &Value) -> Result<Option<Value>> {
        let kind = event["type"].as_str().unwrap_or("");
        let index = event["index"].as_u64().unwrap_or(0);
        if kind.ends_with("_delta")
            && event.get("index").is_some()
            && self
                .blocks
                .get(&index)
                .is_some_and(|block| block.frame.is_some())
        {
            return Err(Error::template(
                "PROVIDER_ERROR",
                TextId::ContextStreamChangedBlock,
                &[],
            ));
        }
        match kind {
            "message_start" => {
                if self.message_started || !self.blocks.is_empty() {
                    return Err(Error::template(
                        "PROVIDER_ERROR",
                        TextId::ContextStreamRestartedMessage,
                        &[],
                    ));
                }
                self.message_started = true;
                if let Some(id) = event["id"].as_str().filter(|s| !s.is_empty()) {
                    self.id = id.into();
                }
                self.model = event["model"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&self.initial_model)
                    .into();
                self.usage = event
                    .get("usage")
                    .filter(|v| v.is_object())
                    .cloned()
                    .unwrap_or(json!({}));
                self.initial_stop = event["stopReason"].as_str().map(str::to_owned);
            }
            "content_block_start" => {
                if self.highest.is_some_and(|highest| index <= highest)
                    || self.blocks.contains_key(&index)
                    || (event["content_block"]["type"] == "tool_use"
                        && self.blocks.values().any(|block| {
                            block.content["type"] == "tool_use"
                                && block.content["id"] == event["content_block"]["id"]
                        }))
                {
                    return Err(Error::template(
                        "PROVIDER_ERROR",
                        TextId::ContextStreamReorderedBlock,
                        &[],
                    ));
                }
                self.highest = Some(index);
                self.blocks.insert(
                    index,
                    Block {
                        content: event["content_block"].clone(),
                        parts: String::new(),
                        signatures: String::new(),
                        frame: None,
                    },
                );
                if self.discovery.is_some()
                    && event["content_block"]["type"] == "tool_use"
                    && event["content_block"]["name"] == "CallTool"
                {
                    self.deferred.insert(index);
                }
            }
            "text_delta" | "thinking_delta" | "reasoning_delta" => {
                if !self.blocks.contains_key(&index) {
                    if self.highest.is_some_and(|highest| index <= highest) {
                        return Err(Error::template(
                            "PROVIDER_ERROR",
                            TextId::ContextStreamReorderedImplicit,
                            &[],
                        ));
                    }
                    self.highest = Some(index);
                    self.blocks.insert(
                        index,
                        Block {
                            content: if kind == "text_delta" {
                                json!({"type":"text","text":""})
                            } else {
                                json!({"type":"thinking","thinking":""})
                            },
                            parts: String::new(),
                            signatures: String::new(),
                            frame: None,
                        },
                    );
                }
                let field = match kind {
                    "text_delta" => "text",
                    "thinking_delta" => "thinking",
                    _ => "reasoning",
                };
                self.blocks
                    .get_mut(&index)
                    .unwrap()
                    .parts
                    .push_str(event[field].as_str().unwrap_or(""));
            }
            "signature_delta" => {
                if let Some(block) = self.blocks.get_mut(&index) {
                    block
                        .signatures
                        .push_str(event["signature"].as_str().unwrap_or(""));
                }
            }
            "input_json_delta" => {
                if let Some(block) = self.blocks.get_mut(&index) {
                    let part = event["partialJson"].as_str().unwrap_or("");
                    let limit = super::tool_context::invocation::MAX_INPUT_BYTES;
                    if self.discovery.is_some() && block.content["name"] == "CallTool" {
                        if block.parts.len() <= limit {
                            let mut end = part.len().min(limit + 1 - block.parts.len());
                            while !part.is_char_boundary(end) { end -= 1; }
                            block.parts.push_str(&part[..end]);
                            if end < part.len() {
                                while block.parts.len() <= limit { block.parts.push(' '); }
                            }
                        }
                    } else {
                        block.parts.push_str(part);
                    }
                }
            }
            "content_block_stop" => return self.finish_block(index),
            "message_delta" => {
                if let Some(reason) = event["stopReason"].as_str().filter(|s| !s.is_empty()) {
                    self.stop = Some(reason.into());
                }
                if let Some(usage) = event["usage"].as_object() {
                    for key in [
                        "input_tokens",
                        "output_tokens",
                        "cache_read_input_tokens",
                        "cache_creation_input_tokens",
                    ] {
                        if let Some(value) = usage.get(key).filter(|value| !value.is_null()) {
                            self.usage[key] = value.clone();
                        }
                    }
                }
            }
            "message_stop" => {
                self.unreadable_tool_call = event["unreadableToolCall"].as_str().map(str::to_owned)
            }
            "error" => {
                return Err(Error::new(
                    "PROVIDER_ERROR",
                    event["message"]
                        .as_str()
                        .unwrap_or_else(|| self.harness.text(TextId::ContextStreamUnknownError)),
                ))
            }
            _ => {}
        }
        Ok(None)
    }
    fn finish_block(&mut self, index: u64) -> Result<Option<Value>> {
        let Some(block) = self
            .blocks
            .get_mut(&index)
            .filter(|block| block.frame.is_none())
        else {
            return Ok(None);
        };
        match block.content["type"].as_str() {
            Some("text") => {
                block.content["text"] = json!(format!(
                    "{}{}",
                    block.content["text"].as_str().unwrap_or(""),
                    block.parts
                ))
            }
            Some("thinking") => {
                block.content["thinking"] = json!(format!(
                    "{}{}",
                    block.content["thinking"].as_str().unwrap_or(""),
                    block.parts
                ));
                let signature = format!(
                    "{}{}",
                    block.content["signature"].as_str().unwrap_or(""),
                    block.signatures
                );
                if !signature.is_empty() {
                    block.content["signature"] = json!(signature);
                }
            }
            Some("tool_use") if !block.parts.is_empty() && !(self.discovery.is_some() && block.content["name"] == "CallTool") => {
                let parsed = match crate::js::json::parse_data(&block.parts) {
                    Ok(value) => Ok(value),
                    Err(error) if matches!(error.code.as_str(), "JSON_SYNTAX" | "JSON_DOMAIN") => {
                        Err(error.render_for(&self.harness))
                    }
                    Err(error) => return Err(error),
                }
                .and_then(|value| {
                    if value.is_object() {
                        Ok(value)
                    } else {
                        Err(self.harness.text(TextId::ContextToolsNotJsonObject).into())
                    }
                });
                match parsed {
                    Ok(input) => block.content["input"] = input,
                    Err(reason) => {
                        let echo = if utf16_len(&block.parts) > 300 {
                            self.harness.render(
                                TextId::ContextToolsArgumentEcho,
                                &[("arguments", &crate::js::utf16_prefix(&block.parts, 300))],
                            )
                        } else {
                            block.parts.clone()
                        };
                        self.unreadable.insert(
                            block.content["id"].as_str().unwrap_or("").into(),
                            self.harness.render(
                                TextId::ContextToolsUnreadableArguments,
                                &[("reason", &reason), ("echo", &echo)],
                            ),
                        );
                        tracing::warn!(tool=%block.content["name"],tool_use_id=%block.content["id"],"Tool call dropped: arguments were not a JSON object");
                    }
                }
            }
            _ => {}
        }
        block.signatures.clear();
        let mut record = None;
        if block.content["type"] == "tool_use" {
            if let Some(discovery) = &self.discovery {
                let mut metadata = json!({"version":2});
                if !self
                    .unreadable
                    .contains_key(block.content["id"].as_str().unwrap_or(""))
                {
                    let (normalized, origin, error, format_rejection) = discovery.lock().unwrap().normalize_raw(
                        &block.content,
                        (!block.parts.is_empty()).then_some(block.parts.as_str()),
                    );
                    if format_rejection {
                        let id = block.content["id"].as_str().unwrap_or("").to_owned();
                        let source = if block.parts.is_empty() { crate::js::stringify(&block.content["input"]) } else { block.parts.clone() };
                        self.format_fingerprints.insert(id.clone(), super::stagnation::content_digest(&source));
                        self.format_rejections.insert(id);
                    }
                    block.content = normalized;
                    if let Some(error) = error {
                        self.unreadable
                            .insert(block.content["id"].as_str().unwrap_or("").into(), error);
                        metadata["rejectedCalls"] =
                            json!([{"id":block.content["id"],"name":block.content["name"]}]);
                    }
                    if let Some(origin) = origin {
                        metadata["calls"] = json!([origin]);
                    } else if metadata.get("rejectedCalls").is_none() {
                        metadata["directCalls"] =
                            json!([{"id":block.content["id"],"name":block.content["name"]}]);
                    }
                } else {
                    metadata["rejectedCalls"] =
                        json!([{"id":block.content["id"],"name":block.content["name"]}]);
                }
                record = Some(metadata);
            }
        }
        block.parts.clear();
        let mut frame = super::loop_runtime::assistant(
            &self.session,
            &self.id,
            &self.model,
            vec![block.content.clone()],
            &self.usage,
            self.initial_stop.as_deref(),
        );
        if let Some(record) = record {
            frame["message"]["toolContext"] = record;
        }
        block.frame = Some(frame.clone());
        Ok(Some(frame))
    }
    pub fn finish(&mut self) -> Result<Vec<Value>> {
        let mut frames = Vec::new();
        for index in self.blocks.keys().copied().collect::<Vec<_>>() {
            if let Some(frame) = self.finish_block(index)? {
                frames.push(frame);
            }
        }
        Ok(frames)
    }
    pub fn content(&self) -> Vec<Value> {
        self.blocks
            .values()
            .take_while(|block| block.frame.is_some())
            .map(|block| block.content.clone())
            .collect()
    }
    pub fn needs_response_recovery(&self) -> bool {
        self.unreadable_tool_call.is_none() && match self.stop.as_deref() {
            Some("tool_use") => !self.blocks.values().any(|block| block.content["type"] == "tool_use"),
            Some("end_turn") => self.has_no_answer_or_call(),
            _ => false,
        }
    }
    pub fn has_no_answer_or_call(&self) -> bool {
        self.blocks.values().all(|block| match block.content["type"].as_str() {
                Some("thinking") => true,
                Some("text") => crate::js::trim_js(block.content["text"].as_str().unwrap_or("")).is_empty(),
                _ => false,
            })
    }
    pub fn has_reported_usage(&self) -> bool {
        ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
            .iter()
            .any(|key| self.usage[key].as_f64().is_some_and(|value| value.is_finite() && value > 0.0))
    }
    pub fn tool_context_record(&self, count: usize) -> Result<Option<Value>> {
        let mut record = None;
        for block in self.blocks.values().take(count) {
            if let Some(frame) = &block.frame {
                record = super::tool_context::history::merge(
                    record.as_ref(),
                    frame["message"].get("toolContext"),
                )?;
            }
        }
        Ok(record)
    }
    pub fn visible_event(&self, event: &Value) -> bool {
        event["index"].as_u64().is_none_or(|index| {
            !self.deferred.contains(&index) || event["type"] == "content_block_stop"
        })
    }
    pub fn deferred_events(&self, frame: &Value) -> Vec<Value> {
        let Some((index, _)) = self.blocks.iter().find(|(_, block)| {
            block
                .frame
                .as_ref()
                .is_some_and(|candidate| candidate["uuid"] == frame["uuid"])
        }) else {
            return vec![];
        };
        if !self.deferred.contains(index) {
            return vec![];
        }
        let block = &frame["message"]["content"][0];
        if block["type"] != "tool_use" {
            return vec![];
        }
        let mut start = block.clone();
        start["input"] = json!({});
        vec![
            json!({"type":"content_block_start","index":index,"content_block":start}),
            json!({"type":"input_json_delta","index":index,"partialJson":crate::js::stringify(&block["input"])}),
        ]
    }
    pub fn frames_to_commit(&self, complete: bool) -> Vec<Value> {
        let prefix: Vec<_> = self
            .blocks
            .values()
            .take_while(|block| block.frame.is_some())
            .collect();
        if !complete
            && self.committed == 0
            && !prefix
                .iter()
                .any(|block| block.content["type"] == "tool_use")
        {
            return vec![];
        }
        prefix
            .into_iter()
            .skip(self.committed)
            .map(|block| block.frame.as_ref().unwrap().clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interleaved_completion_waits_for_earlier_blocks_and_preserves_signatures() {
        let mut stream = Accumulator::new("session", "fixture");
        stream.accept(&json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"begin","signature":"a"}})).unwrap();
        stream.accept(&json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool","name":"Read","input":{}}})).unwrap();
        stream
            .accept(&json!({"type":"content_block_stop","index":1}))
            .unwrap();
        assert!(stream.frames_to_commit(false).is_empty());
        stream
            .accept(&json!({"type":"signature_delta","index":0,"signature":"b"}))
            .unwrap();
        stream
            .accept(&json!({"type":"signature_delta","index":0,"signature":"c"}))
            .unwrap();
        stream
            .accept(&json!({"type":"content_block_stop","index":0}))
            .unwrap();
        assert_eq!(stream.frames_to_commit(false).len(), 2);
        assert_eq!(stream.content()[0]["signature"], "abc");
        assert!(stream
            .accept(&json!({"type":"thinking_delta","index":0,"thinking":"late"}))
            .is_err());
    }
    #[test]
    fn failed_text_attempts_are_not_durable_and_legacy_calls_wait_for_end() {
        let mut stream = Accumulator::new("session", "fixture");
        stream
            .accept(&json!({"type":"text_delta","index":0,"text":"discard on retry"}))
            .unwrap();
        stream
            .accept(&json!({"type":"content_block_stop","index":0}))
            .unwrap();
        assert!(stream.frames_to_commit(false).is_empty());
        stream.reset().unwrap();
        stream.accept(&json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool","name":"Read","input":{}}})).unwrap();
        assert!(stream.frames_to_commit(false).is_empty());
        stream.finish().unwrap();
        assert_eq!(stream.frames_to_commit(true).len(), 1);
    }
}
