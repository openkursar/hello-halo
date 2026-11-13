use crate::bridge::{EventSink, HostBridge, HostServices};
use crate::error::{Error, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

#[cfg(test)]
#[path = "session/tests.rs"]
mod tests;

pub(crate) struct PendingInput {
    pub payload: Value,
    pub id: String,
    pub live: bool,
    bytes: usize,
}

struct Inbox {
    closed: bool,
    stream_requested: bool,
    inputs: VecDeque<PendingInput>,
    bytes: usize,
    turn: CancellationToken,
    work_receipt: Option<String>,
}

pub(crate) struct Command {
    pub name: String,
    pub payload: Value,
    pub result: oneshot::Sender<Result<Value>>,
}

pub struct NativeSession {
    pub(crate) options: Value,
    resources: Arc<crate::resource_activity::ResourceActivity>,
    services: HostServices,
    work: Arc<crate::resource_activity::ResourceActivity>,
    work_receipts: Mutex<HashMap<String, crate::resource_activity::ResourceLease>>,
    output_consumed: std::sync::atomic::AtomicBool,
    event_flow: crate::core::event_flow::EventFlow,
    pub(crate) harness: Arc<crate::harness::Harness>,
    pub(crate) controls: crate::core::command_runtime::SessionControls,
    pub(crate) session_id: String,
    inbox: Mutex<Inbox>,
    pub(crate) wake: Notify,
    pub(crate) lifetime: CancellationToken,
    pub(crate) closed: CancellationToken,
    pub(crate) end_hook_cancellation: CancellationToken,
    running: std::sync::atomic::AtomicBool,
    finalized: std::sync::atomic::AtomicBool,
    forcing: std::sync::atomic::AtomicBool,
    terminal_error: Mutex<Option<Error>>,
    pub(crate) turn_count: Arc<std::sync::atomic::AtomicU32>,
    pub(crate) api_time_ms: Arc<std::sync::atomic::AtomicU64>,
    output: mpsc::Sender<Value>,
    receiver: AsyncMutex<mpsc::Receiver<Value>>,
    callbacks: Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>,
    commands: mpsc::Sender<Command>,
    pub(crate) command_receiver: AsyncMutex<mpsc::Receiver<Command>>,
    pub(crate) tools: Mutex<Option<Arc<crate::tools::ToolRuntime>>>,
    process_retirements: Mutex<Vec<Arc<crate::tools::ProcessRetirement>>>,
    pub(crate) transcript: Mutex<Option<crate::history::Journal>>,
    pub(crate) ownership: Mutex<Option<Value>>,
    run_cost: Mutex<(String, Arc<Mutex<crate::core::cost::CostTracker>>)>,
    catalog_views: Arc<crate::core::skill_catalog_view::SkillCatalogOwner>,
    pub(crate) permission_denials: Arc<Mutex<Vec<Value>>>,
    pub(crate) inherited_collaboration: Option<Arc<dyn crate::collaboration::CollaborationTools>>,
    pub(crate) working_checkpoint: Option<crate::tools::ToolCheckpoint>,
    pub(crate) prepared_working: Option<Arc<crate::tools::WorkingState>>,
    pub(crate) borrowed_mcp: Option<crate::tools::BorrowedMcp>,
    pub(crate) borrowed_search: Option<crate::tools::BorrowedSearch>,
    pub(crate) owned_collaboration:
        Mutex<Option<Arc<crate::core::collaboration_adapter::SdkCollaboration>>>,
    execution_budget: Mutex<Option<Arc<crate::core::execution_budget::ExecutionBudget>>>,
    children: Mutex<HashMap<String, std::sync::Weak<NativeSession>>>,
    pub(crate) tool_context: Arc<crate::core::tool_context_bridge::ToolContextBridge>,
    #[cfg(test)]
    pub(crate) iteration_observer: Mutex<Option<mpsc::UnboundedSender<Vec<Value>>>>,
}

struct PendingCallback<'a> {
    session: &'a NativeSession,
    id: String,
}

impl Drop for NativeSession {
    fn drop(&mut self) { self.catalog_views.close(); }
}

struct ExecutionOwner {
    session: Arc<NativeSession>,
}
impl Drop for ExecutionOwner {
    fn drop(&mut self) {
        if !self
            .session
            .finalized
            .load(std::sync::atomic::Ordering::Acquire)
        {
            self.session.abort_for_host_shutdown();
        }
    }
}

impl Drop for PendingCallback<'_> {
    fn drop(&mut self) {
        if self
            .session
            .callbacks
            .lock()
            .unwrap()
            .remove(&self.id)
            .is_none()
        {
            return;
        }
        let output = self.session.output.clone();
        let closed = self.session.closed.clone();
        let message = json!({"kind":"callbackCancelled","id":self.id});
        crate::runtime::spawn(async move {
            tokio::select! { _ = closed.cancelled() => {}, _ = output.send(message) => {} }
        });
    }
}

