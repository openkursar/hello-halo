use crate::js::{stringify, trim_js, truthy};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn is_o_series(model: &str) -> bool {
    let lower = model.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    ["o1", "o3", "o4"]
        .iter()
        .any(|prefix| name == *prefix || name.starts_with(&format!("{prefix}-")))
}
pub fn is_quirky(model: &str) -> bool {
    let lower = model.to_lowercase();
    [
        "qwen", "deepseek", "glm", "kimi", "moonshot", "minimax", "abab",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}
pub fn is_xml_think(model: &str) -> bool {
    let lower = model.to_lowercase();
    ["qwen", "glm"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

#[derive(Default)]
pub struct ThinkTagParser {
    inside: bool,
    prefix: String,
    skip_newlines: bool,
}
impl ThinkTagParser {
    pub fn process(&mut self, text: &str, index: usize) -> Vec<Value> {
        let input = std::mem::take(&mut self.prefix) + text;
        let mut events = Vec::new();
        let mut offset = 0;
        while offset < input.len() {
            if self.skip_newlines {
                while matches!(input.as_bytes().get(offset), Some(b'\n' | b'\r')) {
                    offset += 1;
                }
                if offset == input.len() {
                    break;
                }
                self.skip_newlines = false;
            }
            let tag = if self.inside { "</think>" } else { "<think>" };
            if let Some(relative) = input[offset..].find(tag) {
                let at = offset + relative;
                if at > offset {
                    events.push(self.event(&input[offset..at], index));
                }
                self.inside = !self.inside;
                self.skip_newlines = !self.inside;
                offset = at + tag.len();
            } else {
                let mut retained = (tag.len() - 1).min(input.len() - offset);
                while retained > 0 && !input.ends_with(&tag[..retained]) {
                    retained -= 1;
                }
                let end = input.len() - retained;
                if end > offset {
                    events.push(self.event(&input[offset..end], index));
                }
                self.prefix = input[end..].to_owned();
                break;
            }
        }
        events
    }
    pub fn flush(&mut self, index: usize) -> Vec<Value> {
        let remainder = std::mem::take(&mut self.prefix);
        if remainder.is_empty() {
            Vec::new()
        } else {
            vec![self.event(&remainder, index)]
        }
    }
    pub fn is_inside(&self) -> bool {
        self.inside
    }
    fn event(&self, content: &str, index: usize) -> Value {
        if self.inside {
            json!({"type":"reasoning_delta","index":index,"reasoning":content})
        } else {
            json!({"type":"text_delta","index":index,"text":content})
        }
    }
}

pub fn apply_response(model: &str, response: &Value) -> Value {
    apply_response_parts(model, response).0
}
pub fn apply_response_receipt(model: &str, response: &Value) -> Value {
    let (response, sources, copied, input_changed) = apply_response_parts(model, response);
    json!({"response":response,"sources":sources,"copied":copied,"inputChanged":input_changed})
}
fn apply_response_parts(
    model: &str,
    response: &Value,
) -> (Value, Vec<Option<usize>>, Vec<bool>, Vec<bool>) {
    let mut blocks: Vec<(Value, Option<usize>, bool, bool)> = Vec::new();
    for (index, block) in response["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if is_xml_think(model) {
            let transformed = extract_xml(std::slice::from_ref(block));
            if transformed.len() == 1 && transformed[0] == *block {
                blocks.push((
                    transformed.into_iter().next().unwrap(),
                    Some(index),
                    false,
                    false,
                ));
            } else {
                blocks.extend(
                    transformed
                        .into_iter()
                        .map(|value| (value, None, false, false)),
                );
            }
        } else {
            blocks.push((block.clone(), Some(index), false, false));
        }
    }
    if model.to_lowercase().starts_with("deepseek") {
        for (block, _, copied, input_changed) in &mut blocks {
            let (value, changed) = repair_arguments(std::mem::take(block));
            *block = value;
            *copied |= changed;
            *input_changed = changed;
        }
    }
    for (block, _, copied, _) in &mut blocks {
        if block["type"] == "tool_use" && !truthy(&block["id"]) {
            block["id"] = json!(format!("toolu_{}", simple_id()));
            *copied = true;
        }
    }
    let tools = blocks
        .iter()
        .any(|(block, _, _, _)| block["type"] == "tool_use");
    if tools
        && !blocks
            .iter()
            .any(|(block, _, _, _)| block["type"] == "text")
    {
        blocks.insert(0, (json!({"type":"text","text":""}), None, false, false));
    }
    let mut result = response.clone();
    if tools && result["stopReason"] == "end_turn" {
        result["stopReason"] = json!("tool_use");
    }
    let mut content = Vec::new();
    let mut sources = Vec::new();
    let mut copies = Vec::new();
    let mut inputs = Vec::new();
    for (block, source, copied, input_changed) in blocks {
        content.push(block);
        sources.push(source);
        copies.push(copied);
        inputs.push(input_changed);
    }
    result["content"] = json!(content);
    (result, sources, copies, inputs)
}

fn extract_xml(blocks: &[Value]) -> Vec<Value> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| Regex::new(r"(?s)<think>(.*?)</think>").unwrap());
    let mut result = Vec::new();
    for block in blocks {
        if block["type"] != "text" {
            result.push(block.clone());
            continue;
        }
        let text = block["text"].as_str().unwrap_or("");
        let thinking: Vec<_> = pattern
            .captures_iter(text)
            .map(|capture| trim_js(capture.get(1).unwrap().as_str()))
            .collect();
        if thinking.is_empty() {
            result.push(block.clone());
            continue;
        }
        for part in thinking {
            if !part.is_empty() {
                result.push(json!({"type":"thinking","thinking":part}));
            }
        }
        let cleaned = pattern.replace_all(text, "");
        let cleaned = trim_js(&cleaned);
        if !cleaned.is_empty() {
            result.push(json!({"type":"text","text":cleaned}));
        }
    }
    result
}

