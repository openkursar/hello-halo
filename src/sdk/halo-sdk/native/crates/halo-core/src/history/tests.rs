use super::{
    admin,
    jsonl::{Entry, Reader},
    page,
};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("halo-history-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn options(root: &Path) -> Value {
    json!({"cwd":"/fixture/project","env":{"FIXTURE_STORE":root},"conventions":{"configDirEnv":"FIXTURE_STORE"}})
}
fn write_transcript(root: &Path, id: &str, text: &str) -> PathBuf {
    let file = super::transcript_path(id, &options(root));
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, text).unwrap();
    file
}
async fn execute(name: &str, options: &Value, payload: Value) -> Value {
    admin::execute(name, options, &payload, &CancellationToken::new())
        .await
        .unwrap()
}

fn write_records(root: &Path, id: &str, records: &[Value]) -> PathBuf {
    let text = records
        .iter()
        .map(|record| format!("{record}\n"))
        .collect::<String>();
    write_transcript(root, id, &text)
}

fn checkpoint(messages: &[Value], summary: &str) -> Value {
    json!({"type":"compact_checkpoint","checkpointVersion":1,"uuid":"checkpoint",
        "summary":summary,"messages":messages})
}

async fn load_resume(root: &Path, id: &str, strict: bool) -> crate::error::Result<Vec<Value>> {
    let mut config = options(root);
    config.as_object_mut().unwrap().extend(json!({
        "resume":id,"strictResume":strict,"model":"history-fixture","persistSession":false,
        "provider":{"id":"history-fixture","name":"History fixture","__haloSdkNativeProvider":true,
            "capabilities":{"toolCalling":true,"streaming":true,"systemPromptStyle":"top_level"}},
        "tools":[],"skillCatalog":[],"settingSources":[],"collaboration":false,
        "systemPrompt":"History fixture.","thinking":{"type":"disabled"}
    }).as_object().unwrap().clone());
    let session = crate::session::NativeSession::new(config)?;
    let loaded = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let envelope = session
                .next()
                .await?
                .expect("session closed before reporting preparation");
            match envelope["kind"].as_str().unwrap() {
                "ready" => break,
                "error" => {
                    return Err(serde_json::from_value::<crate::error::Error>(envelope).unwrap())
                }
                "log" | "work_complete" => {}
                kind => panic!("unexpected resume preparation envelope: {kind}"),
            }
        }
        let history = session.command("readHistory", json!([])).await?;
        Ok(history.as_array().unwrap().clone())
    })
    .await;
    session.close();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(envelope) = session.next().await.unwrap() {
            if let Some(id) = envelope["eventId"].as_str() {
                session.event_consumed(id, None);
            }
        }
        session.output_consumed();
        session.wait_closed().await.unwrap();
    })
    .await
    .expect("resumed session did not close");
    loaded.expect("resume preparation did not settle")
}

#[tokio::test]
async fn restoration_keeps_the_latest_handover_and_its_complete_tool_exchange() {
    let directory = Directory::new();
    let messages = vec![
        json!({"role":"user","content":"Current task: verify the inventory totals."}),
        json!({"role":"assistant","content":[{"type":"tool_use","id":"inventory-read","name":"Read","input":{"file_path":"/fixture/inventory.txt"}}]}),
        json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"inventory-read","content":"12 items"}]}),
        json!({"role":"assistant","content":"The inventory total is 12."}),
    ];
    let mut records = vec![
        json!({"type":"user","message":{"role":"user","content":"An obsolete task."}}),
        json!({"type":"system","subtype":"compact_boundary"}),
        json!({"type":"user","message":{"role":"user","content":"An earlier handover."}}),
        json!({"type":"assistant","message":{"role":"assistant","content":"Intermediate work."}}),
        json!({"type":"system","subtype":"compact_boundary"}),
    ];
    records.extend(
        messages
            .iter()
            .map(|message| json!({"type":message["role"],"message":message})),
    );
    let path = write_records(&directory.0, "handover", &records);
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(report.omitted, 0);
    assert_eq!(report.damaged, 0);
    assert_eq!(report.messages, messages);
    let (repaired, changes) = crate::core::messages::repair(&report.messages);
    assert_eq!(repaired, messages);
    assert_eq!(
        (
            changes.duplicate_calls,
            changes.discarded_results,
            changes.late_results,
            changes.missing_results,
            changes.empty_responses
        ),
        (0, 0, 0, 0, 0)
    );
}

