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

pub fn model_selection_guidance(capability: &Value) -> Result<String> {
    let id = match capability["policy"].as_str() {
        Some("inherit") => TextId::CollaborationModelSelectionInherit,
        Some("task") => TextId::CollaborationModelSelectionTask,
        _ => return Err(Error::new("MODEL_SELECTION", "Unknown model selection policy.")),
    };
    Ok(baseline().text(id).to_owned())
}

pub fn definitions_with_model_selection(harness: &ResolvedHarness, capability: &Value) -> Result<Vec<Value>> {
    model_selection_guidance(capability)?;
    let mut tools = definitions_with_harness(harness);
    let spawn = tools.iter_mut().find(|tool| tool["name"] == "spawn_agent").unwrap();
    spawn["inputSchema"]["properties"]["model_profile"] = serde_json::json!({"type":"string","description":harness.text(TextId::CollaborationModelSelectionProfileField)});
    spawn["inputSchema"]["properties"]["reasoning_effort"] = serde_json::json!({"type":"string","description":harness.text(TextId::CollaborationModelSelectionEffortField)});
    let description = format!("{} {}", harness.text(TextId::CollaborationModelSelectionListDescription), model_selection_guidance(capability)?);
    tools.push(serde_json::json!({"name":"list_model_profiles","description":description,"inputSchema":{"type":"object","properties":{"query":{"type":"string"},"cursor":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":crate::collaboration::model_selection::limits()["pageMaximum"]}},"required":[],"additionalProperties":false}}));
    Ok(tools)
}

pub fn parse_input(name: &str, input: &Value) -> Result<Value> {
    parse_input_with_model_selection(name, input, None)
}

pub fn parse_input_with_model_selection(name: &str, input: &Value, capability: Option<&Value>) -> Result<Value> {
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
    for key in supplied.keys() {
        if !fields.contains_key(key) {
            return Err(invalid(
                TextId::CollaborationArgumentsUnexpected,
                &[("key", key.as_str().into())],
            ));
        }
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
    Ok(Value::Object(parsed))
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
            parse_input("spawn_agent", &serde_json::json!({"prompt":" x "})).unwrap()["prompt"],
            " x "
        );
    }
}
