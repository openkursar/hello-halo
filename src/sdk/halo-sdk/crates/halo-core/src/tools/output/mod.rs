//! Session-owned files for tool output that is too large to return inline.
//!
//! Only Bash foreground output and WebFetch extracted text use this store. It
//! owns file creation, byte limits, completion state and retention; it does not
//! execute tools or make policy decisions for other tools.

use super::file;
use crate::harness::ResolvedHarness;
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, SystemTime},
};
use tokio::{
    fs::{self, File, OpenOptions},
    io::AsyncWriteExt,
};

pub const FILE_LIMIT: u64 = 64 * 1024 * 1024;
const RETAIN_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RETAIN_FILES: usize = 128;
const RETAIN_BYTES: u64 = 256 * 1024 * 1024;
// A completed path is returned to the caller before another writer may prune.
const RECENT_COMPLETION_GRACE: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SaveReason {
    NoLocation,
    StorageUnavailable,
    WriteFailed,
    FinalizeFailed,
    FileLimit,
    Quota,
    UnsafeCopy,
}

impl SaveReason {
    pub fn render(self, harness: &ResolvedHarness) -> String {
        use crate::harness::TextId;
        match self {
            Self::NoLocation => harness.text(TextId::ToolsOutputReasonNoLocation).into(),
            Self::StorageUnavailable => harness.text(TextId::ToolsOutputReasonUnavailable).into(),
            Self::WriteFailed => harness.text(TextId::ToolsOutputReasonWriteFailed).into(),
            Self::FinalizeFailed => harness.text(TextId::ToolsOutputReasonFinalizeFailed).into(),
            Self::FileLimit => harness.render(
                TextId::ToolsOutputReasonFileLimit,
                &[("byte_limit", &FILE_LIMIT.to_string())],
            ),
            Self::Quota => harness.text(TextId::ToolsOutputReasonQuota).into(),
            Self::UnsafeCopy => harness.text(TextId::ToolsOutputReasonUnsafeCopy).into(),
        }
    }
}

#[derive(Clone, Debug)]
pub enum SaveState {
    Complete { path: PathBuf },
    Partial { path: PathBuf, bytes: u64, reason: SaveReason },
    Failed { reason: SaveReason },
}

impl SaveState {
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Complete { path } | Self::Partial { path, .. } => Some(path),
            Self::Failed { .. } => None,
        }
    }
}

pub struct OutputStore {
    root: PathBuf,
    persistent: bool,
    allowed: bool,
    session_id: String,
    active: Arc<StdMutex<HashSet<PathBuf>>>,
    prune: Arc<tokio::sync::Mutex<()>>,
    closed: AtomicBool,
}

fn safe_component(value: &str) -> String {
    let encoded: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    if encoded.is_empty() {
        "session".into()
    } else {
        encoded
    }
}

fn result_directory(options: &Value) -> PathBuf {
    if options["persistSession"] == false {
        return crate::core::conventions::temp_dir(options)
            .join(format!("agent-tool-results-{}", uuid::Uuid::new_v4()));
    }
    let transcript = crate::history::transcript_path(
        options["sessionId"].as_str().unwrap_or("session"),
        options,
    );
    transcript
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("tool-results")
        .join(safe_component(
            options["sessionId"].as_str().unwrap_or("session"),
        ))
}

