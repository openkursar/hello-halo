use super::{
    board_pages::BoardPages,
    protocol,
    store::{self, ScopeStore},
    tool_contract,
};
use crate::error::{Error, Result};
use crate::harness::{ResolvedHarness, TextId};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Notify, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TeamDelivery {
    pub envelope: Value,
    pub trigger: Value,
    #[serde(flatten)]
    pub metadata: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnCompletion {
    Result {
        content: String,
        #[serde(rename = "taskId", skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
    },
    Escalation {
        content: String,
    },
    Error {
        message: String,
    },
    Timeout,
    Undelivered {
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::store::MemoryStore;
    use tokio::sync::mpsc;

    struct Executor {
        started: mpsc::UnboundedSender<(String, Vec<TeamDelivery>)>,
        inputs: Mutex<Vec<TeamDelivery>>,
        release: Notify,
        canceled: Mutex<HashSet<String>>,
        accepts: std::sync::atomic::AtomicBool,
        validation: Mutex<Option<Arc<Notify>>>,
        validation_started: Notify,
    }
    #[async_trait]
    impl SessionExecutor for Executor {
        async fn execute(&self, request: MemberExecutionRequest) -> Result<TurnCompletion> {
            (request.ready)();
            self.started
                .send((
                    request.member["id"].as_str().unwrap().into(),
                    request.deliveries,
                ))
                .unwrap();
            tokio::select! {_=request.cancellation.cancelled()=>Ok(TurnCompletion::Error{message:"Execution was stopped.".into()}),_=self.release.notified()=>Ok(TurnCompletion::Result{content:"actual fixture result".into(),task_id:None})}
        }
        fn inject(&self, _id: &str, deliveries: &[TeamDelivery]) -> bool {
            if !self.accepts.load(std::sync::atomic::Ordering::SeqCst) {
                return false;
            }
            self.inputs.lock().unwrap().extend_from_slice(deliveries);
            true
        }
        async fn interrupt(&self, id: &str) -> Result<bool> {
            self.canceled.lock().unwrap().insert(id.into());
            Ok(true)
        }
        async fn release(&self, _id: &str) -> Result<()> {
            Ok(())
        }
        async fn read_member(&self, _id: &str, _before: Option<u64>) -> Result<String> {
            Ok("member record".into())
        }
        async fn read_artifact(&self, _reference: &str, _requester: &str) -> Result<String> {
            Ok("artifact".into())
        }
        async fn validate_artifact(&self, reference: &str, _producer: &str) -> Result<String> {
            let validation = self.validation.lock().unwrap().clone();
            self.validation_started.notify_one();
            if let Some(validation) = validation {
                validation.notified().await;
            }
            Ok(reference.into())
        }
    }
    struct Source(Mutex<Vec<Value>>);
    #[async_trait]
    impl SourceDelivery for Source {
        async fn deliver(&self, envelope: Value, _trigger: Value) -> Result<String> {
            self.0.lock().unwrap().push(envelope);
            Ok("mid_turn".into())
        }
    }
    fn runtime() -> (
        Arc<CollaborationRuntime>,
        Arc<Executor>,
        Arc<Source>,
        mpsc::UnboundedReceiver<(String, Vec<TeamDelivery>)>,
    ) {
        let (started, receiver) = mpsc::unbounded_channel();
        let executor = Arc::new(Executor {
            started,
            inputs: Mutex::new(Vec::new()),
            release: Notify::new(),
            canceled: Mutex::new(HashSet::new()),
            accepts: std::sync::atomic::AtomicBool::new(true),
            validation: Mutex::new(None),
            validation_started: Notify::new(),
        });
        let source = Arc::new(Source(Mutex::new(Vec::new())));
        let store =
            Arc::new(MemoryStore::new("team".into(), "epoch".into(), 100, 100000, None).unwrap());
        let runtime = CollaborationRuntime::new(
            RuntimeOptions {
                store,
                max_concurrent_turns: 1,
                max_members: 2,
                idle_timeout_ms: Some(10000),
                origin: None,
                on_change: None,
                harness: crate::harness::baseline(),
            },
            executor.clone(),
            source.clone(),
        )
        .unwrap();
        (runtime, executor, source, receiver)
    }
    #[tokio::test]
    async fn dispatch_live_messages_and_reports_keep_separate_ownership() {
        let (runtime, executor, source, mut started) = runtime();
        let cancel = CancellationToken::new();
        let result = runtime
            .call(
                &runtime.coordinator_id,
                "spawn_agent",
                json!({"name":"worker","prompt":"read evidence"}),
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"],"Collaborator created: worker. The assignment was accepted; replies arrive asynchronously.");
        let (id, deliveries) = tokio::time::timeout(Duration::from_secs(2), started.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(deliveries[0].envelope["body"], "read evidence");
        assert_eq!(runtime.active_count(), 1);
        let sent: Value = serde_json::from_str(
            &runtime
                .send(&runtime.coordinator_id, "worker", "new evidence", &cancel)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(sent["delivery"], "mid_turn");
        assert_eq!(
            executor.inputs.lock().unwrap()[0].envelope["body"],
            "new evidence"
        );
        runtime
            .send(&id, "lead", "explicit reply", &cancel)
            .await
            .unwrap();
        assert_eq!(source.0.lock().unwrap()[0]["body"], "explicit reply");
        executor.release.notify_one();
        loop {
            let revision = runtime.revision();
            if runtime.active_count() == 0 {
                break;
            }
            runtime.wait_for_change(revision, &cancel).await;
        }
        assert!(source
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["body"].as_str().unwrap().contains(
                "This is an execution fact, not a completion claim or a delivered reply."
            )));
        runtime.close().await.unwrap();
    }
    #[tokio::test]
    async fn nested_creation_shares_budget_and_stop_cannot_mark_done() {
        let (runtime, executor, _source, mut started) = runtime();
        let cancel = CancellationToken::new();
        runtime
            .spawn(
                &runtime.coordinator_id,
                json!({"name":"worker","prompt":"work"}),
                &cancel,
            )
            .await
            .unwrap();
        let (id, _) = started.recv().await.unwrap();
        runtime
            .spawn(&id, json!({"name":"child","prompt":"child work"}), &cancel)
            .await
            .unwrap();
        let rejected = runtime
            .spawn(&id, json!({"prompt":"third"}), &cancel)
            .await
            .unwrap_err();
        assert_eq!(rejected.code, "member_limit");
        let stopped: Value =
            serde_json::from_str(&runtime.stop(&runtime.coordinator_id, "all").await.unwrap())
                .unwrap();
        assert_eq!(stopped.as_array().unwrap().len(), 2);
        assert!(runtime
            .store
            .rows("member")
            .iter()
            .all(|v| v["state"] == "stopped"));
        assert!(executor.canceled.lock().unwrap().contains(&id));
        assert_eq!(
            runtime
                .send(&id, "lead", "must fail", &cancel)
                .await
                .unwrap_err()
                .code,
            "caller_stopped"
        );
        runtime.close().await.unwrap();
    }
    async fn quiescent(runtime: &CollaborationRuntime, cancel: &CancellationToken) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let revision = runtime.revision();
                if runtime.active_count() == 0 {
                    break;
                }
                runtime.wait_for_change(revision, cancel).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn stopped_pending_messages_do_not_return_with_explicit_continuation() {
        let (runtime, executor, _source, mut started) = runtime();
        let cancel = CancellationToken::new();
        runtime
            .spawn(
                &runtime.coordinator_id,
                json!({"name":"reader","prompt":"First assignment."}),
                &cancel,
            )
            .await
            .unwrap();
        let (id, _) = started.recv().await.unwrap();
        executor
            .accepts
            .store(false, std::sync::atomic::Ordering::SeqCst);
        runtime
            .send(
                &runtime.coordinator_id,
                "reader",
                "OBSOLETE_PENDING_REQUEST",
                &cancel,
            )
            .await
            .unwrap();
        runtime
            .stop(&runtime.coordinator_id, "reader")
            .await
            .unwrap();
        quiescent(&runtime, &cancel).await;
        runtime
            .send(
                &runtime.coordinator_id,
                "reader",
                "NEW_EXPLICIT_REQUEST",
                &cancel,
            )
            .await
            .unwrap();
        let (next_id, deliveries) = tokio::time::timeout(Duration::from_secs(2), started.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next_id, id);
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].envelope["body"], "NEW_EXPLICIT_REQUEST");
        runtime.close().await.unwrap();
    }
    #[tokio::test]
    async fn resumed_member_cannot_commit_publication_admitted_before_stop() {
        let (runtime, executor, _source, mut started) = runtime();
        let cancel = CancellationToken::new();
        runtime
            .spawn(
                &runtime.coordinator_id,
                json!({"name":"reader","prompt":"work"}),
                &cancel,
            )
            .await
            .unwrap();
        let (id, _) = started.recv().await.unwrap();
        let validation = Arc::new(Notify::new());
        *executor.validation.lock().unwrap() = Some(validation.clone());
        let owner = runtime.clone();
        let token = cancel.clone();
        let publishing = crate::runtime::spawn(async move {
            owner
                .call(&id, "team_post_finding", json!({"ref":"report.md"}), &token)
                .await
        });
        executor.validation_started.notified().await;
        runtime
            .stop(&runtime.coordinator_id, "reader")
            .await
            .unwrap();
        quiescent(&runtime, &cancel).await;
        runtime
            .send(&runtime.coordinator_id, "reader", "new work", &cancel)
            .await
            .unwrap();
        started.recv().await.unwrap();
        validation.notify_one();
        assert_eq!(publishing.await.unwrap().unwrap()["isError"], true);
        assert!(runtime.store.rows("finding").is_empty());
        runtime.close().await.unwrap();
    }
}
impl TurnCompletion {
    pub fn kind(&self) -> &str {
        match self {
            Self::Result { .. } => "result",
            Self::Escalation { .. } => "escalation",
            Self::Error { .. } => "error",
            Self::Timeout => "timeout",
            Self::Undelivered { .. } => "undelivered",
        }
    }
}

pub struct MemberExecutionRequest {
    pub member: Value,
    pub deliveries: Vec<TeamDelivery>,
    pub cancellation: CancellationToken,
    pub ready: Arc<dyn Fn() + Send + Sync>,
    pub collaboration: Weak<CollaborationRuntime>,
}

#[async_trait]
pub trait SessionExecutor: Send + Sync {
    async fn execute(&self, request: MemberExecutionRequest) -> Result<TurnCompletion>;
    fn inject(&self, member_id: &str, deliveries: &[TeamDelivery]) -> bool;
    fn try_inject(&self, member_id: &str, deliveries: &[TeamDelivery]) -> Result<bool> {
        Ok(self.inject(member_id, deliveries))
    }
    async fn interrupt(&self, member_id: &str) -> Result<bool>;
    async fn release(&self, member_id: &str) -> Result<()>;
    async fn read_member(&self, member_id: &str, before: Option<u64>) -> Result<String>;
    async fn read_artifact(&self, reference: &str, requester_id: &str) -> Result<String>;
    async fn validate_artifact(&self, reference: &str, producer_id: &str) -> Result<String>;
    async fn read_member_with_harness(
        &self,
        member: &str,
        before: Option<u64>,
        _harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        self.read_member(member, before).await
    }
    async fn read_artifact_with_harness(
        &self,
        reference: &str,
        requester: &str,
        _harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        self.read_artifact(reference, requester).await
    }
    async fn validate_artifact_with_harness(
        &self,
        reference: &str,
        producer: &str,
        _harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        self.validate_artifact(reference, producer).await
    }
}
#[async_trait]
pub trait SourceDelivery: Send + Sync {
    async fn deliver(&self, envelope: Value, trigger: Value) -> Result<String>;
    fn harness(&self) -> Result<Option<Arc<ResolvedHarness>>> {
        Ok(None)
    }
}

pub struct RuntimeOptions {
    pub store: Arc<dyn ScopeStore>,
    pub max_concurrent_turns: usize,
    pub max_members: usize,
    pub idle_timeout_ms: Option<u64>,
    pub origin: Option<String>,
    pub on_change: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>>,
    pub harness: Arc<ResolvedHarness>,
}

struct Active {
    cancellation: CancellationToken,
    trigger: Value,
    ready: bool,
}
struct State {
    active: HashMap<String, Active>,
    idle: HashMap<String, CancellationToken>,
    resident: HashSet<String>,
    retiring: HashMap<String, CancellationToken>,
    allocating: HashSet<String>,
    stop_versions: HashMap<String, u64>,
    stop_version: u64,
    closed: bool,
    revision: u64,
    created: usize,
    executions: usize,
    activity_generation: u64,
}

pub struct CollaborationRuntime {
    pub coordinator_id: String,
    pub store: Arc<dyn ScopeStore>,
    pub bus: Arc<super::message_bus::MessageBus>,
    executor: Arc<dyn SessionExecutor>,
    source: Arc<dyn SourceDelivery>,
    options: RuntimeOptions,
    state: Mutex<State>,
    creation: AsyncMutex<()>,
    permits: Arc<Semaphore>,
    changed: Notify,
    board: Mutex<BoardPages>,
    lifetime: CancellationToken,
    close_complete: CancellationToken,
}

struct RuntimeStore(Weak<CollaborationRuntime>);
impl super::message_bus::MessageBusStore for RuntimeStore {
    fn member(&self, team: &str, id: &str, epoch: Option<&str>) -> Option<Value> {
        self.try_member(team, id, epoch).ok().flatten()
    }
    fn member_by_name(&self, team: &str, name: &str, epoch: Option<&str>) -> Option<Value> {
        self.try_member_by_name(team, name, epoch).ok().flatten()
    }
    fn members(&self, team: &str, epoch: Option<&str>) -> Vec<Value> {
        self.try_members(team, epoch).unwrap_or_default()
    }
    fn try_member(&self, team: &str, id: &str, _epoch: Option<&str>) -> Result<Option<Value>> {
        let Some(runtime) = self.0.upgrade() else {
            return Ok(None);
        };
        if team != runtime.store.team_id() || runtime.state.lock().unwrap().allocating.contains(id)
        {
            return Ok(None);
        }
        if id == runtime.coordinator_id {
            return Ok(Some(
                json!({"appId":id,"memberName":"lead","origin":"local"}),
            ));
        }
        Ok(runtime.store.try_get("member", id)?.map(
            |member| json!({"appId":member["id"],"memberName":member["name"],"origin":"local"}),
        ))
    }
    fn try_member_by_name(
        &self,
        team: &str,
        name: &str,
        epoch: Option<&str>,
    ) -> Result<Option<Value>> {
        let Some(runtime) = self.0.upgrade() else {
            return Ok(None);
        };
        if team != runtime.store.team_id() {
            return Ok(None);
        }
        if name == "lead" {
            return self.try_member(team, &runtime.coordinator_id, epoch);
        }
        let Some(member) = runtime.store.try_find_member(name)? else {
            return Ok(None);
        };
        self.try_member(team, member["id"].as_str().unwrap_or(""), epoch)
    }
    fn try_members(&self, team: &str, _epoch: Option<&str>) -> Result<Vec<Value>> {
        let Some(runtime) = self.0.upgrade() else {
            return Ok(Vec::new());
        };
        if team != runtime.store.team_id() {
            return Ok(Vec::new());
        }
        let members = runtime.store.try_rows("member")?;
        let allocating = runtime.state.lock().unwrap().allocating.clone();
        let mut result =
            vec![json!({"appId":runtime.coordinator_id,"memberName":"lead","origin":"local"})];
        result.extend(members.into_iter().filter(|member| !allocating.contains(member["id"].as_str().unwrap_or(""))).map(|member| json!({"appId":member["id"],"memberName":member["name"],"origin":"local"})));
        Ok(result)
    }
    fn edge_allowed(&self, team: &str, _from: &str, _to: &str, _epoch: Option<&str>) -> bool {
        self.0
            .upgrade()
            .is_some_and(|runtime| runtime.store.team_id() == team)
    }
    fn team(&self, team: &str) -> Option<Value> {
        let runtime = self.0.upgrade()?;
        (team == runtime.store.team_id() && !runtime.state.lock().unwrap().closed)
            .then(|| json!({"leadAppId":runtime.coordinator_id}))
    }
    fn epoch(&self, epoch: &str) -> Option<Value> {
        let runtime = self.0.upgrade()?;
        (epoch == runtime.store.epoch_id()).then(|| json!({"endedAt":if runtime.state.lock().unwrap().closed{Value::from(protocol::now())}else{Value::Null}}))
    }
}

struct RuntimeDelivery(Weak<CollaborationRuntime>);
#[async_trait]
impl super::message_bus::DeliveryHooks for RuntimeDelivery {
    async fn wake_target(&self, request: Value) -> Result<()> {
        let runtime = self.0.upgrade().ok_or_else(|| {
            Error::new("closed", "").with_harness(TextId::CollaborationFeedbackClosed, &[])
        })?;
        let deliveries = serde_json::from_value(request["deliveries"].clone())?;
        runtime.start(request["appId"].as_str().unwrap_or(""), deliveries)
    }
    fn is_busy(&self, key: &str) -> bool {
        let Some(runtime) = self.0.upgrade() else {
            return false;
        };
        let parsed = protocol::parse_session_key(key);
        let id = parsed
            .as_ref()
            .and_then(|v| v["appId"].as_str())
            .unwrap_or("");
        let busy = runtime.state.lock().unwrap().active.contains_key(id);
        busy
    }
    fn turn_identity(&self, key: &str) -> Option<String> {
        let runtime = self.0.upgrade()?;
        let parsed = protocol::parse_session_key(key)?;
        let id = parsed["appId"].as_str()?;
        let state = runtime.state.lock().unwrap();
        state
            .active
            .get(id)
            .map(|active| active.trigger["origin"].as_str().unwrap_or("owner").into())
    }
    fn deliver_mid_turn(&self, request: Value) -> Result<bool> {
        let Some(runtime) = self.0.upgrade() else {
            return Ok(false);
        };
        let id = request["appId"].as_str().unwrap_or("");
        let accepting = runtime
            .state
            .lock()
            .unwrap()
            .active
            .get(id)
            .is_some_and(|active| active.ready && !active.cancellation.is_cancelled());
        if !accepting {
            return Ok(false);
        }
        let deliveries =
            serde_json::from_value::<Vec<TeamDelivery>>(request["deliveries"].clone())?;
        runtime.executor.try_inject(id, &deliveries)
    }
    async fn deliver_to_coordinator(&self, request: Value) -> Result<Option<String>> {
        let runtime = self.0.upgrade().ok_or_else(|| {
            Error::new("closed", "").with_harness(TextId::CollaborationFeedbackClosed, &[])
        })?;
        runtime
            .source
            .deliver(request["envelope"].clone(), request["trigger"].clone())
            .await
            .map(Some)
    }
}

impl CollaborationRuntime {
    pub fn new(
        options: RuntimeOptions,
        executor: Arc<dyn SessionExecutor>,
        source: Arc<dyn SourceDelivery>,
    ) -> Result<Arc<Self>> {
        for (name, value) in [
            ("maxConcurrentTurns", options.max_concurrent_turns),
            ("maxMembers", options.max_members),
        ] {
            if value == 0 {
                return Err(Error::new(
                    "COLLABORATION_ARGUMENTS",
                    format!("{name} must be a positive integer"),
                ));
            }
        }
        if options.idle_timeout_ms == Some(0) {
            return Err(Error::new(
                "COLLABORATION_ARGUMENTS",
                "idleTimeoutMs must be positive",
            ));
        }
        let runtime = Arc::new_cyclic(|weak: &Weak<Self>| Self {
            coordinator_id: protocol::coordinator_id(options.store.epoch_id()),
            store: options.store.clone(),
            bus: super::message_bus::MessageBus::new(
                Arc::new(RuntimeStore(weak.clone())),
                Arc::new(RuntimeDelivery(weak.clone())),
                super::message_bus::MessageBusOptions {
                    harness: options.harness.clone(),
                    record_activity: Some(Arc::new({
                        let weak = weak.clone();
                        move |input| {
                            if let Some(runtime) = weak.upgrade() {
                                store::post_activity(runtime.store.as_ref(), &input)?;
                                runtime.change();
                            }
                            Ok(())
                        }
                    })),
                    ..Default::default()
                },
            ),
            permits: Arc::new(Semaphore::new(options.max_concurrent_turns)),
            options,
            executor,
            source,
            creation: AsyncMutex::new(()),
            changed: Notify::new(),
            board: Mutex::new(BoardPages::default()),
            lifetime: CancellationToken::new(),
            close_complete: CancellationToken::new(),
            state: Mutex::new(State {
                active: HashMap::new(),
                idle: HashMap::new(),
                resident: HashSet::new(),
                retiring: HashMap::new(),
                allocating: HashSet::new(),
                stop_versions: HashMap::new(),
                stop_version: 0,
                closed: false,
                revision: 0,
                created: 0,
                executions: 0,
                activity_generation: 0,
            }),
        });
        let weak = Arc::downgrade(&runtime);
        runtime.bus.on_breach(Arc::new(move |_| {
            if let Some(runtime) = weak.upgrade() {
                crate::runtime::spawn(async move {
                    if let Err(error) = runtime.stop(&runtime.coordinator_id, "all").await {
                        tracing::warn!("[Collaboration] Circuit stop failed: {error}");
                    }
                });
            }
            Ok(())
        }));
        Ok(runtime)
    }
    pub fn active_count(&self) -> usize {
        self.state.lock().unwrap().executions
    }
    pub fn activity(&self) -> (u64, bool) {
        let state = self.state.lock().unwrap();
        (state.activity_generation, state.executions > 0)
    }
    pub fn revision(&self) -> u64 {
        self.state.lock().unwrap().revision
    }
    pub fn abort_now(&self) {
        self.lifetime.cancel();
        self.bus.abort_now();
        {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.stop_version += 1;
            for active in state.active.values() {
                active.cancellation.cancel();
            }
            for timer in state.idle.values() {
                timer.cancel();
            }
            for retirement in state.retiring.values() {
                retirement.cancel();
            }
            state.idle.clear();
            state.retiring.clear();
            state.allocating.clear();
            state.revision += 1;
        }
        self.changed.notify_waiters();
        self.close_complete.cancel();
    }
    pub fn definitions(&self) -> Vec<Value> {
        tool_contract::definitions()
    }
    fn change(&self) {
        self.state.lock().unwrap().revision += 1;
        self.changed.notify_waiters();
        if let Some(observer) = &self.options.on_change {
            if let Err(error) = observer() {
                tracing::warn!(code=%error.code, "Collaboration state observer failed");
            }
        }
    }
    pub async fn wait_for_change(&self, after: u64, cancellation: &CancellationToken) {
        let notified = self.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.revision() != after || self.state.lock().unwrap().closed {
            return;
        }
        tokio::select! {_=notified=>{},_=cancellation.cancelled()=>{}}
    }
    pub fn begin_request(&self) -> Result<bool> {
        self.require_open()?;
        let mut state = self.state.lock().unwrap();
        if state.executions > 0 {
            return Ok(false);
        }
        state.created = 0;
        self.bus.reset_circuit(self.store.epoch_id());
        Ok(true)
    }
    fn require_open(&self) -> Result<()> {
        if self.state.lock().unwrap().closed {
            Err(Error::new("closed", "").with_harness(TextId::CollaborationFeedbackClosed, &[]))
        } else {
            Ok(())
        }
    }
    fn member(&self, id: &str) -> Result<Value> {
        self.store
            .try_get("member", id)?
            .filter(|_| !self.state.lock().unwrap().allocating.contains(id))
            .ok_or_else(|| {
                Error::new("member_missing", "")
                    .with_harness(TextId::CollaborationFeedbackMemberMissing, &[])
            })
    }
    fn caller(&self, id: &str) -> Result<()> {
        self.require_open()?;
        if id != self.coordinator_id {
            let member = self.member(id)?;
            if member["state"] == "stopped" {
                return Err(Error::new("caller_stopped", "")
                    .with_harness(TextId::CollaborationFeedbackCallerStopped, &[]));
            }
        }
        Ok(())
    }
    fn admission(&self, id: &str, cancel: &CancellationToken) -> Result<(u64, u64)> {
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        self.caller(id)?;
        let state = self.state.lock().unwrap();
        Ok((
            state.stop_version,
            *state.stop_versions.get(id).unwrap_or(&0),
        ))
    }
    fn check_admission(
        &self,
        id: &str,
        admitted: (u64, u64),
        cancel: &CancellationToken,
    ) -> Result<()> {
        if self.admission(id, cancel)? != admitted {
            return Err(Error::new("execution_replaced", "")
                .with_harness(TextId::CollaborationFeedbackExecutionReplaced, &[]));
        }
        Ok(())
    }
    fn set_state(&self, id: &str, value: &str) -> Result<()> {
        if let Some(mut member) = self.store.try_get("member", id)? {
            member["state"] = value.into();
            store::add_member(self.store.as_ref(), member)?;
        }
        Ok(())
    }
    fn origin(&self, id: &str) -> Result<Option<Value>> {
        if id == self.coordinator_id {
            return Ok(self.options.origin.clone().map(Value::String));
        }
        let active = self
            .state
            .lock()
            .unwrap()
            .active
            .get(id)
            .and_then(|a| a.trigger.get("origin").cloned());
        match active {
            Some(origin) => Ok(Some(origin)),
            None => Ok(self.member(id)?.get("origin").cloned()),
        }
    }
    pub async fn spawn(
        self: &Arc<Self>,
        caller: &str,
        input: Value,
        cancel: &CancellationToken,
    ) -> Result<String> {
        self.spawn_with_harness(caller, input, cancel, self.options.harness.clone())
            .await
    }
    pub async fn spawn_with_harness(
        self: &Arc<Self>,
        caller: &str,
        input: Value,
        cancel: &CancellationToken,
        harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        let admitted = self.admission(caller, cancel)?;
        let _creation = self.creation.lock().await;
        self.check_admission(caller, admitted, cancel)?;
        if self.state.lock().unwrap().created >= self.options.max_members {
            return Err(Error::new("member_limit", "")
                .with_harness(TextId::CollaborationFeedbackMemberLimit, &[]));
        }
        let base = crate::js::trim_js(input["name"].as_str().unwrap_or("collaborator"));
        let base = if base.is_empty() {
            "collaborator"
        } else {
            base
        };
        if base == "all" || base == protocol::LEAD {
            return Err(Error::new("reserved_name", "")
                .with_harness(TextId::CollaborationFeedbackReservedName, &[]));
        }
        let mut name = base.to_owned();
        let mut suffix = 2;
        while name == self.coordinator_id
            || self.store.try_find_member(&name)?.is_some()
            || self.store.try_get("member", &name)?.is_some()
        {
            name = format!("{base}-{suffix}");
            suffix += 1;
        }
        let id = protocol::id();
        let mut member = json!({"id":id,"name":name,"parentId":caller,"prompt":input["prompt"]});
        for key in ["cwd", "isolation"] {
            if let Some(value) = input.get(key) {
                member[key] = value.clone();
            }
        }
        if let Some(origin) = self.origin(caller)? {
            member["origin"] = origin;
        }
        member["createdAt"] = protocol::now().into();
        member["state"] = "queued".into();
        self.state.lock().unwrap().allocating.insert(id.clone());
        let allocated = async {
            store::add_member(self.store.as_ref(), member)?;
            self.store.flush().await?;
            self.check_admission(caller, admitted, cancel)?;
            self.state.lock().unwrap().created += 1;
            Ok::<_, Error>(())
        }
        .await;
        if let Err(error) = allocated {
            if let Err(rollback) = self.store.record(json!({"kind":"remove_member","id":id})) {
                tracing::warn!("[Collaboration] Member allocation rollback failed: {rollback}");
            }
            if let Err(rollback) = self.store.flush().await {
                tracing::warn!(
                    "[Collaboration] Member allocation rollback could not be persisted: {rollback}"
                );
            }
            self.state.lock().unwrap().allocating.remove(&id);
            return Err(error);
        }
        self.state.lock().unwrap().allocating.remove(&id);
        self.send_with_harness(
            caller,
            &name,
            input["prompt"].as_str().unwrap_or(""),
            cancel,
            harness,
        )
        .await?;
        Ok(name)
    }

    pub async fn send(
        self: &Arc<Self>,
        caller: &str,
        to: &str,
        message: &str,
        cancel: &CancellationToken,
    ) -> Result<String> {
        self.send_with_harness(caller, to, message, cancel, self.options.harness.clone())
            .await
    }
    pub async fn send_with_harness(
        self: &Arc<Self>,
        caller: &str,
        to: &str,
        message: &str,
        cancel: &CancellationToken,
        harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        let admitted = self.admission(caller, cancel)?;
        let target =
            self.bus
                .resolve_member(self.store.team_id(), to, Some(self.store.epoch_id()))?;
        if target != self.coordinator_id {
            let member = self.member(&target)?;
            if member["state"] == "stopped" {
                if caller != self.coordinator_id && member["parentId"] != caller {
                    return Err(Error::new("target_stopped", "")
                        .with_harness(TextId::CollaborationFeedbackTargetStopped, &[]));
                }
                self.set_state(&target, "idle")?;
                self.store.flush().await?;
            }
        }
        self.check_admission(caller, admitted, cancel)?;
        let depth = self
            .state
            .lock()
            .unwrap()
            .active
            .get(caller)
            .and_then(|v| v.trigger["forwardDepth"].as_u64())
            .unwrap_or(0) as usize;
        if target != self.coordinator_id {
            let member = self.member(&target)?;
            if caller == self.coordinator_id || member["parentId"] == caller {
                self.bus.continue_session(&protocol::session_key(
                    &target,
                    self.store.team_id(),
                    self.store.epoch_id(),
                ));
            }
        }
        let mut input = json!({"teamId":self.store.team_id(),"epochId":self.store.epoch_id(),"fromAppId":caller,"to":target,"message":message,"forwardDepth":depth});
        if let Some(origin) = self.origin(caller)? {
            input["origin"] = origin;
        }
        let result = self.bus.send_with_harness(input, harness).await?;
        self.store.flush().await?;
        self.change();
        Ok(crate::js::stringify(&result))
    }

    fn start(self: &Arc<Self>, id: &str, deliveries: Vec<TeamDelivery>) -> Result<()> {
        let member = self.member(id)?;
        self.require_open()?;
        let cancellation = self.lifetime.child_token();
        {
            let mut state = self.state.lock().unwrap();
            if state.active.contains_key(id) {
                return Err(Error::new("COLLABORATION_BUSY", "")
                    .with_harness(TextId::CollaborationFeedbackMemberRunning, &[]));
            }
            if let Some(timer) = state.idle.remove(id) {
                timer.cancel();
            }
            state.resident.insert(id.into());
            if state.executions == 0 {
                state.activity_generation += 1;
            }
            state.executions += 1;
            state.active.insert(
                id.into(),
                Active {
                    cancellation: cancellation.clone(),
                    trigger: deliveries[0].trigger.clone(),
                    ready: false,
                },
            );
        }
        if let Err(error) = self.set_state(id, "queued") {
            let mut state = self.state.lock().unwrap();
            state.active.remove(id);
            state.executions -= 1;
            if state.executions == 0 {
                state.activity_generation += 1;
            }
            drop(state);
            self.change();
            return Err(error);
        }
        crate::runtime::spawn(self.clone().run(member, deliveries, cancellation));
        self.change();
        Ok(())
    }
    fn run(
        self: Arc<Self>,
        member: Value,
        deliveries: Vec<TeamDelivery>,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move {
            let id = member["id"].as_str().unwrap().to_owned();
            let trigger = deliveries[0].trigger.clone();
            let result=async {
            let permit=tokio::select!{_=cancel.cancelled()=>return Err(Error::cancelled()),permit=self.permits.clone().acquire_owned()=>permit.map_err(|_|Error::cancelled())?};
            let retirement=self.state.lock().unwrap().retiring.get(&id).cloned();
            if let Some(retirement)=retirement{tokio::select!{_=cancel.cancelled()=>return Err(Error::cancelled()),_=retirement.cancelled()=>{}}}
            self.set_state(&id,"running")?;self.store.flush().await?;
            if cancel.is_cancelled(){return Err(Error::cancelled());}
            let weak=Arc::downgrade(&self);let ready_id=id.clone();
            let ready=Arc::new(move||{if let Some(runtime)=weak.upgrade(){runtime.ready(&ready_id);}});
            let result=self.executor.execute(MemberExecutionRequest{member:member.clone(),deliveries,cancellation:cancel.clone(),ready,collaboration:Arc::downgrade(&self)}).await;
            drop(permit);result
        }.await;
            let outcome = match result {
                Ok(outcome) => outcome,
                Err(error) => {
                    if !cancel.is_cancelled() {
                        tracing::warn!(
                            "[Collaboration] Member execution failed: member={id}: {error}"
                        );
                    }
                    TurnCompletion::Error {
                        message: if cancel.is_cancelled() {
                            self.options
                                .harness
                                .text(TextId::CollaborationFeedbackExecutionStopped)
                        } else {
                            self.options
                                .harness
                                .text(TextId::CollaborationFeedbackExecutionFailed)
                        }
                        .into(),
                    }
                }
            };
            let stopped = self
                .store
                .get("member", &id)
                .is_some_and(|v| v["state"] == "stopped");
            if !stopped {
                if let Err(error) = self.set_state(
                    &id,
                    if matches!(outcome, TurnCompletion::Error { .. }) {
                        "error"
                    } else {
                        "idle"
                    },
                ) {
                    tracing::warn!(
                        "[Collaboration] Member state could not be persisted: member={id}: {error}"
                    );
                }
            }
            self.state.lock().unwrap().active.remove(&id);
            self.bus.complete_turn(
                &protocol::session_key(&id, self.store.team_id(), self.store.epoch_id()),
                &trigger,
                outcome.clone(),
                self.lifetime.is_cancelled() || stopped,
            );
            if !self.lifetime.is_cancelled() && !stopped && !cancel.is_cancelled() {
                let notice = async {
                    let harness = self.source.harness()?.unwrap_or_else(|| self.options.harness.clone());
                    let placement = self.store.try_get("member", &id)?.unwrap_or(Value::Null);
                    let mut workspace = json!({});
                    if let Some(value) = placement.get("workingDirectory") { workspace["cwd"] = value.clone(); }
                    if let Some(value) = placement.get("worktreePath") { workspace["worktree"] = value.clone(); }
                    let workspace = if workspace.as_object().unwrap().is_empty() { String::new() }
                        else { harness.render(TextId::CollaborationDeliveryWorkspace, &[("workspace", &crate::js::stringify(&workspace))]) };
                    let detail = match &outcome {
                        TurnCompletion::Result { content, .. } => String::from_utf16_lossy(&content.encode_utf16().take(4000).collect::<Vec<_>>()),
                        _ => outcome.kind().into(),
                    };
                    let body = harness.render(TextId::CollaborationDeliveryTurnEnd, &[("name",member["name"].as_str().unwrap_or("")), ("kind",outcome.kind()), ("detail",&detail), ("workspace",&workspace)]);
                    let envelope = json!({"id":protocol::id(),"teamId":self.store.team_id(),"epochId":self.store.epoch_id(),"fromAppId":null,"toAppId":self.coordinator_id,"correlationId":trigger["correlationId"],"createdAt":protocol::now(),"body":body});
                    let mut notice = trigger.clone();
                    notice["fromAppId"] = Value::Null; notice["kind"] = "member_stopped".into(); notice["wait"] = false.into();
                    self.source.deliver(envelope, notice).await
                }.await;
                if let Err(error) = notice {
                    tracing::warn!(
                        "[Collaboration] End notice could not reach source: member={id}: {error}"
                    );
                }
            }
            if let Err(error) = self.store.flush().await {
                tracing::warn!("[Collaboration] Record flush failed after turn: {error}");
            }
            self.arm_idle(&id);
            {
                let mut state = self.state.lock().unwrap();
                state.executions -= 1;
                if state.executions == 0 {
                    state.activity_generation += 1;
                }
            }
            self.change();
        })
    }
    fn ready(self: &Arc<Self>, id: &str) {
        {
            let mut state = self.state.lock().unwrap();
            let Some(active) = state.active.get_mut(id) else {
                return;
            };
            if active.cancellation.is_cancelled() {
                return;
            }
            active.ready = true;
        }
        self.bus.notify_session_ready(&protocol::session_key(
            id,
            self.store.team_id(),
            self.store.epoch_id(),
        ));
        self.change();
    }
    fn arm_idle(self: &Arc<Self>, id: &str) {
        if self.bus.is_session_occupied(&protocol::session_key(
            id,
            self.store.team_id(),
            self.store.epoch_id(),
        )) {
            return;
        }
        let mut state = self.state.lock().unwrap();
        if state.closed || state.active.contains_key(id) {
            return;
        }
        let timer = self.lifetime.child_token();
        if let Some(previous) = state.idle.insert(id.into(), timer.clone()) {
            previous.cancel();
        }
        drop(state);
        let weak = Arc::downgrade(self);
        let id = id.to_owned();
        let duration = self.options.idle_timeout_ms.unwrap_or(120_000);
        crate::runtime::spawn(async move {
            tokio::select! {_=timer.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(duration))=>{}}
            let Some(runtime) = weak.upgrade() else {
                return;
            };
            let retired = CancellationToken::new();
            {
                let mut state = runtime.state.lock().unwrap();
                if state.closed || state.active.contains_key(&id) {
                    return;
                }
                state.retiring.insert(id.clone(), retired.clone());
            }
            if let Err(error) = runtime.executor.release(&id).await {
                tracing::warn!(
                    "[Collaboration] Idle resource release failed: member={id}: {error}"
                );
            }
            let mut state = runtime.state.lock().unwrap();
            state.idle.remove(&id);
            state.retiring.remove(&id);
            retired.cancel();
            if !state.active.contains_key(&id) {
                state.resident.remove(&id);
            }
        });
    }

    pub async fn stop(&self, caller: &str, to: &str) -> Result<String> {
        self.caller(caller)?;
        let targets = if to == "all" {
            self.store.try_rows("member")?
        } else {
            vec![self
                .store
                .try_find_member(to)?
                .map(Ok)
                .unwrap_or_else(|| self.member(to))?]
        };
        if targets.iter().any(|v| v["id"] == caller) {
            return Err(Error::new("stop_self", "")
                .with_harness(TextId::CollaborationFeedbackStopSelf, &[]));
        }
        if caller != self.coordinator_id && targets.iter().any(|v| v["parentId"] != caller) {
            return Err(Error::new("stop_forbidden", "")
                .with_harness(TextId::CollaborationFeedbackStopForbidden, &[]));
        }
        if to == "all" {
            self.state.lock().unwrap().stop_version += 1;
        }
        for member in &targets {
            let id = member["id"].as_str().unwrap();
            self.set_state(id, "stopped")?;
            let mut state = self.state.lock().unwrap();
            *state.stop_versions.entry(id.into()).or_default() += 1;
            if let Some(active) = state.active.get(id) {
                active.cancellation.cancel();
            }
            drop(state);
            self.bus.cancel_session(&protocol::session_key(
                id,
                self.store.team_id(),
                self.store.epoch_id(),
            ));
        }
        let mut results = Vec::new();
        for member in targets {
            let id = member["id"].as_str().unwrap();
            let pending = self.state.lock().unwrap().active.contains_key(id);
            let stopped = self.executor.interrupt(id).await?;
            results.push(
                json!({"member":member["name"],"stopped":stopped,"pending":pending&&!stopped}),
            );
        }
        self.store.flush().await?;
        self.change();
        Ok(crate::js::stringify(&Value::Array(results)))
    }

    pub async fn call(
        self: &Arc<Self>,
        caller: &str,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.call_with_harness(caller, name, input, cancel, self.options.harness.clone())
            .await
    }
    pub async fn call_with_harness(
        self: &Arc<Self>,
        caller: &str,
        name: &str,
        input: Value,
        cancel: &CancellationToken,
        harness: Arc<ResolvedHarness>,
    ) -> Result<Value> {
        let input = match tool_contract::parse_input(name, &input) {
            Ok(input) => input,
            Err(error) => {
                tracing::warn!("[Collaboration] Arguments rejected: tool={name}");
                return Ok(tool_contract::text(error.render_for(&harness), true));
            }
        };
        if cancel.is_cancelled() {
            tracing::warn!("[Collaboration] Cancelled before execution: tool={name}");
            return Ok(tool_contract::text(
                harness.text(TextId::CollaborationFeedbackCancelled),
                true,
            ));
        }
        match self.call_inner(caller, name, input, cancel, &harness).await {
            Ok(text) => Ok(tool_contract::text(text, false)),
            Err(error) => {
                if super::is_refusal(&error) {
                    return Ok(tool_contract::text(error.render_for(&harness), true));
                }
                tracing::warn!("[Collaboration] Operation failed: tool={name}: {error}");
                Ok(tool_contract::text(
                    harness.text(TextId::CollaborationFeedbackOperationFailed),
                    true,
                ))
            }
        }
    }
    async fn call_inner(
        self: &Arc<Self>,
        caller: &str,
        name: &str,
        mut input: Value,
        cancel: &CancellationToken,
        harness: &Arc<ResolvedHarness>,
    ) -> Result<String> {
        match name {
            "spawn_agent" => Ok(harness.render(
                TextId::CollaborationFeedbackCreated,
                &[(
                    "name",
                    &self
                        .spawn_with_harness(caller, input, cancel, harness.clone())
                        .await?,
                )],
            )),
            "team_send" => {
                self.send_with_harness(
                    caller,
                    input["to"].as_str().unwrap(),
                    input["message"].as_str().unwrap(),
                    cancel,
                    harness.clone(),
                )
                .await
            }
            "team_stop" => self.stop(caller, input["to"].as_str().unwrap()).await,
            "team_read_board" => {
                self.caller(caller)?;
                let records = self.store.try_rows("member")?;
                let (allocating, active, revision) = {
                    let state = self.state.lock().unwrap();
                    (
                        state.allocating.clone(),
                        state
                            .active
                            .iter()
                            .map(|(id, active)| (id.clone(), active.ready))
                            .collect::<HashMap<_, _>>(),
                        state.revision,
                    )
                };
                let mut members = vec![json!({"name":"lead","to":"lead"})];
                for member in records {
                    let id = member["id"].as_str().unwrap();
                    if allocating.contains(id) {
                        continue;
                    }
                    let mut row = json!({"name":member["name"],"to":if member["name"]=="lead"{member["id"].clone()}else{member["name"].clone()}});
                    for (key, source) in [("cwd", "workingDirectory"), ("worktree", "worktreePath")]
                    {
                        if let Some(value) = member.get(source) {
                            row[key] = value.clone();
                        }
                    }
                    row["state"] = if let Some(ready) = active.get(id) {
                        if *ready { "running" } else { "queued" }.into()
                    } else if member["state"] == "running" || member["state"] == "queued" {
                        "interrupted".into()
                    } else {
                        member.get("state").cloned().unwrap_or("idle".into())
                    };
                    members.push(row);
                }
                let key = json!([revision, caller, input["mine"], input["status"]]).to_string();
                let tasks: Vec<_> = self
                    .store
                    .try_rows("task")?
                    .into_iter()
                    .filter(|task| {
                        (input["mine"] != true || task["assigneeAppId"] == caller)
                            && (input.get("status").is_none() || task["status"] == input["status"])
                    })
                    .collect();
                let full = json!({"members":members,"tasks":tasks,"findings":self.store.try_rows("finding")?,"activities":self.store.try_rows("activity")?});
                Ok(self
                    .board
                    .lock()
                    .unwrap()
                    .preview_with_harness(key, full, harness))
            }
            "team_read_member" => {
                self.caller(caller)?;
                let name = input["member"].as_str().unwrap();
                let member = self
                    .store
                    .try_find_member(name)?
                    .map(Ok)
                    .unwrap_or_else(|| self.member(name))?;
                if caller != self.coordinator_id && member["parentId"] != caller {
                    return Err(Error::new("record_forbidden", "")
                        .with_harness(TextId::CollaborationFeedbackRecordForbidden, &[]));
                }
                self.executor
                    .read_member_with_harness(
                        member["id"].as_str().unwrap(),
                        input["before"].as_u64(),
                        harness.clone(),
                    )
                    .await
            }
            "team_read_artifact" => {
                self.caller(caller)?;
                let reference = input["ref"].as_str().unwrap();
                if let Some(archive) = self.board.lock().unwrap().read(reference)? {
                    return Ok(archive);
                }
                self.executor
                    .read_artifact_with_harness(reference, caller, harness.clone())
                    .await
            }
            "team_post_finding" => {
                let admitted = self.admission(caller, cancel)?;
                if let Some(reference) = input["ref"].as_str() {
                    input["ref"] = self
                        .executor
                        .validate_artifact_with_harness(reference, caller, harness.clone())
                        .await?
                        .into();
                }
                self.check_admission(caller, admitted, cancel)?;
                input["callerAppId"] = caller.into();
                let result = store::post_finding(self.store.as_ref(), &input)?;
                self.change();
                self.store.flush().await?;
                Ok(crate::js::stringify(&result))
            }
            "team_post_task" => {
                self.caller(caller)?;
                let name = input["assignee"].as_str().unwrap();
                let member = self
                    .store
                    .try_find_member(name)?
                    .map(Ok)
                    .unwrap_or_else(|| self.member(name))?;
                input["assigneeAppId"] = member["id"].clone();
                input["callerAppId"] = caller.into();
                let result = store::post_task(self.store.as_ref(), &input)?;
                self.change();
                self.store.flush().await?;
                Ok(crate::js::stringify(&result))
            }
            "team_update_task" => {
                let admitted = self.admission(caller, cancel)?;
                let task = self
                    .store
                    .try_get("task", input["taskId"].as_str().unwrap())?
                    .filter(|v| caller == self.coordinator_id || v["assigneeAppId"] == caller)
                    .ok_or_else(|| {
                        Error::new("task_forbidden", "")
                            .with_harness(TextId::CollaborationFeedbackTaskForbidden, &[])
                    })?;
                if let Some(reference) = input["resultRef"].as_str() {
                    input["resultRef"] = self
                        .executor
                        .validate_artifact_with_harness(
                            reference,
                            task["assigneeAppId"].as_str().unwrap_or(caller),
                            harness.clone(),
                        )
                        .await?
                        .into();
                }
                self.check_admission(caller, admitted, cancel)?;
                store::update_task(self.store.as_ref(), &input)?;
                self.change();
                self.store.flush().await?;
                Ok(harness
                    .text(TextId::CollaborationFeedbackTaskUpdated)
                    .into())
            }
            _ => Err(Error::new("COLLABORATION_ARGUMENTS", "").with_harness(
                TextId::CollaborationArgumentsUnknownTool,
                &[("name", name.into())],
            )),
        }
    }
    pub async fn close(&self) -> Result<()> {
        let ids = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                None
            } else {
                state.closed = true;
                self.lifetime.cancel();
                Some(state.active.keys().cloned().collect::<Vec<_>>())
            }
        };
        let Some(ids) = ids else {
            self.close_complete.cancelled().await;
            return Ok(());
        };
        self.board.lock().unwrap().clear();
        for id in ids {
            if let Err(error) = self.executor.interrupt(&id).await {
                tracing::warn!("[Collaboration] Shutdown interrupt failed: member={id}: {error}");
            }
        }
        let creation = self.creation.lock().await;
        drop(creation);
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active_count() == 0 {
                break;
            }
            notified.await;
        }
        self.bus.reset_epoch(self.store.epoch_id());
        let retirements = self
            .state
            .lock()
            .unwrap()
            .retiring
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for retirement in retirements {
            retirement.cancelled().await;
        }
        let resident = std::mem::take(&mut self.state.lock().unwrap().resident);
        for id in resident {
            if let Err(error) = self.executor.release(&id).await {
                tracing::warn!("[Collaboration] Shutdown release failed: member={id}: {error}");
            }
        }
        let result = self.store.flush().await;
        self.change();
        self.close_complete.cancel();
        result
    }
}
