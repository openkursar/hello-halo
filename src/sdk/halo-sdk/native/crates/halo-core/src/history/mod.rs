pub mod admin;
pub mod page;
mod jsonl;
mod latest;
pub use latest::latest_session;
use crate::{
    core::tool_context::history::{merge, read_snapshot, valid_record},
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    js::{data::stringify, trim_js},
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
};

const MAX_HISTORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_HISTORY_MESSAGES: usize = 4096;
const MAX_LINE_BYTES: u64 = 32 * 1024 * 1024;

pub fn transcript_path(session_id: &str, options: &Value) -> PathBuf {
    let cwd = options["cwd"].as_str().unwrap_or("");
    let project: String = cwd
        .encode_utf16()
        .map(|code| {
            if code < 128 && (code as u8).is_ascii_alphanumeric() {
                char::from_u32(code as u32).unwrap()
            } else {
                '-'
            }
        })
        .collect();
    Path::new(&crate::tools::config_dir(options))
        .join("projects")
        .join(project)
        .join(format!("{session_id}.jsonl"))
}

pub fn resume_error(reason: &str) -> Error {
    Error::new(
        "RESUME_HISTORY_UNAVAILABLE",
        format!("Stored session history cannot be restored as recorded ({reason})"),
    )
    .with_details(json!({"name":"ResumeHistoryError","reason":reason}))
}

#[derive(Clone)]
pub struct Journal {
    inner: std::sync::Arc<tokio::sync::Mutex<JournalState>>,
    #[cfg(test)]
    checkpoint_gate: std::sync::Arc<std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>>,
    #[cfg(test)]
    append_gate: std::sync::Arc<std::sync::Mutex<Option<(std::sync::Arc<std::sync::atomic::AtomicBool>, std::sync::Arc<tokio::sync::Notify>, bool)>>>,
}
impl Journal {
    pub async fn new(session_id: &str, options: &Value) -> Result<Self> {
        Ok(Self {
            inner: std::sync::Arc::new(tokio::sync::Mutex::new(
                JournalState::new(session_id, options).await?,
            )),
            #[cfg(test)]
            checkpoint_gate: Default::default(),
            #[cfg(test)]
            append_gate: Default::default(),
        })
    }
    pub async fn append(
        &self,
        kind: &str,
        message: Value,
        uuid: &str,
        response: Option<&str>,
        strict: bool,
    ) -> Result<()> {
        #[cfg(test)]
        {
            let gate = self.append_gate.lock().unwrap().take();
            if let Some((entered, released, discovery_only)) = gate {
                let eligible = !discovery_only
                    || (kind == "user"
                        && message
                            .get("toolContext")
                            .and_then(|value| value.get("discoveries"))
                            .is_some());
                if eligible {
                    entered.store(true, std::sync::atomic::Ordering::SeqCst);
                    released.notified().await;
                } else {
                    *self.append_gate.lock().unwrap() = Some((entered, released, discovery_only));
                }
            }
        }
        self.inner
            .lock()
            .await
            .append(kind, message, uuid, response, strict)
            .await
    }
    pub async fn checkpoint(&self, messages: &[Value], summary: &str) -> Result<()> {
        #[cfg(test)]
        {
            let gate = self.checkpoint_gate.lock().unwrap().take();
            if let Some((entered, released)) = gate {
                let _ = entered.send(());
                released.await.expect("checkpoint test gate must be released");
            }
        }
        self.inner.lock().await.checkpoint(messages, summary).await
    }
    #[cfg(test)]
    pub(crate) fn pause_next_append(&self) -> (std::sync::Arc<std::sync::atomic::AtomicBool>, std::sync::Arc<tokio::sync::Notify>) {
        self.pause_append(false)
    }
    #[cfg(test)]
    pub(crate) fn pause_next_discovery_append(&self) -> (std::sync::Arc<std::sync::atomic::AtomicBool>, std::sync::Arc<tokio::sync::Notify>) {
        self.pause_append(true)
    }
    #[cfg(test)]
    fn pause_append(&self, discovery_only: bool) -> (std::sync::Arc<std::sync::atomic::AtomicBool>, std::sync::Arc<tokio::sync::Notify>) {
        let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        *self.append_gate.lock().unwrap() = Some((entered.clone(), release.clone(), discovery_only));
        (entered, release)
    }
    #[cfg(test)]
    pub(crate) fn pause_next_checkpoint(&self) -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
        let (entered, observed) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        *self.checkpoint_gate.lock().unwrap() = Some((entered, released));
        (observed, release)
    }
    pub async fn flush(&self) -> Result<()> {
        self.inner.lock().await.flush().await
    }
    pub async fn set_tool_context_mode(&self) {
        self.inner.lock().await.tool_context_mode = true;
    }
    pub async fn has_complete_history(&self) -> bool { let state=self.inner.lock().await;state.enabled&&!state.write_failed }
}