impl NativeSession {
    pub fn resource_activity(&self) -> Option<Arc<crate::resource_activity::ResourceActivity>> {
        Some(self.resources.clone())
    }
    pub fn execution_activity(&self) -> Arc<crate::resource_activity::ResourceActivity> {
        self.work.clone()
    }
    pub(crate) fn execution_lease(&self) -> crate::resource_activity::ResourceLease {
        self.work.lease()
    }
    fn ensure_work(&self) {
        let needed = |inbox: &Inbox| {
            !inbox.closed
                && (self.is_running() || (inbox.stream_requested && !inbox.inputs.is_empty()))
        };
        {
            let inbox = self.inbox.lock().unwrap();
            if inbox.work_receipt.is_some() || !needed(&inbox) {
                return;
            }
        }
        let lease = self.work.lease();
        let mut inbox = self.inbox.lock().unwrap();
        if inbox.work_receipt.is_none() && needed(&inbox) {
            let receipt = Uuid::new_v4().to_string();
            self.work_receipts
                .lock()
                .unwrap()
                .insert(receipt.clone(), lease);
            inbox.work_receipt = Some(receipt);
        }
    }
    pub(crate) async fn preparation_delivered(&self) -> Result<()> {
        self.envelope(json!({"kind":"work_complete","receipt":"prepare"}))
            .await
    }
    pub(crate) async fn complete_stream(&self) -> Result<()> {
        let receipt = self.inbox.lock().unwrap().work_receipt.take();
        self.ensure_work();
        if let Some(receipt) = receipt {
            self.envelope(json!({"kind":"work_complete","receipt":receipt}))
                .await?;
        }
        Ok(())
    }
    fn finish_work_receipt(&self, receipt: &str) {
        let lease = self.work_receipts.lock().unwrap().remove(receipt);
        drop(lease);
    }
    pub fn event_consumed(&self, id: &str, error: Option<Error>) {
        self.event_flow.consume(id, error);
    }
    pub fn output_consumed(&self) {
        self.output_consumed
            .store(true, std::sync::atomic::Ordering::Release);
        if self.closed.is_cancelled() {
            self.release_work();
        }
    }
    fn release_work(&self) {
        self.work.close();
        let receipts = std::mem::take(&mut *self.work_receipts.lock().unwrap());
        drop(receipts);
    }
    pub fn id(&self) -> &str {
        &self.session_id
    }
    pub(crate) fn forward_log(&self, record: Value) {
        if self
            .output
            .try_send(json!({"kind":"log","record":record}))
            .is_err()
        {
            crate::logging::console(&record);
        }
    }
    pub fn new(options: Value) -> Result<Arc<Self>> {
        Self::new_with_collaboration(options, None)
    }

    pub fn new_with_collaboration(
        options: Value,
        inherited_collaboration: Option<Arc<dyn crate::collaboration::CollaborationTools>>,
    ) -> Result<Arc<Self>> {
        Self::construct(
            options,
            inherited_collaboration,
            None,
            None,
            None,
            None,
            HostServices::default(),
        )
    }

    pub fn new_with_services(
        options: Value,
        services: HostServices,
    ) -> Result<Arc<Self>> {
        Self::construct(options, None, None, None, None, None, services)
    }
    pub fn host_services(&self) -> HostServices { self.services.clone() }
    pub fn new_child(
        mut options: Value,
        binding: Arc<dyn crate::collaboration::CollaborationTools>,
        working: Option<crate::tools::ToolCheckpoint>,
        mcp: Option<crate::tools::BorrowedMcp>,
        search: Option<crate::tools::BorrowedSearch>,
        resources: Option<Arc<crate::resource_activity::ResourceActivity>>,
        services: HostServices,
    ) -> Result<Arc<Self>> {
        for key in ["nativeQuery", "nativeWorker"] {
            options.as_object_mut().unwrap().shift_remove(key);
        }
        Self::construct(
            options,
            Some(binding),
            working,
            mcp,
            search,
            resources,
            services,
        )
    }

