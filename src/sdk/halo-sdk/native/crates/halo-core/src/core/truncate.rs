use crate::js::text::{JsTextBuilder, JsTextView};

pub const DEFAULT_MAX_RESULT_SIZE_CHARS: usize = 50_000;
pub const MAX_TOOL_RESULT_TOKENS: usize = 100_000;
pub const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS: usize = 200_000;
pub const RECOVERY_HINT: &str =
    crate::harness::TextId::ContextTruncationRecoveryHint.default_text();
pub fn recovery_hint(harness: &crate::harness::ResolvedHarness) -> &str {
    harness.text(crate::harness::TextId::ContextTruncationRecoveryHint)
}

pub fn truncate_content(content: &str, max_chars: usize, recovery_hint: &str) -> String {
    truncate_content_with_harness(
        content,
        max_chars,
        recovery_hint,
        &crate::harness::baseline(),
    )
}

pub fn truncate_content_with_harness(
    content: &str,
    max_chars: usize,
    recovery_hint: &str,
    harness: &crate::harness::ResolvedHarness,
) -> String {
    truncate_builder(JsTextView::Utf8(content), max_chars, recovery_hint, harness)
        .finish_utf8()
        .expect("Pair-preserving truncation of UTF-8 text remains UTF-8")
}

pub fn truncate_utf16(content: &[u16], max_chars: usize) -> Vec<u16> {
    truncate_builder(
        JsTextView::Utf16(content),
        max_chars,
        RECOVERY_HINT,
        &crate::harness::baseline(),
    )
    .finish_utf16()
}

fn truncate_builder(
    content: JsTextView<'_>,
    max_chars: usize,
    recovery_hint: &str,
    harness: &crate::harness::ResolvedHarness,
) -> JsTextBuilder {
    let length = content.len();
    let capacity = max_chars.min(length);
    let mut output = match content {
        JsTextView::Utf8(_) => JsTextBuilder::with_capacity(capacity),
        JsTextView::Utf16(_) => JsTextBuilder::with_utf16_capacity(capacity),
    };
    if length <= max_chars {
        output.push_view(content);
        return output;
    }
    if max_chars == 0 {
        return output;
    }
    let full_notice = |omitted: usize| {
        harness.render(
            crate::harness::TextId::ContextTruncationFullNotice,
            &[("omitted", &omitted.to_string()), ("hint", recovery_hint)],
        )
    };
    let short = full_notice(length).encode_utf16().count() >= max_chars;
    let notice = |omitted: usize| {
        if short {
            harness.render(
                crate::harness::TextId::ContextTruncationShortNotice,
                &[("omitted", &omitted.to_string())],
            )
        } else {
            full_notice(omitted)
        }
    };
    let reserved = notice(length).encode_utf16().count();
    if reserved > max_chars {
        let marker = harness.text(crate::harness::TextId::ContextTruncationMarker);
        let ellipsis = harness.text(crate::harness::TextId::ContextTruncationEllipsis);
        let text = if crate::js::utf16_len(marker) <= max_chars {
            marker
        } else {
            ellipsis
        };
        output.push_view(JsTextView::Utf8(text).prefix_without_split(max_chars));
        return output;
    }
    let retained = max_chars - reserved;
    let head = content.prefix_without_split(retained / 2);
    let tail = content.suffix_without_split(retained - retained / 2);
    output.push_view(head);
    output.push_str(&notice(length - head.len() - tail.len()));
    output.push_view(tail);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_preserves_pairs_and_notice_budget() {
        let text = "😀".repeat(100);
        for budget in 0..200 {
            let result = truncate_content(&text, budget, RECOVERY_HINT);
            assert!(result.encode_utf16().count() <= budget.max(1));
            assert!(!result.contains('\u{fffd}'));
        }
    }

    #[test]
    fn borrowed_utf8_and_utf16_use_the_same_truncation_boundaries() {
        for text in [
            "ascii text ".repeat(80),
            "中😀x".repeat(200),
            "\0😀\0".repeat(200),
        ] {
            let units: Vec<_> = text.encode_utf16().collect();
            for budget in 0..300 {
                let expected = truncate_content(&text, budget, RECOVERY_HINT);
                let actual = truncate_utf16(&units, budget);
                assert_eq!(actual, expected.encode_utf16().collect::<Vec<_>>());
            }
        }
        let units: Vec<_> = [0xd800, 0, 0x4e2d, 0xdfff].repeat(200);
        let result = truncate_utf16(&units, 100);
        assert_eq!(result.len(), 100);
        assert_eq!(result.first(), Some(&0xd800));
        assert_eq!(result.last(), Some(&0xdfff));
    }
}