struct JournalState {
    path: PathBuf,
    session_id: String,
    cwd: String,
    parent: Option<String>,
    branch: Option<String>,
    enabled: bool,
    tool_context_mode: bool,
    write_failed: bool,
}

async fn probe_git_branch(cwd: &str, options: &Value) -> Option<String> {
    let mut command = tokio::process::Command::new("git");
    command.args(["rev-parse", "--abbrev-ref", "HEAD"]).current_dir(cwd).env_clear()
        .envs(crate::core::conventions::merged_environment(&crate::core::conventions::process_environment(options), &[], cfg!(windows)))
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    #[cfg(unix)] command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => { tracing::warn!(error=%error,"Git branch probe could not start"); return None; }
    };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let owner = std::sync::Arc::new(crate::processes::OwnedProcesses::default());
    let process = owner.track(child, cfg!(unix));
    async fn capture(stream: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        stream.take(1_048_577).read_to_end(&mut bytes).await?;
        Ok(bytes)
    }
    let operation = async {
        let (output, errors) = tokio::join!(capture(stdout), capture(stderr));
        let (output, errors) = (output?, errors?);
        if output.len() > 1_048_576 || errors.len() > 1_048_576 {
            process.abort_now();
            tracing::warn!("Git branch probe output exceeded its capture limit");
            return Ok(None);
        }
        let status = process.wait().await?;
        let text = String::from_utf8_lossy(&output);
        let text = trim_js(&text);
        Ok::<_, std::io::Error>((status.success() && !text.is_empty()).then(|| text.to_owned()))
    };
    match tokio::time::timeout(std::time::Duration::from_secs(2), operation).await {
        Ok(Ok(branch)) => branch,
        outcome => {
            process.abort_now();
            let _ = process.wait().await;
            match outcome {
                Ok(Err(error)) => tracing::warn!(error=%error,"Git branch probe could not finish"),
                Err(_) => tracing::warn!("Git branch probe exceeded its deadline"),
                _ => unreachable!(),
            }
            None
        }
    }
}

impl JournalState {
    pub async fn new(session_id: &str, options: &Value) -> Result<Self> {
        let cwd = options["cwd"].as_str().unwrap_or("").to_owned();
        let enabled = !cwd.is_empty() && options["persistSession"] != false && options["nativeQuery"] != true;
        let branch = if enabled { probe_git_branch(&cwd, options).await } else { None };
        Ok(Self {
            path: transcript_path(session_id, options),
            session_id: session_id.into(),
            enabled,
            cwd,
            parent: None,
            branch,
            tool_context_mode: false,
            write_failed: false,
        })
    }

    pub async fn append(
        &mut self,
        kind: &str,
        message: Value,
        uuid: &str,
        response: Option<&str>,
        strict: bool,
    ) -> Result<()> {
        let mut entry = json!({"type":kind});
        if let Some(response) = response {
            entry["responseUuid"] = json!(response);
        }
        entry["message"] = message;
        entry["uuid"] = json!(uuid);
        entry["parentUuid"] = json!(self.parent);
        self.metadata(&mut entry);
        let result = self.write(&entry).await;
        if result.is_ok() && ["user", "assistant"].contains(&kind) {
            self.parent = Some(uuid.into());
        }
        if strict { result } else { Ok(()) }
    }

