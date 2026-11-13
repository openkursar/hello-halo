use crate::harness::{ResolvedHarness, TextId};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub fn cache_breakpoint(mut messages: Vec<Value>) -> Vec<Value> {
    if let Some(last) = messages.last_mut() {
        if let Some(text) = last["content"].as_str() {
            last["content"] =
                json!([{"type":"text","text":text,"cache_control":{"type":"ephemeral"}}]);
        } else if let Some(block) = last["content"].as_array_mut().and_then(|blocks| {
            blocks
                .iter_mut()
                .rev()
                .find(|block| block["type"] != "thinking")
        }) {
            block["cache_control"] = json!({"type":"ephemeral"});
        }
    }
    messages
}

#[derive(Default)]
pub struct PairingChanges {
    pub duplicate_calls: usize,
    pub discarded_results: usize,
    pub late_results: usize,
    pub missing_results: usize,
    pub empty_responses: usize,
}
fn missing(
    waiting: &mut Map<String, Value>,
    changes: &mut PairingChanges,
    harness: &ResolvedHarness,
) -> Vec<Value> {
    let results=waiting.keys().map(|id|json!({"type":"tool_result","tool_use_id":id,"content":harness.text(TextId::ContextHistoryMissingToolResult),"is_error":true})).collect::<Vec<_>>();
    changes.missing_results += results.len();
    waiting.clear();
    results
}
pub fn repair(messages: &[Value]) -> (Vec<Value>, PairingChanges) {
    repair_with_harness(messages, &crate::harness::baseline())
}
pub fn repair_with_harness(
    messages: &[Value],
    harness: &ResolvedHarness,
) -> (Vec<Value>, PairingChanges) {
    let mut output = Vec::<Value>::new();
    let mut issued = HashSet::new();
    let mut waiting = Map::new();
    let mut changes = PairingChanges::default();
    for message in messages {
        if message["role"] == "assistant" {
            if !waiting.is_empty() {
                output.push(json!({"role":"user","content":missing(&mut waiting,&mut changes,harness),"isMeta":true}));
            }
            let Some(blocks) = message["content"].as_array() else {
                output.push(message.clone());
                continue;
            };
            let mut kept = Vec::new();
            for block in blocks {
                if block["type"] == "tool_use" {
                    let id = block["id"].as_str().unwrap_or("");
                    if !issued.insert(id.to_owned()) {
                        changes.duplicate_calls += 1;
                        continue;
                    }
                    waiting.insert(id.into(), block.clone());
                }
                kept.push(block.clone());
            }
            let mut message = message.clone();
            if kept.is_empty() {
                changes.empty_responses += 1;
                message["content"] = json!([{"type":"text","text":harness.text(TextId::ContextHistoryEmptyAssistant)}]);
            } else {
                message["content"] = json!(kept);
            }
            output.push(message);
            continue;
        }
        let previous_assistant = output
            .last()
            .is_some_and(|message| message["role"] == "assistant");
        let supplied = message["content"]
            .as_str()
            .map(|text| vec![json!({"type":"text","text":text})])
            .unwrap_or_else(|| message["content"].as_array().cloned().unwrap_or_default());
        let mut removed = 0;
        let mut accepted = Vec::new();
        for block in supplied {
            if block["type"] == "tool_result" {
                let id = block["tool_use_id"].as_str().unwrap_or("");
                if waiting.shift_remove(id).is_none() {
                    removed += 1;
                    if issued.contains(id) {
                        changes.late_results += 1;
                    }
                    continue;
                }
            }
            accepted.push(block);
        }
        changes.discarded_results += removed;
        let mut missing = missing(&mut waiting, &mut changes, harness);
        if removed == 0 && missing.is_empty() {
            output.push(message.clone());
        } else if !accepted.is_empty() || !missing.is_empty() {
            missing.extend(accepted);
            let mut message = message.clone();
            message["content"] = json!(missing);
            output.push(message);
        } else if previous_assistant {
            output.push(json!({"role":"user","content":harness.text(TextId::ContextHistoryEmptyUser),"isMeta":true}));
        } else if output.is_empty() {
            let mut message = message.clone();
            message["content"] = json!([{"type":"text","text":harness.text(TextId::ContextHistoryOrphanToolResult)}]);
            output.push(message);
        }
    }
    if !waiting.is_empty() {
        output.push(json!({"role":"user","content":missing(&mut waiting,&mut changes,harness),"isMeta":true}));
    }
    if changes.duplicate_calls
        + changes.discarded_results
        + changes.late_results
        + changes.missing_results
        + changes.empty_responses
        > 0
    {
        tracing::warn!(
            duplicate_calls = changes.duplicate_calls,
            discarded_results = changes.discarded_results,
            late_results = changes.late_results,
            missing_results = changes.missing_results,
            empty_responses = changes.empty_responses,
            "Tool history repaired before reuse"
        );
    }
    (output, changes)
}
pub fn strip_reasoning(messages: &mut [Value], keep: impl Fn(&Value) -> bool) -> usize {
    strip_reasoning_with_harness(messages, keep, &crate::harness::baseline())
}
pub fn strip_reasoning_with_harness(
    messages: &mut [Value],
    keep: impl Fn(&Value) -> bool,
    harness: &ResolvedHarness,
) -> usize {
    strip_reasoning_indexed_with_harness(messages, |_, message| keep(message), harness)
}
pub fn strip_reasoning_indexed_with_harness(
    messages: &mut [Value],
    mut keep: impl FnMut(usize, &Value) -> bool,
    harness: &ResolvedHarness,
) -> usize {
    let mut removed = 0;
    for (index, message) in messages.iter_mut().enumerate() {
        if message["role"] != "assistant" || keep(index, message) {
            continue;
        }
        let Some(content) = message["content"].as_array() else {
            continue;
        };
        let filtered: Vec<_> = content
            .iter()
            .filter(|block| {
                !["thinking", "redacted_thinking", "signature"]
                    .contains(&block["type"].as_str().unwrap_or(""))
            })
            .cloned()
            .collect();
        if filtered.len() == content.len() {
            continue;
        }
        removed += content.len() - filtered.len();
        message["content"] = if filtered.is_empty() {
            json!([{"type":"text","text":harness.text(TextId::ContextHistoryReasoningOmitted)}])
        } else {
            json!(filtered)
        };
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_and_duplicate_results_do_not_replay_or_claim_success() {
        let history = vec![
            json!({"role":"assistant","content":[{"type":"tool_use","id":"write","name":"Write","input":{}}]}),
            json!({"role":"user","content":"Continue"}),
            json!({"role":"assistant","content":[{"type":"tool_use","id":"write","name":"Write","input":{}}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"write","content":"late"}]}),
        ];
        let (repaired, changes) = repair(&history);
        assert_eq!(changes.missing_results, 1);
        assert_eq!(changes.duplicate_calls, 1);
        assert_eq!(changes.late_results, 1);
        assert_eq!(changes.empty_responses, 1);
        assert_eq!(repaired[1]["content"][0]["is_error"], true);
        assert_eq!(
            repaired[1]["content"][0]["content"],
            "[No recorded output for this tool call; its outcome is unknown.]"
        );
        assert_eq!(repaired[3]["content"], "(no content)");
        assert_eq!(history[1]["content"], "Continue");
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;
    fn text(id: TextId) -> String { crate::harness::baseline().text(id).to_owned() }
    fn call(id: &str) -> Value {
        json!({"type":"tool_use","id":id,"name":"Read","input":{"file_path":"/example"}})
    }
    fn reply(id: &str) -> Value {
        json!({"type":"tool_result","tool_use_id":id,"content":format!("result {id}")})
    }
    /// Every assistant call has one paired result in the next user message, no call repeats,
    /// and every recorded result belongs to the preceding assistant call.
    fn assert_sendable(history: &[Value]) {
        let mut seen = std::collections::HashSet::new();
        for (index, message) in history.iter().enumerate() {
            let blocks: Vec<Value> = message["content"].as_array().cloned().unwrap_or_default();
            if message["role"] == "assistant" {
                let calls: Vec<String> = blocks
                    .iter()
                    .filter(|block| block["type"] == "tool_use")
                    .map(|block| block["id"].as_str().unwrap().to_owned())
                    .collect();
                for id in &calls {
                    assert!(seen.insert(id.clone()), "duplicate call {id}");
                }
                if calls.is_empty() {
                    continue;
                }
                let next = &history[index + 1];
                assert_eq!(next["role"], "user", "missing result message after {calls:?}");
                let mut paired: Vec<String> = next["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|block| block["type"] == "tool_result")
                    .map(|block| block["tool_use_id"].as_str().unwrap().to_owned())
                    .collect();
                let mut expected = calls.clone();
                paired.sort();
                expected.sort();
                assert_eq!(paired, expected);
            } else {
                let available: Vec<&str> = history
                    .get(index.wrapping_sub(1))
                    .filter(|previous| previous["role"] == "assistant")
                    .and_then(|previous| previous["content"].as_array())
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|block| block["type"] == "tool_use")
                            .filter_map(|block| block["id"].as_str())
                            .collect()
                    })
                    .unwrap_or_default();
                for block in &blocks {
                    if block["type"] == "tool_result" {
                        assert!(
                            available.contains(&block["tool_use_id"].as_str().unwrap()),
                            "orphan result {}",
                            block["tool_use_id"]
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn orphan_results_after_a_plain_assistant_reply_are_discarded() {
        let history = vec![
            json!({"role":"assistant","content":"No command was run."}),
            json!({"role":"user","content":[reply("never-started"),{"type":"text","text":"Continue investigating."}]}),
        ];
        let (fixed, changes) = repair(&history);
        assert_sendable(&fixed);
        assert_eq!(changes.discarded_results, 1);
        assert_eq!(
            fixed[1]["content"],
            json!([{"type":"text","text":"Continue investigating."}])
        );
    }
    #[test]
    fn a_call_missing_its_pair_gets_one_synthetic_error_result_in_a_meta_user_message() {
        let history = vec![
            json!({"role":"user","content":"go"}),
            json!({"role":"assistant","content":[call("orphan-1")]}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(fixed.len(), 3);
        assert_eq!(fixed[2]["role"], "user");
        assert_eq!(fixed[2]["isMeta"], true);
        assert_eq!(changes.missing_results, 1);
        let block = &fixed[2]["content"][0];
        assert_eq!(block["type"], "tool_result");
        assert_eq!(block["tool_use_id"], "orphan-1");
        assert_eq!(block["is_error"], true);
        assert_sendable(&fixed);
    }

    #[test]
    fn partial_results_keep_recorded_ones_and_prepend_the_synthetic_pair() {
        let history = vec![
            json!({"role":"assistant","content":[call("a"), call("b")]}),
            json!({"role":"user","content":[reply("b")]}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(fixed.len(), 2);
        assert_eq!(changes.missing_results, 1);
        let blocks = fixed[1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["tool_use_id"], "a");
        assert_eq!(blocks[0]["is_error"], true);
        assert_eq!(blocks[1]["tool_use_id"], "b");
        assert_eq!(blocks[1]["content"], "result b");
        assert_sendable(&fixed);
    }

    #[test]
    fn a_user_slot_emptied_by_orphans_becomes_a_meta_placeholder_between_assistant_turns() {
        let history = vec![
            json!({"role":"assistant","content":"no tools"}),
            json!({"role":"user","content":[reply("ghost")]}),
            json!({"role":"assistant","content":"next"}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(fixed.len(), 3);
        assert_eq!(changes.discarded_results, 1);
        assert_eq!(fixed[1]["role"], "user");
        assert_eq!(fixed[1]["isMeta"], true);
        assert_eq!(fixed[1]["content"].as_str(), Some(text(TextId::ContextHistoryEmptyUser).as_str()));
    }

    #[test]
    fn a_leading_tool_result_only_message_becomes_the_orphan_placeholder() {
        let history = vec![
            json!({"role":"user","content":[reply("lost")]}),
            json!({"role":"assistant","content":"continuing"}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(fixed.len(), 2);
        assert_eq!(changes.discarded_results, 1);
        let blocks = fixed[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], text(TextId::ContextHistoryOrphanToolResult));
        assert_sendable(&fixed);
    }

    #[test]
    fn duplicate_results_in_one_message_are_dropped_once() {
        let history = vec![
            json!({"role":"assistant","content":[call("one")]}),
            json!({"role":"user","content":[reply("one"), reply("one")]}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(changes.discarded_results, 1);
        assert_eq!(changes.late_results, 1);
        assert_eq!(fixed[1]["content"].as_array().unwrap().len(), 1);
        assert_sendable(&fixed);
    }

    #[test]
    fn an_assistant_turn_emptied_by_duplicate_calls_gets_the_interrupted_placeholder() {
        let history = vec![
            json!({"role":"assistant","content":[call("dup")]}),
            json!({"role":"user","content":[reply("dup")]}),
            json!({"role":"assistant","content":[call("dup")]}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(changes.duplicate_calls, 1);
        assert_eq!(changes.empty_responses, 1);
        assert_eq!(fixed[2]["content"][0]["type"], "text");
        assert_eq!(fixed[2]["content"][0]["text"], text(TextId::ContextHistoryEmptyAssistant));
        assert_sendable(&fixed);
    }

    #[test]
    fn a_pure_text_conversation_is_returned_unchanged() {
        let history = vec![
            json!({"role":"user","content":"hi"}),
            json!({"role":"assistant","content":"hello"}),
            json!({"role":"user","content":"again"}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(fixed, history);
        assert_eq!(changes.missing_results + changes.discarded_results + changes.late_results + changes.duplicate_calls + changes.empty_responses, 0);
    }

    #[test]
    fn valid_and_multimodal_results_are_kept_unchanged() {
        let history = vec![
            json!({"role":"assistant","content":[call("image")]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"image","content":[
                {"type":"text","text":"image attached"},
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}
            ]}]}),
        ];
        let (fixed, changes) = repair(&history);
        assert_eq!(fixed, history);
        assert_eq!(
            (
                changes.duplicate_calls,
                changes.discarded_results,
                changes.late_results,
                changes.missing_results,
                changes.empty_responses
            ),
            (0, 0, 0, 0, 0)
        );
        assert_sendable(&fixed);
    }
    #[test]
    fn mixed_interrupted_transcripts_are_repaired_without_mutation_and_idempotently() {
        for seed in 0..64usize {
            let mut history = vec![
                json!({"role":"user","content":[reply("unrecorded"),{"type":"text","text":"task"}]}),
                json!({"role":"assistant","content":[call("one"),call("two")]}),
                json!({"role":"user","content":[reply("one")]}),
                json!({"role":"assistant","content":[call("three")]}),
            ];
            if seed & 1 != 0 {
                history[1]["content"].as_array_mut().unwrap().push(call("one"));
            }
            if seed & 2 != 0 {
                history[2]["content"].as_array_mut().unwrap().push(reply("two"));
            }
            if seed & 4 != 0 {
                history[2]["content"].as_array_mut().unwrap().push(reply("one"));
            }
            if seed & 8 != 0 {
                history[3]["content"].as_array_mut().unwrap().push(call("one"));
            }
            if seed & 16 != 0 {
                history.push(json!({"role":"user","content":[reply("unknown")]}));
            }
            if seed & 32 != 0 {
                history.push(json!({"role":"assistant","content":"Continue."}));
            }
            let before = history.clone();
            let (fixed, _) = repair(&history);
            assert_sendable(&fixed);
            assert_eq!(history, before, "seed {seed} mutated its input");
            let (again, changes) = repair(&fixed);
            assert_eq!(again, fixed, "seed {seed} is not idempotent");
            assert_eq!(
                (
                    changes.duplicate_calls,
                    changes.discarded_results,
                    changes.late_results,
                    changes.missing_results,
                    changes.empty_responses
                ),
                (0, 0, 0, 0, 0),
                "seed {seed} needed a second repair"
            );
        }
    }
}