    fn construct(
        mut options: Value,
        inherited_collaboration: Option<Arc<dyn crate::collaboration::CollaborationTools>>,
        working_checkpoint: Option<crate::tools::ToolCheckpoint>,
        borrowed_mcp: Option<crate::tools::BorrowedMcp>,
        borrowed_search: Option<crate::tools::BorrowedSearch>,
        resources: Option<Arc<crate::resource_activity::ResourceActivity>>,
        services: HostServices,
    ) -> Result<Arc<Self>> {
        if options["nativeResolvedConfig"] != true {
            let resolved = crate::core::config::resolve(&options)?;
            for (key, value) in resolved.as_object().unwrap() {
                if key == "abortSignal" || crate::js::is_undefined(value) {
                    continue;
                }
                let key = if key == "maxTokens" {
                    "maxOutputTokens"
                } else {
                    key.as_str()
                };
                options[key] = value.clone();
            }
            options["nativeResolvedConfig"] = json!(true);
        }
        if !crate::js::truthy(&options["model"]) {
            return Err(Error::new(
                "INVALID_OPTIONS",
                "Options.model is required; the SDK does not pick a model on its own.",
            ));
        }
        if options["cwd"].is_null() {
            options["cwd"] = json!(std::env::current_dir()?.to_string_lossy());
        }
        if options["env"].is_null() {
            options["env"] = json!({});
        }
        let session_id = if options["nativeQuery"] == true
            || (options["forkSession"] == true && options["resume"].is_string())
        {
            Uuid::new_v4().to_string()
        } else {
            options["resume"]
                .as_str()
                .or(options["sessionId"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string())
        };
        let (output, receiver) = mpsc::channel(256);
        options["sessionId"] = json!(session_id);
        let prepared_working = if options["nativeQuery"] == true {
            let working = Arc::new(crate::tools::WorkingState::new(&options));
            if let Some(goal) = options.get("goal").filter(|goal| crate::js::truthy(goal)) {
                working.set_goal(goal.clone())?;
            }
            Some(working)
        } else {
            None
        };
        let (commands, command_receiver) = mpsc::channel(128);
        let cost = Arc::new(Mutex::new(crate::core::cost::CostTracker::new(
            options["model"].as_str().unwrap_or(""),
            options["contextWindow"].as_f64().unwrap_or(200_000.0),
            options["modelPricing"].clone(),
        )));
        let tool_context = Arc::new(crate::core::tool_context_bridge::ToolContextBridge::new(
            cost.clone(),
        ));
        let run_id = Uuid::new_v4().to_string();
        options["nativeCatalogOwner"] = json!(run_id);
        let work = Arc::new(crate::resource_activity::ResourceActivity::default());
        let mut work_receipts = HashMap::new();
        work_receipts.insert("prepare".to_owned(), work.lease());
        let session = Arc::new(Self {
            #[cfg(test)]
            iteration_observer: Mutex::new(None),
            services,
            work,
            work_receipts: Mutex::new(work_receipts),
            output_consumed: std::sync::atomic::AtomicBool::new(false),
            event_flow: crate::core::event_flow::EventFlow::default(),
            resources: resources
                .unwrap_or_else(|| Arc::new(crate::resource_activity::ResourceActivity::default())),
            harness: crate::harness::Harness::from_config(&options["harnessText"])?,
            controls: crate::core::command_runtime::SessionControls::new(&options),
            options,
            session_id,
            inbox: Mutex::new(Inbox {
                closed: false,
                stream_requested: false,
                inputs: VecDeque::new(),
                bytes: 0,
                turn: CancellationToken::new(),
                work_receipt: None,
            }),
            wake: Notify::new(),
            lifetime: CancellationToken::new(),
            closed: CancellationToken::new(),
            end_hook_cancellation: CancellationToken::new(),
            running: std::sync::atomic::AtomicBool::new(false),
            finalized: std::sync::atomic::AtomicBool::new(false),
            forcing: std::sync::atomic::AtomicBool::new(false),
            terminal_error: Mutex::new(None),
            turn_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            api_time_ms: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            output,
            receiver: AsyncMutex::new(receiver),
            callbacks: Mutex::new(HashMap::new()),
            commands,
            command_receiver: AsyncMutex::new(command_receiver),
            tools: Mutex::new(None),
            process_retirements: Mutex::new(Vec::new()),
            transcript: Mutex::new(None),
            ownership: Mutex::new(None),
            catalog_views: Arc::new(crate::core::skill_catalog_view::SkillCatalogOwner::new(run_id.clone())),
            run_cost: Mutex::new((run_id, cost)),
            permission_denials: Arc::new(Mutex::new(Vec::new())),
            inherited_collaboration,
            working_checkpoint,
            prepared_working,
            borrowed_mcp,
            borrowed_search,
            owned_collaboration: Mutex::new(None),
            execution_budget: Mutex::new(None),
            children: Mutex::new(HashMap::new()),
            tool_context,
        });
        let execution = session.clone();
        let runtime = crate::runtime::shared()?;
        crate::runtime::session_started();
        let owner = ExecutionOwner {
            session: execution.clone(),
        };
        let logging = crate::logging::channel_dispatch(execution.output.clone());
        runtime.spawn(async move {
            let _owner=owner;
            let outcome = crate::core::engine::run(execution.clone()).await;
            execution.close();
            execution.end_turn();
            let collaboration = execution.owned_collaboration.lock().unwrap().clone();
            if let Some(collaboration) = collaboration {
                if let Err(error) = collaboration.close().await { collaboration.abort_now(); tracing::warn!(session_id=%execution.session_id,code=%error.code,"Session collaboration cleanup failed"); }
            }
            execution.owned_collaboration.lock().unwrap().take();
            let tools = execution.tools.lock().unwrap().clone();
            if let Some(tools) = tools {
                if let Err(error) = tools.close().await {
                    tools.abort_now();
                    tracing::warn!(session_id=%execution.session_id,code=%error.code,"Session tool cleanup failed");
                }
                execution.remember_process_retirement(tools.process_retirement());
                if execution.options["nativeQuery"]==true{tools.release_working_state();}
            }
            execution.tools.lock().unwrap().take();
            execution.transcript.lock().unwrap().take();
            if execution.options["nativeQuery"]==true{if let Some(working)=&execution.prepared_working{working.release();}}
            let ownership=execution.ownership.lock().unwrap().take();
            if let Some(lease)=ownership{if let Err(error)=execution.call("ownership.release",json!({"leaseId":lease}),&CancellationToken::new()).await{tracing::warn!(session_id=%execution.session_id,code=%error.code,"Session ownership release failed");}}
            let callbacks = std::mem::take(&mut *execution.callbacks.lock().unwrap());
            for (_, callback) in callbacks { let _ = callback.send(Err(Error::cancelled())); }
            if let Err(error)=outcome{
                if execution.output.try_send(json!({"kind":"error","code":error.code,"message":error.message,"details":error.details,"harness":error.harness,"sessionId":execution.session_id})).is_err(){*execution.terminal_error.lock().unwrap()=Some(error);}
            }
            execution.finish_shutdown();
            let _ = execution.output.try_send(json!({"kind":"closed"}));
        }.with_subscriber(logging));
        Ok(session)
    }

    pub fn send(&self, input: Value, id: String, live: bool) -> Result<bool> {
        let mut inbox = self.inbox.lock().unwrap();
        if inbox.closed {
            return if live {
                Ok(false)
            } else {
                Err(Error::new("SESSION_CLOSED", "Session is closed"))
            };
        }
        let bytes = crate::js::utf16_len(
            input
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| crate::js::stringify(&input))
                .as_str(),
        ) * 2;
        if self.options["nativeWorker"] == true
            && (inbox.inputs.len() >= 256 || inbox.bytes.saturating_add(bytes) > 64 * 1024 * 1024)
        {
            return Err(Error::new(
                "INPUT_CAPACITY",
                "Session input capacity exceeded",
            ));
        }
        inbox.bytes += bytes;
        inbox.inputs.push_back(PendingInput {
            payload: normalize_input(input),
            id,
            live,
            bytes,
        });
        drop(inbox);
        if !live {
            if let Some(owner) = self.owned_collaboration.lock().unwrap().as_ref() {
                owner.begin_request();
            }
        }
        self.ensure_work();
        self.wake.notify_one();
        Ok(true)
    }

