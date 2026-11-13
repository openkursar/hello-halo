use crate::{history::Journal, session::NativeSession};
use serde_json::{json, Value};
use std::{collections::VecDeque, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};

struct Turn {
    events: Vec<Value>,
    history: Vec<Value>,
}

impl Turn {
    fn compacted(&self) -> bool {
        self.events
            .iter()
            .any(|event| event["type"] == "system" && event["subtype"] == "compact_boundary")
    }

    fn assert_result(&self, is_error: bool) {
        let results: Vec<_> = self
            .events
            .iter()
            .filter(|event| event["type"] == "result")
            .collect();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["is_error"], is_error);
    }
}

struct Fixture {
    session: Arc<NativeSession>,
    directory: PathBuf,
    path: PathBuf,
    iterations: mpsc::UnboundedReceiver<Vec<Value>>,
    stream: VecDeque<Value>,
    requests: Vec<Value>,
    summaries: Vec<Value>,
    pause_summary: Option<oneshot::Sender<String>>,
}

fn summary(text: &str) -> Value {
    json!({"id":"summary","model":"fixture","content":[{"type":"text","text":text}],
        "stopReason":"end_turn","usage":{"input_tokens":10,"output_tokens":10}})
}

impl Fixture {
    async fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("halo-compact-persistence-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let options = json!({
            "provider":{"id":"fixture","name":"Fixture","__haloSdkNativeProvider":true,
                "capabilities":{"streaming":true,"toolCalling":true,"thinking":false,"imageInput":false,
                    "pdfInput":false,"audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"top_level"}},
            "model":"fixture","cwd":directory,"env":{"HOME":directory,"CLAUDE_CONFIG_DIR":directory.join("state")},
            "tools":[],"settingSources":[],"collaboration":false,"permissionMode":"bypassPermissions",
            "systemPrompt":"Test assistant.","maxTurns":4,"contextWindow":16000,"maxOutputTokens":1024,
            "thinking":{"type":"disabled"},"turnEndChecks":{"openWork":false,"completion":false}
        });
        let session = NativeSession::new(options.clone()).unwrap();
        let (sender, iterations) = mpsc::unbounded_channel();
        *session.iteration_observer.lock().unwrap() = Some(sender);
        let path = crate::history::transcript_path(session.id(), &options);
        loop {
            let envelope = tokio::time::timeout(Duration::from_secs(10), session.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            match envelope["kind"].as_str().unwrap() {
                "ready" => break,
                "log" => {}
                kind => panic!("unexpected preparation envelope {kind}: {envelope}"),
            }
        }
        Self {
            session,
            directory,
            path,
            iterations,
            stream: VecDeque::new(),
            requests: Vec::new(),
            summaries: Vec::new(),
            pause_summary: None,
        }
    }

    fn journal(&self) -> Journal {
        self.session
            .transcript
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone()
    }

    async fn turn(&mut self, input: &str) -> Turn {
        self.session
            .send(json!(input), uuid::Uuid::new_v4().to_string(), false)
            .unwrap();
        self.session.start_stream().unwrap();
        tokio::time::timeout(Duration::from_secs(10), self.drain())
            .await
            .expect("session did not become idle")
    }

    async fn drain(&mut self) -> Turn {
        let mut events = Vec::new();
        loop {
            let envelope = self
                .session
                .next()
                .await
                .unwrap()
                .expect("session closed before becoming idle");
            match envelope["kind"].as_str().unwrap() {
                "callback" => {
                    let id = envelope["id"].as_str().unwrap();
                    let input = &envelope["params"];
                    let value = match envelope["method"].as_str().unwrap() {
                        "provider.start" => {
                            let text = if self.requests.is_empty() {
                                format!("ORIGINAL_DETAIL {}", "old detail ".repeat(8_000))
                            } else {
                                "done".to_owned()
                            };
                            self.requests.push(input.clone());
                            assert!(self.stream.is_empty());
                            self.stream = VecDeque::from([
                                json!({"type":"message_start","id":"reused-id","model":"fixture","usage":{"input_tokens":10,"output_tokens":2}}),
                                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":text}}),
                                json!({"type":"content_block_stop","index":0}),
                                json!({"type":"message_delta","stopReason":"end_turn"}),
                                json!({"type":"message_stop"}),
                            ]);
                            json!("fixture-stream")
                        }
                        "provider.next" => self.stream.pop_front().map_or_else(
                            || json!({"done":true}),
                            |event| json!({"done":false,"value":event}),
                        ),
                        "provider.return" => {
                            self.stream.clear();
                            Value::Null
                        }
                        "provider.complete" => {
                            self.summaries.push(input.clone());
                            if let Some(started) = self.pause_summary.take() {
                                started.send(id.to_owned()).unwrap();
                                continue;
                            }
                            summary("SUMMARY_SENTINEL")
                        }
                        method => panic!("unexpected callback {method}: {input}"),
                    };
                    self.session.callback_response(id, value, None).unwrap();
                }
                "event" => {
                    if let Some(id) = envelope["eventId"].as_str() {
                        self.session.event_consumed(id, None);
                    }
                    let event = envelope["event"].clone();
                    let idle = event["type"] == "system"
                        && event["subtype"] == "session_state_changed"
                        && event["state"] == "idle";
                    events.push(event);
                    if idle {
                        return Turn {
                            events,
                            history: self.iterations.recv().await.unwrap(),
                        };
                    }
                }
                "log" | "inputConsumed" | "callbackCancelled" => {}
                kind => panic!("unexpected session envelope {kind}: {envelope}"),
            }
        }
    }

    async fn persisted(&self) -> String {
        self.journal().flush().await.unwrap();
        let report = crate::history::read_report(&self.path, None).await.unwrap();
        assert_eq!(report.damaged, 0);
        json!(report.messages).to_string()
    }

    async fn close(self) {
        self.session.close();
        tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(envelope) = self.session.next().await.unwrap() {
                if let Some(id) = envelope["eventId"].as_str() {
                    self.session.event_consumed(id, None);
                }
                assert_ne!(envelope["kind"], "error", "{envelope}");
            }
            self.session.output_consumed();
            self.session.wait_closed().await.unwrap();
        })
        .await
        .expect("session did not close");
        tokio::fs::remove_dir_all(&self.directory).await.unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.session.close();
    }
}

