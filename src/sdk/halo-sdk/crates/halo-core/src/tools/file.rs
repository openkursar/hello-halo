use super::{failure, file_range, success, ToolContext};
use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
#[cfg(not(unix))]
use std::time::UNIX_EPOCH;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex as StdMutex, OnceLock, Weak},
    task::{Context, Poll},
};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{Mutex, OwnedMutexGuard},
};

pub(super) mod text;
mod tool_path;

pub(super) const MAX_BYTES: usize = 8 * 1024 * 1024;
struct FileLock {
    mutex: Arc<Mutex<()>>,
    revision: AtomicU64,
}
type Locks = StdMutex<HashMap<String, Weak<FileLock>>>;
static FILE_LOCKS: OnceLock<Locks> = OnceLock::new();

pub fn resolve(cwd: &str, value: &str) -> PathBuf {
    let path = Path::new(value);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            _ => out.push(c),
        }
    }
    out
}
/// Resolves a file tool's path exactly as the host's permission check does, so
/// the file changed is the file that was approved.
pub fn resolve_tool_path(cwd: &str, value: &str) -> PathBuf {
    PathBuf::from(tool_path::resolve_tool_path(
        cwd,
        value,
        tool_path::home_directory,
        cfg!(windows),
    ))
}
pub fn real_path(path: &Path) -> PathBuf {
    let mut head = path.to_path_buf();
    let mut tail = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&head) {
            head = real;
            break;
        }
        if let Some(name) = head.file_name() {
            tail.push(name.to_os_string());
        } else {
            break;
        }
        if !head.pop() {
            break;
        }
    }
    for part in tail.iter().rev() {
        head.push(part);
    }
    head
}
fn folded(path: &Path) -> String {
    let s = path.to_string_lossy().into_owned();
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        s.to_lowercase()
    } else {
        s
    }
}
struct FileLockEntry {
    key: String,
    identity: Weak<FileLock>,
}
impl Drop for FileLockEntry {
    fn drop(&mut self) {
        let Some(locks) = FILE_LOCKS.get() else {
            return;
        };
        let mut map = locks.lock().unwrap_or_else(|error| error.into_inner());
        if map.get(&self.key).is_some_and(|current| {
            Weak::ptr_eq(current, &self.identity) && current.strong_count() == 0
        }) {
            map.remove(&self.key);
        }
    }
}
struct FileGuard {
    guard: Option<OwnedMutexGuard<()>>,
    owner: Option<Arc<FileLock>>,
    revision: u64,
    writing: bool,
    entry: FileLockEntry,
}
impl FileGuard {
    fn changed(&self) -> bool {
        self.owner.as_ref().unwrap().revision.load(Ordering::Acquire) != self.revision
    }
    fn identity(&self) -> &str {
        &self.entry.key
    }
}
impl Drop for FileGuard {
    fn drop(&mut self) {
        if self.writing {
            self.owner.as_ref().unwrap().revision.fetch_add(1, Ordering::AcqRel);
        }
        drop(self.guard.take());
        drop(self.owner.take());
    }
}
/// One key for every spelling of a file: links resolved, case folded where the
/// platform's default filesystem ignores case.
fn file_identity(path: &Path) -> String {
    folded(&real_path(path))
}
fn file_lock(path: &Path) -> (Arc<FileLock>, FileLockEntry) {
    let key = file_identity(path);
    let lock = {
        let mut map = FILE_LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match map.get(&key).and_then(Weak::upgrade) {
            Some(v) => v,
            None => {
                let v = Arc::new(FileLock {
                    mutex: Arc::new(Mutex::new(())),
                    revision: AtomicU64::new(0),
                });
                map.insert(key.clone(), Arc::downgrade(&v));
                v
            }
        }
    };
    let entry = FileLockEntry {
        key,
        identity: Arc::downgrade(&lock),
    };
    (lock, entry)
}
async fn lock(path: &Path) -> FileGuard {
    FileReservation::new(path).acquire().await
}

enum ReservationState {
    Ready(Option<OwnedMutexGuard<()>>),
    Waiting(Pin<Box<dyn Future<Output = OwnedMutexGuard<()>> + Send>>),
}
struct FileReservation {
    state: Option<ReservationState>,
    owner: Option<Arc<FileLock>>,
    revision: u64,
    entry: Option<FileLockEntry>,
}
impl Drop for FileReservation {
    fn drop(&mut self) {
        drop(self.state.take());
        drop(self.owner.take());
    }
}
impl FileReservation {
    fn new(path: &Path) -> Self {
        let (lock, entry) = file_lock(path);
        let mut revision = lock.revision.load(Ordering::Acquire);
        let mut pending = Box::pin(lock.mutex.clone().lock_owned());
        let mut context = Context::from_waker(futures::task::noop_waker_ref());
        // Enqueue before returning to JavaScript; a later task poll installs its own waker.
        let admitted =
            Pin::new(&mut tokio::task::unconstrained(pending.as_mut())).poll(&mut context);
        let state = match admitted {
            Poll::Ready(guard) => {
                revision = lock.revision.load(Ordering::Acquire);
                ReservationState::Ready(Some(guard))
            },
            Poll::Pending => ReservationState::Waiting(pending),
        };
        Self {
            state: Some(state),
            owner: Some(lock),
            revision,
            entry: Some(entry),
        }
    }
    async fn acquire(mut self) -> FileGuard {
        let guard = match self.state.as_mut().unwrap() {
            ReservationState::Ready(guard) => guard.take().unwrap(),
            ReservationState::Waiting(pending) => pending.await,
        };
        FileGuard {
            guard: Some(guard),
            owner: self.owner.take(),
            revision: self.revision,
            writing: false,
            entry: self.entry.take().unwrap(),
        }
    }
}

fn captures_read_state(name: &str, input: &Value) -> bool {
    match name {
        "Write" => input["content"]
            .as_str()
            .is_some_and(|content| content.len() <= MAX_BYTES),
        "Edit" => {
            input["old_string"]
                .as_str()
                .is_some_and(|old| !old.is_empty())
                && input["new_string"].is_string()
                && input["old_string"] != input["new_string"]
        }
        _ => false,
    }
}

fn valid_read_input(input: &Value) -> bool {
    ["offset", "limit"].into_iter().all(|key| {
        input
            .get(key)
            .filter(|value| !crate::js::is_undefined(value))
            .is_none_or(|value| {
                crate::js::safe_integer(value)
                    .is_some_and(|value| value >= if key == "offset" { 0 } else { 1 })
            })
    })
}

/// A caller's read validation and reserved place in the shared file queue.
pub struct FileAdmission {
    captured: Option<Option<ReadValidation>>,
    receipt: Option<String>,
    reservation: FileReservation,
}
impl FileAdmission {
    pub fn path(name: &str, input: &Value, cwd: &str) -> Option<PathBuf> {
        let raw = input["file_path"]
            .as_str()
            .filter(|path| !path.is_empty())?;
        (if name == "Read" {
            valid_read_input(input)
        } else {
            captures_read_state(name, input)
        })
        .then(|| resolve_tool_path(cwd, raw))
    }
    pub fn reads_state(name: &str, input: &Value) -> bool {
        captures_read_state(name, input)
    }
    pub fn admit(path: &Path) -> Self {
        Self {
            captured: None,
            receipt: None,
            reservation: FileReservation::new(path),
        }
    }
}