    pub fn has_pending_input(&self) -> bool {
        !self.inbox.lock().unwrap().inputs.is_empty()
    }

    pub fn start_stream(&self) -> Result<()> {
        let mut inbox = self.inbox.lock().unwrap();
        if inbox.closed {
            return Err(Error::new("SESSION_CLOSED", "Session is closed"));
        }
        inbox.stream_requested = true;
        drop(inbox);
        self.ensure_work();
        self.wake.notify_one();
        Ok(())
    }
    pub(crate) fn stream_requested(&self) -> bool {
        self.inbox.lock().unwrap().stream_requested
    }
    pub(crate) fn end_stream(&self) {
        let mut inbox = self.inbox.lock().unwrap();
        inbox.stream_requested = false;
        self.running.store(false, std::sync::atomic::Ordering::Release);
    }

    pub fn withdraw_unread_input(&self) -> Result<Vec<String>> {
        let mut inbox = self.inbox.lock().unwrap();
        let mut withdrawn = Vec::new();
        inbox.inputs.retain(|input| {
            if input.live {
                withdrawn.push(input.id.clone());
                false
            } else {
                true
            }
        });
        inbox.bytes = inbox.inputs.iter().map(|input| input.bytes).sum();
        Ok(withdrawn)
    }

    pub fn interrupt(&self) {
        let mut inbox = self.inbox.lock().unwrap();
        let idle = inbox.stream_requested && !self.is_running();
        inbox.turn.cancel();
        let receipt = if idle {
            inbox.stream_requested = false;
            inbox.work_receipt.take()
        } else {
            None
        };
        drop(inbox);
        if idle {
            let receipt = receipt.unwrap_or_else(|| {
                let lease = self.work.lease();
                let receipt = Uuid::new_v4().to_string();
                self.work_receipts
                    .lock()
                    .unwrap()
                    .insert(receipt.clone(), lease);
                receipt
            });
            let output = self.output.clone();
            let closed = self.closed.clone();
            crate::runtime::spawn(async move {
                tokio::select! {_=closed.cancelled()=>{},_=output.send(json!({"kind":"streamEnd"}))=>{}}
                tokio::select! {_=closed.cancelled()=>{},_=output.send(json!({"kind":"work_complete","receipt":receipt}))=>{}}
            });
        }
        self.wake.notify_one();
    }

    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::Acquire)
    }
    pub fn end_turn(&self) {
        self.running
            .store(false, std::sync::atomic::Ordering::Release);
    }
    pub fn cancel_end_hooks(&self) {
        self.end_hook_cancellation.cancel();
        let children: Vec<_> = self.children.lock().unwrap().values().filter_map(std::sync::Weak::upgrade).collect();
        for child in children { child.cancel_end_hooks(); }
    }

    pub fn set_execution_budget(
        &self,
        budget: Arc<crate::core::execution_budget::ExecutionBudget>,
    ) {
        *self.execution_budget.lock().unwrap() = Some(budget.clone());
        self.current_cost()
            .lock()
            .unwrap()
            .set_on_usage(Some(Arc::new(move |usage, _model| budget.observe(usage))));
    }
    pub fn current_cost(&self) -> Arc<Mutex<crate::core::cost::CostTracker>> {
        self.run_cost.lock().unwrap().1.clone()
    }
    pub(crate) fn start_cost_run(
        &self,
        options: &Value,
    ) -> Arc<Mutex<crate::core::cost::CostTracker>> {
        let mut tracker = crate::core::cost::CostTracker::new(
            options["model"].as_str().unwrap_or(""),
            options["contextWindow"].as_f64().unwrap_or(200_000.0),
            options["modelPricing"].clone(),
        );
        if let Some(budget) = self.get_execution_budget() {
            tracker.set_on_usage(Some(Arc::new(move |usage, _model| budget.observe(usage))));
        }
        let tracker = Arc::new(Mutex::new(tracker));
        *self.run_cost.lock().unwrap() = (Uuid::new_v4().to_string(), tracker.clone());
        self.tool_context.set_cost(tracker.clone());
        tracker
    }
    pub fn shared_context(
        &self,
        identity: &str,
        expected_owner: Option<&str>,
    ) -> Result<crate::core::loop_owner::SharedToolState> {
        let tool_use_id = if let Some((session, id)) = context_identity(identity) {
            if session != self.session_id {
                return self
                    .find_child(&session)
                    .ok_or_else(|| {
                        Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
                    })?
                    .shared_context(&id, expected_owner);
            }
            id
        } else { identity.to_owned() };
        if expected_owner.is_some_and(|owner| owner != self.catalog_views.identity()) {
            return Err(Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available"));
        }
        let (run_id, cost) = self.run_cost.lock().unwrap().clone();
        let tools = self
            .tools
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::new("SESSION_NOT_READY", "Session is not ready"))?;
        let text = self.tool_context.harness(&tool_use_id)?;
        let skills = self.catalog_views.snapshot(tools.skill_catalog_scope(&text), || tools.skill_catalog_with_harness(&text))?;
        Ok(crate::core::loop_owner::SharedToolState {
            run_id,
            read_identity: self.session_id.clone(),
            cost,
            reads: tools.shared_read_state(),
            text,
            skills,
        })
    }
    pub fn get_execution_budget(
        &self,
    ) -> Option<Arc<crate::core::execution_budget::ExecutionBudget>> {
        self.execution_budget.lock().unwrap().clone()
    }

    pub fn close(&self) {
        let mut inbox = self.inbox.lock().unwrap();
        let first = !inbox.closed;
        inbox.closed = true;
        inbox.stream_requested = false;
        inbox.turn.cancel();
        inbox.inputs.clear();
        inbox.bytes = 0;
        drop(inbox);
        if first && !self.forcing.load(std::sync::atomic::Ordering::Acquire) {
            let lease = self.work.lease();
            self.work_receipts
                .lock()
                .unwrap()
                .insert("close".into(), lease);
        }
        self.lifetime.cancel();
        let tools = self.tools.lock().unwrap().clone();
        if let Some(tools) = tools { tools.begin_close(); }
        if self.forcing.load(std::sync::atomic::Ordering::Acquire) {
            self.release_work();
        }
        self.wake.notify_waiters();
    }

    fn finish_shutdown(&self) {
        self.catalog_views.close();
        if !self
            .finalized
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            crate::runtime::session_closed();
        }
        self.closed.cancel();
        if self
            .output_consumed
            .load(std::sync::atomic::Ordering::Acquire)
            || self.forcing.load(std::sync::atomic::Ordering::Acquire)
        {
            self.release_work();
        }
    }

    pub fn abort_for_host_shutdown(&self) {
        self.process_retirement().abort_now();
        if self.finalized.load(std::sync::atomic::Ordering::Acquire)
            || self.forcing.swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return;
        }
        self.cancel_end_hooks();
        self.close();
        self.end_turn();
        let owner = self.owned_collaboration.lock().unwrap().take();
        if let Some(owner) = owner {
            owner.abort_now();
        }
        let children = std::mem::take(&mut *self.children.lock().unwrap());
        for child in children.into_values().filter_map(|child| child.upgrade()) {
            child.abort_for_host_shutdown();
        }
        let tools = self.tools.lock().unwrap().take();
        if let Some(tools) = tools {
            tools.abort_now();
        }
        if self.options["nativeQuery"] == true {
            if let Some(working) = &self.prepared_working {
                working.release();
            }
        }
        self.transcript.lock().unwrap().take();
        let callbacks = std::mem::take(&mut *self.callbacks.lock().unwrap());
        for (_, callback) in callbacks {
            let _ = callback.send(Err(Error::cancelled()));
        }
        *self.terminal_error.lock().unwrap() = Some(Error::new(
            "RUNTIME_STOPPED",
            "Native session execution stopped before asynchronous cleanup completed",
        ));
        crate::logging::console(
            &json!({"component":"Native","level":"warn","message":"Session execution stopped before asynchronous cleanup; cancelling owned resources","fields":{"sessionId":self.session_id}}),
        );
        self.finish_shutdown();
    }

    pub async fn wait_closed(&self) -> Result<()> {
        self.closed.cancelled().await;
        Ok(())
    }

    pub async fn flush(&self) -> Result<()> {
        if self.lifetime.is_cancelled() {
            self.wait_closed().await
        } else {
            let journal = self.transcript.lock().unwrap().clone();
            match journal {
                Some(journal) => journal.flush().await,
                None => Ok(()),
            }
        }
    }

    pub async fn next(&self) -> Result<Option<Value>> {
        let mut receiver = self.receiver.lock().await;
        loop {
            if self.closed.is_cancelled() && receiver.is_empty() {
                if let Some(error) = self.terminal_error.lock().unwrap().take() {
                    return Err(error);
                }
                return Ok(None);
            }
            let value = tokio::select! {value=receiver.recv()=>value,_=self.closed.cancelled()=>receiver.try_recv().ok()};
            if let Some(value) = value
                .as_ref()
                .filter(|value| value["kind"] == "work_complete")
            {
                self.finish_work_receipt(value["receipt"].as_str().unwrap_or(""));
                continue;
            }
            if value.is_none() {
                if let Some(error) = self.terminal_error.lock().unwrap().take() {
                    return Err(error);
                }
            }
            return Ok(value);
        }
    }

    pub async fn command(&self, name: &str, payload: Value) -> Result<Value> {
        if name == "commandContext" {
            let target = payload[0].as_str().unwrap_or("");
            let operation = payload[1].as_str().unwrap_or("");
            if target == self.session_id {
                return self.command_local(operation, payload[2].clone()).await;
            }
            let child = self
                .find_child(target)
                .ok_or_else(|| Error::new("SESSION_CLOSED", "Session is closed"))?;
            return child.command_local(operation, payload[2].clone()).await;
        }
        self.command_local(name, payload).await
    }

    async fn command_local(&self, name: &str, payload: Value) -> Result<Value> {
        if name == "getRuntimeStats" {
            let active = self
                .owned_collaboration
                .lock()
                .unwrap()
                .as_ref()
                .map_or(0, |owner| owner.active_count());
            let mut stats = json!({"pendingInputs":self.inbox.lock().unwrap().inputs.len(),"activeCollaborators":active});
            if let Some(budget) = self.get_execution_budget() {
                stats["sharedCostUsd"] = json!(budget.total());
            }
            return Ok(stats);
        }
        if self.lifetime.is_cancelled() {
            return Err(Error::new("SESSION_CLOSED", "Session is closed"));
        }
        if let Some(result) = self.immediate_command(name, &payload).await {
            return result;
        }
        let (result, receiver) = oneshot::channel();
        tokio::select! {
            _ = self.lifetime.cancelled() => return Err(Error::cancelled()),
            outcome = self.commands.send(Command { name: name.to_owned(), payload, result }) => outcome.map_err(|_| Error::new("SESSION_CLOSED", "Session is closed"))?,
        }
        self.wake.notify_one();
        tokio::select! {
            _ = self.closed.cancelled() => Err(Error::new("SESSION_CLOSED", "Session is closed")),
            result = receiver => result.map_err(|_| Error::new("SESSION_CLOSED", "Session is closed"))?,
        }
    }

    pub(crate) async fn immediate_command(
        &self,
        name: &str,
        payload: &Value,
    ) -> Option<Result<Value>> {
        if self.controls.update(name, payload) {
            if let Some(owner) = self.owned_collaboration.lock().unwrap().as_ref() {
                owner.update_options(self.controls.options(&self.options));
            }
            return Some(Ok(Value::Null));
        }
        let options = self.controls.options(&self.options);
        let harness = self
            .harness
            .for_model(options["model"].as_str().unwrap_or(""));
        match name {
            "supportedModels" => {
                return Some(Ok(crate::core::command_runtime::configured_models(
                    if self.options["nativeQuery"] == true {
                        &self.options
                    } else {
                        &options
                    },
                )))
            }
            "accountInfo" => return Some(Ok(json!({"apiKeySource":"user"}))),
            "supportedCommands" if self.controls.prepared().is_some() => {
                return Some(Ok(json!(self.controls.supported_commands(&harness))))
            }
            "initializationResult" if self.controls.prepared().is_some() => {
                return Some(Ok(
                    json!({"commands":self.controls.supported_commands(&harness),"models":crate::core::command_runtime::configured_models(if self.options["nativeQuery"] == true { &self.options } else { &options }),"accountInfo":{"apiKeySource":"user"},"mcpServers":self.controls.initial_mcp()}),
                ))
            }
            _ => {}
        }
        let tools = self.tools.lock().unwrap().clone()?;
        match name {
            "mcpServerStatus" => Some(Ok(json!(tools.mcp_statuses_with_harness(&harness)))),
            "reconnectMcpServer" => Some(
                tools
                    .reconnect_mcp(payload[0].as_str().unwrap_or(""), &self.lifetime)
                    .await
                    .map(|_| Value::Null),
            ),
            "toggleMcpServer" => Some(
                tools
                    .toggle_mcp(
                        payload[0].as_str().unwrap_or(""),
                        payload[1] == true,
                        &self.lifetime,
                    )
                    .await
                    .map(|_| Value::Null),
            ),
            "setMcpServers" => Some(
                tools
                    .set_mcp_servers(payload[0].clone(), &self.lifetime)
                    .await,
            ),
            "stopTask" => {
                tools.stop_task(payload[0].as_str().unwrap_or("")).await;
                Some(Ok(Value::Null))
            }
            _ => None,
        }
    }

    pub fn goal(&self) -> Value {
        if let Some(working) = &self.prepared_working {
            return working.get_goal();
        }
        self.tools
            .lock()
            .unwrap()
            .as_ref()
            .map(|tools| tools.get_goal())
            .unwrap_or(Value::Null)
    }

    pub fn context_call(&self, tool_use_id: &str, method: &str, args: Value) -> Result<Value> {
        if let Some((session_id, id)) = context_identity(tool_use_id) {
            if session_id == self.session_id {
                return self.tool_context.call(&id, method, args);
            }
            return self
                .find_child(&session_id)
                .ok_or_else(|| {
                    Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
                })?
                .tool_context
                .call(&id, method, args);
        }
        self.tool_context.call(tool_use_id, method, args)
    }

    pub async fn context_emit(&self, tool_use_id: &str, event: Value) -> Result<()> {
        if let Some((session_id, id)) = context_identity(tool_use_id) {
            if session_id == self.session_id {
                return self.tool_context.emit(&id, event).await;
            }
            return self
                .find_child(&session_id)
                .ok_or_else(|| {
                    Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
                })?
                .tool_context
                .emit(&id, event)
                .await;
        }
        self.tool_context.emit(tool_use_id, event).await
    }

    pub async fn context_async(
        &self,
        tool_use_id: &str,
        method: &str,
        args: Value,
    ) -> Result<Value> {
        if let Some((session_id, id)) = context_identity(tool_use_id) {
            if session_id == self.session_id {
                return self.tool_context.async_call(&id, method, args).await;
            }
            return self
                .find_child(&session_id)
                .ok_or_else(|| {
                    Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
                })?
                .tool_context
                .async_call(&id, method, args)
                .await;
        }
        self.tool_context
            .async_call(tool_use_id, method, args)
            .await
    }

    pub fn prepare_context_file(
        &self,
        tool_use_id: &str,
        method: &str,
        args: &Value,
    ) -> Result<Option<crate::core::tool_context_bridge::PreparedContextFileCall>> {
        if let Some((session_id, id)) = context_identity(tool_use_id) {
            if session_id == self.session_id {
                return self.tool_context.prepare_file_call(&id, method, args);
            }
            return self.find_child(&session_id).ok_or_else(|| {
                Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
            })?.tool_context.prepare_file_call(&id, method, args);
        }
        self.tool_context.prepare_file_call(tool_use_id, method, args)
    }

    pub fn register_child(&self, child: Arc<NativeSession>) {
        self.children
            .lock()
            .unwrap()
            .insert(child.session_id.clone(), Arc::downgrade(&child));
        if self.end_hook_cancellation.is_cancelled() { child.cancel_end_hooks(); }
    }
    pub fn unregister_child(&self, session_id: &str) {
        let mut children = self.children.lock().unwrap();
        if let Some(child) = children.get(session_id).and_then(std::sync::Weak::upgrade) {
            self.remember_process_retirement(child.process_retirement());
        }
        children.remove(session_id);
    }
    fn remember_process_retirement(&self, retirement: Arc<crate::tools::ProcessRetirement>) {
        let mut retained = self.process_retirements.lock().unwrap();
        retained.retain(|owner| !owner.is_settled());
        if !retirement.is_settled() { retained.push(retirement); }
    }
    pub fn process_retirement(&self) -> Arc<crate::tools::ProcessRetirement> {
        let children: Vec<_> = self.children.lock().unwrap().values().filter_map(std::sync::Weak::upgrade).collect();
        let tools = self.tools.lock().unwrap().clone();
        let mut retained = self.process_retirements.lock().unwrap();
        retained.retain(|owner| !owner.is_settled());
        let owners = retained.clone();
        drop(retained);
        let mut result = crate::tools::ProcessRetirement::new(Vec::new(), Vec::new());
        if let Some(tools) = tools { result.append((*tools.process_retirement()).clone()); }
        for owner in owners { result.append((*owner).clone()); }
        for child in children { result.append((*child.process_retirement()).clone()); }
        Arc::new(result)
    }
    pub fn owned_process_count(&self) -> usize { self.process_retirement().count() }
    pub async fn reap_owned_processes(&self) -> Result<()> {
        self.wait_closed().await?;
        self.process_retirement().force_reap().await
    }
    fn find_child(&self, session_id: &str) -> Option<Arc<NativeSession>> {
        let children: Vec<_> = self
            .children
            .lock()
            .unwrap()
            .values()
            .filter_map(std::sync::Weak::upgrade)
            .collect();
        for child in children {
            if child.session_id == session_id {
                return Some(child);
            }
            if let Some(found) = child.find_child(session_id) {
                return Some(found);
            }
        }
        None
    }

    pub fn set_goal(&self, goal: Value) -> Result<Value> {
        if let Some(working) = &self.prepared_working {
            return working.set_goal(goal);
        }
        let tools = self
            .tools
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::new("SESSION_NOT_READY", "Session is not ready"))?;
        tools.set_goal(goal)
    }

    pub fn callback_response(&self, id: &str, value: Value, error: Option<Value>) -> Result<()> {
        self.callback_result(id, error.map_or_else(|| Ok(value), |error| Err(Error::from_host(error))))
    }

    pub(crate) fn callback_result(&self, id: &str, outcome: Result<Value>) -> Result<()> {
        if let Some(callback) = self.callbacks.lock().unwrap().remove(id) {
            let _ = callback.send(outcome);
        }
        Ok(())
    }

    pub(crate) fn take_inputs(&self) -> Vec<PendingInput> {
        let mut inbox = self.inbox.lock().unwrap();
        inbox.bytes = 0;
        inbox.inputs.drain(..).collect()
    }

    pub(crate) fn begin_turn(&self) -> Option<CancellationToken> {
        let mut inbox = self.inbox.lock().unwrap();
        if inbox.closed || !inbox.stream_requested || inbox.inputs.is_empty() {
            tracing::warn!(session_id=%self.session_id, closed=inbox.closed, queued=inbox.inputs.len(),"Turn admission skipped after stream ownership or queued input changed");
            return None;
        }
        self.running.store(true, std::sync::atomic::Ordering::Release);
        inbox.turn = self.lifetime.child_token();
        let turn = inbox.turn.clone();
        drop(inbox);
        self.ensure_work();
        Some(turn)
    }

    pub(crate) async fn envelope(&self, value: Value) -> Result<()> {
        tokio::select! {
            _ = self.lifetime.cancelled() => Err(Error::cancelled()),
            _ = self.closed.cancelled() => Err(Error::new("SESSION_CLOSED", "Session is closed")),
            result = self.output.send(value) => result.map_err(|_| Error::new("STREAM_CLOSED", "Session stream is closed")),
        }
    }
}

