use crate::error::{Error, Result};
use crate::harness::{baseline, Message, ResolvedHarness, ResourceId, TextId};
use serde_json::{Map, Value};

pub fn definitions() -> Vec<Value> {
    definitions_with_harness(&baseline())
}
pub fn definitions_with_harness(harness: &ResolvedHarness) -> Vec<Value> {
    match harness.resource(ResourceId::CollaborationTools) {
        Value::Array(tools) => tools,
        _ => unreachable!("validated collaboration tool resource"),
    }
}

fn model_selection_policy(capability: &Value) -> Result<(TextId, bool)> {
    let inherit_reasoning = match capability.get("reasoningPolicy") {
        None => false,
        Some(policy) if policy == "inherit" => true,
        _ => return Err(Error::new("MODEL_SELECTION", "Unknown reasoning policy.")),
    };
    let guidance = match (capability["policy"].as_str(), inherit_reasoning) {
        (Some("inherit"), false) => TextId::CollaborationModelSelectionInherit,
        (Some("task"), false) => TextId::CollaborationModelSelectionTask,
        (Some("inherit"), true) => TextId::CollaborationModelSelectionInheritWithParentReasoning,
        (Some("task"), true) => TextId::CollaborationModelSelectionTaskWithParentReasoning,
        _ => return Err(Error::new("MODEL_SELECTION", "Unknown model selection policy.")),
    };
    Ok((guidance, inherit_reasoning))
}

pub fn model_selection_guidance(capability: &Value) -> Result<String> {
    let (guidance, _) = model_selection_policy(capability)?;
    Ok(baseline().text(guidance).to_owned())
}

