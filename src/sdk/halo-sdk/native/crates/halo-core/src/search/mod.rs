use crate::error::{Error, Result};
use crate::harness::TextId;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
};
use tokio_util::sync::CancellationToken;

static POOL: OnceLock<Arc<CodeSearchPool>> = OnceLock::new();
pub fn default_pool() -> Arc<CodeSearchPool> {
    POOL.get_or_init(|| Arc::new(CodeSearchPool::default()))
        .clone()
}
#[derive(Default)]
pub struct CodeSearchPool {
    entry: Mutex<Option<Arc<Entry>>>,
    entries: Mutex<Vec<Weak<Entry>>>,
    activity: Arc<crate::resource_activity::ResourceActivity>,
    closed: AtomicBool,
    next_request: Arc<AtomicU64>,
    lifetime: CancellationToken,
}
impl CodeSearchPool {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_resource_activity(
        activity: Arc<crate::resource_activity::ResourceActivity>,
    ) -> Self {
        let mut pool = Self::default();
        pool.activity = activity;
        pool
    }
    pub fn resource_activity(&self) -> Arc<crate::resource_activity::ResourceActivity> {
        self.activity.clone()
    }
    pub fn diagnostics(&self) -> Value {
        let pool = self.entry.lock().unwrap();
        match pool.as_ref() {
            Some(entry) => {
                json!({"workers":usize::from(entry.worker_active.load(Ordering::Acquire)!=0),"pending":entry.pending.load(Ordering::Acquire),"running":usize::from(entry.running.load(Ordering::Acquire))})
            }
            None => json!({"workers":0,"pending":0,"running":0}),
        }
    }
    pub fn abort_now(&self) {
        self.lifetime.cancel();
        let current = {
            let mut current = self.entry.lock().unwrap();
            self.closed.store(true, Ordering::Release);
            current.take()
        };
        let mut entries: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        if let Some(current) = current {
            if !entries.iter().any(|entry| Arc::ptr_eq(entry, &current)) {
                entries.push(current);
            }
        }
        for entry in entries {
            entry.retired.store(true, Ordering::Release);
            entry.idle_generation.fetch_add(1, Ordering::AcqRel);
            if let Some(idle) = entry.idle.lock().unwrap().take() {
                idle.cancel();
            }
            entry.processes.abort_now();
        }
        self.activity.close();
    }
    pub async fn dispose(&self) {
        self.lifetime.cancel();
        let current = {
            let mut current = self.entry.lock().unwrap();
            self.closed.store(true, Ordering::Release);
            current.take()
        };
        let mut entries: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        if let Some(current) = current {
            if !entries.iter().any(|entry| Arc::ptr_eq(entry, &current)) {
                entries.push(current);
            }
        }
        for entry in entries {
            retire(&entry).await;
        }
        self.entry.lock().unwrap().take();
        self.activity.close();
    }
    pub async fn close(&self) {
        self.dispose().await;
    }
}
impl Drop for CodeSearchPool {
    fn drop(&mut self) {
        self.abort_now();
    }
}
struct Settings {
    value: Value,
    environment: Value,
    idle_ms: u64,
    timeout_ms: u64,
}
struct Worker {
    input: ChildStdin,
    output: tokio::io::Lines<BufReader<ChildStdout>>,
    indexed: bool,
    legacy: bool,
    owned_process: Arc<crate::processes::OwnedProcess>,
    alive: Arc<AtomicBool>,
    requests: Arc<AtomicU64>,
    observer: Option<tokio::task::JoinHandle<()>>,
    owned_error_token: String,
}
struct Entry {
    pool: Weak<CodeSearchPool>,
    key: String,
    root: PathBuf,
    settings: Arc<Settings>,
    owners: Mutex<HashSet<String>>,
    pending: AtomicUsize,
    running: AtomicBool,
    retired: AtomicBool,
    worker: tokio::sync::Mutex<Option<Worker>>,
    serial: tokio::sync::Mutex<()>,
    idle_generation: AtomicU64,
    idle: Mutex<Option<CancellationToken>>,
    previous: tokio::sync::Mutex<Option<Arc<Entry>>>,
    processes: Arc<crate::processes::OwnedProcesses>,
    worker_sequence: AtomicU64,
    worker_active: Arc<AtomicU64>,
}
pub struct CodeSearchService {
    pool: Arc<CodeSearchPool>,
    settings: Arc<Settings>,
    owner: String,
    owned: Mutex<Vec<Arc<Entry>>>,
    lifetime: CancellationToken,
}
fn within(path: &Path, root: &Path) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        Path::new(&path.to_string_lossy().to_lowercase())
            .starts_with(root.to_string_lossy().to_lowercase())
    } else {
        path.starts_with(root)
    }
}
fn real(path: &Path) -> PathBuf {
    let mut head = path.to_path_buf();
    let mut tail = Vec::new();
    loop {
        if let Ok(value) = std::fs::canonicalize(&head) {
            head = value;
            break;
        }
        if let Some(name) = head.file_name() {
            tail.push(name.to_owned());
        } else {
            break;
        }
        if !head.pop() {
            break;
        }
    }
    for name in tail.iter().rev() {
        head.push(name);
    }
    head
}
fn cancelled() -> Error {
    Error::template("cancelled", TextId::ToolsCodeSearchCancelled, &[])
}
fn settings(mut value: Value) -> Result<Settings> {
    if value["backend"] != "zvec-grep" {
        return Err(Error::template(
            "configuration",
            TextId::ToolsCodeSearchUnsupportedBackend,
            &[],
        ));
    }
    for field in ["nodePath", "modulePath", "cachePath"] {
        if !value[field]
            .as_str()
            .is_some_and(|s| !s.is_empty() && Path::new(s).is_absolute())
        {
            return Err(Error::template(
                "configuration",
                TextId::ToolsCodeSearchAbsolutePathRequired,
                &[("field", field.into())],
            ));
        }
    }
    for field in ["workerPath", "supervisorPath"] {
        if value[field]
            .as_str()
            .is_some_and(|s| !s.is_empty() && !Path::new(s).is_absolute())
        {
            return Err(Error::template(
                "configuration",
                TextId::ToolsCodeSearchAbsoluteRequired,
                &[("field", field.into())],
            ));
        }
    }
    let timeout = |field: &str, default: f64| -> Result<u64> {
        let configured = value
            .get(field)
            .filter(|number| !number.is_null() && !crate::js::is_undefined(number));
        let number = configured
            .map(|number| crate::js::number(number).unwrap_or(f64::NAN))
            .unwrap_or(default);
        if !number.is_finite() || number.fract() != 0.0 || number <= 0.0 || number > 900000.0 {
            return Err(Error::template(
                "configuration",
                TextId::ToolsCodeSearchInvalidTimeout,
                &[],
            ));
        }
        Ok(number as u64)
    };
    let idle_ms = timeout("idleTimeoutMs", 30000.0)?;
    let timeout_ms = timeout("timeoutMs", 300000.0)?;
    let mut environment = json!({});
    for name in [
        "PATH",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "TMPDIR",
    ] {
        if let Some(content) = crate::core::conventions::process_value(&value, name) {
            environment[name] = json!(content);
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("nativeProcessEnv");
    }
    Ok(Settings {
        value,
        environment,
        idle_ms,
        timeout_ms,
    })
}
impl CodeSearchService {
    pub fn new(options: Value) -> Result<Self> {
        Self::new_with_pool(options, default_pool())
    }
    pub fn new_with_pool(options: Value, pool: Arc<CodeSearchPool>) -> Result<Self> {
        Ok(Self {
            pool,
            settings: Arc::new(settings(options)?),
            owner: uuid::Uuid::new_v4().to_string(),
            owned: Mutex::new(Vec::new()),
            lifetime: CancellationToken::new(),
        })
    }
    pub async fn search(&self, request: Value, caller: &CancellationToken) -> Result<Value> {
        let result = self.search_inner(request, caller).await;
        if let Err(error) = &result {
            tracing::warn!(reason=%error.code,"Code search did not complete");
        }
        result
    }
    async fn search_inner(&self, request: Value, caller: &CancellationToken) -> Result<Value> {
        if caller.is_cancelled()
            || self.lifetime.is_cancelled()
            || self.pool.lifetime.is_cancelled()
        {
            return Err(cancelled());
        }
        let query = request["query"].as_str().unwrap_or("");
        let limit = request
            .get("limit")
            .filter(|value| !value.is_null() && !crate::js::is_undefined(value))
            .map(|value| crate::js::number(value).unwrap_or(f64::NAN))
            .unwrap_or(5.0);
        let valid_limit = limit.is_finite() && limit.fract() == 0.0;
        let raw_root = request["root"].as_str().unwrap_or("");
        if crate::js::trim_js(query).is_empty()
            || query.encode_utf16().count() > 2000
            || !Path::new(raw_root).is_absolute()
            || !valid_limit
            || limit < 1.0
            || limit > 20.0
            || request
                .get("refresh")
                .is_some_and(|v| !crate::js::is_undefined(v) && !v.is_boolean())
        {
            return Err(Error::template(
                "input",
                TextId::ToolsCodeSearchInvalidQuery,
                &[],
            ));
        }
        let limit = limit as u64;
        let root = tokio::fs::canonicalize(raw_root).await?;
        if !tokio::fs::metadata(&root).await?.is_dir() {
            return Err(Error::template(
                "input",
                TextId::ToolsCodeSearchMissingWorkspace,
                &[],
            ));
        }
        let denied: Vec<_> = request["readDenyRoots"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|s| real(Path::new(s)))
                    .collect()
            })
            .unwrap_or_default();
        if denied.iter().any(|d| within(&root, d) || within(d, &root)) {
            return Err(Error::template(
                "read_denied",
                TextId::ToolsCodeSearchReadDenied,
                &[],
            ));
        }
        let cache = real(Path::new(
            self.settings.value["cachePath"].as_str().unwrap(),
        ));
        if within(&cache, &root) || within(&root, &cache) {
            return Err(Error::template(
                "configuration",
                TextId::ToolsCodeSearchCacheOverlap,
                &[],
            ));
        }
        let mut resolved = self.settings.value.clone();
        for field in [
            "nodePath",
            "modulePath",
            "cachePath",
            "workerPath",
            "supervisorPath",
        ] {
            if let Some(path) = resolved[field].as_str() {
                resolved[field] = json!(real(Path::new(path)));
            }
        }
        let key = json!([
            resolved["nodePath"],
            resolved["modulePath"],
            resolved["cachePath"],
            resolved["workerPath"],
            resolved["supervisorPath"],
            resolved["runAsNode"].as_bool().unwrap_or(false),
            self.settings.environment,
            root
        ])
        .to_string();
        let entry = {
            let mut owned = self.owned.lock().unwrap();
            if caller.is_cancelled()
                || self.lifetime.is_cancelled()
                || self.pool.lifetime.is_cancelled()
            {
                return Err(cancelled());
            }
            let mut pool = self.pool.entry.lock().unwrap();
            if self.pool.closed.load(Ordering::Acquire) {
                return Err(Error::template(
                    "disposed",
                    TextId::ToolsCodeSearchReleased,
                    &[],
                ));
            }
            let entry = match pool.as_ref() {
                Some(entry) if entry.key == key && !entry.retired.load(Ordering::Acquire) => {
                    entry.clone()
                }
                Some(entry) if entry.pending.load(Ordering::Acquire) > 0 => {
                    return Err(Error::template(
                        "capacity",
                        TextId::ToolsCodeSearchBusy,
                        &[],
                    ))
                }
                _ => {
                    let previous = pool.take();
                    if let Some(previous) = &previous {
                        previous.retired.store(true, Ordering::Release);
                    }
                    let entry = Arc::new(Entry {
                        pool: Arc::downgrade(&self.pool),
                        key,
                        root: root.clone(),
                        settings: Arc::new(Settings {
                            value: resolved,
                            environment: self.settings.environment.clone(),
                            idle_ms: self.settings.idle_ms,
                            timeout_ms: self.settings.timeout_ms,
                        }),
                        owners: Mutex::new(HashSet::new()),
                        pending: AtomicUsize::new(0),
                        running: AtomicBool::new(false),
                        retired: AtomicBool::new(false),
                        worker: tokio::sync::Mutex::new(None),
                        serial: tokio::sync::Mutex::new(()),
                        idle_generation: AtomicU64::new(0),
                        idle: Mutex::new(None),
                        previous: tokio::sync::Mutex::new(previous),
                        processes: Arc::new(crate::processes::OwnedProcesses::default()),
                        worker_sequence: AtomicU64::new(0),
                        worker_active: Arc::new(AtomicU64::new(0)),
                    });
                    {
                        let mut entries = self.pool.entries.lock().unwrap();
                        entries.retain(|entry| entry.strong_count() != 0);
                        entries.push(Arc::downgrade(&entry));
                    }
                    *pool = Some(entry.clone());
                    entry
                }
            };
            if entry.pending.load(Ordering::Acquire) >= 32 {
                return Err(Error::template(
                    "capacity",
                    TextId::ToolsCodeSearchQueueLimit,
                    &[],
                ));
            }
            entry.pending.fetch_add(1, Ordering::AcqRel);
            entry.idle_generation.fetch_add(1, Ordering::AcqRel);
            if let Some(idle) = entry.idle.lock().unwrap().take() {
                idle.cancel();
            }
            entry.owners.lock().unwrap().insert(self.owner.clone());
            owned.retain(|e| !e.retired.load(Ordering::Acquire));
            if !owned.iter().any(|e| Arc::ptr_eq(e, &entry)) {
                owned.push(entry.clone());
            }
            entry
        };
        let admitted = Admission {
            entry: entry.clone(),
        };
        let serial = tokio::select! {guard=entry.serial.lock()=>guard,_=caller.cancelled()=>return Err(cancelled()),_=self.lifetime.cancelled()=>return Err(cancelled()),_=self.pool.lifetime.cancelled()=>return Err(cancelled())};
        if entry.retired.load(Ordering::Acquire) {
            return Err(Error::template(
                "disposed",
                TextId::ToolsCodeSearchReleased,
                &[],
            ));
        }
        entry.running.store(true, Ordering::Release);
        if let Some(previous) = entry.previous.lock().await.take() {
            retire(&previous).await;
        }
        let mut worker_activity = Some(self.pool.activity.lease());
        let mut worker = entry.worker.lock().await;
        let future = execute(
            &entry,
            &mut worker,
            query,
            limit,
            request["refresh"] == true,
            &mut worker_activity,
        );
        let result = tokio::select! {result=future=>result,_=caller.cancelled()=>Err(cancelled()),_=self.lifetime.cancelled()=>Err(cancelled()),_=self.pool.lifetime.cancelled()=>Err(cancelled()),_=tokio::time::sleep(Duration::from_millis(entry.settings.timeout_ms))=>Err(Error::template("timeout", TextId::ToolsCodeSearchTimeout, &[]))};
        let observer = if result.is_err() {
            stop_worker(&mut worker, true).await
        } else {
            None
        };
        entry.running.store(false, Ordering::Release);
        drop(worker);
        drop(worker_activity);
        drop(serial);
        if let Some(observer) = observer {
            let _ = observer.await;
        }
        drop(admitted);
        verify(result?, &root, &denied, limit as usize).await
    }
    pub fn prepare_dispose(&self) -> futures::future::BoxFuture<'static, ()> {
        use futures::FutureExt;
        self.lifetime.cancel();
        let entries = std::mem::take(&mut *self.owned.lock().unwrap());
        let mut released = Vec::new();
        for entry in entries {
            let last = {
                let mut owners = entry.owners.lock().unwrap();
                owners.remove(&self.owner);
                owners.is_empty()
            };
            if last {
                entry.retired.store(true, Ordering::Release);
                entry.idle_generation.fetch_add(1, Ordering::AcqRel);
                if let Some(idle) = entry.idle.lock().unwrap().take() {
                    idle.cancel();
                }
                released.push(entry);
            }
        }
        async move {
            futures::future::join_all(
                released
                    .into_iter()
                    .map(|entry| async move { retire(&entry).await }),
            )
            .await;
        }
        .boxed()
    }
    pub fn dispose(&self) -> futures::future::BoxFuture<'static, ()> {
        self.prepare_dispose()
    }
    pub fn abort_now(&self) {
        self.lifetime.cancel();
        let entries = std::mem::take(&mut *self.owned.lock().unwrap());
        for entry in entries {
            let last = {
                let mut owners = entry.owners.lock().unwrap();
                owners.remove(&self.owner);
                owners.is_empty()
            };
            if last {
                entry.retired.store(true, Ordering::Release);
                entry.idle_generation.fetch_add(1, Ordering::AcqRel);
                if let Some(idle) = entry.idle.lock().unwrap().take() {
                    idle.cancel();
                }
                entry.processes.abort_now();
                let mut pool = self.pool.entry.lock().unwrap();
                if pool
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &entry))
                {
                    pool.take();
                }
            }
        }
    }
}
struct Admission {
    entry: Arc<Entry>,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if self.entry.pending.fetch_sub(1, Ordering::AcqRel) == 1 {
            let entry = self.entry.clone();
            if entry.retired.load(Ordering::Acquire) {
                return;
            }
            let generation = entry.idle_generation.fetch_add(1, Ordering::AcqRel) + 1;
            let cancel = CancellationToken::new();
            if let Some(previous) = entry.idle.lock().unwrap().replace(cancel.clone()) {
                previous.cancel();
            }
            crate::runtime::spawn(async move {
                tokio::select! {_=tokio::time::sleep(Duration::from_millis(entry.settings.idle_ms))=>{},_=cancel.cancelled()=>return}
                if entry.pending.load(Ordering::Acquire) == 0
                    && entry.idle_generation.load(Ordering::Acquire) == generation
                {
                    retire(&entry).await;
                }
            });
        }
    }
}
async fn retire(entry: &Arc<Entry>) {
    entry.retired.store(true, Ordering::Release);
    entry.idle_generation.fetch_add(1, Ordering::AcqRel);
    if let Some(idle) = entry.idle.lock().unwrap().take() {
        idle.cancel();
    }
    let mut worker = entry.worker.lock().await;
    let observer = stop_worker(&mut worker, false).await;
    drop(worker);
    if let Some(observer) = observer {
        let _ = observer.await;
    }
    if let Some(owner) = entry.pool.upgrade() {
        let mut pool = owner.entry.lock().unwrap();
        if pool
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            pool.take();
        }
    }
    entry.owners.lock().unwrap().clear();
}
async fn stop_worker(
    worker: &mut Option<Worker>,
    force: bool,
) -> Option<tokio::task::JoinHandle<()>> {
    let Some(mut current) = worker.take() else {
        return None;
    };
    let pid = current.owned_process.id();
    let write = current
        .input
        .write_all(format!("{}\n", json!({"type":"close","force":force})).as_bytes())
        .await;
    if write.is_err() {
        tracing::warn!("Search supervisor shutdown request could not be delivered");
    }
    if tokio::time::timeout(Duration::from_millis(1500), current.owned_process.wait())
        .await
        .is_err()
    {
        tracing::warn!(pid, "Search supervisor shutdown exceeded its grace period");
        current.owned_process.abort_now();
        let _ = current.owned_process.wait().await;
    }
    tracing::info!(pid, "Search worker stopped");
    current.observer.take()
}
async fn read_message(worker: &mut Worker, id: Option<u64>) -> Result<Value> {
    loop {
        let Some(line) = worker.output.next_line().await? else {
            return Err(Error::template(
                "exit",
                TextId::ToolsCodeSearchWorkerExited,
                &[],
            ));
        };
        let value: Value = serde_json::from_str(&line).map_err(|_| {
            Error::template("protocol", TextId::ToolsCodeSearchUnexpectedResponse, &[])
        })?;
        if value["type"] == "error" {
            if value["sdkError"]["token"]==worker.owned_error_token {if let Some(error)=bridge_error(&value["sdkError"]){return Err(error);}}
            return Err(match value["message"].as_str() {
                Some(message) => Error::new("backend", message),
                None => Error::template("backend", TextId::ToolsCodeSearchBackendFailed, &[]),
            });
        }
        if id.is_none() && value["type"] == "ready"
            || id.is_some_and(|id| value["id"] == id) && value["type"] == "result"
        {
            return Ok(value);
        }
    }
}
fn bridge_error(value:&Value)->Option<Error>{
    let id=match value["kind"].as_str()? {
        "close_failed"=>TextId::ToolsCodeSearchBridgeCloseFailed,
        "node_version"=>TextId::ToolsCodeSearchBridgeNodeVersion,
        "missing_factory"=>TextId::ToolsCodeSearchBridgeMissingFactory,
        "invalid_method"=>TextId::ToolsCodeSearchBridgeInvalidMethod,
        "launch_failed"=>TextId::ToolsCodeSearchBridgeLaunchFailed,
        "worker_exited"=>return Some(Error::template("backend",TextId::ToolsCodeSearchBridgeWorkerExited,&[("status",value["status"].as_str().unwrap_or("unknown").into())])),
        "invalid_request"=>TextId::ToolsCodeSearchBridgeInvalidRequest,
        "ipc_closed"=>TextId::ToolsCodeSearchBridgeIpcClosed,
        "failed"=>TextId::ToolsCodeSearchBackendFailed,
        _=>return None,
    };
    Some(Error::template("backend",id,&[]))
}
async fn call(worker: &mut Worker, method: &str, args: Value) -> Result<Value> {
    let id = worker.requests.fetch_add(1, Ordering::AcqRel) + 1;
    let request = json!({"method":method,"id":id,"args":args});
    worker
        .input
        .write_all(format!("{request}\n").as_bytes())
        .await?;
    Ok(read_message(worker, Some(id)).await?["result"].clone())
}
async fn execute(
    entry: &Entry,
    slot: &mut Option<Worker>,
    query: &str,
    limit: u64,
    refresh: bool,
    worker_activity: &mut Option<crate::resource_activity::ResourceLease>,
) -> Result<Value> {
    if slot
        .as_ref()
        .is_some_and(|worker| !worker.alive.load(Ordering::Acquire))
    {
        let _ = stop_worker(slot, true).await;
    }
    if slot.is_none() {
        let settings = &entry.settings.value;
        let cache = PathBuf::from(settings["cachePath"].as_str().unwrap());
        let module = settings["modulePath"].as_str().unwrap();
        let index_name = format!(
            "{:x}",
            Sha256::digest(format!(
                "halo-code-search-v1\0{}\0{module}",
                entry.root.display()
            ))
        );
        let index = cache.join("workspaces").join(index_name);
        tokio::fs::create_dir_all(&index).await?;
        let owned_error_token=uuid::Uuid::new_v4().to_string();
        let mut config = json!({"root":entry.root,"cachePath":cache,"indexPath":index,"modulePath":module,"workerPath":settings["workerPath"],"supervisorPath":settings["supervisorPath"],"adapterSource":include_str!("adapter.cjs"),"ownedErrorToken":owned_error_token});
        let legacy = settings["workerPath"].is_string();
        if settings["supervisorPath"].is_string() && !legacy {
            let bridge_dir = cache.join("bridges");
            tokio::fs::create_dir_all(&bridge_dir).await?;
            let source = include_str!("adapter.cjs")
                .replace("JSON.parse(process.argv[1])", "JSON.parse(process.argv[2])");
            let file = bridge_dir.join(format!(
                "{}.cjs",
                hex::encode(Sha256::digest(source.as_bytes()))
            ));
            tokio::fs::write(&file, source).await?;
            config["workerPath"] = json!(file);
        }
        let mut command = Command::new(settings["nodePath"].as_str().unwrap());
        command
            .args(["-e", include_str!("supervisor.cjs")])
            .arg(config.to_string())
            .current_dir(Path::new(module).parent().unwrap())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        command.envs(crate::core::conventions::merged_environment(
            &entry.settings.environment,
            &[],
            false,
        ));
        command
            .env("HOME", cache.join("home"))
            .env("USERPROFILE", cache.join("home"));
        if settings["runAsNode"] == true {
            command.env("ELECTRON_RUN_AS_NODE", "1");
        }
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| Error::template("launch", TextId::ToolsCodeSearchLaunchFailed, &[]))?;
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        let owned_process = Arc::new(entry.processes.track(child, cfg!(unix)));
        let alive = Arc::new(AtomicBool::new(true));
        let generation = entry.worker_sequence.fetch_add(1, Ordering::AcqRel) + 1;
        entry.worker_active.store(generation, Ordering::Release);
        let observed = owned_process.clone();
        let observed_alive = alive.clone();
        let active = entry.worker_active.clone();
        let lease = worker_activity.take();
        let observer = crate::runtime::spawn(async move {
            let _lease = lease;
            if let Err(error) = observed.wait().await {
                tracing::warn!(error=%error,"Search worker exit could not be observed");
            }
            observed_alive.store(false, Ordering::Release);
            let _ = active.compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire);
        });
        let requests = entry
            .pool
            .upgrade()
            .ok_or_else(|| Error::template("disposed", TextId::ToolsCodeSearchReleased, &[]))?
            .next_request
            .clone();
        *slot = Some(Worker {
            input,
            output,
            indexed: false,
            legacy,
            owned_process,
            alive,
            requests,
            observer: Some(observer),
            owned_error_token,
        });
        let worker = slot.as_mut().unwrap();
        read_message(worker, None).await?;
        tracing::info!(pid = worker.owned_process.id(), "Search worker started");
        if !legacy {
            call(worker,"open",json!({"root":index,"home":cache.join("home"),"modelCacheDir":cache.join("models"),"embedding":"local/potion-code-16m-v2","device":"cpu","embeddingConcurrency":1})).await?;
        }
    }
    let worker = slot.as_mut().unwrap();
    if worker.legacy {
        let id = worker.requests.fetch_add(1, Ordering::AcqRel) + 1;
        let request =
            json!({"type":"search","id":id,"query":query,"limit":limit,"refresh":refresh});
        worker
            .input
            .write_all(format!("{request}\n").as_bytes())
            .await?;
        return Ok(read_message(worker, Some(id)).await?["result"].clone());
    }
    let refreshed = !worker.indexed || refresh;
    if refreshed {
        call(worker,"index",json!({"rootPaths":[{"absolutePath":entry.root,"recursive":true,"follow":false}],"resetPaths":true,"follow":false,"hidden":false,"noIgnore":false,"maxFileSizeBytes":1048576})).await?;
        worker.indexed = true;
    }
    let result = call(
        worker,
        "context",
        json!({"query":query,"limit":limit,"autoUpdate":false,"follow":false}),
    )
    .await?;
    let items = result["items"]
        .as_array()
        .ok_or_else(|| Error::template("backend", TextId::ToolsCodeSearchInvalidCandidates, &[]))?;
    let mut fresh = refreshed;
    let mut hits = Vec::new();
    for item in items.iter().take(limit as usize) {
        if item["range"]["kind"] != "text" {
            return Err(Error::template(
                "backend",
                TextId::ToolsCodeSearchInvalidCandidateText,
                &[],
            ));
        }
        let start = item["range"]["startLine"].as_u64();
        let end = item["range"]["endLine"].as_u64();
        let path = item["file"]["absolutePath"].as_str();
        let content = item["content"].as_str();
        if start.is_none_or(|n| n < 1 || n > 9007199254740991)
            || end.is_none_or(|n| n < start.unwrap_or(1) || n > 9007199254740991)
            || path.is_none()
            || content.is_none()
        {
            return Err(Error::template(
                "backend",
                TextId::ToolsCodeSearchInvalidSource,
                &[],
            ));
        }
        fresh &= item["status"] == "fresh";
        let content = content.unwrap();
        hits.push(json!({"path":path,"lineStart":start,"lineEnd":end,"snippet":crate::tools::utf16_prefix(content,2000),"truncated":content.encode_utf16().count()>2000}));
    }
    Ok(json!({"hits":hits,"freshness":if fresh{"fresh"}else{"possibly_stale"},"exhaustive":false}))
}
async fn verify(mut result: Value, root: &Path, denied: &[PathBuf], limit: usize) -> Result<Value> {
    if result["exhaustive"] != false
        || !["fresh", "possibly_stale"].contains(&result["freshness"].as_str().unwrap_or(""))
        || result["hits"].as_array().is_none_or(|a| a.len() > limit)
    {
        return Err(Error::template(
            "protocol",
            TextId::ToolsCodeSearchInvalidResponse,
            &[],
        ));
    }
    if denied.iter().any(|d| within(root, d) || within(d, root)) {
        return Err(Error::template(
            "read_denied",
            TextId::ToolsCodeSearchRestrictionsChanged,
            &[],
        ));
    }
    for hit in result["hits"].as_array_mut().unwrap() {
        let path = hit["path"].as_str().unwrap_or("");
        let start = hit["lineStart"].as_u64().unwrap_or(0);
        let end = hit["lineEnd"].as_u64().unwrap_or(0);
        if !Path::new(path).is_absolute()
            || !hit["snippet"]
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 2000)
            || start < 1
            || end < start
            || end > 9007199254740991
        {
            return Err(Error::template(
                "protocol",
                TextId::ToolsCodeSearchInvalidCandidate,
                &[],
            ));
        }
        let actual = tokio::fs::canonicalize(path).await.ok();
        if actual
            .as_ref()
            .is_none_or(|p| !within(p, root) || denied.iter().any(|d| within(p, d)) || !p.is_file())
        {
            return Err(Error::template(
                "source_scope",
                TextId::ToolsCodeSearchSourceUnavailable,
                &[],
            ));
        }
        hit["path"] = json!(actual.unwrap());
    }
    Ok(result)
}
pub fn diagnostics() -> Value {
    default_pool().diagnostics()
}

#[cfg(test)]
mod tests;
