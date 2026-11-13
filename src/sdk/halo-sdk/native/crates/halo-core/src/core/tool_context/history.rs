use super::catalog::{fingerprint, stable_json, STATE_BYTES};
use crate::{
    error::{Error, Result},
    harness::TextId,
    js::{stringify, utf16_len},
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}
fn exactly(value: &Value, count: usize) -> bool {
    value.as_object().is_some_and(|map| map.len() == count)
}
fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|array| array.iter().all(Value::is_string))
}
fn unique(values: impl Iterator<Item = String>) -> bool {
    let mut seen = HashSet::new();
    values.into_iter().all(|value| seen.insert(value))
}
fn safe_integer(value: &Value, min: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.fract() == 0.0 && n >= min && n <= 9_007_199_254_740_991.0)
}
fn optional_array(value: &Value, key: &str, validate: impl Fn(&Value) -> bool) -> bool {
    value.get(key).is_none_or(|items| {
        items
            .as_array()
            .is_some_and(|items| items.iter().all(validate))
    })
}
fn valid_definition(value: &Value) -> bool {
    if !keys(
        value,
        &[
            "server",
            "identity",
            "originalName",
            "version",
            "definition",
            "usageGuide",
        ],
    ) || ["server", "identity", "originalName", "version"]
        .iter()
        .any(|key| !value[*key].is_string())
        || value
            .get("usageGuide")
            .is_some_and(|guide| !guide.is_string())
    {
        return false;
    }
    let tool = &value["definition"];
    if !keys(tool, &["name", "description", "input_schema"])
        || !tool["name"].is_string()
        || !tool["description"].is_string()
        || !tool["input_schema"].is_object()
    {
        return false;
    }
    let mut content = value.clone();
    content.as_object_mut().unwrap().shift_remove("version");
    value["version"] == fingerprint(&content)
}
fn valid_snapshot(value: &Value) -> bool {
    keys(
        value,
        &[
            "version",
            "discoveryEntries",
            "generation",
            "directory",
            "definitions",
            "historicalDefinitions",
        ],
    ) && value["version"].as_f64() == Some(1.0)
        && value["discoveryEntries"].is_boolean()
        && value["generation"].is_string()
        && value["directory"].is_string()
        && value["definitions"].as_array().is_some_and(|items| {
            items.iter().all(valid_definition)
                && unique(
                    items
                        .iter()
                        .map(|item| item["definition"]["name"].as_str().unwrap().to_owned()),
                )
        })
        && value.get("historicalDefinitions").is_none_or(|items| {
            items.as_array().is_some_and(|items| {
                items.iter().all(valid_definition)
                    && unique(
                        items
                            .iter()
                            .map(|item| item["version"].as_str().unwrap().to_owned()),
                    )
            })
        })
}
pub fn valid_record(value: &Value) -> bool {
    if !keys(
        value,
        &[
            "version",
            "baseline",
            "baselineAttachment",
            "calls",
            "discoveries",
            "rejectedCalls",
            "directCalls",
            "presentations",
        ],
    ) || ![Some(1.0), Some(2.0)].contains(&value["version"].as_f64())
        || stringify(value).len() > STATE_BYTES * 2
    {
        return false;
    }
    if value
        .get("baseline")
        .is_some_and(|baseline| !valid_snapshot(baseline))
        || value
            .get("baselineAttachment")
            .is_some_and(|attachment| !attachment.is_boolean() || value.get("baseline").is_none())
    {
        return false;
    }
    if !optional_array(value, "discoveries", |item| {
        exactly(item, 2)
            && item["callId"].is_string()
            && item["definitions"]
                .as_array()
                .is_some_and(|items| items.iter().all(valid_definition))
    }) {
        return false;
    }
    if !optional_array(value, "calls", |item| {
        (if value["version"] == 1 { exactly(item, 3) } else { keys(item, &["id", "definitionVersion", "input", "rawInput", "normalization"]) })
            && item["id"].is_string()
            && item["definitionVersion"].is_string()
            && exactly(&item["input"], 2)
            && item["input"]["tool"].is_string()
            && (item["input"]["arguments"].is_string() || value["version"] == 2 && item["input"]["arguments"].is_object())
            && item.get("rawInput").is_none_or(Value::is_string)
            && item.get("normalization").is_none_or(strings)
    }) {
        return false;
    }
    for key in ["rejectedCalls", "directCalls"] {
        if !optional_array(value, key, |item| {
            exactly(item, 2) && item["id"].is_string() && item["name"].is_string()
        }) {
            return false;
        }
    }
    if !optional_array(value, "presentations", |item| {
        keys(
            item,
            &[
                "callId",
                "definitions",
                "guides",
                "payloadOffset",
                "payloadLength",
            ],
        ) && item["callId"].is_string()
            && ((item.get("payloadOffset").is_none() && item.get("payloadLength").is_none())
                || (safe_integer(&item["payloadOffset"], 0.0)
                    && safe_integer(&item["payloadLength"], 1.0)))
            && strings(&item["definitions"])
            && unique(
                item["definitions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned()),
            )
            && strings(&item["guides"])
            && item["guides"]
                .as_array()
                .unwrap()
                .iter()
                .all(|guide| item["definitions"].as_array().unwrap().contains(guide))
            && unique(
                item["guides"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned()),
            )
    }) {
        return false;
    }
    if !unique(
        ["calls", "rejectedCalls", "directCalls"]
            .into_iter()
            .flat_map(|key| value[key].as_array().into_iter().flatten())
            .map(|call| call["id"].as_str().unwrap().to_owned()),
    ) {
        return false;
    }
    [
        "baseline",
        "calls",
        "discoveries",
        "rejectedCalls",
        "directCalls",
        "presentations",
    ]
    .iter()
    .any(|key| value.get(*key).is_some())
}
fn fail(id: TextId) -> Error {
    Error::template("TOOL_CONTEXT_HISTORY", id, &[])
}
pub fn merge(a: Option<&Value>, b: Option<&Value>) -> Result<Option<Value>> {
    let (Some(a), Some(b)) = (a, b) else {
        return Ok(a.or(b).cloned());
    };
    if a.get("baseline").is_some() && b.get("baseline").is_some() {
        return Err(fail(TextId::ContextDiscoveryHistoryMultipleBaselines));
    }
    let mut out = json!({"version":a["version"].as_u64().unwrap_or(1).max(b["version"].as_u64().unwrap_or(1))});
    for key in ["baseline", "baselineAttachment"] {
        if let Some(value) = a.get(key).or(b.get(key)) {
            out[key] = value.clone();
        }
    }
    for key in [
        "calls",
        "rejectedCalls",
        "directCalls",
        "presentations",
        "discoveries",
    ] {
        if a.get(key).is_some() || b.get(key).is_some() {
            out[key] = json!(a[key]
                .as_array()
                .into_iter()
                .flatten()
                .chain(b[key].as_array().into_iter().flatten())
                .cloned()
                .collect::<Vec<_>>());
        }
    }
    Ok(Some(out))
}
pub fn read_snapshot(messages: &[Value]) -> Result<Option<Value>> {
    let mut current = None;
    let mut known = Map::new();
    let mut versions = HashMap::<String, Value>::new();
    let mut issued = HashSet::new();
    let mut rejected = HashSet::new();
    for message in messages {
        let record = &message["toolContext"];
        if message.get("toolContext").is_some() && !valid_record(record) {
            return Err(fail(TextId::ContextDiscoveryHistoryInvalidMetadata));
        }
        if let Some(baseline) = record.get("baseline") {
            if message["role"] != "user"
                || (message["isMeta"] != true
                    && (baseline["discoveryEntries"] == true
                        || baseline["directory"] != ""
                        || !baseline["definitions"].as_array().unwrap().is_empty()))
            {
                return Err(fail(TextId::ContextDiscoveryHistoryInvalidBaselineAttachment));
            }
            current = Some(baseline.clone());
            known.clear();
            for item in baseline["definitions"].as_array().unwrap() {
                known.insert(
                    item["definition"]["name"].as_str().unwrap().into(),
                    item.clone(),
                );
                versions.insert(item["version"].as_str().unwrap().into(), item.clone());
            }
            for item in baseline["historicalDefinitions"]
                .as_array()
                .into_iter()
                .flatten()
            {
                versions.insert(item["version"].as_str().unwrap().into(), item.clone());
            }
        }
        if current.is_none() {
            if message.get("toolContext").is_some() {
                return Err(fail(TextId::ContextDiscoveryHistoryBaselineMissing));
            }
            continue;
        }
        let blocks = message["content"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if message["role"] == "assistant" {
            let map = |key: &str| {
                record[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|call| (call["id"].as_str().unwrap().to_owned(), call))
                    .collect::<HashMap<_, _>>()
            };
            let mut origins = map("calls");
            let mut refused = map("rejectedCalls");
            let mut direct = map("directCalls");
            for call in blocks.iter().filter(|call| call["type"] == "tool_use") {
                let id = call["id"].as_str().unwrap_or("");
                if !issued.insert(id.to_owned()) {
                    return Err(fail(TextId::ContextDiscoveryHistoryDuplicateCall));
                }
                if let Some(origin) = origins.remove(id) {
                    let original = versions.get(origin["definitionVersion"].as_str().unwrap());
                    if original.is_none_or(|original| {
                        original["definition"]["name"] != call["name"]
                            || call["name"] != origin["input"]["tool"]
                    }) {
                        return Err(fail(TextId::ContextDiscoveryHistoryOriginDefinitionMismatch));
                    }
                    let input = if record["version"] == 1 {
                        let input: Value = serde_json::from_str(origin["input"]["arguments"].as_str().unwrap())
                            .map_err(|_| fail(TextId::ContextDiscoveryHistoryOriginArgumentsInvalid))?;
                        if !input.is_object() { return Err(fail(TextId::ContextDiscoveryHistoryOriginArgumentsNotObject)); }
                        input
                    } else {
                        let decoded = super::invocation::decode(&origin["input"], origin["rawInput"].as_str())
                            .map_err(|_| fail(TextId::ContextDiscoveryHistoryOriginArgumentsInvalid))?;
                        if decoded.target != origin["input"]["tool"].as_str().unwrap()
                            || stable_json(&decoded.original) != stable_json(&origin["input"])
                            || (origin.get("normalization").is_some() || origin.get("rawInput").is_some())
                                && json!(decoded.normalization) != origin["normalization"]
                        {
                            return Err(fail(TextId::ContextDiscoveryHistoryOriginArgumentsInvalid));
                        }
                        decoded.input
                    };
                    if stable_json(&input) != stable_json(&call["input"]) {
                        return Err(fail(TextId::ContextDiscoveryHistoryOriginArgumentsMismatch));
                    }
                } else if let Some(refusal) = refused.remove(id) {
                    if refusal["name"] != call["name"] {
                        return Err(fail(TextId::ContextDiscoveryHistoryRejectedCallMismatch));
                    }
                    rejected.insert(id.to_owned());
                } else if let Some(direct_call) = direct.remove(id) {
                    if direct_call["name"] != call["name"] {
                        return Err(fail(TextId::ContextDiscoveryHistoryDirectCallMismatch));
                    }
                } else if known.contains_key(call["name"].as_str().unwrap_or("")) {
                    return Err(fail(TextId::ContextDiscoveryHistoryOriginMissing));
                }
            }
            if !origins.is_empty() || !refused.is_empty() || !direct.is_empty() {
                return Err(fail(TextId::ContextDiscoveryHistoryCallBlockMissing));
            }
        } else if ["calls", "rejectedCalls", "directCalls"].iter().any(|key| {
            record[*key]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        }) {
            return Err(fail(TextId::ContextDiscoveryHistoryInvalidCallAttachment));
        }
        for block in blocks {
            if block["type"] == "tool_result"
                && rejected.contains(block["tool_use_id"].as_str().unwrap_or(""))
                && block["is_error"] != true
            {
                return Err(fail(TextId::ContextDiscoveryHistoryRejectedCallSuccess));
            }
        }
        for delta in record["discoveries"].as_array().into_iter().flatten() {
            if message["role"] != "user"
                || !blocks.iter().any(|block| {
                    block["type"] == "tool_result"
                        && block["tool_use_id"] == delta["callId"]
                        && block["is_error"] != true
                })
            {
                return Err(fail(TextId::ContextDiscoveryHistoryDiscoveryResultMissing));
            }
            for item in delta["definitions"].as_array().unwrap() {
                known.insert(
                    item["definition"]["name"].as_str().unwrap().into(),
                    item.clone(),
                );
                versions.insert(item["version"].as_str().unwrap().into(), item.clone());
            }
        }
        for presentation in record["presentations"].as_array().into_iter().flatten() {
            let result = blocks.iter().find(|block| {
                block["type"] == "tool_result"
                    && block["tool_use_id"] == presentation["callId"]
                    && block["is_error"] != true
            });
            if message["role"] != "user" || result.is_none() {
                return Err(fail(TextId::ContextDiscoveryHistoryPresentationResultMissing));
            }
            let result = result.unwrap();
            if let Some(offset) = presentation.get("payloadOffset") {
                if result["content"].as_str().is_none_or(|content| {
                    offset.as_f64().unwrap() + presentation["payloadLength"].as_f64().unwrap()
                        > utf16_len(content) as f64
                }) {
                    return Err(fail(TextId::ContextDiscoveryHistoryPresentationSpanInvalid));
                }
            }
            if presentation["definitions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|version| !versions.contains_key(version.as_str().unwrap()))
                || presentation["guides"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|version| {
                        versions
                            .get(version.as_str().unwrap())
                            .is_none_or(|definition| !crate::js::truthy(&definition["usageGuide"]))
                    })
            {
                return Err(fail(TextId::ContextDiscoveryHistoryPresentationReferenceMissing));
            }
        }
    }
    if let Some(current) = &mut current {
        current["definitions"] = json!(known.values().cloned().collect::<Vec<_>>());
    }
    Ok(current)
}

pub fn project(messages: &[Value]) -> Vec<Value> {
    messages.iter().map(|message|{
    if message.get("toolContext").is_none(){return message.clone();}let mut content=message["content"].clone();
    if let Some(blocks)=content.as_array_mut(){for block in blocks{if block["type"]!="tool_use"{continue;}if let Some(origin)=message["toolContext"]["calls"].as_array().into_iter().flatten().find(|origin|origin["id"]==block["id"]){*block=json!({"type":"tool_use","id":block["id"],"name":"CallTool","input":origin["input"]});}}}
    let mut projected=json!({"role":message["role"],"content":content});if message["isMeta"]==true{projected["isMeta"]=json!(true);}projected
}).collect()
}
