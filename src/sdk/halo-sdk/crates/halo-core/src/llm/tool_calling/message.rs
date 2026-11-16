use crate::{
    harness::{ResolvedHarness, TextId},
    js::{self, data, truthy},
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn inject(system: &Value, tools: &str) -> Value {
    if tools.is_empty() {
        return if system.is_null() || js::is_undefined(system) {
            json!("")
        } else {
            system.clone()
        };
    }
    if system.is_null() || js::is_undefined(system) {
        return json!(tools);
    }
    if let Some(text) = system.as_str() {
        return json!(if text.is_empty() {
            tools.to_owned()
        } else {
            format!("{text}\n\n{tools}")
        });
    }
    let mut blocks = system.as_array().cloned().unwrap_or_default();
    blocks.push(json!({"type":"text","text":tools}));
    json!(blocks)
}

pub fn convert(messages: &[Value], harness: &ResolvedHarness) -> Vec<Value> {
    let mut names = HashMap::new();
    for message in messages
        .iter()
        .filter(|message| message["role"] == "assistant")
    {
        for block in message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"] == "tool_use")
        {
            names.insert(
                block["id"].as_str().unwrap_or(""),
                block["name"].as_str().unwrap_or(""),
            );
        }
    }
    messages
        .iter()
        .map(|message| {
            if message["content"].is_string() {
                return message.clone();
            }
            let mut result = message.clone();
            let mut parts = Vec::new();
            let mut images = Vec::new();
            if message["role"] == "assistant" {
                for block in message["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") if truthy(&block["text"]) => {
                            parts.push(block["text"].as_str().unwrap_or("").to_owned())
                        }
                        Some("thinking") if truthy(&block["thinking"]) => {
                            parts.push(block["thinking"].as_str().unwrap_or("").to_owned())
                        }
                        Some("tool_use") => {
                            let name = block["name"].as_str().unwrap_or("");
                            let mut call = vec![format!("<{name}>")];
                            if let Some(input) = block["input"].as_object() {
                                for (key, value) in js::ordered_object(input) {
                                    let value = if value.is_null() {
                                        String::new()
                                    } else if value.is_string()
                                        || value.is_boolean()
                                        || value.is_number()
                                    {
                                        data::to_string(&value)
                                    } else {
                                        data::stringify_pretty(&value)
                                    };
                                    call.push(format!("<param name=\"{key}\">{value}</param>"));
                                }
                            }
                            call.push(format!("</{name}>"));
                            parts.push(call.join("\n"));
                        }
                        _ => {}
                    }
                }
                result["content"] = json!(parts.join("\n\n"));
            } else if message["role"] == "user" {
                for block in message["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") if truthy(&block["text"]) => {
                            parts.push(block["text"].as_str().unwrap_or("").to_owned())
                        }
                        Some("tool_result") => {
                            let id = block["tool_use_id"].as_str().unwrap_or("");
                            let name = names.get(id).copied().unwrap_or(id);
                            let content = block["content"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| {
                                    block["content"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .filter(|block| block["type"] == "text")
                                        .map(|block| block["text"].as_str().unwrap_or(""))
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                });
                            parts.push(harness.render(
                                if truthy(&block["is_error"]) {
                                    TextId::ProvidersHistoryToolError
                                } else {
                                    TextId::ProvidersHistoryToolResult
                                },
                                &[("name", name), ("content", &content)],
                            ));
                            images.extend(
                                block["content"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter(|block| block["type"] == "image")
                                    .cloned(),
                            );
                        }
                        Some("image") => images.push(block.clone()),
                        _ => {}
                    }
                }
                let text = parts.join("\n\n");
                result["content"] = if images.is_empty() {
                    json!(text)
                } else {
                    if !text.is_empty() {
                        images.insert(0, json!({"type":"text","text":text}));
                    }
                    json!(images)
                };
            }
            result
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_without_mutating_system_blocks() {
        let blocks = json!([{"type":"text","text":"original"}]);
        let result = inject(&blocks, "Here are the tools.");
        assert_eq!(blocks, json!([{"type":"text","text":"original"}]));
        assert_eq!(result, json!([{"type":"text","text":"original"},{"type":"text","text":"Here are the tools."}]));
        for system in [Value::Null, js::undefined(), json!("")] {
            assert_eq!(inject(&system, "Here are the tools."), json!("Here are the tools."));
        }
        assert_eq!(inject(&json!("You are helpful."), "Here are the tools."), json!("You are helpful.\n\nHere are the tools."));
        assert_eq!(inject(&blocks, ""), blocks);
        assert_eq!(inject(&json!("You are helpful."), ""), json!("You are helpful."));
    }

    #[test]
    fn converts_full_history_preserving_text_metadata_and_result_names() {
        let harness = crate::harness::baseline();
        let messages = json!([
            {"role":"user","content":"List files please.","isMeta":true},
            {"role":"assistant","content":[{"type":"text","text":"I will list files."},{"type":"tool_use","id":"call","name":"Bash","input":{"command":"ls","todos":[{"content":"Fix bug","status":"in_progress","activeForm":"Fixing"}]}}]},
            {"role":"user","content":[{"type":"text","text":"Please continue."},{"type":"tool_result","tool_use_id":"call","content":"file1.ts\nfile2.ts","is_error":false}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"command not found","is_error":true}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_orphan","content":[{"type":"text","text":"file contents here"}]}]},
            {"role":"assistant","content":[{"type":"text","text":"Done!"}]},
            {"role":"assistant","content":"Just text"}
        ]);
        let result = convert(messages.as_array().unwrap(), &harness);
        assert_eq!(result.len(), 7);
        assert_eq!(result[0], messages[0]);
        let assistant = result[1]["content"].as_str().unwrap();
        for text in ["I will list files.", "<Bash>", "<param name=\"command\">ls</param>", "</Bash>", "<param name=\"todos\">", "\"Fix bug\""] {
            assert!(assistant.contains(text), "{text}: {assistant}");
        }
        assert_eq!(result[2]["content"], "Please continue.\n\n[Tool Result: Bash]\nfile1.ts\nfile2.ts");
        assert_eq!(result[3]["content"], "[Tool Error: Bash]\ncommand not found");
        assert_eq!(result[4]["content"], "[Tool Result: toolu_orphan]\nfile contents here");
        assert_eq!(result[5]["content"], "Done!");
        assert_eq!(result[6], messages[6]);
    }

    #[test]
    fn retains_tool_result_images_next_to_text() {
        let harness = crate::harness::baseline();
        let image = json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGk="}});
        let result = convert(&[json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"shot","content":[{"type":"text","text":"screenshot"},image]}]})], &harness);
        assert_eq!(result[0]["content"], json!([{"type":"text","text":"[Tool Result: shot]\nscreenshot"},image]));
    }
}
