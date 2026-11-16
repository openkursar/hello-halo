use crate::error::{Error, Result};
use crate::harness::TextId;
use async_trait::async_trait;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

type ExclusiveFuture = Pin<Box<dyn Future<Output = Result<Value>> + Send>>;
type ExclusiveRun = Box<dyn FnOnce() -> ExclusiveFuture + Send>;

fn start_future<F>(future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let mut future = Box::pin(future);
    if future
        .as_mut()
        .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
        .is_pending()
    {
        crate::runtime::spawn(future);
    }
}

#[async_trait]
pub trait TurnGateHooks: Send + Sync {
    async fn dispatch(&self, key: &str, job: Value) -> Result<()>;
    fn is_busy(&self, key: &str) -> bool;
    fn job_identity(&self, _job: &Value) -> Option<String> {
        None
    }
    fn active_identity(&self, _key: &str) -> Option<String> {
        None
    }
    fn supports_merge(&self) -> bool {
        false
    }
    fn merge_jobs(&self, jobs: &[Value]) -> Value {
        jobs[0].clone()
    }
    fn refresh_job(&self, job: &Value) -> Result<Option<Value>> {
        Ok(Some(job.clone()))
    }
    fn deliver_mid_turn(&self, _key: &str, _job: Value) -> Result<bool> {
        Ok(false)
    }
    fn retry_dispatch(&self, _error: &Error, _job: &Value) -> bool {
        true
    }
    fn coalescing_key(&self, _job: &Value) -> Option<String> {
        None
    }
    fn discard(&self, _job: Value, _reason: &str) -> Result<()> {
        Ok(())
    }
    fn can_open_turn(&self, _job: &Value) -> bool {
        true
    }
    fn try_is_busy(&self, key: &str) -> Result<bool> {
        Ok(self.is_busy(key))
    }
    fn try_job_identity(&self, job: &Value) -> Result<Option<String>> {
        Ok(self.job_identity(job))
    }
    fn try_active_identity(&self, key: &str) -> Result<Option<String>> {
        Ok(self.active_identity(key))
    }
    fn try_merge_jobs(&self, jobs: &[Value]) -> Result<Value> {
        Ok(self.merge_jobs(jobs))
    }
    fn try_coalescing_key(&self, job: &Value) -> Result<Option<String>> {
        Ok(self.coalescing_key(job))
    }
    fn try_can_open_turn(&self, job: &Value) -> Result<bool> {
        Ok(self.can_open_turn(job))
    }
    fn try_retry_dispatch(&self, error: &Error, job: &Value) -> Result<bool> {
        Ok(self.retry_dispatch(error, job))
    }
    fn retain_job(&self, _job: &Value) -> Result<()> {
        Ok(())
    }
    fn release_job(&self, _job: &Value) {}
}

