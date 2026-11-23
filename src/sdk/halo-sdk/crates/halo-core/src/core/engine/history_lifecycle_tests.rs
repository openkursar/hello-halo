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
    results: Vec<Value>,
    discovery: bool,
    fail_call_append: bool,
    calls: usize,
}

struct EmptyCollaboration;

#[async_trait::async_trait]
impl crate::collaboration::CollaborationTools for EmptyCollaboration {
    fn definitions(&self) -> Vec<Value> { Vec::new() }
    fn is_readonly(&self, _name: &str) -> bool { true }
    async fn call(&self, _name: &str, _input: Value, _cancellation: &tokio_util::sync::CancellationToken) -> crate::error::Result<Value> { unreachable!() }
}

impl Fixture {
    async fn new(directory: PathBuf, persist_session: bool, extra: Value) -> Self {
        Self::restored(directory, persist_session, extra, None).await
    }

    async fn restored(directory: PathBuf, persist_session: bool, extra: Value, working: Option<crate::tools::ToolCheckpoint>) -> Self {
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
        let discovery = options["toolDiscovery"].is_object();
        let fail_call_append = options.as_object_mut().unwrap().shift_remove("failCallAppend").is_some_and(|value| value == true);
        let session = if working.is_some() {
            NativeSession::new_child(options.clone(), Arc::new(EmptyCollaboration), working, None, None, None, Default::default()).unwrap()
        } else {
            NativeSession::new(options.clone()).unwrap()
        };
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
            results: Vec::new(),
            discovery,
            fail_call_append,
            calls: 0,
        }
    }

    fn scripted(&self, id: &str, text: &str) -> VecDeque<Value> {
        if self.discovery && self.requests.len() <= 2 {
            let blocks = if self.requests.len() == 1 {
                vec![json!({"type":"tool_use","id":"discover","name":"ToolSearch","input":{"query":"select:mcp__records__lookup"}})]
            } else {
                vec![json!({"type":"tool_use","id":"one","name":"CallTool","input":{"tool":"mcp__records__lookup","arguments":{"value":"one"}}}), json!({"type":"tool_use","id":"two","name":"CallTool","input":{"tool":"mcp__records__lookup","arguments":{"value":"two"}}})]
            };
            let mut events = VecDeque::from([json!({"type":"message_start","id":id,"model":"fixture","usage":{"input_tokens":10,"output_tokens":10}})]);
            for (index, block) in blocks.into_iter().enumerate() {
                events.push_back(json!({"type":"content_block_start","index":index,"content_block":block}));
                events.push_back(json!({"type":"content_block_stop","index":index}));
            }
            events.push_back(json!({"type":"message_delta","stopReason":"tool_use"}));
            events.push_back(json!({"type":"message_stop"}));
            return events;
        }
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
                            if self.fail_call_append && index == 1 {
                                std::fs::remove_file(&self.path).unwrap();
                                std::fs::create_dir(&self.path).unwrap();
                            }
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
                        "mcp.call" => {
                            self.calls += 1;
                            json!({"content":[{"type":"text","text":"Recorded lookup."}]})
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
                    if event["type"] == "result" {
                        self.results.push(event.clone());
                    }
                    if event["type"] == "system"
                        && event["subtype"] == "session_state_changed"
                        && event["state"] == "idle"
                    {
                        let _ = self.iterations.recv().await;
                        return;
                    }
                }
                "error" if self.fail_call_append => return,
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
    first.session.set_goal(json!({"objective":"Retain this goal."})).unwrap();
    first.turn(INPUT).await;
    let working = first.session.tools.lock().unwrap().as_ref().unwrap().retire_working_state();
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

    let mut second = Fixture::restored(directory.clone(), true, json!({"sessionId":session_id,"nativeCheckpoint":checkpoint}), Some(working)).await;
    assert_eq!(second.session.goal()["objective"], "Retain this goal.");
    assert!(second.requests.is_empty());
    let records = second.journal_records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["type"], "compact_checkpoint");
    assert!(records[0]["messages"].to_string().contains(INPUT));
    second.turn("Follow up.").await;
    assert_eq!(second.requests.len(), 1);
    assert!(second.requests[0]["messages"].to_string().contains(INPUT));
    let persisted = second.session.command("captureCheckpoint", json!([])).await.unwrap();
    assert!(
        persisted.get("messages").is_none(),
        "after the durable append the journal owns the history: {persisted}"
    );
    assert!(std::fs::read_to_string(&second.path).unwrap().contains("Follow up."));
    second.close().await;
    let mut third = Fixture::new(directory.clone(), true, json!({"resume":session_id,"strictResume":true})).await;
    assert_eq!(third.session.goal()["objective"], "Retain this goal.");
    third.turn("Continue from disk.").await;
    assert!(third.requests[0]["messages"].to_string().contains(INPUT));
    assert!(third.requests[0]["messages"].to_string().contains("Follow up."));
    third.close().await;
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn imported_history_must_be_durable_before_preparation_succeeds() {
    let directory = std::env::temp_dir().join(format!("halo-import-failure-{}", uuid::Uuid::new_v4()));
    let mut first = Fixture::new(directory.clone(), false, json!({})).await;
    first.turn(INPUT).await;
    let checkpoint = first.session.command("captureCheckpoint", json!([])).await.unwrap();
    let mut options = first.options.clone();
    options["sessionId"] = json!(first.session.id());
    options["persistSession"] = json!(true);
    options["nativeCheckpoint"] = checkpoint;
    let path = first.path.clone();
    first.close().await;
    std::fs::create_dir_all(&path).unwrap();

    let session = NativeSession::new(options.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let envelope = session.next().await.unwrap().expect("missing preparation error");
            match envelope["kind"].as_str().unwrap() {
                "error" => break,
                "log" => {}
                kind => panic!("preparation must fail before ready or model work: {kind}: {envelope}"),
            }
        }
    }).await.expect("preparation did not report checkpoint failure");
    assert!(session.transcript.lock().unwrap().is_none());
    assert!(path.is_dir());
    session.close();
    session.wait_closed().await.unwrap();
    session.output_consumed();
    std::fs::remove_dir(&path).unwrap();

    let recovered = Fixture::new(directory.clone(), true, options).await;
    assert!(recovered.requests.is_empty());
    let report = crate::history::read_report(&path, None).await.unwrap();
    assert_eq!(report.damaged, 0);
    assert!(json!(report.messages).to_string().contains(INPUT));
    recovered.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}