impl OutputStore {
    pub fn new(options: &Value) -> Arc<Self> {
        let root = result_directory(options);
        let allowed = !file::denied(&root, &file::deny_roots(options));
        Arc::new(Self {
            root,
            persistent: options["persistSession"] != false,
            allowed,
            session_id: options["sessionId"].as_str().unwrap_or("").into(),
            active: Arc::new(StdMutex::new(HashSet::new())),
            prune: Arc::new(tokio::sync::Mutex::new(())),
            closed: AtomicBool::new(false),
        })
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashSet<PathBuf>> {
        self.active.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn begin_active(&self, path: &Path) {
        self.active().insert(path.to_path_buf());
    }

    async fn ensure_directory(&self) -> std::io::Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "output store is closed",
            ));
        }
        if !self.allowed {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "saved-output location is closed by read policy",
            ));
        }
        if !self.root.exists() {
            fs::create_dir_all(&self.root).await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700)).await?;
            }
        }
        Ok(())
    }

    /// Counts completed files by actual size and active writers by their full
    /// file capacity in one directory pass. A writer may grow concurrently, so
    /// reserving a fixed capacity avoids subtracting a newer size from an older
    /// total.
    async fn usage_with_reservations(
        &self,
        active: &HashSet<PathBuf>,
    ) -> std::io::Result<(usize, u64)> {
        let mut entries = fs::read_dir(&self.root).await?;
        let mut files = 0usize;
        let mut bytes = 0u64;
        let mut seen = HashSet::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !is_result_name(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if !metadata.is_file() {
                continue;
            }
            files += 1;
            if active.contains(&path) {
                seen.insert(path);
                bytes = bytes.saturating_add(FILE_LIMIT);
            } else {
                bytes = bytes.saturating_add(metadata.len());
            }
        }
        for path in active.difference(&seen) {
            files += 1;
            bytes = bytes.saturating_add(FILE_LIMIT);
        }
        Ok((files, bytes))
    }

    async fn prune(&self) {
        let _guard = self.prune.lock().await;
        let active = self.active().clone();
        if let Err(error) = prune_directory(&self.root, &active).await {
            tracing::warn!(
                session_id = %self.session_id,
                error = %error,
                "tool output retention failed"
            );
        }
    }

    pub async fn save_text(&self, kind: &str, text: &str) -> SaveState {
        self.save_bytes(kind, text.as_bytes()).await
    }

    pub async fn save_bytes(&self, kind: &str, bytes: &[u8]) -> SaveState {
        if let Err(reason) = self.ensure_directory().await {
            tracing::warn!(
                session_id = %self.session_id,
                kind,
                reason = ?reason.kind(),
                "tool output could not be saved"
            );
            return SaveState::Failed {
                reason: if !self.allowed {
                    SaveReason::NoLocation
                } else {
                    SaveReason::StorageUnavailable
                },
            };
        }
        let mut writer = match self.begin(kind, None).await {
            Ok(writer) => writer,
            Err(reason) => return SaveState::Failed { reason },
        };
        writer.write_bytes(bytes).await;
        writer.finish().await
    }

    pub async fn begin(
        &self,
        kind: &str,
        limit_marker: Option<String>,
    ) -> Result<OutputWriter, SaveReason> {
        if let Err(error) = self.ensure_directory().await {
            tracing::warn!(
                session_id = %self.session_id,
                kind,
                error = %error,
                "tool output file could not be created"
            );
            return Err(if !self.allowed {
                SaveReason::NoLocation
            } else {
                SaveReason::StorageUnavailable
            });
        }
        let _guard = self.prune.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(SaveReason::StorageUnavailable);
        }
        let active = self.active().clone();
        if let Err(error) = prune_directory(&self.root, &active).await {
            tracing::warn!(
                session_id = %self.session_id,
                kind,
                error = %error,
                "tool output retention failed"
            );
        }
        let (files, bytes) = match self.usage_with_reservations(&active).await {
            Ok(usage) => usage,
            Err(error) => {
                tracing::warn!(
                    session_id = %self.session_id,
                    kind,
                    error = %error,
                    "tool output storage could not be inspected"
                );
                return Err(SaveReason::StorageUnavailable);
            }
        };
        if files >= RETAIN_FILES {
            tracing::warn!(
                session_id = %self.session_id,
                kind,
                files,
                "tool output storage quota refused a new file"
            );
            return Err(SaveReason::Quota);
        }
        let marker_bytes = limit_marker
            .as_deref()
            .map(|marker| marker.as_bytes().len() as u64)
            .unwrap_or(0);
        let remaining = RETAIN_BYTES.saturating_sub(bytes);
        if remaining <= marker_bytes.saturating_add(1024) {
            tracing::warn!(
                session_id = %self.session_id,
                kind,
                bytes,
                "tool output storage quota refused a new file"
            );
            return Err(SaveReason::Quota);
        }
        let full_limit = FILE_LIMIT.saturating_sub(marker_bytes);
        let content_limit = full_limit.min(remaining - marker_bytes);
        let limit_reason = if content_limit < full_limit {
            SaveReason::Quota
        } else {
            SaveReason::FileLimit
        };
        let path = self
            .root
            .join(format!("{kind}-{}.out", uuid::Uuid::new_v4()));
        let mut open = OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            open.mode(0o600);
        }
        let file = match open.open(&path).await {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(
                    session_id = %self.session_id,
                    kind,
                    error = %error,
                    "tool output file could not be created"
                );
                return Err(SaveReason::StorageUnavailable);
            }
        };
        self.begin_active(&path);
        Ok(OutputWriter {
            root: self.root.clone(),
            path,
            file: Some(file),
            bytes: 0,
            content_limit,
            truncated: false,
            reason: None,
            limit_reason,
            finished: false,
            marker: limit_marker.map(String::into_bytes),
            kind: kind.into(),
            session_id: self.session_id.clone(),
            active: self.active.clone(),
            prune: self.prune.clone(),
        })
    }

    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if self.persistent {
            self.prune().await;
            return;
        }
        if let Err(error) = fs::remove_dir_all(&self.root).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(session_id = %self.session_id, error = %error, "temporary tool output cleanup failed");
            }
        }
    }

    pub fn close_blocking(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if !self.persistent {
            if let Err(error) = std::fs::remove_dir_all(&self.root) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(session_id = %self.session_id, error = %error, "temporary tool output cleanup failed");
                }
            }
        }
    }
}

