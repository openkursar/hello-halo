use crate::harness::{baseline, Harness, ResolvedHarness, TextId};
use crate::{
    bridge::HostBridge,
    collaboration::{
        self,
        journal::FileScopeStore,
        store::{add_member, MemoryStore, ScopeStore},
        workspaces::{
            open_member_workspace, release_member_workspace, remap_denied_roots, MemberWorkspace,
        },
        CollaborationRuntime, CollaborationTools, MemberExecutionRequest, RuntimeOptions,
        SessionExecutor, SourceDelivery, TeamDelivery, TurnCompletion,
    },
    error::{Error, Result},
    session::NativeSession,
    tools::{BorrowedMcp, BorrowedSearch, ToolCheckpoint},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt},
    sync::{mpsc, Mutex as AsyncMutex},
};
use tokio_util::sync::CancellationToken;

const PREFIX: &str = "mcp__halo-team__";
#[derive(Clone)]
struct Retained {
    history: Value,
    tools: ToolCheckpoint,
}
struct Child {
    session: Arc<NativeSession>,
    events: AsyncMutex<mpsc::Receiver<Value>>,
    ready: CancellationToken,
    failed: Mutex<Option<Error>>,
    accepting: AtomicBool,
    live_admission: Mutex<()>,
    consuming: AtomicBool,
    last_used: std::sync::atomic::AtomicU64,
    fingerprint: String,
}
impl Child {
    fn set_accepting(&self, accepting: bool) {
        let _admission = self.live_admission.lock().unwrap();
        self.accepting.store(accepting, Ordering::Release);
    }
    fn harness(&self) -> Arc<ResolvedHarness> {
        self.session
            .tools
            .lock()
            .unwrap()
            .as_ref()
            .map(|tools| tools.resolved_harness())
            .unwrap_or_else(|| {
                self.session
                    .harness
                    .for_model(self.session.options["model"].as_str().unwrap_or(""))
            })
    }
}
pub struct SourceTools {
    pub mcp: Option<BorrowedMcp>,
    pub search: Option<BorrowedSearch>,
    pub read_deny_roots: Vec<String>,
}
pub trait SourceOptionsLease: Send + Sync {}
#[derive(Clone)]
pub struct SourceOptions {
    pub value: Value,
    pub lease: Option<Arc<dyn SourceOptionsLease>>,
}
impl std::ops::Deref for SourceOptions {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.value
    }
}
#[async_trait]
pub trait SourceOwner: Send + Sync {
    fn session_id(&self) -> &str;
    fn resource_activity(&self) -> Option<Arc<crate::resource_activity::ResourceActivity>> {
        None
    }
    fn host_services(&self) -> crate::bridge::HostServices {
        crate::bridge::HostServices::default()
    }
    fn activity_changed(&self, _generation: u64, _active: bool) -> Result<()> {
        Ok(())
    }
    fn options(&self, current: &Value) -> Result<SourceOptions> {
        Ok(SourceOptions {
            value: current.clone(),
            lease: None,
        })
    }
    fn prepare_child_options(&self, options: Value) -> Result<Value> {
        Ok(options)
    }
    fn harness(&self, options: &Value) -> Result<Arc<ResolvedHarness>> {
        Ok(Harness::from_config(&options["harnessText"])?
            .for_model(options["model"].as_str().unwrap_or("")))
    }
    fn inherited_tools(&self, options: &Value) -> Result<SourceTools>;
    fn read_deny_roots(&self, options: &Value) -> Result<Vec<String>>;
    fn register_child(&self, child: Arc<NativeSession>, options: &Value);
    fn unregister_child(&self, session_id: &str);
    fn log(&self, record: Value);
    async fn call_child(
        &self,
        session_id: &str,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value>;
    async fn deliver(&self, envelope: Value, trigger: Value) -> Result<String>;
}
struct SessionOwner {
    session_id: String,
    session: Weak<NativeSession>,
    services: crate::bridge::HostServices,
}
impl SessionOwner {
    fn session(&self) -> Result<Arc<NativeSession>> {
        self.session.upgrade().ok_or_else(Error::cancelled)
    }
}
#[async_trait]
impl SourceOwner for SessionOwner {
    fn session_id(&self) -> &str {
        &self.session_id
    }
    fn resource_activity(&self) -> Option<Arc<crate::resource_activity::ResourceActivity>> {
        self.session
            .upgrade()
            .and_then(|session| session.resource_activity())
    }
    fn host_services(&self) -> crate::bridge::HostServices {
        self.services.clone()
    }
    fn harness(&self, options: &Value) -> Result<Arc<ResolvedHarness>> {
        let session = self.session()?;
        let tools = session.tools.lock().unwrap().clone();
        Ok(tools
            .map(|tools| tools.resolved_harness())
            .unwrap_or_else(|| {
                session
                    .harness
                    .for_model(options["model"].as_str().unwrap_or(""))
            }))
    }
    fn inherited_tools(&self, _options: &Value) -> Result<SourceTools> {
        let session = self.session()?;
        let tools = session
            .tools
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::new("SESSION_NOT_READY", "Source tools are not prepared"))?;
        Ok(SourceTools {
            mcp: Some(tools.borrowed_mcp()),
            search: tools.borrowed_search(),
            read_deny_roots: tools.read_deny_roots(),
        })
    }
    fn read_deny_roots(&self, options: &Value) -> Result<Vec<String>> {
        let session = self.session()?;
        let tools = session.tools.lock().unwrap().clone();
        tools.map_or_else(
            || crate::tools::resolve_read_deny_roots(options),
            |tools| Ok(tools.read_deny_roots()),
        )
    }
    fn register_child(&self, child: Arc<NativeSession>, _options: &Value) {
        if let Some(session) = self.session.upgrade() {
            session.register_child(child);
        }
    }
    fn unregister_child(&self, id: &str) {
        if let Some(session) = self.session.upgrade() {
            session.unregister_child(id);
        }
    }
    fn log(&self, record: Value) {
        if let Some(session) = self.session.upgrade() {
            session.forward_log(record);
        }
    }
    async fn call_child(
        &self,
        _id: &str,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        self.session()?.call(method, params, cancellation).await
    }
    async fn deliver(&self, envelope: Value, _trigger: Value) -> Result<String> {
        let session = self.session()?;
        if session.lifetime.is_cancelled() {
            return Err(Error::new("COLLABORATION_SOURCE", "")
                .with_harness(TextId::CollaborationDeliverySourceClosed, &[]));
        }
        let live = session.is_running();
        if !session.send(
            envelope["body"].clone(),
            uuid::Uuid::new_v4().to_string(),
            true,
        )? {
            return Err(Error::new("COLLABORATION_SOURCE", "")
                .with_harness(TextId::CollaborationDeliverySourceRefused, &[]));
        }
        Ok(if live { "mid_turn" } else { "buffered" }.into())
    }
}
pub struct SdkCollaboration {
    pub budget: Arc<super::execution_budget::ExecutionBudget>,
    owner: Arc<dyn SourceOwner>,
    this: Weak<SdkCollaboration>,
    options: Mutex<Value>,
    settings: Value,
    runtime: AsyncMutex<Option<Arc<CollaborationRuntime>>>,
    runtime_view: Mutex<Weak<CollaborationRuntime>>,
    journal: AsyncMutex<Option<FileScopeStore>>,
    metadata: Mutex<Option<PathBuf>>,
    sessions: Mutex<HashMap<String, Arc<Child>>>,
    checkpoints: Mutex<HashMap<String, Retained>>,
    tool_owners: Mutex<HashMap<String, ToolCheckpoint>>,
    placements: Mutex<HashMap<String, MemberWorkspace>>,
    session_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    workspace_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    executing: Mutex<HashSet<String>>,
    receipts: Mutex<Value>,
    new_request: AtomicBool,
    lifetime: CancellationToken,
    closed: CancellationToken,
    closing: AtomicBool,
    max_idle: usize,
    access_sequence: std::sync::atomic::AtomicU64,
}
struct Executor(Weak<SdkCollaboration>);
struct Source(Weak<SdkCollaboration>);
struct MemberTools {
    owner: Weak<SdkCollaboration>,
    caller: String,
}