#[async_trait]
impl HostBridge for NativeSession {
    fn code_search_pool(&self) -> Option<Arc<crate::search::CodeSearchPool>> {
        self.services.code_search_pool.clone()
    }
    fn http_trust(&self) -> Option<Arc<crate::http::HostTrust>> { self.services.http_trust.clone() }
    fn resource_activity(&self) -> Option<Arc<crate::resource_activity::ResourceActivity>> {
        Some(self.resources.clone())
    }
    async fn call(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        if cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.callbacks.lock().unwrap().insert(id.clone(), sender);
        let _pending = PendingCallback {
            session: self,
            id: id.clone(),
        };
        tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::cancelled()),
            _ = self.closed.cancelled() => return Err(Error::cancelled()),
            result = self.output.send(json!({"kind":"callback","id":id,"method":method,"params":params})) => result.map_err(|_| Error::new("STREAM_CLOSED", "Session stream is closed"))?,
        }
        tokio::select! {
            result = receiver => result.map_err(|_| Error::cancelled())?,
            _ = cancellation.cancelled() => Err(Error::cancelled()),
            _ = self.closed.cancelled() => Err(Error::cancelled()),
        }
    }
}

#[async_trait]
impl crate::core::loop_owner::LoopOutput for NativeSession {
    async fn publish(
        &self,
        event: Value,
        progress: crate::core::loop_owner::ProgressTiming,
    ) -> Result<()> {
        if matches!(progress, crate::core::loop_owner::ProgressTiming::Before) {
            let cancellation = self.inbox.lock().unwrap().turn.clone();
            self.event_flow
                .publish(event, progress, &cancellation, |envelope| {
                    self.envelope(envelope)
                })
                .await
        } else {
            self.emit(event).await
        }
    }
}