pub struct OutputWriter {
    root: PathBuf,
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    content_limit: u64,
    truncated: bool,
    reason: Option<SaveReason>,
    limit_reason: SaveReason,
    finished: bool,
    marker: Option<Vec<u8>>,
    kind: String,
    session_id: String,
    active: Arc<StdMutex<HashSet<PathBuf>>>,
    prune: Arc<tokio::sync::Mutex<()>>,
}

impl OutputWriter {
    pub fn mark_incomplete(&mut self, reason: SaveReason) {
        if self.reason.is_none() {
            self.reason = Some(reason);
        }
    }

    pub async fn write_bytes(&mut self, bytes: &[u8]) {
        if self.file.is_none() || self.reason.is_some() {
            return;
        }
        let remaining = self.content_limit.saturating_sub(self.bytes);
        let take = (bytes.len() as u64).min(remaining) as usize;
        if take > 0 {
            if let Some(file) = &mut self.file {
                if let Err(error) = file.write_all(&bytes[..take]).await {
                    self.reason = Some(SaveReason::WriteFailed);
                    tracing::warn!(
                        session_id = %self.session_id,
                        kind = %self.kind,
                        bytes = self.bytes,
                        error = %error,
                        "tool output write failed"
                    );
                    return;
                }
                self.bytes += take as u64;
            }
        }
        if take < bytes.len() && !self.truncated {
            self.truncated = true;
        }
    }

    pub async fn finish(mut self) -> SaveState {
        self.finished = true;
        if self.truncated {
            if let Some(marker) = self.marker.take() {
                if let Some(file) = &mut self.file {
                    if let Err(error) = file.write_all(&marker).await {
                        self.reason = Some(SaveReason::WriteFailed);
                        tracing::warn!(
                            session_id = %self.session_id,
                            kind = %self.kind,
                            error = %error,
                            "tool output limit marker write failed"
                        );
                    }
                }
            }
        }
        let mut file = self.file.take();
        if let Some(file) = &mut file {
            if let Err(error) = file.flush().await {
                self.reason = Some(SaveReason::FinalizeFailed);
                tracing::warn!(
                    session_id = %self.session_id,
                    kind = %self.kind,
                    error = %error,
                    "tool output finalization failed"
                );
            }
        }
        drop(file);
        let state = if let Some(reason) = self.reason {
            if self.bytes > 0 {
                SaveState::Partial {
                    path: self.path.clone(),
                    bytes: self.bytes,
                    reason,
                }
            } else {
                remove_if_empty(&self.path).await;
                SaveState::Failed { reason }
            }
        } else if self.truncated {
            SaveState::Partial {
                path: self.path.clone(),
                bytes: self.bytes,
                reason: self.limit_reason,
            }
        } else {
            SaveState::Complete {
                path: self.path.clone(),
            }
        };
        let _guard = self.prune.lock().await;
        let active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Err(error) = prune_directory(&self.root, &active).await {
            tracing::warn!(
                session_id = %self.session_id,
                kind = %self.kind,
                error = %error,
                "tool output retention failed"
            );
        }
        state
    }
}

