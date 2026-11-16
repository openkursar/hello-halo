use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    js::{
        self,
        text::{JsText, JsTextView, TextSource},
        value::JsValue,
    },
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;

#[path = "parser/xml.rs"]
mod xml_parser;
pub use xml_parser::{parse_xml, ParameterObject, ParameterPrototype, XmlCall, XmlResult};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub name: String,
    pub parameters: Value,
    pub raw_xml: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub text_content: String,
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreadable: Option<String>,
}
impl ParseResult {
    fn plain(text: &str) -> Self {
        Self {
            text_content: text.into(),
            tool_calls: Vec::new(),
            unreadable: None,
        }
    }
}

fn fences(text: &str) -> Vec<(usize, usize, &str)> {
    let mut result = Vec::new();
    let mut cursor = 0;
    while let Some(start) = text[cursor..].find("```json").map(|index| cursor + index) {
        let content = start + 7;
        let Some(end) = text[content..].find("```").map(|index| content + index) else {
            break;
        };
        result.push((start, end + 3, js::trim_js(&text[content..end])));
        cursor = end + 3;
    }
    result
}

pub fn json(text: &str, names: &[&str], harness: &ResolvedHarness) -> Result<ParseResult> {
    json_mode(text, names, harness, false)
}

fn json_mode(text: &str, names: &[&str], harness: &ResolvedHarness, model_data: bool) -> Result<ParseResult> {
    let mut result = ParseResult::plain(text);
    if names.is_empty() || text.is_empty() {
        return Ok(result);
    }
    let blocks = fences(text);
    let Some(last) = blocks.last() else {
        return Ok(result);
    };
    let parsed = match if model_data { js::json::parse_data(last.2) } else { js::json::parse(last.2) } {
        Ok(parsed) => parsed,
        Err(error) if error.code == "JSON_SYNTAX" || error.code == "JSON_DOMAIN" => {
            result.unreadable = Some(harness.render(
                TextId::ProvidersJsonInvalidBlock,
                &[("reason", &error.render_for(harness))],
            ));
            return Ok(result);
        }
        Err(error) => return Err(error),
    };
    let Some(items) = parsed.as_array() else {
        return Ok(result);
    };
    let known: HashSet<_> = names.iter().copied().collect();
    if model_data && !items.iter().any(|item| {
        item["name"].as_str().is_some_and(|name| known.contains(name))
            || item.get("name").is_some() && item.get("params").is_some()
    }) {
        return Ok(result);
    }
    for item in items {
        let Some(name) = item["name"]
            .as_str()
            .filter(|name| !name.is_empty() && known.contains(name))
        else {
            if model_data {
                result.tool_calls.clear();
                result.unreadable = Some(harness.text(TextId::ProvidersJsonNoKnownTool).into());
                return Ok(result);
            }
            continue;
        };
        let parameters = &item["params"];
        if model_data && !parameters.is_null() && !parameters.is_object() {
            result.tool_calls.clear();
            result.unreadable = Some(harness.text(TextId::ProvidersResponseUnreadableArguments).into());
            return Ok(result);
        }
        result.tool_calls.push(ToolCall {
            name: name.into(),
            parameters: if parameters.is_object() || parameters.is_array() {
                parameters.clone()
            } else {
                Value::Object(Map::new())
            },
            raw_xml: if model_data { js::data::stringify(item) } else { js::stringify(item) },
        });
    }
    if result.tool_calls.is_empty() {
        result.unreadable = Some(harness.text(TextId::ProvidersJsonNoKnownTool).into());
    } else {
        result.text_content = js::trim_end_js(&text[..blocks[0].0]).into();
    }
    Ok(result)
}

