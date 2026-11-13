use super::{failure, success, ToolContext};
use crate::{
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(not(unix))]
use std::time::UNIX_EPOCH;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
    task::{Context, Poll},
};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::{Mutex, OwnedMutexGuard},
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
type Locks = StdMutex<HashMap<String, Weak<Mutex<()>>>>;
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
    identity: Weak<Mutex<()>>,
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
    _entry: FileLockEntry,
}
impl Drop for FileGuard {
    fn drop(&mut self) {
        drop(self.guard.take());
    }
}
fn file_lock(path: &Path) -> (Arc<Mutex<()>>, FileLockEntry) {
    let key = folded(&real_path(path));
    let lock = {
        let mut map = FILE_LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match map.get(&key).and_then(Weak::upgrade) {
            Some(v) => v,
            None => {
                let v = Arc::new(Mutex::new(()));
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
    let (lock, entry) = file_lock(path);
    let guard = lock.lock_owned().await;
    FileGuard {
        guard: Some(guard),
        _entry: entry,
    }
}

enum ReservationState {
    Ready(Option<OwnedMutexGuard<()>>),
    Waiting(Pin<Box<dyn Future<Output = OwnedMutexGuard<()>> + Send>>),
}
struct FileReservation {
    state: Option<ReservationState>,
    entry: Option<FileLockEntry>,
}
impl Drop for FileReservation {
    fn drop(&mut self) {
        drop(self.state.take());
    }
}
impl FileReservation {
    fn new(path: &Path) -> Self {
        let (lock, entry) = file_lock(path);
        let mut pending = Box::pin(lock.lock_owned());
        let mut context = Context::from_waker(futures::task::noop_waker_ref());
        // Enqueue before returning to JavaScript; a later task poll installs its own waker.
        let admitted =
            Pin::new(&mut tokio::task::unconstrained(pending.as_mut())).poll(&mut context);
        let state = match admitted {
            Poll::Ready(guard) => ReservationState::Ready(Some(guard)),
            Poll::Pending => ReservationState::Waiting(pending),
        };
        Self {
            state: Some(state),
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
            _entry: self.entry.take().unwrap(),
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
        .then(|| resolve(cwd, raw))
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
#[derive(Clone)]
struct ReadState {
    hash: String,
    modified: f64,
    partial: bool,
    public: Value,
    sequence: u64,
    value_version: u64,
}
#[derive(Clone)]
struct ReadValidation {
    hash: String,
    modified: f64,
    partial: bool,
    partial_view: Value,
}
impl ReadValidation {
    fn from_public(public: &Value) -> Self {
        let partial = public["isPartialView"] == true;
        let hash = public["contentHash"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                (!partial)
                    .then(|| {
                        public["content"]
                            .as_str()
                            .map(|content| hash(content.as_bytes()))
                    })
                    .flatten()
            })
            .unwrap_or_default();
        Self {
            hash,
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
            hash: self.hash.clone(),
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
    fn insert(&mut self, path: PathBuf, mut state: ReadState) {
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
                    hash: validation.hash,
                    modified: validation.modified,
                    partial: validation.partial,
                    public,
                    sequence,
                    value_version,
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
                    value.hash = value.public["contentHash"].as_str().map(str::to_owned).or_else(||(!value.partial).then(||value.public["content"].as_str().map(|s|hash(s.as_bytes()))).flatten()).unwrap_or_default();
                    json!(true)
                } else { json!(false) }
            },
            "readFileState.get" => state
                .values
                .get(&key()?)
                .map(|s| s.public.clone())
                .unwrap_or(Value::Null),
            "readFileState.has" => json!(state.values.contains_key(&key()?)),
            "readFileState.delete" => {
                let key = key()?;
                state.order.retain(|p| p != &key);
                json!(state.values.remove(&key).is_some())
            }
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
    pub deny: Vec<PathBuf>,
    record_change: Option<(Arc<dyn crate::bridge::HostBridge>, String)>,
    external_reads: Option<Arc<dyn crate::bridge::HostBridge>>,
}
struct Snapshot {
    bytes: Vec<u8>,
    metadata: std::fs::Metadata,
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
fn same(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
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
async fn write_snapshot(
    path: &Path,
    bytes: &[u8],
    previous: Option<&Snapshot>,
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
    if let Some(expected) = previous {
        let current = file.metadata().await.map_err(Error::from)?;
        let at_path = File::open(path)
            .await
            .map_err(Error::from)?
            .metadata()
            .await
            .map_err(Error::from)?;
        if !same(&current, &at_path) {
            return Err(Error::new("FILE_CHANGED", "").with_harness(TextId::ToolsFileChanged, &[]));
        }
        if !same(&expected.metadata, &current) {
            if !same_content_version(&expected.metadata, &current) {
                return Err(
                    Error::new("FILE_CHANGED", "").with_harness(TextId::ToolsFileChanged, &[])
                );
            }
            let content = crate::filesystem::read_bounded(&mut file, MAX_BYTES).await?;
            let after = file.metadata().await.map_err(Error::from)?;
            let at_path = File::open(path)
                .await
                .map_err(Error::from)?
                .metadata()
                .await
                .map_err(Error::from)?;
            if content != expected.bytes || !same(&current, &after) || !same(&after, &at_path) {
                return Err(
                    Error::new("FILE_CHANGED", "").with_harness(TextId::ToolsFileChanged, &[])
                );
            }
            file.seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(Error::from)?;
        }
    }
    file.write_all(bytes).await.map_err(Error::from)?;
    file.set_len(bytes.len() as u64)
        .await
        .map_err(Error::from)?;
    file.metadata().await.map_err(Error::from)
}
impl FileTools {
    pub fn new(options: &Value, bridge: Arc<dyn crate::bridge::HostBridge>) -> Self {
        Self {
            reads: Arc::new(FileReadStateStore::default()),
            track_reads: options["nativeOwner"]["readFileStatePresent"] != false,
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
        let captured = (capture && self.external_reads.is_none()).then(|| {
            self.reads
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .values
                .get(&path)
                .map(ReadState::validation)
        });
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
        let path = resolve(&ctx.cwd, raw);
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
        let _guard = match admitted {
            Some(admitted) => admitted.reservation.acquire().await,
            None => lock(&path).await,
        };
        if ctx.cancellation.is_cancelled() {
            return Ok(failure(harness.text(TextId::ToolsFileCancelled)));
        }
        let mut exported = ReadExport {
            version: self.read_version(&path),
            invalidated: false,
        };
        let result = match name {
            "Read" => Ok(self.read(&path, input, harness).await),
            "Write" => self.write(&path, input, ctx, captured, &mut exported).await,
            "Edit" => self.edit(&path, input, ctx, captured, &mut exported).await,
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
    fn forget(&self, path: &Path, exported: &mut ReadExport) {
        if !self.track_reads {
            return;
        }
        let mut reads = self.reads.lock().unwrap_or_else(|error| error.into_inner());
        reads.values.remove(path);
        reads.order.retain(|entry| entry != path);
        exported.invalidated = true;
    }
    async fn record(&self, path: &Path, bytes: &[u8], metadata: &std::fs::Metadata, partial: bool) {
        if !self.track_reads {
            return;
        }
        let content = String::from_utf8_lossy(bytes);
        let mut public = json!({"content":if partial { crate::js::undefined() } else { json!(content) },"contentHash":hash(bytes),"timestamp":modified(metadata)});
        if partial {
            public["isPartialView"] = json!(true);
        }
        self.record_public(path, public);
    }
    fn record_public(&self, path: &Path, mut public: Value) {
        if !self.track_reads {
            return;
        }
        let partial = public["isPartialView"] == true;
        let content_hash = public["contentHash"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                (!partial)
                    .then(|| public["content"].as_str().map(|s| hash(s.as_bytes())))
                    .flatten()
            })
            .unwrap_or_default();
        if !content_hash.is_empty() {
            public["contentHash"] = json!(content_hash);
        }
        if public["content"]
            .as_str()
            .is_some_and(|content| content.encode_utf16().count() * 2 > 4096)
        {
            public["content"] = crate::js::undefined();
        }
        let modified = public["timestamp"].as_f64().unwrap_or(f64::NAN);
        self.reads.lock().unwrap_or_else(|e| e.into_inner()).insert(
            path.to_owned(),
            ReadState {
                hash: content_hash,
                modified,
                partial,
                public,
                sequence: 0,
                value_version: 0,
            },
        );
    }
    pub fn context_call(&self, method: &str, args: &Value) -> crate::error::Result<Value> {
        self.reads.context_call(method, args)
    }
    pub fn shared_read_state(&self) -> Arc<FileReadStateStore> {
        self.reads.clone()
    }
    async fn read(&self, path: &Path, input: &Value, harness: &ResolvedHarness) -> Value {
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
            Err(_) => {
                return failure(harness.render(
                    TextId::ToolsFileNotFound,
                    &[("path", &path.to_string_lossy())],
                ))
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
        let content = String::from_utf8_lossy(&snap.bytes);
        if ext == "ipynb" {
            match notebook(&content, harness) {
                Ok(text) => {
                    let state = json!({"content":text,"contentHash":hash(&snap.bytes),"timestamp":modified(&snap.metadata),"isPartialView":true});
                    self.record_public(path, state);
                    return success(text, None);
                }
                Err(e) => {
                    return failure(
                        harness.render(TextId::ToolsFileNotebookFailed, &[("error", &e)]),
                    )
                }
            }
        }
        if content.is_empty() {
            self.record_public(path, json!({"content":"","contentHash":hash(&snap.bytes),"timestamp":modified(&snap.metadata),"offset":input.get("offset").cloned().unwrap_or_else(crate::js::undefined),"limit":input.get("limit").cloned().unwrap_or_else(crate::js::undefined)}));
            return success(harness.text(TextId::ToolsFileEmpty), None);
        }
        let lines: Vec<&str> = content.split('\n').collect();
        let total = lines.len();
        let offset = crate::js::safe_integer(&input["offset"]).unwrap_or(0) as usize;
        let limit = crate::js::safe_integer(&input["limit"]).unwrap_or(2000) as usize;
        let start = offset.saturating_sub(1);
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
        let mut truncated = false;
        let mut chars = 0;
        for (i, line) in lines.iter().enumerate().take(end).skip(start) {
            let next = format!("{:>width$}\t{line}\n", i + 1);
            let n = next.encode_utf16().count();
            if chars + n > 40000 {
                if fitted == start {
                    output = super::utf16_prefix(&next, 40000);
                    output.push('\n');
                    fitted = i + 1;
                    truncated = true;
                }
                break;
            }
            output.push_str(&next);
            chars += n;
            fitted = i + 1;
        }
        if truncated {
            output.push_str(&harness.render(
                TextId::ToolsFileLineTruncated,
                &[("line", &(start + 1).to_string())],
            ));
        }
        if fitted < total {
            output.push_str(&harness.render(
                TextId::ToolsFileMoreLines,
                &[
                    ("start", &(start + 1).to_string()),
                    ("end", &fitted.to_string()),
                    ("total", &total.to_string()),
                    ("offset", &(fitted + 1).to_string()),
                ],
            ));
        }
        let partial = truncated || fitted < total || start > 0;
        let retained = if truncated {
            crate::js::undefined()
        } else if partial {
            json!(lines[start..fitted].join("\n"))
        } else {
            json!(content)
        };
        self.record_public(path, json!({"content":retained,"contentHash":hash(&snap.bytes),"timestamp":modified(&snap.metadata),"offset":input.get("offset").cloned().unwrap_or_else(crate::js::undefined),"limit":input.get("limit").cloned().unwrap_or_else(crate::js::undefined),"isPartialView":if partial {json!(true)}else{crate::js::undefined()}}));
        success(output, None)
    }
    async fn write(
        &self,
        path: &Path,
        input: &Value,
        ctx: &ToolContext,
        captured: Option<Option<ReadValidation>>,
        exported: &mut ReadExport,
    ) -> crate::error::Result<Value> {
        let harness = &ctx.harness;
        let Some(content) = input["content"].as_str() else {
            return Ok(failure(harness.text(TextId::ToolsFileMissingContent)));
        };
        if content.len() > MAX_BYTES {
            return Ok(failure(size_error().render_for(harness)));
        }
        let state = captured.unwrap_or_else(|| {
            self.reads
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values
                .get(path)
                .map(ReadState::validation)
        });
        let exists = fs::try_exists(path).await.unwrap_or(false);
        if self.track_reads && exists && state.as_ref().map(|s| s.partial).unwrap_or(true) {
            return Ok(failure(harness.text(TextId::ToolsFileCompleteRead)));
        }
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
            if old.as_ref().is_none_or(|s| {
                state.hash != hash(&s.bytes) || state.modified != modified(&s.metadata)
            }) {
                return Ok(failure(harness.text(TextId::ToolsFileChanged)));
            }
        }
        let stat = match write_snapshot(path, content.as_bytes(), old.as_ref()).await {
            Ok(s) => s,
            Err(e) => {
                self.forget(path, exported);
                return Ok(failure(harness.render(
                    TextId::ToolsFileWriteFailed,
                    &[
                        ("path", &path.to_string_lossy()),
                        ("error", &e.render_for(harness)),
                    ],
                )));
            }
        };
        self.record(path, content.as_bytes(), &stat, false).await;
        self.export_read_state(path, exported).await?;
        self.record_change(
            path,
            old.as_ref()
                .map(|snapshot| snapshot.bytes.as_slice())
                .unwrap_or(&[]),
            content.as_bytes(),
            ctx,
        )
        .await?;
        let lines = content.bytes().filter(|b| *b == b'\n').count() + 1;
        let bytes = content.len();
        Ok(success(
            harness.render(
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
            ),
            Some(json!({"file_path":path,"is_new":old.is_none(),"lines":lines,"bytes":bytes})),
        ))
    }
    async fn edit(
        &self,
        path: &Path,
        input: &Value,
        ctx: &ToolContext,
        captured: Option<Option<ReadValidation>>,
        exported: &mut ReadExport,
    ) -> crate::error::Result<Value> {
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
        let state = captured.unwrap_or_else(|| {
            self.reads
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values
                .get(path)
                .map(ReadState::validation)
        });
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
            if state.hash != hash(&snap.bytes)
                || (state.partial && state.modified != modified(&snap.metadata))
            {
                return Ok(failure(harness.text(TextId::ToolsFileChanged)));
            }
        }
        let content = String::from_utf8_lossy(&snap.bytes);
        let count = content.matches(old).count();
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
        let content = content.replacen(old, new, replacements);
        if content.len() > MAX_BYTES {
            return Ok(failure(size_error().render_for(harness)));
        }
        match write_snapshot(path, content.as_bytes(), Some(&snap)).await {
            Ok(_) => {}
            Err(e) => {
                self.forget(path, exported);
                return Ok(failure(harness.render(
                    TextId::ToolsFileWriteFailed,
                    &[
                        ("path", &path.to_string_lossy()),
                        ("error", &e.render_for(harness)),
                    ],
                )));
            }
        };
        self.record_change(path, &snap.bytes, content.as_bytes(), ctx)
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
                Ok(final_snapshot) if final_snapshot.bytes != content.as_bytes() => {
                    self.forget(path, exported);
                    tracing::warn!(file_path = %path.display(), "file changed after edit; read authorization revoked");
                    message.push_str(harness.text(TextId::ToolsFileChangedAfterEdit));
                }
                Ok(final_snapshot) => {
                    self.record_public(path, json!({"content":if state.partial {crate::js::undefined()}else{json!(content)},"contentHash":hash(content.as_bytes()),"timestamp":modified(&final_snapshot.metadata),"isPartialView":state.partial_view}));
                }
                Err(error) => {
                    self.forget(path, exported);
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
mod admission_tests {
    use super::*;
    use std::time::Duration;

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
