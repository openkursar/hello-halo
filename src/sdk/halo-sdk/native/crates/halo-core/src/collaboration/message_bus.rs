use super::{
    protocol,
    runtime::TurnCompletion,
    turn_gate::{BusyDisposition, DeliverDisposition, TurnGate, TurnGateHooks, TurnGateOptions},
};
use crate::error::{Error, Result};
use crate::harness::{baseline, ResolvedHarness, TextId};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub trait MessageBusStore: Send + Sync {
    fn member(&self, team: &str, id: &str, epoch: Option<&str>) -> Option<Value>;
    fn member_by_name(&self, team: &str, name: &str, epoch: Option<&str>) -> Option<Value>;
    fn members(&self, team: &str, epoch: Option<&str>) -> Vec<Value>;
    fn edge_allowed(&self, team: &str, from: &str, to: &str, epoch: Option<&str>) -> bool;
    fn team(&self, id: &str) -> Option<Value>;
    fn epoch(&self, id: &str) -> Option<Value>;
    fn try_member(&self, team: &str, id: &str, epoch: Option<&str>) -> Result<Option<Value>> {
        Ok(self.member(team, id, epoch))
    }
    fn try_member_by_name(
        &self,
        team: &str,
        name: &str,
        epoch: Option<&str>,
    ) -> Result<Option<Value>> {
        Ok(self.member_by_name(team, name, epoch))
    }
    fn try_members(&self, team: &str, epoch: Option<&str>) -> Result<Vec<Value>> {
        Ok(self.members(team, epoch))
    }
    fn try_edge_allowed(
        &self,
        team: &str,
        from: &str,
        to: &str,
        epoch: Option<&str>,
    ) -> Result<bool> {
        Ok(self.edge_allowed(team, from, to, epoch))
    }
    fn try_team(&self, id: &str) -> Result<Option<Value>> {
        Ok(self.team(id))
    }
    fn try_epoch(&self, id: &str) -> Result<Option<Value>> {
        Ok(self.epoch(id))
    }
}
pub enum RecipientFence {
    Absent,
    Immediate(String),
    Pending(Pin<Box<dyn Future<Output = Result<String>> + Send>>),
}
#[async_trait]
pub trait DeliveryHooks: Send + Sync {
    fn acquire_recipient_fence(&self, _target: Value) -> RecipientFence {
        RecipientFence::Absent
    }
    fn accept_recipient_fence(&self, _target: &Value, _fence: Option<&str>) -> bool {
        true
    }
    async fn wake_target(&self, request: Value) -> Result<()>;
    fn is_busy(&self, key: &str) -> bool;
    fn turn_identity(&self, _key: &str) -> Option<String> {
        None
    }
    fn deliver_mid_turn(&self, _request: Value) -> Result<bool> {
        Ok(false)
    }
    fn deliver_remote(
        &self,
        _request: Value,
        _complete: Arc<dyn Fn(TurnCompletion) + Send + Sync>,
    ) -> Result<Option<bool>> {
        Ok(None)
    }
    fn reachable(&self, _app: &str, _team: &str) -> bool {
        true
    }
    async fn deliver_to_coordinator(&self, _request: Value) -> Result<Option<String>> {
        Ok(None)
    }
    fn try_acquire_recipient_fence(&self, target: Value) -> Result<RecipientFence> {
        Ok(self.acquire_recipient_fence(target))
    }
    fn try_accept_recipient_fence(&self, target: &Value, fence: Option<&str>) -> Result<bool> {
        Ok(self.accept_recipient_fence(target, fence))
    }
    fn try_is_busy(&self, key: &str) -> Result<bool> {
        Ok(self.is_busy(key))
    }
    fn try_turn_identity(&self, key: &str) -> Result<Option<String>> {
        Ok(self.turn_identity(key))
    }
    fn try_reachable(&self, app: &str, team: &str) -> Result<bool> {
        Ok(self.reachable(app, team))
    }
}
pub type Observer = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;
pub struct MessageBusOptions {
    pub max_messages: usize,
    pub max_forward_depth: usize,
    pub sync_wait_timeout_ms: u64,
    pub reservation_ttl_ms: Option<u64>,
    pub on_message: Option<Observer>,
    pub record_activity: Option<Observer>,
    pub harness: Arc<ResolvedHarness>,
}
impl Default for MessageBusOptions {
    fn default() -> Self {
        Self {
            max_messages: 2000,
            max_forward_depth: 999,
            sync_wait_timeout_ms: 2 * 60 * 60 * 1000,
            reservation_ttl_ms: None,
            on_message: None,
            record_activity: None,
            harness: baseline(),
        }
    }
}
struct Pending {
    sender: oneshot::Sender<Value>,
    target: String,
    source: Option<String>,
    name: String,
    team: String,
    epoch: String,
    timer: CancellationToken,
    harness: Arc<ResolvedHarness>,
}
struct TextScope {
    epoch: String,
    harness: Arc<ResolvedHarness>,
}
struct State {
    pending: HashMap<String, Pending>,
    stats: HashMap<String, Value>,
    cancelled: HashSet<String>,
    generations: HashMap<String, u64>,
    listeners: HashMap<u64, Observer>,
    next_listener: u64,
    text_scopes: HashMap<String, TextScope>,
}
pub struct MessageBus {
    pub gate: Arc<TurnGate>,
    store: Arc<dyn MessageBusStore>,
    hooks: Arc<dyn DeliveryHooks>,
    options: MessageBusOptions,
    state: Mutex<State>,
    lifetime: CancellationToken,
}
struct GateAdapter(Weak<MessageBus>);
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn items(job: &Value) -> Vec<Value> {
    job["deliveries"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![job.clone()])
}
fn target(envelope: &Value) -> Value {
    json!({"teamId":envelope["teamId"],"epochId":envelope["epochId"],"appId":envelope["toAppId"]})
}
fn stopped_unread(harness: &ResolvedHarness) -> TurnCompletion {
    TurnCompletion::Error {
        message: harness
            .text(TextId::CollaborationDeliveryStoppedBeforeRead)
            .into(),
    }
}
pub fn is_persons_own_delivery(trigger: &Value) -> bool {
    trigger["kind"] == "human_message" && !crate::js::truthy(&trigger["origin"])
}