fn definitions(harness: &ResolvedHarness) -> Vec<Value> {
    collaboration::tool_contract::definitions_with_harness(harness).into_iter().map(|tool|json!({"name":format!("{PREFIX}{}",tool["name"].as_str().unwrap()),"description":tool["description"],"input_schema":tool["inputSchema"],"mcpSource":{"server":"halo-team","name":tool["name"],"toolDescription":tool["description"]}})).collect()
}
fn readonly(name: &str) -> bool {
    let name = name.strip_prefix(PREFIX).unwrap_or(name);
    matches!(
        name,
        "team_read_board" | "team_read_member" | "team_read_artifact"
    )
}
fn tool_result(result: Value) -> Value {
    let content = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    json!({"content":content,"isError":result["isError"]==true})
}
fn weak_owner(owner: &Weak<SdkCollaboration>) -> Result<Arc<SdkCollaboration>> {
    owner.upgrade().ok_or_else(|| {
        Error::new("closed", "").with_harness(TextId::CollaborationFeedbackClosed, &[])
    })
}
fn policy(options: &Value) -> String {
    if let Some(references) = options.get("nativePolicyReferences") {
        return crate::js::stringify(&json!([
            options["permissionMode"],
            options["allowedTools"],
            options["disallowedTools"],
            options["tools"],
            options["customTools"].as_array().map(|tools| tools
                .iter()
                .map(|tool| tool["name"].clone())
                .collect::<Vec<_>>()),
            options["additionalDirectories"],
            options["systemPrompt"],
            options["toolDiscovery"],
            options["toolResultBudget"],
            options["nativeReadDenyRoots"],
            options["harnessText"],
            references,
        ]));
    }
    crate::js::stringify(&json!([
        options["permissionMode"],
        options["allowedTools"],
        options["disallowedTools"],
        options["tools"],
        options["customTools"],
        options["additionalDirectories"],
        options["systemPrompt"],
        options["toolDiscovery"],
        options["toolResultBudget"],
        options["nativeReadDenyRoots"],
        options["harnessText"],
        options["provider"],
        options["canUseTool"],
        options["hooks"]
    ]))
}
fn lock_for(locks: &Mutex<HashMap<String, Arc<AsyncMutex<()>>>>, id: &str) -> Arc<AsyncMutex<()>> {
    locks
        .lock()
        .unwrap()
        .entry(id.into())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

impl SdkCollaboration {
    pub fn new(owner: Weak<NativeSession>, options: Value, settings: Value) -> Result<Arc<Self>> {
        let session = owner.upgrade().ok_or_else(Error::cancelled)?;
        let session_id = session.session_id.clone();
        let services = session.host_services();
        Self::new_with_source(
            Arc::new(SessionOwner {
                session_id,
                session: owner,
                services,
            }),
            options,
            settings,
        )
    }
    pub fn new_with_source(
        owner: Arc<dyn SourceOwner>,
        options: Value,
        settings: Value,
    ) -> Result<Arc<Self>> {
        let max_idle = settings
            .get("maxIdleSessions")
            .filter(|value| !value.is_null())
            .map_or(10.0, |value| value.as_f64().unwrap_or(f64::NAN));
        if !max_idle.is_finite()
            || max_idle < 0.0
            || max_idle.fract() != 0.0
            || max_idle > 9_007_199_254_740_991.0
        {
            return Err(Error::new(
                "COLLABORATION_ARGUMENTS",
                "maxIdleSessions must be a nonnegative integer",
            ));
        }
        for name in ["maxConcurrentTurns", "maxMembers", "maxRecords", "maxBytes"] {
            if let Some(value) = settings.get(name) {
                let valid = value.as_f64().is_some_and(|v| {
                    v.is_finite() && v >= 1.0 && v.fract() == 0.0 && v <= 9_007_199_254_740_991.0
                });
                if !valid {
                    return Err(Error::new(
                        "COLLABORATION_ARGUMENTS",
                        format!("{name} must be a positive integer"),
                    ));
                }
            }
        }
        Ok(Arc::new_cyclic(|this| Self {
            owner,
            budget: Arc::new(super::execution_budget::ExecutionBudget::new()),
            this: this.clone(),
            options: Mutex::new(options),
            settings,
            runtime: AsyncMutex::new(None),
            runtime_view: Mutex::new(Weak::new()),
            journal: AsyncMutex::new(None),
            metadata: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            checkpoints: Mutex::new(HashMap::new()),
            tool_owners: Mutex::new(HashMap::new()),
            placements: Mutex::new(HashMap::new()),
            session_locks: Mutex::new(HashMap::new()),
            workspace_locks: Mutex::new(HashMap::new()),
            executing: Mutex::new(HashSet::new()),
            receipts: Mutex::new(json!({})),
            new_request: AtomicBool::new(false),
            lifetime: CancellationToken::new(),
            closed: CancellationToken::new(),
            closing: AtomicBool::new(false),
            max_idle: max_idle as usize,
            access_sequence: std::sync::atomic::AtomicU64::new(0),
        }))
    }
    pub fn update_options(&self, options: Value) {
        *self.options.lock().unwrap() = options;
    }
    fn options(&self) -> Result<SourceOptions> {
        let current = self.options.lock().unwrap().clone();
        self.owner.options(&current)
    }
    pub fn active_count(&self) -> usize {
        self.runtime_view
            .lock()
            .unwrap()
            .upgrade()
            .map_or(0, |runtime| runtime.active_count())
    }
    pub fn resident_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
    pub fn retained_count(&self) -> usize {
        self.checkpoints.lock().unwrap().len()
    }
    pub fn revision(&self) -> u64 {
        self.runtime_view
            .lock()
            .unwrap()
            .upgrade()
            .map_or(0, |runtime| runtime.revision())
    }
    pub fn begin_request(&self) {
        self.new_request.store(true, Ordering::SeqCst);
        let runtime = self.runtime_view.lock().unwrap().upgrade();
        if runtime
            .as_ref()
            .is_none_or(|runtime| runtime.begin_request().unwrap_or(false))
        {
            self.new_request.store(false, Ordering::SeqCst);
            self.budget.reset_request();
        }
    }
    pub fn drain_usage(&self) -> Value {
        std::mem::replace(&mut *self.receipts.lock().unwrap(), json!({}))
    }
    pub async fn wait_for_change(&self, after: u64, cancel: &CancellationToken) {
        let runtime = self.runtime_view.lock().unwrap().upgrade();
        if let Some(runtime) = runtime {
            runtime.wait_for_change(after, cancel).await;
        }
    }
    async fn ensure(&self) -> Result<Arc<CollaborationRuntime>> {
        if self.lifetime.is_cancelled() {
            return Err(Error::cancelled());
        }
        let mut ready = self.runtime.lock().await;
        if let Some(runtime) = ready.as_ref() {
            if self.new_request.load(Ordering::SeqCst) && runtime.begin_request()? {
                self.new_request.store(false, Ordering::SeqCst);
                self.budget.reset_request();
            }
            return Ok(runtime.clone());
        }
        let session_id = self.owner.session_id();
        let options = self.options()?;
        let key = hex::encode(Sha256::digest(session_id.as_bytes()));
        let directory = crate::history::transcript_path(session_id, &options)
            .parent()
            .unwrap()
            .join("collaboration")
            .join(&key);
        let max_records = self.settings["maxRecords"].as_u64().unwrap_or(10000) as usize;
        let max_bytes = self.settings["maxBytes"]
            .as_u64()
            .unwrap_or(32 * 1024 * 1024) as usize;
        let store: Arc<dyn ScopeStore> = if options["persistSession"] == false {
            Arc::new(MemoryStore::new(
                key,
                session_id.into(),
                max_records,
                max_bytes,
                None,
            )?)
        } else {
            let file = FileScopeStore::open(
                directory.join("events.jsonl"),
                key,
                session_id.into(),
                max_records,
                max_bytes,
                &self.lifetime,
            )
            .await?;
            let store = file.store.clone();
            *self.journal.lock().await = Some(file);
            *self.metadata.lock().unwrap() = Some(directory.join("workspaces"));
            store
        };
        if self.lifetime.is_cancelled() {
            if let Some(file) = self.journal.lock().await.take() {
                file.close().await?;
            }
            return Err(Error::cancelled());
        }
        let runtime = CollaborationRuntime::new(
            RuntimeOptions {
                store,
                max_concurrent_turns: self.settings["maxConcurrentTurns"].as_u64().unwrap_or(10)
                    as usize,
                max_members: self.settings["maxMembers"].as_u64().unwrap_or(128) as usize,
                idle_timeout_ms: self.settings["idleTimeoutMs"]
                    .as_f64()
                    .map(|v| v.max(0.0) as u64),
                origin: None,
                on_change: Some(Arc::new({
                    let adapter = self.this.clone();
                    move || {
                        if let Some(adapter) = adapter.upgrade() {
                            let runtime = adapter.runtime_view.lock().unwrap().upgrade();
                            if let Some(runtime) = runtime {
                                let (generation, active) = runtime.activity();
                                adapter.owner.activity_changed(generation, active)?;
                            }
                        }
                        Ok(())
                    }
                })),
                harness: self.owner.harness(&options)?,
            },
            Arc::new(Executor(self.this.clone())),
            Arc::new(Source(self.this.clone())),
        )?;
        *self.runtime_view.lock().unwrap() = Arc::downgrade(&runtime);
        *ready = Some(runtime.clone());
        self.new_request.store(false, Ordering::SeqCst);
        Ok(runtime)
    }
    fn name_of(&self, id: &str) -> String {
        self.runtime_view
            .lock()
            .unwrap()
            .upgrade()
            .and_then(|runtime| runtime.store.get("member", id))
            .map(|member| {
                if member["name"] == "lead" {
                    member["id"].as_str().unwrap_or("").into()
                } else {
                    member["name"].as_str().unwrap_or("").into()
                }
            })
            .unwrap_or("lead".into())
    }
    fn lineage(&self, member: &Value, runtime: &CollaborationRuntime) -> Result<Vec<Value>> {
        let mut ancestors = Vec::new();
        let mut current = Some(member.clone());
        let mut seen = HashSet::new();
        while let Some(member) = current {
            let id = member["id"].as_str().unwrap_or("");
            if !seen.insert(id.to_owned()) {
                return Err(Error::new(
                    "COLLABORATION_ANCESTRY",
                    "Collaborator ancestry contains a cycle.",
                ));
            }
            current = runtime
                .store
                .get("member", member["parentId"].as_str().unwrap_or(""));
            ancestors.push(member);
        }
        ancestors.reverse();
        Ok(ancestors)
    }
    async fn workspace(
        &self,
        member: &Value,
        cancel: &CancellationToken,
    ) -> Result<MemberWorkspace> {
        let runtime = self.ensure().await?;
        let options = self.options()?;
        let base = PathBuf::from(options["cwd"].as_str().unwrap_or("."));
        let mut parent = base.clone();
        let additional = options["additionalDirectories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|path| base.join(path))
            .collect::<Vec<_>>();
        let mut result = None;
        for ancestor in self.lineage(member, &runtime)? {
            let id = ancestor["id"].as_str().unwrap_or("");
            let lock = lock_for(&self.workspace_locks, id);
            let _guard = lock.lock().await;
            let existing = self.placements.lock().unwrap().get(id).cloned();
            let workspace = if let Some(existing) = existing {
                existing
            } else {
                let metadata = self.metadata.lock().unwrap().clone();
                match open_member_workspace(
                    &ancestor,
                    &parent,
                    &additional,
                    metadata.as_deref(),
                    cancel,
                )
                .await
                {
                    Ok(placement) => {
                        let mut updated =
                            runtime.store.get("member", id).unwrap_or(ancestor.clone());
                        updated["workingDirectory"] = placement.cwd.clone().into();
                        if let Some(checkout) = &placement.checkout {
                            updated["worktreePath"] = checkout.clone().into();
                        }
                        self.placements
                            .lock()
                            .unwrap()
                            .insert(id.into(), placement.clone());
                        add_member(runtime.store.as_ref(), updated)?;
                        runtime.store.flush().await?;
                        placement
                    }
                    Err(error) => {
                        if error.code == "WORKSPACE_SETUP" {
                            let mut updated =
                                runtime.store.get("member", id).unwrap_or(ancestor.clone());
                            if let Some(checkout) =
                                error.details.as_ref().and_then(|v| v.get("checkout"))
                            {
                                updated["worktreePath"] = checkout.clone();
                                add_member(runtime.store.as_ref(), updated)?;
                                runtime.store.flush().await?;
                            }
                        }
                        return Err(error);
                    }
                }
            };
            parent = workspace.cwd.clone().into();
            result = Some(workspace);
        }
        result.ok_or_else(|| {
            Error::new(
                "COLLABORATION_WORKSPACE",
                "Collaborator workspace has not been prepared.",
            )
        })
    }
    async fn child(&self, member: &Value, cancel: &CancellationToken) -> Result<Arc<Child>> {
        let id = member["id"].as_str().unwrap_or("");
        let lock = lock_for(&self.session_locks, id);
        let _guard = lock.lock().await;
        let base = self.options()?;
        let fingerprint = policy(&base);
        let existing = self.sessions.lock().unwrap().get(id).cloned();
        if let Some(existing) = existing {
            if existing.fingerprint == fingerprint && !existing.session.lifetime.is_cancelled() {
                existing.last_used.store(
                    self.access_sequence.fetch_add(1, Ordering::SeqCst),
                    Ordering::Release,
                );
                return Ok(existing);
            }
            self.retire_locked(id).await?;
        }
        let runtime = self.ensure().await?;
        let model = member["model"]
            .as_str()
            .map(String::from)
            .or_else(|| {
                runtime
                    .store
                    .get("member", member["parentId"].as_str().unwrap_or(""))
                    .and_then(|v| v["model"].as_str().map(String::from))
            })
            .or_else(|| base["model"].as_str().map(String::from))
            .ok_or_else(|| {
                Error::new(
                    "COLLABORATION_MODEL",
                    "The collaborator model has not been configured by its host.",
                )
            })?;
        if member.get("model").is_none() {
            let mut updated = runtime.store.get("member", id).unwrap_or(member.clone());
            updated["model"] = model.clone().into();
            add_member(runtime.store.as_ref(), updated)?;
            runtime.store.flush().await?;
        }
        let placement = self.workspace(member, cancel).await?;
        if cancel.is_cancelled() || self.lifetime.is_cancelled() {
            return Err(Error::new("ABORT_ERR", "")
                .with_harness(TextId::CollaborationFeedbackCreationCancelled, &[]));
        }
        let source_tools = self.owner.inherited_tools(&base)?;
        let mut config = base.value.clone();
        for key in ["resume", "resumeSessionAt", "goal", "nativeCheckpoint"] {
            config.as_object_mut().unwrap().remove(key);
        }
        config["model"] = model.into();
        config["sessionId"] = id.into();
        config["continue"] = false.into();
        config["forkSession"] = false.into();
        config["collaboration"] = json!({"mode":"hosted"});
        config["cwd"] = placement.cwd.clone().into();
        if source_tools.mcp.is_some() {
            config["mcpServers"] = json!({});
        }
        config["additionalDirectories"] = base["additionalDirectories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|path| {
                Value::String(
                    Path::new(base["cwd"].as_str().unwrap_or("."))
                        .join(path)
                        .to_string_lossy()
                        .into_owned(),
                )
            })
            .collect::<Vec<_>>()
            .into();
        let mut denied = base["disallowedTools"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !denied.iter().any(|v| v == "Goal") {
            denied.push("Goal".into());
        }
        config["disallowedTools"] = denied.into();
        let mut floor = source_tools.read_deny_roots;
        for ancestor in self.lineage(member, &runtime)? {
            if let Some(placement) = self
                .placements
                .lock()
                .unwrap()
                .get(ancestor["id"].as_str().unwrap_or(""))
            {
                floor = remap_denied_roots(&floor, placement);
            }
        }
        config["nativeReadDenyRoots"] = floor.into();
        config["nativeCollaborationIdentity"] = json!({"name":member["name"]});
        let checkpoint = self.checkpoints.lock().unwrap().remove(id);
        let working = checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.tools.clone());
        if let Some(checkpoint) = &checkpoint {
            config["nativeCheckpoint"] = checkpoint.history.clone();
            if checkpoint.history.get("messages").is_none() {
                config["resume"] = id.into();
                config["strictResume"] = true.into();
            }
        } else if base["persistSession"] != false
            && fs::try_exists(crate::history::transcript_path(id, &config)).await?
        {
            config["resume"] = id.into();
            config["strictResume"] = true.into();
        }
        let binding = Arc::new(MemberTools {
            owner: self.this.clone(),
            caller: id.into(),
        });
        let config = self.owner.prepare_child_options(config)?;
        let callback_options = config.clone();
        let native = match NativeSession::new_child(
            config,
            binding,
            working,
            source_tools.mcp,
            source_tools.search,
            self.owner.resource_activity(),
            self.owner.host_services(),
        ) {
            Ok(session) => session,
            Err(error) => {
                if let Some(checkpoint) = checkpoint {
                    self.checkpoints
                        .lock()
                        .unwrap()
                        .insert(id.into(), checkpoint);
                }
                return Err(error);
            }
        };
        native.set_execution_budget(self.budget.clone());
        self.owner.register_child(native.clone(), &callback_options);
        let (sender, receiver) = mpsc::channel(256);
        let child = Arc::new(Child {
            session: native,
            events: AsyncMutex::new(receiver),
            ready: CancellationToken::new(),
            failed: Mutex::new(None),
            accepting: AtomicBool::new(false),
            live_admission: Mutex::new(()),
            consuming: AtomicBool::new(false),
            last_used: std::sync::atomic::AtomicU64::new(
                self.access_sequence.fetch_add(1, Ordering::SeqCst),
            ),
            fingerprint,
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(id.into(), child.clone());
        self.start_pump(child.clone(), sender);
        let cancelled =
            tokio::select! {_=cancel.cancelled()=>true,_=child.ready.cancelled()=>false};
        let error = child.failed.lock().unwrap().clone();
        if cancelled || error.is_some() {
            self.sessions.lock().unwrap().remove(id);
            let cleanup = self.close_session(&child).await;
            if let Some(checkpoint) = checkpoint {
                self.checkpoints
                    .lock()
                    .unwrap()
                    .insert(id.into(), checkpoint);
            }
            cleanup?;
            return Err(error.unwrap_or_else(Error::cancelled));
        }
        Ok(child)
    }
    fn start_pump(&self, child: Arc<Child>, sender: mpsc::Sender<Value>) {
        let owner = self.owner.clone();
        crate::runtime::spawn(async move {
            let callbacks: Arc<Mutex<HashMap<String, CancellationToken>>> =
                Arc::new(Mutex::new(HashMap::new()));
            loop {
                let envelope = match child.session.next().await {
                    Ok(Some(envelope)) => envelope,
                    Ok(None) => break,
                    Err(error) => {
                        *child.failed.lock().unwrap() = Some(error);
                        child.ready.cancel();
                        break;
                    }
                };
                match envelope["kind"].as_str() {
                    Some("log") => owner.log(envelope["record"].clone()),
                    Some("ready") => child.ready.cancel(),
                    Some("error") => {
                        let code = envelope["code"]
                            .as_str()
                            .unwrap_or("COLLABORATION_EXECUTION");
                        let error = if let Some(message) = envelope["message"].as_str() {
                            Error::new(code, message)
                        } else {
                            Error::new(code, "")
                                .with_harness(TextId::CollaborationFeedbackExecutionFailed, &[])
                        };
                        *child.failed.lock().unwrap() = Some(error);
                        child.ready.cancel();
                        let _ = sender.send(envelope).await;
                    }
                    Some("callback") => {
                        let id = envelope["id"].as_str().unwrap_or("").to_owned();
                        let method = envelope["method"].as_str().unwrap_or("").to_owned();
                        let mut params = envelope["params"].clone();
                        if method == "tools.execute" {
                            params["context"]["nativeContextId"] = crate::js::stringify(&json!([
                                child.session.session_id,
                                params["context"]["toolUseId"]
                            ]))
                            .into();
                        }
                        let token = CancellationToken::new();
                        callbacks.lock().unwrap().insert(id.clone(), token.clone());
                        let pending = callbacks.clone();
                        let source = owner.clone();
                        let session = child.session.clone();
                        crate::runtime::spawn(async move {
                            let outcome = source
                                .call_child(&session.session_id, &method, params, &token)
                                .await;
                            pending.lock().unwrap().remove(&id);
                            let _ = session.callback_result(&id, outcome);
                        });
                    }
                    Some("callbackCancelled") => {
                        if let Some(token) = callbacks
                            .lock()
                            .unwrap()
                            .remove(envelope["id"].as_str().unwrap_or(""))
                        {
                            token.cancel();
                        }
                    }
                    Some("event") => {
                        let consuming = child.consuming.load(Ordering::Acquire);
                        if consuming {
                            tokio::select! {_=child.session.lifetime.cancelled()=>{},result=sender.send(envelope["event"].clone())=>if result.is_err(){break;}}
                        }
                        if let Some(id) = envelope["eventId"].as_str() {
                            child
                                .session
                                .event_consumed(id, (!consuming).then(Error::cancelled));
                        }
                    }
                    Some("closed") => break,
                    _ => {}
                }
            }
            child.session.output_consumed();
            child.ready.cancel();
            for (_, token) in std::mem::take(&mut *callbacks.lock().unwrap()) {
                token.cancel();
            }
        });
    }
    async fn close_session(&self, child: &Child) -> Result<()> {
        child.set_accepting(false);
        child.consuming.store(false, Ordering::Release);
        child.session.close();
        let settled = CancellationToken::new();
        let done = settled.clone();
        let session = child.session.clone();
        crate::runtime::spawn(async move {
            tokio::select! {_=done.cancelled()=>{},_=tokio::time::sleep(Duration::from_millis(1500))=>session.cancel_end_hooks()}
        });
        let result = child.session.wait_closed().await;
        settled.cancel();
        self.owner.unregister_child(&child.session.session_id);
        result
    }
    async fn retire_locked(&self, id: &str) -> Result<()> {
        let child = self.sessions.lock().unwrap().remove(id);
        let Some(child) = child else { return Ok(()) };
        if !self.lifetime.is_cancelled() {
            let captured = child.session.command("captureCheckpoint", json!([])).await;
            let tools = child.session.tools.lock().unwrap().clone();
            match (captured, tools) {
                (Ok(history), Some(tools)) => {
                    let tools = tools.retire_working_state();
                    self.tool_owners
                        .lock()
                        .unwrap()
                        .insert(id.into(), tools.clone());
                    self.checkpoints
                        .lock()
                        .unwrap()
                        .insert(id.into(), Retained { history, tools });
                }
                (Err(error), _) => {
                    self.sessions.lock().unwrap().insert(id.into(), child);
                    return Err(error);
                }
                (_, None) => {}
            }
        }
        self.close_session(&child).await
    }
    async fn retire(&self, id: &str) -> Result<()> {
        let lock = lock_for(&self.session_locks, id);
        let _guard = lock.lock().await;
        self.retire_locked(id).await
    }
    async fn trim_idle(&self) -> Result<()> {
        let active = self.executing.lock().unwrap().clone();
        let mut idle = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| !active.contains(*id))
            .map(|(id, child)| (id.clone(), child.last_used.load(Ordering::Acquire)))
            .collect::<Vec<_>>();
        idle.sort_by_key(|(_, stamp)| *stamp);
        let extra = idle.len().saturating_sub(self.max_idle);
        for (id, _) in idle.into_iter().take(extra) {
            if !self.executing.lock().unwrap().contains(&id) {
                self.retire(&id).await?;
            }
        }
        Ok(())
    }
    fn receive_usage(&self, event: &Value) {
        let Some(models) = event["modelUsage"].as_object() else {
            return;
        };
        let mut receipts = self.receipts.lock().unwrap();
        for (model, usage) in models {
            if receipts.get(model).is_none() {
                receipts[model] = usage.clone();
            } else {
                for field in [
                    "input_tokens",
                    "output_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                    "total_cost_usd",
                ] {
                    receipts[model][field] = json!(
                        receipts[model][field].as_f64().unwrap_or(0.0)
                            + usage[field].as_f64().unwrap_or(0.0)
                    );
                }
            }
        }
    }
    async fn execute_member(&self, request: MemberExecutionRequest) -> Result<TurnCompletion> {
        let id = request.member["id"].as_str().unwrap_or("").to_owned();
        self.executing.lock().unwrap().insert(id.clone());
        let outcome = self.execute_turn(&request).await;
        self.executing.lock().unwrap().remove(&id);
        if let Err(error) = self.trim_idle().await {
            tracing::warn!(member=%id,code=%error.code,"Collaboration idle session eviction failed");
        }
        outcome
    }
    async fn execute_turn(&self, request: &MemberExecutionRequest) -> Result<TurnCompletion> {
        let child = self.child(&request.member, &request.cancellation).await?;
        let name = request.member["name"].as_str().unwrap_or("");
        let input = collaboration::protocol::render_deliveries_with_harness(
            &request.deliveries,
            name,
            |id| self.name_of(id),
            &child.harness(),
        );
        if request.cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        child.consuming.store(true, Ordering::Release);
        child
            .session
            .send(input.into(), uuid::Uuid::new_v4().to_string(), false)?;
        let finished = CancellationToken::new();
        let done = finished.clone();
        let signal = request.cancellation.clone();
        let native = child.session.clone();
        crate::runtime::spawn(async move {
            tokio::select! { _=done.cancelled()=>{}, _=signal.cancelled()=>native.interrupt() }
        });
        let mut events = child.events.lock().await;
        let execution: Result<TurnCompletion> = async {
            let result = loop {
                child.set_accepting(true);
                (request.ready)();
                child.session.start_stream()?;
                let mut completed = None;
                let result = loop {
                    let event = events.recv().await.ok_or_else(|| {
                        child.failed.lock().unwrap().clone().unwrap_or_else(|| {
                            Error::new("COLLABORATION_EXECUTION", "")
                                .with_harness(TextId::CollaborationFeedbackIncompleteTurn, &[])
                        })
                    })?;
                    if event["kind"] == "error" {
                        return Err(child
                            .failed
                            .lock()
                            .unwrap()
                            .clone()
                            .unwrap_or_else(Error::cancelled));
                    }
                    if event["type"] == "result" {
                        self.receive_usage(&event);
                        completed = Some(event);
                    } else if event["type"] == "system"
                        && event["subtype"] == "session_state_changed"
                        && event["state"] == "idle"
                    {
                        if let Some(result) = completed.take() {
                            break result;
                        }
                    }
                };
                child.set_accepting(false);
                child.session.flush().await?;
                if request.cancellation.is_cancelled()
                    || (!child.session.has_pending_input() && !child.session.is_running())
                {
                    break result;
                }
            };
            if request.cancellation.is_cancelled() {
                return Ok(TurnCompletion::Error {
                    message: child
                        .harness()
                        .text(TextId::CollaborationFeedbackExecutionStopped)
                        .into(),
                });
            }
            if result["subtype"] != "success" {
                return Ok(TurnCompletion::Error {
                    message: child
                        .harness()
                        .text(TextId::CollaborationFeedbackIncompleteTurn)
                        .into(),
                });
            }
            Ok(TurnCompletion::Result {
                content: result["result"].as_str().unwrap_or("").into(),
                task_id: None,
            })
        }
        .await;
        finished.cancel();
        child.set_accepting(false);
        child.consuming.store(false, Ordering::Release);
        execution
    }
    async fn read_member(
        &self,
        id: &str,
        before: Option<u64>,
        harness: &ResolvedHarness,
    ) -> Result<String> {
        let runtime = self.ensure().await?;
        let member = runtime.store.get("member", id).ok_or_else(|| {
            Error::new("COLLABORATION_MEMBER", "")
                .with_harness(TextId::CollaborationFeedbackMemberUnknown, &[])
        })?;
        let placement = self.workspace(&member, &self.lifetime).await?;
        let options = self.options()?;
        if options["persistSession"] == false {
            let child = self.sessions.lock().unwrap().get(id).cloned();
            let messages = if let Some(child) = child {
                child.session.command("readHistory", json!([])).await?
            } else {
                self.checkpoints
                    .lock()
                    .unwrap()
                    .get(id)
                    .map(|v| v.history["messages"].clone())
                    .unwrap_or(json!([]))
            };
            let messages = messages.as_array().cloned().unwrap_or_default();
            let mut cursor = before
                .unwrap_or(messages.len() as u64)
                .min(messages.len() as u64) as usize;
            let mut lines = Vec::new();
            let mut chars = 0;
            while cursor > 0 && chars < 12000 {
                cursor -= 1;
                let message = &messages[cursor];
                let text = visible_text(&message["content"]);
                if text.is_empty() {
                    continue;
                }
                let line = record_line(message["role"].as_str().unwrap_or("user"), &text, harness);
                chars += crate::js::utf16_len(&line);
                lines.insert(0, line);
            }
            return Ok(if lines.is_empty() {
                harness.text(TextId::CollaborationRecordNoMessages).into()
            } else {
                format!(
                    "{}{}",
                    lines.join("\n\n"),
                    if cursor > 0 {
                        harness.render(
                            TextId::CollaborationRecordEarlierMessages,
                            &[("cursor", &cursor.to_string())],
                        )
                    } else {
                        String::new()
                    }
                )
            });
        }
        let child = self.sessions.lock().unwrap().get(id).cloned();
        if let Some(child) = child {
            child.session.flush().await?;
        }
        let mut config = options.value.clone();
        config["cwd"] = placement.cwd.into();
        let path = crate::history::transcript_path(id, &config);
        let mut file = match fs::File::open(&path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(harness
                    .text(TextId::CollaborationRecordNoPersistedRecord)
                    .into())
            }
            Err(error) => return Err(error.into()),
        };
        let size = file.metadata().await?.len();
        let end = before.unwrap_or(size).min(size);
        let start = end.saturating_sub(512 * 1024);
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let mut bytes = vec![0; (end - start) as usize];
        file.read_exact(&mut bytes).await?;
        let mut cursor = start;
        let mut lines = Vec::new();
        let mut chars = 0;
        for (index, raw) in bytes.split(|b| *b == b'\n').enumerate() {
            let record_start = cursor;
            cursor += raw.len() as u64 + 1;
            if start > 0 && index == 0 {
                continue;
            }
            if cursor > end + 1 {
                break;
            }
            let Ok(entry) = serde_json::from_slice::<Value>(raw) else {
                continue;
            };
            if entry["type"] != "assistant" && entry["type"] != "user" {
                continue;
            }
            let text = visible_text(&entry["message"]["content"]);
            if text.is_empty() {
                continue;
            }
            let line = record_line(entry["type"].as_str().unwrap(), &text, harness);
            chars += crate::js::utf16_len(&line);
            lines.push((record_start, line));
            while chars > 12000 && lines.len() > 1 {
                chars -= crate::js::utf16_len(&lines.remove(0).1);
            }
        }
        if lines.is_empty() {
            return Ok(format!(
                "{}{}",
                harness.text(TextId::CollaborationRecordEmptyPage),
                if start > 0 {
                    harness.render(
                        TextId::CollaborationRecordEarlierPage,
                        &[("cursor", &start.to_string())],
                    )
                } else {
                    String::new()
                }
            ));
        }
        Ok(format!(
            "{}{}",
            lines
                .iter()
                .map(|(_, text)| text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
            if lines[0].0 > 0 {
                harness.render(
                    TextId::CollaborationRecordEarlierMessages,
                    &[("cursor", &lines[0].0.to_string())],
                )
            } else {
                String::new()
            }
        ))
    }
    async fn artifact_path(&self, reference: &str, producer: &str) -> Result<(PathBuf, String)> {
        let runtime = self.ensure().await?;
        let member = runtime.store.get("member", producer);
        let options = self.options()?;
        let root = if let Some(member) = &member {
            self.workspace(member, &self.lifetime).await?.cwd
        } else {
            options["cwd"].as_str().unwrap_or(".").into()
        };
        let root = fs::canonicalize(root).await?;
        let prefix = format!("team:{producer}/");
        let relative = reference.strip_prefix(&prefix).unwrap_or(reference);
        if relative.starts_with("team:") {
            return Err(Error::new("artifact_owner", "")
                .with_harness(TextId::CollaborationFeedbackArtifactOwner, &[]));
        }
        let path = fs::canonicalize(root.join(relative)).await?;
        if !path.starts_with(&root) || !fs::metadata(&path).await?.is_file() {
            return Err(Error::new("artifact_scope", "")
                .with_harness(TextId::CollaborationFeedbackArtifactScope, &[]));
        }
        let mut floor = self.owner.read_deny_roots(&options)?;
        if let Some(member) = member {
            for ancestor in self.lineage(&member, &runtime)? {
                if let Some(placement) = self
                    .placements
                    .lock()
                    .unwrap()
                    .get(ancestor["id"].as_str().unwrap_or(""))
                {
                    floor = remap_denied_roots(&floor, placement);
                }
            }
        }
        if floor.iter().any(|root| path.starts_with(root)) {
            return Err(Error::new("artifact_denied", "")
                .with_harness(TextId::CollaborationFeedbackArtifactDenied, &[]));
        }
        let canonical = format!(
            "{prefix}{}",
            path.strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        );
        Ok((path, canonical))
    }
    pub async fn stop_all(&self) -> Result<()> {
        let runtime = self.runtime_view.lock().unwrap().upgrade();
        if let Some(runtime) = runtime {
            if !self.lifetime.is_cancelled() {
                runtime.stop(&runtime.coordinator_id, "all").await?;
            }
        }
        Ok(())
    }
    pub async fn call_server(
        &self,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let options = self.options()?;
        self.call_server_with_harness(name, input, cancel, self.owner.harness(&options)?)
            .await
    }
    pub async fn call_server_with_harness(
        &self,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
        harness: Arc<ResolvedHarness>,
    ) -> Result<Value> {
        let name = name.strip_prefix(PREFIX).unwrap_or(name);
        let input = match collaboration::tool_contract::parse_input(name, &input) {
            Ok(input) => input,
            Err(error) => {
                tracing::warn!(tool = name, "Collaboration arguments rejected");
                return Ok(collaboration::tool_contract::text(
                    error.render_for(&harness),
                    true,
                ));
            }
        };
        if cancel.is_cancelled() {
            return Ok(collaboration::tool_contract::text(
                harness.text(TextId::CollaborationFeedbackCancelled),
                true,
            ));
        }
        let result = async {
            let runtime = self.ensure().await?;
            if cancel.is_cancelled() {
                return Err(Error::cancelled());
            }
            runtime
                .call_with_harness(
                    &runtime.coordinator_id,
                    name,
                    input,
                    cancel,
                    harness.clone(),
                )
                .await
        }
        .await;
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                tracing::warn!(tool=name,code=%error.code,"Collaboration operation failed");
                Ok(collaboration::tool_contract::text(
                    if collaboration::is_refusal(&error) {
                        error.render_for(&harness)
                    } else {
                        harness
                            .text(TextId::CollaborationFeedbackOperationFailed)
                            .into()
                    },
                    true,
                ))
            }
        }
    }
    pub async fn flush(&self) -> Result<()> {
        let runtime = self.runtime.lock().await.clone();
        if let Some(runtime) = runtime {
            runtime.store.flush().await?;
        }
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        if self.closing.swap(true, Ordering::SeqCst) {
            self.closed.cancelled().await;
            return Ok(());
        }
        self.lifetime.cancel();
        let mut failure = None;
        let runtime = self.runtime.lock().await.clone();
        if let Some(runtime) = runtime {
            if let Err(error) = runtime.close().await {
                failure = Some(error);
            }
        }
        let ids = self
            .sessions
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            if let Err(error) = self.retire(&id).await {
                tracing::warn!(member=%id,code=%error.code,"Collaboration child cleanup failed");
                failure.get_or_insert(error);
            }
        }
        let owners = std::mem::take(&mut *self.tool_owners.lock().unwrap());
        for (_, checkpoint) in owners {
            checkpoint.close().await;
        }
        self.checkpoints.lock().unwrap().clear();
        if let Some(file) = self.journal.lock().await.take() {
            if let Err(error) = file.close().await {
                failure.get_or_insert(error);
            }
        }
        let placements = std::mem::take(&mut *self.placements.lock().unwrap());
        let mut placements = placements.into_values().collect::<Vec<_>>();
        placements.sort_by_key(|placement| std::cmp::Reverse(placement.cwd.len()));
        for placement in placements {
            release_member_workspace(&placement).await;
        }
        let result = failure.map_or(Ok(()), Err);
        self.closed.cancel();
        result
    }
    pub fn abort_now(&self) {
        if self.closed.is_cancelled() {
            return;
        }
        self.closing.store(true, Ordering::Release);
        self.lifetime.cancel();
        let runtime = self.runtime_view.lock().unwrap().upgrade();
        if let Some(runtime) = runtime {
            runtime.abort_now();
        }
        let children = std::mem::take(&mut *self.sessions.lock().unwrap());
        for child in children.into_values() {
            child.set_accepting(false);
            child.consuming.store(false, Ordering::Release);
            child.session.cancel_end_hooks();
            child.session.abort_for_host_shutdown();
            self.owner.unregister_child(&child.session.session_id);
        }
        for checkpoint in std::mem::take(&mut *self.checkpoints.lock().unwrap()).into_values() {
            checkpoint.tools.abort_now();
        }
        for tools in std::mem::take(&mut *self.tool_owners.lock().unwrap()).into_values() {
            tools.abort_now();
        }
        if let Ok(mut journal) = self.journal.try_lock() {
            if let Some(journal) = journal.take() {
                journal.abort_now();
            }
        }
        if let Ok(mut runtime) = self.runtime.try_lock() {
            runtime.take();
        }
        *self.runtime_view.lock().unwrap() = Weak::new();
        self.executing.lock().unwrap().clear();
        self.placements.lock().unwrap().clear();
        self.session_locks.lock().unwrap().clear();
        self.workspace_locks.lock().unwrap().clear();
        self.closed.cancel();
    }
}
fn visible_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.into();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
fn record_line(role: &str, text: &str, harness: &ResolvedHarness) -> String {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let message = if units.len() > 8000 {
        harness.render(
            TextId::CollaborationRecordTruncatedMessage,
            &[(
                "message",
                &String::from_utf16_lossy(&units[units.len() - 8000..]),
            )],
        )
    } else {
        text.into()
    };
    harness.render(
        TextId::CollaborationRecordLine,
        &[("role", role), ("message", &message)],
    )
}

