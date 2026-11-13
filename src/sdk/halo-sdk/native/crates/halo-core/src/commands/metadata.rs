use crate::js::{is_undefined, trim_js, truthy};
use serde_json::{json, Value};

pub fn is_command(value: &Value) -> bool {
    value.is_object()
        && value["name"].is_string()
        && value["description"].is_string()
        && (value["type"] == "local" || value["type"] == "prompt")
}
pub fn static_invocable(value: &Value) -> bool {
    value["userInvocable"] != false && value["isHidden"] != true
}
pub fn enabled(value: &Value) -> Value {
    if value.is_null() || is_undefined(value) {
        json!(true)
    } else {
        value.clone()
    }
}
pub fn slash(command: &Value) -> Value {
    let mut value = json!({"name":command["name"],"description":command["description"]});
    if truthy(&command["argumentHint"]) {
        value["argumentHint"] = command["argumentHint"].clone();
    }
    value
}
pub fn normalize(input: Option<&Value>) -> Vec<Value> {
    normalize_receipts(input)
        .into_iter()
        .map(|receipt| receipt["value"].clone())
        .collect()
}
pub fn normalize_receipts(input: Option<&Value>) -> Vec<Value> {
    let mut result = Vec::new();
    for (index, entry) in input
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(name) = entry.as_str() {
            let name = trim_js(name);
            if !name.is_empty() {
                result.push(json!({"index":index,"kind":"string","value":{"type":"local","name":name,"description":"","source":"user"}}));
            }
            continue;
        }
        if !entry.is_object() || is_undefined(entry) {
            continue;
        }
        if is_command(entry) {
            let mut value = entry.clone();
            if value
                .get("source")
                .is_none_or(|value| value.is_null() || is_undefined(value))
            {
                value["source"] = json!("user");
            }
            result.push(json!({"index":index,"kind":"copy","value":value}));
            continue;
        }
        if entry["name"]
            .as_str()
            .is_none_or(|name| trim_js(name).is_empty())
        {
            continue;
        }
        let description = entry
            .get("description")
            .filter(|value| !value.is_null() && !is_undefined(value))
            .cloned()
            .unwrap_or_else(|| json!(""));
        let hint = entry
            .get("argumentHint")
            .cloned()
            .unwrap_or_else(crate::js::undefined);
        result.push(json!({"index":index,"kind":"wire","value":{"type":"local","name":entry["name"],"description":description,"argumentHint":hint,"source":"user"}}));
    }
    result
}
