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
