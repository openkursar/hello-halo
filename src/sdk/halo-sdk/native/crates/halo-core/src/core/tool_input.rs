use crate::{
    harness::{ResolvedHarness, TextId},
    js::data::stringify,
};
use serde_json::Value;

fn type_name(value: &Value) -> &str {
    if let Some(value) = value.as_f64() {
        return if value.is_finite() && value.fract() == 0.0 {
            "integer"
        } else {
            "number"
        };
    }
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Number(number) if number.as_f64().is_some_and(|n| n.fract() == 0.0) => "integer",
        Value::Number(_) => "number",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn matches_type(value: &Value, name: &str) -> bool {
    match name {
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "integer" => type_name(value) == "integer",
        _ => true,
    }
}

fn path_join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.into()
    } else {
        format!("{path}.{key}")
    }
}

fn collect(
    schema: &Value,
    value: &Value,
    path: &str,
    problems: &mut Vec<String>,
    harness: &ResolvedHarness,
    disclose_values: bool,
) {
    if problems.len() >= 5
        || ["oneOf", "anyOf", "allOf", "not", "$ref"]
            .iter()
            .any(|key| schema.get(key).is_some())
    {
        return;
    }
    let types: Vec<&str> = if let Some(name) = schema["type"].as_str() {
        vec![name]
    } else {
        schema["type"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    };
    if !types.is_empty() && !types.iter().any(|name| matches_type(value, name)) {
        let label = if path.is_empty() {
            harness.text(TextId::ContextArgumentsRoot).into()
        } else {
            harness.render(TextId::ContextArgumentsPath, &[("path", path)])
        };
        problems.push(harness.render(
            TextId::ContextArgumentsTypeMismatch,
            &[
                ("label", &label),
                (
                    "types",
                    &types.join(harness.text(TextId::ContextArgumentsTypesSeparator)),
                ),
                ("actual", type_name(value)),
            ],
        ));
        return;
    }
    if let Some(values) = schema["enum"].as_array().filter(|a| !a.is_empty()) {
        let comparable = !value.is_array() && !value.is_object();
        let equal = |other: &Value| match (value.as_f64(), other.as_f64()) {
            (Some(left), Some(right)) => left == right || left.is_nan() && right.is_nan(),
            _ => value == other,
        };
        if comparable && !values.iter().any(equal) {
            if !disclose_values {
                problems.push(harness.render(TextId::ContextArgumentsEnumInvalid, &[("path", path)]));
                return;
            }
            let enum_values = values
                .iter()
                .map(stringify)
                .collect::<Vec<_>>()
                .join(harness.text(TextId::ContextArgumentsValuesSeparator));
            let actual = stringify(value);
            problems.push(harness.render(
                TextId::ContextArgumentsEnumMismatch,
                &[
                    ("path", path),
                    ("values", &enum_values),
                    ("actual", &actual),
                ],
            ));
            return;
        }
    }
    if let Some(object) = value.as_object() {
        for key in schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(key) {
                problems.push(harness.render(
                    TextId::ContextArgumentsRequired,
                    &[("path", &path_join(path, key))],
                ));
                if problems.len() >= 5 {
                    return;
                }
            }
        }
        if let Some(properties) = schema["properties"].as_object() {
            for (key, property) in crate::js::ordered_object(properties) {
                if !property.is_object() {
                    continue;
                }
                if let Some(value) = object.get(&key) {
                    collect(&property, value, &path_join(path, &key), problems, harness, disclose_values);
                }
                if problems.len() >= 5 {
                    return;
                }
            }
        }
    } else if let Some(array) = value.as_array().filter(|_| schema["items"].is_object()) {
        for (index, value) in array.iter().enumerate() {
            collect(
                &schema["items"],
                value,
                &format!("{path}[{index}]"),
                problems,
                harness,
                disclose_values,
            );
            if problems.len() >= 5 {
                return;
            }
        }
    }
}

pub fn problems_with_harness(schema: &Value, input: &Value, harness: &ResolvedHarness) -> Vec<String> {
    let mut problems = Vec::new();
    if schema.is_object() {
        collect(schema, input, "", &mut problems, harness, false);
    }
    problems
}

pub fn validate(name: &str, schema: &Value, input: &Value) -> Option<String> {
    validate_with_harness(name, schema, input, &crate::harness::baseline())
}
pub fn validate_with_harness(
    name: &str,
    schema: &Value,
    input: &Value,
    harness: &ResolvedHarness,
) -> Option<String> {
    if !schema.is_object() {
        return None;
    }
    let mut problems = Vec::new();
    collect(schema, input, "", &mut problems, harness, true);
    (!problems.is_empty()).then(|| {
        harness.render(
            TextId::ContextArgumentsInvalid,
            &[
                ("tool", name),
                (
                    "problems",
                    &problems.join(harness.text(TextId::ContextArgumentsProblemsSeparator)),
                ),
            ],
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_json_markers_are_objects_and_satisfy_required_properties() {
        let schema = json!({"type":"object","required":["payload"],"properties":{"payload":{"type":"object"}}});
        let input = json!({"__haloSdkNativeUndefined":true,"payload":{"__haloSdkNativeNumber":"NaN"}});
        assert_eq!(validate("Record", &schema, &input), None);
    }
    use serde_json::json;
    #[test]
    fn validates_nested_input_and_preserves_uninterpretable_subtrees() {
        let schema = json!({"type":"object","required":["path"],"properties":{"count":{"type":"integer"},"source":{"oneOf":[],"type":"string"},"items":{"type":"array","items":{"type":"string"}}}});
        assert_eq!(validate("Read",&schema,&json!({"count":2.5,"source":null,"items":[4]})),Some("Invalid arguments for Read: \"path\" is required but was not provided; \"count\" must be integer, but received number; \"items[0]\" must be string, but received integer. Correct the arguments and call Read again.".into()));
    }
}