fn repair_arguments(mut block: Value) -> (Value, bool) {
    if block["type"] != "tool_use" {
        return (block, false);
    }
    let input = &block["input"];
    if input.as_object().is_some_and(|object| !object.is_empty())
        || input.as_array().is_some_and(|array| !array.is_empty())
    {
        return (block, false);
    }
    let text = input
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| stringify(input));
    match serde_json::from_str::<Value>(&text) {
        Ok(value) if value.is_object() || value.is_array() => {
            block["input"] = value;
            return (block, true);
        }
        Err(_) => {
            let extracted = extract_key_values(&text);
            if !extracted.is_empty() {
                block["input"] = Value::Object(extracted);
                return (block, true);
            }
        }
        _ => {}
    }
    (block, false)
}

fn extract_key_values(text: &str) -> Map<String, Value> {
    static STRING: OnceLock<Regex> = OnceLock::new();
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    const SPACE: &str = r"[\x09-\x0d \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
    let strings = STRING.get_or_init(|| {
        Regex::new(&format!(
            r#""?([A-Za-z0-9_]+)"?{SPACE}*[:=]{SPACE}*"([^"]*?)""#
        ))
        .unwrap()
    });
    let numbers = NUMBER.get_or_init(|| {
        Regex::new(&format!(
            r#""?([A-Za-z0-9_]+)"?{SPACE}*[:=]{SPACE}*(true|false|[0-9]+(?:\.[0-9]+)?)(?-u:\b)"#
        ))
        .unwrap()
    });
    let mut values = Map::new();
    for captures in strings.captures_iter(text) {
        values.insert(captures[1].to_owned(), json!(&captures[2]));
    }
    for captures in numbers.captures_iter(text) {
        let key = &captures[1];
        if values.contains_key(key) {
            continue;
        }
        let raw = &captures[2];
        values.insert(
            key.to_owned(),
            match raw {
                "true" => json!(true),
                "false" => json!(false),
                _ => json!(raw.parse::<f64>().unwrap()),
            },
        );
    }
    values
}

fn simple_id() -> String {
    let mut time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(time % 36) as usize] as char);
        time /= 36;
        if time == 0 {
            break;
        }
    }
    let mut result: String = digits.into_iter().rev().collect();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut generated = 0;
    while generated < 12 {
        for (index, byte) in uuid::Uuid::new_v4().as_bytes().iter().enumerate() {
            if !matches!(index, 6 | 8) && *byte < 248 {
                result.push(alphabet[(*byte % 62) as usize] as char);
                generated += 1;
                if generated == 12 {
                    break;
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn think_tags_across_chunks_preserve_order_and_newline_rules() {
        let mut parser = ThinkTagParser::default();
        assert_eq!(
            parser.process("a<th", 0),
            vec![json!({"type":"text_delta","index":0,"text":"a"})]
        );
        assert_eq!(
            parser.process("ink>心</thi", 0),
            vec![json!({"type":"reasoning_delta","index":0,"reasoning":"心"})]
        );
        assert_eq!(
            parser.process("nk>\r\nfinal", 0),
            vec![json!({"type":"text_delta","index":0,"text":"final"})]
        );
        assert!(parser.flush(0).is_empty());
    }
    #[test]
    fn o_series_only_strips_provider_prefix_for_that_family() {
        assert!(is_o_series("openai/o3-mini"));
        assert!(!is_o_series("o10"));
        assert!(!is_quirky("vendor/qwen"));
    }
    #[test]
    fn malformed_arguments_use_ascii_keys_and_javascript_whitespace() {
        let result = apply_response(
            "deepseek-fixture",
            &json!({"content":[{"type":"tool_use","id":"present","name":"run","input":"word: \"value\", flag=true count=12"}],"stopReason":"end_turn"}),
        );
        assert_eq!(
            result["content"][1]["input"],
            json!({"word":"value","flag":true,"count":12.0})
        );
        assert_eq!(result["stopReason"], "tool_use");
    }
}
