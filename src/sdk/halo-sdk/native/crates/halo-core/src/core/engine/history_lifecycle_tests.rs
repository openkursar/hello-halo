//! Handing a settled session's history to its next owner: the capture is the session
//! command that collaborator retirement uses, and re-entry consumes it as `nativeCheckpoint`.

use crate::session::NativeSession;
use serde_json::{json, Value};
use std::{collections::VecDeque, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::mpsc;

const INPUT: &str = "ORIGINAL_CONTEXT";

struct Fixture {
    session: Arc<NativeSession>,
    directory: PathBuf,
    path: PathBuf,
    options: Value,
    iterations: mpsc::UnboundedReceiver<Vec<Value>>,
    stream: VecDeque<Value>,
    requests: Vec<Value>,
}

impl Fixture {
    async fn new(directory: PathBuf, persist_session: bool, extra: Value) -> Self {
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let mut options = json!({
            "provider":{"id":"fixture","name":"Fixture","__haloSdkNativeProvider":true,
                "capabilities":{"streaming":true,"toolCalling":true,"thinking":false,"imageInput":false,
                    "pdfInput":false,"audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"top_level"}},
            "model":"fixture","cwd":directory,"env":{"HOME":directory,"CLAUDE_CONFIG_DIR":directory.join("config")},
            "tools":[],"settingSources":[],"persistSession":persist_session,"permissionMode":"bypassPermissions",
            "systemPrompt":"Test assistant.","maxTurns":4,"turnEndChecks":{"openWork":false,"completion":false}
        });
        options
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().cloned().unwrap_or_default());
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
            options,
            iterations,
            stream: VecDeque::new(),
            requests: Vec::new(),
        }
    }

    fn scripted(&self, id: &str, text: &str) -> VecDeque<Value> {
        VecDeque::from([
            json!({"type":"message_start","id":id,"model":"fixture","usage":{"input_tokens":10,"output_tokens":10}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":text}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","stopReason":"end_turn"}),
            json!({"type":"message_stop"}),
        ])
    }

    async fn turn(&mut self, input: &str) {
        self.session
            .send(json!(input), uuid::Uuid::new_v4().to_string(), false)
            .unwrap();
        self.session.start_stream().unwrap();
        loop {
            let envelope = tokio::time::timeout(Duration::from_secs(20), self.session.next())
                .await
                .expect("session stalled")
                .unwrap()
                .expect("session closed");
            match envelope["kind"].as_str().unwrap() {
                "callback" => {
                    let id = envelope["id"].as_str().unwrap();
                    let value = match envelope["method"].as_str().unwrap() {
                        "provider.start" => {
                            let index = self.requests.len();
                            self.requests.push(envelope["params"].clone());
                            self.stream = self.scripted(&format!("response-{index}"), "Recorded.");
                            json!(format!("stream-{index}"))
                        }
                        "provider.next" => self.stream.pop_front().map_or_else(
                            || json!({"done":true}),
                            |event| json!({"done":false,"value":event}),
                        ),
                        "provider.return" => {
                            self.stream.clear();
                            Value::Null
                        }
                        method => panic!("unexpected callback {method}: {envelope}"),
                    };
                    self.session.callback_response(id, value, None).unwrap();
                }
                "event" => {
                    if let Some(id) = envelope["eventId"].as_str() {
                        self.session.event_consumed(id, None);
                    }
                    let event = envelope["event"].clone();
                    if event["type"] == "system"
                        && event["subtype"] == "session_state_changed"
                        && event["state"] == "idle"
                    {
                        let _ = self.iterations.recv().await;
                        return;
                    }
                }
                "log" | "inputConsumed" | "callbackCancelled" | "streamEnd" => {}
                kind => panic!("unexpected session envelope {kind}: {envelope}"),
            }
        }
    }

    fn journal_records(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.path)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    async fn close(self) {
        self.session.close();
        tokio::time::timeout(Duration::from_secs(20), async {
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
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.session.close();
    }
}

/// Removes the checkpoint header, as a host transfer would before handing it to another owner.
fn without_checkpoint(checkpoint: &Value) -> Value {
    let mut values = checkpoint
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| key.as_str() != "messages")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    values.insert("messages".into(), json!([]));
    Value::Object(values)
}

#[tokio::test]
async fn settled_capture_is_in_memory_and_a_later_durable_owner_does_not_replay_model_work() {
    let directory = std::env::temp_dir().join(format!("halo-history-lifecycle-{}", uuid::Uuid::new_v4()));
    let mut first = Fixture::new(directory.clone(), false, json!({})).await;
    first.turn(INPUT).await;
    let checkpoint = first.session.command("captureCheckpoint", json!([])).await.unwrap();
    assert_eq!(checkpoint["sessionId"], json!(first.session.id()));
    assert_eq!(checkpoint["cwd"], json!(directory.to_string_lossy()));
    assert!(
        checkpoint["messages"].to_string().contains(INPUT),
        "a memory-only session carries its history: {checkpoint}"
    );
    let session_id = first.session.id().to_owned();
    let turns_before_transfer = first.requests.len();
    first.close().await;
    assert_eq!(turns_before_transfer, 1);
    assert!(!directory.join("config").join("goals").exists());

    // Handing the memory-only history to another owner requires materializing it in the journal
    // first; without records there is nothing durable to resume and the host's copy stays the
    // authoritative one.
    let mut second = Fixture::new(directory.clone(), true, json!({"sessionId":session_id})).await;
    let empty = second.session.command("captureCheckpoint", json!([])).await.unwrap();
    assert!(
        empty.get("messages").is_none(),
        "a new journal is complete even before its first record: {empty}"
    );
    assert_eq!(empty["sessionId"], json!(session_id));
    second.turn("Follow up.").await;
    assert_eq!(second.requests.len(), 1);
    let persisted = second.session.command("captureCheckpoint", json!([])).await.unwrap();
    assert!(
        persisted.get("messages").is_none(),
        "after the durable append the journal owns the history: {persisted}"
    );
    assert!(std::fs::read_to_string(&second.path).unwrap().contains("Follow up."));
    second.close().await;
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn capture_states_whether_the_durable_journal_already_owns_history() {
    let directory = std::env::temp_dir().join(format!("halo-history-lifecycle-{}", uuid::Uuid::new_v4()));
    let mut fixture = Fixture::new(directory.clone(), true, json!({})).await;
    fixture.turn(INPUT).await;
    let checkpoint = fixture.session.command("captureCheckpoint", json!([])).await.unwrap();
    assert!(
        checkpoint.get("messages").is_none(),
        "a complete journal owns the history, so no in-memory copy is attached: {checkpoint}"
    );
    let records = fixture.journal_records();
    assert_eq!(
        records.iter().filter(|entry| entry["type"] == "assistant_metadata").count(),
        1
    );
    assert_eq!(
        records.iter().filter(|entry| entry["type"] == "user" && entry["message"]["role"] == "user").count(),
        1
    );
    fixture.close().await;
    std::fs::remove_dir_all(&directory).unwrap();
}