pub struct FileAdmissionPreparation {
    path: PathBuf,
    captured: Option<Option<ReadValidation>>,
    external_reads: bool,
}
impl FileAdmissionPreparation {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn needs_external_read(&self) -> bool {
        self.external_reads
    }
    pub fn admit(self, receipt: Option<String>) -> Result<FileAdmission> {
        if self.external_reads && receipt.is_none() {
            tracing::warn!(
                "File operation admission refused: external read state snapshot is unavailable"
            );
            return Err(Error::template(
                "FILE_STATE_UNAVAILABLE",
                TextId::ToolsFileStateUnavailable,
                &[],
            ));
        }
        Ok(FileAdmission {
            captured: self.captured,
            receipt,
            reservation: FileReservation::new(&self.path),
        })
    }
}
pub fn denied(path: &Path, roots: &[PathBuf]) -> bool {
    denied_real(&real_path(path), roots)
}
pub fn denied_real(path: &Path, roots: &[PathBuf]) -> bool {
    let target = PathBuf::from(folded(path));
    roots
        .iter()
        .any(|r| target.starts_with(PathBuf::from(folded(r))))
}
pub fn deny_roots(options: &Value) -> Vec<PathBuf> {
    let cwd = options["cwd"].as_str().unwrap_or(".");
    let mut roots = Vec::new();
    if let Some(rules) = options["disallowedTools"].as_array() {
        for rule in rules.iter().filter_map(Value::as_str) {
            let rule = crate::js::trim_js(rule);
            if let Some(raw) = rule.strip_prefix("Read(").and_then(|x| x.strip_suffix(')')) {
                if raw.is_empty() || raw.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
                    continue;
                }
                let raw = crate::js::trim_js(raw);
                let raw = raw.strip_suffix("/**").unwrap_or(raw);
                if raw.contains(['*', '?', '[', ']', '{', '}']) {
                    tracing::warn!("read-deny rule with a wildcard is not supported; skipped");
                    continue;
                }
                let home = options["nativeHomeDirectory"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        super::home(&json!({
                            "nativeProcessEnv":
                                crate::core::conventions::process_environment(options)
                        }))
                    });
                let path = if raw == "~" || raw.starts_with("~/") {
                    Path::new(&home).join(raw.get(2..).unwrap_or(""))
                } else if let Some(p) = raw.strip_prefix("//") {
                    if cfg!(windows)
                        && p.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                        && (p.len() == 1 || p.as_bytes().get(1) == Some(&b'/'))
                    {
                        resolve(cwd, &format!("{}:\\{}", &p[..1], p.get(2..).unwrap_or("")))
                    } else {
                        resolve(cwd, &format!("/{p}"))
                    }
                } else {
                    resolve(cwd, raw)
                };
                let path = real_path(&path);
                if !roots.contains(&path) {
                    roots.push(path);
                }
            }
        }
    }
    if let Some(inherited) = options["nativeReadDenyRoots"].as_array() {
        for root in inherited.iter().filter_map(Value::as_str) {
            let path = real_path(&resolve(cwd, root));
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
    }
    roots
}
/// What a recorded read says about the file's content.
#[derive(Clone, Default)]
enum ReadDigest {
    #[default]
    None,
    /// SHA-256 of the file's raw bytes (`contentHash`).
    Raw(String),
    /// Without a raw hash, the host's recorded text may have LF-normalized line endings.
    Text(String),
}
impl ReadDigest {
    fn of(public: &Value, partial: bool) -> Self {
        if let Some(digest) = public["contentHash"].as_str() {
            return Self::Raw(digest.to_owned());
        }
        match public["content"].as_str() {
            Some(content) if !partial => Self::Text(hash(content.as_bytes())),
            _ => Self::None,
        }
    }
}
#[derive(Clone)]
struct ReadState {
    digest: ReadDigest,
    modified: f64,
    partial: bool,
    public: Value,
    sequence: u64,
    value_version: u64,
    /// `file_identity` of the file this entry describes, fixed when it was recorded:
    /// a spelling that later names another file does not carry the entry along.
    identity: String,
}
#[derive(Clone)]
struct ReadValidation {
    digest: ReadDigest,
    modified: f64,
    partial: bool,
    partial_view: Value,
}
impl ReadValidation {
    fn from_public(public: &Value) -> Self {
        let partial = public["isPartialView"] == true;
        Self {
            digest: ReadDigest::of(public, partial),
            modified: public["timestamp"].as_f64().unwrap_or(f64::NAN),
            partial,
            partial_view: public
                .get("isPartialView")
                .cloned()
                .unwrap_or_else(crate::js::undefined),
        }
    }
}
struct ReadExport {
    version: Option<u64>,
    invalidated: bool,
}
impl ReadState {
    fn validation(&self) -> ReadValidation {
        ReadValidation {
            digest: self.digest.clone(),
            modified: self.modified,
            partial: self.partial,
            partial_view: self
                .public
                .get("isPartialView")
                .cloned()
                .unwrap_or_else(crate::js::undefined),
        }
    }
}
#[derive(Default)]
struct ReadStates {
    values: HashMap<PathBuf, ReadState>,
    order: VecDeque<PathBuf>,
    next_sequence: u64,
    next_value_version: u64,
}
impl ReadStates {
    fn insert(&mut self, path: PathBuf, identity: String, mut state: ReadState) {
        let aliases: Vec<PathBuf> = self
            .values
            .iter()
            .filter(|(key, value)| **key != path && value.identity == identity)
            .map(|(key, _)| key.clone())
            .collect();
        for alias in aliases {
            self.remove(&alias);
        }
        state.identity = identity;
        self.order.retain(|p| p != &path);
        while self.order.len() >= 512 {
            if let Some(old) = self.order.pop_front() {
                self.values.remove(&old);
            }
        }
        self.next_sequence += 1;
        state.sequence = self.next_sequence;
        self.next_value_version += 1;
        state.value_version = self.next_value_version;
        self.order.push_back(path.clone());
        self.values.insert(path, state);
    }
    fn remove(&mut self, path: &Path) -> bool {
        self.order.retain(|entry| entry != path);
        self.values.remove(path).is_some()
    }
    /// The newest entry recorded for the file `identity` names, under any spelling.
    fn find(&self, identity: &str) -> Option<&ReadState> {
        self.values
            .values()
            .filter(|value| value.identity == identity)
            .max_by_key(|value| value.value_version)
    }
    /// Removes the entry under `path` and every entry for the file `identity` names.
    fn forget(&mut self, path: &Path, identity: &str) {
        let keys: Vec<PathBuf> = self
            .values
            .iter()
            .filter(|(key, value)| *key == path || value.identity == identity)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            self.remove(&key);
        }
    }
}
#[derive(Default)]
pub struct FileReadStateStore {
    reads: StdMutex<ReadStates>,
}
impl FileReadStateStore {
    fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, ReadStates>> {
        self.reads.lock()
    }
    pub fn context_call(&self, method: &str, args: &Value) -> crate::error::Result<Value> {
        let key = || {
            args[0].as_str().map(PathBuf::from).ok_or_else(|| {
                Error::template("INVALID_TOOL_CONTEXT", TextId::ToolsFileStateKeyType, &[])
            })
        };
        if method == "readFileState.set" {
            let key = key()?;
            let public = args[1].clone();
            let validation = ReadValidation::from_public(&public);
            let identity = file_identity(&key);
            let mut state = self.reads.lock().unwrap_or_else(|e| e.into_inner());
            let sequence = if let Some(existing) = state.values.get(&key) {
                existing.sequence
            } else {
                state.next_sequence += 1;
                state.order.push_back(key.clone());
                state.next_sequence
            };
            state.next_value_version += 1;
            let value_version = state.next_value_version;
            state.values.insert(
                key,
                ReadState {
                    digest: validation.digest,
                    modified: validation.modified,
                    partial: validation.partial,
                    public,
                    sequence,
                    value_version,
                    identity,
                },
            );
            return Ok(Value::Null);
        }
        let mut state = self.reads.lock().unwrap_or_else(|e| e.into_inner());
        Ok(match method {
            "readFileState.getEntry" => state.values.get(&key()?).map(|v|json!({"sequence":v.sequence,"valueVersion":v.value_version,"value":v.public})).unwrap_or(Value::Null),
            "readFileState.patchEntry" => {
                let key = key()?;
                let version = args[1].as_u64().unwrap_or(0);
                let property = args[2].as_str().ok_or_else(||Error::template("INVALID_TOOL_CONTEXT", TextId::ToolsFileStatePropertyType, &[]))?;
                if let Some(value) = state.values.get_mut(&key).filter(|v|v.value_version==version) {
                    if args[4]==true { if let Some(map)=value.public.as_object_mut() { map.remove(property); } }
                    else { value.public[property] = args[3].clone(); }
                    value.partial = value.public["isPartialView"] == true;
                    value.modified = value.public["timestamp"].as_f64().unwrap_or(f64::NAN);
                    value.digest = ReadDigest::of(&value.public, value.partial);
                    json!(true)
                } else { json!(false) }
            },
            "readFileState.get" => state
                .values
                .get(&key()?)
                .map(|s| s.public.clone())
                .unwrap_or(Value::Null),
            "readFileState.has" => json!(state.values.contains_key(&key()?)),
            "readFileState.delete" => json!(state.remove(&key()?)),
            "readFileState.clear" => {
                state.values.clear();
                state.order.clear();
                Value::Null
            }
            "readFileState.size" => json!(state.values.len()),
            "readFileState.next" => {
                let sequence = args[0].as_u64().unwrap_or(0);
                state
                    .order
                    .iter()
                    .find_map(|key| {
                        state
                            .values
                            .get(key)
                            .filter(|v| v.sequence > sequence)
                            .map(|v| json!({"sequence":v.sequence,"valueVersion":v.value_version,"key":key,"value":v.public}))
                    })
                    .unwrap_or(Value::Null)
            }
            "readFileState.entries" => json!(state
                .order
                .iter()
                .filter_map(|p| state.values.get(p).map(|s| json!([p, s.public])))
                .collect::<Vec<_>>()),
            "readFileState.keys" => json!(state
                .order
                .iter()
                .filter(|p| state.values.contains_key(*p))
                .collect::<Vec<_>>()),
            "readFileState.values" => json!(state
                .order
                .iter()
                .filter_map(|p| state.values.get(p).map(|s| s.public.clone()))
                .collect::<Vec<_>>()),
            _ => {
                return Err(Error::template("INVALID_TOOL_CONTEXT", TextId::ToolsFileUnknownStateOperation, &[("method", method.into())]))
            }
        })
    }
}
#[derive(Default)]
pub struct FileTools {
    reads: Arc<FileReadStateStore>,
    track_reads: bool,
    read_token_limit: usize,
    explicit_result_budget: Option<usize>,
    pub deny: Vec<PathBuf>,
    record_change: Option<(Arc<dyn crate::bridge::HostBridge>, String)>,
    external_reads: Option<Arc<dyn crate::bridge::HostBridge>>,
}
struct Snapshot {
    bytes: Vec<u8>,
    metadata: std::fs::Metadata,
}
/// The file a call operates on: the path as resolved, and its `file_identity`.
struct Target<'a> {
    path: &'a Path,
    identity: String,
}
pub(super) fn modified(m: &std::fs::Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1_000_000.0;
    }
    #[cfg(not(unix))]
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0)
        .unwrap_or(0.)
}
pub(super) fn same(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let changed =
            |m: &std::fs::Metadata| m.ctime() as f64 * 1000.0 + m.ctime_nsec() as f64 / 1_000_000.0;
        if changed(a) != changed(b) {
            return false;
        }
    }
    same_content_version(a, b)
}
fn same_content_version(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return false;
        }
    }
    a.len() == b.len() && modified(a) == modified(b)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
