use crate::{
    bridge::{EventSink, HostBridge, HostServices},
    error::{Error, Result},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;

pub struct CallbackChannel {
    services:Mutex<HostServices>,
    resources:Arc<crate::resource_activity::ResourceActivity>,
    cancellation: CancellationToken,
    interruption: CancellationToken,
    closed: CancellationToken,
    output: mpsc::Sender<Value>,
    receiver: AsyncMutex<mpsc::Receiver<Value>>,
    callbacks: Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>,
    terminal_error: Mutex<Option<Error>>,
}
impl CallbackChannel {
    pub fn spawn<F, Fut>(operation: F) -> Result<Arc<Self>>
    where
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<Value>>> + Send + 'static,
    {
        Self::spawn_with_cleanup(operation, false)
    }
    pub fn spawn_graceful<F, Fut>(operation: F) -> Result<Arc<Self>>
    where
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<Value>>> + Send + 'static,
    {
        Self::spawn_with_cleanup(operation, true)
    }
    fn spawn_with_cleanup<F, Fut>(operation: F, graceful: bool) -> Result<Arc<Self>>
    where
        F: FnOnce(Arc<Self>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<Value>>> + Send + 'static,
    {
        let (output, receiver) = mpsc::channel(256);
        let channel = Arc::new(Self {
            services:Mutex::new(HostServices::default()),
            resources:Arc::new(crate::resource_activity::ResourceActivity::default()),
            cancellation: CancellationToken::new(),
            interruption: CancellationToken::new(),
            closed: CancellationToken::new(),
            output,
            receiver: AsyncMutex::new(receiver),
            callbacks: Mutex::new(HashMap::new()),
            terminal_error: Mutex::new(None),
        });
        let owned = channel.clone();
        let dispatch = crate::logging::channel_dispatch(owned.output.clone());
        crate::runtime::shared()?.spawn(async move{
            let _owner=ExecutionOwner(owned.clone());
            let result=if graceful{operation(owned.clone()).await}else{tokio::select!{_=owned.cancellation.cancelled()=>Err(Error::cancelled()),result=operation(owned.clone())=>result}};
            match result{
                Ok(Some(value))=>{let _=owned.envelope(json!({"kind":"result","result":value})).await;}
                Ok(None)=>{}
                Err(error)=>{
                    let mut value=serde_json::to_value(error).expect("SDK errors are serializable");value["kind"]=json!("error");
                    tokio::select!{_=owned.cancellation.cancelled()=>{let _=owned.output.try_send(value);},_=owned.output.send(value.clone())=>{}}
                }
            }
            owned.finish();
        }.with_subscriber(dispatch));
        Ok(channel)
    }
    pub fn set_host_services(&self, services: HostServices) { *self.services.lock().unwrap() = services; }
    pub fn resource_activity(&self)->Arc<crate::resource_activity::ResourceActivity>{self.resources.clone()}
    pub fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    pub fn interruption(&self) -> CancellationToken {
        self.interruption.clone()
    }
    pub fn interrupt(&self) {
        self.interruption.cancel();
    }
    pub async fn envelope(&self, envelope: Value) -> Result<()> {
        tokio::select! {_=self.cancellation.cancelled()=>Err(Error::cancelled()),result=self.output.send(envelope)=>result.map_err(|_|Error::new("STREAM_CLOSED","Native operation stream is closed"))}
    }
    pub async fn next(&self) -> Result<Option<Value>> {
        let mut receiver = self.receiver.lock().await;
        if self.closed.is_cancelled() && receiver.is_empty() {
            return self
                .terminal_error
                .lock()
                .unwrap()
                .clone()
                .map_or(Ok(None), Err);
        }
        let value = tokio::select! {event=receiver.recv()=>event,_=self.closed.cancelled()=>receiver.try_recv().ok()};
        if value.is_none() {
            if let Some(error) = self.terminal_error.lock().unwrap().clone() {
                return Err(error);
            }
        }
        Ok(value)
    }
    fn finish(&self) {
        for (_, callback) in std::mem::take(&mut *self.callbacks.lock().unwrap()) {
            let _ = callback.send(Err(Error::cancelled()));
        }
        self.closed.cancel();
        let _ = self.output.try_send(json!({"kind":"closed"}));
    }
    fn stop_now(&self, error: Error) {
        self.interruption.cancel();
        self.cancellation.cancel();
        *self.terminal_error.lock().unwrap() = Some(error);
        self.finish();
    }
    pub fn abort_for_host_shutdown(&self) {
        if !self.closed.is_cancelled() {
            self.stop_now(Error::new(
                "HOST_ENV_CLOSED",
                "Native operation stopped because its host environment closed",
            ));
        }
    }
    pub fn close(&self) {
        self.interruption.cancel();
        self.cancellation.cancel();
    }
    pub async fn wait_closed(&self) -> Result<()> {
        self.closed.cancelled().await;
        Ok(())
    }
    pub fn callback_response(&self, id: &str, value: Value, error: Option<Value>) -> Result<()> {
        if let Some(callback) = self.callbacks.lock().unwrap().remove(id) {
            let _ = callback.send(error.map_or(Ok(value), |error| Err(Error::from_host(error))));
        }
        Ok(())
    }
}
struct ExecutionOwner(Arc<CallbackChannel>);
impl Drop for ExecutionOwner {
    fn drop(&mut self) {
        if !self.0.closed.is_cancelled() {
            tracing::error!("Native operation ended before completion");
            self.0.stop_now(Error::new(
                "EXECUTION_STOPPED",
                "Native operation ended before completion",
            ));
        }
    }
}
struct PendingCallback<'a> {
    channel: &'a CallbackChannel,
    id: String,
}
impl Drop for PendingCallback<'_> {
    fn drop(&mut self) {
        if self
            .channel
            .callbacks
            .lock()
            .unwrap()
            .remove(&self.id)
            .is_some()
        {
            let output = self.channel.output.clone();
            let id = self.id.clone();
            let closed = self.channel.closed.clone();
            crate::runtime::spawn(async move {
                tokio::select! {_=closed.cancelled()=>{},_=output.send(json!({"kind":"callbackCancelled","id":id}))=>{}}
            });
        }
    }
}
#[async_trait]
impl HostBridge for CallbackChannel {
    fn code_search_pool(&self)->Option<Arc<crate::search::CodeSearchPool>>{self.services.lock().unwrap().code_search_pool.clone()}
    fn http_trust(&self)->Option<Arc<crate::http::HostTrust>>{self.services.lock().unwrap().http_trust.clone()}
    fn resource_activity(&self)->Option<Arc<crate::resource_activity::ResourceActivity>>{Some(self.resources.clone())}
    async fn call(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        if cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        self.callbacks.lock().unwrap().insert(id.clone(), send);
        let _pending = PendingCallback {
            channel: self,
            id: id.clone(),
        };
        tokio::select! {_=cancellation.cancelled()=>return Err(Error::cancelled()),_=self.closed.cancelled()=>return Err(Error::cancelled()),result=self.output.send(json!({"kind":"callback","id":id,"method":method,"params":params}))=>result.map_err(|_|Error::new("STREAM_CLOSED","Native operation stream is closed"))?}
        tokio::select! {_=cancellation.cancelled()=>Err(Error::cancelled()),_=self.closed.cancelled()=>Err(Error::cancelled()),result=receive=>result.map_err(|_|Error::cancelled())?}
    }
}
#[async_trait]
impl EventSink for CallbackChannel {
    async fn emit(&self, event: Value) -> Result<()> {
        self.envelope(json!({"kind":"event","event":event})).await
    }
}
