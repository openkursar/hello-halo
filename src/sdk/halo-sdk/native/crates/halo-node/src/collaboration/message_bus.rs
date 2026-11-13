use super::{
    super::{decode, encode, failure},
    callbacks::{self, Callbacks},
};
use async_trait::async_trait;
use halo_core::{
    collaboration::{
        message_bus::{
            DeliveryHooks, MessageBus, MessageBusOptions, MessageBusStore, Observer, RecipientFence,
        },
        runtime::TurnCompletion,
        turn_gate::BusyDisposition,
    },
    error::{Error as CoreError, Result as CoreResult},
};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type Completion = Arc<dyn Fn(TurnCompletion) + Send + Sync>;
struct Bridge {
    callbacks: Arc<Callbacks>,
    completions: Arc<Mutex<HashMap<String, Completion>>>,
    options: Value,
}
impl Bridge {
    fn call(&self, name: &str, input: Value) -> CoreResult<Value> {
        self.callbacks.sync(&format!("bus.{name}"), input)
    }
    fn optional(&self, name: &str, input: Value) -> CoreResult<Option<Value>> {
        let value = self.call(name, input)?;
        Ok((!value.is_null()).then_some(value))
    }
}
impl MessageBusStore for Bridge {
    fn member(&self, team: &str, id: &str, epoch: Option<&str>) -> Option<Value> {
        self.try_member(team, id, epoch).ok().flatten()
    }
    fn member_by_name(&self, team: &str, name: &str, epoch: Option<&str>) -> Option<Value> {
        self.try_member_by_name(team, name, epoch).ok().flatten()
    }
    fn members(&self, team: &str, epoch: Option<&str>) -> Vec<Value> {
        self.try_members(team, epoch).unwrap_or_default()
    }
    fn edge_allowed(&self, team: &str, from: &str, to: &str, epoch: Option<&str>) -> bool {
        self.try_edge_allowed(team, from, to, epoch)
            .unwrap_or(false)
    }
    fn team(&self, id: &str) -> Option<Value> {
        self.try_team(id).ok().flatten()
    }
    fn epoch(&self, id: &str) -> Option<Value> {
        self.try_epoch(id).ok().flatten()
    }
    fn try_member(&self, team: &str, id: &str, epoch: Option<&str>) -> CoreResult<Option<Value>> {
        self.optional("getMember", json!({"team":team,"id":id,"epoch":epoch}))
    }
    fn try_member_by_name(
        &self,
        team: &str,
        name: &str,
        epoch: Option<&str>,
    ) -> CoreResult<Option<Value>> {
        self.optional(
            "getMemberByName",
            json!({"team":team,"name":name,"epoch":epoch}),
        )
    }
    fn try_members(&self, team: &str, epoch: Option<&str>) -> CoreResult<Vec<Value>> {
        Ok(self
            .call("listMembersByTeam", json!({"team":team,"epoch":epoch}))?
            .as_array()
            .cloned()
            .unwrap_or_default())
    }
    fn try_edge_allowed(
        &self,
        team: &str,
        from: &str,
        to: &str,
        epoch: Option<&str>,
    ) -> CoreResult<bool> {
        Ok(self.call(
            "isEdgeAllowed",
            json!({"team":team,"from":from,"to":to,"epoch":epoch}),
        )? == true)
    }
    fn try_team(&self, id: &str) -> CoreResult<Option<Value>> {
        self.optional("getTeamById", json!({"id":id}))
    }
    fn try_epoch(&self, id: &str) -> CoreResult<Option<Value>> {
        self.optional("getEpochById", json!({"id":id}))
    }
}
#[async_trait]
impl DeliveryHooks for Bridge {
    fn try_acquire_recipient_fence(&self, target: Value) -> CoreResult<RecipientFence> {
        if self.options["acquireRecipientFence"] != true {
            return Ok(RecipientFence::Absent);
        }
        let result = self.call("acquireRecipientFence", json!({"target":target}))?;
        if result["kind"] == "immediate" {
            return Ok(RecipientFence::Immediate(
                result["value"].as_str().unwrap_or("").into(),
            ));
        }
        let callbacks = self.callbacks.clone();
        let reference = result["reference"].clone();
        Ok(RecipientFence::Pending(Box::pin(async move {
            Ok(callbacks
                .asynchronous("bus.awaitRecipientFence", json!({"reference":reference}))
                .await?
                .as_str()
                .unwrap_or("")
                .into())
        })))
    }
    fn try_accept_recipient_fence(&self, target: &Value, fence: Option<&str>) -> CoreResult<bool> {
        if self.options["acceptRecipientFence"] != true {
            return Ok(true);
        }
        Ok(self.call(
            "acceptRecipientFence",
            json!({"target":target,"fence":fence}),
        )? == true)
    }
    async fn wake_target(&self, request: Value) -> CoreResult<()> {
        self.callbacks
            .asynchronous("bus.wakeTarget", request)
            .await
            .map(|_| ())
    }
    fn is_busy(&self, key: &str) -> bool {
        self.try_is_busy(key).unwrap_or(true)
    }
    fn try_is_busy(&self, key: &str) -> CoreResult<bool> {
        Ok(self.call("isBusy", json!({"key":key}))? == true)
    }
    fn try_turn_identity(&self, key: &str) -> CoreResult<Option<String>> {
        Ok(self
            .call("getTurnIdentity", json!({"key":key}))?
            .as_str()
            .map(String::from))
    }
    fn deliver_mid_turn(&self, request: Value) -> CoreResult<bool> {
        Ok(self.call("deliverMidTurn", request)? == true)
    }
    fn deliver_remote(&self, mut request: Value, complete: Completion) -> CoreResult<Option<bool>> {
        if self.options["deliverRemote"] != true {
            return Ok(None);
        }
        let reference = halo_core::collaboration::protocol::id();
        self.completions
            .lock()
            .unwrap()
            .insert(reference.clone(), complete);
        request["completionReference"] = reference.clone().into();
        match self.call("deliverRemote", request) {
            Ok(value) => Ok(value.as_bool()),
            Err(error) => {
                self.completions.lock().unwrap().remove(&reference);
                Err(error)
            }
        }
    }
    fn try_reachable(&self, app: &str, team: &str) -> CoreResult<bool> {
        Ok(self.call("checkReachable", json!({"app":app,"team":team}))? == true)
    }
    async fn deliver_to_coordinator(&self, request: Value) -> CoreResult<Option<String>> {
        if self.options["deliverToCoordinator"] != true {
            return Ok(None);
        }
        Ok(self
            .callbacks
            .asynchronous("bus.deliverToCoordinator", request)
            .await?
            .as_str()
            .map(String::from))
    }
}
enum Owner {
    Standalone(Arc<MessageBus>),
    Runtime(Arc<halo_core::collaboration::runtime::CollaborationRuntime>),
}
#[napi]
pub struct NativeMessageBus {
    owner: Owner,
    callbacks: Arc<Callbacks>,
    completions: Arc<Mutex<HashMap<String, Completion>>>,
}
impl NativeMessageBus {
    fn core(&self) -> &Arc<MessageBus> {
        match &self.owner {
            Owner::Standalone(bus) => bus,
            Owner::Runtime(runtime) => &runtime.bus,
        }
    }
    pub(crate) fn from_runtime(
        runtime: Arc<halo_core::collaboration::runtime::CollaborationRuntime>,
        callbacks: Arc<Callbacks>,
    ) -> Self {
        Self {
            owner: Owner::Runtime(runtime),
            callbacks,
            completions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
#[napi]
impl NativeMessageBus {
    #[napi(constructor)]
    pub fn new(mut env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        let callbacks = Callbacks::new(env, &callback)?;
        let completions = Arc::new(Mutex::new(HashMap::new()));
        let bridge = Arc::new(Bridge {
            callbacks: callbacks.clone(),
            completions: completions.clone(),
            options: options.clone(),
        });
        let observer = |name: &'static str| -> Option<Observer> {
            if options[name] != true {
                return None;
            }
            let callbacks = callbacks.clone();
            Some(Arc::new(move |value| {
                callbacks.sync(&format!("bus.{name}"), value).map(|_| ())
            }))
        };
        let bus = MessageBus::new(
            bridge.clone(),
            bridge,
            MessageBusOptions {
                harness: halo_core::harness::baseline(),
                max_messages: options["circuitOverrides"]["maxMessages"]
                    .as_u64()
                    .unwrap_or(2000) as usize,
                max_forward_depth: options["circuitOverrides"]["maxForwardDepth"]
                    .as_u64()
                    .unwrap_or(999) as usize,
                sync_wait_timeout_ms: options["syncWaitTimeoutMs"]
                    .as_u64()
                    .unwrap_or(2 * 60 * 60 * 1000),
                reservation_ttl_ms: options["reservationTtlMs"].as_u64(),
                on_message: observer("onMessage"),
                record_activity: observer("recordActivity"),
            },
        );
        crate::environment::track(&mut env, &bus, MessageBus::abort_now, "message bus")?;
        Ok(Self {
            owner: Owner::Standalone(bus),
            callbacks,
            completions,
        })
    }
    #[napi]
    pub fn call(
        &self,
        env: Env,
        name: String,
        payload: String,
        callback: JsFunction,
    ) -> Result<String> {
        let input = decode(&payload)?;
        let key = input["sessionKey"].as_str().unwrap_or("");
        let team = input["teamId"].as_str().unwrap_or("");
        let epoch = input["epochId"].as_str();
        let operation = || {
            self.callbacks
                .scoped(env, callback, || -> CoreResult<Value> {
                    Ok(match name.as_str() {
                        "notifySessionReady" => {
                            self.core().gate.checked_notify_ready(key)?;
                            Value::Null
                        }
                        "isSessionOccupied" => json!(self.core().gate.checked_is_occupied(key)?),
                        "drainMailbox" => {
                            self.core().gate.checked_drain(key)?;
                            Value::Null
                        }
                        "holdSession" => json!(self.core().hold_session(key)),
                        "cancelSession" => {
                            self.core().cancel_session(key);
                            Value::Null
                        }
                        "continueSession" => {
                            self.core().continue_session(key);
                            Value::Null
                        }
                        "returnDeliveries" => {
                            self.core().return_deliveries(
                                key,
                                input["deliveries"].as_array().cloned().unwrap_or_default(),
                            );
                            Value::Null
                        }
                        "returnHeldBack" => json!(self.core().return_held_back(
                            key,
                            input["deliveries"].as_array().cloned().unwrap_or_default()
                        )),
                        "completeTurn" => {
                            self.core().checked_complete_turn(
                                key,
                                &input["trigger"],
                                serde_json::from_value(input["outcome"].clone())?,
                                input["sealPending"] == true,
                            )?;
                            Value::Null
                        }
                        "assertCanContact" => {
                            self.core().assert_can_contact(
                                team,
                                input["fromAppId"].as_str().unwrap_or(""),
                                input["toAppId"].as_str().unwrap_or(""),
                                input["collabMode"].as_str().unwrap_or(""),
                                epoch,
                            )?;
                            Value::Null
                        }
                        "resolveMemberAppId" => self
                            .core()
                            .resolve_member(
                                team,
                                input["memberName"].as_str().unwrap_or(""),
                                epoch,
                            )?
                            .into(),
                        "resolvePendingWaitsForMember" => {
                            json!(self.core().resolve_pending_for_member(
                                input["appId"].as_str().unwrap_or(""),
                                serde_json::from_value(input["outcome"].clone())?
                            ))
                        }
                        "getEpochStats" => self.core().epoch_stats(epoch.unwrap_or("")),
                        "resetEpoch" => {
                            self.core().reset_epoch(epoch.unwrap_or(""));
                            Value::Null
                        }
                        "resetCircuit" => {
                            self.core().reset_circuit(epoch.unwrap_or(""));
                            Value::Null
                        }
                        "tripExternal" => {
                            self.core().trip_external(
                                team,
                                epoch.unwrap_or(""),
                                input["reason"].as_str().unwrap_or(""),
                            );
                            Value::Null
                        }
                        "onBreach" => {
                            let callbacks = self.callbacks.clone();
                            let reference = input["reference"].clone();
                            json!(self.core().on_breach(Arc::new(move |event| callbacks
                                .sync("bus.onBreach", json!({"reference":reference,"event":event}))
                                .map(|_| ()))))
                        }
                        "removeBreachListener" => {
                            self.core()
                                .remove_breach_listener(input["listener"].as_u64().unwrap_or(0));
                            Value::Null
                        }
                        "getPendingRecordedInputIds" => {
                            json!(self.core().pending_recorded_input_ids(key))
                        }
                        "hasBufferedMessages" => {
                            json!(self.core().has_buffered_messages(epoch.unwrap_or("")))
                        }
                        "remoteCompletion" => {
                            let completion = self
                                .completions
                                .lock()
                                .unwrap()
                                .get(input["reference"].as_str().unwrap_or(""))
                                .cloned();
                            if let Some(completion) = completion {
                                completion(serde_json::from_value(input["outcome"].clone())?);
                            }
                            Value::Null
                        }
                        "releaseRemote" => {
                            self.completions
                                .lock()
                                .unwrap()
                                .remove(input["reference"].as_str().unwrap_or(""));
                            Value::Null
                        }
                        _ => {
                            return Err(CoreError::new(
                                "MESSAGE_BUS_OPERATION",
                                format!("Unknown message bus operation: {name}"),
                            ))
                        }
                    })
                })
                .map_err(failure)
        };
        let result = if matches!(
            name.as_str(),
            "notifySessionReady"
                | "drainMailbox"
                | "returnDeliveries"
                | "returnHeldBack"
                | "completeTurn"
                | "tripExternal"
        ) {
            crate::with_runtime(operation)
        } else {
            operation()
        }?;
        encode(&result)
    }
    #[napi]
    pub fn start(
        &self,
        env: Env,
        name: String,
        payload: String,
        callback: JsFunction,
    ) -> Result<JsObject> {
        let input = decode(&payload)?;
        let bus = self.core().clone();
        let callbacks = self.callbacks.clone();
        callbacks::start(env, callbacks.clone(), callback, async move {
            match name.as_str() {
                "send" => bus.send(input).await,
                "deliverRuntimeWake" => {
                    let mut envelope = input["envelope"].clone();
                    let mut trigger = input["trigger"].clone();
                    let disposition = bus
                        .deliver_runtime_wake(
                            &mut envelope,
                            &mut trigger,
                            if input["onBusy"] == "skip" {
                                BusyDisposition::Skip
                            } else {
                                BusyDisposition::Buffer
                            },
                            input["coalescingKey"].as_str(),
                        )
                        .await?;
                    Ok(json!({"disposition":disposition,"envelope":envelope,"trigger":trigger}))
                }
                "runRelayedTurn" => {
                    let reference = input["reference"].clone();
                    bus.run_relayed_turn(
                        input["sessionKey"].as_str().unwrap_or(""),
                        Box::new(move || {
                            Box::pin(async move {
                                callbacks
                                    .asynchronous(
                                        "bus.runRelayedTurn",
                                        json!({"reference":reference}),
                                    )
                                    .await
                            })
                        }),
                    )
                    .await
                }
                _ => Err(CoreError::new(
                    "MESSAGE_BUS_OPERATION",
                    format!("Unknown message bus operation: {name}"),
                )),
            }
        })
    }
}