#[async_trait]
impl TurnGateHooks for GateAdapter {
    async fn dispatch(&self, key: &str, job: Value) -> Result<()> {
        let bus = self.0.upgrade().ok_or_else(|| {
            Error::new("TeamBusError", "").with_harness(TextId::CollaborationFeedbackClosed, &[])
        })?;
        bus.assert_recipient(&job["envelope"], &job["trigger"])?;
        let result = bus.hooks.wake_target(bus.request(key, &job)).await;
        if result.is_ok() {
            for item in items(&job).iter().skip(1) {
                bus.release_context(&item["trigger"]);
            }
        }
        result
    }
    fn is_busy(&self, key: &str) -> bool {
        self.0.upgrade().is_some_and(|bus| bus.hooks.is_busy(key))
    }
    fn try_is_busy(&self, key: &str) -> Result<bool> {
        self.0
            .upgrade()
            .map_or(Ok(false), |bus| bus.hooks.try_is_busy(key))
    }
    fn job_identity(&self, job: &Value) -> Option<String> {
        Some(job["trigger"]["origin"].as_str().unwrap_or("owner").into())
    }
    fn active_identity(&self, key: &str) -> Option<String> {
        self.0
            .upgrade()
            .and_then(|bus| bus.hooks.turn_identity(key))
    }
    fn try_active_identity(&self, key: &str) -> Result<Option<String>> {
        self.0
            .upgrade()
            .map_or(Ok(None), |bus| bus.hooks.try_turn_identity(key))
    }
    fn supports_merge(&self) -> bool {
        true
    }
    fn merge_jobs(&self, jobs: &[Value]) -> Value {
        let mut merged = jobs[0].clone();
        merged["deliveries"] = jobs.iter().flat_map(items).collect::<Vec<_>>().into();
        merged
    }
    fn refresh_job(&self, job: &Value) -> Result<Option<Value>> {
        let Some(bus) = self.0.upgrade() else {
            return Ok(None);
        };
        let previous = items(job);
        let mut current = Vec::new();
        for item in &previous {
            if bus.hooks.try_accept_recipient_fence(
                &target(&item["envelope"]),
                item["trigger"]["recipientFence"]
                    .as_str()
                    .or(item["envelope"]["recipientFence"].as_str()),
            )? {
                current.push(item.clone());
            }
        }
        if current.len() == previous.len() {
            return Ok(Some(job.clone()));
        }
        tracing::warn!(
            "[TeamBus] Expired recipient deliveries discarded: team={} app={} count={}",
            text(&job["envelope"], "teamId"),
            text(&job["envelope"], "toAppId"),
            previous.len() - current.len()
        );
        for item in previous {
            if !current.contains(&item) && item["trigger"]["wait"] == true {
                bus.resolve_pending(
                    text(&item["trigger"], "correlationId"),
                    stopped_unread(&bus.context_for(&item["trigger"])),
                );
            }
            if !current.contains(&item) {
                bus.release_context(&item["trigger"]);
            }
        }
        if current.is_empty() {
            Ok(None)
        } else {
            let mut refreshed = job.clone();
            refreshed["deliveries"] = current.into();
            Ok(Some(refreshed))
        }
    }
    fn deliver_mid_turn(&self, key: &str, job: Value) -> Result<bool> {
        let Some(bus) = self.0.upgrade() else {
            return Ok(false);
        };
        bus.assert_recipient(&job["envelope"], &job["trigger"])?;
        let accepted = bus.hooks.deliver_mid_turn(bus.request(key, &job))?;
        if accepted {
            for item in items(&job) {
                bus.release_context(&item["trigger"]);
            }
        }
        Ok(accepted)
    }
    fn coalescing_key(&self, job: &Value) -> Option<String> {
        job["coalescingKey"].as_str().map(String::from)
    }
    fn discard(&self, job: Value, _reason: &str) -> Result<()> {
        if let Some(bus) = self.0.upgrade() {
            for item in items(&job) {
                bus.release_context(&item["trigger"]);
            }
        }
        Ok(())
    }
}