#[tokio::test]
async fn checkpoint_write_failure_preserves_live_and_persisted_history() {
    let mut fixture = Fixture::new().await;
    fixture.turn("original task").await.assert_result(false);
    let (entered, release) = fixture.journal().pause_next_checkpoint();
    let path = fixture.path.clone();
    let backup = path.with_extension("saved");
    let pending = tokio::spawn(async move {
        let turn = fixture.turn("compact now").await;
        (fixture, turn)
    });
    tokio::time::timeout(Duration::from_secs(10), entered)
        .await
        .unwrap()
        .unwrap();
    let original = tokio::fs::read(&path).await.unwrap();
    tokio::fs::rename(&path, &backup).await.unwrap();
    tokio::fs::create_dir(&path).await.unwrap();
    release.send(()).unwrap();
    let (mut fixture, failed) = pending.await.unwrap();
    tokio::fs::remove_dir(&path).await.unwrap();
    tokio::fs::rename(&backup, &path).await.unwrap();
    failed.assert_result(true);
    assert!(!failed.compacted());
    assert!(json!(failed.history)
        .to_string()
        .contains("ORIGINAL_DETAIL"));
    assert!(!json!(failed.history)
        .to_string()
        .contains("SUMMARY_SENTINEL"));
    assert!(fixture.persisted().await.contains("ORIGINAL_DETAIL"));
    assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
    assert!(!String::from_utf8(original)
        .unwrap()
        .contains("compact_checkpoint"));
    assert_eq!(fixture.summaries.len(), 1);
    let retry = fixture.turn("retry").await;
    retry.assert_result(false);
    assert!(retry.compacted());
    assert_eq!(fixture.summaries.len(), 2);
    assert!(fixture.summaries[1]["messages"]
        .to_string()
        .contains("ORIGINAL_DETAIL"));
    assert!(fixture.persisted().await.contains("SUMMARY_SENTINEL"));
    fixture.close().await;
}