fn discovery_options(fail: bool) -> Value {
    json!({"failCallAppend":fail,"mcpServers":{"records":{"type":"sdk","name":"records","tools":[{"name":"lookup","description":"Read record.","inputSchema":{"type":"object","properties":{"value":{"type":"string"}}}}]}},"toolDiscovery":{"services":{"records":{"identity":"records-installation","loading":"deferred","summary":"Read records."}}}})
}

#[tokio::test]
async fn assistant_origins_install_once_and_stay_out_of_advisory_metadata() {
    let directory = std::env::temp_dir().join(format!("halo-origin-lifecycle-{}", uuid::Uuid::new_v4()));
    let mut fixture = Fixture::new(directory.clone(), true, discovery_options(false)).await;
    fixture.turn("Discover and read two records.").await;
    assert_eq!(fixture.calls, 2);
    let records = fixture.journal_records();
    let origins: Vec<_> = records.iter().filter(|record| record["type"] == "assistant").flat_map(|record| record["message"]["toolContext"]["calls"].as_array().into_iter().flatten()).collect();
    assert_eq!(origins.len(), 2);
    assert!(origins.iter().any(|call| call.to_string().contains("one")));
    assert!(origins.iter().any(|call| call.to_string().contains("two")));
    assert!(records.iter().filter(|record| record["type"] == "assistant_metadata").all(|record| record["message"].get("toolContext").is_none()));
    let history = fixture.session.command("readHistory", json!([])).await.unwrap();
    let grouped: Vec<_> = history.as_array().unwrap().iter().filter_map(|message| message["toolContext"]["calls"].as_array()).collect();
    assert_eq!(grouped.len(), 1);
    assert_eq!(grouped[0].len(), 2);
    fixture.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn failed_first_origin_append_does_not_install_call_in_live_history() {
    let directory = std::env::temp_dir().join(format!("halo-origin-failure-{}", uuid::Uuid::new_v4()));
    let mut fixture = Fixture::new(directory.clone(), true, discovery_options(true)).await;
    fixture.turn("Discover and read two records.").await;
    assert_eq!(fixture.requests.len(), 2);
    assert_eq!(fixture.calls, 0);
    let history = fixture.session.command("readHistory", json!([])).await.unwrap();
    assert!(history.as_array().unwrap().iter().all(|message| message["toolContext"].get("calls").is_none()));
    assert!(!history.to_string().contains("\"id\":\"one\""));
    assert!(!history.to_string().contains("\"id\":\"two\""));
    fixture.session.close();
    drop(fixture);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn persisted_goals_use_the_configured_host_directory() {
    let directory = std::env::temp_dir().join(format!("halo-goal-host-{}", uuid::Uuid::new_v4()));
    let fixture = Fixture::new(directory.clone(), true, json!({})).await;
    fixture.session.set_goal(json!({"objective":"Configured host goal."})).unwrap();
    let value: Value = serde_json::from_str(&std::fs::read_to_string(directory.join("config").join("goals").join(format!("{}.json", fixture.session.id()))).unwrap()).unwrap();
    assert_eq!(value["current"]["objective"], "Configured host goal.");
    fixture.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn failed_append_marks_the_journal_incomplete_without_claiming_durable_history() {
    let directory = std::env::temp_dir().join(format!("halo-journal-completeness-{}", uuid::Uuid::new_v4()));
    let options = json!({"cwd":directory,"env":{"HOME":directory,"CLAUDE_CONFIG_DIR":directory.join("config")}});
    std::fs::create_dir_all(&directory).unwrap();
    let journal = crate::history::Journal::new("fixture", &options).await.unwrap();
    let path = crate::history::transcript_path("fixture", &options);
    std::fs::create_dir_all(&path).unwrap();
    journal.append("user", json!({"role":"user","content":"Retain me in memory."}), "user", None, false).await.unwrap();
    journal.flush().await.unwrap();
    assert!(!journal.has_complete_history().await);
    std::fs::remove_dir_all(directory).unwrap();
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
    assert!(records.iter().all(|entry| entry["type"] != "compact_checkpoint"));
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

#[tokio::test]
async fn a_first_local_command_records_an_empty_history_that_strict_resume_continues() {
    let directory = std::env::temp_dir().join(format!("halo-command-history-{}", uuid::Uuid::new_v4()));
    let mut first = Fixture::new(directory.clone(), true, json!({})).await;
    first.turn("/compact").await;
    first.turn("/help").await;
    assert!(first.requests.is_empty());
    let records = first.journal_records();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["type"], "empty_history");
    assert_eq!(records[0]["sessionId"], json!(first.session.id()));
    assert!(records[0].get("message").is_none());
    let session_id = first.session.id().to_owned();
    first.close().await;

    let options = json!({"resume":session_id,"strictResume":true});
    let mut second = Fixture::new(directory.clone(), true, options.clone()).await;
    assert_eq!(second.session.command("readHistory", json!([])).await.unwrap(), json!([]));
    second.turn("/help").await;
    assert_eq!(second.journal_records().len(), 1);
    second.turn(INPUT).await;
    assert_eq!(second.requests.len(), 1);
    let sent = second.requests[0]["messages"].to_string();
    assert!(sent.contains(INPUT));
    assert!(!sent.contains("/compact") && !sent.contains("/help"), "{sent}");
    second.close().await;

    let mut third = Fixture::new(directory.clone(), true, options).await;
    third.turn("Continue from disk.").await;
    assert!(third.requests[0]["messages"].to_string().contains(INPUT));
    third.close().await;
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn a_recorded_empty_history_resumes_with_the_discovery_format_of_a_new_session() {
    let directory = std::env::temp_dir().join(format!("halo-command-discovery-{}", uuid::Uuid::new_v4()));
    let mut first = Fixture::new(directory.clone(), true, discovery_options(false)).await;
    first.turn("/help").await;
    let records = first.journal_records();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["type"], "empty_history");
    assert!(records[0].get("toolContextVersion").is_none(), "{records:?}");
    let session_id = first.session.id().to_owned();
    first.close().await;

    let mut options = discovery_options(false);
    options["resume"] = json!(session_id);
    options["strictResume"] = json!(true);
    let mut second = Fixture::new(directory.clone(), true, options).await;
    second.turn("Discover and read two records.").await;
    assert_eq!(second.calls, 2);
    let records = second.journal_records();
    assert!(records.len() > 1);
    assert!(
        records[1..].iter().all(|record| record.get("toolContextVersion").is_some()),
        "{records:?}"
    );
    second.close().await;
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn local_commands_record_no_empty_history_without_input_or_over_recorded_history() {
    let directory = std::env::temp_dir().join(format!("halo-command-boundaries-{}", uuid::Uuid::new_v4()));
    let idle = Fixture::new(directory.clone(), true, json!({})).await;
    let idle_path = idle.path.clone();
    idle.close().await;
    assert!(!idle_path.exists(), "a session that received no input writes nothing");

    let mut memory = Fixture::new(directory.clone(), false, json!({})).await;
    memory.turn("/help").await;
    assert!(!memory.path.exists());
    memory.close().await;

    let mut used = Fixture::new(directory.clone(), true, json!({})).await;
    used.turn(INPUT).await;
    used.turn("/help").await;
    assert!(used.journal_records().iter().all(|record| record["type"] != "empty_history"));
    std::fs::remove_file(&used.path).unwrap();
    used.turn("/help").await;
    assert!(
        !used.path.exists(),
        "a lost journal is not replaced by an empty history while live history remains"
    );
    used.close().await;
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn an_unwritable_empty_history_leaves_the_command_and_its_in_memory_history_intact() {
    let directory = std::env::temp_dir().join(format!("halo-command-unwritable-{}", uuid::Uuid::new_v4()));
    let mut fixture = Fixture::new(directory.clone(), true, json!({})).await;
    std::fs::create_dir_all(&fixture.path).unwrap();
    fixture.turn("/help").await;
    let result = fixture.results.last().unwrap();
    assert_eq!(result["is_error"], false, "{result}");
    assert!(result["result"].as_str().unwrap().contains("Available commands"), "{result}");
    let journal = fixture.session.transcript.lock().unwrap().clone().unwrap();
    assert!(!journal.has_complete_history().await);
    let checkpoint = fixture.session.command("captureCheckpoint", json!([])).await.unwrap();
    assert_eq!(checkpoint["messages"], json!([]), "{checkpoint}");
    fixture.close().await;
    std::fs::remove_dir_all(&directory).unwrap();
}
