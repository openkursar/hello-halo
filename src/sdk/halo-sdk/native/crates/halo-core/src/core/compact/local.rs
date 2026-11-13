use crate::{
    core::tokens::{estimate_content_block_tokens, estimate_message_tokens, ApiTokenAnchor},
    harness::{ResolvedHarness, TextId},
    js::{stringify, trim_js, utf16_len, utf16_prefix},
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const KEEP_RECENT: usize = 10;
pub const PREAMBLE: &str = TextId::ContextCompactionPreamble.default_text();
pub fn reminder(path: Option<&str>) -> String {
    reminder_with_harness(path, &crate::harness::baseline())
}
pub fn reminder_with_harness(path: Option<&str>, harness: &ResolvedHarness) -> String {
    let recovery = path
        .filter(|path| !path.is_empty())
        .map(|path| harness.render(TextId::ContextCompactionRecoveryPath, &[("path", path)]))
        .unwrap_or_else(|| {
            harness
                .text(TextId::ContextCompactionRecoveryGeneric)
                .into()
        });
    harness.render(
        TextId::ContextCompactionReminder,
        &[("recovery", &recovery)],
    )
}
pub fn format_summary(raw: &str) -> String {
    format_summary_with_harness(raw, &crate::harness::baseline())
}
pub fn format_summary_with_harness(raw: &str, harness: &ResolvedHarness) -> String {
    let mut text = trim_js(raw);
    if let Some(rest) = text.strip_prefix("<analysis>") {
        if let Some(end) = rest.find("</analysis>") {
            let content = &rest[..end];
            let tail = &rest[end + 11..];
            if !content.contains("<analysis>")
                && !content.contains("</analysis>")
                && (tail.is_empty() || tail.starts_with('\n') || tail.starts_with("\r\n"))
            {
                text = trim_js(tail);
            }
        }
    }
    if let Some(content) = text
        .strip_prefix("<summary>")
        .and_then(|text| text.strip_suffix("</summary>"))
    {
        if !content.contains("<summary>") && !content.contains("</summary>") {
            return harness.render(
                TextId::ContextCompactionSummaryEnvelope,
                &[("summary", trim_js(content))],
            );
        }
    }
    text.into()
}
pub fn transcript(messages: &[Value]) -> String {
    transcript_with_harness(messages, &crate::harness::baseline())
}
pub fn transcript_with_harness(messages: &[Value], harness: &ResolvedHarness) -> String {
    let mut parts = Vec::new();
    for message in messages {
        let role = if message["role"] == "user" {
            harness.text(TextId::ContextCompactionHumanRole)
        } else {
            harness.text(TextId::ContextCompactionAssistantRole)
        };
        if let Some(text) = message["content"].as_str() {
            if !text.is_empty() {
                parts.push(harness.render(
                    TextId::ContextCompactionTranscriptText,
                    &[("role", role), ("text", text)],
                ));
            }
            continue;
        }
        for block in message["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => parts.push(harness.render(
                    TextId::ContextCompactionTranscriptText,
                    &[
                        ("role", role),
                        ("text", block["text"].as_str().unwrap_or("")),
                    ],
                )),
                Some("tool_use") => parts.push(harness.render(
                    TextId::ContextCompactionTranscriptToolCall,
                    &[
                        ("tool", block["name"].as_str().unwrap_or("")),
                        ("id", block["id"].as_str().unwrap_or("")),
                        ("input", &stringify(&block["input"])),
                    ],
                )),
                Some("tool_result") => {
                    let text = block["content"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            let parts = block["content"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|block| block["type"] == "text")
                                .filter_map(|block| block["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n");
                            if parts.is_empty() {
                                harness.text(TextId::ContextCompactionComplexContent).into()
                            } else {
                                parts
                            }
                        });
                    let error = if crate::js::truthy(&block["is_error"]) {
                        harness.text(TextId::ContextCompactionErrorMarker)
                    } else {
                        ""
                    };
                    parts.push(harness.render(
                        TextId::ContextCompactionTranscriptToolResult,
                        &[
                            ("id", block["tool_use_id"].as_str().unwrap_or("")),
                            ("error", error),
                            ("text", &text),
                        ],
                    ));
                }
                _ => {}
            }
        }
    }
    parts.join("\n\n")
}
pub fn adjust_pairing(messages: &[Value], keep_from: usize) -> usize {
    if keep_from == 0 || keep_from >= messages.len() {
        return keep_from;
    }
    let mut owners = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        if message["role"] != "assistant" {
            continue;
        }
        for block in message["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_use" {
                owners.insert(block["id"].as_str().unwrap_or(""), index);
            }
        }
    }
    let mut boundary = keep_from;
    let mut index = messages.len();
    while index > boundary {
        index -= 1;
        let message = &messages[index];
        if message["role"] != "user" {
            continue;
        }
        for block in message["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_result" {
                boundary = boundary.min(
                    *owners
                        .get(block["tool_use_id"].as_str().unwrap_or(""))
                        .unwrap_or(&boundary),
                );
            }
        }
    }
    boundary
}
pub fn unfinished_tail(messages: &[Value]) -> usize {
    let mut pending = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        for block in message["content"].as_array().into_iter().flatten() {
            if message["role"] == "assistant" && block["type"] == "tool_use" {
                pending.insert(block["id"].as_str().unwrap_or(""), index);
            } else if message["role"] == "user" && block["type"] == "tool_result" {
                pending.remove(block["tool_use_id"].as_str().unwrap_or(""));
            }
        }
    }
    pending.into_values().min().unwrap_or(messages.len())
}
fn content_size(content: &Value) -> usize {
    if let Some(text) = content.as_str() {
        return utf16_len(text);
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .map(|block| match block["type"].as_str() {
            Some("text") => utf16_len(block["text"].as_str().unwrap_or("")),
            Some("tool_result") => content_size(&block["content"]),
            Some("image") => (estimate_content_block_tokens(block) / 0.3).ceil() as usize,
            Some("document") => utf16_len(block["source"]["data"].as_str().unwrap_or("")),
            _ => 0,
        })
        .sum()
}
fn placeholder(chars: usize, tool: Option<&Value>, harness: &ResolvedHarness) -> String {
    let chars = chars.to_string();
    if let Some(tool) = tool {
        let mut preview = stringify(&tool["input"]);
        if utf16_len(&preview) > 120 {
            preview = format!(
                "{}{}",
                utf16_prefix(&preview, 120),
                harness.text(TextId::ContextTruncationEllipsis)
            );
        }
        harness.render(
            TextId::ContextCompactionToolPlaceholder,
            &[
                ("tool", tool["name"].as_str().unwrap_or("")),
                ("input", &preview),
                ("chars", &chars),
            ],
        )
    } else {
        harness.render(
            TextId::ContextCompactionResultPlaceholder,
            &[("chars", &chars)],
        )
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicroCompactReceipt {
    pub messages: Vec<Value>,
    pub truncated_count: usize,
    pub same_array: bool,
    pub copied_messages: Vec<usize>,
    pub changed_blocks: Vec<(usize, usize)>,
}
pub fn micro_compact(messages: &[Value], budget: f64) -> (Vec<Value>, usize) {
    let receipt = micro_compact_receipt(messages, budget, &crate::harness::baseline());
    (receipt.messages, receipt.truncated_count)
}
pub fn micro_compact_receipt(
    messages: &[Value],
    budget: f64,
    harness: &ResolvedHarness,
) -> MicroCompactReceipt {
    let total: usize = messages
        .iter()
        .filter(|message| message["role"] == "user")
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_result")
        .map(|block| content_size(&block["content"]))
        .sum();
    if total as f64 <= budget {
        return MicroCompactReceipt {
            messages: messages.to_vec(),
            truncated_count: 0,
            same_array: true,
            copied_messages: vec![],
            changed_blocks: vec![],
        };
    }
    let mut cycles = 0;
    let mut protect = 0;
    for (index, message) in messages.iter().enumerate().rev() {
        if message["role"] == "user"
            && message["content"]
                .as_array()
                .is_some_and(|content| content.iter().any(|block| block["type"] == "tool_result"))
        {
            cycles += 1;
            if cycles == 2 {
                protect = if index > 0 && messages[index - 1]["role"] == "assistant" {
                    index - 1
                } else {
                    index
                };
                break;
            }
        }
    }
    let mut calls = HashMap::new();
    for message in messages {
        if message["role"] == "assistant" {
            for block in message["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_use" {
                    calls.insert(block["id"].as_str().unwrap_or(""), block);
                }
            }
        }
    }
    let mut remaining = total as f64 - budget;
    let mut count = 0;
    let mut output = messages.to_vec();
    let mut copied_messages = Vec::new();
    let mut changed_blocks = Vec::new();
    for (message_index, message) in output.iter_mut().enumerate().take(protect) {
        if remaining <= 0.0 || message["role"] != "user" || message["content"].is_string() {
            continue;
        }
        copied_messages.push(message_index);
        for (block_index, block) in message["content"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .enumerate()
        {
            if remaining <= 0.0 || block["type"] != "tool_result" {
                continue;
            }
            let size = content_size(&block["content"]);
            if size == 0
                || block["content"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("[tool result truncated to save context"))
            {
                continue;
            }
            let text = placeholder(
                size,
                calls
                    .get(block["tool_use_id"].as_str().unwrap_or(""))
                    .copied(),
                harness,
            );
            let saved = size as i64 - utf16_len(&text) as i64;
            if saved <= 0 {
                continue;
            }
            count += 1;
            changed_blocks.push((message_index, block_index));
            remaining -= saved as f64;
            if remaining < 0.0 {
                remaining = 0.0;
            }
            block["content"] = json!(text);
        }
    }
    MicroCompactReceipt {
        messages: output,
        truncated_count: count,
        same_array: false,
        copied_messages,
        changed_blocks,
    }
}
pub fn api_compact(
    messages: &[Value],
    anchor: Option<&ApiTokenAnchor>,
    window: Option<f64>,
) -> Option<Vec<Value>> {
    api_compact_indices(messages, anchor, window).map(|indices| {
        indices
            .into_iter()
            .map(|index| messages[index].clone())
            .collect()
    })
}
pub fn api_compact_indices(
    messages: &[Value],
    anchor: Option<&ApiTokenAnchor>,
    window: Option<f64>,
) -> Option<Vec<usize>> {
    let total = anchor
        .map(|anchor| anchor.estimate(messages))
        .unwrap_or_else(|| estimate_message_tokens(messages));
    api_compact_indices_with_total(messages, total, window)
}
pub fn api_compact_indices_with_total(
    messages: &[Value],
    total: f64,
    window: Option<f64>,
) -> Option<Vec<usize>> {
    let window = window.filter(|window| *window != 0.0 && !window.is_nan());
    let max = window
        .map(|window| (window * 0.9).floor())
        .unwrap_or(180_000.0);
    let target = window
        .map(|window| (window * 0.2).floor())
        .unwrap_or(40_000.0);
    if total < max || messages.len() <= KEEP_RECENT + 1 {
        return None;
    }
    let mut accumulated = 0.0;
    let mut keep = messages.len();
    for (index, message) in messages.iter().enumerate().rev() {
        let size = estimate_message_tokens(std::slice::from_ref(message));
        if accumulated + size > target {
            keep = index + 1;
            break;
        }
        accumulated += size;
        keep = index;
    }
    keep = keep.min(messages.len() - KEEP_RECENT);
    if keep == 0 {
        return None;
    }
    keep = adjust_pairing(messages, keep);
    if keep == 0 {
        return None;
    }
    let mut output: Vec<usize> = (keep..messages.len()).collect();
    if let Some(first) = messages
        .iter()
        .position(|message| message["role"] == "user")
    {
        if first < keep {
            output.insert(0, first);
        }
    }
    Some(output)
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn receipts_preserve_recorded_copy_boundaries() {
        let cases: Value = serde_json::from_str(include_str!("fixtures/identity.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            let result = if case["kind"] == "micro" {
                let budget = if case["budget"] == "NaN" {
                    f64::NAN
                } else {
                    case["budget"].as_f64().unwrap()
                };
                serde_json::to_value(micro_compact_receipt(
                    messages,
                    budget,
                    &crate::harness::baseline(),
                ))
                .unwrap()
            } else {
                json!(api_compact_indices(messages, None, case["window"].as_f64()))
            };
            assert_eq!(result, case["expected"]);
        }
    }
}