#[tokio::test]
async fn interruption_during_checkpoint_write_installs_the_committed_history() {
    let mut fixture = Fixture::new().await;
    fixture.turn("original task").await.assert_result(false);
    let (entered, release) = fixture.journal().pause_next_checkpoint();
    let session = fixture.session.clone();
    let path = fixture.path.clone();
    let pending = tokio::spawn(async move {
        let turn = fixture.turn("compact now").await;
        (fixture, turn)
    });
    tokio::time::timeout(Duration::from_secs(10), entered)
        .await
        .unwrap()
        .unwrap();
    assert!(!tokio::fs::read_to_string(&path)
        .await
        .unwrap()
        .contains("compact_checkpoint"));
    session.interrupt();
    release.send(()).unwrap();
    let (mut fixture, interrupted) = pending.await.unwrap();
    interrupted.assert_result(true);
    assert!(interrupted.compacted());
    let live = json!(interrupted.history).to_string();
    assert!(live.contains("SUMMARY_SENTINEL"));
    assert!(!live.contains("ORIGINAL_DETAIL"));
    let restored = fixture.persisted().await;
    assert!(restored.contains("SUMMARY_SENTINEL"));
    assert!(!restored.contains("ORIGINAL_DETAIL"));
    let raw = tokio::fs::read_to_string(&path).await.unwrap();
    assert!(raw.contains("ORIGINAL_DETAIL"));
    assert!(raw.contains("compact_checkpoint"));
    assert_eq!(fixture.requests.len(), 1);
    assert_eq!(fixture.summaries.len(), 1);
    let retry = fixture.turn("retry after interruption").await;
    retry.assert_result(false);
    assert!(!retry.compacted());
    assert_eq!(fixture.summaries.len(), 1);
    assert!(fixture.requests[1]["messages"]
        .to_string()
        .contains("SUMMARY_SENTINEL"));
    assert!(!fixture.requests[1]["messages"]
        .to_string()
        .contains("ORIGINAL_DETAIL"));
    fixture.close().await;
}

#[tokio::test]
async fn summary_cancellation_does_not_submit_a_checkpoint() {
    let mut fixture = Fixture::new().await;
    fixture.turn("original task").await.assert_result(false);
    let (mut entered, release) = fixture.journal().pause_next_checkpoint();
    let (started, summary_started) = oneshot::channel();
    fixture.pause_summary = Some(started);
    let session = fixture.session.clone();
    let pending = tokio::spawn(async move {
        let turn = fixture.turn("compact now").await;
        (fixture, turn)
    });
    let callback = tokio::time::timeout(Duration::from_secs(10), summary_started)
        .await
        .unwrap()
        .unwrap();
    session.interrupt();
    session
        .callback_response(&callback, summary("NOT_COMMITTED"), None)
        .unwrap();
    let (fixture, interrupted) = pending.await.unwrap();
    interrupted.assert_result(true);
    assert!(!interrupted.compacted());
    assert!(matches!(
        entered.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    let live = json!(interrupted.history).to_string();
    assert!(live.contains("ORIGINAL_DETAIL"));
    assert!(!live.contains("NOT_COMMITTED"));
    assert!(fixture.persisted().await.contains("ORIGINAL_DETAIL"));
    let raw = tokio::fs::read_to_string(&fixture.path).await.unwrap();
    assert!(!raw.contains("compact_checkpoint"));
    assert!(!raw.contains("NOT_COMMITTED"));
    assert_eq!(fixture.requests.len(), 1);
    assert_eq!(fixture.summaries.len(), 1);
    fixture.close().await;
    drop(release);
}