pub fn definitions_with_model_selection(
    harness: &ResolvedHarness,
    capability: &Value,
) -> Result<Vec<Value>> {
    let (guidance, inherit_reasoning) = model_selection_policy(capability)?;
    let baseline = baseline();
    let guidance = baseline.text(guidance);
    let mut tools = definitions_with_harness(harness);
    let spawn = tools.iter_mut().find(|tool| tool["name"] == "spawn_agent").unwrap();
    let profile_field = if inherit_reasoning {
        TextId::CollaborationModelSelectionProfileReferenceField
    } else {
        TextId::CollaborationModelSelectionProfileField
    };
    let properties = &mut spawn["inputSchema"]["properties"];
    properties["model_profile"] = serde_json::json!({"type":"string","description":harness.text(profile_field)});
    if !inherit_reasoning {
        properties["reasoning_effort"] = serde_json::json!({"type":"string","description":harness.text(TextId::CollaborationModelSelectionEffortField)});
    }
    let description = format!("{} {guidance}", harness.text(TextId::CollaborationModelSelectionListDescription));
    tools.push(serde_json::json!({"name":"list_model_profiles","description":description,"inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}}));
    Ok(tools)
}

fn ignores_undeclared(tool: &str, key: &str) -> bool {
    match tool {
        // The prompt is the whole assignment, so these keys only label it.
        "spawn_agent" => ["summary", "description", "title"].contains(&key),
        // A dropped key could leave a record other than the one the caller wrote.
        "team_post_task" | "team_update_task" | "team_post_finding" => false,
        _ => true,
    }
}

#[derive(Debug)]
pub struct ParsedInput {
    pub input: Value,
    pub unfiltered_directory: bool,
}

fn display_keys(keys: &[&str]) -> Message {
    // Tool input is untrusted; don't echo arbitrary text or an unbounded list.
    let mut visible: Vec<_> = keys
        .iter()
        .copied()
        .filter(|key| {
            !key.is_empty() && key.len() <= 64
                && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
        .take(8)
        .collect();
    if visible.len() < keys.len() {
        visible.push(TextId::CollaborationArgumentsUnlisted.default_text());
    }
    visible.join(", ").into()
}

fn accepted_keys(fields: &Map<String, Value>) -> Message {
    fields.keys().map(String::as_str).collect::<Vec<_>>().join(", ").into()
}

pub fn parse_input(name: &str, input: &Value) -> Result<ParsedInput> {
    parse_input_with_model_selection(name, input, None)
}

pub fn parse_input_with_model_selection(name: &str, input: &Value, capability: Option<&Value>) -> Result<ParsedInput> {
    parse_tool_input(name, input, capability, true)
}

pub fn parse_tool_input(
    name: &str,
    input: &Value,
    capability: Option<&Value>,
    has_model_directory: bool,
) -> Result<ParsedInput> {
    let invalid = |id: TextId, values: &[(&str, Message)]| {
        Error::new("COLLABORATION_ARGUMENTS", "").with_harness(id, values)
    };
    let supplied = input
        .as_object()
        .ok_or_else(|| invalid(TextId::CollaborationArgumentsExpectedObject, &[]))?;
    let definitions = match capability {
        Some(capability) => definitions_with_model_selection(&baseline(), capability)?,
        None => definitions(),
    };
    let definition = definitions
        .into_iter()
        .find(|v| v["name"] == name)
        .ok_or_else(|| {
            invalid(
                TextId::CollaborationArgumentsUnknownTool,
                &[("name", name.into())],
            )
        })?;
    let fields = definition["inputSchema"]["properties"].as_object().unwrap();
    let required = definition["inputSchema"]["required"].as_array().unwrap();
    let rejected: Vec<_> = supplied.keys().map(String::as_str)
        .filter(|key| !fields.contains_key(*key) && !ignores_undeclared(name, key))
        .collect();
    if !rejected.is_empty() {
        let reason = Message::template(TextId::CollaborationArgumentsUnexpected, &[("key", display_keys(&rejected))]);
        let values = [("reason", reason), ("accepted", accepted_keys(fields))];
        if name != "spawn_agent" {
            return Err(invalid(TextId::CollaborationArgumentsRecordRefused, &values));
        }
        if rejected.contains(&"model") {
            let recovery = if !fields.contains_key("model_profile") {
                Some(TextId::CollaborationModelSelectionUnavailableInConversation)
            } else if has_model_directory {
                Some(TextId::CollaborationModelSelectionUseProfileReference)
            } else {
                None
            };
            if let Some(recovery) = recovery {
                return Err(invalid(TextId::CollaborationArgumentsSpawnWithRecovery, &[
                    ("refusal", Message::template(TextId::CollaborationArgumentsSpawnRefused, &values)),
                    ("recovery", Message::template(recovery, &[])),
                ]));
            }
        }
        return Err(invalid(TextId::CollaborationArgumentsSpawnRefused, &values));
    }
    let mut parsed = Map::new();
    for (key, field) in fields {
        let value = supplied.get(key);
        if value.is_none() && !required.iter().any(|v| v == key) {
            continue;
        }
        let value = value.unwrap_or(&Value::Null);
        match field["type"].as_str().unwrap() {
            "string"
                if !value
                    .as_str()
                    .is_some_and(|s| !crate::js::trim_js(s).is_empty()) =>
            {
                return Err(invalid(
                    TextId::CollaborationArgumentsNonEmptyString,
                    &[("key", key.as_str().into())],
                ))
            }
            "boolean" if !value.is_boolean() => {
                return Err(invalid(
                    TextId::CollaborationArgumentsBoolean,
                    &[("key", key.as_str().into())],
                ))
            }
            "integer" => {
                let valid = value.as_f64().is_some_and(|n| {
                    n.fract() == 0.0
                        && n.abs() <= 9_007_199_254_740_991.0
                        && field["minimum"].as_f64().is_none_or(|min| n >= min)
                        && field["maximum"].as_f64().is_none_or(|max| n <= max)
                });
                if !valid {
                    return Err(invalid(
                        TextId::CollaborationArgumentsIntegerRange,
                        &[("key", key.as_str().into())],
                    ));
                }
            }
            _ => {}
        }
        if field["enum"]
            .as_array()
            .is_some_and(|values| !values.contains(value))
        {
            return Err(invalid(
                TextId::CollaborationArgumentsEnumValue,
                &[("key", key.as_str().into())],
            ));
        }
        parsed.insert(key.clone(), value.clone());
    }
    if name == "spawn_agent" && parsed.contains_key("cwd") && parsed.contains_key("isolation") {
        return Err(invalid(TextId::CollaborationArgumentsCwdAndIsolation, &[]));
    }
    if name == "team_post_finding" && !parsed.contains_key("content") && !parsed.contains_key("ref")
    {
        return Err(invalid(
            TextId::CollaborationArgumentsFindingContentOrReference,
            &[],
        ));
    }
    let ignored = supplied.keys().filter(|key| !fields.contains_key(*key)).count();
    if ignored != 0 {
        tracing::debug!(tool = name, count = ignored, "Ignored undeclared collaboration arguments");
    }
    let unfiltered_directory = name == "list_model_profiles"
        && ["query", "limit", "cursor"].iter().any(|key| supplied.contains_key(*key));
    Ok(ParsedInput { input: Value::Object(parsed), unfiltered_directory })
}

pub fn text(text: impl Into<String>, is_error: bool) -> Value {
    let mut result = serde_json::json!({"content":[{"type":"text","text":text.into()}]});
    if is_error {
        result["isError"] = true.into();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn baseline_tool_language_matches_its_fixture_and_overrides_keep_schema_shape() {
        let expected: Value =
            serde_json::from_str(include_str!("../harness/fixtures/collaboration-tools.json"))
                .unwrap();
        assert_eq!(
            crate::js::stringify(&Value::Array(definitions())),
            crate::js::stringify(&expected)
        );
        let configured = crate::harness::Harness::from_config(&serde_json::json!({"models":{"alternate":{"collaboration.tools.spawn_agent.description":"Delegate with {opaque} instructions.","collaboration.arguments.non_empty_string":"Missing {key}."}}})).unwrap();
        let alternate = configured.for_model("alternate");
        let mut changed = expected.clone();
        changed[0]["description"] = "Delegate with {opaque} instructions.".into();
        assert_eq!(Value::Array(definitions_with_harness(&alternate)), changed);
        assert_eq!(
            Value::Array(definitions_with_harness(&configured.for_model("original"))),
            expected
        );
        let error = parse_input("spawn_agent", &serde_json::json!({"prompt":" "})).unwrap_err();
        assert_eq!(error.message, "prompt must be a non-empty string.");
        assert_eq!(error.render_for(&alternate), "Missing prompt.");
    }
    #[test]
    fn reasoning_inheritance_removes_only_the_spawn_effort_argument() {
        let default = serde_json::json!({"policy":"inherit"});
        let inherits = serde_json::json!({"policy":"inherit","reasoningPolicy":"inherit"});
        let invalid = serde_json::json!({"policy":"inherit","reasoningPolicy":"unknown"});
        let input =
            serde_json::json!({"prompt":"work","model_profile":"p1","reasoning_effort":"high"});

        assert_eq!(
            parse_input_with_model_selection("spawn_agent", &input, Some(&default)).unwrap().input,
            input
        );
        let error =
            parse_input_with_model_selection("spawn_agent", &input, Some(&inherits)).unwrap_err();
        assert_eq!(error.code, "COLLABORATION_ARGUMENTS");
        assert_eq!(
            error.message,
            "No collaborator was created. Unsupported argument: reasoning_effort. Accepted arguments: prompt, name, cwd, isolation, model_profile."
        );
        assert!(model_selection_guidance(&invalid).is_err());
    }

    #[test]
    fn directory_discards_extras_and_distinguishes_filters_from_labels() {
        let capability = serde_json::json!({"policy":"inherit"});
        for (input, unfiltered) in [
            (serde_json::json!({}), false),
            (serde_json::json!({"summary":"Find Small"}), false),
            (serde_json::json!({"query":"Small","limit":1}), true),
            (serde_json::json!({"cursor":"next"}), true),
        ] {
            let parsed = parse_input_with_model_selection("list_model_profiles", &input, Some(&capability)).unwrap();
            assert_eq!(parsed.input, serde_json::json!({}));
            assert_eq!(parsed.unfiltered_directory, unfiltered);
        }
    }

    #[test]
    fn rejects_extra_authority_and_explicit_null() {
        assert!(parse_input(
            "spawn_agent",
            &serde_json::json!({"prompt":"x","teamId":"override"})
        )
        .is_err());
        assert!(parse_input(
            "spawn_agent",
            &serde_json::json!({"prompt":"x","name":null})
        )
        .is_err());
        assert_eq!(
            parse_input("spawn_agent", &serde_json::json!({"prompt":" x "})).unwrap().input["prompt"],
            " x "
        );
    }

    #[test]
    fn a_message_with_an_unknown_label_preserves_only_supported_input() {
        let parsed = parse_input(
            "team_send",
            &serde_json::json!({"message":"Report back.","summary":"Ask for report","to":"reviewer"}),
        )
        .unwrap();
        assert_eq!(parsed.input, serde_json::json!({"to":"reviewer","message":"Report back."}));
        assert!(!parsed.unfiltered_directory);
    }

    #[test]
    fn tolerated_arguments_never_replace_validation_of_the_ones_the_tool_defines() {
        let extra = serde_json::json!({"summary":"x","priority":"high"});
        for (tool, mut input) in [
            ("team_send", serde_json::json!({"to":"reviewer","message":" "})),
            ("team_read_board", serde_json::json!({"status":"finished"})),
            ("team_read_member", serde_json::json!({"member":"reader","before":1.5})),
            ("team_stop", serde_json::json!({})),
        ] {
            input.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let error = parse_input(tool, &input).unwrap_err();
            assert_eq!(error.code, "COLLABORATION_ARGUMENTS", "{tool}");
            assert!(!error.message.contains("priority"), "{tool}: {}", error.message);
        }
        assert!(parse_input("team_send", &serde_json::json!({"to":"reviewer","summary":"x"})).is_err());
    }

    #[test]
    fn recording_tools_refuse_undeclared_arguments_instead_of_dropping_them() {
        for (tool, input, message) in [
            (
                "team_post_task",
                serde_json::json!({"title":"Check logs","assignee":"reader","description":"Compare both runs."}),
                "Nothing was recorded. Unsupported argument: description. Accepted arguments: title, assignee, parentId.",
            ),
            (
                "team_update_task",
                serde_json::json!({"taskId":"t1","status":"done","summary":"Verified both runs."}),
                "Nothing was recorded. Unsupported argument: summary. Accepted arguments: taskId, status, resultRef, note.",
            ),
            (
                "team_post_finding",
                serde_json::json!({"content":"Both runs match.","title":"Result"}),
                "Nothing was recorded. Unsupported argument: title. Accepted arguments: content, ref.",
            ),
        ] {
            let error = parse_input(tool, &input).unwrap_err();
            assert_eq!(error.code, "COLLABORATION_ARGUMENTS", "{tool}");
            assert_eq!(error.message, message);
        }
        let note = serde_json::json!({"taskId":"t1","status":"done","note":"Verified both runs."});
        assert_eq!(parse_input("team_update_task", &note).unwrap().input, note);
    }

    #[test]
    fn creating_a_collaborator_tolerates_labels_but_refuses_anything_that_might_shape_it() {
        let labelled = parse_input(
            "spawn_agent",
            &serde_json::json!({"prompt":"Review.","description":"Review","summary":"s","title":"t"}),
        )
        .unwrap();
        assert_eq!(labelled.input, serde_json::json!({"prompt":"Review."}));
        assert!(!labelled.unfiltered_directory);
        let error = parse_input(
            "spawn_agent",
            &serde_json::json!({"prompt":"Review.","description":"Review","subagent_type":"explore","run_in_background":true}),
        )
        .unwrap_err();
        assert_eq!(error.code, "COLLABORATION_ARGUMENTS");
        assert_eq!(
            error.message,
            "No collaborator was created. Unsupported argument: subagent_type, run_in_background. Accepted arguments: prompt, name, cwd, isolation."
        );
    }

    #[test]
    fn feedback_bounds_untrusted_keys_and_never_echoes_values() {
        let mut input = serde_json::json!({"prompt":"Work","model":"PRIVATE_VALUE","bad\nkey":"x"});
        for index in 0..12 {
            input[format!("extra_{index}")] = Value::Null;
        }
        let error = parse_input("spawn_agent", &input).unwrap_err();
        assert_eq!(error.message, "No collaborator was created. Unsupported argument: model, extra_0, extra_1, extra_2, extra_3, extra_4, extra_5, extra_6, other unsupported keys. Accepted arguments: prompt, name, cwd, isolation. Model selection is not available in this conversation.");
    }

    #[test]
    fn existing_unexpected_argument_overrides_keep_their_slot() {
        let configured = crate::harness::Harness::from_config(&serde_json::json!({"models":{"alternate":{"collaboration.arguments.unexpected":"Remove {key}."}}})).unwrap();
        let error = parse_input("spawn_agent", &serde_json::json!({"prompt":"Work","model":"other"})).unwrap_err();
        assert_eq!(error.render_for(&configured.for_model("alternate")), "No collaborator was created. Remove model. Accepted arguments: prompt, name, cwd, isolation. Model selection is not available in this conversation.");
    }

    #[test]
    fn raw_model_recovery_matches_the_available_tools() {
        let input = serde_json::json!({"prompt":"Work","model":"other"});
        let capability = serde_json::json!({"policy":"inherit","reasoningPolicy":"inherit"});
        let rejected = "No collaborator was created. Unsupported argument: model. Accepted arguments: prompt, name, cwd, isolation, model_profile.";
        let enabled = parse_tool_input("spawn_agent", &input, Some(&capability), true).unwrap_err();
        assert_eq!(enabled.message, format!("{rejected} To choose a model, call list_model_profiles and pass the returned profile reference as model_profile."));
        let no_directory = parse_tool_input("spawn_agent", &input, Some(&capability), false).unwrap_err();
        assert_eq!(no_directory.message, rejected);
        let disabled = parse_input("spawn_agent", &input).unwrap_err();
        assert_eq!(disabled.message, "No collaborator was created. Unsupported argument: model. Accepted arguments: prompt, name, cwd, isolation. Model selection is not available in this conversation.");
    }
}