/// The file is as the recorded read saw it. A full read may outlive a timestamp
/// change when the raw bytes are unchanged, since sync clients and scanners touch
/// files without changing them; a partial view also requires the same timestamp.
fn unchanged(state: &ReadValidation, snapshot: &Snapshot) -> bool {
    let same_content = match &state.digest {
        ReadDigest::Raw(digest) => *digest == hash(&snapshot.bytes),
        ReadDigest::Text(digest) => {
            *digest == hash(&snapshot.bytes)
                || text::decode(&snapshot.bytes)
                    .is_some_and(|decoded| *digest == hash(text::lf(&decoded.text).as_bytes()))
        }
        ReadDigest::None => false,
    };
    same_content && (!state.partial || state.modified == modified(&snapshot.metadata))
}
fn size_error() -> Error {
    Error::new("FILE_LIMIT", "").with_harness(
        TextId::ToolsFileWriteLimit,
        &[("limit", MAX_BYTES.to_string().into())],
    )
}
async fn snapshot(path: &Path) -> Result<Snapshot> {
    let mut file = File::open(path).await.map_err(Error::from)?;
    let before = file.metadata().await.map_err(Error::from)?;
    if !before.is_file() {
        return Err(Error::new("FILE_READ", "").with_harness(
            TextId::ToolsFileNotRegular,
            &[("path", path.to_string_lossy().into_owned().into())],
        ));
    }
    let bytes = crate::filesystem::read_bounded(&mut file, MAX_BYTES).await?;
    let after = file.metadata().await.map_err(Error::from)?;
    let current = File::open(path)
        .await
        .map_err(Error::from)?
        .metadata()
        .await
        .map_err(Error::from)?;
    if !same(&before, &after) || !same(&after, &current) {
        return Err(Error::new("FILE_CHANGED", "").with_harness(TextId::ToolsFileChanged, &[]));
    }
    Ok(Snapshot {
        bytes,
        metadata: after,
    })
}
async fn matches_bytes(file: &mut File, expected: &[u8]) -> std::io::Result<bool> {
    let mut buffer = vec![0; (expected.len() + 1).min(64 * 1024)];
    let mut remaining = expected;
    while !remaining.is_empty() {
        let limit = remaining.len().min(buffer.len());
        let count = file.read(&mut buffer[..limit]).await?;
        if count == 0 || buffer[..count] != remaining[..count] {
            return Ok(false);
        }
        remaining = &remaining[count..];
    }
    Ok(file.read(&mut buffer[..1]).await? == 0)
}

