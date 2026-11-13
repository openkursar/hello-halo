use crate::session::NativeSession;
use serde_json::{json, Value};
use std::{collections::VecDeque, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
};

const TARGET: &str = "mcp__records__lookup";

async fn read_http_request(stream: &mut TcpStream) -> Option<Value> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 { return None; }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let length = headers.lines().find_map(|line| {
        line.to_ascii_lowercase().strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    }).unwrap_or(0);
    while bytes.len() < header_end + length {
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 { return None; }
        bytes.extend_from_slice(&buffer[..read]);
    }
    serde_json::from_slice(&bytes[header_end..header_end + length]).ok()
}

async fn serve_mcp(listener: TcpListener, effects: PathBuf) {
    while let Ok((mut stream, _)) = listener.accept().await {
        let Some(request) = read_http_request(&mut stream).await else { continue; };
        let id = request["id"].clone();
        if id.is_null() {
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},
                "serverInfo":{"name":"records","version":"1"},"instructions":"Read records."}),
            "tools/list" => json!({"tools":[{"name":"lookup","description":"Read the complete record.",
                "inputSchema":{"type":"object","properties":{},"additionalProperties":false}}]}),
            "tools/call" => {
                let mut records: Vec<Value> = serde_json::from_str(
                    &std::fs::read_to_string(&effects).unwrap_or_else(|_| "[]".to_owned()),
                ).unwrap();
                records.push(request["params"]["name"].clone());
                std::fs::write(&effects, serde_json::to_string(&records).unwrap()).unwrap();
                json!({"content":[{"type":"text","text":"Record read."}]})
            }
            _ => continue,
        };
        let body = json!({"jsonrpc":"2.0","id":id,"result":result}).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body,
        );
        let _ = stream.write_all(response.as_bytes()).await;
    }
}

struct Turn {
    events: Vec<Value>,
}
impl Turn {
    fn assert_result(&self, is_error: bool) {
        let results: Vec<_> = self.events.iter().filter(|event| event["type"] == "result").collect();
        assert_eq!(results.len(), 1, "{:?}", self.events);
        assert_eq!(results[0]["is_error"], is_error, "{:?}", results[0]);
    }
    fn tool_results(&self) -> Vec<Value> {
        self.events.iter().filter(|event| event["type"] == "user")
            .flat_map(|event| event["message"]["content"].as_array().cloned().unwrap_or_default())
            .filter(|block| block["type"] == "tool_result").collect()
    }
}

fn search_call() -> Vec<Value> {
    vec![json!({"type":"tool_use","id":"search","name":"ToolSearch","input":{"query":format!("select:{TARGET}")}})]
}
fn invoke_call(id: &str) -> Vec<Value> {
    vec![json!({"type":"tool_use","id":id,"name":"CallTool","input":{"tool":TARGET,"arguments":"{}"}})]
}
fn text(value: &str) -> Vec<Value> {
    vec![json!({"type":"text","text":value})]
}

struct Fixture {
    session: Arc<NativeSession>,
    directory: PathBuf,
    path: PathBuf,
    effects: PathBuf,
    url: String,
    server: JoinHandle<()>,
    iterations: mpsc::UnboundedReceiver<Vec<Value>>,
    stream: VecDeque<Value>,
    replies: VecDeque<Vec<Value>>,
    requests: Vec<Value>,
}

