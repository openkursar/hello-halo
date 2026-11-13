use crate::harness::{fixed_text, ResolvedHarness, ResourceId, TextId};
use serde_json::{json, Value};
use std::collections::HashMap;

fn active_reminder(text: &str) -> Value {
    let open = fixed_text(ResourceId::SkillProtocol, &["reminder", "open"]);
    let close = fixed_text(ResourceId::SkillProtocol, &["reminder", "close"]);
    json!({"role":"user","content":[{"type":"text","text":format!("{open}\n{text}\n{close}")}]})
}

pub fn build(catalog: &Value) -> Option<Value> {
    build_with_harness(catalog, &crate::harness::baseline())
}
pub fn build_with_harness(catalog: &Value, harness: &ResolvedHarness) -> Option<Value> {
    let entries = catalog.as_array().filter(|entries| !entries.is_empty())?;
    let mut lines = vec![
        harness.text(TextId::ContextSkillsHeading).to_owned(),
        harness
            .text(TextId::ContextSkillsCatalogGuidance)
            .to_owned(),
    ];
    let mut length = crate::js::utf16_len(&lines.join("\n"));
    let mut included = 0;
    for entry in entries {
        let mut description = String::new();
        let mut whitespace = false;
        for character in entry["description"].as_str().unwrap_or("").chars() {
            if crate::js::is_whitespace(character) {
                if !whitespace {
                    description.push(' ');
                }
                whitespace = true;
            } else {
                description.push(character);
                whitespace = false;
            }
        }
        let line = harness.render(
            TextId::ContextSkillsCatalogEntry,
            &[
                ("name", entry["name"].as_str().unwrap_or("")),
                ("description", &crate::js::utf16_prefix(&description, 200)),
            ],
        );
        let added = crate::js::utf16_len(&line) + 1;
        if length + added > 15_900 {
            break;
        }
        lines.push(line);
        length += added;
        included += 1;
    }
    if included < entries.len() {
        lines.push(harness.render(
            TextId::ContextSkillsCatalogOmitted,
            &[("count", &(entries.len() - included).to_string())],
        ));
    }
    let text = harness.render(
        TextId::ContextSkillsCatalogWrapper,
        &[("catalog", &lines.join("\n"))],
    );
    Some(json!({"role":"user","content":[{"type":"text","text":text}]}))
}

fn add_reference(references: &mut Vec<Value>, value: &Value) {
    let Some(name) = value
        .as_str()
        .and_then(crate::skills::normalize_name)
        .filter(|name| name != "list" && name.len() <= 256)
    else {
        return;
    };
    references.retain(|reference| {
        reference["name"].as_str().unwrap_or("").to_lowercase() != name.to_lowercase()
    });
    references.push(json!({"name":name}));
    if references.len() > 3 {
        references.remove(0);
    }
}

fn collect_marked_text(text: &str, references: &mut Vec<Value>) {
    if let Some(after) = text.strip_prefix(fixed_text(
        ResourceId::SkillProtocol,
        &["invocation", "name_prefix"],
    )) {
        if let Some((name, _)) = after
            .split_once(fixed_text(
                ResourceId::SkillProtocol,
                &["invocation", "body_prefix"],
            ))
            .filter(|(name, _)| !name.is_empty() && !name.contains(['\n', '"']))
        {
            add_reference(references, &json!(name));
        }
    }
    let Some(after) =
        text.strip_prefix(fixed_text(ResourceId::SkillProtocol, &["reminder", "open"]))
    else {
        return;
    };
    let Some(after) = crate::js::trim_start_js(after)
        .strip_prefix(fixed_text(ResourceId::SkillProtocol, &["active", "open"]))
    else {
        return;
    };
    let Some((encoded, _)) = after
        .split_once(fixed_text(ResourceId::SkillProtocol, &["active", "close"]))
        .filter(|(encoded, _)| {
            !encoded.is_empty() && !encoded.contains('\n') && crate::js::utf16_len(encoded) <= 1024
        })
    else {
        return;
    };
    if let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(encoded) {
        for entry in entries.iter().skip(entries.len().saturating_sub(3)) {
            add_reference(references, &entry["name"]);
        }
    }
}

pub fn collect_active(messages: &[Value], previous: &[Value]) -> Vec<Value> {
    let mut references = Vec::new();
    for entry in previous.iter().skip(previous.len().saturating_sub(3)) {
        add_reference(&mut references, &entry["name"]);
    }
    let mut pending = HashMap::new();
    for message in messages {
        if let Some(text) = message["content"].as_str() {
            if message["role"] == "user" {
                collect_marked_text(text, &mut references);
            }
            continue;
        }
        let Some(blocks) = message["content"].as_array() else {
            continue;
        };
        for block in blocks {
            if message["role"] == "assistant"
                && block["type"] == "tool_use"
                && block["name"] == "Skill"
            {
                if let Some(name) = block["input"]["skill"]
                    .as_str()
                    .and_then(crate::skills::normalize_name)
                    .filter(|name| name != "list")
                {
                    pending.insert(block["id"].as_str().unwrap_or("").to_owned(), name);
                }
            } else if message["role"] == "user" && block["type"] == "tool_result" {
                if let Some(name) = pending.remove(block["tool_use_id"].as_str().unwrap_or("")) {
                    if !crate::js::truthy(&block["is_error"]) {
                        add_reference(&mut references, &json!(name));
                    }
                }
            } else if message["role"] == "user" && block["type"] == "text" {
                if let Some(text) = block["text"].as_str() {
                    collect_marked_text(text, &mut references);
                }
            }
        }
    }
    references
}

