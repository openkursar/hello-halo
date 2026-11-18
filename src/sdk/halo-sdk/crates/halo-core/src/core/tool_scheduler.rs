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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tool_execution::tests::{call, fixture, request, Request};
    use serde_json::json;

    async fn start(receiver: &mut mpsc::UnboundedReceiver<Request>, id: &str) -> Request {
        request(receiver, "tools.concurrencySafe").await.reply.send(Ok(json!(true))).unwrap();
        let operation = request(receiver, "tools.execute").await;
        assert_eq!(operation.params["context"]["toolUseId"], id);
        operation
    }
    fn complete(operation: Request) {
        let id = operation.params["context"]["toolUseId"].clone();
        operation.reply.send(Ok(json!({"content":id,"isError":false}))).unwrap();
    }
    async fn quiet(receiver: &mut mpsc::UnboundedReceiver<Request>) {
        assert!(tokio::time::timeout(std::time::Duration::from_millis(20), receiver.recv()).await.is_err());
    }
    #[tokio::test]
    async fn safe_calls_overlap_refill_capacity_and_retain_admission_order() {
        let (execution, mut receiver, _) = fixture(json!({"env":{"HALO_MAX_TOOL_CONCURRENCY":"2"}}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Safe"), None, false).unwrap();
        let first = start(&mut receiver, "0").await;
        scheduler.enqueue(call("1", "Safe"), None, false).unwrap();
        let second = start(&mut receiver, "1").await;
        scheduler.enqueue(call("2", "Safe"), None, false).unwrap();
        quiet(&mut receiver).await;
        complete(second);
        complete(start(&mut receiver, "2").await);
        complete(first);
        let results = scheduler.finish().await.unwrap();
        assert_eq!(results.iter().map(|v| v["content"].as_str().unwrap()).collect::<Vec<_>>(), ["0", "1", "2"]);
    }
    #[tokio::test]
    async fn exclusive_calls_drain_active_work_and_block_later_calls() {
        let (execution, mut receiver, _) = fixture(json!({}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Safe"), None, false).unwrap();
        let first = start(&mut receiver, "0").await;
        scheduler.enqueue(call("1", "Exclusive"), None, false).unwrap();
        scheduler.enqueue(call("2", "Safe"), None, false).unwrap();
        quiet(&mut receiver).await;
        complete(first);
        let exclusive = request(&mut receiver, "tools.execute").await;
        assert_eq!(exclusive.params["context"]["toolUseId"], "1");
        quiet(&mut receiver).await;
        complete(exclusive);
        complete(start(&mut receiver, "2").await);
        assert_eq!(scheduler.finish().await.unwrap().len(), 3);
    }
    #[tokio::test]
    async fn exclusive_barrier_survives_an_empty_queue() {
        let (execution, mut receiver, _) = fixture(json!({}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Exclusive"), None, false).unwrap();
        let exclusive = request(&mut receiver, "tools.execute").await;
        scheduler.enqueue(call("1", "Safe"), None, false).unwrap();
        quiet(&mut receiver).await;
        complete(exclusive);
        complete(start(&mut receiver, "1").await);
        assert_eq!(scheduler.finish().await.unwrap().len(), 2);
    }
    #[tokio::test]
    async fn independent_schedulers_overlap_exclusive_calls() {
        let (first, mut a, _) = fixture(json!({}));
        let (second, mut b, _) = fixture(json!({}));
        let first = ToolScheduler::new(first);
        let second = ToolScheduler::new(second);
        first.enqueue(call("0", "Exclusive"), None, false).unwrap();
        second.enqueue(call("1", "Exclusive"), None, false).unwrap();
        let a = request(&mut a, "tools.execute").await;
        let b = request(&mut b, "tools.execute").await;
        complete(a);
        complete(b);
        assert_eq!(first.finish().await.unwrap().len(), 1);
        assert_eq!(second.finish().await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn cancelled_turn_and_empty_producer_start_no_work() {
        let (execution, mut receiver, _) = fixture(json!({}));
        execution.cancellation.cancel();
        let scheduler = ToolScheduler::new(execution);
        assert!(scheduler.enqueue(call("0", "Safe"), None, false).is_err());
        match scheduler.finish().await {
            Ok(results) => assert!(results.is_empty()),
            Err(error) => assert!(error.is_abort()),
        }
        assert!(receiver.try_recv().is_err());
        let (execution, mut receiver, _) = fixture(json!({}));
        assert!(ToolScheduler::new(execution).finish().await.unwrap().is_empty());
        assert!(receiver.try_recv().is_err());
    }
    #[tokio::test]
    async fn cancellation_during_preparation_prevents_active_and_queued_calls() {
        let (execution, mut receiver, _) = fixture(json!({"permissionMode":"default","canUseTool":{"__haloSdkNativeCallback":"permission"}}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Safe"), None, false).unwrap();
        scheduler.enqueue(call("1", "Safe"), None, false).unwrap();
        let permission = request(&mut receiver, "permissions.call").await;
        scheduler.stop();
        assert!(scheduler.finish().await.unwrap_err().is_abort());
        drop(permission);
        assert!(receiver.try_recv().is_err());
    }
    #[tokio::test]
    async fn environment_limits_accept_positive_integers_and_reject_invalid_values() {
        for (value, cap) in [("",10), ("4",4), ("0",10), ("-2",10), ("many",10), ("1.5",10), ("4workers",10), ("Infinity",10), ("9007199254740992",10)] {
            let (execution, mut receiver, _) = fixture(json!({"env":{"HALO_MAX_TOOL_CONCURRENCY":value}}));
            let scheduler = ToolScheduler::new(execution);
            let mut running = Vec::new();
            for index in 0..cap {
                scheduler.enqueue(call(&index.to_string(), "Safe"), None, false).unwrap();
                running.push(start(&mut receiver, &index.to_string()).await);
            }
            scheduler.enqueue(call(&cap.to_string(), "Safe"), None, false).unwrap();
            quiet(&mut receiver).await;
            complete(running.pop().unwrap());
            complete(start(&mut receiver, &cap.to_string()).await);
            for operation in running { complete(operation); }
            assert_eq!(scheduler.finish().await.unwrap().len(), cap + 1);
        }
    }
    #[tokio::test]
    async fn failed_classification_uses_exclusive_admission() {
        let (execution, mut receiver, _) = fixture(json!({}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Safe"), None, false).unwrap();
        scheduler.enqueue(call("1", "Safe"), None, false).unwrap();
        request(&mut receiver, "tools.concurrencySafe").await.reply.send(Err(Error::new("TEST", "Cannot classify"))).unwrap();
        let first = request(&mut receiver, "tools.execute").await;
        quiet(&mut receiver).await;
        complete(first);
        complete(start(&mut receiver, "1").await);
        assert_eq!(scheduler.finish().await.unwrap().len(), 2);
    }
    #[tokio::test]
    async fn permissions_prepare_in_order_and_classification_uses_effective_input() {
        let (execution, mut receiver, _) = fixture(json!({"permissionMode":"default","canUseTool":{"__haloSdkNativeCallback":"permission"}}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Safe"), None, false).unwrap();
        scheduler.enqueue(call("1", "Safe"), None, false).unwrap();
        let permission = request(&mut receiver, "permissions.call").await;
        assert_eq!(permission.params["toolUseId"], "0");
        quiet(&mut receiver).await;
        permission.reply.send(Ok(json!({"result":{"behavior":"allow","updatedInput":{"value":"effective"}}}))).unwrap();
        let classification = request(&mut receiver, "tools.concurrencySafe").await;
        assert_eq!(classification.params["input"]["value"], "effective");
        classification.reply.send(Ok(json!(false))).unwrap();
        let first = request(&mut receiver, "tools.execute").await;
        quiet(&mut receiver).await;
        complete(first);
        let permission = request(&mut receiver, "permissions.call").await;
        assert_eq!(permission.params["toolUseId"], "1");
        permission.reply.send(Ok(json!({"result":{"behavior":"allow"}}))).unwrap();
        complete(start(&mut receiver, "1").await);
        assert_eq!(scheduler.finish().await.unwrap().len(), 2);
    }
    #[tokio::test]
    async fn effectful_hook_preparation_waits_for_running_safe_work() {
        let (execution, mut receiver, _) = fixture(json!({"hooks":{"PreToolUse":[{"hooks":[{"__haloSdkNativeCallback":"pre"}]}]}}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Safe"), None, false).unwrap();
        request(&mut receiver, "hooks.call").await.reply.send(Ok(json!({"result":{}}))).unwrap();
        request(&mut receiver, "hooks.release").await.reply.send(Ok(json!(null))).unwrap();
        let first = start(&mut receiver, "0").await;
        scheduler.enqueue(call("1", "Safe"), None, false).unwrap();
        quiet(&mut receiver).await;
        complete(first);
        request(&mut receiver, "hooks.call").await.reply.send(Ok(json!({"result":{}}))).unwrap();
        request(&mut receiver, "hooks.release").await.reply.send(Ok(json!(null))).unwrap();
        complete(start(&mut receiver, "1").await);
        assert_eq!(scheduler.finish().await.unwrap().len(), 2);
    }
    struct FailingProgress {
        failed: tokio::sync::Notify,
    }
    #[async_trait::async_trait]
    impl crate::bridge::EventSink for FailingProgress {
        async fn emit(&self, event: Value) -> Result<()> {
            if event["tool_use_id"] == "0" && event.get("elapsed_time_seconds").is_some() {
                self.failed.notify_one();
                return Err(Error::new("FIRST_FAILURE", "Progress delivery failed"));
            }
            Ok(())
        }
    }
    #[tokio::test]
    async fn first_failure_cancels_active_sibling_and_discards_queued_work() {
        let (mut execution, mut receiver, _) = fixture(json!({"env":{"HALO_MAX_TOOL_CONCURRENCY":"2"}}));
        let events = Arc::new(FailingProgress { failed: tokio::sync::Notify::new() });
        Arc::get_mut(&mut execution).unwrap().events = events.clone();
        let scheduler = ToolScheduler::new(execution.clone());
        scheduler.enqueue(call("0", "Safe"), None, false).unwrap();
        let first = start(&mut receiver, "0").await;
        scheduler.enqueue(call("1", "Safe"), None, false).unwrap();
        let sibling = start(&mut receiver, "1").await;
        scheduler.enqueue(call("2", "Exclusive"), None, false).unwrap();
        complete(first);
        events.failed.notified().await;
        let failure = scheduler.finish().await.unwrap_err();
        assert_eq!(failure.code, "FIRST_FAILURE");
        assert!(execution.cancellation.is_cancelled());
        assert_eq!(execution.completed.lock().unwrap()["0"]["content"], "0");
        assert!(!execution.completed.lock().unwrap().contains_key("1"));
        assert!(sibling.reply.send(Ok(json!({"content":"late","isError":false}))).is_err());
        assert!(receiver.try_recv().is_err());
    }
    #[tokio::test]
    async fn unknown_tool_is_rejected_without_host_execution() {
        let (execution, mut receiver, _) = fixture(json!({}));
        let scheduler = ToolScheduler::new(execution);
        scheduler.enqueue(call("0", "Missing"), None, false).unwrap();
        let results = scheduler.finish().await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["isError"], true);
        assert!(receiver.try_recv().is_err());
    }
}