#[cfg(test)]
mod json_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_known_calls_parameters_order_and_prefix() {
        let harness = crate::harness::baseline();
        let params = json!({"file_path":"/tmp/foo.ts","offset":-1,"limit":500,"timeout":1.5,
            "command":"","run_in_background":false,"background":true,
            "todos":[{"content":"Fix","status":"in_progress","activeForm":"Fixing"}],
            "old_string":"line 1\nline 2\nline 3","new_string":"return foo() + 2;"});
        let calls = json!([{"name":"Read","params":params},{"name":"Bash","params":{"command":"ls -la"}},
            {"name":"mcp__web-search__web_search","params":{"query":"hello world"}}]);
        let text = format!("I will read this file:\n\n```json\n{calls}\n```");
        let result = json(&text, &["Read", "Bash", "mcp__web-search__web_search"], &harness).unwrap();
        assert_eq!(result.text_content, "I will read this file:");
        assert_eq!(result.tool_calls.len(), 3);
        for (call, expected) in result.tool_calls.iter().zip(calls.as_array().unwrap()) {
            assert_eq!(call.name, expected["name"].as_str().unwrap());
            assert_eq!(js::stringify(&call.parameters), js::stringify(&expected["params"]));
            assert_eq!(serde_json::from_str::<Value>(&call.raw_xml).unwrap(), *expected);
        }
        assert!(result.unreadable.is_none());
        let edit = json!( [{"name":"Edit","params":{"file_path":"/src/foo.ts","old_string":"return foo() + 1;","new_string":"return foo() + 2;"}}] );
        let result = json(&format!("```json\n{edit}\n```"), &["Edit"], &harness).unwrap();
        assert_eq!(result.tool_calls[0].name, "Edit");
        assert_eq!(result.tool_calls[0].parameters, edit[0]["params"]);
    }

    #[test]
    fn handles_plain_empty_unknown_and_malformed_blocks() {
        let harness = crate::harness::baseline();
        for text in ["Just some text.", ""] {
            let result = json(text, &["Bash"], &harness).unwrap();
            assert!(result.tool_calls.is_empty());
            assert_eq!(result.text_content, text);
            assert!(result.unreadable.is_none());
        }
        let text = "```json\n[{\"name\":\"Bash\",\"params\":{\"command\":\"ls\"}}]\n```";
        assert!(json(text, &[], &harness).unwrap().tool_calls.is_empty());
        assert_eq!(json(text, &["Bash"], &harness).unwrap().text_content, "");
        for body in ["[{\"name\":\"UnknownTool\",\"params\":{}}]", "[{\"params\":{\"command\":\"ls\"}}]", "[]"] {
            let result = json(&format!("```json\n{body}\n```"), &["Bash"], &harness).unwrap();
            assert!(result.tool_calls.is_empty());
            assert!(result.unreadable.unwrap().contains("no known tool"));
        }
        let result = json("```json\n{\"name\":\"Bash\"}\n```", &["Bash"], &harness).unwrap();
        assert!(result.tool_calls.is_empty());
        let text = "```json\n[{\"name\": \"Bash\", \"params\": {\n```";
        let result = json(text, &["Bash"], &harness).unwrap();
        assert!(result.tool_calls.is_empty());
        assert_eq!(result.text_content, text);
        assert!(result.unreadable.unwrap().contains("not valid JSON"));
    }

    #[test]
    fn filters_entries_defaults_params_and_uses_last_fence() {
        let harness = crate::harness::baseline();
        let result = json("```json\n[\"string\",42,true,{\"name\":\"Bash\"},{\"name\":\"Bash\",\"params\":null}]\n```", &["Bash"], &harness).unwrap();
        assert_eq!(result.tool_calls.len(), 2);
        for call in result.tool_calls {
            assert_eq!(call.name, "Bash");
            assert_eq!(call.parameters, json!({}));
        }
        let result = json("Some reasoning...\n```json\n[{\"name\":\"Bash\",\"params\":{\"command\":\"wrong\"}}]\n```\nLet me reconsider...\n```json\n[{\"name\":\"Bash\",\"params\":{\"command\":\"right\"}}]\n```", &["Bash"], &harness).unwrap();
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].parameters["command"], "right");
    }
}

