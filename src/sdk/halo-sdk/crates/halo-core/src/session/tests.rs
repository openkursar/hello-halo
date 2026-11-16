use super::*;
use std::{future::Future, sync::Weak, task::{Context, Wake, Waker}, time::Duration};

#[cfg(unix)]
#[tokio::test]
async fn idle_interrupt_stops_a_borrowed_shell_without_closing_its_owner() {
    let root = std::env::temp_dir().join(format!("halo-idle-interrupt-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let session = NativeSession::new(json!({"model":"fixture","cwd":root,"env":{"HOME":root,"AGENT_SHELL":"/bin/bash"},
        "tools":[],"skillCatalog":[],"settingSources":[],"collaboration":false,"persistSession":false,
        "systemPrompt":"Fixture instructions.","provider":{"id":"fixture","name":"Fixture","__haloSdkNativeProvider":true,
        "capabilities":{"streaming":true,"toolCalling":false,"thinking":false,"imageInput":false,"pdfInput":false,
        "audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"top_level"}}})).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = session.next().await.unwrap().unwrap();
            if event["kind"] == "ready" { break; }
        }
    }).await.unwrap();
    let tools = session.tools.lock().unwrap().clone().unwrap();
    let checkpoint = tools.retire_working_state();
    let context = crate::tools::ToolContext {
        session_id: session.id().into(), cwd: root.to_string_lossy().into(),
        env: json!({"AGENT_SHELL":"/bin/bash"}), current_turn: 0, tool_use_id: String::new(),
        cancellation: CancellationToken::new(), harness: crate::harness::baseline(),
    };
    let launch = json!({"command":"sleep 30","run_in_background":true});
    let first = tools.execute_builtin("Bash", launch.clone(), context.clone()).await.unwrap();
    let first_id = first["metadata"]["task_id"].clone();
    assert!(!first_id.is_null());
    assert!(!session.is_running());
    session.interrupt();
    assert_eq!(tools.tool_context_call("backgroundTasks.get", json!([first_id])).unwrap()["status"], "stopped");
    assert!(!context.cancellation.is_cancelled());
    assert!(!session.lifetime.is_cancelled());
    tools.tool_context_async_call("backgroundTasks.wait", json!([first_id]), &CancellationToken::new()).await.unwrap();
    let next = tools.execute_builtin("Bash", launch, context).await.unwrap();
    let next_id = next["metadata"]["task_id"].clone();
    assert_eq!(tools.tool_context_call("backgroundTasks.get", json!([next_id])).unwrap()["status"], "running");
    session.interrupt();
    assert_eq!(tools.tool_context_call("backgroundTasks.get", json!([next_id])).unwrap()["status"], "stopped");
    tools.tool_context_async_call("backgroundTasks.wait", json!([next_id]), &CancellationToken::new()).await.unwrap();
    session.close();
    tokio::time::timeout(Duration::from_secs(5), session.wait_closed()).await.unwrap().unwrap();
    checkpoint.close().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

struct FinishingActor(Weak<NativeSession>);
impl Wake for FinishingActor {
    fn wake(self: Arc<Self>) {
        if let Some(session) = self.0.upgrade() { session.end_turn(); }
    }
}

#[tokio::test]
async fn cancellation_finishing_a_running_actor_cannot_emit_an_extra_idle_stream_end() {
    let root = std::env::temp_dir().join(format!("halo-interrupt-race-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let session = NativeSession::new(json!({"model":"fixture","cwd":root,"env":{"HOME":root},
        "tools":[],"skillCatalog":[],"settingSources":[],"collaboration":false,"persistSession":false,
        "systemPrompt":"Fixture instructions.","provider":{"id":"fixture","name":"Fixture","__haloSdkNativeProvider":true,
        "capabilities":{"streaming":true,"toolCalling":false,"thinking":false,"imageInput":false,"pdfInput":false,
        "audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"top_level"}}})).unwrap();
    session.start_stream().unwrap();
    session.running.store(true, std::sync::atomic::Ordering::Release);
    let token = session.inbox.lock().unwrap().turn.clone();
    let mut cancelled = Box::pin(token.cancelled());
    let waker = Waker::from(Arc::new(FinishingActor(Arc::downgrade(&session))));
    assert!(cancelled.as_mut().poll(&mut Context::from_waker(&waker)).is_pending());
    // The waker finishes the actor synchronously inside CancellationToken::cancel.
    session.interrupt();
    let requested = session.stream_requested();
    let running = session.is_running();
    drop(cancelled);
    session.close();
    let closed = tokio::time::timeout(Duration::from_secs(5), session.wait_closed()).await;
    if closed.is_err() { session.abort_for_host_shutdown(); }
    let _ = tokio::fs::remove_dir_all(root).await;
    assert!(!running, "the finishing actor must have actually run during cancellation");
    assert!(requested, "the running actor owns its idle boundary; interrupt must not manufacture another");
    closed.unwrap().unwrap();
}
