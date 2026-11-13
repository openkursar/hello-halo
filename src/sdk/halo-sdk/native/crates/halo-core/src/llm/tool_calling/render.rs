use crate::{
    harness::{ResolvedHarness, ResourceId, TextId},
    js::{self, stringify, stringify_pretty},
};
use serde_json::{json, Map, Value};

struct Parameter {
    name: String,
    required: bool,
    kind: String,
    description: String,
    values: Vec<Value>,
    default: Option<Value>,
}
fn parameters(schema: &Value) -> Vec<Parameter> {
    let Some(properties) = schema["properties"].as_object() else {
        return Vec::new();
    };
    let required = schema["required"].as_array();
    js::ordered_object(properties)
        .into_iter()
        .map(|(name, property)| Parameter {
            required: required.is_some_and(|required| required.iter().any(|value| value == &name)),
            name,
            kind: js::to_string(
                property
                    .get("type")
                    .filter(|value| !value.is_null() && !js::is_undefined(value))
                    .unwrap_or(&json!("string")),
            ),
            description: js::to_string(
                property
                    .get("description")
                    .filter(|value| !value.is_null() && !js::is_undefined(value))
                    .unwrap_or(&json!("")),
            ),
            values: property["enum"].as_array().cloned().unwrap_or_default(),
            default: property
                .get("default")
                .filter(|value| !js::is_undefined(value))
                .cloned(),
        })
        .collect()
}
fn suffix(parameter: &Parameter, harness: &ResolvedHarness) -> String {
    let mut parts = Vec::new();
    if !parameter.values.is_empty() {
        parts.push(
            harness.render(
                TextId::ProvidersToolAllowedValues,
                &[(
                    "values",
                    &parameter
                        .values
                        .iter()
                        .map(stringify)
                        .collect::<Vec<_>>()
                        .join(", "),
                )],
            ),
        );
    }
    if let Some(value) = &parameter.default {
        parts.push(harness.render(
            TextId::ProvidersToolDefaultValue,
            &[("value", &stringify(value))],
        ));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(". "))
    }
}
fn xml_example(parameter: &Parameter, harness: &ResolvedHarness) -> String {
    if let Some(value) = &parameter.default {
        return value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| stringify(value));
    }
    if let Some(value) = parameter.values.first() {
        return js::to_string(value);
    }
    match parameter.kind.as_str() {
        "boolean" => "true".into(),
        "integer" => "42".into(),
        "number" => "3.14".into(),
        "array" => "[]".into(),
        "object" => "{}".into(),
        _ => {
            if parameter.description.is_empty() {
                harness.text(TextId::ProvidersToolExampleValue).into()
            } else {
                parameter.description.clone()
            }
        }
    }
}
fn protocol(template: &str, slots: &[(&str, &str)]) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < template.len() {
        if let Some((name, value)) = slots
            .iter()
            .find(|(name, _)| template[cursor..].starts_with(&format!("{{{name}}}")))
        {
            output.push_str(value);
            cursor += name.len() + 2;
        } else {
            let character = template[cursor..].chars().next().unwrap();
            output.push(character);
            cursor += character.len_utf8();
        }
    }
    output
}
pub fn render_tools(tools: &[Value], mode: &str, harness: &ResolvedHarness) -> String {
    if tools.is_empty() {
        return String::new();
    }
    let rules = if mode == "json" {
        TextId::ProvidersJsonInstructions
    } else {
        TextId::ProvidersXmlInstructions
    };
    let mut lines: Vec<String> = harness.text(rules).split('\n').map(str::to_owned).collect();
    let resource = harness.resource(ResourceId::ProviderProtocol);
    for tool in tools {
        let name = tool["name"].as_str().unwrap_or("");
        let description = tool["description"].as_str().unwrap_or("");
        let params = parameters(&tool["input_schema"]);
        lines.push(harness.render(TextId::ProvidersToolHeading, &[("name", name)]));
        lines.push(String::new());
        lines.push(harness.render(
            TextId::ProvidersToolDescription,
            &[("description", description)],
        ));
        lines.push(String::new());
        if params.is_empty() {
            lines.push(harness.text(TextId::ProvidersToolNoParameters).into());
        } else {
            lines.push(harness.text(TextId::ProvidersToolParameters).into());
            for parameter in &params {
                lines.push(harness.render(
                    TextId::ProvidersToolParameter,
                    &[
                        ("name", &parameter.name),
                        (
                            "requirement",
                            harness.text(if parameter.required {
                                TextId::ProvidersToolRequired
                            } else {
                                TextId::ProvidersToolOptional
                            }),
                        ),
                        ("description", &parameter.description),
                        ("suffix", &suffix(parameter, harness)),
                    ],
                ));
            }
        }
        lines.push(String::new());
        lines.push(harness.text(TextId::ProvidersToolUsage).into());
        if mode == "json" {
            let mut values = Map::new();
            for parameter in params.iter().filter(|parameter| parameter.required) {
                if parameter.name == "__proto__" {
                    continue;
                }
                let value = match parameter.kind.as_str() {
                    "boolean" => json!(true),
                    "number" | "integer" => json!(42),
                    "array" => json!([]),
                    "object" => json!({}),
                    _ => json!(harness.text(TextId::ProvidersToolExampleValue)),
                };
                values.insert(parameter.name.clone(), value);
            }
            lines.push(resource["json"]["fenceOpen"].as_str().unwrap().into());
            lines.push(stringify_pretty(&json!([{"name":name,"params":values}])));
            lines.push(resource["json"]["fenceClose"].as_str().unwrap().into());
        } else {
            lines.push(protocol(
                resource["xml"]["open"].as_str().unwrap(),
                &[("name", name)],
            ));
            for parameter in params
                .iter()
                .filter(|parameter| parameter.required)
                .chain(params.iter().filter(|parameter| !parameter.required))
            {
                let kind = resource["xml"]["types"][&parameter.kind]
                    .as_str()
                    .unwrap_or("string");
                lines.push(protocol(
                    resource["xml"]["parameter"].as_str().unwrap(),
                    &[
                        ("name", &parameter.name),
                        ("type", kind),
                        (
                            "required",
                            if parameter.required { "true" } else { "false" },
                        ),
                        ("value", &xml_example(parameter, harness)),
                    ],
                ));
            }
            lines.push(protocol(
                resource["xml"]["close"].as_str().unwrap(),
                &[("name", name)],
            ));
        }
        let optional: Vec<_> = params
            .iter()
            .filter(|parameter| !parameter.required)
            .map(|parameter| parameter.name.as_str())
            .collect();
        if !optional.is_empty() {
            lines.push(harness.render(
                TextId::ProvidersToolOptionalNotice,
                &[("names", &optional.join(", "))],
            ));
        }
        lines.push(String::new());
        lines.push(resource["separator"].as_str().unwrap().into());
        lines.push(String::new());
    }
    while lines
        .last()
        .is_some_and(|line| line.is_empty() || line == resource["separator"].as_str().unwrap())
    {
        lines.pop();
    }
    lines.join("\n")
}