#[tokio::test]
async fn bounded_tail_restores_main_and_sidechain_checkpoints() {
    let directory = Directory::new();
    let messages = vec![json!({"role":"user","content":"tail summary"})];
    for sidechain in [false, true] {
        let header = if sidechain {
            json!({"type":"agent_task","version":1,"id":"child"})
        } else {
            json!({"type":"user","message":{"role":"user","content":"old main message"}})
        };
        let path = write_records(
            &directory.0,
            if sidechain { "child-tail" } else { "main-tail" },
            &[header],
        );
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.set_len(70 * 1024 * 1024).unwrap();
        let mut record = checkpoint(&messages, "tail summary");
        record["isSidechain"] = json!(sidechain);
        write!(file, "\n{record}\n").unwrap();
        drop(file);
        let report = super::read_report(&path, None).await.unwrap();
        assert_eq!(report.messages, messages, "sidechain={sidechain}");
        assert_eq!(
            (report.damaged, report.omitted),
            (0, 0),
            "sidechain={sidechain}"
        );
    }
}

#[tokio::test]
async fn oversized_checkpoint_does_not_replace_readable_history() {
    let directory = Directory::new();
    let original = json!({"role":"user","content":"original history"});
    let oversized = checkpoint(
        &[json!({"role":"user","content":"x".repeat(16 * 1024 * 1024)})],
        "summary",
    );
    let path = write_records(
        &directory.0,
        "oversized-checkpoint",
        &[json!({"type":"user","message":original}), oversized],
    );
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(report.messages, vec![original]);
    assert_eq!((report.damaged, report.omitted), (1, 0));
}

#[tokio::test]
async fn checkpoint_history_still_obeys_the_retained_message_limit() {
    let directory = Directory::new();
    let messages = (0..4096)
        .map(|index| json!({"role":"user","content":format!("kept-{index}")}))
        .collect::<Vec<_>>();
    let path = write_records(
        &directory.0,
        "checkpoint-count",
        &[
            checkpoint(&messages, "summary"),
            json!({"type":"user","message":{"role":"user","content":"later turn"}}),
        ],
    );
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(report.omitted, 1);
    assert_eq!(report.messages.len(), 4097);
    assert!(report.messages[0]["content"]
        .as_str()
        .unwrap()
        .contains("omitted"));
    assert_eq!(report.messages[1]["content"], "kept-1");
    assert_eq!(report.messages.last().unwrap()["content"], "later turn");
}

#[tokio::test]
async fn bounded_restore_recovers_the_tail_after_a_sparse_broken_record() {
    let directory = Directory::new();
    let path = write_transcript(&directory.0, "broken-tail", "");
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.set_len(1024 * 1024 * 1024).unwrap();
    write!(
        file,
        "\n{}\n",
        json!({"type":"user","message":{"role":"user","content":"latest durable message"}})
    )
    .unwrap();
    drop(file);
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(report.messages.len(), 2);
    assert!(report.messages[0]["content"]
        .as_str()
        .unwrap()
        .contains("omitted"));
    assert_eq!(report.messages[1]["content"], "latest durable message");
}

#[tokio::test]
async fn page_stops_before_a_sparse_trailing_record() {
    let directory = Directory::new();
    let path = write_records(
        &directory.0,
        "page-tail",
        &[json!({"type":"user","message":{"role":"user","content":"first"}})],
    );
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(1024 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        page::read(
            &path,
            "test",
            &json!({"limit":1}),
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .len(),
        1
    );
    let error = page::read(
        &path,
        "test",
        &json!({"limit":2}),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("32 MiB"));
}

#[tokio::test]
async fn multi_image_record_fits_the_restoration_and_page_budgets() {
    let directory = Directory::new();
    let image = json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"A".repeat(6 * 1024 * 1024)}});
    let path = write_records(
        &directory.0,
        "images",
        &[json!({"type":"user","message":{"role":"user","content":[image,image]}})],
    );
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(report.messages.len(), 1);
    assert_eq!(report.messages[0]["content"].as_array().unwrap().len(), 2);
    assert_eq!(
        page::read(
            &path,
            "test",
            &json!({"limit":1}),
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .len(),
        1
    );
}