impl MessageBus {
    pub fn new(
        store: Arc<dyn MessageBusStore>,
        hooks: Arc<dyn DeliveryHooks>,
        options: MessageBusOptions,
    ) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            gate: TurnGate::new(
                Arc::new(GateAdapter(weak.clone())),
                TurnGateOptions {
                    reservation_ttl_ms: options.reservation_ttl_ms,
                    ..Default::default()
                },
            )
            .expect("default mailbox capacity is valid"),
            store,
            hooks,
            options,
            lifetime: CancellationToken::new(),
            state: Mutex::new(State {
                pending: HashMap::new(),
                stats: HashMap::new(),
                cancelled: HashSet::new(),
                generations: HashMap::new(),
                listeners: HashMap::new(),
                next_listener: 0,
                text_scopes: HashMap::new(),
            }),
        })
    }
    pub fn abort_now(&self) {
        self.lifetime.cancel();
        self.gate.abort_now();
        let pending = {
            let mut state = self.state.lock().unwrap();
            state.listeners.clear();
            state.text_scopes.clear();
            std::mem::take(&mut state.pending)
        };
        for pending in pending.into_values() {
            pending.timer.cancel();
        }
    }
    fn context_for(&self, trigger: &Value) -> Arc<ResolvedHarness> {
        self.state
            .lock()
            .unwrap()
            .text_scopes
            .get(text(trigger, "correlationId"))
            .map(|scope| scope.harness.clone())
            .unwrap_or_else(|| self.options.harness.clone())
    }
    fn release_context(&self, trigger: &Value) {
        self.state
            .lock()
            .unwrap()
            .text_scopes
            .remove(text(trigger, "correlationId"));
    }
    fn request(&self, key: &str, job: &Value) -> Value {
        json!({"sessionKey":key,"appId":job["envelope"]["toAppId"],"teamId":job["envelope"]["teamId"],"epochId":job["envelope"]["epochId"],"envelope":job["envelope"],"trigger":job["trigger"],"deliveries":items(job)})
    }
    pub fn resolve_member(&self, team: &str, name: &str, epoch: Option<&str>) -> Result<String> {
        let lead = if name == protocol::LEAD {
            self.store.try_team(team)?.and_then(|v| {
                v["leadAppId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            })
        } else {
            None
        };
        let member = if let Some(lead) = lead {
            self.store.try_member(team, &lead, epoch)?
        } else {
            match self.store.try_member(team, name, epoch)? {
                Some(member) => Some(member),
                None => self.store.try_member_by_name(team, name, epoch)?,
            }
        };
        member
            .and_then(|v| v["appId"].as_str().map(String::from))
            .ok_or_else(|| {
                tracing::warn!(
                    "[TeamBus] Recipient unavailable: team={team} epoch={}",
                    epoch.unwrap_or("standing")
                );
                Error::new("UnknownMemberError", "")
                    .with_harness(
                        TextId::CollaborationDeliveryUnknownMember,
                        &[("name", name.into())],
                    )
                    .with_details(json!({"memberName":name}))
            })
    }
    pub fn assert_can_contact(
        &self,
        team: &str,
        from: &str,
        to: &str,
        mode: &str,
        epoch: Option<&str>,
    ) -> Result<()> {
        if mode == "free"
            || self.store.try_edge_allowed(team, from, to, epoch)?
            || self.store.try_edge_allowed(team, to, from, epoch)?
        {
            return Ok(());
        }
        let member = self.store.try_member(team, to, epoch)?;
        let name = member
            .as_ref()
            .and_then(|v| v["memberName"].as_str())
            .unwrap_or(to);
        Err(Error::new("TopologyError", "")
            .with_harness(
                TextId::CollaborationDeliveryContactForbidden,
                &[("name", name.into())],
            )
            .with_details(json!({"toMemberName":name})))
    }
    fn default_stats() -> Value {
        json!({"messageCount":0,"maxForwardDepthSeen":0,"firstSendAt":null,"breached":false,"breachReason":null})
    }
    pub fn epoch_stats(&self, epoch: &str) -> Value {
        self.state
            .lock()
            .unwrap()
            .stats
            .entry(epoch.into())
            .or_insert_with(Self::default_stats)
            .clone()
    }
    pub fn on_breach(&self, observer: Observer) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.next_listener += 1;
        let id = state.next_listener;
        state.listeners.insert(id, observer);
        id
    }
    pub fn remove_breach_listener(&self, id: u64) {
        self.state.lock().unwrap().listeners.remove(&id);
    }
    pub fn trip_external(&self, team: &str, epoch: &str, reason: &str) {
        let event = {
            let mut state = self.state.lock().unwrap();
            let stats = state
                .stats
                .entry(epoch.into())
                .or_insert_with(Self::default_stats);
            if stats["breached"] == true {
                return;
            }
            stats["breached"] = true.into();
            stats["breachReason"] = reason.into();
            json!({"teamId":team,"epochId":epoch,"reason":reason,"limits":{"maxMessages":self.options.max_messages,"maxForwardDepth":self.options.max_forward_depth},"stats":stats})
        };
        tracing::warn!("[TeamBus] Circuit breaker tripped: epoch={epoch} reason={reason}");
        let observers = self
            .state
            .lock()
            .unwrap()
            .listeners
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for observer in observers {
            if let Err(error) = observer(event.clone()) {
                tracing::warn!("[TeamBus] onBreach listener threw: {error}");
            }
        }
    }
    fn charge(&self, team: &str, epoch: &str, depth: usize) -> Result<()> {
        let breached = {
            let mut state = self.state.lock().unwrap();
            let stats = state
                .stats
                .entry(epoch.into())
                .or_insert_with(Self::default_stats);
            if stats["firstSendAt"].is_null() {
                stats["firstSendAt"] = protocol::now().into();
            }
            let count = stats["messageCount"].as_u64().unwrap_or(0) as usize;
            if depth > self.options.max_forward_depth {
                Some((
                    "maxForwardDepth",
                    TextId::CollaborationDeliveryForwardDepthLimit,
                    self.options.max_forward_depth.to_string(),
                ))
            } else if count >= self.options.max_messages {
                Some((
                    "maxMessages",
                    TextId::CollaborationDeliveryMessageLimit,
                    self.options.max_messages.to_string(),
                ))
            } else {
                stats["messageCount"] = (count + 1).into();
                stats["maxForwardDepthSeen"] = depth
                    .max(stats["maxForwardDepthSeen"].as_u64().unwrap_or(0) as usize)
                    .into();
                None
            }
        };
        if let Some((reason, template, limit)) = breached {
            self.trip_external(team, epoch, reason);
            Err(Error::new("CircuitBreakerError", "")
                .with_harness(template, &[("limit", limit.into())])
                .with_details(json!({"reason":reason})))
        } else {
            Ok(())
        }
    }
    pub fn reset_circuit(&self, epoch: &str) {
        self.state.lock().unwrap().stats.remove(epoch);
    }
    fn record(&self, input: Value) {
        if let Some(observer) = &self.options.record_activity {
            if let Err(error) = observer(input) {
                tracing::warn!("[TeamBus] recordActivity failed (the act itself stands): {error}");
            }
        }
    }
    fn message_event(&self, envelope: &Value, from: &str) -> Result<()> {
        let team = text(envelope, "teamId");
        let epoch = text(envelope, "epochId");
        let to = text(envelope, "toAppId");
        let name = |id: &str| -> Result<String> {
            Ok(self
                .store
                .try_member(team, id, Some(epoch))?
                .and_then(|v| v["memberName"].as_str().map(String::from))
                .unwrap_or(id.into()))
        };
        let event = json!({"teamId":team,"epochId":epoch,"fromAppId":from,"toAppId":to,"fromMemberName":name(from)?,"toMemberName":name(to)?,"messageId":envelope["id"],"ts":envelope["createdAt"]});
        let Some(observer) = &self.options.on_message else {
            return Ok(());
        };
        if let Err(error) = observer(event) {
            tracing::warn!(
                "[TeamBus] Message observer failed: team={team} epoch={epoch} message={}: {error}",
                text(envelope, "id")
            );
        }
        Ok(())
    }
    fn assert_recipient(&self, envelope: &Value, trigger: &Value) -> Result<()> {
        if let (Some(a), Some(b)) = (
            envelope.get("recipientFence"),
            trigger.get("recipientFence"),
        ) {
            if a != b {
                return Err(Error::new(
                    "TeamBusError",
                    "The message recipient incarnation is inconsistent.",
                ));
            }
        }
        if !self.hooks.try_accept_recipient_fence(
            &target(envelope),
            trigger["recipientFence"]
                .as_str()
                .or(envelope["recipientFence"].as_str()),
        )? {
            return Err(Error::new("TeamBusError", "")
                .with_harness(TextId::CollaborationDeliveryRecipientExpired, &[]));
        }
        Ok(())
    }
    fn stamp_start(
        &self,
        envelope: &mut Value,
        trigger: &mut Value,
    ) -> Result<Option<Pin<Box<dyn Future<Output = Result<String>> + Send>>>> {
        if trigger.get("recipientFence").is_none() {
            if let Some(fence) = envelope.get("recipientFence") {
                trigger["recipientFence"] = fence.clone();
            }
        }
        if trigger.get("recipientFence").is_none() {
            let mut request = target(envelope);
            request["fromAppId"] = trigger["fromAppId"].clone();
            if let Some(id) = trigger.get("requestId") {
                request["requestId"] = id.clone();
            }
            match self.hooks.try_acquire_recipient_fence(request)? {
                RecipientFence::Absent => {}
                RecipientFence::Immediate(ticket) => {
                    trigger["recipientFence"] = ticket.clone().into();
                    envelope["recipientFence"] = ticket.into();
                }
                RecipientFence::Pending(future) => return Ok(Some(future)),
            }
        }
        self.assert_recipient(envelope, trigger)?;
        Ok(None)
    }
    async fn stamp(&self, envelope: &mut Value, trigger: &mut Value) -> Result<()> {
        if let Some(pending) = self.stamp_start(envelope, trigger)? {
            let ticket = tokio::select! { _=self.lifetime.cancelled()=>return Err(Error::cancelled()), result=pending=>result? };
            trigger["recipientFence"] = ticket.clone().into();
            envelope["recipientFence"] = ticket.into();
            self.assert_recipient(envelope, trigger)?;
        }
        Ok(())
    }
    pub async fn deliver_runtime_wake(
        self: &Arc<Self>,
        envelope: &mut Value,
        trigger: &mut Value,
        on_busy: BusyDisposition,
        coalescing: Option<&str>,
    ) -> Result<String> {
        if self.lifetime.is_cancelled() {
            return Err(Error::cancelled());
        }
        self.stamp(envelope, trigger).await?;
        self.deliver_stamped(
            envelope.clone(),
            trigger.clone(),
            on_busy,
            coalescing,
            self.options.harness.clone(),
        )
        .await
    }
    async fn deliver_stamped(
        self: &Arc<Self>,
        envelope: Value,
        trigger: Value,
        on_busy: BusyDisposition,
        coalescing: Option<&str>,
        harness: Arc<ResolvedHarness>,
    ) -> Result<String> {
        self.assert_recipient(&envelope, &trigger)?;
        let key = protocol::session_key(
            text(&envelope, "toAppId"),
            text(&envelope, "teamId"),
            text(&envelope, "epochId"),
        );
        if self.state.lock().unwrap().cancelled.contains(&key) {
            return Err(Error::new("TeamBusError", "")
                .with_harness(TextId::CollaborationDeliveryRecipientStopped, &[]));
        }
        if protocol::parse_coordinator_id(text(&envelope, "toAppId")).is_some() {
            let mut request = json!({"envelope":envelope,"trigger":trigger});
            if let Some(key) = coalescing {
                request["coalescingKey"] = key.into();
            }
            let delivered = tokio::select! { _=self.lifetime.cancelled()=>return Err(Error::cancelled()), result=self.hooks.deliver_to_coordinator(request)=>result };
            return match delivered {
                Ok(Some(disposition)) => Ok(disposition),
                Ok(None) => Err(Error::new("TeamBusError", "")
                    .with_harness(TextId::CollaborationDeliveryCoordinatorUnreachable, &[])),
                Err(error) => {
                    if trigger["kind"] != "member_stopped" {
                        self.record_delivery_outcome_with_harness(
                            &envelope,
                            &trigger,
                            &TurnCompletion::Undelivered {
                                reason: error.message.clone(),
                            },
                            &harness,
                        );
                    }
                    Err(error)
                }
            };
        }
        if self
            .store
            .try_member(
                text(&envelope, "teamId"),
                text(&envelope, "toAppId"),
                Some(text(&envelope, "epochId")),
            )?
            .is_some_and(|v| protocol::is_remote(&v))
        {
            let mut request = json!({"sessionKey":key,"envelope":envelope,"trigger":trigger});
            if let Some(key) = coalescing {
                request["coalescingKey"] = key.into();
            }
            let weak = Arc::downgrade(self);
            let sent = envelope.clone();
            let context = trigger.clone();
            let callback_harness = harness.clone();
            let completed = Arc::new(move |outcome: TurnCompletion| {
                if let Some(bus) = weak.upgrade() {
                    bus.record_delivery_outcome_with_harness(
                        &sent,
                        &context,
                        &outcome,
                        &callback_harness,
                    );
                    if context["wait"] == true {
                        bus.resolve_pending(text(&context, "correlationId"), outcome);
                    }
                }
            });
            match self.hooks.deliver_remote(request, completed)? {
                Some(true) => return Ok("remote_accepted".into()),
                Some(false) => {
                    return Err(Error::new("TeamBusError", "")
                        .with_harness(TextId::CollaborationDeliveryRemoteRefused, &[]))
                }
                None => {}
            }
        }
        let generation = self
            .state
            .lock()
            .unwrap()
            .generations
            .get(&key)
            .copied()
            .unwrap_or(0);
        let mut job = json!({"envelope":envelope,"trigger":trigger});
        if let Some(value) = coalescing {
            job["coalescingKey"] = value.into();
        }
        job["admissionGeneration"] = generation.into();
        let trigger = job["trigger"].clone();
        if !Arc::ptr_eq(&harness, &self.options.harness) {
            self.state.lock().unwrap().text_scopes.insert(
                text(&trigger, "correlationId").into(),
                TextScope {
                    epoch: text(&trigger, "epochId").into(),
                    harness,
                },
            );
        }
        let disposition = match self.gate.deliver(&key, job, on_busy).await {
            Ok(disposition) => disposition,
            Err(error) => {
                self.release_context(&trigger);
                return Err(error);
            }
        };
        if matches!(
            disposition,
            DeliverDisposition::MidTurn | DeliverDisposition::Skipped
        ) {
            self.release_context(&trigger);
        }
        Ok(match disposition {
            DeliverDisposition::Dispatched => "dispatched",
            DeliverDisposition::MidTurn => "mid_turn",
            DeliverDisposition::Buffered => "buffered",
            DeliverDisposition::Skipped => "skipped",
        }
        .into())
    }
    pub async fn send(self: &Arc<Self>, input: Value) -> Result<Value> {
        self.send_with_harness(input, self.options.harness.clone())
            .await
    }
    pub async fn send_with_harness(
        self: &Arc<Self>,
        input: Value,
        harness: Arc<ResolvedHarness>,
    ) -> Result<Value> {
        if self.lifetime.is_cancelled() {
            return Err(Error::cancelled());
        }
        let team = text(&input, "teamId");
        let epoch = text(&input, "epochId");
        let to = text(&input, "to");
        let target_id = self.resolve_member(team, to, Some(epoch))?;
        let coordinator = protocol::parse_coordinator_id(&target_id).is_some();
        let from = input["fromAppId"].as_str().filter(|s| !s.is_empty());
        let wait = input["wait"] == true;
        let depth = input["forwardDepth"].as_u64().unwrap_or(0) as usize;
        if !wait && !coordinator && !self.hooks.try_reachable(&target_id, team)? {
            tracing::warn!("[TeamBus] send: target owner unreachable, not delivered: team={team} to={to} app={target_id}");
            let id = protocol::id();
            if let Some(from) = from {
                self.record(json!({"teamId":team,"epochId":epoch,"id":id,"kind":"message","actorAppId":from,"targetAppId":target_id,"subject":protocol::activity_subject_with_harness(text(&input,"message"),80, &harness),"body":input["message"],"refId":id,"status":"undelivered"}));
            }
            return Ok(json!({"messageId":id,"delivery":"undelivered"}));
        }
        if from.is_some() {
            self.charge(team, epoch, depth)?;
        }
        let correlation = protocol::id();
        let mut envelope = json!({"id":protocol::id(),"teamId":team,"epochId":epoch,"fromAppId":input["fromAppId"],"toAppId":target_id,"body":input["message"],"correlationId":correlation});
        for field in ["requestId", "taskRef"] {
            if let Some(value) = input.get(field) {
                envelope[field] = value.clone();
            }
        }
        envelope["createdAt"] = protocol::now().into();
        let mut trigger = json!({"teamId":team,"epochId":epoch,"correlationId":correlation,"fromAppId":input["fromAppId"],"wait":wait});
        for (field, source) in [("requestId", "requestId"), ("taskId", "taskRef")] {
            if let Some(value) = input.get(source) {
                trigger[field] = value.clone();
            }
        }
        trigger["kind"] = if from.is_some() {
            "message"
        } else {
            "human_message"
        }
        .into();
        if let Some(from) = from {
            trigger["controller"] = json!({"appId":from});
            if crate::js::truthy(&input["origin"]) {
                trigger["controller"]["origin"] = input["origin"].clone();
            }
        }
        if crate::js::truthy(&input["origin"]) {
            trigger["origin"] = input["origin"].clone();
        }
        trigger["forwardDepth"] = (depth + 1).into();
        self.stamp(&mut envelope, &mut trigger).await?;
        if let Some(from) = from {
            self.message_event(&envelope, from)?;
            self.record(json!({"teamId":team,"epochId":epoch,"id":envelope["id"],"kind":"message","actorAppId":from,"targetAppId":target_id,"subject":protocol::activity_subject_with_harness(text(&input,"message"),80, &harness),"body":input["message"],"refId":envelope["id"],"correlationId":correlation,"status":"sent"}));
        }
        if wait && coordinator {
            self.deliver_stamped(
                envelope,
                trigger,
                BusyDisposition::Buffer,
                None,
                harness.clone(),
            )
            .await?;
            return Ok(
                json!({"from":to,"message":harness.text(TextId::CollaborationDeliveryCoordinatorReceipt),"status":"ok"}),
            );
        }
        if !wait {
            let disposition = self
                .deliver_stamped(
                    envelope.clone(),
                    trigger,
                    BusyDisposition::Buffer,
                    None,
                    harness.clone(),
                )
                .await?;
            let remote = self
                .store
                .try_member(team, &target_id, Some(epoch))?
                .is_some_and(|v| protocol::is_remote(&v));
            let mut result = json!({"messageId":envelope["id"]});
            if !coordinator {
                if disposition == "buffered" {
                    result["delivery"] = "queued".into();
                } else if disposition == "mid_turn" {
                    result["delivery"] = "mid_turn".into();
                }
            }
            if remote {
                result["remoteTarget"] = true.into();
            }
            return Ok(result);
        }
        let (sender, receiver) = oneshot::channel();
        let timer = CancellationToken::new();
        self.state.lock().unwrap().pending.insert(
            correlation.clone(),
            Pending {
                sender,
                target: target_id,
                source: from.map(String::from),
                name: to.into(),
                team: team.into(),
                epoch: epoch.into(),
                timer: timer.clone(),
                harness: harness.clone(),
            },
        );
        let weak = Arc::downgrade(self);
        let receipt = correlation.clone();
        let timeout = self.options.sync_wait_timeout_ms;
        crate::runtime::spawn(async move {
            tokio::select! {_=timer.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(timeout))=>{}}
            if let Some(bus) = weak.upgrade() {
                if bus.resolve_pending(&receipt, TurnCompletion::Timeout) {
                    tracing::warn!("[TeamBus] completion receipt timed out: corr={receipt}");
                }
            }
        });
        let bus = self.clone();
        let name = to.to_owned();
        crate::runtime::spawn(async move {
            match bus
                .deliver_stamped(envelope, trigger, BusyDisposition::Buffer, None, harness)
                .await
            {
                Ok(disposition) if disposition == "buffered" || disposition == "mid_turn" => {
                    bus.settle(&correlation,json!({"from":name,"message":"","status":if disposition=="mid_turn"{"mid_turn"}else{"queued"}}));
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!("[TeamBus] wakeTarget failed for a receipted send: {error}");
                    bus.settle(
                        &correlation,
                        json!({"from":name,"message":"","status":"timeout"}),
                    );
                }
            }
        });
        receiver.await.map_err(|_| {
            Error::new(
                "TeamBusError",
                "The completion receipt was released without a result.",
            )
        })
    }
    fn settle(&self, correlation: &str, result: Value) -> bool {
        let pending = self.state.lock().unwrap().pending.remove(correlation);
        if let Some(pending) = pending {
            pending.timer.cancel();
            let _ = pending.sender.send(result);
            true
        } else {
            false
        }
    }
    fn receipt(
        name: &str,
        outcome: &TurnCompletion,
        offline: bool,
        harness: &ResolvedHarness,
    ) -> Value {
        let (message, status) = match outcome {
            TurnCompletion::Timeout => (
                if offline {
                    harness.render(
                        TextId::CollaborationReceiptOfflineTimeout,
                        &[("name", name)],
                    )
                } else {
                    String::new()
                },
                "timeout",
            ),
            TurnCompletion::Undelivered { .. } => (
                if offline {
                    harness.render(
                        TextId::CollaborationReceiptOfflineUndelivered,
                        &[("name", name)],
                    )
                } else {
                    harness.text(TextId::CollaborationReceiptUndelivered).into()
                },
                "undelivered",
            ),
            TurnCompletion::Error { message } => (
                harness.render(TextId::CollaborationReceiptFailed, &[("message", message)]),
                "ok",
            ),
            TurnCompletion::Result { content, .. } | TurnCompletion::Escalation { content } => {
                (content.clone(), "ok")
            }
        };
        json!({"from":name,"message":message,"status":status})
    }
    pub fn resolve_pending(&self, correlation: &str, outcome: TurnCompletion) -> bool {
        let pending = self.state.lock().unwrap().pending.remove(correlation);
        if let Some(pending) = pending {
            pending.timer.cancel();
            let _ = pending.sender.send(Self::receipt(
                &pending.name,
                &outcome,
                false,
                &pending.harness,
            ));
            true
        } else {
            false
        }
    }
    fn recordable(outcome: &TurnCompletion) -> bool {
        matches!(
            outcome,
            TurnCompletion::Error { .. }
                | TurnCompletion::Timeout
                | TurnCompletion::Undelivered { .. }
        )
    }
    fn status(outcome: &TurnCompletion) -> &str {
        match outcome {
            TurnCompletion::Result { .. } => "ok",
            TurnCompletion::Escalation { .. } => "escalation",
            TurnCompletion::Error { .. } => "error",
            TurnCompletion::Timeout => "timeout",
            TurnCompletion::Undelivered { .. } => "undelivered",
        }
    }
    pub fn describe_completion(outcome: &TurnCompletion) -> String {
        Self::describe_completion_with_harness(outcome, &baseline())
    }
    pub fn describe_completion_with_harness(
        outcome: &TurnCompletion,
        harness: &ResolvedHarness,
    ) -> String {
        match outcome {
            TurnCompletion::Result { content, .. } => {
                let content = crate::js::trim_js(content);
                if content.is_empty() {
                    harness
                        .text(TextId::CollaborationActivityEmptyResult)
                        .into()
                } else {
                    content.into()
                }
            }
            TurnCompletion::Escalation { content } => content.clone(),
            TurnCompletion::Error { message } => {
                harness.render(TextId::CollaborationActivityFailed, &[("message", message)])
            }
            TurnCompletion::Timeout => harness.text(TextId::CollaborationActivityTimeout).into(),
            TurnCompletion::Undelivered { reason } => harness.render(
                TextId::CollaborationActivityUndelivered,
                &[("reason", reason)],
            ),
        }
    }
    fn record_reply(&self, trigger: &Value, finisher: &str, outcome: &TurnCompletion) {
        self.record_reply_with_harness(trigger, finisher, outcome, &self.context_for(trigger));
    }
    fn record_reply_with_harness(
        &self,
        trigger: &Value,
        finisher: &str,
        outcome: &TurnCompletion,
        harness: &ResolvedHarness,
    ) {
        if !crate::js::truthy(&trigger["fromAppId"])
            || trigger["kind"] != "message"
            || !Self::recordable(outcome)
        {
            return;
        }
        self.record(json!({"teamId":trigger["teamId"],"epochId":trigger["epochId"],"kind":"reply","actorAppId":finisher,"targetAppId":trigger["fromAppId"],"subject":protocol::activity_subject_with_harness(&Self::describe_completion_with_harness(outcome,harness),80,harness),"correlationId":trigger["correlationId"],"status":Self::status(outcome)}));
    }
    fn record_delivery_outcome_with_harness(
        &self,
        envelope: &Value,
        trigger: &Value,
        outcome: &TurnCompletion,
        harness: &ResolvedHarness,
    ) {
        self.record_reply_with_harness(trigger, text(envelope, "toAppId"), outcome, harness);
        if crate::js::truthy(&trigger["kind"])
            && trigger["kind"] != "message"
            && trigger["kind"] != "human_message"
            && Self::recordable(outcome)
        {
            self.record(json!({"teamId":envelope["teamId"],"epochId":envelope["epochId"],"kind":"reply","actorAppId":envelope["toAppId"],"targetAppId":envelope["fromAppId"],"subject":protocol::activity_subject_with_harness(&Self::describe_completion_with_harness(outcome,harness),80,harness),"correlationId":trigger["correlationId"],"status":Self::status(outcome)}));
        }
    }
    pub fn resolve_pending_for_member(&self, id: &str, outcome: TurnCompletion) -> usize {
        let pending = {
            let mut state = self.state.lock().unwrap();
            let keys = state
                .pending
                .iter()
                .filter(|(_, pending)| pending.target == id)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| state.pending.remove(&key).map(|pending| (key, pending)))
                .collect::<Vec<_>>()
        };
        let count = pending.len();
        for (correlation, pending) in pending {
            pending.timer.cancel();
            if let Some(source) = pending.source {
                if Self::recordable(&outcome) {
                    self.record(json!({"teamId":pending.team,"epochId":pending.epoch,"kind":"reply","actorAppId":pending.target,"targetAppId":source,"subject":protocol::activity_subject_with_harness(&Self::describe_completion_with_harness(&outcome,&pending.harness),80,&pending.harness),"correlationId":correlation,"status":Self::status(&outcome)}));
                }
            }
            let _ = pending.sender.send(Self::receipt(
                &pending.name,
                &outcome,
                true,
                &pending.harness,
            ));
        }
        count
    }
    pub fn complete_turn(
        &self,
        key: &str,
        trigger: &Value,
        outcome: TurnCompletion,
        seal_pending: bool,
    ) {
        if let Err(error) = self.checked_complete_turn(key, trigger, outcome, seal_pending) {
            tracing::warn!(session=key, code=%error.code, "Team turn completion failed");
        }
    }
    pub fn checked_complete_turn(
        &self,
        key: &str,
        trigger: &Value,
        outcome: TurnCompletion,
        seal_pending: bool,
    ) -> Result<()> {
        self.gate.release(key);
        let team = self.store.try_team(text(trigger, "teamId"))?;
        let epoch = self.store.try_epoch(text(trigger, "epochId"))?;
        if team.is_none()
            || epoch
                .as_ref()
                .is_none_or(|v| v.get("endedAt") != Some(&Value::Null))
        {
            self.release_context(trigger);
            tracing::warn!(
                "[TeamBus] completeTurn dropped (epoch sealed/missing): epoch={}",
                text(trigger, "epochId")
            );
            return Ok(());
        }
        let finisher = protocol::parse_session_key(key)
            .and_then(|v| v["appId"].as_str().map(String::from))
            .or_else(|| trigger["fromAppId"].as_str().map(String::from))
            .unwrap_or_default();
        if !finisher.is_empty() {
            self.record_reply(trigger, &finisher, &outcome);
        }
        if trigger["wait"] == true {
            self.resolve_pending(text(trigger, "correlationId"), outcome);
        }
        self.release_context(trigger);
        if seal_pending {
            tracing::warn!(
                "[TeamBus] completeTurn: mailbox left for the seal to discard: epoch={}",
                text(trigger, "epochId")
            );
            return Ok(());
        }
        self.gate.checked_drain(key)
    }
    pub fn notify_session_ready(&self, key: &str) {
        self.gate.notify_ready(key);
    }
    pub fn is_session_occupied(&self, key: &str) -> bool {
        self.gate.is_occupied(key)
    }
    pub fn drain_mailbox(&self, key: &str) {
        self.gate.drain(key);
    }
    pub async fn run_relayed_turn(
        &self,
        key: &str,
        run: Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = Result<Value>> + Send>> + Send>,
    ) -> Result<Value> {
        if self.state.lock().unwrap().cancelled.contains(key) {
            return Err(Error::new("TeamBusError", "")
                .with_harness(TextId::CollaborationDeliveryCollaboratorStopped, &[]));
        }
        self.gate.run_exclusive(key, run).await
    }
    fn void_own_words(&self, deliveries: &[Value]) {
        for delivery in deliveries {
            if delivery["trigger"]["wait"] == true {
                self.resolve_pending(
                    text(&delivery["trigger"], "correlationId"),
                    stopped_unread(&self.context_for(&delivery["trigger"])),
                );
            }
        }
    }
    pub fn hold_session(&self, key: &str) -> Vec<Value> {
        let voided = Mutex::new(Vec::new());
        self.gate.discard_jobs(
            |candidate, job| {
                let deliveries = items(job);
                if candidate != key
                    || !deliveries
                        .iter()
                        .all(|v| is_persons_own_delivery(&v["trigger"]))
                {
                    return false;
                }
                voided.lock().unwrap().extend(deliveries);
                true
            },
            "stopped before it was read",
        );
        let voided = voided.into_inner().unwrap();
        self.void_own_words(&voided);
        self.gate.park(key);
        voided
    }
    pub fn cancel_session(&self, key: &str) {
        {
            let mut state = self.state.lock().unwrap();
            state.cancelled.insert(key.into());
            *state.generations.entry(key.into()).or_default() += 1;
        }
        self.gate
            .discard(|candidate| candidate == key, "the collaborator was stopped");
        self.gate.park(key);
        let correlations = self
            .state
            .lock()
            .unwrap()
            .pending
            .iter()
            .filter(|(_, pending)| {
                protocol::session_key(&pending.target, &pending.team, &pending.epoch) == key
            })
            .map(|(key, pending)| (key.clone(), pending.harness.clone()))
            .collect::<Vec<_>>();
        for (correlation, harness) in correlations {
            self.resolve_pending(&correlation, stopped_unread(&harness));
        }
    }
    pub fn continue_session(&self, key: &str) {
        self.state.lock().unwrap().cancelled.remove(key);
    }
    pub fn return_deliveries(&self, key: &str, deliveries: Vec<Value>) {
        let (generation, cancelled) = {
            let state = self.state.lock().unwrap();
            (
                state.generations.get(key).copied().unwrap_or(0),
                state.cancelled.contains(key),
            )
        };
        let mut current = Vec::new();
        let mut removed = 0;
        for delivery in deliveries {
            if !cancelled && delivery["admissionGeneration"].as_u64().unwrap_or(0) == generation {
                current.push(delivery);
            } else {
                removed += 1;
                if delivery["trigger"]["wait"] == true {
                    self.resolve_pending(
                        text(&delivery["trigger"], "correlationId"),
                        stopped_unread(&self.context_for(&delivery["trigger"])),
                    );
                }
            }
        }
        if removed > 0 {
            tracing::warn!(
                "[TeamBus] stopped deliveries not restored: session={key} count={removed}"
            );
        }
        for delivery in &current {
            let correlation = text(&delivery["trigger"], "correlationId");
            let name = self
                .state
                .lock()
                .unwrap()
                .pending
                .get(correlation)
                .map(|pending| pending.name.clone());
            if let Some(name) = name {
                self.settle(
                    correlation,
                    json!({"from":name,"message":"","status":"queued"}),
                );
            }
        }
        self.gate.put_back(key, current);
    }
    pub fn return_held_back(&self, key: &str, deliveries: Vec<Value>) -> Vec<Value> {
        self.gate.release(key);
        let (voided, kept): (Vec<_>, Vec<_>) = deliveries
            .into_iter()
            .partition(|v| is_persons_own_delivery(&v["trigger"]));
        self.void_own_words(&voided);
        self.return_deliveries(key, kept);
        voided
    }
    pub fn reset_epoch(&self, epoch: &str) {
        let suffix = format!(":{epoch}");
        let pending = {
            let mut state = self.state.lock().unwrap();
            state.stats.remove(epoch);
            state.text_scopes.retain(|_, scope| scope.epoch != epoch);
            state.cancelled.retain(|key| !key.ends_with(&suffix));
            state.generations.retain(|key, _| !key.ends_with(&suffix));
            let keys = state
                .pending
                .iter()
                .filter(|(_, p)| p.epoch == epoch)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| state.pending.remove(&key))
                .collect::<Vec<_>>()
        };
        for pending in pending {
            pending.timer.cancel();
            let _ = pending
                .sender
                .send(json!({"from":pending.name,"message":"","status":"timeout"}));
        }
        let dropped = self
            .gate
            .discard(|key| key.ends_with(&suffix), "the run was stopped");
        if dropped > 0 {
            tracing::warn!("[TeamBus] resetEpoch dropped {dropped} undelivered buffered envelope(s): epoch={epoch}");
        }
    }
    pub fn has_buffered_messages(&self, epoch: &str) -> bool {
        let suffix = format!(":{epoch}");
        self.gate.has_any_buffered(|key| key.ends_with(&suffix))
    }
    pub fn pending_recorded_input_ids(&self, key: &str) -> Vec<String> {
        self.gate
            .buffered_jobs(key)
            .iter()
            .flat_map(items)
            .flat_map(|delivery| {
                delivery["recordedInputIds"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Store {
        members: Vec<Value>,
        lead: String,
        edge: bool,
    }
    impl MessageBusStore for Store {
        fn member(&self, team: &str, id: &str, epoch: Option<&str>) -> Option<Value> {
            if team != "team" || epoch != Some("work") {
                return None;
            }
            self.members.iter().find(|v| v["appId"] == id).cloned()
        }
        fn member_by_name(&self, team: &str, name: &str, epoch: Option<&str>) -> Option<Value> {
            if team != "team" || epoch != Some("work") {
                return None;
            }
            self.members
                .iter()
                .find(|v| v["memberName"] == name)
                .cloned()
        }
        fn members(&self, _team: &str, _epoch: Option<&str>) -> Vec<Value> {
            self.members.clone()
        }
        fn edge_allowed(&self, _team: &str, _from: &str, _to: &str, _epoch: Option<&str>) -> bool {
            self.edge
        }
        fn team(&self, _id: &str) -> Option<Value> {
            Some(json!({"leadAppId":self.lead}))
        }
        fn epoch(&self, _id: &str) -> Option<Value> {
            Some(json!({"endedAt":null}))
        }
    }
    struct Hooks {
        fence: Mutex<Option<String>>,
        acquired: Mutex<Vec<Value>>,
        wakes: Mutex<Vec<Value>>,
        coordinator: Mutex<Vec<Value>>,
        busy: std::sync::atomic::AtomicBool,
        wake_delay: Mutex<Option<Arc<tokio::sync::Notify>>>,
    }
    impl Hooks {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                fence: Mutex::new(None),
                acquired: Mutex::new(Vec::new()),
                wakes: Mutex::new(Vec::new()),
                coordinator: Mutex::new(Vec::new()),
                busy: std::sync::atomic::AtomicBool::new(false),
                wake_delay: Mutex::new(None),
            })
        }
    }
    #[async_trait]
    impl DeliveryHooks for Hooks {
        fn acquire_recipient_fence(&self, target: Value) -> RecipientFence {
            self.acquired.lock().unwrap().push(target);
            match self.fence.lock().unwrap().clone() {
                Some(fence) => RecipientFence::Immediate(fence),
                None => RecipientFence::Absent,
            }
        }
        fn accept_recipient_fence(&self, _target: &Value, fence: Option<&str>) -> bool {
            self.fence.lock().unwrap().as_deref() == fence
        }
        async fn wake_target(&self, request: Value) -> Result<()> {
            self.wakes.lock().unwrap().push(request);
            let delay = self.wake_delay.lock().unwrap().clone();
            if let Some(delay) = delay {
                delay.notified().await;
            }
            Ok(())
        }
        fn is_busy(&self, _key: &str) -> bool {
            self.busy.load(std::sync::atomic::Ordering::SeqCst)
        }
        async fn deliver_to_coordinator(&self, request: Value) -> Result<Option<String>> {
            self.coordinator.lock().unwrap().push(request);
            Ok(Some("dispatched".into()))
        }
    }
    #[tokio::test]
    async fn reserved_lead_routes_to_scoped_identity_not_peer_label() {
        let root = protocol::coordinator_id("original-chat");
        let store = Arc::new(Store {
            members: vec![
                json!({"appId":root,"memberName":"coordinator","isLead":true}),
                json!({"appId":"peer-id","memberName":"lead","isLead":false}),
                json!({"appId":"alice-id","memberName":"Alice"}),
            ],
            lead: root.clone(),
            edge: false,
        });
        let hooks = Hooks::new();
        let bus = MessageBus::new(store, hooks.clone(), Default::default());
        bus.send(json!({"teamId":"team","epochId":"work","fromAppId":"alice-id","to":"lead","message":"Verified result."})).await.unwrap();
        assert_eq!(
            hooks.coordinator.lock().unwrap()[0]["envelope"]["toAppId"],
            root
        );
        assert_eq!(
            bus.resolve_member("team", "peer-id", Some("work")).unwrap(),
            "peer-id"
        );
        assert!(bus
            .resolve_member("team", "lead", Some("other-work"))
            .is_err());
        assert!(bus
            .assert_can_contact("team", "alice-id", &root, "structured", Some("work"))
            .is_err());
        bus.reset_epoch("work");
    }
    #[tokio::test]
    async fn stamped_notice_uses_runtime_sender_and_cannot_gain_new_incarnation() {
        let store = Arc::new(Store {
            members: vec![json!({"appId":"lead","memberName":"lead"})],
            lead: "lead".into(),
            edge: true,
        });
        let hooks = Hooks::new();
        *hooks.fence.lock().unwrap() = Some("before-stop".into());
        let bus = MessageBus::new(store, hooks.clone(), Default::default());
        let mut envelope = json!({"id":"notice","teamId":"team","epochId":"work","fromAppId":"lead","toAppId":"lead","body":"A member finished.","createdAt":1,"correlationId":"notice"});
        let mut trigger = json!({"teamId":"team","epochId":"work","fromAppId":null,"correlationId":"notice","requestId":"source/member","kind":"member_stopped","wait":false});
        bus.deliver_runtime_wake(&mut envelope, &mut trigger, BusyDisposition::Buffer, None)
            .await
            .unwrap();
        assert_eq!(
            hooks.acquired.lock().unwrap().as_slice(),
            &[
                json!({"teamId":"team","epochId":"work","appId":"lead","fromAppId":null,"requestId":"source/member"})
            ]
        );
        assert_eq!(trigger["recipientFence"], "before-stop");
        *hooks.fence.lock().unwrap() = Some("after-stop".into());
        assert!(bus
            .deliver_runtime_wake(&mut envelope, &mut trigger, BusyDisposition::Buffer, None)
            .await
            .unwrap_err()
            .message
            .contains("stopped recipient"));
        assert_eq!(hooks.acquired.lock().unwrap().len(), 1);
        assert_eq!(hooks.wakes.lock().unwrap().len(), 1);
        bus.reset_epoch("work");
    }
    #[tokio::test]
    async fn human_receipt_is_settled_by_actual_completion_without_team_reply() {
        let store = Arc::new(Store {
            members: vec![json!({"appId":"worker","memberName":"worker"})],
            lead: "worker".into(),
            edge: true,
        });
        let hooks = Hooks::new();
        let records = Arc::new(Mutex::new(Vec::new()));
        let captured = records.clone();
        let bus = MessageBus::new(
            store,
            hooks.clone(),
            MessageBusOptions {
                record_activity: Some(Arc::new(move |value| {
                    captured.lock().unwrap().push(value);
                    Ok(())
                })),
                ..Default::default()
            },
        );
        let sender = bus.clone();
        let send = crate::runtime::spawn(async move {
            sender.send(json!({"teamId":"team","epochId":"work","fromAppId":null,"to":"worker","message":"question","wait":true})).await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while hooks.wakes.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let request = hooks.wakes.lock().unwrap()[0].clone();
        bus.complete_turn(
            text(&request, "sessionKey"),
            &request["trigger"],
            TurnCompletion::Result {
                content: "actual response".into(),
                task_id: None,
            },
            false,
        );
        assert_eq!(
            send.await.unwrap().unwrap(),
            json!({"from":"worker","message":"actual response","status":"ok"})
        );
        assert!(records.lock().unwrap().is_empty());
        assert!(hooks.coordinator.lock().unwrap().is_empty());
        bus.reset_epoch("work");
    }
    #[tokio::test]
    async fn receipt_deadline_survives_an_unresolved_wake() {
        let store = Arc::new(Store {
            members: vec![json!({"appId":"worker","memberName":"worker"})],
            lead: "worker".into(),
            edge: true,
        });
        let hooks = Hooks::new();
        let delay = Arc::new(tokio::sync::Notify::new());
        *hooks.wake_delay.lock().unwrap() = Some(delay.clone());
        let bus = MessageBus::new(
            store,
            hooks,
            MessageBusOptions {
                sync_wait_timeout_ms: 2,
                ..Default::default()
            },
        );
        let receipt=tokio::time::timeout(Duration::from_secs(1),bus.send(json!({"teamId":"team","epochId":"work","fromAppId":null,"to":"worker","message":"question","wait":true}))).await.unwrap().unwrap();
        assert_eq!(receipt["status"], "timeout");
        delay.notify_one();
        bus.reset_epoch("work");
    }
}