#[async_trait]
impl EventSink for NativeSession {
    async fn emit(&self, event: Value) -> Result<()> {
        let admission = event["type"] == "system"
            && (event["subtype"] == "init"
                || (event["subtype"] == "session_state_changed" && event["state"] == "running"));
        let tool_result = event["type"] == "user" && event["isReplay"] != true
            && event["message"]["content"].as_array().is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"));
        if admission || tool_result {
            let cancellation = self.inbox.lock().unwrap().turn.clone();
            self.event_flow
                .publish(
                    event,
                    crate::core::loop_owner::ProgressTiming::None,
                    &cancellation,
                    |envelope| self.envelope(envelope),
                )
                .await
        } else {
            self.envelope(json!({"kind":"event","event":event})).await
        }
    }
}

fn normalize_input(input: Value) -> Value {
    if input.is_string() {
        return input;
    }
    let inner = if input["type"] == "user" && input["message"].is_object() {
        &input["message"]
    } else if input["role"] == "user" {
        &input
    } else {
        return json!(crate::js::stringify(&input));
    };
    match &inner["content"] {
        Value::String(text) => json!(text),
        Value::Array(blocks) => json!({"role":"user","content":blocks}),
        Value::Null => json!(""),
        Value::Object(_) => json!("[object Object]"),
        value => json!(crate::js::stringify(value)),
    }
}

fn context_identity(value: &str) -> Option<(String, String)> {
    let identity: Vec<String> = serde_json::from_str(value).ok()?;
    if identity.len() != 2 {
        return None;
    }
    Some((identity[0].clone(), identity[1].clone()))
}