#[tokio::test]
async fn strict_resume_refuses_missing_history() {
    let directory = Directory::new();
    let error = load_resume(&directory.0, "missing", true)
        .await
        .unwrap_err();
    assert_eq!(error.code, "RESUME_HISTORY_UNAVAILABLE");
    assert_eq!(
        error.details.as_ref().unwrap()["name"],
        "ResumeHistoryError"
    );
    assert_eq!(error.details.unwrap()["reason"], "missing");
}

#[tokio::test]
async fn strict_resume_refuses_history_without_readable_messages() {
    let directory = Directory::new();
    write_records(
        &directory.0,
        "unreadable",
        &[json!({"type":"queue-operation"})],
    );
    let error = load_resume(&directory.0, "unreadable", true)
        .await
        .unwrap_err();
    assert_eq!(error.details.unwrap()["reason"], "unreadable");
}

#[tokio::test]
async fn strict_resume_refuses_damaged_records() {
    let directory = Directory::new();
    write_transcript(
        &directory.0,
        "damaged",
        &format!(
            "{}\n{{\"type\":\"assistant\",\"mess\n{}\n",
            json!({"type":"user","message":{"role":"user","content":"hello"}}),
            json!({"type":"user","message":{"role":"user","content":"again"}})
        ),
    );
    let error = load_resume(&directory.0, "damaged", true)
        .await
        .unwrap_err();
    assert_eq!(error.details.unwrap()["reason"], "incomplete");
}