async fn write_snapshot(
    path: &Path,
    bytes: &[u8],
    previous: Option<&Snapshot>,
    guard: &mut FileGuard,
) -> Result<std::fs::Metadata> {
    if bytes.len() > MAX_BYTES {
        return Err(size_error());
    }
    if previous.is_none() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(Error::from)?;
        }
    }
    let mut opts = OpenOptions::new();
    opts.write(true);
    if previous.is_some() {
        opts.read(true);
    } else {
        opts.create_new(true);
    }
    let mut file = opts.open(path).await.map_err(Error::from)?;
    if previous.is_none() {
        guard.writing = true;
    }
    if let Some(expected) = previous {
        let current = file.metadata().await.map_err(Error::from)?;
        let at_path = File::open(path)
            .await
            .map_err(Error::from)?
            .metadata()
            .await
            .map_err(Error::from)?;
        if !current.is_file()
            || !same(&current, &at_path)
            || !same_content_version(&expected.metadata, &current)
            || current.len() != expected.bytes.len() as u64
        {
            return Err(Error::new("FILE_CHANGED", "").with_harness(TextId::ToolsFileChanged, &[]));
        }
        if expected.bytes.len() > MAX_BYTES {
            return Err(size_error());
        }
        // Filesystems can preserve the observed metadata across a same-size overwrite.
        if !matches_bytes(&mut file, &expected.bytes).await? {
            tracing::warn!("file overwrite refused: write handle bytes differ from its snapshot");
            return Err(Error::new("FILE_CHANGED", "").with_harness(TextId::ToolsFileChanged, &[]));
        }
        let after = file.metadata().await.map_err(Error::from)?;
        let at_path = File::open(path)
            .await
            .map_err(Error::from)?
            .metadata()
            .await
            .map_err(Error::from)?;
        if !same(&current, &after) || !same(&after, &at_path) {
            return Err(Error::new("FILE_CHANGED", "").with_harness(TextId::ToolsFileChanged, &[]));
        }
    }
    guard.writing = true;
    // Writing in place keeps the file's identity, permissions and attributes,
    // and works while other programs hold it open; a failure must therefore
    // put the previous bytes back.
    let outcome = match replace_contents(&mut file, bytes).await {
        Ok(()) => file.metadata().await.map_err(Error::from),
        Err(error) => Err(match previous {
            Some(previous) => match replace_contents(&mut file, &previous.bytes).await {
                Ok(()) => Error::from(error),
                Err(restore) => {
                    tracing::warn!(file_path = %path.display(), error = %error, restore_error = %restore, "file write failed and its previous content could not be restored");
                    Error::new("FILE_WRITE_PARTIAL", "").with_harness(
                        TextId::ToolsFilePartialWrite,
                        &[("error", error.to_string().into()), ("restore", restore.to_string().into())],
                    )
                }
            },
            // Removing by path could delete a file another program saved there meanwhile.
            None => Error::new("FILE_WRITE_PARTIAL", "").with_harness(
                TextId::ToolsFilePartialNewFile,
                &[("error", error.to_string().into())],
            ),
        }),
    };
    // Some filesystems set the final write time when the handle closes.
    drop(file.into_std().await);
    confirm_written(path, &outcome?).await
}
/// The path's metadata after a write, if the path still names the file that was
/// written; another program may have replaced it while the handle was open.
async fn confirm_written(path: &Path, written: &std::fs::Metadata) -> Result<std::fs::Metadata> {
    let current = fs::metadata(path).await.ok();
    #[cfg(unix)]
    let current = current.filter(|current| {
        use std::os::unix::fs::MetadataExt;
        current.dev() == written.dev() && current.ino() == written.ino()
    });
    #[cfg(not(unix))]
    let _ = written;
    current.ok_or_else(|| {
        tracing::warn!(file_path = %path.display(), "file was replaced during a write; no read state recorded");
        Error::new("FILE_REPLACED", "").with_harness(TextId::ToolsFileReplacedDuringWrite, &[])
    })
}
/// Makes the open file hold exactly `bytes`. A Tokio file reports the failure of
/// its last queued write only on a later flush; without one, a full disk would
/// leave the file unwritten while the write appeared to succeed.
async fn replace_contents(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    file.seek(std::io::SeekFrom::Start(0)).await?;
    file.write_all(bytes).await?;
    file.flush().await?;
    file.set_len(bytes.len() as u64).await
}
impl FileTools {
    pub fn new(options: &Value, bridge: Arc<dyn crate::bridge::HostBridge>) -> Self {
        Self {
            reads: Arc::new(FileReadStateStore::default()),
            track_reads: options["nativeOwner"]["readFileStatePresent"] != false,
            read_token_limit: file_range::read_token_limit_for(options),
            explicit_result_budget: if options
                .get("toolResultBudgetExplicit")
                .is_some_and(|value| !crate::js::is_undefined(value))
            {
                (options["toolResultBudgetExplicit"] == true)
                    .then(|| options["toolResultBudget"].as_u64().map(|value| value as usize))
                    .flatten()
            } else {
                options["toolResultBudget"]
                    .as_u64()
                    .map(|value| value as usize)
            },
            deny: deny_roots(options),
            record_change: options["nativeOwner"]["recordFileChange"]["__haloSdkNativeCallback"]
                .as_str()
                .map(|callback| (bridge.clone(), callback.to_owned())),
            external_reads: (options["nativeOwner"]["externalReadFileState"] == true)
                .then_some(bridge),
        }
    }
    pub(super) fn prepare_admission(
        &self,
        name: &str,
        input: &Value,
        cwd: &str,
    ) -> Option<FileAdmissionPreparation> {
        let path = FileAdmission::path(name, input, cwd)?;
        let capture = captures_read_state(name, input);
        let captured = (capture && self.external_reads.is_none())
            .then(|| self.recorded(&file_identity(&path)));
        Some(FileAdmissionPreparation {
            path,
            captured,
            external_reads: capture && self.external_reads.is_some(),
        })
    }
    pub(super) async fn execute_admitted(
        &self,
        name: &str,
        input: &Value,
        ctx: &ToolContext,
        mut admitted: Option<FileAdmission>,
    ) -> crate::error::Result<Value> {
        let harness = &ctx.harness;
        let Some(raw) = input["file_path"].as_str().filter(|s| !s.is_empty()) else {
            return Ok(failure(harness.text(TextId::ToolsFileMissingPath)));
        };
        let path = resolve_tool_path(&ctx.cwd, raw);
        let read_state = captures_read_state(name, input);
        let receipt = admitted
            .as_mut()
            .and_then(|admitted| admitted.receipt.take());
        let captured = if let Some(captured) = admitted
            .as_mut()
            .and_then(|admitted| admitted.captured.take())
        {
            Some(captured)
        } else if read_state && self.external_reads.is_some() {
            Some(
                self.import_read_state(&path, ctx, receipt.as_deref())
                    .await?,
            )
        } else {
            None
        };
        let mut guard = match admitted {
            Some(admitted) => admitted.reservation.acquire().await,
            None => lock(&path).await,
        };
        if ctx.cancellation.is_cancelled() {
            return Ok(failure(harness.text(TextId::ToolsFileCancelled)));
        }
        if name == "Write" && guard.changed() {
            tracing::warn!(session_id=%ctx.session_id,tool_use_id=%ctx.tool_use_id,"Queued file replacement refused because another write ran while it waited");
            return Ok(failure(harness.text(TextId::ToolsFileQueuedChange)));
        }
        let mut exported = ReadExport {
            version: self.read_version(&path),
            invalidated: false,
        };
        let target = Target {
            path: &path,
            identity: guard.identity().to_owned(),
        };
        let result = match name {
            "Read" => Ok(self.read(&target, input, harness, &mut exported, &ctx.cancellation).await),
            "Write" => self.write(&target, input, ctx, captured, &mut exported, &mut guard).await,
            "Edit" => self.edit(&target, input, ctx, captured, &mut exported, &mut guard).await,
            _ => unreachable!(),
        };
        self.export_read_state(&path, &mut exported).await?;
        result
    }
    fn read_version(&self, path: &Path) -> Option<u64> {
        self.external_reads.as_ref()?;
        self.reads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values
            .get(path)
            .map(|state| state.value_version)
    }
    async fn import_read_state(
        &self,
        path: &Path,
        ctx: &ToolContext,
        receipt: Option<&str>,
    ) -> Result<Option<ReadValidation>> {
        let Some(bridge) = &self.external_reads else {
            return Ok(None);
        };
        let mut request = json!({ "path": path });
        if let Some(receipt) = receipt {
            request["receipt"] = json!(receipt);
        }
        let value = bridge
            .call("file.readState.get", request, &ctx.cancellation)
            .await?;
        Ok(crate::js::truthy(&value).then(|| ReadValidation::from_public(&value)))
    }
    async fn export_read_state(&self, path: &Path, exported: &mut ReadExport) -> Result<()> {
        let Some(bridge) = &self.external_reads else {
            return Ok(());
        };
        let entry = self
            .reads
            .context_call("readFileState.getEntry", &json!([path]))?;
        let version = entry["valueVersion"].as_u64();
        if version == exported.version && !exported.invalidated {
            return Ok(());
        }
        if version.is_some() && !exported.invalidated {
            bridge
                .call(
                    "file.readState.set",
                    json!({"path":path,"value":entry["value"],"maxEntries":512}),
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await?;
        } else {
            bridge
                .call(
                    "file.readState.delete",
                    json!({ "path": path }),
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await?;
        }
        exported.version = version;
        exported.invalidated = false;
        Ok(())
    }
    async fn record_change(
        &self,
        path: &Path,
        before: &[u8],
        after: &[u8],
        ctx: &ToolContext,
    ) -> crate::error::Result<()> {
        if let Some((bridge, callback)) = &self.record_change {
            bridge.call("file.recordChange", json!({"callbackId":callback,"path":path,"before":base64::engine::general_purpose::STANDARD.encode(before),"after":base64::engine::general_purpose::STANDARD.encode(after)}), &ctx.cancellation).await?;
        }
        Ok(())
    }
    /// The read recorded for this file under any spelling.
    fn recorded(&self, identity: &str) -> Option<ReadValidation> {
        self.reads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .find(identity)
            .map(ReadState::validation)
    }
    fn forget(&self, target: &Target<'_>, exported: &mut ReadExport) {
        if !self.track_reads {
            return;
        }
        self.reads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .forget(target.path, &target.identity);
        exported.invalidated = true;
    }
    fn record_public(&self, target: &Target<'_>, mut public: Value) {
        if !self.track_reads {
            return;
        }
        let partial = public["isPartialView"] == true;
        let digest = ReadDigest::of(&public, partial);
        if public["content"]
            .as_str()
            .is_some_and(|content| content.encode_utf16().count() * 2 > 4096)
        {
            public["content"] = crate::js::undefined();
        }
        let modified = public["timestamp"].as_f64().unwrap_or(f64::NAN);
        self.reads.lock().unwrap_or_else(|e| e.into_inner()).insert(
            target.path.to_owned(),
            target.identity.clone(),
            ReadState {
                digest,
                modified,
                partial,
                public,
                sequence: 0,
                value_version: 0,
                identity: String::new(),
            },
        );
    }
    pub fn context_call(&self, method: &str, args: &Value) -> crate::error::Result<Value> {
        self.reads.context_call(method, args)
    }
    pub fn shared_read_state(&self) -> Arc<FileReadStateStore> {
        self.reads.clone()
    }
    async fn read(
        &self,
        target: &Target<'_>,
        input: &Value,
        harness: &ResolvedHarness,
        exported: &mut ReadExport,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Value {
        let path = target.path;
        for key in ["offset", "limit"] {
            if let Some(v) = input
                .get(key)
                .filter(|value| !crate::js::is_undefined(value))
            {
                if crate::js::safe_integer(v)
                    .filter(|n| *n >= if key == "offset" { 0 } else { 1 })
                    .is_none()
                {
                    tracing::warn!(field = key, "invalid read pagination refused");
                    return failure(harness.text(if key == "offset" {
                        TextId::ToolsFileInvalidOffset
                    } else {
                        TextId::ToolsFileInvalidLimit
                    }));
                }
            }
        }
        if denied(path, &self.deny) {
            return failure(harness.render(
                TextId::ToolsFileDenied,
                &[("path", &path.to_string_lossy())],
            ));
        }
        let stat = match fs::metadata(path).await {
            Ok(m) => m,
            Err(error) => {
                if error.kind() == std::io::ErrorKind::NotFound {
                    // Seeing the file missing replaces any earlier record; otherwise Write could not recreate it.
                    self.forget(target, exported);
                }
                return failure(harness.render(
                    TextId::ToolsFileNotFound,
                    &[("path", &path.to_string_lossy())],
                ));
            }
        };
        if stat.is_dir() {
            return failure(harness.render(
                TextId::ToolsFileDirectory,
                &[("path", &path.to_string_lossy())],
            ));
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico"].contains(&ext.as_str()) {
            return image(path, &stat, &ext, harness).await;
        }
        if ext == "pdf" {
            return pdf(path, stat.len(), input.get("pages"), harness);
        }
        let offset = crate::js::safe_integer(&input["offset"]).unwrap_or(0) as usize;
        let limit = crate::js::safe_integer(&input["limit"]).unwrap_or(2000) as usize;
        let start = offset.saturating_sub(1);
        if stat.len() > MAX_BYTES as u64 && ext != "ipynb" {
            return self
                .read_range(target, input, harness, offset, limit, start, cancellation)
                .await;
        }
        let snap = match snapshot(path).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(file_path = %path.display(), error = %e, "file snapshot failed");
                return failure(harness.render(
                    TextId::ToolsFileReadFailed,
                    &[
                        ("path", &path.to_string_lossy()),
                        ("error", &e.render_for(harness)),
                    ],
                ));
            }
        };
        let decoded = text::decode(&snap.bytes);
        // Only the complete text is shown; this view never authorizes rewriting the file.
        let complete_prefix = decoded
            .is_none()
            .then(|| text::complete_prefix(&snap.bytes))
            .flatten()
            .filter(|_| ext != "ipynb");
        let lossy;
        let source: &str = match (&decoded, complete_prefix) {
            (Some(decoded), _) => &decoded.text,
            (None, Some(prefix)) => prefix,
            (None, None) => {
                lossy = text::lossy(&snap.bytes);
                &lossy
            }
        };
        let notice = match &decoded {
            Some(decoded) if decoded.encoding.is_utf16() => Some(harness.render(
                TextId::ToolsFileReadEncoding,
                &[("encoding", decoded.encoding.label())],
            )),
            Some(_) => None,
            None if complete_prefix.is_some() => None,
            None => Some(harness.text(TextId::ToolsFileReadUndecodable).to_owned()),
        };
        let content = text::lf(source);
        if ext == "ipynb" {
            match notebook(&content, harness) {
                Ok(text) => {
                    let state = json!({"content":text,"contentHash":hash(&snap.bytes),"timestamp":modified(&snap.metadata),"isPartialView":true});
                    self.record_public(target, state);
                    return success(
                        match notice {
                            Some(notice) => format!("{text}\n{notice}"),
                            None => text,
                        },
                        None,
                    );
                }
                Err(e) => {
                    return failure(
                        harness.render(TextId::ToolsFileNotebookFailed, &[("error", &e)]),
                    )
                }
            }
        }
        if content.is_empty() && complete_prefix.is_none() {
            self.record_public(target, json!({"content":"","contentHash":hash(&snap.bytes),"timestamp":modified(&snap.metadata),"offset":input.get("offset").cloned().unwrap_or_else(crate::js::undefined),"limit":input.get("limit").cloned().unwrap_or_else(crate::js::undefined)}));
            return success(harness.text(TextId::ToolsFileEmpty), None);
        }
        let lines: Vec<&str> = content.split('\n').collect();
        let total = lines.len();
        let end = start.saturating_add(limit).min(total);
        if start >= total {
            return success(
                harness.render(
                    TextId::ToolsFileBeyondEnd,
                    &[
                        ("offset", &offset.to_string()),
                        ("total", &total.to_string()),
                    ],
                ),
                None,
            );
        }
        let width = end.to_string().len();
        let mut output = String::new();
        let mut fitted = start;
        let mut estimated = 0.0;
        let mut characters = 0usize;
        let mut truncated_line = None;
        let mut budget = None;
        for (index, line) in lines.iter().enumerate().take(end).skip(start) {
            let number = index + 1;
            if let Some(kind) = file_range::line_overflow(
                self.read_token_limit,
                self.explicit_result_budget,
                estimated,
                characters,
                line,
                number,
            ) {
                budget = Some(kind);
                if fitted == start {
                    let prefix = file_range::prefix_for_budget(
                        self.read_token_limit,
                        self.explicit_result_budget,
                        kind,
                        estimated,
                        characters,
                        line,
                    );
                    output.push_str(&format!("{:>width$}\t{}\n", number, prefix));
                    fitted = number;
                    truncated_line = Some(number);
                }
                break;
            }
            let next = format!("{:>width$}\t{line}\n", number);
            estimated += crate::core::tokens::estimate_tokens(line) + 2.0;
            characters += next.encode_utf16().count();
            output.push_str(&next);
            fitted = number;
        }
        let more = fitted < total;
        if let Some(number) = truncated_line {
            let text = budget
                .map(|kind| {
                    file_range::budget_text(
                        kind,
                        self.read_token_limit,
                        self.explicit_result_budget,
                        harness,
                    )
                })
                .unwrap_or_default();
            output.push_str(&harness.render(
                TextId::ToolsFileLineTruncated,
                &[("line", &number.to_string()), ("budget", &text)],
            ));
            if more {
                output.push_str(&harness.render(
                    TextId::ToolsFileLineTruncatedLater,
                    &[("offset", &(fitted + 1).to_string()), ("line", &number.to_string())],
                ));
            }
            output.push('\n');
        } else if let Some(kind) = budget.filter(|_| more) {
            let text = file_range::budget_text(
                kind,
                self.read_token_limit,
                self.explicit_result_budget,
                harness,
            );
            let suffix = format!(" of {total}");
            output.push_str(&harness.render(
                TextId::ToolsFileReadBudget,
                &[
                    ("budget", &text),
                    ("start", &(start + 1).to_string()),
                    ("end", &fitted.to_string()),
                    ("total_suffix", &suffix),
                    ("offset", &(fitted + 1).to_string()),
                ],
            ));
            output.push('\n');
        } else if more {
            output.push_str(&harness.render(
                TextId::ToolsFileMoreLines,
                &[
                    ("start", &(start + 1).to_string()),
                    ("end", &fitted.to_string()),
                    ("total", &total.to_string()),
                    ("offset", &(fitted + 1).to_string()),
                ],
            ));
            output.push('\n');
        } else if start > 0 {
            output.push_str(&harness.render(
                TextId::ToolsFileEndOfFileNotStart,
                &[
                    ("start", &(start + 1).to_string()),
                    ("end", &fitted.to_string()),
                ],
            ));
            output.push('\n');
        }
        let (notice, body_limit) = self.read_notice(notice);
        let mut clamped = false;
        if let Some(limit) = body_limit {
            if crate::js::utf16_len(&output) > limit {
                let (fitted_output, delivered_end, truncated) = fit_explicit_read(
                    &output,
                    limit,
                    Some(total),
                    more,
                    false,
                    truncated_line.is_some(),
                    harness,
                );
                output = fitted_output;
                fitted = delivered_end;
                clamped = truncated;
            }
        }
        if let Some(notice) = notice {
            output.push_str(&notice);
            output.push('\n');
        }
        if complete_prefix.is_some() && truncated_line.is_none() && !clamped && fitted == total {
            self.push_end_note(&mut output, harness);
        }
        let partial = truncated_line.is_some()
            || budget.is_some()
            || more
            || start > 0
            || clamped
            || complete_prefix.is_some();
        let retained = if truncated_line.is_some() || budget.is_some() || clamped {
            crate::js::undefined()
        } else if partial {
            json!(lines[start..fitted].join("\n"))
        } else {
            json!(content)
        };
        self.record_public(target, json!({"content":retained,"contentHash":hash(&snap.bytes),"timestamp":modified(&snap.metadata),"offset":input.get("offset").cloned().unwrap_or_else(crate::js::undefined),"limit":input.get("limit").cloned().unwrap_or_else(crate::js::undefined),"isPartialView":if partial {json!(true)}else{crate::js::undefined()}}));
        let mut result = success(output, None);
        result["__haloSdkNativeOutput"] = json!("read_text");
        result
    }

    /// Adds the note on an incomplete final character after a view that delivered
    /// the file's final line, when the explicit budget still holds the whole note.
    fn push_end_note(&self, output: &mut String, harness: &ResolvedHarness) {
        let note = harness.text(TextId::ToolsFileReadIncompleteEnd);
        if self.explicit_result_budget.is_none_or(|limit| {
            crate::js::utf16_len(output) + crate::js::utf16_len(note) + 1 <= limit
        }) {
            output.push_str(note);
            output.push('\n');
        }
    }

    /// A notice that fits the explicit result budget, and the budget left for the lines.
    fn read_notice(&self, notice: Option<String>) -> (Option<String>, Option<usize>) {
        let notice = notice.filter(|notice| {
            self.explicit_result_budget
                .is_none_or(|limit| crate::js::utf16_len(notice) < limit)
        });
        let body_limit = self.explicit_result_budget.map(|limit| {
            limit - notice.as_deref().map_or(0, |notice| crate::js::utf16_len(notice) + 1)
        });
        (notice, body_limit)
    }

    async fn read_range(
        &self,
        target: &Target<'_>,
        input: &Value,
        harness: &ResolvedHarness,
        offset: usize,
        limit: usize,
        start: usize,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Value {
        let path = target.path;
        let request = file_range::RangeRequest {
            path,
            start: start + 1,
            limit,
            token_limit: self.read_token_limit,
            character_limit: self.explicit_result_budget,
            cancellation,
            harness,
        };
        match file_range::read(&request).await {
            Ok(outcome) if outcome.beyond_end => {
                let total = outcome.total.unwrap_or(0);
                return failure(harness.render(
                    TextId::ToolsFileBeyondEnd,
                    &[
                        ("offset", &offset.to_string()),
                        ("total", &total.to_string()),
                    ],
                ));
            }
            Ok(outcome) if outcome.cancelled && outcome.text.is_empty() => {
                return failure(harness.text(TextId::ToolsFileReadCancelled));
            }
            Ok(outcome) => {
                let metadata = fs::metadata(path).await.ok();
                let timestamp = metadata
                    .as_ref()
                    .map(modified)
                    .unwrap_or(f64::NAN);
                let mut text = outcome.text;
                let mut delivered_end = outcome.end;
                let (notice, body_limit) = self.read_notice(
                    outcome
                        .undecodable
                        .then(|| harness.text(TextId::ToolsFileReadUndecodable).to_owned()),
                );
                let mut clamped = false;
                if let Some(limit) = body_limit {
                    if crate::js::utf16_len(&text) > limit {
                        let fitted = fit_explicit_read(
                            &text,
                            limit,
                            outcome.total,
                            outcome.more,
                            outcome.changed,
                            outcome.line_truncated,
                            harness,
                        );
                        text = fitted.0;
                        delivered_end = fitted.1;
                        clamped = fitted.2;
                    }
                }
                if let Some(notice) = notice {
                    text.push_str(&notice);
                    text.push('\n');
                }
                if outcome.incomplete_end && !clamped && delivered_end == outcome.end {
                    self.push_end_note(&mut text, harness);
                }
                let delivered_start = if delivered_end == 0 { 0 } else { outcome.start };
                let mut state = json!({"content":crate::js::undefined(),"timestamp":timestamp,"isPartialView":true,"offset":input.get("offset").cloned().unwrap_or_else(crate::js::undefined),"limit":input.get("limit").cloned().unwrap_or_else(crate::js::undefined),"deliveredStart":delivered_start,"deliveredEnd":delivered_end});
                if let Some(total) = outcome.total {
                    state["totalLines"] = json!(total);
                }
                self.record_public(target, state);
                let mut result = success(text, None);
                result["__haloSdkNativeOutput"] = json!("read_text");
                result
            }
            Err(error) if error.is_abort() => failure(harness.text(TextId::ToolsFileReadCancelled)),
            Err(error) => {
                tracing::warn!(file_path = %path.display(), error = %error, "large text range read failed");
                failure(harness.render(
                    TextId::ToolsFileReadFailed,
                    &[
                        ("path", &path.to_string_lossy()),
                        ("error", &error.render_for(harness)),
                    ],
                ))
            }
        }
    }

    async fn write(
        &self,
        target: &Target<'_>,
        input: &Value,
        ctx: &ToolContext,
        captured: Option<Option<ReadValidation>>,
        exported: &mut ReadExport,
        guard: &mut FileGuard,
    ) -> crate::error::Result<Value> {
        let path = target.path;
        let harness = &ctx.harness;
        let Some(content) = input["content"].as_str() else {
            return Ok(failure(harness.text(TextId::ToolsFileMissingContent)));
        };
        if content.len() > MAX_BYTES {
            return Ok(failure(size_error().render_for(harness)));
        }
        let state = captured.unwrap_or_else(|| self.recorded(&target.identity));
        let exists = fs::try_exists(path).await.unwrap_or(false);
        let old = if exists {
            match snapshot(path).await {
                Ok(s) => Some(s),
                Err(e) => {
                    return Ok(failure(harness.render(
                        TextId::ToolsFileReadFailed,
                        &[
                            ("path", &path.to_string_lossy()),
                            ("error", &e.render_for(harness)),
                        ],
                    )))
                }
            }
        } else {
            None
        };
        if let Some(state) = state.filter(|_| self.track_reads) {
            if old.as_ref().is_none_or(|snapshot| !unchanged(&state, snapshot)) {
                return Ok(failure(harness.text(TextId::ToolsFileChanged)));
            }
        }
        let encoding = match &old {
            None => text::Encoding::Utf8,
            Some(old) => match text::decode(&old.bytes) {
                Some(decoded) => decoded.encoding,
                None => {
                    tracing::warn!(file_path = %path.display(), "Write refused: the existing file is not lossless text");
                    return Ok(failure(harness.text(TextId::ToolsFileUndecodable)));
                }
            },
        };
        let written = text::encode(content, encoding);
        if written.len() > MAX_BYTES {
            return Ok(failure(size_error().render_for(harness)));
        }
        let stat = match write_snapshot(path, &written, old.as_ref(), guard).await {
            Ok(s) => s,
            Err(e) => {
                self.forget(target, exported);
                return Ok(failure(harness.render(
                    TextId::ToolsFileWriteFailed,
                    &[
                        ("path", &path.to_string_lossy()),
                        ("error", &e.render_for(harness)),
                    ],
                )));
            }
        };
        self.record_public(target, json!({"content":content,"contentHash":hash(&written),"timestamp":modified(&stat)}));
        self.export_read_state(path, exported).await?;
        self.record_change(
            path,
            old.as_ref()
                .map(|snapshot| snapshot.bytes.as_slice())
                .unwrap_or(&[]),
            &written,
            ctx,
        )
        .await?;
        let lines = content.split_terminator('\n').count();
        let bytes = written.len();
        let mut message = harness.render(
            TextId::ToolsFileWritten,
            &[
                (
                    "action",
                    harness.text(if old.is_some() {
                        TextId::ToolsFileWrote
                    } else {
                        TextId::ToolsFileCreated
                    }),
                ),
                ("path", &path.to_string_lossy()),
                ("lines", &lines.to_string()),
                ("bytes", &bytes.to_string()),
            ],
        );
        if encoding != text::Encoding::Utf8 {
            message.push_str(&harness.render(
                TextId::ToolsFileKeptEncoding,
                &[("encoding", encoding.label())],
            ));
        }
        Ok(success(
            message,
            Some(json!({"file_path":path,"is_new":old.is_none(),"lines":lines,"bytes":bytes})),
        ))
    }
    async fn edit(
        &self,
        target: &Target<'_>,
        input: &Value,
        ctx: &ToolContext,
        captured: Option<Option<ReadValidation>>,
        exported: &mut ReadExport,
        guard: &mut FileGuard,
    ) -> crate::error::Result<Value> {
        let path = target.path;
        let harness = &ctx.harness;
        let Some(old) = input["old_string"].as_str().filter(|s| !s.is_empty()) else {
            return Ok(failure(harness.text(TextId::ToolsFileMissingOld)));
        };
        let Some(new) = input["new_string"].as_str() else {
            return Ok(failure(harness.text(TextId::ToolsFileMissingNew)));
        };
        if old == new {
            return Ok(failure(harness.text(TextId::ToolsFileIdenticalEdit)));
        }
        let state = captured.unwrap_or_else(|| self.recorded(&target.identity));
        if self.track_reads && state.is_none() {
            return Ok(failure(harness.text(TextId::ToolsFileEditRead)));
        }
        let snap = match snapshot(path).await {
            Ok(s) => s,
            Err(e) => {
                return Ok(failure(harness.render(
                    TextId::ToolsFileReadFailed,
                    &[
                        ("path", &path.to_string_lossy()),
                        ("error", &e.render_for(harness)),
                    ],
                )))
            }
        };
        if let Some(state) = state.as_ref().filter(|_| self.track_reads) {
            if !unchanged(state, &snap) {
                return Ok(failure(harness.text(TextId::ToolsFileChanged)));
            }
        }
        let Some(decoded) = text::decode(&snap.bytes) else {
            tracing::warn!(file_path = %path.display(), "Edit refused: the file is not lossless text");
            return Ok(failure(harness.text(TextId::ToolsFileUndecodable)));
        };
        let view = text::LfView::new(&decoded.text);
        let wanted = text::lf(old);
        let count = view.text().matches(wanted.as_ref()).count();
        if count == 0 {
            return Ok(failure(
                harness.render(TextId::ToolsFileNoMatch, &[("old", old)]),
            ));
        }
        let all = input["replace_all"].as_bool().unwrap_or(false);
        if count > 1 && !all {
            return Ok(failure(harness.render(
                TextId::ToolsFileAmbiguousEdit,
                &[("count", &count.to_string()), ("old", old)],
            )));
        }
        let replacements = if all { count } else { 1 };
        let insertion = text::with_ending(new, text::dominant_ending(&decoded.text));
        // Size the result before building it: a replace_all multiplies the insertion.
        let mut removed = 0usize;
        let mut identical = true;
        for original in view.originals(&wanted, replacements) {
            removed += text::encoded_len(original, decoded.encoding);
            identical &= original == insertion.as_ref();
        }
        if identical {
            return Ok(failure(harness.text(TextId::ToolsFileEditNoChange)));
        }
        let size = text::encoded_len(&insertion, decoded.encoding)
            .checked_mul(replacements)
            .and_then(|added| snap.bytes.len().checked_sub(removed)?.checked_add(added));
        if size.is_none_or(|size| size > MAX_BYTES) {
            return Ok(failure(size_error().render_for(harness)));
        }
        let updated = view.replace(&wanted, replacements, &insertion);
        let written = text::encode(&updated, decoded.encoding);
        match write_snapshot(path, &written, Some(&snap), guard).await {
            Ok(_) => {}
            Err(e) => {
                self.forget(target, exported);
                return Ok(failure(harness.render(
                    TextId::ToolsFileWriteFailed,
                    &[
                        ("path", &path.to_string_lossy()),
                        ("error", &e.render_for(harness)),
                    ],
                )));
            }
        };
        self.record_change(path, &snap.bytes, &written, ctx)
            .await?;
        let mut message = harness.render(
            TextId::ToolsFileEdited,
            &[
                ("path", &path.to_string_lossy()),
                ("count", &replacements.to_string()),
                ("plural", if replacements == 1 { "" } else { "s" }),
            ],
        );
        if let Some(state) = state.filter(|_| self.track_reads) {
            match snapshot(path).await {
                Ok(final_snapshot) if final_snapshot.bytes != written => {
                    self.forget(target, exported);
                    tracing::warn!(file_path = %path.display(), "file changed after edit; read authorization revoked");
                    message.push_str(harness.text(TextId::ToolsFileChangedAfterEdit));
                }
                Ok(final_snapshot) => {
                    self.record_public(target, json!({"content":if state.partial {crate::js::undefined()}else{json!(text::lf(&updated))},"contentHash":hash(&written),"timestamp":modified(&final_snapshot.metadata),"isPartialView":state.partial_view}));
                }
                Err(error) => {
                    self.forget(target, exported);
                    tracing::warn!(file_path = %path.display(),error = %error, "post-edit read state invalidated");
                    message.push_str(harness.text(TextId::ToolsFileRefreshFailed));
                }
            }
        }
        Ok(success(
            message,
            Some(json!({"file_path":path,"replacements":replacements})),
        ))
    }
}
fn numbered_read_line(line: &str) -> Option<(usize, &str)> {
    let line = line.strip_suffix('\n').unwrap_or(line);
    let (number, content) = line.split_once('\t')?;
    Some((number.trim().parse().ok()?, content))
}

/// Fits an explicit character cap around the numbered read body. The original
/// feedback is replaced with a truthful continuation notice when lines must be
/// dropped; a short marker is used only when no body content plus feedback fits.
fn fit_explicit_read(
    output: &str,
    limit: usize,
    total: Option<usize>,
    more: bool,
    changed: bool,
    line_truncated: bool,
    harness: &ResolvedHarness,
) -> (String, usize, bool) {
    if limit == 0 {
        return (String::new(), 0, true);
    }
    if crate::js::utf16_len(output) <= limit {
        let end = output
            .split_inclusive('\n')
            .filter_map(numbered_read_line)
            .last()
            .map(|(number, _)| number)
            .unwrap_or(0);
        return (output.to_owned(), end, false);
    }
    let body: Vec<&str> = output
        .split_inclusive('\n')
        .take_while(|line| numbered_read_line(line).is_some())
        .collect();
    let Some((start, first_content)) = body.first().and_then(|line| numbered_read_line(line)) else {
        return (short_read_output(limit, harness), 0, true);
    };
    let width = body
        .first()
        .and_then(|line| line.split_once('\t').map(|(number, _)| number.len()))
        .unwrap_or(1);
    let budget = file_range::budget_text(
        file_range::BudgetKind::Characters,
        0,
        Some(limit),
        harness,
    );
    for count in (1..=body.len()).rev() {
        let end = body[count - 1]
            .split_inclusive('\n')
            .next()
            .and_then(numbered_read_line)
            .map(|(number, _)| number)
            .unwrap_or(start);
        let delivered_more = more || count < body.len();
        let mut notice = String::new();
        if changed {
            notice.push_str(&harness.render(
                TextId::ToolsFileChangedDuringRead,
                &[("start", &start.to_string()), ("end", &end.to_string())],
            ));
            notice.push('\n');
        }
        if line_truncated && count == body.len() {
            notice.push_str(&harness.render(
                TextId::ToolsFileLineTruncated,
                &[("line", &end.to_string()), ("budget", &budget)],
            ));
            if delivered_more {
                notice.push_str(&harness.render(
                    TextId::ToolsFileLineTruncatedLater,
                    &[
                        ("offset", &(end + 1).to_string()),
                        ("line", &end.to_string()),
                    ],
                ));
            }
            notice.push('\n');
        } else if delivered_more {
            let suffix = total.map(|total| format!(" of {total}")).unwrap_or_default();
            notice.push_str(&harness.render(
                TextId::ToolsFileReadBudget,
                &[
                    ("budget", &budget),
                    ("start", &start.to_string()),
                    ("end", &end.to_string()),
                    ("total_suffix", &suffix),
                    ("offset", &(end + 1).to_string()),
                ],
            ));
            notice.push('\n');
        }
        let candidate = format!("{}{notice}", body[..count].concat());
        if crate::js::utf16_len(&candidate) <= limit {
            return (candidate, end, count < body.len());
        }
    }
    let line_notice = harness.render(
        TextId::ToolsFileLineTruncated,
        &[("line", &start.to_string()), ("budget", &budget)],
    );
    let line_notice = if more {
        format!(
            "{line_notice}{}\n",
            harness.render(
                TextId::ToolsFileLineTruncatedLater,
                &[
                    ("offset", &(start + 1).to_string()),
                    ("line", &start.to_string()),
                ],
            )
        )
    } else {
        format!("{line_notice}\n")
    };
    let prefix = format!("{:>width$}\t", start);
    let available = limit.saturating_sub(
        crate::js::utf16_len(&line_notice) + crate::js::utf16_len(&prefix) + 1,
    );
    let content = crate::js::utf16_prefix_without_split(first_content, available);
    if !content.is_empty() {
        let candidate = format!("{prefix}{content}\n{line_notice}");
        if crate::js::utf16_len(&candidate) <= limit {
            return (candidate, start, true);
        }
    }
    (short_read_output(limit, harness), 0, true)
}

fn short_read_output(limit: usize, harness: &ResolvedHarness) -> String {
    let label = file_range::budget_text(
        file_range::BudgetKind::Characters,
        0,
        Some(limit),
        harness,
    );
    let short = harness.render(TextId::ToolsOutputShort, &[("budget", &label)]);
    if crate::js::utf16_len(&short) <= limit {
        return short;
    }
    let marker = harness.text(TextId::ContextTruncationMarker);
    if crate::js::utf16_len(marker) <= limit {
        return marker.to_owned();
    }
    crate::js::utf16_prefix_without_split(harness.text(TextId::ContextTruncationEllipsis), limit)
}

async fn image(
    path: &Path,
    stat: &std::fs::Metadata,
    ext: &str,
    harness: &ResolvedHarness,
) -> Value {
    if stat.len() > 5 * 1024 * 1024 {
        return failure(harness.render(
            TextId::ToolsFileImageLimit,
            &[(
                "megabytes",
                &crate::js::to_fixed(stat.len() as f64 / (1024. * 1024.), 1),
            )],
        ));
    }
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => {}
        _ => {
            return success(
                harness.render(
                    TextId::ToolsFileImageUnsupported,
                    &[("path", &path.to_string_lossy())],
                ),
                None,
            )
        }
    }
    match File::open(path).await {
        Ok(mut file) => match crate::filesystem::read_bounded(&mut file, 5 * 1024 * 1024).await {
            Ok(bytes) => {
                let Some(mime) = crate::images::read_mime(&bytes) else {
                    tracing::warn!(file_path=%path.display(), bytes=bytes.len(), "Image read refused: empty, unsupported or incomplete image data");
                    return failure(harness.render(
                        TextId::ToolsFileImageInvalid,
                        &[("path", &path.to_string_lossy())],
                    ));
                };
                let mut result = success(
                    harness.render(
                        TextId::ToolsFileImageCaptured,
                        &[("path", &path.to_string_lossy())],
                    ),
                    None,
                );
                result["images"] = json!([{"mimeType":mime,"data":base64::engine::general_purpose::STANDARD.encode(&bytes)}]);
                result
            }
            Err(error) => {
                tracing::warn!(file_path = %path.display(), error = %error, "image read failed");
                failure(error.render_for(harness))
            }
        },
        Err(e) => failure(e.to_string()),
    }
}
fn pdf(path: &Path, size: u64, pages: Option<&Value>, harness: &ResolvedHarness) -> Value {
    let guidance = harness.text(TextId::ToolsFilePdfGuidance);
    if size > 100 * 1024 * 1024 {
        return failure(harness.render(
            TextId::ToolsFilePdfLimit,
            &[("size", &size.to_string()), ("guidance", guidance)],
        ));
    }
    let mut selection = String::new();
    if let Some(pages) = pages {
        let parsed = pages.as_str().and_then(|s| {
            let parts: Vec<_> = crate::js::trim_js(s).split('-').collect();
            if parts.len() > 2 {
                return None;
            }
            let first = crate::js::trim_end_js(parts[0]);
            if first.is_empty() || !first.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let start = first.parse::<u64>().ok()?;
            let end = if parts.len() == 2 {
                let last = crate::js::trim_start_js(parts[1]);
                if last.is_empty() || !last.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                last.parse::<u64>().ok()?
            } else {
                start
            };
            if start < 1 || end < start || end > 9007199254740991 {
                return None;
            }
            Some((start, end))
        });
        let Some((start, end)) = parsed else {
            return failure(
                harness.render(TextId::ToolsFilePdfInvalidPages, &[("guidance", guidance)]),
            );
        };
        let count = end - start + 1;
        if count > 20 {
            return failure(harness.render(
                TextId::ToolsFilePdfTooManyPages,
                &[
                    ("count", &count.to_string()),
                    ("start", &start.to_string()),
                    ("end", &(start + 19).to_string()),
                    ("next", &(start + 20).to_string()),
                    ("guidance", guidance),
                ],
            ));
        }
        selection = if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        };
    }
    success(
        harness.render(
            TextId::ToolsFilePdfFile,
            &[
                ("path", &path.to_string_lossy()),
                ("size", &size.to_string()),
                (
                    "selection",
                    &if selection.is_empty() {
                        String::new()
                    } else {
                        harness.render(TextId::ToolsFilePdfSelection, &[("selection", &selection)])
                    },
                ),
                ("guidance", guidance),
            ],
        ),
        None,
    )
}
fn notebook(raw: &str, harness: &ResolvedHarness) -> std::result::Result<String, String> {
    let value: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let Some(cells) = value["cells"].as_array() else {
        return Ok(harness.text(TextId::ToolsFileEmptyNotebook).into());
    };
    let text = |v: &Value| -> String {
        v.as_str()
            .map(str::to_owned)
            .or_else(|| {
                v.as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
            })
            .unwrap_or_default()
    };
    let mut parts = Vec::new();
    for (i, cell) in cells.iter().enumerate() {
        parts.push(harness.render(
            TextId::ToolsFileNotebookCell,
            &[
                ("index", &i.to_string()),
                ("kind", cell["cell_type"].as_str().unwrap_or("undefined")),
            ],
        ));
        parts.push(text(&cell["source"]));
        let mut outputs = Vec::new();
        if let Some(items) = cell["outputs"].as_array() {
            for o in items {
                if crate::js::truthy(&o["text"]) {
                    outputs.push(text(&o["text"]));
                } else if crate::js::truthy(&o["data"]) {
                    if crate::js::truthy(&o["data"]["text/plain"]) {
                        outputs.push(text(&o["data"]["text/plain"]));
                    }
                } else if let Some(trace) = o["traceback"].as_array() {
                    outputs.push(
                        trace
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n"),
                    );
                }
            }
        }
        if !outputs.is_empty() {
            parts.push(harness.text(TextId::ToolsFileNotebookOutput).into());
            parts.push(outputs.join("\n"));
        }
        parts.push(String::new());
    }
    Ok(parts.join("\n"))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod admission_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn read_states_refresh_automatic_order_and_evict_at_512_entries() {
        let mut states = ReadStates::default();
        let entry = |content: &str| ReadState {
            digest: ReadDigest::Raw(hash(content.as_bytes())), modified: 1.0, partial: false,
            public: json!({"content":content,"timestamp":1}), sequence: 0, value_version: 0, identity: String::new(),
        };
        let insert = |states: &mut ReadStates, path: &str, content: &str| {
            states.insert(PathBuf::from(path), path.to_owned(), entry(content));
        };
        insert(&mut states, "/a", "a");
        insert(&mut states, "/b", "b");
        insert(&mut states, "/a", "a2");
        assert_eq!(states.order, VecDeque::from([PathBuf::from("/b"), PathBuf::from("/a")]));
        assert_eq!(states.values[&PathBuf::from("/a")].public["content"], "a2");
        for index in 0..512 {
            insert(&mut states, &format!("/file-{index}"), "content");
        }
        assert_eq!(states.values.len(), 512);
        insert(&mut states, "/new", "new");
        assert_eq!(states.values.len(), 512);
        assert!(!states.values.contains_key(&PathBuf::from("/file-0")));
        assert!(states.values.contains_key(&PathBuf::from("/file-1")));
        assert!(states.values.contains_key(&PathBuf::from("/new")));
    }

    #[test]
    fn read_states_keep_one_entry_per_file_identity() {
        let mut states = ReadStates::default();
        let entry = |content: &str| ReadState {
            digest: ReadDigest::Raw(hash(content.as_bytes())), modified: 1.0, partial: false,
            public: json!({"content":content}), sequence: 0, value_version: 0, identity: String::new(),
        };
        states.insert(PathBuf::from("/W/A.txt"), "/w/a.txt".into(), entry("old"));
        states.insert(PathBuf::from("/w/a.txt"), "/w/a.txt".into(), entry("new"));
        assert_eq!(states.values.len(), 1);
        assert_eq!(states.order, VecDeque::from([PathBuf::from("/w/a.txt")]));
        let found = states.find("/w/a.txt").unwrap();
        assert_eq!(found.public["content"], "new");
        // An entry describes the file it was recorded for, not whatever its key names now.
        states.insert(PathBuf::from("/link"), "/w/b.txt".into(), entry("b"));
        assert!(states.find("/w/c.txt").is_none());
        assert_eq!(states.find("/w/b.txt").unwrap().public["content"], "b");
        states.forget(Path::new("/w/A.TXT"), "/w/a.txt");
        assert_eq!(states.values.len(), 1);
        states.forget(Path::new("/link"), "/w/c.txt");
        assert!(states.values.is_empty() && states.order.is_empty());
    }

    #[test]
    fn explicit_budget_keeps_body_before_replacing_feedback() {
        let harness = crate::harness::baseline();
        let body: String = (1..=20)
            .map(|number| format!("{number:>2}\tline-{number:02}\n"))
            .collect();
        let output = format!("{body}[More content remains.]\n");
        let (fitted, end, truncated) =
            fit_explicit_read(&output, 230, Some(100), true, false, false, &harness);
        assert!(truncated);
        assert!(end > 0 && end < 20);
        assert!(fitted.starts_with(" 1\tline-01\n"));
        assert!(fitted.contains("Read reached the 230"));
        assert!(fitted.contains("Later lines are available from offset="));
        assert!(!fitted.contains("Output omitted"));
        assert!(crate::js::utf16_len(&fitted) <= 230);

        let (body_only, end, truncated) =
            fit_explicit_read(&body, 350, Some(20), false, false, false, &harness);
        assert!(!truncated);
        assert_eq!(end, 20);
        assert_eq!(body_only, body);

        let (partial, end, truncated) =
            fit_explicit_read(&format!("1\t{}\n", "x".repeat(500)), 400, None, true, false, true, &harness);
        assert!(truncated);
        assert_eq!(end, 1);
        assert!(partial.starts_with("1\t"));
        assert!(crate::js::utf16_len(&partial) <= 400);

        let (short, end, truncated) =
            fit_explicit_read(&body, 40, Some(20), true, false, false, &harness);
        assert!(truncated);
        assert_eq!(end, 0);
        assert!(crate::js::utf16_len(&short) <= 40);
    }

    #[test]
    fn partial_read_content_never_creates_a_whole_file_digest() {
        let complete = ReadValidation::from_public(&json!({"content":"fragment","timestamp":1}));
        assert!(matches!(&complete.digest, ReadDigest::Text(digest) if *digest == hash(b"fragment")));
        assert!(!complete.partial);
        let raw = ReadValidation::from_public(&json!({"content":"fragment","contentHash":"raw","timestamp":1}));
        assert!(matches!(&raw.digest, ReadDigest::Raw(digest) if digest == "raw"));
        let partial = ReadValidation::from_public(&json!({"content":"fragment","timestamp":1,"isPartialView":true}));
        assert!(partial.partial);
        assert!(matches!(partial.digest, ReadDigest::None));
    }

    #[tokio::test]
    async fn reservations_keep_fifo_update_wakers_and_release_cancelled_waiters() {
        let root =
            std::env::temp_dir().join(format!("halo-file-admission-{}", uuid::Uuid::new_v4()));
        let path = root.join("file");
        let first = FileReservation::new(&path);
        let cancelled = FileReservation::new(&path);
        let third = FileReservation::new(&path);
        drop(cancelled);

        let unrelated = FileReservation::new(&root.join("other"));
        drop(
            tokio::time::timeout(Duration::from_secs(1), unrelated.acquire())
                .await
                .unwrap(),
        );

        let (polled, waiting) = tokio::sync::oneshot::channel();
        let queued = tokio::spawn(async move {
            let mut polled = Some(polled);
            let future = third.acquire();
            tokio::pin!(future);
            std::future::poll_fn(|context| {
                let result = future.as_mut().poll(context);
                if result.is_pending() {
                    if let Some(polled) = polled.take() {
                        let _ = polled.send(());
                    }
                }
                result
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap();
        assert!(!queued.is_finished());
        drop(first);
        let guard = tokio::time::timeout(Duration::from_secs(1), queued)
            .await
            .unwrap()
            .unwrap();
        drop(guard);
        drop(
            tokio::time::timeout(
                Duration::from_secs(1),
                FileReservation::new(&path).acquire(),
            )
            .await
            .unwrap(),
        );
        assert!(!FILE_LOCKS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .contains_key(&folded(&real_path(&path))));
    }

    #[tokio::test]
    async fn a_reserved_permit_remains_available_before_its_task_is_polled() {
        let path =
            std::env::temp_dir().join(format!("halo-file-admission-{}", uuid::Uuid::new_v4()));
        let first = FileReservation::new(&path);
        let next = FileReservation::new(&path);
        drop(first);
        drop(
            tokio::time::timeout(Duration::from_secs(1), next.acquire())
                .await
                .unwrap(),
        );
        assert!(!FILE_LOCKS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .contains_key(&folded(&real_path(&path))));
    }
}
