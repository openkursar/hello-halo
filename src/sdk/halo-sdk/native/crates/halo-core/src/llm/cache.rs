use crate::js::truthy;
use serde_json::{json, Value};

fn control(extended: bool) -> Value {
    if extended {
        json!({"type":"ephemeral","ttl":"1h"})
    } else {
        json!({"type":"ephemeral"})
    }
}

pub fn add_cache_breakpoints(
    messages: &[Value],
    enabled: bool,
    skip_write: bool,
    extended: bool,
) -> Vec<Value> {
    let mut messages = messages.to_vec();
    if !enabled || messages.is_empty() {
        return messages;
    }
    let index = if skip_write {
        messages.len().saturating_sub(2)
    } else {
        messages.len() - 1
    };
    let content = &mut messages[index]["content"];
    if let Some(text) = content.as_str() {
        *content = json!([{"type":"text","text":text,"cache_control":control(extended)}]);
    } else if let Some(blocks) = content.as_array_mut() {
        if let Some(block) = blocks
            .iter_mut()
            .rev()
            .find(|block| block["type"] != "thinking" && block["type"] != "redacted_thinking")
        {
            block["cache_control"] = control(extended);
        }
    }
    messages
}

pub fn add_system_prompt_cache_breakpoint(prompt: &Value, extended: bool) -> Value {
    if let Some(text) = prompt.as_str() {
        return json!([{"type":"text","text":text,"cache_control":control(extended)}]);
    }
    let mut blocks = prompt.as_array().cloned().unwrap_or_default();
    if blocks.len() == 1 {
        blocks[0]["cache_control"] = control(extended);
    } else if !blocks.is_empty() {
        let last = blocks.len() - 1;
        for block in &mut blocks[last.saturating_sub(3)..last] {
            if !truthy(&block["cache_control"]) {
                block["cache_control"] = control(extended);
            }
        }
    }
    Value::Array(blocks)
}

pub fn limit_cache_breakpoints(body: &mut Value) {
    let mut groups: [Vec<Vec<usize>>; 3] = Default::default();
    if let Some(tools) = body["tools"].as_array() {
        for (index, tool) in tools.iter().enumerate() {
            if truthy(&tool["cache_control"]) {
                groups[0].push(vec![index]);
            }
        }
    }
    if let Some(system) = body["system"].as_array() {
        for (index, block) in system.iter().enumerate() {
            if truthy(&block["cache_control"]) {
                groups[1].push(vec![index]);
            }
        }
    }
    if let Some(messages) = body["messages"].as_array() {
        for (index, message) in messages.iter().enumerate() {
            if let Some(content) = message["content"].as_array() {
                for (block_index, block) in content.iter().enumerate() {
                    if truthy(&block["cache_control"]) {
                        groups[2].push(vec![index, block_index]);
                    }
                }
            }
        }
    }
    if groups.iter().map(Vec::len).sum::<usize>() <= 4 {
        return;
    }
    let mut keep = Vec::new();
    for (group, paths) in groups.iter().enumerate() {
        if let Some(path) = paths.last() {
            keep.push((group, path));
        }
    }
    for group in [2, 1, 0] {
        for path in groups[group].iter().rev().skip(1) {
            if keep.len() >= 4 {
                break;
            }
            keep.push((group, path));
        }
    }
    for (group, paths) in groups.iter().enumerate() {
        for path in paths {
            if keep.contains(&(group, path)) {
                continue;
            }
            let block = match group {
                0 => &mut body["tools"][path[0]],
                1 => &mut body["system"][path[0]],
                _ => &mut body["messages"][path[0]]["content"][path[1]],
            };
            if let Some(object) = block.as_object_mut() {
                object.shift_remove("cache_control");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_limit_keeps_tiers_and_latest_message_prefixes() {
        let marker = json!({"type":"text","text":"x","cache_control":{"type":"ephemeral"}});
        let mut request = json!({"tools":[marker.clone(),marker.clone()],"system":[marker.clone(),marker.clone()],"messages":[{"role":"user","content":[marker.clone(),marker.clone(),marker]}]});
        limit_cache_breakpoints(&mut request);
        assert!(request["tools"][0].get("cache_control").is_none());
        assert!(request["system"][0].get("cache_control").is_none());
        assert!(request["messages"][0]["content"][0]
            .get("cache_control")
            .is_none());
        assert!(request["tools"][1].get("cache_control").is_some());
        assert!(request["system"][1].get("cache_control").is_some());
        assert!(request["messages"][0]["content"][1]
            .get("cache_control")
            .is_some());
        assert!(request["messages"][0]["content"][2]
            .get("cache_control")
            .is_some());
    }

    #[test]
    fn thinking_is_not_marked_and_skip_write_keeps_existing_policy() {
        let messages = vec![
            json!({"role":"assistant","content":[{"type":"text","text":"a"},{"type":"thinking","thinking":"b"}]}),
            json!({"role":"user","content":"c"}),
        ];
        let marked = add_cache_breakpoints(&messages, true, true, false);
        assert!(marked[0]["content"][0].get("cache_control").is_some());
        assert!(marked[0]["content"][1].get("cache_control").is_none());
        assert_eq!(marked[1], messages[1]);
    }
}
