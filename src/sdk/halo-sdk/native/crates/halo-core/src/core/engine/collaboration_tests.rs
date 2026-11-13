use crate::session::NativeSession;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const PROMPT: &str = "Delegate a bounded task, then use the record tool.";
const TARGET: &str = "mcp__records__lookup";

struct Evidence {
    requests: Vec<Value>,
    histories: Vec<Vec<Value>>,
    calls: Vec<Value>,
    results: Vec<Value>,
}

fn tool_definition() -> Value {
    json!({"name":"lookup","description":"Read the complete record.","inputSchema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}})
}

fn response(id: &str, call: Option<Value>, child: bool) -> VecDeque<Value> {
    let has_call = call.is_some();
    let content = call.map_or_else(
        || json!({"type":"text","text":if child {"Child completed."} else {"Source completed."}}),
        |call| json!({"type":"tool_use","id":id,"name":call["name"],"input":call["input"]}),
    );
    VecDeque::from([
        json!({"type":"message_start","id":id,"model":"fixture","usage":{"input_tokens":10,"output_tokens":10}}),
        json!({"type":"content_block_start","index":0,"content_block":content}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","stopReason":if has_call {"tool_use"} else {"end_turn"}}),
        json!({"type":"message_stop"}),
    ])
}

async fn run(native_query: bool, deferred: bool, change_directory: bool) -> Evidence {
    let directory =
        std::env::temp_dir().join(format!("halo-source-context-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let loading = if deferred { "deferred" } else { "eager" };
    let mut options = json!({
        "provider":{"id":"fixture","name":"Fixture","__haloSdkNativeProvider":true,"capabilities":{"streaming":true,"toolCalling":true,"thinking":false,"imageInput":false,"pdfInput":false,"audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"top_level"}},
        "model":"fixture","cwd":directory,"env":{"HOME":directory,"CLAUDE_CONFIG_DIR":directory.join("config")},
        "tools":[],"settingSources":[],"persistSession":false,"permissionMode":"bypassPermissions","maxTurns":12,
        "turnEndChecks":{"completion":false,"openWork":false},"systemPrompt":"You are the source assistant.",
        "nativeQuery":native_query,"collaboration":{"mode":"local"},
        "mcpServers":{"records":{"type":"sdk","name":"records","instructions":"Keep the record guide.","tools":[tool_definition()]}},
        "toolDiscovery":{"services":{"records":{"identity":"records-installation","loading":loading,"summary":"Read records."}}}
    });
    let archive = if change_directory {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        options["mcpServers"]["archive"] =
            json!({"type":"http","url":format!("http://{}/mcp", listener.local_addr().unwrap())});
        options["toolDiscovery"]["services"]["archive"] = json!({"identity":"archive-installation","loading":"deferred","summary":"Read archives."});
        Some(tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut bytes = Vec::new();
                let (header_end, length) = loop {
                    let byte = socket.read_u8().await.unwrap();
                    bytes.push(byte);
                    if bytes.ends_with(b"\r\n\r\n") {
                        let headers = String::from_utf8(bytes.clone()).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|length| length.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (bytes.len(), length);
                    }
                };
                bytes.resize(header_end + length, 0);
                socket.read_exact(&mut bytes[header_end..]).await.unwrap();
                let request: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                let response = if request["method"] == "notifications/initialized" {
                    "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_owned()
                } else {
                    let result = if request["method"] == "initialize" {
                        json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"archive","version":"1"}})
                    } else {
                        json!({"tools":[{"name":"read","description":"Read archived records.","inputSchema":{"type":"object","properties":{}}}]})
                    };
                    let body =
                        json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string();
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        }))
    } else {
        None
    };
    let session = NativeSession::new(options).unwrap();
    let (sender, mut iterations) = mpsc::unbounded_channel();
    *session.iteration_observer.lock().unwrap() = Some(sender);
    let mut evidence = Evidence {
        requests: Vec::new(),
        histories: Vec::new(),
        calls: Vec::new(),
        results: Vec::new(),
    };
    let mut streams = HashMap::<String, VecDeque<Value>>::new();
    let mut pending_child: Option<(String, Value)> = None;
    let mut released = false;
    let mut next_stream = 0;
    let operation = async {
        loop {
            let envelope = tokio::select! {
                history = iterations.recv() => {
                    evidence.histories.push(history.unwrap());
                    released = true;
                    if let Some((callback, request)) = pending_child.take() {
                        let stream = format!("stream-{}", next_stream); next_stream += 1;
                        assert!(request["systemPrompt"].to_string().contains("You are collaborator"));
                        streams.insert(stream.clone(), response(&stream, None, true));
                        session.callback_response(&callback, json!(stream), None).unwrap();
                    }
                    continue;
                },
                envelope = session.next() => envelope.unwrap().expect("session closed before its result"),
            };
            match envelope["kind"].as_str().unwrap() {
                "ready" => {
                    session
                        .send(json!(PROMPT), "source-input".into(), false)
                        .unwrap();
                    session.start_stream().unwrap();
                }
                "callback" => {
                    let callback = envelope["id"].as_str().unwrap();
                    let input = &envelope["params"];
                    let value = match envelope["method"].as_str().unwrap() {
                        "provider.start" => {
                            let child = input["systemPrompt"]
                                .to_string()
                                .contains("You are collaborator");
                            if child && !released {
                                assert!(pending_child
                                    .replace((callback.into(), input.clone()))
                                    .is_none());
                                continue;
                            }
                            let call = if child {
                                None
                            } else {
                                let step = evidence.requests.len();
                                evidence.requests.push(input.clone());
                                if step == 0 {
                                    Some(
                                        json!({"name":"mcp__halo-team__spawn_agent","input":{"name":"reader","prompt":"Report completion."}}),
                                    )
                                } else if step == 1 && deferred {
                                    if change_directory {
                                        session
                                            .command("toggleMcpServer", json!(["archive", false]))
                                            .await
                                            .unwrap();
                                    }
                                    Some(
                                        json!({"name":"ToolSearch","input":{"query":format!("select:{TARGET}")}}),
                                    )
                                } else if step == if deferred { 3 } else { 2 } {
                                    assert!(released, "the child must complete after the first source loop exited");
                                    Some(if deferred {
                                        json!({"name":"CallTool","input":{"tool":TARGET,"arguments":"{\"value\":\"continued\"}"}})
                                    } else {
                                        json!({"name":TARGET,"input":{"value":"continued"}})
                                    })
                                } else {
                                    None
                                }
                            };
                            let stream = format!("stream-{}", next_stream);
                            next_stream += 1;
                            streams.insert(stream.clone(), response(&stream, call, child));
                            json!(stream)
                        }
                        "provider.next" => {
                            let stream = input["streamId"].as_str().unwrap();
                            match streams.get_mut(stream).unwrap().pop_front() {
                                Some(event) => json!({"done":false,"value":event}),
                                None => json!({"done":true}),
                            }
                        }
                        "provider.return" => Value::Null,
                        "mcp.call" => {
                            assert_eq!(input["server"], "records");
                            evidence.calls.push(input["input"]["value"].clone());
                            json!({"content":[{"type":"text","text":"Receipt continued"}]})
                        }
                        method => panic!("unexpected callback {method}: {input}"),
                    };
                    session.callback_response(callback, value, None).unwrap();
                }
                "event" => {
                    if let Some(id) = envelope["eventId"].as_str() {
                        session.event_consumed(id, None);
                    }
                    if envelope["event"]["type"] == "result" {
                        evidence.results.push(envelope["event"].clone());
                        break;
                    }
                }
                "log" | "inputConsumed" | "callbackCancelled" => {}
                kind => panic!("unexpected envelope {kind}: {envelope}"),
            }
        }
        while let Ok(history) = iterations.try_recv() {
            evidence.histories.push(history);
        }
    };
    let outcome = tokio::time::timeout(Duration::from_secs(10), operation).await;
    session.close();
    while let Some(envelope) = session.next().await.unwrap() {
        if let Some(id) = envelope["eventId"].as_str() {
            session.event_consumed(id, None);
        }
    }
    session.output_consumed();
    session.wait_closed().await.unwrap();
    if let Some(server) = archive {
        server.abort();
        let _ = server.await;
    }
    tokio::fs::remove_dir_all(directory).await.unwrap();
    outcome.expect("source continuation did not reach its final result");
    evidence
}

fn assert_definitions(evidence: &Evidence) {
    assert_eq!(evidence.histories.len(), 2);
    assert_eq!(evidence.calls, vec![json!("continued")]);
    assert_eq!(evidence.results.len(), 1);
    assert_eq!(evidence.results[0]["subtype"], "success");
    assert_eq!(evidence.results[0]["num_turns"], 5);
    let continued = evidence.requests[3]["messages"].to_string();
    assert!(continued.contains("Read the complete record."));
    assert!(continued.contains("Keep the record guide."));
    let finished = evidence.requests[4]["messages"].to_string();
    assert!(finished.contains("Receipt continued"));
    assert!(finished.contains("CallTool"));
    for request in &evidence.requests {
        assert_eq!(request["tools"], evidence.requests[0]["tools"]);
    }
}

#[tokio::test]
async fn source_continuation_preserves_discovered_definitions_and_directory_prefix() {
    for native_query in [false, true] {
        let evidence = run(native_query, true, false).await;
        assert_definitions(&evidence);
        let prefix = evidence.requests[0]["messages"].as_array().unwrap();
        assert_eq!(prefix.last().unwrap()["content"], PROMPT);
        assert_eq!(evidence.requests.len(), 5);
        for request in &evidence.requests {
            assert!(request["messages"]
                .to_string()
                .contains("Available services"));
            assert_eq!(
                &request["messages"].as_array().unwrap()[..prefix.len()],
                prefix
            );
        }
    }
}

#[tokio::test]
async fn source_continuation_preserves_an_empty_baseline_on_the_original_user_message() {
    for native_query in [false, true] {
        let evidence = run(native_query, false, false).await;
        assert_eq!(evidence.histories.len(), 2);
        let original = &evidence.histories[0][0];
        assert_eq!(original["role"], "user");
        assert_eq!(original["content"], PROMPT);
        assert_eq!(original["toolContext"]["baselineAttachment"], false);
        assert_eq!(original["toolContext"]["baseline"]["directory"], "");
        assert_eq!(
            original["toolContext"]["baseline"]["definitions"],
            json!([])
        );
        assert_eq!(evidence.histories[1][0], *original);
        let messages = evidence.requests[0]["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["isMeta"] != true)
                .collect::<Vec<_>>(),
            vec![&json!({"role":"user","content":PROMPT})]
        );
        assert!(messages.iter().all(|message| message["content"] != ""));
        assert_eq!(evidence.calls, vec![json!("continued")]);
    }
}

#[tokio::test]
async fn source_continuation_keeps_directory_changes_without_revoking_discoveries() {
    for native_query in [false, true] {
        let evidence = run(native_query, true, true).await;
        assert_eq!(evidence.histories.len(), 2);
        assert_eq!(evidence.calls, vec![json!("continued")]);
        let changed = evidence.requests[3]["messages"].as_array().unwrap();
        let prior = evidence.requests[2]["messages"].as_array().unwrap();
        assert_eq!(&changed[..prior.len()], prior);
        let directories: Vec<_> = changed
            .iter()
            .filter_map(|message| message["content"].as_str())
            .filter(|content| content.contains("Available services"))
            .collect();
        assert_eq!(directories.len(), 2);
        assert!(directories[0].contains("Read archives."));
        assert!(!directories[1].contains("Read archives."));
        assert_eq!(
            &evidence.requests[4]["messages"].as_array().unwrap()[..changed.len()],
            changed
        );
    }
}
