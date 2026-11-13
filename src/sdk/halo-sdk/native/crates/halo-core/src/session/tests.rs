use super::*;
use std::{future::Future, sync::Weak, task::{Context, Wake, Waker}, time::Duration};

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