    pub async fn checkpoint(&mut self, messages: &[Value], summary: &str) -> Result<()> {
        if messages.is_empty()
            || messages.len() > MAX_HISTORY_MESSAGES
            || !messages.iter().all(valid_message)
        {
            return Err(Error::new(
                "INVALID_CHECKPOINT",
                "Compact checkpoint requires 1 to 4096 valid messages",
            ));
        }
        let snapshot = read_snapshot(messages)?;
        if snapshot.is_some() {
            self.tool_context_mode = true;
        }
        let mut entry = json!({"type":"compact_checkpoint","checkpointVersion":if snapshot.is_some() { 2 } else { 1 },"uuid":uuid::Uuid::new_v4().to_string(),"summary":summary,"messages":messages,"parentUuid":self.parent});
        self.metadata(&mut entry);
        if stringify(&entry).len() > 16 * 1024 * 1024 {
            return Err(Error::new(
                "CHECKPOINT_SIZE",
                "Compact checkpoint exceeds the 16 MiB restoration limit",
            ));
        }
        self.write(&entry).await
    }

    fn metadata(&self, entry: &mut Value) {
        entry["sessionId"] = json!(self.session_id);
        entry["timestamp"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        entry["isSidechain"] = json!(false);
        entry["userType"] = json!("external");
        entry["cwd"] = json!(self.cwd);
        entry["version"] = json!("1.0.0");
        if let Some(branch) = &self.branch {
            entry["gitBranch"] = json!(branch);
        }
    }

    async fn write(&mut self, entry: &Value) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let result: Result<()> = async {
            let has_context = ["user", "assistant"].contains(&entry["type"].as_str().unwrap_or(""))
                && entry["message"].get("toolContext").is_some();
            if has_context && !valid_record(&entry["message"]["toolContext"]) {
                return Err(Error::new(
                    "INVALID_TOOL_CONTEXT",
                    "Invalid tool context journal metadata",
                ));
            }
            let mut stored = if has_context || self.tool_context_mode {
                json!({"toolContextVersion":2,"toolContextRecord":has_context})
            } else {
                json!({})
            };
            stored
                .as_object_mut()
                .unwrap()
                .extend(entry.as_object().unwrap().clone());
            let text = format!("{}\n", stringify(&stored));
            fs::create_dir_all(self.path.parent().unwrap()).await?;
            let mut file = OpenOptions::new().create(true).append(true).open(&self.path).await?;
            file.write_all(text.as_bytes()).await?;
            file.flush().await?;
            Ok(())
        }
        .await;
        if let Err(error) = &result {
            self.write_failed = true;
            tracing::warn!(session_id=%self.session_id, entry_type=%entry["type"], code=%error.code, "Failed to append entry; transcript may be incomplete on resume");
        }
        result
    }

