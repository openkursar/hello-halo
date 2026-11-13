use super::tool_execution::{Execution, Prepared};
use crate::error::{Error, Result};
use futures::{future::BoxFuture, stream::FuturesUnordered, FutureExt, StreamExt};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Arc,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub struct ToolScheduler {
    sender: Option<mpsc::UnboundedSender<(Value, Option<String>, bool)>>,
    task: tokio::task::JoinHandle<Result<Vec<Value>>>,
    cancellation: CancellationToken,
}

impl ToolScheduler {
    pub fn new(execution: Arc<Execution>) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<(Value, Option<String>, bool)>();
        let cancellation = execution.cancellation.clone();
        let task = crate::runtime::spawn(async move {
            let configured = execution.options["env"]["HALO_MAX_TOOL_CONCURRENCY"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| std::env::var("HALO_MAX_TOOL_CONCURRENCY").ok())
                .unwrap_or_default();
            let cap = configured
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
                .unwrap_or(10.0) as usize;
            let exclusive_preparation = ["PreToolUse", "PostToolUse", "PostToolUseFailure"]
                .iter()
                .any(|event| {
                    execution.options["hooks"][*event]
                        .as_array()
                        .is_some_and(|hooks| !hooks.is_empty())
                });
            let mut queue = VecDeque::<(usize, Value, Option<String>, bool)>::new();
            let mut active =
                FuturesUnordered::<BoxFuture<'static, (usize, bool, Result<Value>)>>::new();
            let mut preparing: Option<BoxFuture<'static, Result<(usize, bool, Prepared)>>> = None;
            let mut ready = None;
            let mut results = BTreeMap::new();
            let mut next = 0usize;
            let mut closed = false;
            let mut exclusive = false;
            let mut failure = None;
            loop {
                if failure.is_none() && !exclusive && active.len() < cap {
                    if let Some((index, safe, prepared)) = ready.take() {
                        if safe || active.is_empty() {
                            let execution = execution.clone();
                            exclusive = !safe;
                            active.push(
                                async move { (index, safe, execution.run(prepared).await) }.boxed(),
                            );
                            continue;
                        }
                        ready = Some((index, safe, prepared));
                    } else if preparing.is_none() && (!exclusive_preparation || active.is_empty()) {
                        if let Some((index, call, unreadable, format_recovery)) = queue.pop_front() {
                            let execution = execution.clone();
                            preparing = Some(
                                async move {
                                    let prepared =
                                        execution.prepare(call, unreadable.as_deref(), format_recovery).await?;
                                    let safe = execution.concurrency_safe(&prepared.call).await;
                                    Ok((index, safe, prepared))
                                }
                                .boxed(),
                            );
                        }
                    }
                }
                if closed
                    && active.is_empty()
                    && preparing.is_none()
                    && (failure.is_some() || (queue.is_empty() && ready.is_none()))
                {
                    break;
                }
                tokio::select! {
                    _ = execution.cancellation.cancelled(), if failure.is_none() => {
                        failure = Some(Error::cancelled()); closed = true;
                    }
                    incoming = receiver.recv(), if !closed => {
                        match incoming {
                            Some((call,unreadable,format_recovery)) => { queue.push_back((next,call,unreadable,format_recovery)); next += 1; }
                            None => closed = true,
                        }
                    }
                    prepared = async { preparing.as_mut().unwrap().await }, if preparing.is_some() => {
                        preparing = None;
                        match prepared { Ok(prepared) if failure.is_none() => ready = Some(prepared), Ok(_) => {}, Err(error) => { failure.get_or_insert(error); execution.cancellation.cancel(); closed = true; } }
                    }
                    completed = active.next(), if !active.is_empty() => {
                        let (index,safe,result) = completed.unwrap();
                        if !safe { exclusive = false; }
                        match result { Ok(result) => { results.insert(index,result); }, Err(error) => { failure.get_or_insert(error); execution.cancellation.cancel(); closed = true; } }
                    }
                }
                if failure.is_some() && (!queue.is_empty() || ready.is_some()) {
                    tracing::warn!(
                        queued = queue.len() + usize::from(ready.is_some()),
                        running = active.len(),
                        "Queued tool calls discarded because execution stopped"
                    );
                    queue.clear();
                    ready = None;
                }
            }
            if let Some(error) = failure {
                Err(error)
            } else {
                Ok(results.into_values().collect())
            }
        });
        Self {
            sender: Some(sender),
            task,
            cancellation,
        }
    }
    pub fn enqueue(&self, call: Value, unreadable: Option<String>, format_recovery: bool) -> Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        self.sender
            .as_ref()
            .ok_or_else(|| Error::new("SCHEDULER_CLOSED", "Tool scheduler is closed"))?
            .send((call, unreadable, format_recovery))
            .map_err(|_| Error::new("SCHEDULER_CLOSED", "Tool scheduler is closed"))
    }
    pub fn stop(&self) {
        self.cancellation.cancel();
    }
    pub async fn finish(mut self) -> Result<Vec<Value>> {
        self.sender.take();
        (&mut self.task)
            .await
            .map_err(|error| Error::new("TOOL_SCHEDULER", error.to_string()))?
    }
}

impl Drop for ToolScheduler {
    fn drop(&mut self) {
        if !self.task.is_finished() {
            self.cancellation.cancel();
        }
    }
}
