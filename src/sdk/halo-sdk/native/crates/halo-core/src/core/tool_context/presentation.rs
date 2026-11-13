use serde_json::{json, Value};

pub fn target(snapshot: &Value, include_guide: bool) -> Value {
    let definition = &snapshot["definition"];
    let mut target = json!({"tool":definition["name"],"description":definition["description"],"arguments_schema":definition["input_schema"],"version":snapshot["version"]});
    if include_guide { target["usage_guide"] = snapshot["usageGuide"].clone(); }
    target
}

pub fn payload(targets: Vec<Value>) -> Value {
    json!({"invoke_via":"CallTool","targets":targets})
}

pub fn entries(payload: &Value) -> Option<(&[Value], bool)> {
    if payload.get("targets").is_some() {
        if payload["invoke_via"] != "CallTool" || payload.get("tools").is_some() { return None; }
        payload["targets"].as_array().map(|items| (items.as_slice(), true))
    } else if payload.get("invoke_via").is_none() {
        payload["tools"].as_array().map(|items| (items.as_slice(), false))
    } else { None }
}

pub fn definition(item: &Value, targets: bool) -> Value {
    if targets {
        json!({"name":item["tool"],"description":item["description"],"input_schema":item["arguments_schema"]})
    } else {
        json!({"name":item["name"],"description":item["description"],"input_schema":item["input_schema"]})
    }
}
