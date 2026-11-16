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

    fn marker_count(request: &Value) -> usize {
        let marked = |blocks: &[Value]| blocks.iter().filter(|block| block.get("cache_control").is_some()).count();
        marked(request["tools"].as_array().unwrap()) + marked(request["system"].as_array().unwrap())
            + request["messages"].as_array().unwrap().iter().map(|message| marked(message["content"].as_array().unwrap())).sum::<usize>()
    }

    #[test]
    fn four_markers_are_unchanged_and_overflow_preserves_content_and_source_values() {
        let marker = json!({"type":"ephemeral"});
        let first = json!({"type":"text","text":"s0","cache_control":marker});
        let mut request = json!({"tools":[{"name":"lookup","cache_control":marker}],"system":[first.clone(),{"type":"text","text":"dynamic"}],"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":marker}]},{"role":"assistant","content":[{"type":"text","text":"hi","cache_control":marker}]}]});
        let before = request.clone();
        limit_cache_breakpoints(&mut request);
        assert_eq!(request, before);
        for message_count in [1, 3] {
            let mut request = json!({"tools":[{"name":"lookup","cache_control":marker}],"system":[first.clone(),{"type":"text","text":"s1","cache_control":marker},{"type":"text","text":"s2","cache_control":marker}],"messages":(0..message_count).map(|index|json!({"role":"user","content":[{"type":"text","text":format!("m{index}"),"cache_control":marker}]})).collect::<Vec<_>>()});
            limit_cache_breakpoints(&mut request);
            assert_eq!(marker_count(&request), 4);
            assert!(request["tools"][0].get("cache_control").is_some());
            assert_eq!(request["system"][0], json!({"type":"text","text":"s0"}));
            assert_eq!(first["cache_control"], marker);
            assert!(request["system"][2].get("cache_control").is_some());
            assert_eq!(request["system"][1].get("cache_control").is_some(), message_count == 1);
            for index in 0..message_count {
                assert_eq!(request["messages"][index]["content"][0]["text"], format!("m{index}"));
                assert_eq!(request["messages"][index]["content"][0].get("cache_control").is_some(), message_count == 1 || index > 0);
            }
        }
    }

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
    fn marker_helpers_compose_before_limiting_without_mutating_their_inputs() {
        let prompt = json!((0..5).map(|index|json!({"type":"text","text":format!("s{index}")})).collect::<Vec<_>>());
        let messages = vec![json!({"role":"user","content":"hello"})];
        let mut request = json!({"tools":[{"name":"lookup","cache_control":{"type":"ephemeral"}}],"system":add_system_prompt_cache_breakpoint(&prompt,false),"messages":add_cache_breakpoints(&messages,true,false,false)});
        assert_eq!(marker_count(&request), 5);
        limit_cache_breakpoints(&mut request);
        assert_eq!(marker_count(&request), 4);
        assert!(prompt.as_array().unwrap().iter().all(|block| block.get("cache_control").is_none()));
        assert_eq!(messages[0]["content"], "hello");
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
