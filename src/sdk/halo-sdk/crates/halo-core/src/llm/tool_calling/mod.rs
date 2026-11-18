pub mod message;
pub mod parser;
pub mod render;
use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    js,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Arc};

pub fn family(model: &str) -> &'static str {
    let lower = model.to_lowercase();
    let name = js::trim_js(&lower).rsplit('/').next().unwrap_or("");
    for (prefixes, family) in [
        (&["claude"][..], "anthropic"),
        (&["gpt", "o1", "o3", "o4", "chatgpt"][..], "openai"),
        (&["gemini"][..], "google"),
        (&["deepseek"][..], "deepseek"),
        (&["qwen"][..], "qwen"),
        (&["glm", "chatglm"][..], "glm"),
        (&["kimi", "moonshot"][..], "kimi"),
        (&["minimax", "abab"][..], "minimax"),
    ] {
        if prefixes.iter().any(|prefix| {
            name.strip_prefix(prefix).is_some_and(|rest| {
                rest.is_empty()
                    || rest
                        .bytes()
                        .next()
                        .is_some_and(|byte| byte.is_ascii_digit() || b"-:.".contains(&byte))
            })
        }) {
            return family;
        }
    }
    "unknown"
}
pub fn mode(options: &Value) -> &str {
    options["toolCallingMode"]
        .as_str()
        .filter(|mode| !mode.is_empty())
        .unwrap_or("native")
}
pub fn adapt_request(
    request: &Value,
    mode: &str,
    provider: &str,
    capabilities: &Value,
    harness: &ResolvedHarness,
) -> Result<Value> {
    let tools = request["tools"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let block = render::render_tools(tools, mode, harness);
    let messages = message::convert(
        request["messages"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        harness,
    );
    if !js::truthy(&capabilities["imageInput"])
        && messages.iter().any(|message| {
            message["content"]
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "image"))
        })
    {
        tracing::error!(
            provider,
            "Prompt tool-calling cannot forward images to a provider without image input"
        );
        return Err(Error::template(
            "UNSUPPORTED_IMAGE_INPUT",
            TextId::ProvidersImagesUnsupported,
            &[("provider", provider.into())],
        ));
    }
    let mut result = request.clone();
    result["tools"] = js::undefined();
    result["systemPrompt"] = message::inject(&request["systemPrompt"], &block);
    result["messages"] = json!(messages);
    Ok(result)
}
fn tool_id() -> String {
    format!("toolu_{}", &uuid::Uuid::new_v4().simple().to_string()[..24])
}
fn names(tools: &[Value]) -> Vec<&str> {
    tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap_or(""))
        .collect()
}
pub fn adapt_response(
    mut response: Value,
    tools: &[Value],
    harness: &ResolvedHarness,
) -> Result<Value> {
    let text = response["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    let parsed = parser::dual(&text, &names(tools), harness)?;
    if parsed.tool_calls.is_empty() {
        if let Some(detail) = parsed.unreadable { response["unreadableToolCall"] = json!(detail); }
        return Ok(response);
    }
    let mut content: Vec<_> = response["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] != "text")
        .cloned()
        .collect();
    content.push(json!({"type":"text","text":parsed.text_content}));
    for call in parsed.tool_calls {
        content.push(
            json!({"type":"tool_use","id":tool_id(),"name":call.name,"input":call.parameters}),
        );
    }
    let mut response = response;
    response["content"] = json!(content);
    response["stopReason"] = json!("tool_use");
    Ok(response)
}

pub struct StreamAdapter {
    tools: Vec<Value>,
    harness: Arc<ResolvedHarness>,
    text: String,
    text_index: i64,
    deferred_stop: Option<Value>,
    delta: Option<Value>,
    queue: VecDeque<Value>,
}
impl StreamAdapter {
    pub fn new(tools: Vec<Value>, harness: Arc<ResolvedHarness>) -> Self {
        Self {
            tools,
            harness,
            text: String::new(),
            text_index: -1,
            deferred_stop: None,
            delta: None,
            queue: VecDeque::new(),
        }
    }
    pub fn next(&mut self) -> Option<Value> {
        self.queue.pop_front()
    }
    pub fn event(&mut self, event: Value) -> Result<()> {
        match event["type"].as_str() {
            Some("content_block_start") => {
                if event["content_block"]["type"] == "text" {
                    self.text_index = event["index"].as_i64().unwrap_or(-1);
                }
                self.queue.push_back(event);
            }
            Some("text_delta") => {
                self.text.push_str(event["text"].as_str().unwrap_or(""));
                self.queue.push_back(event);
            }
            Some("content_block_stop") if event["index"].as_i64() == Some(self.text_index) => {
                self.deferred_stop = Some(event)
            }
            Some("message_delta") => {
                let delta = self
                    .delta
                    .get_or_insert_with(|| json!({"type":"message_delta"}));
                if let Some(reason) = event
                    .get("stopReason")
                    .filter(|reason| !js::is_undefined(reason))
                {
                    delta["stopReason"] = reason.clone();
                }
                if let Some(usage) = event.get("usage").filter(|usage| js::truthy(usage)) {
                    let mut total = delta["usage"].as_object().cloned().unwrap_or_default();
                    if let Some(usage) = usage.as_object() {
                        total.extend(usage.clone());
                    }
                    delta["usage"] = Value::Object(total);
                }
            }
            Some("message_stop") => {
                let parsed = parser::dual(&self.text, &names(&self.tools), &self.harness)?;
                if let Some(stop) = &self.deferred_stop {
                    self.queue.push_back(stop.clone());
                }
                self.text = parsed.text_content;
                if !parsed.tool_calls.is_empty() {
                    let mut index = self.text_index.max(-1) + 1;
                    for call in parsed.tool_calls {
                        self.queue.push_back(json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":tool_id(),"name":call.name,"input":call.parameters}}));
                        self.queue
                            .push_back(json!({"type":"content_block_stop","index":index}));
                        index += 1;
                    }
                    let mut delta = self
                        .delta
                        .clone()
                        .unwrap_or_else(|| json!({"type":"message_delta"}));
                    delta["stopReason"] = json!("tool_use");
                    self.queue.push_back(delta);
                } else if let Some(delta) = &self.delta {
                    self.queue.push_back(delta.clone());
                }
                self.queue
                    .push_back(if let Some(unreadable) = parsed.unreadable {
                        json!({"type":"message_stop","unreadableToolCall":unreadable})
                    } else {
                        event
                    });
            }
            Some("retry") => {
                self.text.clear();
                self.text_index = -1;
                self.deferred_stop = None;
                self.delta = None;
                self.queue.push_back(event);
            }
            _ => self.queue.push_back(event),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn normalize(value: &mut Value) {
        match value {
            Value::Array(values) => {
                for value in values {
                    normalize(value);
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    if key == "id" && value.as_str().is_some_and(|id| id.starts_with("toolu_")) {
                        *value = json!("toolu_fixture");
                    } else {
                        normalize(value);
                    }
                }
            }
            _ => {}
        }
    }
    #[test]
    fn prompt_adapters_match_fixture_requests_parsers_and_streams() {
        let fixture: Value = serde_json::from_str(include_str!("fixtures/reference.json")).unwrap();
        let harness = crate::harness::baseline();
        for case in fixture["parsers"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let names: Vec<_> = case["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect();
            let result = if case["format"] == "xml" {
                parser::xml(text, &names)
            } else {
                parser::json(text, &names, &harness)
            }
            .unwrap();
            assert_eq!(
                js::stringify(&serde_json::to_value(result).unwrap()),
                case["expected"].as_str().unwrap(),
                "parser {}: {text}",
                case["format"]
            );
        }
        for case in fixture["render"].as_array().unwrap() {
            assert_eq!(
                render::render_tools(
                    case["tools"].as_array().unwrap(),
                    case["format"].as_str().unwrap(),
                    &harness
                ),
                case["expected"].as_str().unwrap(),
                "render {case}"
            );
        }
        for case in fixture["messages"].as_array().unwrap() {
            assert_eq!(
                js::stringify(&json!(message::convert(
                    case["messages"].as_array().unwrap(),
                    &harness
                ))),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["inject"].as_array().unwrap() {
            assert_eq!(
                js::stringify(&message::inject(
                    &case["system"],
                    case["block"].as_str().unwrap()
                )),
                case["expected"].as_str().unwrap()
            );
        }
        for (index, case) in fixture["adapters"].as_array().unwrap().iter().enumerate() {
            let tools = case["request"]["tools"].as_array().unwrap();
            assert_eq!(
                js::stringify(
                    &adapt_request(
                        &case["request"],
                        case["mode"].as_str().unwrap(),
                        "fixture",
                        &json!({"imageInput":true}),
                        &harness
                    )
                    .unwrap()
                ),
                js::stringify(&case["sent"]),
                "request {index}"
            );
            let mut response = adapt_response(case["response"].clone(), tools, &harness).unwrap();
            normalize(&mut response);
            let mut expected = case["expected"].clone();
            let mut expected_stream = case["stream"].clone();
            if let Some(detail) = case["stream"].as_array().unwrap().iter()
                .find_map(|event| event.get("unreadableToolCall")) {
                expected["unreadableToolCall"] = detail.clone();
            }
            let text = case["response"]["content"].as_array().unwrap().iter()
                .filter_map(|block| block["text"].as_str()).collect::<String>();
            let rejected = match text.as_str() {
                "<Bash><param name=\"n\">1e400</param></Bash>" => Some(harness.text(TextId::ProvidersJsonUnsupportedData)),
                "```json [{\"name\":\"Bash\",\"params\":[1,2]},{\"name\":\"Read\",\"params\":null}]```" => Some(harness.text(TextId::ProvidersResponseUnreadableArguments)),
                _ => None,
            };
            if matches!(text.as_str(), "```json []```" | "```json [null,true,3,{}, {\"name\":\"unknown\"}] ```") {
                expected.as_object_mut().unwrap().remove("unreadableToolCall");
                expected_stream.as_array_mut().unwrap().last_mut().unwrap()
                    .as_object_mut().unwrap().remove("unreadableToolCall");
            } else if let Some(detail) = rejected {
                // The fixtures record the public parser helpers' results; runtime admission rejects these.
                expected = case["response"].clone();
                expected["unreadableToolCall"] = json!(detail);
                let mut events: Vec<_> = case["events"].as_array().unwrap().iter()
                    .take_while(|event| event["type"] != "message_delta").cloned().collect();
                events.push(json!({"type":"message_delta","stopReason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}));
                events.push(json!({"type":"message_stop","unreadableToolCall":detail}));
                expected_stream = json!(events);
            }
            assert_eq!(
                js::stringify(&response),
                js::stringify(&expected),
                "response {index}"
            );
            let mut adapter = StreamAdapter::new(tools.clone(), harness.clone());
            let mut output = Vec::new();
            for event in case["events"].as_array().unwrap() {
                adapter.event(event.clone()).unwrap();
                while let Some(event) = adapter.next() {
                    output.push(event);
                }
            }
            let mut output = json!(output);
            normalize(&mut output);
            assert_eq!(
                js::stringify(&output),
                js::stringify(&expected_stream),
                "stream {index}"
            );
        }
    }
}
