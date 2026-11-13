use crate::{
    error::{Error, Result},
    js::truthy,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub struct ResponseCollector {
    default_model: String,
    id: Value,
    model: Value,
    content: Vec<Value>,
    text: BTreeMap<usize, String>,
    thinking: BTreeMap<usize, (String, String)>,
    tools: BTreeMap<usize, (Value, Value, String)>,
    stop: Value,
    usage: Value,
}
impl ResponseCollector {
    pub fn new(model: String) -> Self {
        Self {
            default_model: model.clone(),
            id: json!("unknown"),
            model: json!(model),
            content: Vec::new(),
            text: BTreeMap::new(),
            thinking: BTreeMap::new(),
            tools: BTreeMap::new(),
            stop: json!("end_turn"),
            usage: json!({"input_tokens":0,"output_tokens":0}),
        }
    }
    pub fn event(&mut self, event: &Value) -> Result<()> {
        let index = event["index"].as_u64().unwrap_or(0) as usize;
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.id = event["id"].clone();
                self.model = event["model"].clone();
                self.usage = event["usage"].clone();
            }
            "content_block_start" => {
                let block = &event["content_block"];
                match block["type"].as_str().unwrap_or("") {
                    "text" => {
                        self.text.insert(index, String::new());
                    }
                    "thinking" => {
                        self.thinking.insert(index, (String::new(), String::new()));
                    }
                    "tool_use" | "server_tool_use" => {
                        self.tools.insert(
                            index,
                            (block["id"].clone(), block["name"].clone(), String::new()),
                        );
                    }
                    _ => self.content.push(block.clone()),
                }
            }
            "text_delta" => self
                .text
                .entry(index)
                .or_default()
                .push_str(event["text"].as_str().unwrap_or("")),
            "thinking_delta" => self
                .thinking
                .entry(index)
                .or_default()
                .0
                .push_str(event["thinking"].as_str().unwrap_or("")),
            "signature_delta" => {
                self.thinking.entry(index).or_default().1 =
                    event["signature"].as_str().unwrap_or("").to_owned()
            }
            "input_json_delta" => {
                if let Some(tool) = self.tools.get_mut(&index) {
                    tool.2.push_str(event["partialJson"].as_str().unwrap_or(""));
                }
            }
            "content_block_stop" => {
                if let Some((id, name, arguments)) = self.tools.remove(&index) {
                    let input=serde_json::from_str::<Value>(&arguments).unwrap_or_else(|error|{tracing::warn!(tool=?name,tool_use_id=?id,error=%error,"tool arguments unparseable; block emitted with empty input");json!({})});
                    self.content
                        .push(json!({"type":"tool_use","id":id,"name":name,"input":input}));
                }
            }
            "message_delta" => {
                if truthy(&event["stopReason"]) {
                    self.stop = event["stopReason"].clone();
                }
                if let Some(usage) = event["usage"].as_object() {
                    if !self.usage.is_object() {
                        self.usage = json!({});
                    }
                    self.usage.as_object_mut().unwrap().extend(usage.clone());
                }
            }
            "retry" => {
                *self = Self::new(self.default_model.clone());
            }
            "error" => {
                return Err(Error::template(
                    "PROVIDER_STREAM_ERROR",
                    crate::harness::TextId::ProvidersStreamEventError,
                    &[
                        ("type", event["errorType"].as_str().unwrap_or("").into()),
                        ("message", event["message"].as_str().unwrap_or("").into()),
                    ],
                ))
            }
            _ => {}
        }
        Ok(())
    }
    pub fn finish(self) -> Value {
        let mut content = Vec::new();
        for (_, (thinking, signature)) in self.thinking {
            if thinking.is_empty() {
                continue;
            }
            let mut block = json!({"type":"thinking","thinking":thinking});
            if !signature.is_empty() {
                block["signature"] = json!(signature);
            }
            content.push(block);
        }
        for (_, text) in self.text {
            content.push(json!({"type":"text","text":text}));
        }
        content.extend(self.content);
        json!({"id":self.id,"content":content,"stopReason":self.stop,"usage":self.usage,"model":self.model})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collector_matches_baseline_including_retry_reset() {
        let fixtures: Value =
            serde_json::from_str(include_str!("fixtures/anthropic-baseline.json")).unwrap();
        for fixture in fixtures["collected"].as_array().unwrap() {
            let mut collector =
                ResponseCollector::new(fixture["request"]["model"].as_str().unwrap().to_owned());
            for event in fixture["events"].as_array().unwrap() {
                collector.event(event).unwrap();
            }
            assert_eq!(
                crate::js::stringify(&collector.finish()),
                crate::js::stringify(&fixture["expected"]),
                "{}",
                fixture["name"]
            );
        }
    }
}