#[async_trait]
impl CollaborationTools for SdkCollaboration {
    fn definitions(&self) -> Vec<Value> {
        definitions(&baseline())
    }
    fn definitions_with_harness(&self, harness: &ResolvedHarness) -> Vec<Value> {
        definitions(harness)
    }
    fn is_readonly(&self, name: &str) -> bool {
        readonly(name)
    }
    async fn call(&self, name: &str, input: Value, cancel: &CancellationToken) -> Result<Value> {
        self.call_server(name, input, cancel).await.map(tool_result)
    }
    async fn call_with_harness(
        &self,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
        harness: Arc<ResolvedHarness>,
    ) -> Result<Value> {
        self.call_server_with_harness(name, input, cancel, harness)
            .await
            .map(tool_result)
    }
}
#[async_trait]
impl CollaborationTools for MemberTools {
    fn inherited(&self) -> bool {
        true
    }
    fn definitions(&self) -> Vec<Value> {
        definitions(&baseline())
    }
    fn definitions_with_harness(&self, harness: &ResolvedHarness) -> Vec<Value> {
        definitions(harness)
    }
    fn is_readonly(&self, name: &str) -> bool {
        readonly(name)
    }
    async fn call(&self, name: &str, input: Value, cancel: &CancellationToken) -> Result<Value> {
        self.call_with_harness(name, input, cancel, baseline())
            .await
    }
    async fn call_with_harness(
        &self,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
        harness: Arc<ResolvedHarness>,
    ) -> Result<Value> {
        let owner = weak_owner(&self.owner)?;
        let runtime = owner.ensure().await?;
        runtime
            .call_with_harness(
                &self.caller,
                name.strip_prefix(PREFIX).unwrap_or(name),
                input,
                cancel,
                harness,
            )
            .await
            .map(tool_result)
    }
}
#[async_trait]
impl SourceDelivery for Source {
    fn harness(&self) -> Result<Option<Arc<ResolvedHarness>>> {
        let owner = weak_owner(&self.0)?;
        let options = owner.options()?;
        owner.owner.harness(&options).map(Some)
    }
    async fn deliver(&self, mut envelope: Value, trigger: Value) -> Result<String> {
        let owner = weak_owner(&self.0)?;
        let options = owner.options()?;
        let harness = owner.owner.harness(&options)?;
        if let Some(from) = envelope["fromAppId"].as_str() {
            envelope["body"] = harness
                .render(
                    TextId::CollaborationDeliverySourceMessage,
                    &[
                        ("name", &owner.name_of(from)),
                        ("message", envelope["body"].as_str().unwrap_or("")),
                    ],
                )
                .into();
        }
        owner.owner.deliver(envelope, trigger).await
    }
}
#[async_trait]
impl SessionExecutor for Executor {
    async fn execute(&self, request: MemberExecutionRequest) -> Result<TurnCompletion> {
        weak_owner(&self.0)?.execute_member(request).await
    }
    fn inject(&self, id: &str, deliveries: &[TeamDelivery]) -> bool {
        let Some(owner) = self.0.upgrade() else {
            return false;
        };
        let child = owner.sessions.lock().unwrap().get(id).cloned();
        let Some(child) = child else { return false };
        if !child.accepting.load(Ordering::Acquire) {
            return false;
        }
        let runtime = owner.runtime_view.lock().unwrap().upgrade();
        let Some(member) = runtime.and_then(|runtime| runtime.store.get("member", id)) else {
            return false;
        };
        let text = collaboration::protocol::render_deliveries_with_harness(
            deliveries,
            member["name"].as_str().unwrap_or(""),
            |id| owner.name_of(id),
            &child.harness(),
        );
        let _admission = child.live_admission.lock().unwrap();
        if !child.accepting.load(Ordering::Acquire) {
            return false;
        }
        child
            .session
            .send(text.into(), uuid::Uuid::new_v4().to_string(), true)
            .unwrap_or(false)
    }
    async fn interrupt(&self, id: &str) -> Result<bool> {
        let owner = weak_owner(&self.0)?;
        let child = owner.sessions.lock().unwrap().get(id).cloned();
        if let Some(child) = child {
            child.set_accepting(false);
            child.session.interrupt();
            let tools = child.session.tools.lock().unwrap().clone();
            if let Some(tools) = tools {
                tools.interrupt().await;
            }
            Ok(true)
        } else {
            let checkpoint = owner.tool_owners.lock().unwrap().get(id).cloned();
            if let Some(checkpoint) = checkpoint {
                checkpoint.interrupt().await;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }
    async fn release(&self, id: &str) -> Result<()> {
        weak_owner(&self.0)?.retire(id).await
    }
    async fn read_member(&self, id: &str, before: Option<u64>) -> Result<String> {
        weak_owner(&self.0)?
            .read_member(id, before, &baseline())
            .await
    }
    async fn read_member_with_harness(
        &self,
        id: &str,
        before: Option<u64>,
        harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        weak_owner(&self.0)?.read_member(id, before, &harness).await
    }
    async fn validate_artifact(&self, reference: &str, producer: &str) -> Result<String> {
        let owner = weak_owner(&self.0)?;
        let (_, canonical) = owner.artifact_path(reference, producer).await?;
        let runtime = owner.ensure().await?;
        let published = collaboration::artifacts::resolve_published(
            &runtime.store.rows("finding"),
            &runtime.store.rows("task"),
            &canonical,
        );
        if published["kind"] == "ambiguous"
            || (published["kind"] == "unique" && published["authorAppId"] != producer)
        {
            return Err(Error::new("artifact_conflict", "")
                .with_harness(TextId::CollaborationFeedbackArtifactConflict, &[]));
        }
        Ok(canonical)
    }
    async fn read_artifact(&self, reference: &str, requester: &str) -> Result<String> {
        self.read_artifact_with_harness(reference, requester, baseline())
            .await
    }
    async fn read_artifact_with_harness(
        &self,
        reference: &str,
        _requester: &str,
        harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        let owner = weak_owner(&self.0)?;
        let runtime = owner.ensure().await?;
        let published = collaboration::artifacts::resolve_published(
            &runtime.store.rows("finding"),
            &runtime.store.rows("task"),
            reference,
        );
        if published["kind"] != "unique" {
            return Err(Error::new("artifact_unavailable", "")
                .with_harness(TextId::CollaborationFeedbackArtifactUnavailable, &[]));
        }
        let (path, _) = owner
            .artifact_path(reference, published["authorAppId"].as_str().unwrap_or(""))
            .await?;
        let mut file = fs::File::open(path).await?;
        let size = file.metadata().await?.len();
        let mut bytes = vec![0; size.min(256 * 1024) as usize];
        let read = file.read(&mut bytes).await?;
        bytes.truncate(read);
        Ok(format!(
            "{}{}",
            String::from_utf8_lossy(&bytes),
            if size > read as u64 {
                harness.render(
                    TextId::CollaborationArtifactTruncated,
                    &[("read", &read.to_string()), ("total", &size.to_string())],
                )
            } else {
                String::new()
            }
        ))
    }
}