impl Drop for OutputWriter {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.path);
        if !self.finished {
            if let Err(error) = std::fs::remove_file(&self.path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        session_id = %self.session_id,
                        kind = %self.kind,
                        error = %error,
                        "abandoned tool output cleanup failed"
                    );
                }
            }
        }
    }
}

pub async fn remove_saved(path: &Path) {
    remove_if_empty(path).await;
}

async fn remove_if_empty(path: &Path) {
    if let Err(error) = fs::remove_file(path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %error, "partial tool output cleanup failed");
        }
    }
}

fn is_result_name(name: &str) -> bool {
    let Some((kind, rest)) = name.split_once('-') else {
        return false;
    };
    if !matches!(kind, "bash" | "web") || !rest.ends_with(".out") {
        return false;
    }
    let id = rest.trim_end_matches(".out");
    !id.is_empty()
        && id
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

async fn prune_directory(root: &Path, active: &HashSet<PathBuf>) -> std::io::Result<()> {
    let mut entries = match fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let now = SystemTime::now();
    let mut completed = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_result_name(&name) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if active.contains(&path) {
            completed.push((path, metadata.len(), modified, true));
        } else if now.duration_since(modified).unwrap_or(Duration::ZERO) > RETAIN_AGE {
            remove(&path).await?;
        } else if now.duration_since(modified).unwrap_or(Duration::ZERO)
            < RECENT_COMPLETION_GRACE
        {
            completed.push((path, metadata.len(), modified, true));
        } else {
            completed.push((path, metadata.len(), modified, false));
        }
    }
    completed.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| b.2.cmp(&a.2)).then_with(|| a.0.cmp(&b.0)));
    let mut bytes = 0u64;
    let mut retained = 0usize;
    let mut removed = 0usize;
    for (path, size, _, active) in completed {
        if active {
            bytes = bytes.saturating_add(size);
            retained += 1;
            continue;
        }
        if retained >= RETAIN_FILES || bytes.saturating_add(size) > RETAIN_BYTES {
            remove(&path).await?;
            removed += 1;
        } else {
            bytes = bytes.saturating_add(size);
            retained += 1;
        }
    }
    if removed > 0 {
        tracing::warn!(
            retained,
            bytes,
            removed,
            "expired or over-budget tool output removed"
        );
    }
    Ok(())
}