    pub async fn flush(&mut self) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct Record {
    message: Value,
    bytes: usize,
    reply: Option<String>,
    attached: bool,
    checkpoint: bool,
}

pub struct ReadReport {
    pub messages: Vec<Value>,
    pub damaged: usize,
    pub omitted: usize,
    pub anchor_found: bool,
    pub tool_context: bool,
    pub tool_context_damaged: bool,
}

pub async fn read_report(path: &Path, anchor: Option<&str>) -> Result<ReadReport> {
    read_report_with_harness(path, anchor, &crate::harness::baseline()).await
}

pub async fn read_report_with_harness(
    path: &Path,
    anchor: Option<&str>,
    harness: &ResolvedHarness,
) -> Result<ReadReport> {
    let mut file = File::open(path).await.map_err(|error| {
        resume_error(if error.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "unreadable"
        })
    })?;
    let size = file.metadata().await?.len();
    let start = if anchor.is_none() {
        size.saturating_sub(MAX_HISTORY_BYTES as u64)
    } else {
        0
    };
    let mut tool_context = false;
    let mut sidechain: Option<bool> = None;
    if start > 0 {
        sidechain = Some(false);
        let mut prefix = vec![0; 64 * 1024];
        let count = file.read(&mut prefix).await?;
        let first = prefix[..count]
            .split(|byte| *byte == b'\n')
            .next()
            .unwrap_or(&[]);
        tool_context = first.starts_with(b"{\"toolContextVersion\":");
        if let Ok(first) = serde_json::from_slice::<Value>(first) {
            sidechain = Some(first["type"] == "agent_task" || first["isSidechain"] == true);
            tool_context |= first["message"].get("toolContext").is_some()
                || first["checkpointVersion"].as_f64() == Some(2.0);
        }
    }
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut reader = BufReader::new(file);
    let mut omitted = usize::from(start > 0);
    if start > 0 {
        let mut discarded = Vec::new();
        reader.read_until(b'\n', &mut discarded).await?;
    }
    let mut records = VecDeque::<Record>::new();
    let (mut bytes, mut damaged, mut anchor_found) = (0usize, 0usize, anchor.is_none());
    let mut tool_context_damaged = false;
    loop {
        let mut line = Vec::new();
        let mut bounded = (&mut reader).take(MAX_LINE_BYTES + 1);
        let count = bounded.read_until(b'\n', &mut line).await?;
        if count == 0 {
            break;
        }
        if count as u64 > MAX_LINE_BYTES {
            omitted += 1;
            if !line.ends_with(b"\n") {
                loop {
                    line.clear();
                    let mut bounded = (&mut reader).take(MAX_LINE_BYTES);
                    if bounded.read_until(b'\n', &mut line).await? == 0 || line.ends_with(b"\n") {
                        break;
                    }
                }
            }
            continue;
        }
        let entry: Value = match serde_json::from_slice(&line) {
            Ok(entry) => entry,
            Err(_) => {
                damaged += 1;
                if line.starts_with(b"{\"toolContextVersion\":") {
                    tool_context = true;
                    tool_context_damaged = true;
                }
                continue;
            }
        };
        if sidechain.is_some_and(|value| value != (entry["isSidechain"] == true)) {
            continue;
        }
        let anchored = anchor.is_some_and(|anchor| entry["uuid"].as_str() == Some(anchor));
        anchor_found |= anchored;
        if entry.get("toolContextVersion").is_some()
            && ![
                "user",
                "assistant",
                "assistant_metadata",
                "compact_checkpoint",
            ]
            .contains(&entry["type"].as_str().unwrap_or(""))
        {
            tool_context = true;
            tool_context_damaged = true;
            damaged += 1;
            if anchored {
                break;
            }
            continue;
        }
        if entry["type"] == "compact_checkpoint" {
            let new_format = entry["checkpointVersion"].as_f64() != Some(1.0);
            let snapshot_valid = entry["messages"].as_array().is_some_and(|messages| {
                read_snapshot(messages).is_ok_and(|snapshot| {
                    snapshot.is_some() == (entry["checkpointVersion"].as_f64() == Some(2.0))
                })
            });
            if ![Some(1.0), Some(2.0)].contains(&entry["checkpointVersion"].as_f64())
                || !entry["summary"].is_string()
                || !entry["uuid"].is_string()
                || count > 16 * 1024 * 1024
                || entry["messages"].as_array().is_none_or(|messages| {
                    messages.is_empty()
                        || messages.len() > MAX_HISTORY_MESSAGES
                        || !messages.iter().all(valid_message)
                })
                || !snapshot_valid
                || (tool_context && !new_format)
            {
                damaged += 1;
                tool_context_damaged |= new_format || tool_context;
            } else {
                tool_context = entry["checkpointVersion"].as_f64() == Some(2.0);
                tool_context_damaged = false;
                records.clear();
                bytes = 0;
                omitted = 0;
                damaged = 0;
                sidechain.get_or_insert(entry["isSidechain"] == true);
                for message in entry["messages"].as_array().unwrap() {
                    let size = stringify(message).len() * 2;
                    bytes += size;
                    records.push_back(Record {
                        message: message.clone(),
                        bytes: size,
                        reply: None,
                        attached: false,
                        checkpoint: true,
                    });
                }
            }
        } else if entry["type"] == "system" && entry["subtype"] == "compact_boundary" {
            if tool_context {
                damaged += 1;
                tool_context_damaged = true;
            } else {
                records.clear();
                bytes = 0;
                omitted = 0;
                damaged = 0;
            }
        } else if ["user", "assistant"].contains(&entry["type"].as_str().unwrap_or(""))
            && valid_message(&entry["message"])
        {
            if entry.get("toolContextVersion").is_some()
                || entry["message"].get("toolContext").is_some()
            {
                tool_context = true;
                let requires = entry["message"].get("toolContext").is_some()
                    || entry["toolContextRecord"] != false;
                if entry
                    .get("toolContextVersion")
                    .is_some_and(|version| ![Some(1.0), Some(2.0)].contains(&version.as_f64()))
                    || entry
                        .get("toolContextRecord")
                        .is_some_and(|flag| !flag.is_boolean())
                    || (requires && !valid_record(&entry["message"]["toolContext"]))
                {
                    damaged += 1;
                    tool_context_damaged = true;
                    if anchored {
                        break;
                    }
                    continue;
                }
            }
            sidechain.get_or_insert(entry["isSidechain"] == true);
            let size = count * 2;
            while !records.is_empty()
                && (bytes + size > MAX_HISTORY_BYTES || records.len() >= MAX_HISTORY_MESSAGES)
            {
                bytes -= records.pop_front().unwrap().bytes;
                omitted += 1;
            }
            let mut message =
                json!({"role":entry["message"]["role"],"content":entry["message"]["content"]});
            for key in ["toolContext", "isMeta"] {
                if let Some(value) = entry["message"].get(key) {
                    message[key] = value.clone();
                }
            }
            let reply = if message["role"] == "assistant" {
                let local = entry["responseUuid"].as_str().filter(|s| !s.is_empty());
                let provider = entry["message"]["id"].as_str().filter(|s| !s.is_empty());
                local.or(provider).map(|id| {
                    stringify(&json!([
                        if local.is_some() {
                            "response"
                        } else {
                            "message"
                        },
                        id,
                        entry["sessionId"],
                        entry["parent_tool_use_id"]
                    ]))
                })
            } else {
                None
            };
            let attached = message["role"] == "user"
                && (entry["isMeta"] == true
                    || message["content"].as_array().is_some_and(|blocks| {
                        !blocks.is_empty()
                            && blocks.iter().all(|block| block["type"] == "tool_result")
                    }));
            records.push_back(Record {
                message,
                bytes: size,
                reply,
                attached,
                checkpoint: false,
            });
            bytes += size;
        } else if ["user", "assistant"].contains(&entry["type"].as_str().unwrap_or(""))
            && (entry.get("toolContextVersion").is_some()
                || entry["message"].get("toolContext").is_some())
        {
            tool_context = true;
            tool_context_damaged = true;
            damaged += 1;
        }
        if anchored {
            break;
        }
    }
    let mut messages = match group_records(records.clone()) {
        Ok(messages) => messages,
        Err(error) => {
            tracing::warn!(code=%error.code,"Tool context history records could not be grouped");
            damaged += 1;
            tool_context_damaged = true;
            records.into_iter().map(|record| record.message).collect()
        }
    };
    if tool_context
        && (damaged > 0 || !read_snapshot(&messages).is_ok_and(|snapshot| snapshot.is_some()))
    {
        tool_context_damaged = true;
    }
    if omitted > 0 {
        messages.insert(0, json!({"role":"user","content":harness.text(TextId::ContextHistoryBoundedOmission)}));
    }
    if damaged > 0 || omitted > 0 {
        tracing::warn!(
            damaged,
            omitted,
            "History restored with bounded or incomplete records"
        );
    }
    Ok(ReadReport {
        messages,
        damaged,
        omitted,
        anchor_found,
        tool_context,
        tool_context_damaged,
    })
}

