use super::{
    jsonl::{io_error, Entry, Reader},
    page,
};
use crate::{
    error::{Error, Result},
    harness::TextId,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncReadExt, AsyncWriteExt},
};
use tokio_util::sync::CancellationToken;

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null() && !crate::js::is_undefined(value))
}
fn storage_options(options: &Value, aliases: bool) -> Result<Value> {
    let mut result = if options.is_object() {
        options.clone()
    } else {
        json!({})
    };
    let cwd = if aliases {
        present(options.get("dir")).or_else(|| present(options.get("cwd")))
    } else {
        present(options.get("cwd"))
    };
    result["cwd"] = match cwd {
        Some(value) if value.is_string() => value.clone(),
        Some(_) => {
            return Err(
                Error::template("INVALID_CWD", TextId::HistoryAdminInvalidCwd, &[])
                    .with_details(json!({"name":"TypeError"})),
            )
        }
        None => json!(std::env::current_dir()?.to_string_lossy()),
    };
    Ok(result)
}
fn path(session: &str, options: &Value) -> PathBuf {
    super::transcript_path(session, options)
}
fn archive_directory(session: &str, options: &Value) -> PathBuf {
    path("_placeholder_", options)
        .parent()
        .unwrap()
        .join(session)
        .join("subagents")
}
fn meta_path(session: &str, options: &Value) -> PathBuf {
    path(session, options).with_extension("meta.json")
}
fn first_prompt(line: &str) -> Option<String> {
    let entry = crate::js::json::parse(line).ok()?;
    if entry["type"] != "user"
        || entry["isMeta"] == true
        || entry["message"]["toolContext"]["baselineAttachment"] == true
    {
        return None;
    }
    let content = &entry["message"]["content"];
    if let Some(text) = content.as_str() {
        let text = crate::js::trim_js(text);
        if !text.is_empty() {
            return Some(crate::js::utf16_prefix(text, 200));
        }
    }
    if let Some(blocks) = content.as_array() {
        for block in blocks {
            if block["type"] != "text" {
                continue;
            }
            let value = block
                .get("text")
                .filter(|value| !value.is_null())
                .map(crate::js::data::to_string)
                .unwrap_or_default();
            let text = crate::js::trim_js(&value);
            if !text.is_empty() {
                return Some(crate::js::utf16_prefix(text, 200));
            }
        }
    }
    None
}
async fn read_first_prompt(path: &Path, cancel: &CancellationToken) -> Result<Option<String>> {
    let mut file = match File::open(path).await {
        Ok(file) => file,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error=%error,"First session prompt could not be read");
            }
            return Ok(None);
        }
    };
    let mut buffer = [0u8; 8192];
    let mut pending = Vec::new();
    let mut position = 0;
    while position < 256 * 1024 {
        let length = buffer.len().min(256 * 1024 - position);
        let read = tokio::select! {_=cancel.cancelled()=>return Err(Error::cancelled()),read=file.read(&mut buffer[..length])=>read};
        let count = match read {
            Ok(count) => count,
            Err(error) => {
                tracing::warn!(error=%error,"First session prompt could not be read");
                return Ok(None);
            }
        };
        if count == 0 {
            return Ok(first_prompt(&String::from_utf8_lossy(&pending)));
        }
        position += count;
        let mut start = 0;
        for index in 0..count {
            if buffer[index] == b'\n' {
                pending.extend_from_slice(&buffer[start..index]);
                if let Some(text) = first_prompt(&String::from_utf8_lossy(&pending)) {
                    return Ok(Some(text));
                }
                pending.clear();
                start = index + 1;
            }
        }
        pending.extend_from_slice(&buffer[start..count]);
    }
    Ok(None)
}
async fn read_meta(session: &str, options: &Value) -> Value {
    match fs::read(meta_path(session, options)).await {
        Ok(bytes) => match crate::js::json::parse(&String::from_utf8_lossy(&bytes)) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(session_id=session,code=%error.code,"Session metadata could not be parsed");
                json!({})
            }
        },
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(session_id=session,error=%error,"Session metadata could not be read");
            }
            json!({})
        }
    }
}
fn millis(value: std::io::Result<SystemTime>) -> Value {
    value
        .ok()
        .map(|value| match value.duration_since(UNIX_EPOCH) {
            Ok(value) => {
                value.as_secs() as f64 * 1000.0 + value.subsec_nanos() as f64 / 1_000_000.0
            }
            Err(error) => {
                let value = error.duration();
                -(value.as_secs() as f64 * 1000.0 + value.subsec_nanos() as f64 / 1_000_000.0)
            }
        })
        .map(|value| json!(value))
        .unwrap_or_else(crate::js::undefined)
}
async fn base_info(session: &str, options: &Value) -> Value {
    let mut info = json!({"sessionId":session,"summary":session,"lastModified":0,"fileSize":crate::js::undefined(),"cwd":options["cwd"],"createdAt":crate::js::undefined()});
    match fs::metadata(path(session, options)).await {
        Ok(metadata) => {
            info["fileSize"] = json!(metadata.len());
            info["lastModified"] = millis(metadata.modified());
            info["createdAt"] = millis(metadata.created());
        }
        Err(error) => {
            tracing::warn!(session_id=session,error=%error,"Session file metadata could not be read")
        }
    }
    info
}
async fn enrich(info: &mut Value, options: &Value, cancel: &CancellationToken) -> Result<()> {
    let session = info["sessionId"].as_str().unwrap();
    let file = path(session, options);
    let (metadata, prompt) = tokio::join!(
        read_meta(session, options),
        read_first_prompt(&file, cancel)
    );
    let prompt = prompt?;
    if metadata.is_null() {
        return Err(Error::template(
            "INVALID_SESSION_METADATA",
            TextId::HistoryAdminNullMetadata,
            &[],
        )
        .with_details(json!({"name":"TypeError"})));
    }
    if crate::js::data::truthy(&metadata["title"]) {
        info["customTitle"] = metadata["title"].clone();
    }
    if let Some(tag) = metadata.get("tag").filter(|value| !value.is_null()) {
        info["tag"] = tag.clone();
    }
    if let Some(prompt) = prompt {
        info["firstPrompt"] = json!(prompt);
    }
    info["summary"] = info
        .get("customTitle")
        .or_else(|| info.get("firstPrompt"))
        .cloned()
        .unwrap_or_else(|| info["sessionId"].clone());
    Ok(())
}
fn numeric(value: &Value) -> f64 {
    if let Some(number) = crate::js::number(value) {
        return number;
    }
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::String(value) => {
            let value = crate::js::trim_js(value);
            if value.is_empty() {
                0.0
            } else {
                value.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}
fn slice_index(value: f64, length: usize) -> usize {
    if value.is_nan() || value == 0.0 {
        0
    } else if value < 0.0 {
        (length as f64 + value.trunc()).clamp(0.0, length as f64) as usize
    } else {
        value.trunc().min(length as f64) as usize
    }
}
async fn list(options: &Value, cancel: &CancellationToken) -> Result<Value> {
    if crate::js::truthy(&options["includeWorktrees"]) {
        tracing::warn!("Session listing rejected: worktree enumeration is not supported");
        return Err(Error::template(
            "UNSUPPORTED_WORKTREE_LISTING",
            TextId::HistoryAdminWorktreesUnsupported,
            &[],
        ));
    }
    let options = storage_options(options, true)?;
    let directory = path("_placeholder_", &options).parent().unwrap().to_owned();
    let result: Result<Value> = async {
        let mut directory = fs::read_dir(&directory).await?;
        let mut files = Vec::new();
        while let Some(entry) = directory.next_entry().await? {
            if cancel.is_cancelled() {
                return Err(Error::cancelled());
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(session) = name.strip_suffix(".jsonl") {
                files.push(session.to_owned());
            }
        }
        files.sort_by(|left, right| crate::js::compare_text(left, right));
        let mut sessions = Vec::with_capacity(files.len());
        for session in files {
            sessions.push(base_info(&session, &options).await);
        }
        sessions.sort_by(|left, right| {
            right["lastModified"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&left["lastModified"].as_f64().unwrap_or(0.0))
        });
        let offset = present(options.get("offset"))
            .cloned()
            .unwrap_or_else(|| json!(0));
        let limit = present(options.get("limit"))
            .cloned()
            .unwrap_or_else(|| json!(sessions.len()));
        let end = if offset.is_string() || limit.is_string() {
            numeric(&json!(format!(
                "{}{}",
                crate::js::to_string(&offset),
                crate::js::to_string(&limit)
            )))
        } else {
            numeric(&offset) + numeric(&limit)
        };
        let start = slice_index(numeric(&offset), sessions.len());
        let end = slice_index(end, sessions.len()).max(start);
        let mut selected = sessions.drain(start..end).collect::<Vec<_>>();
        futures::future::try_join_all(
            selected
                .iter_mut()
                .map(|info| enrich(info, &options, cancel)),
        )
        .await?;
        Ok(json!(selected))
    }
    .await;
    match result {
        Ok(value) => Ok(value),
        Err(error) if error.code == "ABORTED" => Err(error),
        Err(error) => {
            tracing::warn!(code=%error.code,"Session listing could not be completed");
            Ok(json!([]))
        }
    }
}
async fn info(session: &str, options: &Value, cancel: &CancellationToken) -> Result<Value> {
    let options = storage_options(options, true)?;
    let file = path(session, &options);
    if File::open(&file).await.is_err() {
        return Ok(crate::js::undefined());
    }
    let mut info = base_info(session, &options).await;
    enrich(&mut info, &options, cancel).await?;
    Ok(info)
}
async fn archived(session: &str, options: &Value) -> Result<Value> {
    let options = storage_options(options, true)?;
    let mut directory = match fs::read_dir(archive_directory(session, &options)).await {
        Ok(directory) => directory,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error=%error,"Archived session records could not be listed");
            }
            return Ok(json!([]));
        }
    };
    let mut ids = Vec::new();
    loop {
        match directory.next_entry().await {
            Ok(Some(entry)) => {
                let file = entry.file_name().to_string_lossy().into_owned();
                if let Some(id) = file
                    .strip_prefix("agent-")
                    .and_then(|file| file.strip_suffix(".jsonl"))
                {
                    ids.push(id.to_owned());
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(error=%error,"Archived session records could not be listed");
                return Ok(json!([]));
            }
        }
    }
    ids.sort_by(|left, right| crate::js::compare_text(left, right));
    Ok(json!(ids))
}
async fn fork(session: &str, options: &Value, cancel: &CancellationToken) -> Result<Value> {
    let options = storage_options(options, false)?;
    let source = path(session, &options);
    let id = uuid::Uuid::new_v4().to_string();
    let destination = path(&id, &options);
    let anchor = options
        .get("upToMessageId")
        .filter(|value| !crate::js::is_undefined(value));
    let mut found = anchor.is_none();
    let mut output: Option<File> = None;
    let mut damaged = 0usize;
    let result: Result<()> = async {
        let mut reader = Reader::open(&source, 0, false, cancel).await?;
        while let Some(entry) = reader.next().await? {
            let Entry::Record(record) = entry else {
                unreachable!()
            };
            if output.is_none() {
                let mut open = OpenOptions::new();
                open.write(true).create_new(true);
                #[cfg(unix)]
                open.mode(0o600);
                output = Some(
                    open.open(&destination)
                        .await
                        .map_err(|error| io_error(error, "open", &destination))?,
                );
            }
            let (line, matched) = if let Some(mut value) = record.value {
                let matched = anchor.is_some_and(|anchor| value.get("uuid") == Some(anchor));
                value["sessionId"] = json!(id);
                (crate::js::data::stringify(&value), matched)
            } else {
                damaged += 1;
                (record.line, false)
            };
            let output = output.as_mut().unwrap();
            output
                .write_all(line.as_bytes())
                .await
                .map_err(|error| io_error(error, "write", &destination))?;
            output
                .write_all(b"\n")
                .await
                .map_err(|error| io_error(error, "write", &destination))?;
            output
                .flush()
                .await
                .map_err(|error| io_error(error, "write", &destination))?;
            if matched {
                found = true;
                break;
            }
        }
        if !found {
            return Err(Error::template(
                "FORK_ANCHOR_MISSING",
                TextId::HistoryAdminForkAnchorMissing,
                &[],
            ));
        }
        Ok(())
    }
    .await;
    let created = output.take().is_some();
    if damaged > 0 {
        tracing::warn!(
            session_id = session,
            count = damaged,
            "Session fork preserved malformed records"
        );
    }
    if let Err(error) = result {
        if created {
            if let Err(cleanup) = fs::remove_file(&destination).await {
                if cleanup.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error=%cleanup,"Failed fork destination could not be removed");
                }
            }
        }
        tracing::warn!(session_id=session,code=%error.code,"Session fork failed");
        return Err(error);
    }
    Ok(json!({"sessionId":id}))
}
async fn mutate(session: &str, key: &str, value: &Value, options: &Value) -> Result<Value> {
    let options = storage_options(options, false)?;
    let mut metadata = page::object_spread(&read_meta(session, &options).await);
    metadata[key] = value.clone();
    if metadata["tag"].is_null() {
        metadata.as_object_mut().unwrap().shift_remove("tag");
    }
    if crate::js::is_undefined(value) {
        metadata.as_object_mut().unwrap().shift_remove(key);
    }
    let file = meta_path(session, &options);
    if let Some(parent) = file.parent() {
        if let Err(error) = fs::create_dir_all(parent).await {
            tracing::warn!(session_id=session,error=%error,"Session metadata directory could not be created");
        }
    }
    let text = crate::js::data::stringify_pretty(&metadata) + "\n";
    if let Err(error) = fs::write(&file, text).await {
        tracing::warn!(session_id=session,error=%error,"Session metadata update could not be saved");
    }
    Ok(crate::js::undefined())
}
pub async fn execute(
    operation: &str,
    options: &Value,
    payload: &Value,
    cancel: &CancellationToken,
) -> Result<Value> {
    if cancel.is_cancelled() {
        return Err(Error::cancelled());
    }
    let session = payload["sessionId"].as_str().unwrap_or("");
    match operation {
        "latestSession" => {
            let options = storage_options(options, false)?;
            tokio::select! {
                _ = cancel.cancelled() => Err(Error::cancelled()),
                latest = super::latest_session(&options) => Ok(json!(latest)),
            }
        }
        "listSessions" => list(options, cancel).await,
        "getSessionInfo" => info(session, options, cancel).await,
        "getSessionMessages" => {
            let options = storage_options(options, true)?;
            Ok(json!(
                page::read(&path(session, &options), session, &options, cancel).await?
            ))
        }
        "listArchivedRecords" => archived(session, options).await,
        "getArchivedRecordMessages" => {
            let options = storage_options(options, true)?;
            let agent = payload["agentId"].as_str().unwrap_or("");
            Ok(json!(
                page::read(
                    &archive_directory(session, &options).join(format!("agent-{agent}.jsonl")),
                    agent,
                    &options,
                    cancel
                )
                .await?
            ))
        }
        "forkSession" => fork(session, options, cancel).await,
        "renameSession" => {
            mutate(
                session,
                "title",
                payload.get("title").unwrap_or(&crate::js::undefined()),
                options,
            )
            .await
        }
        "tagSession" => {
            mutate(
                session,
                "tag",
                payload.get("tag").unwrap_or(&crate::js::undefined()),
                options,
            )
            .await
        }
        _ => Err(Error::template(
            "UNKNOWN_HISTORY_OPERATION",
            TextId::HistoryAdminUnknownOperation,
            &[("name", operation.into())],
        )),
    }
}