async fn remove(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn options(root: &Path) -> Value {
        json!({
            "sessionId": "output-fixture",
            "persistSession": false,
            "nativeTempDirectory": root,
            "env": {},
            "conventions": crate::core::config::default_conventions()
        })
    }

    #[tokio::test]
    async fn saved_text_is_private_complete_and_removed_with_the_session_directory() {
        let root = std::env::temp_dir().join(format!("halo-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = OutputStore::new(&options(&root));
        let state = store.save_text("bash", "complete output").await;
        let path = match &state {
            SaveState::Complete { path } => path.clone(),
            other => panic!("unexpected state: {other:?}"),
        };
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "complete output");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        store.close().await;
        assert!(!store.root.exists());
    }

    #[tokio::test]
    async fn writer_reports_partial_states_for_file_quota_and_write_limits() {
        let root = std::env::temp_dir().join(format!("halo-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = OutputStore::new(&options(&root));
        for (limit, reason_expected) in [
            (64u64, SaveReason::FileLimit),
            (64u64, SaveReason::Quota),
        ] {
            let mut writer = store.begin("bash", Some("[limit marker]".into())).await.unwrap();
            writer.content_limit = limit;
            writer.limit_reason = reason_expected;
            writer.write_bytes(&[b'x'; 200]).await;
            let state = writer.finish().await;
            match state {
                SaveState::Partial { path, bytes, reason } => {
                    assert_eq!(bytes, limit);
                    assert_eq!(reason, reason_expected);
                    let stored = std::fs::read_to_string(path).unwrap();
                    assert_eq!(stored.len() as u64, limit + "[limit marker]".len() as u64);
                    assert!(stored.ends_with("[limit marker]"));
                }
                other => panic!("unexpected state: {other:?}"),
            }
        }
        store.close().await;
    }

    #[tokio::test]
    async fn retention_removes_expired_and_over_count_files_but_keeps_active_and_user_files() {
        let root = std::env::temp_dir().join(format!("halo-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let active = root.join(format!("web-{}.out", uuid::Uuid::new_v4()));
        std::fs::write(&active, "active").unwrap();
        let mut old = None;
        for index in 0..130 {
            let path = root.join(format!("bash-{:08x}.out", index));
            let file = std::fs::File::create(&path).unwrap();
            file.set_len(1024).unwrap();
            if index == 0 {
                file.set_modified(SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60))
                    .unwrap();
                old = Some(path);
            } else {
                file.set_modified(SystemTime::now() - Duration::from_secs(120))
                    .unwrap();
            }
        }
        std::fs::write(root.join("user-file"), "keep").unwrap();
        prune_directory(&root, &HashSet::from([active.clone()]))
            .await
            .unwrap();
        assert!(!old.unwrap().exists());
        assert!(active.exists());
        assert_eq!(std::fs::read_to_string(root.join("user-file")).unwrap(), "keep");
        let count = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| is_result_name(&entry.file_name().to_string_lossy()))
            .count();
        assert!(count <= RETAIN_FILES, "count={count}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn finishing_one_writer_does_not_evict_another_active_writer() {
        let store = OutputStore::new(&json!({"persistSession": false}));
        let first = store.begin("bash", None).await.unwrap();
        let second = store.begin("web", None).await.unwrap();
        for index in 0..130 {
            std::fs::write(
                store.root.join(format!("bash-extra{:08x}.out", index)),
                vec![b'x'; 1024],
            )
            .unwrap();
        }
        let _ = first.finish().await;
        assert!(second.path.exists(), "retention must not remove an active writer");
        let _ = second.finish().await;
        let _ = std::fs::remove_dir_all(&store.root);
    }

    #[tokio::test]
    async fn active_reservation_does_not_shrink_when_the_active_file_grows() {
        let store = OutputStore::new(&json!({"persistSession": false}));
        let mut writer = store.begin("bash", None).await.unwrap();
        let completed = store.root.join(format!("web-{}.out", uuid::Uuid::new_v4()));
        std::fs::write(&completed, vec![b'c'; 1024]).unwrap();
        let active = store.active().clone();
        let (files, before) = store.usage_with_reservations(&active).await.unwrap();
        writer.write_bytes(&vec![b'x'; 4096]).await;
        let (grown_files, after) = store.usage_with_reservations(&active).await.unwrap();
        assert_eq!((files, grown_files), (2, 2));
        assert_eq!(before, FILE_LIMIT + 1024);
        assert_eq!(after, before, "a growing active file must not reduce its fixed reservation");
        drop(writer);
        store.close().await;
        let _ = std::fs::remove_dir_all(&store.root);
    }

    #[tokio::test]
    async fn begin_reserves_active_capacity_when_checking_the_byte_quota() {
        let store = OutputStore::new(&json!({"persistSession": false}));
        let active = store.begin("bash", None).await.unwrap();
        let completed = store.root.join(format!("web-{}.out", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&completed).unwrap();
        file.set_len(200 * 1024 * 1024).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();
        let blocked = store.begin("web", None).await;
        assert!(matches!(blocked, Err(SaveReason::Quota)));
        drop(active);
        let _ = std::fs::remove_dir_all(&store.root);
    }

    #[tokio::test]
    async fn a_denied_location_reports_no_saved_copy() {
        let root = std::env::temp_dir().join(format!("halo-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut options = options(&root);
        options["nativeReadDenyRoots"] = json!([root]);
        let store = OutputStore::new(&options);
        assert!(matches!(
            store.save_text("web", "closed").await,
            SaveState::Failed {
                reason: SaveReason::NoLocation
            }
        ));
        store.close().await;
        std::fs::remove_dir_all(root).ok();
    }
}