impl Fixture {
    async fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("halo-discovery-append-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let effects = directory.join("effects.json");
        std::fs::write(&effects, "[]").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = tokio::spawn(serve_mcp(listener, effects.clone()));
        let options = json!({
            "provider":{"id":"fixture","name":"Fixture","__haloSdkNativeProvider":true,
                "capabilities":{"streaming":true,"toolCalling":true,"thinking":false,"imageInput":false,
                    "pdfInput":false,"audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"top_level"}},
            "model":"fixture","cwd":directory,"env":{"HOME":directory,"CLAUDE_CONFIG_DIR":directory.join("state")},
            "tools":[],"settingSources":[],"persistSession":true,"permissionMode":"bypassPermissions",
            "systemPrompt":"Test assistant.","maxTurns":8,"turnEndChecks":{"openWork":false,"completion":false},
            "mcpServers":{"records":{"type":"http","url":url}},
            "toolDiscovery":{"services":{"records":{"identity":"records-installation","loading":"deferred","summary":"Read records."}}}
        });
        let session = NativeSession::new(options.clone()).unwrap();
        let (sender, iterations) = mpsc::unbounded_channel();
        *session.iteration_observer.lock().unwrap() = Some(sender);
        let path = crate::history::transcript_path(session.id(), &options);
        loop {
            let envelope = tokio::time::timeout(Duration::from_secs(30), session.next()).await.unwrap().unwrap().unwrap();
            match envelope["kind"].as_str().unwrap() {
                "ready" => break,
                "log" => {}
                kind => panic!("unexpected preparation envelope {kind}: {envelope}"),
            }
        }
        Self { session, directory, path, effects, url, server, iterations,
            stream: VecDeque::new(), replies: VecDeque::new(), requests: Vec::new() }
    }

    fn script(&mut self, replies: Vec<Vec<Value>>) {
        self.replies = replies.into();
    }

    fn scripted(&self, id: &str, blocks: Vec<Value>) -> VecDeque<Value> {
        let call = blocks.iter().any(|block| block["type"] == "tool_use");
        let mut events: VecDeque<Value> = vec![json!({"type":"message_start","id":id,"model":"fixture","usage":{"input_tokens":10,"output_tokens":10}})].into();
        for (index, block) in blocks.iter().enumerate() {
            events.push_back(json!({"type":"content_block_start","index":index,"content_block":block}));
            events.push_back(json!({"type":"content_block_stop","index":index}));
        }
        events.push_back(json!({"type":"message_delta","stopReason":if call {"tool_use"} else {"end_turn"}}));
        events.push_back(json!({"type":"message_stop"}));
        events
    }

    fn send(&mut self, input: &str) {
        self.session.send(json!(input), uuid::Uuid::new_v4().to_string(), false).unwrap();
        self.session.start_stream().unwrap();
    }

    async fn drain(&mut self) -> Turn {
        let mut events = Vec::new();
        loop {
            let envelope = tokio::time::timeout(Duration::from_secs(30), self.session.next()).await.expect("session stalled").unwrap().expect("session closed");
            match envelope["kind"].as_str().unwrap() {
                "callback" => {
                    let id = envelope["id"].as_str().unwrap();
                    let value = match envelope["method"].as_str().unwrap() {
                        "provider.start" => {
                            let blocks = self.replies.pop_front().unwrap_or_else(|| text("Done."));
                            let index = self.requests.len();
                            self.requests.push(envelope["params"].clone());
                            self.stream = self.scripted(&format!("response-{index}"), blocks);
                            json!(format!("stream-{index}"))
                        }
                        "provider.next" => self.stream.pop_front().map_or_else(|| json!({"done":true}), |event| json!({"done":false,"value":event})),
                        "provider.return" => { self.stream.clear(); Value::Null }
                        "provider.complete" => json!({"id":"summary","model":"fixture","content":[{"type":"text","text":"Continue."}],"stopReason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}),
                        method => panic!("unexpected callback {method}: {envelope}"),
                    };
                    self.session.callback_response(id, value, None).unwrap();
                }
                "event" => {
                    if let Some(id) = envelope["eventId"].as_str() { self.session.event_consumed(id, None); }
                    let event = envelope["event"].clone();
                    let idle = event["type"] == "system" && event["subtype"] == "session_state_changed" && event["state"] == "idle";
                    events.push(event);
                    if idle {
                        let _ = self.iterations.recv().await;
                        return Turn { events };
                    }
                }
                "log" | "inputConsumed" | "callbackCancelled" | "streamEnd" => {}
                kind => panic!("unexpected session envelope {kind}: {envelope}"),
            }
        }
    }

    fn effect_count(&self) -> usize {
        let text = std::fs::read_to_string(&self.effects).unwrap();
        let records: Vec<Value> = serde_json::from_str(&text).unwrap();
        records.iter().filter(|value| value.as_str() == Some("lookup")).count()
    }

    fn journal_records(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.path).unwrap_or_default().lines().filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn discoveries(&self) -> Vec<Value> {
        self.journal_records().into_iter().filter_map(|entry| entry["message"]["toolContext"]["discoveries"].as_array().cloned())
            .flatten().collect()
    }

    async fn close(self) {
        self.session.close();
        tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(envelope) = self.session.next().await.unwrap() {
                if let Some(id) = envelope["eventId"].as_str() { self.session.event_consumed(id, None); }
                assert_ne!(envelope["kind"], "error", "{envelope}");
            }
            self.session.output_consumed();
            self.session.wait_closed().await.unwrap();
        }).await.expect("session did not close");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { self.session.close(); }
}

// Runs one turn whose search result append is held by the gate, cancels at the given side of
// the write, then reopens the same journal and proves the committed discovery is usable.
async fn wait_entered(entered: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    while !entered.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

async fn run(stage: &str) {
    let mut fixture = Fixture::new().await;
    fixture.script(vec![search_call(), text("Done.")]);
    let live_journal = fixture.session.transcript.lock().unwrap().clone().expect("live journal");
    let (entered, release) = live_journal.pause_next_discovery_append();
    fixture.send("Find the record tool.");
    // Drive the provider until the discovery result append reaches the gate.
    loop {
        let envelope = if entered.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        } else {
            tokio::select! {
                value = fixture.session.next() => value.expect("closed").expect("ended"),
                _ = wait_entered(entered.clone()) => break,
                _ = tokio::time::sleep(Duration::from_secs(20)) => panic!("STALL requests={} journal={:?}", fixture.requests.len(), fixture.journal_records().iter().map(|e| e["type"].as_str().unwrap().to_owned()).collect::<Vec<_>>()),
            }
        };
        match envelope["kind"].as_str().unwrap() {
            "callback" => {
                let id = envelope["id"].as_str().unwrap();
                let value = match envelope["method"].as_str().unwrap() {
                    "provider.start" => {
                        let blocks = fixture.replies.pop_front().unwrap_or_else(|| text("Done."));
                        let index = fixture.requests.len();
                        fixture.requests.push(envelope["params"].clone());
                        fixture.stream = fixture.scripted(&format!("response-{index}"), blocks);
                        json!(format!("stream-{index}"))
                    }
                    "provider.next" => fixture.stream.pop_front().map_or_else(|| json!({"done":true}), |event| json!({"done":false,"value":event})),
                    "provider.return" => { fixture.stream.clear(); Value::Null }
                    "provider.complete" => json!({"id":"summary","model":"fixture","content":[{"type":"text","text":"Continue."}],"stopReason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}),
                    method => panic!("unexpected callback {method}: {envelope}"),
                };
                fixture.session.callback_response(id, value, None).unwrap();
            }
            "event" => {
                if let Some(id) = envelope["eventId"].as_str() { fixture.session.event_consumed(id, None); }
                let event = envelope["event"].clone();
                if event["type"] == "result" {
                    panic!("turn ended before the discovery append reached the gate: {event}");
                }
            }
            "log" | "inputConsumed" | "callbackCancelled" | "streamEnd" => {}
            kind => panic!("unexpected session envelope {kind}: {envelope}"),
        }
    }
    assert!(!fixture.journal_records().iter().any(|entry| entry["message"]["toolContext"]["discoveries"].is_array()),
        "the discovery append is held before the write: {:?}", fixture.journal_records());
    if stage == "before-write" {
        fixture.session.interrupt();
    }
    release.notify_waiters();
    if stage == "after-write" {
        tokio::task::yield_now().await;
        fixture.session.interrupt();
    }
    let interrupted = fixture.drain().await;
    interrupted.assert_result(true);
    assert!(interrupted.tool_results().iter().any(|block| block["tool_use_id"] == "search"), "{:?}", interrupted.tool_results());
    assert_eq!(fixture.effect_count(), 0, "discovery search must not execute the deferred tool");
    let discoveries = fixture.discoveries();
    assert_eq!(discoveries.len(), 1, "the search result append is committed before cancellation is observed: {:?}", fixture.journal_records());
    assert_eq!(discoveries[0]["callId"], "search");
    let directory = fixture.directory.clone();
    let effects = fixture.effects.clone();
    let url = fixture.url.clone();
    let server = fixture.server.abort_handle();
    let session_id = fixture.session.id().to_owned();
    fixture.close().await;

    // Reopen the same journal through a fresh native session.
    let options = json!({
        "provider":{"id":"fixture","name":"Fixture","__haloSdkNativeProvider":true,
            "capabilities":{"streaming":true,"toolCalling":true,"thinking":false,"imageInput":false,
                "pdfInput":false,"audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"top_level"}},
        "model":"fixture","cwd":directory,"env":{"HOME":directory,"CLAUDE_CONFIG_DIR":directory.join("state")},
        "tools":[],"settingSources":[],"persistSession":true,"permissionMode":"bypassPermissions",
        "systemPrompt":"Test assistant.","maxTurns":8,"turnEndChecks":{"openWork":false,"completion":false},
        "resume": session_id.clone(),
        "strictResume": true,
        "mcpServers":{"records":{"type":"http","url":url}},
        "toolDiscovery":{"services":{"records":{"identity":"records-installation","loading":"deferred","summary":"Read records."}}}
    });
    let session = NativeSession::new(options.clone()).unwrap();
    let (sender, mut iterations) = mpsc::unbounded_channel();
    *session.iteration_observer.lock().unwrap() = Some(sender);
    loop {
        let envelope = tokio::time::timeout(Duration::from_secs(30), session.next()).await.unwrap().unwrap().unwrap();
        match envelope["kind"].as_str().unwrap() {
            "ready" => break,
            "log" => {}
            kind => panic!("unexpected resumed preparation envelope {kind}: {envelope}"),
        }
    }
    session.send(json!("Use the discovered tool."), uuid::Uuid::new_v4().to_string(), false).unwrap();
    session.start_stream().unwrap();
    let mut stream: VecDeque<Value> = VecDeque::new();
    let mut replies: VecDeque<Vec<Value>> = vec![invoke_call("resumed"), text("Done.")].into();
    let mut requests = 0;
    loop {
        let envelope = tokio::time::timeout(Duration::from_secs(30), session.next()).await.unwrap().unwrap().unwrap();
        match envelope["kind"].as_str().unwrap() {
            "callback" => {
                let id = envelope["id"].as_str().unwrap();
                let value = match envelope["method"].as_str().unwrap() {
                    "provider.start" => {
                        requests += 1;
                        let blocks = replies.pop_front().unwrap_or_else(|| text("Done."));
                        let call = blocks.iter().any(|block| block["type"] == "tool_use");
                        let mut queue: VecDeque<Value> = vec![json!({"type":"message_start","id":"r","model":"fixture","usage":{"input_tokens":1,"output_tokens":1}})].into();
                        for (index, block) in blocks.iter().enumerate() {
                            queue.push_back(json!({"type":"content_block_start","index":index,"content_block":block}));
                            queue.push_back(json!({"type":"content_block_stop","index":index}));
                        }
                        queue.push_back(json!({"type":"message_delta","stopReason":if call {"tool_use"} else {"end_turn"}}));
                        queue.push_back(json!({"type":"message_stop"}));
                        stream = queue;
                        json!("stream")
                    }
                    "provider.next" => stream.pop_front().map_or_else(|| json!({"done":true}), |event| json!({"done":false,"value":event})),
                    "provider.return" => { stream.clear(); Value::Null }
                    "provider.complete" => json!({"id":"summary","model":"fixture","content":[{"type":"text","text":"Continue."}],"stopReason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}),
                    method => panic!("unexpected callback {method}"),
                };
                session.callback_response(id, value, None).unwrap();
            }
            "event" => {
                if let Some(id) = envelope["eventId"].as_str() { session.event_consumed(id, None); }
                let event = envelope["event"].clone();
                if event["type"] == "result" {
                    assert_eq!(event["is_error"], false, "{event}");
                    break;
                }
                if event["type"] == "system" && event["subtype"] == "session_state_changed" && event["state"] == "idle" {
                    if let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(100), iterations.recv()).await {}
                }
            }
            "log" | "inputConsumed" | "callbackCancelled" | "streamEnd" => {}
            kind => panic!("unexpected resumed envelope {kind}"),
        }
    }
    let records: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&effects).unwrap()).unwrap();
    assert_eq!(records.iter().filter(|value| value.as_str() == Some("lookup")).count(), 1, "the committed discovery executes exactly once after resume");
    assert_eq!(requests, 2);
    session.close();
    tokio::time::timeout(Duration::from_secs(20), session.wait_closed()).await.unwrap().unwrap();
    server.abort();
    tokio::fs::remove_dir_all(&directory).await.unwrap();
}

#[tokio::test]
async fn discovery_append_commits_when_cancellation_arrives_before_the_write() {
    run("before-write").await;
}

#[tokio::test]
async fn discovery_append_commits_when_cancellation_arrives_after_the_write() {
    run("after-write").await;
}