pub fn build_active(references: &[Value]) -> Option<Value> {
    build_active_with_harness(references, &crate::harness::baseline())
}
pub fn build_active_with_harness(references: &[Value], harness: &ResolvedHarness) -> Option<Value> {
    let mut bounded = Vec::new();
    for reference in references.iter().skip(references.len().saturating_sub(3)) {
        add_reference(&mut bounded, &reference["name"]);
    }
    while !bounded.is_empty() {
        let mut message = active_reminder(&format!(
            "{}{}{}\n{}",
            fixed_text(ResourceId::SkillProtocol, &["active", "open"]),
            crate::js::stringify(&Value::Array(bounded.clone())),
            fixed_text(ResourceId::SkillProtocol, &["active", "close"]),
            harness.text(TextId::ContextSkillsReloadGuidance)
        ));
        if message["content"][0]["text"].as_str().unwrap().len() <= 1024 {
            message["isMeta"] = json!(true);
            return Some(message);
        }
        bounded.remove(0);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded(name: &str, id: &str, failed: bool) -> Vec<Value> {
        vec![
            json!({"role":"assistant","content":[{"type":"tool_use","id":id,"name":"Skill","input":{"skill":name}}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"Instruction body","is_error":failed}]}),
        ]
    }
    #[test]
    fn catalogs_preserve_whitespace_and_budget_contracts() {
        let message =
            build(&json!([{"name":"sample","description":"\u{feff}one\n\t two \u{0085}"}]))
                .unwrap();
        assert_eq!(message["content"][0]["text"], "<system-reminder>\n# skills\nAvailable workflows. Load a matching entry with Skill before using its instructions.\n- sample:  one two \u{0085}\n</system-reminder>");
        let entries: Vec<_> = (0..200)
            .map(|index| json!({"name":format!("skill-{index}"),"description":"x".repeat(200)}))
            .collect();
        let message = build(&json!(entries)).unwrap();
        let text = message["content"][0]["text"].as_str().unwrap();
        assert!(text.len() < 16000);
        assert!(text.contains("more skills are available through Skill with skill=\"list\"."));
    }
    #[test]
    fn successful_skill_references_survive_repeated_history_rewrites() {
        let mut history = loaded("commit", "first", false);
        history.extend(loaded("list", "listing", false));
        history.extend(loaded("missing", "failed", true));
        assert_eq!(
            collect_active(&history, &[]),
            vec![json!({"name":"commit"})]
        );
        let previous = vec![json!({"name":"old"}), json!({"name":"commit"})];
        let mut history = loaded("review", "review", false);
        history.extend(loaded("tests", "tests", false));
        history.extend(loaded("commit", "again", false));
        let references = collect_active(&history, &previous);
        assert_eq!(
            references,
            vec![
                json!({"name":"review"}),
                json!({"name":"tests"}),
                json!({"name":"commit"})
            ]
        );
        let reminder = build_active(&references).unwrap();
        assert_eq!(reminder["isMeta"], true);
        assert_eq!(collect_active(&[reminder], &[]), references);
        let references: Vec<_> = ['一', '二', '三']
            .iter()
            .map(|character| json!({"name":character.to_string().repeat(80)}))
            .collect();
        let reminder = build_active(&references).unwrap();
        assert!(reminder["content"][0]["text"].as_str().unwrap().len() <= 1024);
        assert_eq!(collect_active(&[reminder], &[]).last(), references.last());
    }
    #[test]
    fn skill_protocol_parsing_and_reminders_match_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("fixtures/skill-protocol.json")).unwrap();
        for fixture in fixtures["marked"].as_array().unwrap() {
            let actual = collect_active(
                fixture["messages"].as_array().unwrap(),
                fixture["previous"].as_array().unwrap(),
            );
            assert_eq!(json!(actual), fixture["expected"]);
        }
        for fixture in fixtures["active"].as_array().unwrap() {
            assert_eq!(
                build_active(fixture["references"].as_array().unwrap()),
                fixture
                    .get("expected")
                    .filter(|value| !value.is_null())
                    .cloned()
            );
        }
    }
    #[test]
    fn model_catalog_framing_does_not_change_the_skill_recovery_protocol() {
        let harness = crate::harness::Harness::from_config(&json!({"models":{"fixture":{
            "context.skills.catalog_wrapper":"Selected catalog: {catalog}",
            "context.skills.reload_guidance":"Reload the recorded skill when needed."
        }}}))
        .unwrap()
        .for_model("fixture");
        let catalog = build_with_harness(
            &json!([{"name":"sample","description":"Sample instructions"}]),
            &harness,
        )
        .unwrap();
        assert!(catalog["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Selected catalog: # skills\n"));
        let references = vec![json!({"name":"sample"})];
        let active = build_active_with_harness(&references, &harness).unwrap();
        assert_eq!(active["content"][0]["text"], "<system-reminder>\n<active-skills>[{\"name\":\"sample\"}]</active-skills>\nReload the recorded skill when needed.\n</system-reminder>");
        assert_eq!(collect_active(&[active], &[]), references);
    }
}