pub struct TurnGateOptions {
    pub buffer_cap: usize,
    pub recheck_ms: u64,
    pub reservation_ttl_ms: Option<u64>,
}
impl Default for TurnGateOptions {
    fn default() -> Self {
        Self {
            buffer_cap: 128,
            recheck_ms: 3000,
            reservation_ttl_ms: None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusyDisposition {
    Buffer,
    Skip,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliverDisposition {
    Dispatched,
    MidTurn,
    Buffered,
    Skipped,
}
#[derive(Clone)]
struct Job {
    id: u64,
    value: Value,
    identity: Option<String>,
    coalescing: Option<String>,
    refresh_failed: bool,
    lease: Arc<JobLease>,
}
struct JobLease {
    value: Value,
    hooks: Arc<dyn TurnGateHooks>,
}
impl Drop for JobLease {
    fn drop(&mut self) {
        self.hooks.release_job(&self.value);
    }
}
struct Exclusive {
    run: Option<ExclusiveRun>,
    result: Option<oneshot::Sender<Result<Value>>>,
}
#[derive(Clone)]
enum Entry {
    Job(Job),
    Exclusive(Arc<Mutex<Exclusive>>),
}
struct Attempt {
    entries: Vec<Job>,
    cancelled: Mutex<Option<String>>,
}
struct State {
    mailboxes: HashMap<String, Vec<Entry>>,
    reserved: HashMap<String, u64>,
    attempts: HashMap<String, HashMap<u64, Arc<Attempt>>>,
    rechecks: HashMap<String, CancellationToken>,
    watchdogs: HashMap<String, CancellationToken>,
    parked: HashSet<String>,
    returned: HashMap<String, usize>,
    refreshing: HashSet<String>,
    sequence: u64,
}
struct LiveDelivery {
    running: bool,
    pending: Vec<String>,
}
pub struct TurnGate {
    hooks: Arc<dyn TurnGateHooks>,
    options: TurnGateOptions,
    state: Mutex<State>,
    live_delivery: Mutex<LiveDelivery>,
    lifetime: CancellationToken,
}

impl TurnGate {
    pub fn new(hooks: Arc<dyn TurnGateHooks>, options: TurnGateOptions) -> Result<Arc<Self>> {
        if options.buffer_cap == 0 {
            return Err(Error::new(
                "TURN_GATE_ARGUMENTS",
                "bufferCap must be a positive integer",
            ));
        }
        Ok(Arc::new(Self {
            hooks,
            options,
            lifetime: CancellationToken::new(),
            live_delivery: Mutex::new(LiveDelivery {
                running: false,
                pending: Vec::new(),
            }),
            state: Mutex::new(State {
                mailboxes: HashMap::new(),
                reserved: HashMap::new(),
                attempts: HashMap::new(),
                rechecks: HashMap::new(),
                watchdogs: HashMap::new(),
                parked: HashSet::new(),
                returned: HashMap::new(),
                refreshing: HashSet::new(),
                sequence: 0,
            }),
        }))
    }
    pub fn abort_now(&self) {
        self.lifetime.cancel();
        let discarded = {
            let mut state = self.state.lock().unwrap();
            for timer in state.rechecks.values().chain(state.watchdogs.values()) {
                timer.cancel();
            }
            for attempt in state
                .attempts
                .values()
                .flat_map(|attempts| attempts.values())
            {
                *attempt.cancelled.lock().unwrap() = Some("runtime closed".into());
            }
            state.rechecks.clear();
            state.watchdogs.clear();
            state.reserved.clear();
            state.parked.clear();
            state.returned.clear();
            std::mem::take(&mut state.mailboxes)
        };
        drop(discarded);
    }
    fn require_open(&self) -> Result<()> {
        if self.lifetime.is_cancelled() {
            Err(Error::new("TURN_GATE_CLOSED", "Turn gate is closed"))
        } else {
            Ok(())
        }
    }
    fn job(&self, value: Value) -> Result<Job> {
        let identity = self.hooks.try_job_identity(&value)?;
        let coalescing = self.hooks.try_coalescing_key(&value)?;
        self.hooks.retain_job(&value)?;
        let lease = Arc::new(JobLease {
            value: value.clone(),
            hooks: self.hooks.clone(),
        });
        let mut state = self.state.lock().unwrap();
        state.sequence += 1;
        Ok(Job {
            id: state.sequence,
            identity,
            coalescing,
            value,
            refresh_failed: false,
            lease,
        })
    }
    pub fn is_occupied(&self, key: &str) -> bool {
        self.checked_is_occupied(key).unwrap_or_else(|error| {
            tracing::warn!(session=key, code=%error.code, "Turn gate busy probe failed");
            true
        })
    }
    pub fn checked_is_occupied(&self, key: &str) -> Result<bool> {
        let reserved = self.state.lock().unwrap().reserved.contains_key(key);
        Ok(reserved || self.hooks.try_is_busy(key)?)
    }
    pub fn buffered_count(&self, key: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .mailboxes
            .get(key)
            .map_or(0, Vec::len)
    }
    pub fn buffered_jobs(&self, key: &str) -> Vec<Value> {
        self.state
            .lock()
            .unwrap()
            .mailboxes
            .get(key)
            .into_iter()
            .flatten()
            .filter_map(|entry| match entry {
                Entry::Job(job) => Some(job.value.clone()),
                _ => None,
            })
            .collect()
    }
    pub fn has_any_buffered(&self, filter: impl Fn(&str) -> bool) -> bool {
        self.checked_has_any_buffered(|key| Ok(filter(key)))
            .unwrap_or(false)
    }
    pub fn checked_has_any_buffered(&self, filter: impl Fn(&str) -> Result<bool>) -> Result<bool> {
        let keys: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .mailboxes
            .keys()
            .cloned()
            .collect();
        for key in keys {
            if filter(&key)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn release(&self, key: &str) {
        let mut state = self.state.lock().unwrap();
        state.reserved.remove(key);
        if let Some(timer) = state.watchdogs.remove(key) {
            timer.cancel();
        }
    }
    fn release_own(&self, key: &str, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.reserved.get(key) != Some(&generation) {
            return false;
        }
        state.reserved.remove(key);
        if let Some(timer) = state.watchdogs.remove(key) {
            timer.cancel();
        }
        true
    }
    fn reserve_idle(self: &Arc<Self>, key: &str, allow_buffered: bool) -> Result<Option<u64>> {
        if self.hooks.try_is_busy(key)? {
            return Ok(None);
        }
        let generation = {
            let mut state = self.state.lock().unwrap();
            if state.reserved.contains_key(key)
                || (!allow_buffered && state.mailboxes.get(key).is_some_and(|v| !v.is_empty()))
            {
                return Ok(None);
            }
            state.sequence += 1;
            let generation = state.sequence;
            state.reserved.insert(key.into(), generation);
            generation
        };
        self.arm_watchdog(key, generation);
        Ok(Some(generation))
    }
    fn arm_watchdog(self: &Arc<Self>, key: &str, generation: u64) {
        let Some(ttl) = self.options.reservation_ttl_ms else {
            return;
        };
        let timer = CancellationToken::new();
        {
            let mut state = self.state.lock().unwrap();
            if let Some(old) = state.watchdogs.insert(key.into(), timer.clone()) {
                old.cancel();
            }
        }
        let weak = Arc::downgrade(self);
        let key = key.to_owned();
        crate::runtime::spawn(async move {
            tokio::select! {_=timer.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(ttl))=>{}}
            let Some(gate) = weak.upgrade() else { return };
            if gate.state.lock().unwrap().reserved.get(&key) != Some(&generation) {
                return;
            }
            if gate.hooks.try_is_busy(&key).unwrap_or_else(|error| {
                tracing::warn!(session=%key, code=%error.code, "Turn gate recovery probe failed");
                true
            }) {
                gate.arm_watchdog(&key, generation);
                return;
            }
            if gate.release_own(&key, generation) {
                tracing::warn!(
                    "[TurnGate] Reclaiming stranded reservation: session={key} buffered={}",
                    gate.buffered_count(&key)
                );
                gate.drain(&key);
            }
        });
    }
    fn schedule(self: &Arc<Self>, key: &str) {
        let timer = CancellationToken::new();
        {
            let mut state = self.state.lock().unwrap();
            if state.rechecks.contains_key(key) || state.parked.contains(key) {
                return;
            }
            state.rechecks.insert(key.into(), timer.clone());
        }
        let weak = Arc::downgrade(self);
        let key = key.to_owned();
        let delay = self.options.recheck_ms;
        crate::runtime::spawn(async move {
            tokio::select! {_=timer.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(delay))=>{}}
            if let Some(gate) = weak.upgrade() {
                gate.state.lock().unwrap().rechecks.remove(&key);
                gate.drain(&key);
            }
        });
    }
    fn store_mailbox(state: &mut State, key: &str, entries: Vec<Entry>) {
        if entries.is_empty() {
            state.mailboxes.remove(key);
            if let Some(timer) = state.rechecks.remove(key) {
                timer.cancel();
            }
        } else {
            state.mailboxes.insert(key.into(), entries);
        }
    }
    fn reject(&self, entry: Entry, reason: &str) {
        match entry {
            Entry::Job(job) => {
                if let Err(error) = self.hooks.discard(job.value, reason) {
                    tracing::warn!("[TurnGate] Discard callback failed: reason={reason}: {error}");
                }
            }
            Entry::Exclusive(relay) => {
                let mut relay = relay.lock().unwrap();
                if let Some(sender) = relay.result.take() {
                    let _ = sender.send(Err(Error::new("TURN_GATE_DISCARDED", "").with_harness(
                        TextId::CollaborationMailboxRelayedDropped,
                        &[("reason", reason.into())],
                    )));
                }
                relay.run.take();
            }
        }
    }
    fn enqueue(self: &Arc<Self>, key: &str, entry: Entry) -> Result<()> {
        let superseded = {
            let mut state = self.state.lock().unwrap();
            let queue = state.mailboxes.entry(key.into()).or_default();
            let mut superseded = None;
            if let Entry::Job(job) = &entry {
                if job.identity.is_some() && job.coalescing.is_some() {
                    for i in (0..queue.len()).rev() {
                        match &queue[i] {
                            Entry::Exclusive(_) => break,
                            Entry::Job(previous)
                                if previous.identity == job.identity
                                    && previous.coalescing == job.coalescing =>
                            {
                                superseded = Some(queue.remove(i));
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
            if queue.len() >= self.options.buffer_cap {
                tracing::warn!(
                    "[TurnGate] Mailbox full; new delivery refused: session={key} capacity={}",
                    self.options.buffer_cap
                );
                return Err(Error::new("TurnGateCapacityError", "")
                    .with_harness(TextId::CollaborationMailboxFull, &[("key", key.into())])
                    .with_details(serde_json::json!({"sessionKey":key})));
            }
            queue.push(entry);
            superseded
        };
        if let Some(previous) = superseded {
            self.reject(previous, "superseded");
        }
        self.schedule(key);
        Ok(())
    }
    fn refresh_entry(&self, key: &str, entry: &mut Job) -> bool {
        let refreshed = self.hooks.refresh_job(&entry.value).and_then(|value| {
            value
                .map(|value| {
                    let identity = self.hooks.try_job_identity(&value)?;
                    let coalescing = self.hooks.try_coalescing_key(&value)?;
                    let lease = if value == entry.value {
                        entry.lease.clone()
                    } else {
                        self.hooks.retain_job(&value)?;
                        Arc::new(JobLease {
                            value: value.clone(),
                            hooks: self.hooks.clone(),
                        })
                    };
                    Ok((value, identity, coalescing, lease))
                })
                .transpose()
        });
        match refreshed {
            Ok(Some((value, identity, coalescing, lease))) => {
                entry.identity = identity;
                entry.coalescing = coalescing;
                entry.value = value;
                entry.lease = lease;
                entry.refresh_failed = false;
                true
            }
            Ok(None) => false,
            Err(error) => {
                entry.identity = None;
                entry.refresh_failed = true;
                tracing::warn!("[TurnGate] Deferred delivery could not be revalidated; retaining input: session={key}: {error}");
                true
            }
        }
    }
    fn refresh_mailbox(&self, key: &str) {
        let snapshot = {
            let mut state = self.state.lock().unwrap();
            if !state.refreshing.insert(key.into()) {
                return;
            }
            state.mailboxes.get(key).cloned().unwrap_or_default()
        };
        let mut discarded = Vec::new();
        let mut replacements = HashMap::new();
        let mut coalescing = HashMap::new();
        let mut removed = HashMap::new();
        for entry in snapshot {
            match entry {
                Entry::Exclusive(_) => coalescing.clear(),
                Entry::Job(mut job) => {
                    if !self.refresh_entry(key, &mut job) {
                        removed.insert(job.id, "no longer valid");
                        continue;
                    }
                    if let (Some(identity), Some(key)) = (&job.identity, &job.coalescing) {
                        if let Some(previous) =
                            coalescing.insert((identity.clone(), key.clone()), job.id)
                        {
                            removed.insert(previous, "superseded");
                        }
                    }
                    replacements.insert(job.id, job);
                }
            }
        }
        {
            let mut state = self.state.lock().unwrap();
            let mut current = state.mailboxes.remove(key).unwrap_or_default();
            current.retain_mut(|entry| {
                let Entry::Job(job) = entry else { return true };
                if let Some(updated) = replacements.remove(&job.id) {
                    *job = updated;
                }
                if let Some(reason) = removed.get(&job.id) {
                    discarded.push((entry.clone(), *reason));
                    return false;
                }
                true
            });
            state.refreshing.remove(key);
            Self::store_mailbox(&mut state, key, current);
        }
        let count = discarded.len();
        for (entry, reason) in discarded {
            self.reject(entry, reason);
        }
        if count > 0 {
            tracing::warn!(
                "[TurnGate] Revalidated pending deliveries: session={key} removed={count}"
            );
        }
    }
    fn merge(&self, entries: &[Job]) -> Result<Value> {
        if entries.len() == 1 {
            Ok(entries[0].value.clone())
        } else {
            self.hooks
                .try_merge_jobs(&entries.iter().map(|v| v.value.clone()).collect::<Vec<_>>())
        }
    }
    fn matching(&self, key: &str, identity: &Option<String>) -> Vec<Job> {
        if identity.is_none() {
            return Vec::new();
        }
        let supports_merge = self.hooks.supports_merge();
        let state = self.state.lock().unwrap();
        let mut result = Vec::new();
        for entry in state.mailboxes.get(key).into_iter().flatten() {
            match entry {
                Entry::Exclusive(_) => break,
                Entry::Job(job) => {
                    if job.refresh_failed || job.identity != *identity {
                        continue;
                    }
                    result.push(job.clone());
                    if !supports_merge {
                        break;
                    }
                }
            }
        }
        result
    }
    fn remove(&self, key: &str, jobs: &[Job]) {
        let ids: HashSet<_> = jobs.iter().map(|v| v.id).collect();
        let mut state = self.state.lock().unwrap();
        let mut entries = state.mailboxes.remove(key).unwrap_or_default();
        entries.retain(|entry| !matches!(entry,Entry::Job(job)if ids.contains(&job.id)));
        Self::store_mailbox(&mut state, key, entries);
    }
    fn flush_live(&self, key: &str, offered: Option<Job>, refresh: bool) -> Result<Vec<Job>> {
        {
            let mut delivery = self.live_delivery.lock().unwrap();
            if delivery.running {
                if offered.is_none() {
                    delivery.pending.push(key.into());
                }
                return Ok(Vec::new());
            }
            delivery.running = true;
        }
        let initial = self.flush_live_inner(key, offered, refresh);
        let mut accepted = initial.as_ref().cloned().unwrap_or_default();
        let mut failure = initial.err();
        loop {
            let pending = {
                let mut delivery = self.live_delivery.lock().unwrap();
                if delivery.pending.is_empty() {
                    delivery.running = false;
                    return failure.map_or(Ok(accepted), Err);
                }
                std::mem::take(&mut delivery.pending)
            };
            for pending in pending {
                match self.flush_live_inner(&pending, None, false) {
                    Ok(values) => accepted.extend(values),
                    Err(error) => {
                        failure.get_or_insert(error);
                    }
                }
            }
        }
    }
    fn flush_live_inner(
        &self,
        key: &str,
        mut offered: Option<Job>,
        refresh: bool,
    ) -> Result<Vec<Job>> {
        if self.lifetime.is_cancelled() {
            return Ok(Vec::new());
        }
        if self.state.lock().unwrap().parked.contains(key) {
            return Ok(Vec::new());
        }
        if refresh {
            self.refresh_mailbox(key);
        }
        if let Some(job) = &mut offered {
            if !self.refresh_entry(key, job) || job.refresh_failed {
                return Ok(Vec::new());
            }
        }
        if !self.hooks.try_is_busy(key)? {
            return Ok(Vec::new());
        }
        let identity = self.hooks.try_active_identity(key)?;
        if identity.is_none() {
            return Ok(Vec::new());
        }
        let mut entries = self.matching(key, &identity);
        if let Some(job) = offered {
            if job.identity != identity {
                return Ok(Vec::new());
            }
            if self
                .state
                .lock()
                .unwrap()
                .mailboxes
                .get(key)
                .into_iter()
                .flatten()
                .any(|v| matches!(v, Entry::Exclusive(_)))
            {
                return Ok(Vec::new());
            }
            if !entries.is_empty() && !self.hooks.supports_merge() {
                return Ok(Vec::new());
            }
            entries.push(job);
        }
        if entries.is_empty() {
            return Ok(entries);
        }
        match self
            .merge(&entries)
            .and_then(|job| self.hooks.deliver_mid_turn(key, job))
        {
            Ok(true) => {
                self.remove(key, &entries);
                Ok(entries)
            }
            Ok(false) => Ok(Vec::new()),
            Err(error) => {
                tracing::warn!(
                    "[TurnGate] Live delivery failed; retaining mailbox: session={key}: {error}"
                );
                Ok(Vec::new())
            }
        }
    }
    pub fn try_deliver_live(&self, key: &str, job: Value) -> bool {
        self.checked_try_deliver_live(key, job)
            .unwrap_or_else(|error| {
                tracing::warn!(session=key, code=%error.code, "Turn gate live offer failed");
                false
            })
    }
    pub fn checked_try_deliver_live(&self, key: &str, job: Value) -> Result<bool> {
        self.require_open()?;
        let entry = self.job(job)?;
        let id = entry.id;
        Ok(self
            .flush_live(key, Some(entry), true)?
            .iter()
            .any(|v| v.id == id))
    }
    async fn dispatch_entries(
        self: &Arc<Self>,
        key: String,
        entries: Vec<Job>,
        attempt: Arc<Attempt>,
        generation: u64,
    ) -> Result<()> {
        {
            self.state
                .lock()
                .unwrap()
                .attempts
                .entry(key.clone())
                .or_default()
                .insert(generation, attempt);
        }
        let result = match self.merge(&entries) {
            Ok(job) => {
                tokio::select! { _=self.lifetime.cancelled()=>Err(Error::new("TURN_GATE_CLOSED", "Turn gate is closed")), result=self.hooks.dispatch(&key,job)=>result }
            }
            Err(error) => Err(error),
        };
        if result.is_err() {
            self.release_own(&key, generation);
        }
        let mut state = self.state.lock().unwrap();
        if let Some(attempts) = state.attempts.get_mut(&key) {
            attempts.remove(&generation);
            if attempts.is_empty() {
                state.attempts.remove(&key);
            }
        }
        result
    }
    pub async fn deliver(
        self: &Arc<Self>,
        key: &str,
        job: Value,
        on_busy: BusyDisposition,
    ) -> Result<DeliverDisposition> {
        self.require_open()?;
        let mut entry = self.job(job)?;
        self.refresh_mailbox(key);
        if !self.refresh_entry(key, &mut entry) {
            self.reject(Entry::Job(entry), "no longer valid");
            return Ok(DeliverDisposition::Skipped);
        }
        if let Some(generation) = if entry.refresh_failed {
            None
        } else {
            self.reserve_idle(key, false)?
        } {
            self.unpark(key);
            let entries = vec![entry];
            let attempt = Arc::new(Attempt {
                entries: entries.clone(),
                cancelled: Mutex::new(None),
            });
            self.dispatch_entries(key.into(), entries, attempt, generation)
                .await?;
            return Ok(DeliverDisposition::Dispatched);
        }
        if on_busy == BusyDisposition::Skip {
            tracing::warn!("[TurnGate] Repeated run skipped while occupied: session={key}");
            return Ok(DeliverDisposition::Skipped);
        }
        self.unpark(key);
        if self.buffered_count(key) >= self.options.buffer_cap {
            self.flush_live(key, None, false)?;
        }
        let id = entry.id;
        self.enqueue(key, Entry::Job(entry))?;
        if self
            .flush_live(key, None, false)?
            .iter()
            .any(|v| v.id == id)
        {
            return Ok(DeliverDisposition::MidTurn);
        }
        if !self.checked_is_occupied(key)? {
            self.drain_inner(key, false)?;
        }
        Ok(DeliverDisposition::Buffered)
    }
    pub async fn run_exclusive(self: &Arc<Self>, key: &str, run: ExclusiveRun) -> Result<Value> {
        self.require_open()?;
        self.unpark(key);
        let (sender, receiver) = oneshot::channel();
        let entry = Arc::new(Mutex::new(Exclusive {
            run: Some(run),
            result: Some(sender),
        }));
        if let Some(generation) = self.reserve_idle(key, false)? {
            self.start_exclusive(key, entry, generation);
        } else {
            self.enqueue(key, Entry::Exclusive(entry))?;
            if !self.checked_is_occupied(key)? {
                self.drain(key);
            }
        }
        receiver
            .await
            .map_err(|_| Error::new("TURN_GATE_CLOSED", "Exclusive turn owner was released"))?
    }
    fn start_exclusive(self: &Arc<Self>, key: &str, entry: Arc<Mutex<Exclusive>>, generation: u64) {
        let run = entry.lock().unwrap().run.take();
        let Some(run) = run else { return };
        let weak = Arc::downgrade(self);
        let key = key.to_owned();
        let cancellation = self.lifetime.clone();
        start_future(async move {
            let result = tokio::select! { _=cancellation.cancelled()=>Err(Error::new("TURN_GATE_CLOSED", "Turn gate is closed")), result=run()=>result };
            if let Some(gate) = weak.upgrade() {
                if gate.release_own(&key, generation) {
                    gate.drain(&key);
                }
            }
            if let Some(sender) = entry.lock().unwrap().result.take() {
                let _ = sender.send(result);
            }
        });
    }
    fn opening_group(&self, key: &str) -> Result<Option<Vec<Job>>> {
        let entries = self
            .state
            .lock()
            .unwrap()
            .mailboxes
            .get(key)
            .cloned()
            .unwrap_or_default();
        let mut tried = HashSet::new();
        for entry in entries {
            match entry {
                Entry::Exclusive(_) => return Ok(None),
                Entry::Job(job) => {
                    if job.refresh_failed {
                        continue;
                    }
                    if let Some(identity) = &job.identity {
                        if !tried.insert(identity.clone()) {
                            continue;
                        }
                    }
                    let group = if job.identity.is_none() {
                        vec![job]
                    } else {
                        self.matching(key, &job.identity)
                    };
                    if !group.is_empty() && self.hooks.try_can_open_turn(&self.merge(&group)?)? {
                        return Ok(Some(group));
                    }
                }
            }
        }
        Ok(None)
    }
    pub fn drain(self: &Arc<Self>, key: &str) {
        if let Err(error) = self.checked_drain(key) {
            tracing::warn!(session=key, code=%error.code, "Turn gate drain failed");
        }
    }
    pub fn checked_drain(self: &Arc<Self>, key: &str) -> Result<()> {
        self.drain_inner(key, true)
    }
    fn drain_inner(self: &Arc<Self>, key: &str, refresh: bool) -> Result<()> {
        if self.lifetime.is_cancelled() {
            return Ok(());
        }
        if self.state.lock().unwrap().parked.contains(key) {
            return Ok(());
        }
        if refresh {
            self.refresh_mailbox(key);
        }
        if self.buffered_count(key) == 0 {
            return Ok(());
        }
        let Some(generation) = self.reserve_idle(key, true)? else {
            self.flush_live(key, None, false)?;
            if self.buffered_count(key) > 0 {
                self.schedule(key);
            }
            return Ok(());
        };
        let first = self
            .state
            .lock()
            .unwrap()
            .mailboxes
            .get(key)
            .and_then(|v| v.first())
            .cloned();
        match first {
            Some(Entry::Exclusive(relay)) => {
                let mut state = self.state.lock().unwrap();
                let mut entries = state.mailboxes.remove(key).unwrap_or_default();
                entries.remove(0);
                Self::store_mailbox(&mut state, key, entries);
                drop(state);
                self.start_exclusive(key, relay, generation);
                return Ok(());
            }
            Some(Entry::Job(job)) if job.refresh_failed => {
                self.release_own(key, generation);
                self.schedule(key);
                return Ok(());
            }
            _ => {}
        }
        let entries = match self.opening_group(key) {
            Ok(entries) => entries,
            Err(error) => {
                self.release_own(key, generation);
                return Err(error);
            }
        };
        let Some(entries) = entries else {
            self.release_own(key, generation);
            return Ok(());
        };
        self.remove(key, &entries);
        let attempt = Arc::new(Attempt {
            entries: entries.clone(),
            cancelled: Mutex::new(None),
        });
        let gate = self.clone();
        let key = key.to_owned();
        self.state
            .lock()
            .unwrap()
            .attempts
            .entry(key.clone())
            .or_default()
            .insert(generation, attempt.clone());
        start_future(async move {
            let result = match gate.merge(&entries) {
                Ok(job) => {
                    tokio::select! { _=gate.lifetime.cancelled()=>Err(Error::new("TURN_GATE_CLOSED", "Turn gate is closed")), result=gate.hooks.dispatch(&key,job)=>result }
                }
                Err(error) => Err(error),
            };
            {
                let mut state = gate.state.lock().unwrap();
                if let Some(attempts) = state.attempts.get_mut(&key) {
                    attempts.remove(&generation);
                    if attempts.is_empty() {
                        state.attempts.remove(&key);
                    }
                }
            }
            if let Err(error) = result {
                gate.release_own(&key, generation);
                let cancelled = attempt.cancelled.lock().unwrap().clone();
                if let Some(reason) = cancelled {
                    tracing::warn!("[TurnGate] Cancelled dispatch failed; no retry: session={key} reason={reason}");
                    return;
                }
                if !gate.merge(&entries).and_then(|job| gate.hooks.try_retry_dispatch(&error, &job)).unwrap_or_else(|error| {
                    tracing::warn!(session=%key, code=%error.code, "Turn gate retry decision failed");
                    false
                }) {
                    tracing::warn!("[TurnGate] Buffered dispatch permanently refused: session={key} count={}: {error}",entries.len());
                    for entry in entries {
                        gate.reject(Entry::Job(entry), &error.message);
                    }
                    if gate.buffered_count(&key) > 0 {
                        gate.schedule(&key);
                    }
                    return;
                }
                {
                    let mut state = gate.state.lock().unwrap();
                    let following = state.mailboxes.remove(&key).unwrap_or_default();
                    let mut retained: Vec<_> = entries.iter().cloned().map(Entry::Job).collect();
                    retained.extend(following);
                    Self::store_mailbox(&mut state, &key, retained);
                }
                tracing::warn!("[TurnGate] Buffered dispatch failed; retaining messages: session={key} count={}: {error}",entries.len());
                gate.schedule(&key);
            }
        });
        Ok(())
    }
    pub fn notify_ready(self: &Arc<Self>, key: &str) {
        if let Err(error) = self.checked_notify_ready(key) {
            tracing::warn!(session=key, code=%error.code, "Turn gate readiness callback failed");
        }
    }
    pub fn checked_notify_ready(self: &Arc<Self>, key: &str) -> Result<()> {
        self.unpark(key);
        self.flush_live(key, None, true)?;
        if self.buffered_count(key) > 0 {
            self.schedule(key);
        }
        Ok(())
    }
    fn unpark(&self, key: &str) {
        let mut state = self.state.lock().unwrap();
        state.returned.remove(key);
        state.parked.remove(key);
    }
    pub fn park(&self, key: &str) {
        let mut state = self.state.lock().unwrap();
        state.parked.insert(key.into());
        state.returned.remove(key);
        if let Some(timer) = state.rechecks.remove(key) {
            timer.cancel();
        }
    }
    pub fn put_back(self: &Arc<Self>, key: &str, jobs: Vec<Value>) {
        if let Err(error) = self.checked_put_back(key, jobs) {
            tracing::warn!(session=key, code=%error.code, "Turn gate returned-input validation failed");
        }
    }
    pub fn checked_put_back(self: &Arc<Self>, key: &str, jobs: Vec<Value>) -> Result<()> {
        self.require_open()?;
        let mut discarded = Vec::new();
        let held;
        {
            let entries: Vec<_> = jobs
                .into_iter()
                .map(|job| self.job(job))
                .collect::<Result<_>>()?;
            let mut state = self.state.lock().unwrap();
            let mut waiting = state.mailboxes.remove(key).unwrap_or_default();
            let mut accepted = Vec::new();
            for job in entries {
                let newer=job.identity.is_some()&&job.coalescing.is_some()&&waiting.iter().any(|entry|matches!(entry,Entry::Job(other)if other.identity==job.identity&&other.coalescing==job.coalescing));
                if newer {
                    discarded.push(Entry::Job(job));
                } else {
                    accepted.push(Entry::Job(job));
                }
            }
            held = state.parked.contains(key);
            let at = if held {
                state
                    .returned
                    .get(key)
                    .copied()
                    .unwrap_or(0)
                    .min(waiting.len())
            } else {
                0
            };
            if held {
                state.returned.insert(key.into(), at + accepted.len());
            }
            waiting.splice(at..at, accepted);
            Self::store_mailbox(&mut state, key, waiting);
        }
        for entry in discarded {
            self.reject(entry, "superseded");
        }
        if !held {
            self.checked_drain(key)?;
        }
        Ok(())
    }
    pub fn discard_jobs(&self, filter: impl Fn(&str, &Value) -> bool, reason: &str) -> usize {
        self.checked_discard_jobs(|key, job| Ok(filter(key, job)), reason)
            .unwrap_or(0)
    }
    pub fn checked_discard_jobs(
        &self,
        filter: impl Fn(&str, &Value) -> Result<bool>,
        reason: &str,
    ) -> Result<usize> {
        let snapshot = self.state.lock().unwrap().mailboxes.clone();
        let mut selected = HashSet::new();
        for (key, entries) in snapshot {
            for entry in entries {
                if let Entry::Job(job) = entry {
                    if filter(&key, &job.value)? {
                        selected.insert(job.id);
                    }
                }
            }
        }
        let mut dropped = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            let keys: Vec<_> = state.mailboxes.keys().cloned().collect();
            for key in keys {
                let mut entries = state.mailboxes.remove(&key).unwrap_or_default();
                entries.retain(|entry| {
                    if matches!(entry, Entry::Job(job) if selected.contains(&job.id)) {
                        dropped.push(entry.clone());
                        return false;
                    }
                    true
                });
                Self::store_mailbox(&mut state, &key, entries);
            }
        }
        let count = dropped.len();
        for entry in dropped {
            self.reject(entry, reason);
        }
        if count > 0 {
            tracing::warn!(
                "[TurnGate] Pending deliveries cancelled: count={count} reason={reason}"
            );
        }
        Ok(count)
    }
    pub fn discard(&self, filter: impl Fn(&str) -> bool, reason: &str) -> usize {
        self.checked_discard(|key| Ok(filter(key)), reason)
            .unwrap_or_else(|error| {
                tracing::warn!(code=%error.code, "Turn gate discard probe failed");
                0
            })
    }
    pub fn checked_discard(
        &self,
        filter: impl Fn(&str) -> Result<bool>,
        reason: &str,
    ) -> Result<usize> {
        let (keys, reservations) = {
            let state = self.state.lock().unwrap();
            let keys: HashSet<String> = state
                .mailboxes
                .keys()
                .chain(state.attempts.keys())
                .chain(state.reserved.keys())
                .chain(state.parked.iter())
                .cloned()
                .collect();
            (keys, state.reserved.clone())
        };
        let mut selected = HashSet::new();
        for key in keys {
            if filter(&key)? {
                selected.insert(key);
            }
        }
        let mut released = HashSet::new();
        for (key, generation) in reservations {
            if selected.contains(&key) && !self.hooks.try_is_busy(&key)? {
                released.insert((key, generation));
            }
        }
        let mut dropped = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            for key in selected {
                if let Some(attempts) = state.attempts.get(&key) {
                    for attempt in attempts.values() {
                        let mut cancelled = attempt.cancelled.lock().unwrap();
                        if cancelled.is_none() {
                            *cancelled = Some(reason.into());
                            dropped.extend(attempt.entries.iter().cloned().map(Entry::Job));
                        }
                    }
                }
                dropped.extend(state.mailboxes.remove(&key).unwrap_or_default());
                if let Some(timer) = state.rechecks.remove(&key) {
                    timer.cancel();
                }
                if state
                    .reserved
                    .get(&key)
                    .is_some_and(|generation| released.contains(&(key.clone(), *generation)))
                {
                    state.reserved.remove(&key);
                    if let Some(timer) = state.watchdogs.remove(&key) {
                        timer.cancel();
                    }
                }
                state.parked.remove(&key);
                state.returned.remove(&key);
            }
        }
        let count = dropped
            .iter()
            .filter(|v| matches!(v, Entry::Job(_)))
            .count();
        for entry in dropped {
            self.reject(entry, reason);
        }
        if count > 0 {
            tracing::warn!("[TurnGate] Mailbox discarded: count={count} reason={reason}");
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    struct ReentrantHooks(Mutex<std::sync::Weak<TurnGate>>);
    impl ReentrantHooks {
        fn inspect(&self) {
            if let Some(gate) = self.0.lock().unwrap().upgrade() {
                let _ = gate.buffered_count("session");
            }
        }
    }
    #[async_trait]
    impl TurnGateHooks for ReentrantHooks {
        async fn dispatch(&self, _key: &str, _job: Value) -> Result<()> {
            self.inspect();
            Ok(())
        }
        fn is_busy(&self, _key: &str) -> bool {
            self.inspect();
            true
        }
        fn job_identity(&self, _job: &Value) -> Option<String> {
            self.inspect();
            Some("identity".into())
        }
        fn refresh_job(&self, job: &Value) -> Result<Option<Value>> {
            self.inspect();
            Ok(Some(job.clone()))
        }
        fn active_identity(&self, _key: &str) -> Option<String> {
            self.inspect();
            None
        }
    }
    #[tokio::test]
    async fn callbacks_can_inspect_the_gate_without_locking_their_own_mailbox() {
        let hooks = Arc::new(ReentrantHooks(Mutex::new(std::sync::Weak::new())));
        let gate = TurnGate::new(hooks.clone(), TurnGateOptions::default()).unwrap();
        *hooks.0.lock().unwrap() = Arc::downgrade(&gate);
        assert_eq!(
            gate.deliver("session", json!(1), BusyDisposition::Buffer)
                .await
                .unwrap(),
            DeliverDisposition::Buffered
        );
        gate.drain("session");
        assert!(gate.has_any_buffered(|key| gate.buffered_count(key) == 1));
        assert_eq!(
            gate.discard_jobs(|key, _| gate.buffered_count(key) == 1, "cancelled"),
            1
        );
        gate.deliver("session", json!(2), BusyDisposition::Buffer)
            .await
            .unwrap();
        assert_eq!(
            gate.discard(|key| gate.buffered_count(key) == 1, "cancelled"),
            1
        );
    }
    struct Hooks {
        busy: AtomicBool,
        live: Mutex<Vec<Value>>,
        dispatched: Mutex<Vec<Value>>,
        discarded: Mutex<Vec<(Value, String)>>,
        failures: AtomicUsize,
    }
    impl Hooks {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                busy: AtomicBool::new(false),
                live: Mutex::new(Vec::new()),
                dispatched: Mutex::new(Vec::new()),
                discarded: Mutex::new(Vec::new()),
                failures: AtomicUsize::new(0),
            })
        }
    }
    #[async_trait]
    impl TurnGateHooks for Hooks {
        async fn dispatch(&self, _key: &str, job: Value) -> Result<()> {
            if self
                .failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_sub(1))
                .is_ok()
            {
                return Err(Error::new("FIXTURE_FAILURE", "fixture unavailable"));
            }
            self.dispatched.lock().unwrap().push(job);
            Ok(())
        }
        fn is_busy(&self, _key: &str) -> bool {
            self.busy.load(Ordering::SeqCst)
        }
        fn job_identity(&self, job: &Value) -> Option<String> {
            job["identity"].as_str().map(String::from)
        }
        fn active_identity(&self, _key: &str) -> Option<String> {
            Some("owner".into())
        }
        fn deliver_mid_turn(&self, _key: &str, job: Value) -> Result<bool> {
            self.live.lock().unwrap().push(job);
            Ok(true)
        }
        fn discard(&self, job: Value, reason: &str) -> Result<()> {
            self.discarded.lock().unwrap().push((job, reason.into()));
            Ok(())
        }
    }
    async fn wait_until(condition: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn unknown_permissions_stay_separate_and_owner_joins_live() {
        let hooks = Hooks::new();
        hooks.busy.store(true, Ordering::SeqCst);
        let gate = TurnGate::new(hooks.clone(), TurnGateOptions::default()).unwrap();
        assert_eq!(
            gate.deliver("chat", json!({"body":"unknown"}), BusyDisposition::Buffer)
                .await
                .unwrap(),
            DeliverDisposition::Buffered
        );
        assert_eq!(
            gate.deliver(
                "chat",
                json!({"identity":"guest","body":"guest"}),
                BusyDisposition::Buffer
            )
            .await
            .unwrap(),
            DeliverDisposition::Buffered
        );
        assert_eq!(
            gate.deliver(
                "chat",
                json!({"identity":"owner","body":"owner"}),
                BusyDisposition::Buffer
            )
            .await
            .unwrap(),
            DeliverDisposition::MidTurn
        );
        assert_eq!(hooks.live.lock().unwrap().len(), 1);
        hooks.busy.store(false, Ordering::SeqCst);
        gate.release("chat");
        gate.drain("chat");
        wait_until(|| hooks.dispatched.lock().unwrap().len() == 1).await;
        assert_eq!(
            hooks.dispatched.lock().unwrap()[0],
            json!({"body":"unknown"})
        );
        gate.release("chat");
        gate.drain("chat");
        wait_until(|| hooks.dispatched.lock().unwrap().len() == 2).await;
        assert_eq!(hooks.dispatched.lock().unwrap()[1]["body"], "guest");
        gate.release("chat");
        assert_eq!(gate.buffered_count("chat"), 0);
    }
    #[tokio::test]
    async fn capacity_refusal_keeps_owned_mail() {
        let hooks = Hooks::new();
        hooks.busy.store(true, Ordering::SeqCst);
        let gate = TurnGate::new(
            hooks.clone(),
            TurnGateOptions {
                buffer_cap: 1,
                ..Default::default()
            },
        )
        .unwrap();
        gate.deliver("chat", json!("accepted"), BusyDisposition::Buffer)
            .await
            .unwrap();
        assert_eq!(
            gate.deliver("chat", json!("overflow"), BusyDisposition::Buffer)
                .await
                .unwrap_err()
                .code,
            "TurnGateCapacityError"
        );
        assert_eq!(gate.buffered_jobs("chat"), vec![json!("accepted")]);
        assert!(hooks.discarded.lock().unwrap().is_empty());
        assert_eq!(gate.discard(|_| true, "test teardown"), 1);
        assert_eq!(
            hooks.discarded.lock().unwrap().as_slice(),
            &[(json!("accepted"), "test teardown".into())]
        );
    }
    #[tokio::test]
    async fn returned_work_stays_parked_until_explicit_delivery() {
        let hooks = Hooks::new();
        let gate = TurnGate::new(
            hooks.clone(),
            TurnGateOptions {
                recheck_ms: 1,
                ..Default::default()
            },
        )
        .unwrap();
        gate.park("chat");
        gate.put_back("chat", vec![json!("interrupted input")]);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(hooks.dispatched.lock().unwrap().is_empty());
        gate.deliver("chat", json!("continue"), BusyDisposition::Buffer)
            .await
            .unwrap();
        wait_until(|| hooks.dispatched.lock().unwrap().len() == 1).await;
        assert_eq!(hooks.dispatched.lock().unwrap()[0], "interrupted input");
        gate.release("chat");
        gate.drain("chat");
        wait_until(|| hooks.dispatched.lock().unwrap().len() == 2).await;
        assert_eq!(hooks.dispatched.lock().unwrap()[1], "continue");
        gate.release("chat");
    }
    #[tokio::test]
    async fn dispatch_failure_retains_input_until_retry() {
        let hooks = Hooks::new();
        hooks.busy.store(true, Ordering::SeqCst);
        hooks.failures.store(1, Ordering::SeqCst);
        let gate = TurnGate::new(
            hooks.clone(),
            TurnGateOptions {
                recheck_ms: 1,
                ..Default::default()
            },
        )
        .unwrap();
        gate.deliver("chat", json!("accepted"), BusyDisposition::Buffer)
            .await
            .unwrap();
        hooks.busy.store(false, Ordering::SeqCst);
        gate.drain("chat");
        wait_until(|| hooks.dispatched.lock().unwrap().len() == 1).await;
        assert_eq!(hooks.dispatched.lock().unwrap()[0], "accepted");
        assert!(hooks.discarded.lock().unwrap().is_empty());
        gate.release("chat");
    }
    #[tokio::test]
    async fn exclusive_callback_blocks_live_messages_behind_it() {
        let hooks = Hooks::new();
        hooks.busy.store(true, Ordering::SeqCst);
        let gate = TurnGate::new(hooks.clone(), TurnGateOptions::default()).unwrap();
        let barrier = gate.clone();
        let handle = crate::runtime::spawn(async move {
            barrier
                .run_exclusive(
                    "chat",
                    Box::new(|| Box::pin(async { Ok(json!("barrier result")) })),
                )
                .await
        });
        wait_until(|| gate.buffered_count("chat") == 1).await;
        assert_eq!(
            gate.deliver(
                "chat",
                json!({"identity":"owner","body":"behind"}),
                BusyDisposition::Buffer
            )
            .await
            .unwrap(),
            DeliverDisposition::Buffered
        );
        assert!(hooks.live.lock().unwrap().is_empty());
        hooks.busy.store(false, Ordering::SeqCst);
        gate.release("chat");
        gate.drain("chat");
        assert_eq!(handle.await.unwrap().unwrap(), "barrier result");
        wait_until(|| hooks.dispatched.lock().unwrap().len() == 1).await;
        assert_eq!(hooks.dispatched.lock().unwrap()[0]["body"], "behind");
        gate.release("chat");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_live_delivery_is_owned_once_per_input() {
        let hooks = Hooks::new();
        hooks.busy.store(true, Ordering::SeqCst);
        let gate = TurnGate::new(hooks.clone(), TurnGateOptions::default()).unwrap();
        let mut tasks = Vec::new();
        for index in 0..100 {
            let gate = gate.clone();
            tasks.push(crate::runtime::spawn(async move {
                gate.deliver(
                    "chat",
                    json!({"identity":"owner","index":index}),
                    BusyDisposition::Buffer,
                )
                .await
                .unwrap()
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        gate.notify_ready("chat");
        let live = hooks.live.lock().unwrap();
        assert_eq!(live.len(), 100);
        let unique: HashSet<_> = live
            .iter()
            .map(|job| job["index"].as_u64().unwrap())
            .collect();
        assert_eq!(unique.len(), 100);
        assert_eq!(gate.buffered_count("chat"), 0);
    }
}
