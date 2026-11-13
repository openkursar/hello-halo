use super::loop_owner::ProgressTiming;
use crate::error::{Error, Result};
use serde_json::{json, Value};
use std::{collections::HashMap, future::Future, sync::Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct EventFlow {
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<()>>>>,
    before_gate: tokio::sync::Mutex<()>,
}
impl EventFlow {
    pub fn consume(&self, id: &str, error: Option<Error>) {
        if let Some(sender) = self.pending.lock().unwrap().remove(id) {
            let _ = sender.send(error.map_or(Ok(()), Err));
        }
    }
    pub async fn publish<F, Fut>(
        &self,
        event: Value,
        progress: ProgressTiming,
        cancellation: &CancellationToken,
        send: F,
    ) -> Result<()>
    where
        F: FnOnce(Value) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let _before = if matches!(progress, ProgressTiming::Before) {
            Some(
                tokio::select! { _=cancellation.cancelled()=>return Err(Error::cancelled()), guard=self.before_gate.lock()=>guard },
            )
        } else {
            None
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), sender);
        let _pending = PendingEvent {
            flow: self,
            id: id.clone(),
        };
        send(json!({"kind":"event","event":event,"eventId":id,"progress":progress.as_str()}))
            .await?;
        tokio::select! { result=receiver=>result.map_err(|_|Error::cancelled())?, _=cancellation.cancelled()=>Err(Error::cancelled()) }
    }
}
struct PendingEvent<'a> {
    flow: &'a EventFlow,
    id: String,
}
impl Drop for PendingEvent<'_> {
    fn drop(&mut self) {
        self.flow.pending.lock().unwrap().remove(&self.id);
    }
}
