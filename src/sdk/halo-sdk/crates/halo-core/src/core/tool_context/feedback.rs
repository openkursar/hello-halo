use crate::harness::{ResolvedHarness, TextId};
use serde_json::{json, Map, Value};

fn required_shape(schema: &Value, depth: usize, harness: &ResolvedHarness) -> Value {
    if depth == 0 || ["oneOf", "anyOf", "allOf", "$ref"].iter().any(|key| schema.get(key).is_some()) {
        return json!(harness.text(TextId::ContextDiscoveryExampleInputs));
    }
    let mut fields = Map::new();
    for name in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str).take(8) {
        let property = &schema["properties"][name];
        let value = if property["type"] == "object" {
            required_shape(property, depth - 1, harness)
        } else {
            json!(harness.render(TextId::ContextDiscoveryExampleValue, &[("type", property["type"].as_str().unwrap_or_else(|| harness.text(TextId::ContextDiscoveryExampleRequired)))]))
        };
        fields.insert(name.to_owned(), value);
    }
    Value::Object(fields)
}

pub fn invalid_arguments(target: &str, schema: &Value, input: &Value, harness: &ResolvedHarness) -> Option<String> {
    let problems = super::super::tool_input::problems_with_harness(schema, input, harness);
    if problems.is_empty() {
        return None;
    }
    let example = crate::js::stringify(&json!({"tool":target,"arguments":required_shape(schema, 3, harness)}));
    Some(harness.render(TextId::ContextDiscoveryInvalidTargetArguments, &[("problems", &problems.join("; ")), ("example", &example)]))
}
