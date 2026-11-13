use super::{
    catalog::{stable_json, SEARCH_BYTES, STATE_BYTES},
    history::{read_snapshot, valid_record},
    presentation,
};
use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness,TextId},
    js::{compare_text, stringify, utf16_len},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
fn fail(id: TextId) -> Error {
    Error::template("TOOL_CONTEXT_HISTORY", id, &[])
}
fn guide_key(definition: &Value) -> String {
    stable_json(&json!([definition["identity"], definition["usageGuide"]]))
}
fn delivered(
    messages: &[Value],
    current: &HashMap<String, Value>,
) -> (HashSet<String>, HashSet<String>) {
    let mut definitions = HashSet::new();
    let mut guides = HashSet::new();
    for message in messages {
        if message["role"] != "user" || !message["content"].is_array() {
            continue;
        }
        for presentation in message["toolContext"]["presentations"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let block = message["content"].as_array().unwrap().iter().find(|block| {
                block["type"] == "tool_result"
                    && block["tool_use_id"] == presentation["callId"]
                    && block["is_error"] != true
            });
            let Some(content) = block
                .and_then(|block| block["content"].as_str())
                .filter(|text| text.len() <= SEARCH_BYTES)
            else {
                continue;
            };
            let offset = presentation["payloadOffset"].as_u64().unwrap_or(0) as usize;
            let length = presentation["payloadLength"]
                .as_u64()
                .map(|n| n as usize)
                .unwrap_or_else(|| utf16_len(content));
            let payload = String::from_utf16_lossy(
                &content
                    .encode_utf16()
                    .skip(offset)
                    .take(length)
                    .collect::<Vec<_>>(),
            );
            let Ok(payload) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            let Some((tools, targets)) = presentation::entries(&payload) else {
                continue;
            };
            for version in presentation["definitions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let Some(definition) = current.get(version) else {
                    continue;
                };
                let item=tools.iter().find(|item|item.is_object()&&item["version"]==version&&stable_json(&presentation::definition(item,targets))==stable_json(&definition["definition"]));
                let Some(item) = item else {
                    continue;
                };
                definitions.insert(version.into());
                if presentation["guides"]
                    .as_array()
                    .is_some_and(|guides| guides.iter().any(|guide| guide == version))
                    && crate::js::truthy(&definition["usageGuide"])
                    && item["usage_guide"] == definition["usageGuide"]
                {
                    guides.insert(guide_key(definition));
                }
            }
        }
    }
    (definitions, guides)
}
fn render_recovery(snapshot: &Value, delivered: (HashSet<String>, HashSet<String>),harness:&ResolvedHarness) -> String {
    let (shown, mut guides) = delivered;
    let mut definitions = snapshot["definitions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    definitions.sort_by(|a, b| {
        compare_text(
            a["definition"]["name"].as_str().unwrap(),
            b["definition"]["name"].as_str().unwrap(),
        )
    });
    let mut missing = Vec::new();
    for definition in &definitions {
        if shown.contains(definition["version"].as_str().unwrap()) {
            continue;
        }
        let item = presentation::target(definition, crate::js::truthy(&definition["usageGuide"]) && guides.insert(guide_key(definition)));
        missing.push(item);
    }
    let mut missing_guides = Vec::new();
    for definition in &definitions {
        if crate::js::truthy(&definition["usageGuide"]) && guides.insert(guide_key(definition)) {
            missing_guides.push(
                json!({"server":definition["server"],"usage_guide":definition["usageGuide"]}),
            );
        }
    }
    let mut text = Vec::new();
    if let Some(directory) = snapshot["directory"].as_str().filter(|s| !s.is_empty()) {
        text.push(directory.to_owned());
    }
    if !missing.is_empty() {
        text.push(harness.render(TextId::ContextDiscoveryDefinitions,&[("definitions",&stringify(&presentation::payload(missing)))]));
    }
    if !missing_guides.is_empty() {
        text.push(harness.render(TextId::ContextDiscoveryGuides,&[("guides",&stringify(&json!(missing_guides)))]));
    }
    text.join("\n")
}
fn all_definitions(record: &Value) -> Vec<&Value> {
    record["baseline"]["definitions"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            record["baseline"]["historicalDefinitions"]
                .as_array()
                .into_iter()
                .flatten(),
        )
        .chain(
            record["discoveries"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|discovery| discovery["definitions"].as_array().into_iter().flatten()),
        )
        .collect()
}
pub fn prepare(
    candidate: &[Value],
    source: &[Value],
    snapshot: Option<&Value>,
) -> Result<Vec<Value>> {
    prepare_with_harness(candidate,source,snapshot,&crate::harness::baseline())
}
pub fn prepare_with_harness(
    candidate: &[Value],
    source: &[Value],
    snapshot: Option<&Value>,
    harness:&ResolvedHarness,
) -> Result<Vec<Value>> {
    let mut messages = candidate.to_vec();
    let baseline_index = messages
        .iter()
        .position(|message| message["toolContext"].get("baseline").is_some());
    let selected = snapshot
        .or_else(|| baseline_index.and_then(|index| messages[index]["toolContext"].get("baseline")))
        .cloned();
    if selected.is_none() || baseline_index.is_none() {
        if snapshot.is_some()
            || source
                .iter()
                .any(|message| message.get("toolContext").is_some())
        {
            return Err(fail(TextId::ContextDiscoveryHistoryCheckpointBaselineMissing));
        }
        return Ok(messages);
    }
    let mut snapshot = selected.unwrap();
    let baseline_index = baseline_index.unwrap();
    if !valid_record(&json!({"version":1,"baseline":snapshot})) {
        return Err(fail(TextId::ContextDiscoveryHistoryInvalidSnapshot));
    }
    let mut versions = HashMap::new();
    for message in source.iter().chain(messages.iter()) {
        let Some(record) = message.get("toolContext") else {
            continue;
        };
        if !valid_record(record) {
            return Err(fail(TextId::ContextDiscoveryHistoryInvalidMetadata));
        }
        for item in all_definitions(record) {
            versions.insert(item["version"].as_str().unwrap().to_owned(), item.clone());
        }
    }
    for item in snapshot["definitions"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            snapshot["historicalDefinitions"]
                .as_array()
                .into_iter()
                .flatten(),
        )
    {
        versions.insert(item["version"].as_str().unwrap().to_owned(), item.clone());
    }
    let current: HashMap<String, Value> = snapshot["definitions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|definition| {
            (
                definition["version"].as_str().unwrap().into(),
                definition.clone(),
            )
        })
        .collect();
    let mut retained = Vec::new();
    let mut selected_index = 0;
    for (index, mut message) in messages.into_iter().enumerate() {
        let Some(mut record) = message.get("toolContext").cloned() else {
            retained.push(message);
            continue;
        };
        if record.get("baseline").is_some() {
            if index == baseline_index {
                selected_index = retained.len();
                record["baseline"] = snapshot.clone();
            } else {
                let attachment = record["baselineAttachment"] == true;
                record.as_object_mut().unwrap().shift_remove("baseline");
                record
                    .as_object_mut()
                    .unwrap()
                    .shift_remove("baselineAttachment");
                if attachment
                    && message["isMeta"] == true
                    && message["content"].is_string()
                    && record.as_object().unwrap().len() == 1
                {
                    continue;
                }
            }
        }
        if let Some(discoveries) = record.get_mut("discoveries").and_then(Value::as_array_mut) {
            for discovery in discoveries.iter_mut() {
                discovery["definitions"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|definition| {
                        current
                            .get(definition["version"].as_str().unwrap())
                            .is_some_and(|current| current["identity"] == definition["identity"])
                    });
            }
            discoveries
                .retain(|discovery| !discovery["definitions"].as_array().unwrap().is_empty());
            if discoveries.is_empty() {
                record.as_object_mut().unwrap().shift_remove("discoveries");
            }
        }
        if record.as_object().unwrap().len() == 1 {
            message.as_object_mut().unwrap().shift_remove("toolContext");
        } else {
            message["toolContext"] = record;
        }
        retained.push(message);
    }
    messages = retained;
    let mut historical = HashMap::new();
    for message in &messages {
        for version in message["toolContext"]["calls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|call| call["definitionVersion"].as_str())
            .chain(
                message["toolContext"]["presentations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|presentation| {
                        presentation["definitions"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                    }),
            )
        {
            if current.contains_key(version) {
                continue;
            }
            let Some(original) = versions.get(version) else {
                return Err(fail(TextId::ContextDiscoveryHistoryCheckpointDefinitionMissing));
            };
            historical.insert(version.to_owned(), original.clone());
        }
    }
    snapshot
        .as_object_mut()
        .unwrap()
        .shift_remove("historicalDefinitions");
    if !historical.is_empty() {
        let mut values: Vec<_> = historical.into_values().collect();
        values.sort_by(|a, b| {
            compare_text(
                a["version"].as_str().unwrap(),
                b["version"].as_str().unwrap(),
            )
        });
        snapshot["historicalDefinitions"] = json!(values);
    }
    if stringify(&snapshot).len() > STATE_BYTES * 2 {
        return Err(fail(TextId::ContextDiscoveryHistoryCheckpointLimit));
    }
    messages[selected_index]["toolContext"]["baseline"] = snapshot.clone();
    read_snapshot(&messages)?;
    if messages[selected_index]["isMeta"] == true
        && messages[selected_index]["toolContext"]["baselineAttachment"] == true
    {
        let content = render_recovery(&snapshot, delivered(&messages, &current),harness);
        messages[selected_index]["content"] = json!(content);
        if content.is_empty()
            && selected_index != 0
            && messages[0]["role"] == "user"
            && messages[0]["content"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            && messages[0]["toolContext"].get("baseline").is_none()
        {
            if !messages[0]["toolContext"].is_object() {
                messages[0]["toolContext"] = json!({});
            }
            messages[0]["toolContext"]["version"] = json!(2);
            messages[0]["toolContext"]["baseline"] = snapshot.clone();
            messages[0]["toolContext"]["baselineAttachment"] = json!(false);
            if snapshot["discoveryEntries"] == true
                || snapshot["directory"] != ""
                || !snapshot["definitions"].as_array().unwrap().is_empty()
            {
                messages[0]["isMeta"] = json!(true);
            }
            messages.remove(selected_index);
        }
    }
    read_snapshot(&messages)?;
    Ok(messages)
}