#[tokio::test]
async fn strict_resume_refuses_recorded_results_that_cannot_be_paired() {
    let directory = Directory::new();
    write_records(
        &directory.0,
        "unpaired",
        &[
            json!({"type":"user","message":{"role":"user","content":"go"}}),
            json!({"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"a","name":"Read","input":{}}]}}),
            json!({"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"b","name":"Read","input":{}}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"output a"}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"b","content":"output b"}]}}),
            json!({"type":"user","message":{"role":"user","content":"next"}}),
        ],
    );
    let error = load_resume(&directory.0, "unpaired", true)
        .await
        .unwrap_err();
    assert_eq!(error.details.unwrap()["reason"], "incomplete");
}

#[tokio::test]
async fn strict_resume_repairs_calls_with_no_recorded_result_anywhere_in_history() {
    let directory = Directory::new();
    write_records(
        &directory.0,
        "unfinished",
        &[
            json!({"type":"user","message":{"role":"user","content":"go"}}),
            json!({"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"stopped","name":"Read","input":{}}]}}),
            json!({"type":"user","message":{"role":"user","content":"carry on"}}),
            json!({"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"ok"}]}}),
            json!({"type":"user","message":{"role":"user","content":"once more"}}),
            json!({"type":"assistant","message":{"id":"m3","role":"assistant","content":[{"type":"tool_use","id":"running","name":"Read","input":{}}]}}),
        ],
    );
    let messages = load_resume(&directory.0, "unfinished", true).await.unwrap();
    assert!(json!(messages).to_string().contains("stopped"));
    assert_eq!(messages.last().unwrap()["role"], "user");
    let repaired = messages
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_result")
        .collect::<Vec<_>>();
    assert_eq!(repaired.len(), 2);
    assert!(repaired.iter().all(|block| block["is_error"] == true));
    assert_eq!(repaired[0]["tool_use_id"], "stopped");
    assert_eq!(repaired[1]["tool_use_id"], "running");
}

#[tokio::test]
async fn nonstrict_resume_keeps_readable_history_and_allows_a_missing_transcript() {
    let directory = Directory::new();
    assert!(load_resume(&directory.0, "missing", false)
        .await
        .unwrap()
        .is_empty());
    write_transcript(
        &directory.0,
        "partial",
        &format!(
            "{}\n{{broken\n{}\n",
            json!({"type":"user","message":{"role":"user","content":"hello"}}),
            json!({"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi"}]}})
        ),
    );
    let messages = load_resume(&directory.0, "partial", false).await.unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0], json!({"role":"user","content":"hello"}));
    assert_eq!(
        messages[1],
        json!({"role":"assistant","content":[{"type":"text","text":"hi"}]})
    );
}

#[tokio::test]
async fn bounded_restore_renders_only_its_own_omission_notice_for_the_selected_model() {
    let directory = Directory::new();
    let original = "[Earlier conversation was omitted from active memory to stay within the history size limit. The original transcript remains on disk. Do not assume missing details.]";
    let mut lines = String::new();
    for index in 0..=super::MAX_HISTORY_MESSAGES {
        let text = if index == super::MAX_HISTORY_MESSAGES {
            original
        } else {
            "Earlier input."
        };
        lines.push_str(&serde_json::to_string(&json!({"type":"user","uuid":index.to_string(),"message":{"role":"user","content":text}})).unwrap());
        lines.push('\n');
    }
    let path = write_transcript(&directory.0, "bounded", &lines);
    let baseline = super::read_report(&path, None).await.unwrap();
    assert!(baseline.omitted > 0);
    assert_eq!(baseline.messages[0]["content"], original);
    let harness = crate::harness::Harness::from_config(&json!({"models":{
        "first":{"context.history.bounded_omission":"First model omission notice."},
        "second":{"context.history.bounded_omission":"Second model omission notice."}
    }}))
    .unwrap();
    for (model, expected) in [
        ("first", "First model omission notice."),
        ("second", "Second model omission notice."),
    ] {
        let report = super::read_report_with_harness(&path, None, &harness.for_model(model))
            .await
            .unwrap();
        assert_eq!(report.omitted, baseline.omitted);
        assert_eq!(report.messages[0]["content"], expected);
        assert_eq!(report.messages[1..], baseline.messages[1..]);
        assert_eq!(report.messages.last().unwrap()["content"], original);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn only_persisted_sessions_probe_git_and_store_the_observed_branch() {
    use std::os::unix::fs::PermissionsExt;
    let directory = Directory::new();
    let executable = directory.0.join("git");
    let observations = directory.0.join("probes.txt");
    std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\n' probe >> \"$HALO_FIXTURE_PROBE_LOG\"\nprintf '%s\\n' fixture-branch\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let options = json!({"cwd":directory.0,"env":{"HOME":directory.0,"CLAUDE_CONFIG_DIR":directory.0.join("state")},
        "nativeProcessEnv":{"PATH":directory.0,"HALO_FIXTURE_PROBE_LOG":observations}});
    for (session_id, mode) in [
        ("ephemeral", json!({"persistSession":false})),
        ("query", json!({"nativeQuery":true})),
    ] {
        let mut configured = options.clone();
        configured
            .as_object_mut()
            .unwrap()
            .extend(mode.as_object().unwrap().clone());
        let journal = super::Journal::new(session_id, &configured).await.unwrap();
        journal
            .append(
                "user",
                json!({"role":"user","content":"Input"}),
                "input",
                None,
                true,
            )
            .await
            .unwrap();
        journal.flush().await.unwrap();
        assert!(!observations.exists());
        assert!(!super::transcript_path(session_id, &configured).exists());
    }
    let journal = super::Journal::new("persisted", &options).await.unwrap();
    journal
        .append(
            "user",
            json!({"role":"user","content":"Input"}),
            "input",
            None,
            true,
        )
        .await
        .unwrap();
    journal.flush().await.unwrap();
    assert_eq!(std::fs::read_to_string(observations).unwrap(), "probe\n");
    let entry: Value = serde_json::from_str(
        &std::fs::read_to_string(super::transcript_path("persisted", &options)).unwrap(),
    )
    .unwrap();
    assert_eq!(entry["gitBranch"], "fixture-branch");
}

#[tokio::test]
async fn public_pages_and_line_offsets_match_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/public-pages.json")).unwrap();
    let directory = Directory::new();
    for (name, text) in fixture["datasets"].as_object().unwrap() {
        std::fs::write(directory.0.join(name), text.as_str().unwrap()).unwrap();
    }
    for case in fixture["pages"].as_array().unwrap() {
        let result = page::read(
            &directory.0.join(case["dataset"].as_str().unwrap()),
            "fallback",
            &case["options"],
            &CancellationToken::new(),
        )
        .await;
        if let Some(error) = case.get("error") {
            let result = result.unwrap_err();
            assert_eq!(result.message, error["message"].as_str().unwrap());
            assert_eq!(result.details.unwrap()["name"], error["name"]);
        } else {
            assert_eq!(
                crate::js::stringify(&json!(result.unwrap())),
                crate::js::stringify(&case["expected"]),
                "{}",
                case["options"]
            );
        }
    }
    for case in fixture["lines"].as_array().unwrap() {
        let mut reader = Reader::open(
            &directory.0.join("malformed"),
            case["start"].as_u64().unwrap(),
            false,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let mut records = Vec::new();
        while let Some(Entry::Record(record)) = reader.next().await.unwrap() {
            let mut value = json!({"line":record.line,"bytes":record.bytes,"start":record.start,"end":record.end,"terminated":record.terminated});
            if let Some(parsed) = record.value {
                value["value"] = parsed;
            }
            records.push(value);
        }
        assert_eq!(json!(records), case["expected"], "offset {}", case["start"]);
    }
}
#[tokio::test]
async fn first_prompt_scan_matches_fixtures_and_stays_within_its_prefix() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/first-prompts.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let directory = Directory::new();
        write_transcript(&directory.0, "session", case["text"].as_str().unwrap());
        let mut info = execute(
            "getSessionInfo",
            &options(&directory.0),
            json!({"sessionId":"session"}),
        )
        .await;
        assert!(info["lastModified"].as_f64().unwrap() > 0.0);
        assert!(info["createdAt"].as_f64().unwrap() > 0.0);
        info.as_object_mut().unwrap().shift_remove("lastModified");
        info.as_object_mut().unwrap().shift_remove("createdAt");
        assert_eq!(info, case["expected"], "{}", case["name"]);
    }
}
#[tokio::test]
async fn metadata_archives_and_forks_preserve_isolated_storage_and_real_effects() {
    let directory = Directory::new();
    let config = options(&directory.0);
    let transcript = write_transcript(
        &directory.0,
        "original",
        &format!(
            "{}\nmalformed\n{}\n",
            json!({"type":"user","uuid":"first","sessionId":"original","message":{"role":"user","content":"First request"}}),
            json!({"type":"assistant","uuid":"last","sessionId":"original","message":{"role":"assistant","content":"Answer"}})
        ),
    );
    execute(
        "renameSession",
        &config,
        json!({"sessionId":"original","title":"Title"}),
    )
    .await;
    execute(
        "tagSession",
        &config,
        json!({"sessionId":"original","tag":"marked"}),
    )
    .await;
    let info = execute("getSessionInfo", &config, json!({"sessionId":"original"})).await;
    assert_eq!(info["summary"], "Title");
    assert_eq!(info["firstPrompt"], "First request");
    assert_eq!(info["tag"], "marked");
    execute(
        "tagSession",
        &config,
        json!({"sessionId":"original","tag":Value::Null}),
    )
    .await;
    assert!(
        execute("getSessionInfo", &config, json!({"sessionId":"original"}))
            .await
            .get("tag")
            .is_none()
    );
    let before = execute("listSessions", &config, json!({})).await;
    let mut missing = config.clone();
    missing["upToMessageId"] = json!("missing");
    assert!(admin::execute(
        "forkSession",
        &missing,
        &json!({"sessionId":"original"}),
        &CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(execute("listSessions", &config, json!({})).await, before);
    let mut anchored = config.clone();
    anchored["upToMessageId"] = json!("first");
    let fork = execute("forkSession", &anchored, json!({"sessionId":"original"})).await;
    let messages = execute(
        "getSessionMessages",
        &config,
        json!({"sessionId":fork["sessionId"]}),
    )
    .await;
    assert_eq!(messages.as_array().unwrap().len(), 1);
    assert_eq!(messages[0]["session_id"], fork["sessionId"]);
    assert_eq!(messages[0]["uuid"], "first");
    let fork = execute("forkSession", &config, json!({"sessionId":"original"})).await;
    let copied = std::fs::read_to_string(super::transcript_path(
        fork["sessionId"].as_str().unwrap(),
        &config,
    ))
    .unwrap();
    assert!(copied.contains("\nmalformed\n"));
    assert!(!copied.contains("\"sessionId\":\"original\""));
    assert_eq!(
        std::fs::read_to_string(&transcript)
            .unwrap()
            .lines()
            .count(),
        3
    );
    let archive = transcript.parent().unwrap().join("original/subagents");
    std::fs::create_dir_all(&archive).unwrap();
    std::fs::write(
        archive.join("agent-reader.jsonl"),
        format!(
            "{}\n",
            json!({"type":"assistant","message":{"role":"assistant","content":"Archived"}})
        ),
    )
    .unwrap();
    assert_eq!(
        execute(
            "listArchivedRecords",
            &config,
            json!({"sessionId":"original"})
        )
        .await,
        json!(["reader"])
    );
    let messages = execute(
        "getArchivedRecordMessages",
        &config,
        json!({"sessionId":"original","agentId":"reader"}),
    )
    .await;
    assert_eq!(messages[0]["session_id"], "reader");
    assert_eq!(messages[0]["message"]["content"], "Archived");
    let other = options(&directory.0.join("other"));
    assert_eq!(execute("listSessions", &other, json!({})).await, json!([]));
    assert!(crate::js::is_undefined(
        &execute("getSessionInfo", &other, json!({"sessionId":"original"})).await
    ));
    assert!(crate::js::is_undefined(
        &execute(
            "renameSession",
            &other,
            json!({"sessionId":"absent","title":"Advisory metadata"})
        )
        .await
    ));
}
#[tokio::test]
async fn disk_json_preserves_objects_that_resemble_transport_markers() {
    let directory = Directory::new();
    let config = options(&directory.0);
    let raw = json!({"type":"user","uuid":"raw","message":{"role":"user","content":[{"type":"text","text":{"__haloSdkNativeUndefined":true}},{"type":"tool_result","content":{"__haloSdkNativeNumber":"NaN"}}]}});
    write_transcript(
        &directory.0,
        "raw",
        &format!("{}\n", serde_json::to_string(&raw).unwrap()),
    );
    let info = execute("getSessionInfo", &config, json!({"sessionId":"raw"})).await;
    assert_eq!(info["firstPrompt"], "[object Object]");
    let original = execute("getSessionMessages", &config, json!({"sessionId":"raw"})).await;
    assert_eq!(original[0]["message"], raw["message"]);
    let fork = execute("forkSession", &config, json!({"sessionId":"raw"})).await;
    let copied = execute(
        "getSessionMessages",
        &config,
        json!({"sessionId":fork["sessionId"]}),
    )
    .await;
    assert_eq!(copied[0]["message"], raw["message"]);
}
#[tokio::test]
async fn page_and_fork_limits_fail_without_publishing_an_incomplete_copy() {
    let directory = Directory::new();
    let config = options(&directory.0);
    let rows = (0..6000)
        .map(|index| {
            format!(
                "{}\n",
                json!({"type":"user","uuid":format!("record-{index}"),"message":{"role":"user","content":format!("message-{index}")}})
            )
        })
        .collect::<String>();
    let file = write_transcript(&directory.0, "many", &rows);
    let report = super::read_report(&file, None).await.unwrap();
    assert!(report.messages.len() <= 4097);
    assert_eq!(report.messages.last().unwrap()["content"], "message-5999");
    let earlier = super::read_report(&file, Some("record-3")).await.unwrap();
    assert!(earlier.anchor_found);
    assert_eq!(earlier.messages.len(), 4);
    assert_eq!(earlier.messages.last().unwrap()["content"], "message-3");
    assert_eq!(
        page::read(&file, "many", &json!({}), &CancellationToken::new())
            .await
            .unwrap_err()
            .message,
        "History exceeds the default page limit. Supply limit and offset."
    );
    assert_eq!(
        page::read(
            &file,
            "many",
            &json!({"offset":4096,"limit":1}),
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .len(),
        1
    );
    let later = page::read(
        &file,
        "many",
        &json!({"offset":5000,"limit":2}),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        later
            .iter()
            .map(|entry| entry["message"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!({"role":"user","content":"message-5000"}),
            json!({"role":"user","content":"message-5001"}),
        ]
    );
    let oversized = format!(
        "{}\n{}",
        json!({"type":"assistant","uuid":"first","responseUuid":"reply","message":{"role":"assistant","content":"kept"}}),
        "x".repeat(32 * 1024 * 1024 + 1)
    );
    let file = write_transcript(&directory.0, "oversized", &oversized);
    let page = page::read(
        &file,
        "oversized",
        &json!({"limit":1}),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["uuid"], "first");
    let before = std::fs::read_dir(file.parent().unwrap()).unwrap().count();
    let error = admin::execute(
        "forkSession",
        &config,
        &json!({"sessionId":"oversized"}),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.message, "Transcript record exceeds the 32 MiB limit");
    assert_eq!(
        std::fs::read_dir(file.parent().unwrap()).unwrap().count(),
        before
    );
}

#[tokio::test]
async fn checkpoint_limits_refuse_before_appending_and_allow_a_later_write() {
    let directory = Directory::new();
    let journal = super::Journal::new("checkpoint-limits", &options(&directory.0))
        .await
        .unwrap();
    journal
        .append(
            "user",
            json!({"role":"user","content":"old history remains"}),
            "old",
            None,
            true,
        )
        .await
        .unwrap();
    let path = super::transcript_path("checkpoint-limits", &options(&directory.0));
    let before = std::fs::read(&path).unwrap();
    let oversized = json!({"role":"user","content":"字".repeat((16 * 1024 * 1024) / 3)});
    let error = journal
        .checkpoint(&[oversized], "summary")
        .await
        .unwrap_err();
    assert_eq!(error.code, "CHECKPOINT_SIZE");
    assert!(error.message.contains("16 MiB"));
    let oversized_count = vec![json!({"role":"user","content":"old"}); 4097];
    let error = journal
        .checkpoint(&oversized_count, "summary")
        .await
        .unwrap_err();
    assert_eq!(error.code, "INVALID_CHECKPOINT");
    assert!(error.message.contains("4096"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    journal
        .checkpoint(&[json!({"role":"user","content":"small recovery"})], "summary")
        .await
        .unwrap();
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(
        report.messages,
        vec![json!({"role":"user","content":"small recovery"})]
    );
}

#[tokio::test]
async fn oversized_tool_context_record_is_refused_without_replacing_prior_history() {
    let directory = Directory::new();
    let journal = super::Journal::new("tool-context-limit", &options(&directory.0))
        .await
        .unwrap();
    journal
        .append(
            "user",
            json!({"role":"user","content":"kept"}),
            "kept",
            None,
            true,
        )
        .await
        .unwrap();
    let path = super::transcript_path("tool-context-limit", &options(&directory.0));
    let before = std::fs::read(&path).unwrap();
    let oversized = json!({"role":"user","content":"large","toolContext":{"version":1,
        "calls":[{"id":"large","definitionVersion":"v","input":{"tool":"mcp__fixture__write",
            "arguments":"x".repeat(8 * 1024 * 1024)}}]}});
    let error = journal
        .append("user", oversized, "large", None, true)
        .await
        .unwrap_err();
    assert_eq!(error.code, "INVALID_TOOL_CONTEXT");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!journal.has_complete_history().await);
    journal
        .append(
            "user",
            json!({"role":"user","content":"small"}),
            "small",
            None,
            true,
        )
        .await
        .unwrap();
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(
        report.messages,
        vec![
            json!({"role":"user","content":"kept"}),
            json!({"role":"user","content":"small"})
        ]
    );
}

#[tokio::test]
async fn first_append_creates_missing_directories_and_an_empty_cwd_writes_nothing() {
    let directory = Directory::new();
    let root = directory.0.join("nested").join("state");
    let journal = super::Journal::new("created", &options(&root)).await.unwrap();
    let path = super::transcript_path("created", &options(&root));
    assert!(!path.exists());
    journal
        .append(
            "user",
            json!({"role":"user","content":"first"}),
            "first",
            None,
            true,
        )
        .await
        .unwrap();
    assert!(path.exists());
    let disabled = json!({"cwd":"","env":{"FIXTURE_STORE":root}});
    let journal = super::Journal::new("disabled", &disabled).await.unwrap();
    journal
        .append(
            "user",
            json!({"role":"user","content":"ignored"}),
            "ignored",
            None,
            true,
        )
        .await
        .unwrap();
    assert!(!super::transcript_path("disabled", &disabled)
        .parent()
        .unwrap()
        .exists()
        || !super::transcript_path("disabled", &disabled).exists());
    assert!(!journal.has_complete_history().await);
}

#[tokio::test]
async fn flush_waits_for_every_queued_append() {
    let directory = Directory::new();
    let journal = super::Journal::new("flushed", &options(&directory.0))
        .await
        .unwrap();
    for index in 0..32 {
        journal
            .append(
                "user",
                json!({"role":"user","content":format!("turn-{index}")}),
                &format!("uuid-{index}"),
                None,
                true,
            )
            .await
            .unwrap();
    }
    journal.flush().await.unwrap();
    let path = super::transcript_path("flushed", &options(&directory.0));
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 32);
    assert!(text.lines().last().unwrap().contains("turn-31"));
}

#[tokio::test]
async fn failed_strict_append_does_not_poison_later_writes() {
    let directory = Directory::new();
    let journal = super::Journal::new("poisoned", &options(&directory.0))
        .await
        .unwrap();
    let (entered, release) = journal.pause_next_append();
    let pending = tokio::spawn(async move {
        let result = journal
            .append(
                "assistant",
                json!({"role":"assistant","content":[{"type":"text","text":"interrupted"}]}),
                "failed",
                Some("response"),
                true,
            )
            .await;
        let journal = journal;
        (journal, result)
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !entered.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(std::time::Instant::now() < deadline, "append test gate was not entered");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let path = super::transcript_path("poisoned", &options(&directory.0));
    // A regular file where the project directory belongs makes the append's parent creation fail.
    let projects = path.parent().unwrap().parent().unwrap();
    let _ = std::fs::remove_dir_all(projects);
    std::fs::write(projects, b"not a directory").unwrap();
    release.notify_one();
    let (journal, failed) = pending.await.unwrap();
    assert!(failed.is_err());
    assert!(!journal.has_complete_history().await);
    journal.flush().await.unwrap();
    std::fs::remove_file(projects).unwrap();
    journal
        .append(
            "assistant",
            json!({"role":"assistant","content":[{"type":"text","text":"saved"}]}),
            "saved",
            Some("next"),
            true,
        )
        .await
        .unwrap();
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(
        report.messages,
        vec![json!({"role":"assistant","content":[{"type":"text","text":"saved"}]})]
    );
}

#[tokio::test]
async fn stored_transcript_existence_requires_a_readable_file() {
    let directory = Directory::new();
    let path = super::transcript_path("absent", &options(&directory.0));
    assert!(!path.exists());
    assert_eq!(
        execute(
            "getSessionMessages",
            &options(&directory.0),
            json!({"sessionId":"absent"})
        )
        .await,
        json!([])
    );
    assert_eq!(
        execute(
            "getSessionInfo",
            &options(&directory.0),
            json!({"sessionId":"absent"})
        )
        .await,
        crate::js::undefined()
    );
    write_records(
        &directory.0,
        "present",
        &[json!({"type":"user","message":{"role":"user","content":"stored"}})],
    );
    let path = super::transcript_path("present", &options(&directory.0));
    assert!(path.exists());
    assert!(!execute(
        "getSessionMessages",
        &options(&directory.0),
        json!({"sessionId":"present"})
    )
    .await
    .is_null());
}

#[tokio::test]
async fn legacy_records_without_any_optional_metadata_are_still_readable() {
    let directory = Directory::new();
    let path = write_transcript(
        &directory.0,
        "legacy-minimal",
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"legacy message\"},\"uuid\":\"legacy\",\"parentUuid\":null,\"sessionId\":\"legacy-minimal\"}\n",
    );
    let report = super::read_report(&path, None).await.unwrap();
    assert_eq!(report.damaged, 0);
    assert_eq!(
        report.messages,
        vec![json!({"role":"user","content":"legacy message"})]
    );
    let page = page::read(&path, "legacy-minimal", &json!({}), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["uuid"], "legacy");
    assert_eq!(page[0]["message"]["content"], "legacy message");
}

#[tokio::test]
async fn archived_record_lookups_are_empty_without_a_destination() {
    let directory = Directory::new();
    assert_eq!(
        execute(
            "listArchivedRecords",
            &options(&directory.0),
            json!({"sessionId":"nothing"}),
        )
        .await,
        json!([])
    );
    assert_eq!(
        execute(
            "getArchivedRecordMessages",
            &options(&directory.0),
            json!({"sessionId":"nothing","agentId":"child"}),
        )
        .await,
        json!([])
    );
    let archive = super::transcript_path("parent", &options(&directory.0))
        .parent()
        .unwrap()
        .join("parent")
        .join("subagents")
        .join("agent-child.jsonl");
    std::fs::create_dir_all(archive.parent().unwrap()).unwrap();
    std::fs::write(
        &archive,
        json!({"type":"assistant","uuid":"archived","message":{"role":"assistant","content":"archived result"}}).to_string()
            + "\n",
    )
    .unwrap();
    assert_eq!(
        execute(
            "listArchivedRecords",
            &options(&directory.0),
            json!({"sessionId":"parent"}),
        )
        .await,
        json!(["child"])
    );
    let messages = execute(
        "getArchivedRecordMessages",
        &options(&directory.0),
        json!({"sessionId":"parent","agentId":"child"}),
    )
    .await;
    assert_eq!(messages[0]["message"]["content"], "archived result");
}
