use crate::js::{stringify, text::JsTextView, utf16_len};
use serde_json::Value;

pub fn estimate_tokens(text: &str) -> f64 {
    estimate_text_tokens(JsTextView::Utf8(text))
}

pub fn estimate_text_tokens(text: JsTextView<'_>) -> f64 {
    let mut length = 0;
    let mut cjk = 0;
    for code in text.units() {
        length += 1;
        if (0x3000..=0x9fff).contains(&code)
            || (0xac00..=0xd7af).contains(&code)
            || (0xf900..=0xfaff).contains(&code)
            || (0xff00..=0xffef).contains(&code)
        {
            cjk += 1;
        }
    }
    ((length - cjk) as f64 * 0.3 + cjk as f64 * 0.6).ceil()
}

pub fn estimate_content_block_tokens(block: &Value) -> f64 {
    let text = |key| block[key].as_str().unwrap_or("");
    match text("type") {
        "text" => estimate_tokens(text("text")),
        "thinking" => estimate_tokens(text("thinking")),
        "tool_use" => estimate_tokens(text("name")) + estimate_tokens(&stringify(&block["input"])),
        "tool_result" => estimate_content_tokens(&block["content"]),
        "image" => 1600.0,
        "document" => {
            (utf16_len(block["source"]["data"].as_str().unwrap_or("")) as f64 * 0.75 * 0.01).ceil()
        }
        "signature" => estimate_tokens(text("signature")),
        _ => 0.0,
    }
}

pub fn estimate_content_tokens(content: &Value) -> f64 {
    match content {
        Value::String(text) => estimate_tokens(text),
        Value::Array(blocks) => blocks.iter().map(estimate_content_block_tokens).sum(),
        _ => 0.0,
    }
}

pub fn estimate_message_tokens(messages: &[Value]) -> f64 {
    messages
        .iter()
        .map(|message| estimate_content_tokens(&message["content"]) + 4.0)
        .sum()
}

#[derive(Default)]
pub struct ApiTokenAnchor {
    pub api_tokens: f64,
    pub local_estimate_at_anchor: f64,
}

impl ApiTokenAnchor {
    pub fn anchor(&mut self, api_input_tokens: f64, local_estimate: f64) {
        if api_input_tokens > 0.0 && local_estimate > 0.0 {
            self.api_tokens = api_input_tokens;
            self.local_estimate_at_anchor = local_estimate;
        }
    }

    pub fn estimate(&self, messages: &[Value]) -> f64 {
        let local = estimate_message_tokens(messages);
        if self.api_tokens > 0.0 && self.local_estimate_at_anchor > 0.0 {
            (local * (self.api_tokens / self.local_estimate_at_anchor)).ceil()
        } else {
            local
        }
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_messages_without_counting_image_payload_bytes() {
        use serde_json::json;
        assert_eq!(estimate_tokens("a".repeat(100).as_str()), 30.0);
        assert_eq!(estimate_tokens("中".repeat(100).as_str()), 60.0);
        assert!(estimate_tokens("Hello world") > 0.0);
        assert!(estimate_tokens(&"A".repeat(1000)) > estimate_tokens("Short"));
        assert_eq!(estimate_message_tokens(&[]), 0.0);
        assert_eq!(estimate_message_tokens(&[json!({"role":"user","content":"Hello"})]), 6.0);
        assert!(estimate_message_tokens(&[json!({"role":"assistant","content":[{"type":"text","text":"Hello world"}]})]) > 0.0);
        assert!(estimate_message_tokens(&[json!({"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls -la /usr/local"}}]})]) > 10.0);
        let image = |data: String| json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"image","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":data}}]}]});
        assert_eq!(estimate_message_tokens(&[image("AAAA".into())]), 1604.0);
        assert_eq!(estimate_message_tokens(&[image("A".repeat(4 * 1024 * 1024))]), 1604.0);
        let first = json!({"role":"user","content":"A".repeat(100)});
        let second = json!({"role":"assistant","content":"B".repeat(100)});
        assert!(estimate_message_tokens(&[first.clone(), second]) > estimate_message_tokens(&[first]));
    }

    #[test]
    fn token_anchor_calibrates_and_resets_only_after_valid_observations() {
        let messages = [serde_json::json!({"role":"user","content":"a".repeat(400)})];
        let mut anchor = ApiTokenAnchor::default();
        assert_eq!(anchor.api_tokens, 0.0);
        assert_eq!(anchor.estimate(&messages), estimate_message_tokens(&messages));
        for (api, local) in [(0.0, 800.0), (1000.0, 0.0)] {
            anchor.anchor(api, local);
            assert_eq!(anchor.api_tokens, 0.0);
        }
        anchor.anchor(1000.0, 800.0);
        assert_eq!(anchor.api_tokens, 1000.0);
        anchor.anchor(2000.0, 1000.0);
        assert_eq!(anchor.estimate(&messages), estimate_message_tokens(&messages) * 2.0);
        anchor.reset();
        assert_eq!(anchor.api_tokens, 0.0);
        assert_eq!(anchor.estimate(&messages), estimate_message_tokens(&messages));
    }

    #[test]
    fn counts_surrogates_and_cjk_like_javascript() {
        assert_eq!(estimate_tokens(""), 0.0);
        assert_eq!(estimate_tokens("😀😀😀"), 2.0);
        assert_eq!(estimate_tokens("中文ab"), 2.0);
        assert_eq!(estimate_text_tokens(JsTextView::Utf16(&[0xd800])), 1.0);
        assert_eq!(
            estimate_text_tokens(JsTextView::Utf16(&[0, 0xd800, 0x4e2d, 0xdfff, 0])),
            2.0
        );
        assert_eq!(
            estimate_content_block_tokens(
                &serde_json::json!({"type":"image","source":{"data":""}})
            ),
            1600.0
        );
    }
}
