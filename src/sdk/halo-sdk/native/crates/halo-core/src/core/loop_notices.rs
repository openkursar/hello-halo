use crate::harness::{ResolvedHarness, TextId};
use serde_json::{json, Value};

pub fn build_notice_message(sections: &[Value]) -> Option<Value> {
    build_notice_message_with_harness(sections, &crate::harness::baseline())
}
pub fn build_notice_message_with_harness(
    sections: &[Value],
    harness: &ResolvedHarness,
) -> Option<Value> {
    let mut parts = Vec::new();
    for section in sections {
        if let Some(text) = section.get("text") {
            if crate::js::truthy(text) {
                parts.push(crate::js::to_string(text));
            }
            continue;
        }
        let Some(items) = section["items"]
            .as_array()
            .filter(|items| !items.is_empty())
        else {
            continue;
        };
        let items = items
            .iter()
            .map(|item| {
                harness.render(
                    TextId::ContextNoticesItem,
                    &[("item", &crate::js::to_string(item))],
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(harness.render(
            TextId::ContextNoticesLabeledItems,
            &[
                ("label", &crate::js::to_string(&section["label"])),
                ("items", &items),
            ],
        ));
    }
    if parts.is_empty() {
        return None;
    }
    Some(
        json!({"role":"user","content":format!("<system-reminder>\n{}\n</system-reminder>",parts.join("\n\n")),"isMeta":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notices_match_fixture_message_shape_and_text() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/loop-notices.json")).unwrap();
        for case in fixture.as_array().unwrap() {
            assert_eq!(
                build_notice_message(case["sections"].as_array().unwrap()).unwrap_or(Value::Null),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }
}
