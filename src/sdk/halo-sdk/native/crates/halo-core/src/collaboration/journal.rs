use super::store::{JournalSink, MemoryStore, ScopeStore};
use crate::error::{Error, Result};
use async_trait::async_trait;
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct FileScopeStore {
    pub store: Arc<MemoryStore>,
    journal: Arc<FileJournal>,
}
struct FileState {
    file: Option<File>,
    separator: bool,
    failed: Option<Error>,
}
struct FileJournal {
    state: Arc<Mutex<FileState>>,
    closed: Arc<AtomicBool>,
}

fn malformed(message: &str) -> Error {
    Error::new("COLLABORATION_JOURNAL", message)
}

fn validate_mutation(mutation: &Value) -> Result<()> {
    let object = mutation
        .as_object()
        .ok_or_else(|| malformed("Malformed collaboration journal mutation"))?;
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or("");
    let row = &mutation["value"];
    let id = if kind == "remove_member" {
        mutation["id"].as_str()
    } else {
        row["id"].as_str()
    }
    .unwrap_or("");
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(malformed("Invalid collaboration journal identity"));
    }
    if kind == "remove_member" {
        return Ok(());
    }
    if !row.is_object() {
        return Err(malformed("Missing collaboration journal row"));
    }
    let string = |key: &str| row[key].is_string();
    let finite = |key: &str| row[key].as_f64().is_some_and(f64::is_finite);
    if kind == "member" {
        let valid = ["name", "parentId", "prompt"].iter().all(|key| string(key))
            && finite("createdAt")
            && row.get("state").is_none_or(|v| {
                matches!(
                    v.as_str(),
                    Some("idle" | "queued" | "running" | "stopped" | "error")
                )
            })
            && ["cwd", "model", "workingDirectory", "worktreePath"]
                .iter()
                .all(|key| row.get(key).is_none() || string(key))
            && row.get("isolation").is_none_or(|v| v == "worktree")
            && row
                .get("origin")
                .is_none_or(|v| v == "guest" || v == "colleague");
        if !valid {
            return Err(malformed("Invalid collaborator record"));
        }
    } else {
        if !string("teamId") || !string("epochId") || !finite("createdAt") {
            return Err(malformed("Invalid collaboration scope record"));
        }
        match kind {
            "task" => {
                if !string("title")
                    || !matches!(
                        row["status"].as_str(),
                        Some("pending" | "in_progress" | "done" | "rejected" | "blocked")
                    )
                    || !string("createdByAppId")
                {
                    return Err(malformed("Invalid collaboration task"));
                }
            }
            "finding" => {
                if !string("authorAppId") {
                    return Err(malformed("Invalid collaboration finding"));
                }
            }
            "activity" => {
                if !matches!(
                    row["kind"].as_str(),
                    Some(
                        "message"
                            | "reply"
                            | "task_post"
                            | "task_update"
                            | "finding"
                            | "check_set"
                            | "check_stop"
                            | "run_end"
                            | "decision"
                    )
                ) || !string("actorAppId")
                    || !string("subject")
                {
                    return Err(malformed("Invalid collaboration activity"));
                }
            }
            _ => return Err(malformed("Unknown collaboration journal mutation")),
        }
    }
    Ok(())
}

impl FileScopeStore {
    pub async fn open(
        path: PathBuf,
        team: String,
        epoch: String,
        max_records: usize,
        max_bytes: usize,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| malformed("Invalid collaboration journal path"))?;
        tokio::fs::create_dir_all(parent).await?;
        let mut options = OpenOptions::new();
        options.create(true).read(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        loop {
            if cancel.is_cancelled() {
                return Err(Error::cancelled());
            }
            match file.try_lock_exclusive() {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::select! {_=cancel.cancelled()=>return Err(Error::cancelled()),_=tokio::time::sleep(Duration::from_millis(25))=>{}}
                }
                Err(error) => return Err(error.into()),
            }
        }
        let journal = Arc::new(FileJournal {
            closed: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(FileState {
                file: Some(file),
                separator: false,
                failed: None,
            })),
        });
        let store = Arc::new(MemoryStore::new(
            team.clone(),
            epoch.clone(),
            max_records,
            max_bytes,
            Some(journal.clone()),
        )?);
        let state = journal.state.clone();
        let replay_store = store.clone();
        let token = cancel.clone();
        tokio::task::spawn_blocking(move || {
            replay(&path, &team, &epoch, &replay_store, &state, &token)
        })
        .await
        .map_err(|error| malformed(&error.to_string()))??;
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        Ok(Self { store, journal })
    }
    pub async fn close(&self) -> Result<()> {
        let result = self.store.flush().await;
        self.journal.closed.store(true, Ordering::Release);
        let state = self.journal.state.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = state.lock().unwrap();
            if let Some(file) = state.file.take() {
                FileExt::unlock(&file)?;
            }
            Ok::<_, Error>(())
        })
        .await
        .map_err(|error| malformed(&error.to_string()))??;
        result
    }
    pub fn abort_now(&self) {
        self.journal.closed.store(true, Ordering::Release);
        if let Ok(mut state) = self.journal.state.try_lock() {
            state.file.take();
        }
    }
}

