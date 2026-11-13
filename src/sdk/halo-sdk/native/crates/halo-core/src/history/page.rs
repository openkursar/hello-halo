use super::jsonl::{Entry, Reader};
use crate::{
    error::{Error, Result},
    harness::TextId,
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};
use tokio_util::sync::CancellationToken;

fn nullish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null() && !crate::js::is_undefined(value))
}
fn data_present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}
fn response_key(entry: &Value, session_id: &str) -> Option<String> {
    let response = entry["responseUuid"].as_str()?;
    Some(crate::js::data::stringify(&json!([
        response,
        data_present(entry.get("sessionId"))
            .cloned()
            .unwrap_or_else(|| json!(session_id)),
        data_present(entry.get("parent_tool_use_id"))
            .cloned()
            .unwrap_or(Value::Null),
        data_present(entry.get("isSidechain"))
            .cloned()
            .unwrap_or_else(|| json!(false))
    ])))
}
fn range(id: TextId) -> Error {
    Error::template("HISTORY_PAGE_RANGE", id, &[]).with_details(json!({"name":"RangeError"}))
}
pub async fn read(
    path: &Path,
    session_id: &str,
    options: &Value,
    cancellation: &CancellationToken,
) -> Result<Vec<Value>> {
    let offset = nullish(options.get("offset"))
        .map(crate::js::safe_integer)
        .unwrap_or(Some(0));
    let limit = nullish(options.get("limit"))
        .map(crate::js::safe_integer)
        .unwrap_or(Some(4096));
    let (Some(offset), Some(limit)) = (offset, limit) else {
        tracing::warn!("Invalid history pagination refused");
        return Err(range(TextId::HistoryPagePagination));
    };
    if offset < 0 || !(0..=4096).contains(&limit) {
        tracing::warn!("Invalid history pagination refused");
        return Err(range(TextId::HistoryPagePagination));
    }
    if limit == 0 {
        return Ok(Vec::new());
    }
    let explicit = options
        .get("limit")
        .is_some_and(|value| !crate::js::is_undefined(value));
    let include_system = crate::js::truthy(&options["includeSystemMessages"]);
    let mut messages = Vec::<Value>::new();
    let mut response_targets = HashMap::<String, usize>::new();
    let mut skipped = 0i64;
    let mut bytes = 0usize;
    let mut damaged = 0usize;
    let result: Result<()> = async {
        let mut reader = Reader::open(path,0,false,cancellation).await?;
        while let Some(record) = reader.next().await? {
            let Entry::Record(record) = record else { unreachable!() };
            let Some(entry) = record.value else { damaged+=1; continue; };
            let internal = entry["message"]["isMeta"] == true && entry["message"]["toolContext"]["baselineAttachment"] == true;
            let visible = !internal && (entry["type"] == "user" || entry["type"] == "assistant" || include_system && entry["type"] == "system");
            if visible { let previous=skipped; skipped+=1; if previous<offset { continue; } }
            if skipped < offset { continue; }
            if visible && messages.len() == limit as usize {
                if !explicit { return Err(range(TextId::HistoryPageDefaultLimit)); }
                break;
            }
            bytes = bytes.saturating_add(record.bytes);
            if bytes > 64*1024*1024 { return Err(range(TextId::HistoryPageByteLimit)); }
            if entry["type"] == "assistant_metadata" {
                let target = response_key(&entry,session_id).and_then(|key| response_targets.get(&key).copied());
                if let Some(index) = target {
                    if (messages[index]["message"].is_object() || messages[index]["message"].is_array()) && (entry["message"].is_object() || entry["message"].is_array()) {
                        let mut enriched = object_spread(&messages[index]["message"]);
                        for field in ["id","model","stop_reason","stop_sequence","usage"] { if let Some(value)=entry["message"].get(field) { enriched[field]=value.clone(); } }
                        messages[index]["message"] = enriched;
                        if explicit && messages.len() == limit as usize { break; }
                    }
                }
                continue;
            }
            if !visible { continue; }
            let mut message = json!({"type":entry["type"],"uuid":data_present(entry.get("uuid")).cloned().unwrap_or_else(||json!("")),"session_id":data_present(entry.get("sessionId")).cloned().unwrap_or_else(||json!(session_id)),"message":data_present(entry.get("message")).cloned().unwrap_or(Value::Null),"parent_tool_use_id":data_present(entry.get("parent_tool_use_id")).cloned().unwrap_or(Value::Null)});
            if let Some(object)=message["message"].as_object_mut() { object.shift_remove("toolContext"); }
            let target = (entry["type"] == "assistant").then(|| response_key(&entry,session_id)).flatten();
            messages.push(message);
            if let Some(key)=target.as_ref() { response_targets.insert(key.clone(),messages.len()-1); }
            if explicit && messages.len() == limit as usize && target.is_none() { break; }
        }
        Ok(())
    }.await;
    if damaged > 0 {
        tracing::warn!(count = damaged, "Malformed history records skipped");
    }
    if let Err(error) = result {
        if explicit && messages.len() == limit as usize {
            tracing::warn!(offset,limit,code=%error.code,"History page returned without final response metadata");
            return Ok(messages);
        }
        if error.code == "ENOENT" {
            return Ok(Vec::new());
        }
        tracing::warn!(offset,limit,code=%error.code,"History page could not be read");
        return Err(error);
    }
    Ok(messages)
}
pub(super) fn object_spread(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        Value::Array(items) => Value::Object(
            items
                .iter()
                .enumerate()
                .map(|(index, value)| (index.to_string(), value.clone()))
                .collect(),
        ),
        Value::String(value) => Value::Object(
            value
                .chars()
                .enumerate()
                .map(|(index, value)| (index.to_string(), json!(value.to_string())))
                .collect(),
        ),
        _ => json!({}),
    }
}
