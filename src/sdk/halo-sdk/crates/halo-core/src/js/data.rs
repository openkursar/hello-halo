use serde_json::Value;

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
pub fn to_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    to_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => stringify(value),
    }
}
pub fn stringify(value: &Value) -> String {
    let mut output = String::new();
    write(value, None, 0, &mut output);
    output
}
pub(crate) fn append(value: &Value, output: &mut String) {
    write(value, None, 0, output);
}
pub fn stringify_pretty(value: &Value) -> String {
    let mut output = String::new();
    write(value, Some(2), 0, &mut output);
    output
}
pub(crate) fn entries(values: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed = Vec::new();
    let mut named = Vec::new();
    for (key, value) in values {
        match key.parse::<u32>() {
            Ok(index) if index != u32::MAX && index.to_string() == *key => {
                indexed.push((index, key, value))
            }
            _ => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}
fn newline(output: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(width) = indent {
        output.push('\n');
        for _ in 0..width * depth {
            output.push(' ');
        }
    }
}
fn write(value: &Value, indent: Option<usize>, depth: usize, output: &mut String) {
    match value {
        Value::Number(number) => {
            output.push_str(ryu_js::Buffer::new().format(number.as_f64().unwrap()))
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                newline(output, indent, depth + 1);
                write(value, indent, depth + 1, output);
            }
            if !values.is_empty() {
                newline(output, indent, depth);
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            for (index, (key, value)) in entries(values).into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                newline(output, indent, depth + 1);
                output.push_str(&serde_json::to_string(key).unwrap());
                output.push(':');
                if indent.is_some() {
                    output.push(' ');
                }
                write(value, indent, depth + 1, output);
            }
            if !values.is_empty() {
                newline(output, indent, depth);
            }
            output.push('}');
        }
        _ => output.push_str(&serde_json::to_string(value).unwrap()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn raw_json_objects_do_not_acquire_transport_semantics() {
        let value = json!({"ordinary":{"__haloSdkNativeUndefined":true},"numbers":{"__haloSdkNativeNumber":"NaN"},"array":[{"__haloSdkNativeUndefined":true}],"10":10.0,"2":2.0});
        assert_eq!(
            stringify(&value),
            r#"{"2":2,"10":10,"ordinary":{"__haloSdkNativeUndefined":true},"numbers":{"__haloSdkNativeNumber":"NaN"},"array":[{"__haloSdkNativeUndefined":true}]}"#
        );
        assert!(truthy(&value["ordinary"]));
        assert_eq!(to_string(&value["ordinary"]), "[object Object]");
        assert_eq!(
            stringify_pretty(&json!({"value":1.0})),
            "{\n  \"value\": 1\n}"
        );
    }
}
