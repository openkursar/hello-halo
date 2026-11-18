use crate::{
    harness::TextId,
    js::{
        text::{JsText, JsTextBuilder},
        value::{JsObject, JsValue},
    },
};
use regress::Regex;
use std::sync::OnceLock;

fn marker() -> &'static str {
    TextId::DiagnosticsRedactionMarker.default_text()
}

fn secret_header(name: &JsText) -> bool {
    let Some(name) = name.as_utf8() else {
        return false;
    };
    matches!(
        name.to_lowercase().as_str(),
        "authorization"
            | "x-api-key"
            | "cookie"
            | "set-cookie"
            | "proxy-authorization"
            | "x-session-token"
    )
}

pub fn redact_headers(headers: &JsObject) -> JsObject {
    headers
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                if secret_header(name) {
                    JsValue::from(marker())
                } else {
                    value.clone()
                },
            )
        })
        .collect()
}

fn patterns() -> &'static [Regex; 3] {
    static PATTERNS: OnceLock<[Regex; 3]> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            Regex::new(r"sk-ant-[a-zA-Z0-9_-]{20,}").unwrap(),
            Regex::new(r"sk-[a-zA-Z0-9]{20,}").unwrap(),
            // Non-Unicode JavaScript ignore-case matching excludes long s and Kelvin sign.
            Regex::new(r"[Bb][Ee][Aa][Rr][Ee][Rr]\s+[a-zA-Z0-9._\-/+]{20,}").unwrap(),
        ]
    })
}

fn replace(text: &JsText, pattern: &Regex) -> JsText {
    if let Some(source) = text.as_utf8() {
        let mut matches = pattern.find_iter(source).peekable();
        if matches.peek().is_none() {
            return text.clone();
        }
        let mut output = String::with_capacity(source.len());
        let mut offset = 0;
        for found in matches {
            output.push_str(&source[offset..found.range.start]);
            output.push_str(marker());
            offset = found.range.end;
        }
        output.push_str(&source[offset..]);
        output.into()
    } else {
        let units: Vec<_> = text.units().collect();
        let mut matches = pattern.find_from_ucs2(&units, 0).peekable();
        if matches.peek().is_none() {
            return text.clone();
        }
        let mut output = Vec::with_capacity(units.len());
        let mut offset = 0;
        for found in matches {
            output.extend_from_slice(&units[offset..found.range.start]);
            output.extend(marker().encode_utf16());
            offset = found.range.end;
        }
        output.extend_from_slice(&units[offset..]);
        JsText::from_utf16(output)
    }
}

pub fn redact_secrets(text: &JsText) -> JsText {
    patterns()
        .iter()
        .fold(text.clone(), |text, pattern| replace(&text, pattern))
}

pub fn truncate_field(value: &JsText, max_chars: f64) -> JsText {
    if value.len() as f64 <= max_chars {
        return value.clone();
    }
    let mut output = JsTextBuilder::default();
    output.push_text(&value.slice(0.0, Some(max_chars)));
    output.push_str(
        &TextId::DiagnosticsRedactionTruncated
            .default_text()
            .replace("{length}", &value.len().to_string()),
    );
    output.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::wire::WireDocument;

    #[test]
    fn matches_redaction_fixtures_and_utf16_truncation() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("redaction/fixtures/golden.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let input = WireDocument::from_json(case["input"].clone())
                .unwrap()
                .decode()
                .unwrap();
            let expected = WireDocument::from_json(case["expected"].clone())
                .unwrap()
                .decode()
                .unwrap();
            let actual = match case["method"].as_str().unwrap() {
                "headers" => JsValue::Object(redact_headers(input.as_object().unwrap())),
                "secrets" => JsValue::String(redact_secrets(input.as_text().unwrap())),
                "truncate" => {
                    let args = input.as_array().unwrap();
                    JsValue::String(truncate_field(
                        args[0].as_text().unwrap(),
                        args[1].as_number().unwrap(),
                    ))
                }
                _ => unreachable!(),
            };
            assert!(
                actual.same_value(&expected),
                "{}: {:?} != {:?}",
                case["name"],
                actual,
                expected
            );
        }
    }
}