fn valid_message(value: &Value) -> bool {
    ["user", "assistant"].contains(&value["role"].as_str().unwrap_or(""))
        && (value["content"].is_string()
            || value["content"].as_array().is_some_and(|blocks| {
                blocks
                    .iter()
                    .all(|block| block.is_object() && block["type"].is_string())
            }))
        && value.get("toolContext").is_none_or(valid_record)
}

fn blocks(content: &Value) -> Vec<Value> {
    if let Some(text) = content.as_str() {
        if text.is_empty() {
            vec![]
        } else {
            vec![json!({"type":"text","text":text})]
        }
    } else {
        content.as_array().cloned().unwrap_or_default()
    }
}

fn group_records(records: VecDeque<Record>) -> Result<Vec<Value>> {
    let mut messages: Vec<Value> = Vec::new();
    let mut open: Option<(String, usize, Option<usize>)> = None;
    for record in records {
        if record.checkpoint {
            messages.push(record.message);
            open = None;
            continue;
        }
        if record.message["role"] == "assistant" {
            if let Some((key, reply, results)) = &open {
                if record.reply.as_ref() == Some(key)
                    && (messages.len() - 1 == *reply || Some(messages.len() - 1) == *results)
                {
                    messages[*reply]["content"]
                        .as_array_mut()
                        .unwrap()
                        .extend(blocks(&record.message["content"]));
                    if let Some(metadata) = merge(
                        messages[*reply].get("toolContext"),
                        record.message.get("toolContext"),
                    )? {
                        messages[*reply]["toolContext"] = metadata;
                    }
                    continue;
                }
            }
            if record.reply.is_some() && record.message["content"].is_array() {
                open = Some((record.reply.unwrap(), messages.len(), None));
            } else {
                open = None;
            }
            messages.push(record.message);
        } else {
            if let Some((_, reply, results)) = &mut open {
                if record.attached
                    && record.message["isMeta"] != true
                    && record.message["toolContext"].get("baseline").is_none()
                    && (messages.len() - 1 == *reply || Some(messages.len() - 1) == *results)
                {
                    let result = *results.get_or_insert_with(|| {
                        let index = messages.len();
                        messages.push(json!({"role":"user","content":[]}));
                        index
                    });
                    messages[result]["content"]
                        .as_array_mut()
                        .unwrap()
                        .extend(blocks(&record.message["content"]));
                    if let Some(metadata) = merge(
                        messages[result].get("toolContext"),
                        record.message.get("toolContext"),
                    )? {
                        messages[result]["toolContext"] = metadata;
                    }
                    continue;
                }
            }
            messages.push(record.message);
            open = None;
        }
    }
    for message in &mut messages {
        if message["role"] == "user" {
            if let Some(content) = message["content"].as_array_mut() {
                content.sort_by_key(|block| block["type"] != "tool_result");
            }
        }
    }
    Ok(messages)
}

pub async fn read_session_tool_context_mode(session_id: &str, options: Value) -> Result<String> {
    if trim_js(session_id).is_empty()
        || options["cwd"]
            .as_str()
            .is_none_or(|cwd| trim_js(cwd).is_empty())
        || options["resumeSessionAt"] == ""
    {
        return Err(Error::new("INVALID_ARGUMENT", "Session context inspection requires a session ID, working directory and nonempty optional anchor").with_details(json!({"name":"TypeError"})));
    }
    let report = read_report(
        &transcript_path(session_id, &options),
        options["resumeSessionAt"].as_str(),
    )
    .await?;
    if !report.anchor_found || report.damaged > 0 || report.tool_context_damaged {
        return Err(resume_error("incomplete"));
    }
    if report.messages.is_empty() {
        return Err(resume_error("unreadable"));
    }
    Ok(if report.tool_context {
        "deferred"
    } else {
        "full"
    }
    .into())
}

#[cfg(test)]
mod tests;