fn replay(
    path: &Path,
    team: &str,
    epoch: &str,
    store: &MemoryStore,
    state: &Mutex<FileState>,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut state = state.lock().unwrap();
    let file = state.file.as_mut().unwrap();
    let size = file.metadata()?.len();
    file.seek(SeekFrom::Start(0))?;
    if size == 0 {
        writeln!(
            file,
            "{}",
            json!({"type":"scope","version":1,"teamId":team,"epochId":epoch})
        )?;
        file.sync_all()?;
        return Ok(());
    }
    let mut header = false;
    let mut damaged: Option<(u64, Vec<u8>)> = None;
    let mut pending = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut start = 0u64;
    let mut separator = false;
    let mut accept = |line: &[u8], terminated: bool, start: u64| -> Result<()> {
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        if line.is_empty() {
            return Ok(());
        }
        if damaged.is_some() {
            return Err(malformed(
                "The collaboration journal contains a damaged non-final record.",
            ));
        }
        let decoded = String::from_utf8_lossy(line);
        let value: Value = match serde_json::from_str(&decoded) {
            Ok(value) if matches!(value, Value::Object(_)) => value,
            _ => {
                damaged = Some((start, decoded.into_owned().into_bytes()));
                return Ok(());
            }
        };
        if !header {
            if value["type"] != "scope"
                || value["version"].as_f64() != Some(1.0)
                || value["teamId"] != team
                || value["epochId"] != epoch
            {
                return Err(malformed(
                    "The collaboration journal scope or version does not match.",
                ));
            }
            header = true;
        } else {
            if value["type"] != "mutation" || value["version"].as_f64() != Some(1.0) {
                return Err(malformed("Unsupported collaboration journal record"));
            }
            validate_mutation(&value["mutation"])?;
            store.apply(&value["mutation"])?;
        }
        separator = !terminated;
        Ok(())
    };
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..read]);
        let mut processed = 0;
        while let Some(relative) = pending[processed..].iter().position(|b| *b == b'\n') {
            let end = processed + relative;
            if end - processed > 32 * 1024 * 1024 {
                return Err(malformed("Transcript record exceeds the 32 MiB limit"));
            }
            accept(&pending[processed..end], true, start)?;
            start += (end - processed + 1) as u64;
            processed = end + 1;
        }
        if processed > 0 {
            pending.drain(..processed);
        }
        if pending.len() > 32 * 1024 * 1024 {
            return Err(malformed("Transcript record exceeds the 32 MiB limit"));
        }
    }
    if !pending.is_empty() {
        accept(&pending, false, start)?;
    }
    drop(accept);
    if !header {
        return Err(malformed(
            "The collaboration journal header is unavailable.",
        ));
    }
    if let Some((at, line)) = damaged {
        let recovery = PathBuf::from(format!(
            "{}.recovery-{}",
            path.display(),
            super::protocol::now()
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(recovery)?.write_all(&line)?;
        file.set_len(at)?;
        tracing::warn!("[Collaboration] Incomplete final journal record preserved separately: epoch={epoch} bytes={}",line.len());
        separator = false;
    }
    state.separator = separator;
    Ok(())
}

#[async_trait]
impl JournalSink for FileJournal {
    async fn persist(&self, mutations: &[Value]) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(malformed("Collaboration journal is closed"));
        }
        let batch = mutations
            .iter()
            .map(|mutation| json!({"type":"mutation","version":1,"mutation":mutation}).to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let state = self.state.clone();
        let closed = self.closed.clone();
        tokio::task::spawn_blocking(move||{let mut state=state.lock().unwrap();
            let result=(|| {
                if closed.load(Ordering::Acquire) { return Err(malformed("Collaboration journal is closed")); }
                if let Some(error)=&state.failed{return Err(error.clone());}let separator=state.separator;let file=state.file.as_mut().ok_or_else(||malformed("Collaboration journal is closed"))?;let before=file.metadata()?.len();
                let append=(||{if separator{file.write_all(b"\n")?;}file.write_all(batch.as_bytes())?;file.sync_all()?;Ok::<_,std::io::Error>(())})();
                match append{Ok(())=>{state.separator=false;Ok(())},Err(error)=>{if let Err(rollback)=file.set_len(before).and_then(|()|file.sync_all()){tracing::warn!("[Collaboration] Journal rollback failed: {rollback}");state.failed=Some(malformed("Collaboration journal rollback failed; reopen and inspect before continuing."));}Err(error.into())}}
            })();
            if closed.load(Ordering::Acquire) { state.file.take(); }
            result
        }).await.map_err(|error|malformed(&error.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn journal_replays_and_recovers_only_final_damage() {
        let directory = std::env::temp_dir().join(format!(
            "halo-collaboration-journal-{}",
            super::super::protocol::id()
        ));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let path = directory.join("scope.jsonl");
        let cancel = CancellationToken::new();
        let first = FileScopeStore::open(
            path.clone(),
            "team".into(),
            "epoch".into(),
            100,
            100000,
            &cancel,
        )
        .await
        .unwrap();
        super::super::store::add_member(
            first.store.as_ref(),
            json!({"id":"alice","name":"alice","parentId":"lead","prompt":"work","createdAt":1}),
        )
        .unwrap();
        first.close().await.unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"unfinished\":")
            .unwrap();
        let second = FileScopeStore::open(
            path.clone(),
            "team".into(),
            "epoch".into(),
            100,
            100000,
            &cancel,
        )
        .await
        .unwrap();
        assert!(second.store.get("member", "alice").is_some());
        second.close().await.unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"bad\n{}\n")
            .unwrap();
        assert!(
            FileScopeStore::open(path, "team".into(), "epoch".into(), 100, 100000, &cancel)
                .await
                .is_err()
        );
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