fn legacy_text(text: JsText) -> Result<String> {
    text.as_utf8().map(str::to_owned).ok_or_else(|| {
        Error::template(
            "UNSUPPORTED_JSON_ENCODING",
            TextId::ProvidersJsonUnsupportedEncoding,
            &[],
        )
    })
}
fn legacy_xml_value(value: JsValue) -> Result<Value> {
    enum Task {
        Value(JsValue),
        Array(usize),
        Object(Vec<String>),
    }
    let mut tasks = vec![Task::Value(value)];
    let mut values = Vec::new();
    while let Some(task) = tasks.pop() {
        match task {
            Task::Value(value) => match value {
                JsValue::Null => values.push(Value::Null),
                JsValue::Bool(value) => values.push(Value::Bool(value)),
                JsValue::Number(value) => values.push(js::number_value(value)),
                JsValue::String(value) => values.push(Value::String(legacy_text(value)?)),
                JsValue::Array(items) => {
                    tasks.push(Task::Array(items.len()));
                    tasks.extend(items.into_iter().rev().map(Task::Value));
                }
                JsValue::Object(items) => {
                    let mut keys = Vec::with_capacity(items.len());
                    let mut children = Vec::with_capacity(items.len());
                    for (key, value) in items {
                        keys.push(legacy_text(key)?);
                        children.push(Task::Value(value));
                    }
                    tasks.push(Task::Object(keys));
                    tasks.extend(children.into_iter().rev());
                }
                _ => {
                    return Err(Error::template(
                        "UNSUPPORTED_JSON_ENCODING",
                        TextId::ProvidersJsonUnsupportedEncoding,
                        &[],
                    ))
                }
            },
            Task::Array(length) => {
                let items = values.split_off(values.len() - length);
                values.push(Value::Array(items));
            }
            Task::Object(keys) => {
                let items = values.split_off(values.len() - keys.len());
                values.push(Value::Object(keys.into_iter().zip(items).collect()));
            }
        }
    }
    Ok(values.pop().unwrap())
}
fn project_xml_own_properties(result: XmlResult, model_data: bool) -> Result<ParseResult> {
    // The existing model-message boundary carries own JSON properties, not object prototypes.
    let tool_calls = result
        .tool_calls
        .into_iter()
        .map(|call| {
            Ok(ToolCall {
                name: legacy_text(call.name)?,
                parameters: if model_data {
                    JsValue::Object(call.parameters.own_entries).try_into_json().map_err(|_| {
                        Error::template("JSON_DOMAIN", TextId::ProvidersJsonUnsupportedData, &[])
                    })?
                } else {
                    legacy_xml_value(JsValue::Object(call.parameters.own_entries))?
                },
                raw_xml: legacy_text(call.raw_xml)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ParseResult {
        text_content: legacy_text(result.text_content)?,
        tool_calls,
        unreadable: None,
    })
}
pub fn xml(text: &str, names: &[&str]) -> Result<ParseResult> {
    let names: Vec<_> = names.iter().map(|name| JsText::from(*name)).collect();
    project_xml_own_properties(parse_xml(JsTextView::Utf8(text), &names), false)
}

fn score(calls: &[ToolCall]) -> usize {
    calls
        .iter()
        .map(|call| {
            let values: Vec<&Value> = match &call.parameters {
                Value::Object(values) => values.values().collect(),
                Value::Array(values) => values.iter().collect(),
                _ => Vec::new(),
            };
            values
                .into_iter()
                .filter(|value| {
                    !value.is_null()
                        && **value != Value::String(String::new())
                })
                .count()
        })
        .sum()
}

pub fn dual(text: &str, names: &[&str], harness: &ResolvedHarness) -> Result<ParseResult> {
    let mut json = json_mode(text, names, harness, true)?;
    let xml_names: Vec<_> = names.iter().map(|name| JsText::from(*name)).collect();
    let mut xml = match project_xml_own_properties(parse_xml(JsTextView::Utf8(text), &xml_names), true) {
        Ok(result) => result,
        Err(error) if error.code == "JSON_DOMAIN" || error.code == "UNSUPPORTED_JSON_ENCODING" => {
            let mut result = ParseResult::plain(text);
            result.unreadable = Some(error.render_for(harness));
            result
        }
        Err(error) => return Err(error),
    };
    if json.tool_calls.is_empty() && xml.tool_calls.is_empty() {
        return Ok(ParseResult {
            text_content: text.into(),
            tool_calls: Vec::new(),
            unreadable: json.unreadable.or(xml.unreadable),
        });
    }
    if json.tool_calls.is_empty() {
        return Ok(xml);
    }
    if xml.tool_calls.is_empty() {
        return Ok(json);
    }
    if score(&json.tool_calls) >= score(&xml.tool_calls) {
        let mut cleaned = String::new();
        let mut cursor = 0;
        let known_names: Vec<_> = names.iter().map(|name| JsText::from(*name)).collect();
        let source = TextSource(JsTextView::Utf8(&json.text_content));
        let mut scanner = xml_parser::Scanner::new(source, &known_names);
        while let Some(tag) = scanner.next() {
            if source.slice(tag.body_start..tag.body_end).trim().is_empty() {
                cleaned.push_str(&json.text_content[cursor..tag.start]);
                cursor = tag.end;
            }
        }
        cleaned.push_str(&json.text_content[cursor..]);
        json.text_content = js::trim_end_js(&cleaned).into();
        Ok(json)
    } else {
        let blocks = fences(&xml.text_content);
        let mut cleaned = String::new();
        let mut cursor = 0;
        for (start, end, _) in blocks {
            cleaned.push_str(&xml.text_content[cursor..start]);
            cursor = end;
        }
        cleaned.push_str(&xml.text_content[cursor..]);
        xml.text_content = js::trim_end_js(&cleaned).into();
        Ok(xml)
    }
}
