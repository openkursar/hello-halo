use super::tokens::{estimate_message_tokens, estimate_tokens};
use crate::js::stringify;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn effective_thinking(thinking: &Value, max_tokens: f64) -> Value {
    let mut thinking = thinking.clone();
    if thinking["type"] == "enabled" {
        thinking["budgetTokens"] = json!(thinking["budgetTokens"]
            .as_f64()
            .unwrap_or(0.0)
            .min((max_tokens - 1.0).max(0.0)));
    }
    thinking
}

fn token_count(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

pub fn context_input_tokens(usage: &Value) -> f64 {
    [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .fold(0.0, |total, key| {
        (total + token_count(&usage[*key]).unwrap_or(0.0)).min(f64::MAX)
    })
}

struct Anchor {
    input_tokens: f64,
    local_tokens: f64,
    model: Value,
    thinking: Value,
    message_keys: Vec<[u8; 32]>,
    tool_keys: Vec<[u8; 32]>,
    system_prompt: Value,
}

pub struct TokenBudget {
    pub context_window: f64,
    pub max_output_tokens: f64,
    thinking: Value,
    output_limit: Option<f64>,
    anchor: Option<Anchor>,
    pending_input_tokens: Option<f64>,
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn without_cache(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(without_cache).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .filter(|(key, _)| *key != "cache_control")
                .map(|(key, value)| (key.clone(), without_cache(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn digest(value: &Value) -> [u8; 32] {
    Sha256::digest(stringify(value).as_bytes()).into()
}

fn message_key(message: &Value) -> [u8; 32] {
    let mut normalized = message.clone();
    if let Some(text) = message["content"].as_str() {
        normalized["content"] = json!([{"type":"text","text":text}]);
    }
    digest(&without_cache(&normalized))
}

fn system_tokens(text: &str) -> f64 {
    if text.is_empty() {
        0.0
    } else {
        ((estimate_tokens(text) + 4.0) * 1.2).ceil()
    }
}

pub fn estimate_local_request(request: &Value) -> f64 {
    let messages: f64 = array(&request["messages"])
        .iter()
        .map(|message| (estimate_message_tokens(std::slice::from_ref(message)) * 1.2).ceil())
        .sum();
    let system = if let Some(text) = request["systemPrompt"].as_str() {
        system_tokens(text)
    } else {
        array(&request["systemPrompt"])
            .iter()
            .map(|block| system_tokens(block["text"].as_str().unwrap_or("")))
            .sum()
    };
    let tools: f64 = array(&request["tools"])
        .iter()
        .map(|tool| ((estimate_tokens(&stringify(tool)) + 4.0) * 1.2).ceil())
        .sum();
    messages + system + tools
}

impl TokenBudget {
    pub fn new(context_window: f64, max_output_tokens: f64) -> Self {
        Self {
            context_window,
            max_output_tokens,
            thinking: Value::Null,
            output_limit: None,
            anchor: None,
            pending_input_tokens: None,
        }
    }

    pub fn configure_output(&mut self, thinking: Value, output_limit: Option<f64>) {
        self.thinking = thinking;
        self.output_limit = output_limit;
    }

    pub fn output_reservation_tokens(&self) -> f64 {
        let ceiling = self
            .max_output_tokens
            .min(self.output_limit.unwrap_or(f64::INFINITY));
        let thinking = if self.thinking["type"] == "enabled" {
            self.thinking["budgetTokens"].as_f64().unwrap_or(0.0)
        } else {
            0.0
        };
        let answer = 1024.0_f64.min((ceiling - thinking).max(1.0));
        ceiling.min(
            20_000.0_f64
                .min((self.context_window / 4.0).floor().max(1.0))
                .max(if thinking > 0.0 {
                    thinking + answer
                } else {
                    0.0
                }),
        )
    }

    pub fn request_max_tokens(&self, input_tokens: f64, ceiling: Option<f64>) -> f64 {
        ceiling
            .unwrap_or(self.max_output_tokens)
            .min(self.output_limit.unwrap_or(f64::INFINITY))
            .min((self.context_window - input_tokens).floor())
            .max(0.0)
    }

    pub fn available_input_tokens(&self) -> f64 {
        (self.context_window - self.output_reservation_tokens()).max(0.0)
    }
    pub fn target_input_tokens(&self) -> f64 {
        (self.available_input_tokens() * 0.55).floor()
    }
    pub fn compaction_trigger_tokens(&self) -> f64 {
        (self.available_input_tokens() * 0.9).floor()
    }

    pub fn estimate_request(&self, request: &Value) -> f64 {
        let local = estimate_local_request(request);
        let Some(anchor) = &self.anchor else {
            return local;
        };
        let messages = array(&request["messages"]);
        let tools = array(&request["tools"]);
        if request["model"] != anchor.model
            || stringify(&request["thinking"]) != stringify(&anchor.thinking)
            || messages.len() < anchor.message_keys.len()
            || tools.len() < anchor.tool_keys.len()
            || !anchor
                .message_keys
                .iter()
                .zip(messages)
                .all(|(key, message)| *key == message_key(message))
            || !anchor
                .tool_keys
                .iter()
                .zip(tools)
                .all(|(key, tool)| *key == digest(tool))
        {
            return local;
        }
        if let Some(prefix) = anchor.system_prompt.as_str() {
            if !request["systemPrompt"]
                .as_str()
                .is_some_and(|text| text.starts_with(prefix))
            {
                return local;
            }
        } else if !array(&anchor.system_prompt).is_empty() {
            let prefix = array(&anchor.system_prompt);
            let system = array(&request["systemPrompt"]);
            if system.len() < prefix.len()
                || !prefix
                    .iter()
                    .zip(system)
                    .all(|(a, b)| a["text"] == b["text"])
            {
                return local;
            }
        }
        if local < anchor.local_tokens {
            local
        } else {
            (anchor.input_tokens + (local - anchor.local_tokens)).min(f64::MAX)
        }
    }

    pub fn observe(&mut self, request: &Value, usage: &Value) {
        if token_count(&usage["input_tokens"]).is_none()
            || ["cache_creation_input_tokens", "cache_read_input_tokens"]
                .iter()
                .any(|key| {
                    usage
                        .get(*key)
                        .is_some_and(|value| !crate::js::is_undefined(value) && token_count(value).is_none())
                })
        {
            return;
        }
        let input = context_input_tokens(usage);
        if input <= 0.0 {
            return;
        }
        self.anchor = Some(Anchor {
            input_tokens: input,
            local_tokens: estimate_local_request(request),
            model: request["model"].clone(),
            thinking: request["thinking"].clone(),
            message_keys: array(&request["messages"])
                .iter()
                .map(message_key)
                .collect(),
            tool_keys: array(&request["tools"]).iter().map(digest).collect(),
            system_prompt: request["systemPrompt"].clone(),
        });
        self.pending_input_tokens = None;
    }

    pub fn should_compact_request(&self, request: &Value) -> bool {
        self.estimate_request(request) >= self.compaction_trigger_tokens()
    }
    pub fn reset(&mut self) {
        self.anchor = None;
        self.pending_input_tokens = None;
    }
    pub fn update_from_usage(&mut self, input: f64) {
        if input.is_finite() && input > 0.0 {
            self.pending_input_tokens = Some(input);
        }
    }
    pub fn current_input_tokens(&mut self, messages: &[Value]) -> f64 {
        let request = json!({"messages":messages});
        if let Some(input) = self.pending_input_tokens {
            self.observe(&request, &json!({"input_tokens":input,"output_tokens":0}));
        }
        self.estimate_request(&request)
    }
    pub fn remaining_input_tokens(&mut self, messages: &[Value]) -> f64 {
        (self.available_input_tokens() - self.current_input_tokens(messages)).max(0.0)
    }
    pub fn usage_ratio(&mut self, messages: &[Value]) -> f64 {
        if self.available_input_tokens() <= 0.0 {
            1.0
        } else {
            (self.current_input_tokens(messages) / self.available_input_tokens()).min(1.0)
        }
    }
    pub fn should_compact(&mut self, messages: &[Value]) -> bool {
        self.usage_ratio(messages) >= 0.9
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_input_counts_only_input_and_cache_fields() {
        assert_eq!(context_input_tokens(&json!({"input_tokens":100,"output_tokens":5000,"cache_creation_input_tokens":200,"cache_read_input_tokens":300,"web_search_requests":10})), 600.0);
    }

    #[test]
    fn context_input_accepts_missing_and_partial_usage() {
        for (usage, expected) in [(Value::Null, 0.0), (json!({}), 0.0), (json!({"input_tokens":0}), 0.0), (json!({"cache_read_input_tokens":700}), 700.0), (json!({"cache_creation_input_tokens":300}), 300.0)] {
            assert_eq!(context_input_tokens(&usage), expected);
        }
    }

    #[test]
    fn context_input_ignores_malformed_fields() {
        for invalid in [Value::Null, json!(-1), json!("100"), crate::js::number_value(f64::NAN), crate::js::number_value(f64::INFINITY), crate::js::number_value(f64::NEG_INFINITY)] {
            assert_eq!(context_input_tokens(&json!({"input_tokens":invalid,"cache_creation_input_tokens":20,"cache_read_input_tokens":30})), 50.0);
            assert_eq!(context_input_tokens(&json!({"input_tokens":10,"cache_creation_input_tokens":invalid,"cache_read_input_tokens":invalid})), 10.0);
        }
    }

    #[test]
    fn context_input_saturates_overflow() {
        assert_eq!(context_input_tokens(&json!({"input_tokens":f64::MAX,"cache_creation_input_tokens":f64::MAX,"cache_read_input_tokens":f64::MAX})), f64::MAX);
    }

    #[test]
    fn explicit_thinking_is_bounded_but_adaptive_is_unchanged() {
        assert_eq!(effective_thinking(&json!({"type":"enabled","budgetTokens":10000}), 8192.0), json!({"type":"enabled","budgetTokens":8191.0}));
        assert_eq!(effective_thinking(&json!({"type":"adaptive"}), 300.0), json!({"type":"adaptive"}));
    }

    #[test]
    fn maintenance_reservation_follows_rust_output_policy() {
        for (window, thinking, expected) in [
            (150_000.0, Value::Null, 20_000.0),
            (40_000.0, Value::Null, 10_000.0),
            (150_000.0, json!({"type":"adaptive"}), 20_000.0),
            (150_000.0, json!({"type":"enabled","budgetTokens":32000}), 33_024.0),
        ] {
            let mut budget = TokenBudget::new(window, 320_000.0);
            budget.configure_output(thinking, None);
            assert_eq!(budget.output_reservation_tokens(), expected);
        }
    }

    #[test]
    fn repeated_content_estimates_preserve_the_calibrated_prefix() {
        let mut budget = TokenBudget::new(200_000.0, 16_384.0);
        let mut request = json!({"messages":[{"role":"user","content":"a".repeat(100000)}],"systemPrompt":[{"type":"text","text":"System policy. ".repeat(1000)}],"tools":[{"name":"read","description":"Read a file.","input_schema":{"type":"object"}}]});
        let original_tools = request["tools"].clone();
        let original_system = request["systemPrompt"].clone();
        for turn in 0..10 {
            let observed = 50000.0 + turn as f64;
            budget.observe(&request, &json!({"input_tokens":observed}));
            let addition = json!({"role":"user","content":"a".repeat(100)});
            let growth = estimate_local_request(&json!({"messages":[addition.clone()]}));
            request["messages"].as_array_mut().unwrap().push(addition);
            request["tools"] = original_tools.clone();
            request["systemPrompt"] = original_system.clone();
            assert_eq!(budget.estimate_request(&request), observed + growth);
        }
    }

    #[test]
    fn reset_releases_calibration_and_pending_count_and_reestimates_system() {
        let mut budget = TokenBudget::new(200_000.0, 16_384.0);
        let mut request = json!({"messages":[],"systemPrompt":"System policy."});
        let original = budget.estimate_request(&request);
        budget.observe(&request, &json!({"input_tokens":50000}));
        assert!(budget.anchor.is_some());
        budget.update_from_usage(60000.0);
        assert_eq!(budget.pending_input_tokens, Some(60000.0));
        budget.reset();
        assert!(budget.anchor.is_none());
        assert!(budget.pending_input_tokens.is_none());
        assert_eq!(budget.estimate_request(&request), original);
        request["systemPrompt"] = json!("Changed system policy. ".repeat(100));
        assert_eq!(budget.estimate_request(&request), estimate_local_request(&request));
        assert!(budget.estimate_request(&request) > original);
        assert_eq!(budget.current_input_tokens(&[]), 0.0);
    }

    #[test]
    fn measured_prefix_anchors_only_append_only_growth() {
        let mut budget = TokenBudget::new(200_000.0, 16_384.0);
        let mut request = json!({"model":"local","messages":[{"role":"user","content":"hello"}],"systemPrompt":"system"});
        budget.observe(
            &request,
            &json!({"input_tokens":100,"cache_read_input_tokens":50}),
        );
        assert_eq!(budget.estimate_request(&request), 150.0);
        request["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"assistant","content":"answer"}));
        assert!(budget.estimate_request(&request) > 150.0);
        request["messages"][0]["content"] = json!("changed");
        assert_eq!(
            budget.estimate_request(&request),
            estimate_local_request(&request)
        );
    }
    #[test]
    fn output_reservation_does_not_limit_request_ceiling() {
        let budget = TokenBudget::new(200_000.0, 64_000.0);
        assert_eq!(budget.output_reservation_tokens(), 20_000.0);
        assert_eq!(budget.request_max_tokens(160_000.0, None), 40_000.0);
        assert_eq!(budget.request_max_tokens(10_000.0, Some(128_000.0)), 128_000.0);
    }
}
