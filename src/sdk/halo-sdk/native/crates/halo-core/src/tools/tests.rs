use super::*;
use async_trait::async_trait;
use std::path::PathBuf;
struct Fixture {
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("halo-native-tools-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self { path }
    }
    fn context(&self) -> ToolContext {
        ToolContext {
            session_id: "test".into(),
            cwd: self.path.to_string_lossy().into_owned(),
            env: json!({"AGENT_SHELL":"/bin/bash"}),
            current_turn: 0,
            tool_use_id: "test-call".into(),
            cancellation: CancellationToken::new(),
            harness: crate::harness::baseline(),
        }
    }
    fn options(&self) -> Value {
        json!({"cwd":self.path,"sessionId":"test","persistSession":false,"skillCatalog":[]})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}
struct NoHost;
struct CustomSearch;
#[async_trait]
impl HostBridge for CustomSearch {
    async fn call(&self,method:&str,request:Value,_:&CancellationToken)->Result<Value>{assert_eq!(method,"tools.execute");assert_eq!(request["name"],"CodeSearch");Ok(success("custom service",None))}
}
struct HostSearch {
    requests: std::sync::Mutex<Vec<Value>>,
}
#[async_trait]
impl HostBridge for HostSearch {
    async fn call(&self, method: &str, request: Value, _: &CancellationToken) -> Result<Value> {
        assert_eq!(method, "codeSearch.search");
        self.requests.lock().unwrap().push(request.clone());
        Ok(json!({"hits":[],"freshness":"fresh","root":request["root"],"query":request["query"]}))
    }
}
struct ResourceHost {
    activity: Arc<crate::resource_activity::ResourceActivity>,
}
#[async_trait]
impl HostBridge for ResourceHost {
    fn resource_activity(&self) -> Option<Arc<crate::resource_activity::ResourceActivity>> {
        Some(self.activity.clone())
    }
    async fn call(&self, method: &str, _: Value, _: &CancellationToken) -> Result<Value> {
        Err(Error::new("UNEXPECTED_CALLBACK", method))
    }
}
struct HostedMcp {
    path: PathBuf,
}
struct FileChanges {
    records: std::sync::Mutex<Vec<Value>>,
    rewrite_after_edit: bool,
}
#[derive(Default)]
struct ExternalReads {
    values: std::sync::Mutex<serde_json::Map<String, Value>>,
    writes: std::sync::atomic::AtomicUsize,
    mutation_after_write: bool,
}
#[async_trait]
impl HostBridge for ExternalReads {
    async fn call(&self, method: &str, params: Value, _: &CancellationToken) -> Result<Value> {
        let path = params["path"].as_str().unwrap();
        let mut values = self.values.lock().unwrap();
        match method {
            "file.readState.get" => Ok(values
                .get(path)
                .cloned()
                .unwrap_or_else(crate::js::undefined)),
            "file.readState.set" => {
                self.writes
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                values.shift_remove(path);
                while values.len() >= params["maxEntries"].as_u64().unwrap() as usize {
                    let first = values.keys().next().unwrap().clone();
                    values.shift_remove(&first);
                }
                values.insert(path.into(), params["value"].clone());
                Ok(Value::Null)
            }
            "file.readState.delete" => {
                values.shift_remove(path);
                Ok(Value::Null)
            }
            "file.recordChange" => {
                assert_eq!(values[path]["content"], "written");
                if self.mutation_after_write {
                    values.get_mut(path).unwrap()["timestamp"] = json!(0);
                }
                Ok(Value::Null)
            }
            _ => panic!("unexpected method {method}"),
        }
    }
}
#[async_trait]
impl HostBridge for FileChanges {
    async fn call(
        &self,
        method: &str,
        params: Value,
        _cancellation: &CancellationToken,
    ) -> Result<Value> {
        use base64::Engine;
        assert_eq!(method, "file.recordChange");
        assert_eq!(params["callbackId"], "file-change");
        let before = base64::engine::general_purpose::STANDARD
            .decode(params["before"].as_str().unwrap())
            .unwrap();
        let after = base64::engine::general_purpose::STANDARD
            .decode(params["after"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            std::fs::read(params["path"].as_str().unwrap()).unwrap(),
            after
        );
        if self.rewrite_after_edit && !before.is_empty() {
            std::fs::write(params["path"].as_str().unwrap(), "changed by callback").unwrap();
        }
        self.records.lock().unwrap().push(json!({"path":params["path"],"before":String::from_utf8(before).unwrap(),"after":String::from_utf8(after).unwrap()}));
        Ok(Value::Null)
    }
}
#[async_trait]
impl HostBridge for HostedMcp {
    async fn call(
        &self,
        method: &str,
        params: Value,
        _cancellation: &CancellationToken,
    ) -> Result<Value> {
        assert_eq!(method, "mcp.call");
        assert_eq!(params["server"], "configured/key");
        assert_eq!(params["name"], "write/result");
        std::fs::write(&self.path, params["input"]["value"].as_str().unwrap()).unwrap();
        Ok(json!({"content":[{"type":"text","text":"written through host"}]}))
    }
}
#[async_trait]
impl HostBridge for NoHost {
    async fn call(
        &self,
        method: &str,
        _params: Value,
        _cancellation: &CancellationToken,
    ) -> Result<Value> {
        Err(Error::new("UNEXPECTED_CALLBACK", method))
    }
}
#[async_trait]
impl EventSink for NoHost {
    async fn emit(&self, _event: Value) -> Result<()> {
        Ok(())
    }
}
async fn runtime(f: &Fixture) -> ToolRuntime {
    let mut runtime = ToolRuntime::new(f.options(), Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    runtime
}
#[tokio::test]
async fn host_code_search_keeps_scope_and_never_launches_a_local_backend() {
    let fixture = Fixture::new();
    let cache = fixture
        .path
        .with_file_name(format!("native-host-search-cache-{}", uuid::Uuid::new_v4()));
    let denied = fixture.path.join("private");
    let bridge = Arc::new(HostSearch {
        requests: Default::default(),
    });
    let mut options = fixture.options();
    options["tools"] = json!(["CodeSearch"]);
    options["nativeCodeSearchBridge"] = json!(true);
    options["nativeReadDenyRoots"] = json!([denied]);
    options["codeSearch"] = json!({"backend":"zvec-grep","nodePath":"/missing/node","modulePath":"/missing/backend","cachePath":cache});
    let mut runtime = ToolRuntime::new(options, bridge.clone(), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    assert!(runtime.code_search.is_none());
    assert_eq!(runtime.definitions()[0]["name"], "CodeSearch");
    let result = runtime
        .execute(
            "CodeSearch",
            json!({"query":"host-owned","root":"/ignored","readDenyRoots":[]}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], false);
    let requests = bridge.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["root"], fixture.path.to_string_lossy().as_ref());
    assert!(requests[0]["readDenyRoots"]
        .as_array()
        .unwrap()
        .contains(&json!(file::real_path(&denied))));
    assert!(requests[0]["readDenyRoots"]
        .as_array()
        .unwrap()
        .contains(&json!(file::real_path(&cache))));
    drop(requests);
    runtime.close().await.unwrap();
    assert!(!cache.exists());
    assert_eq!(bridge.requests.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn owned_definition_metadata_renders_per_model_without_rebinding_execution(){
    let fixture=Fixture::new();let baseline=crate::harness::baseline().resource(ResourceId::CodeSearchDefinition);
    let descriptor=json!({"name":"CodeSearch","description":baseline["description"],"inputSchema":baseline["input_schema"],"permissionLevel":"readonly","__haloSdkNativeToolDefinition":"CodeSearchDefinition"});
    let harness=Harness::from_config(&json!({"models":{"one":{"tools.code_search.description":"first model description"},"two":{"tools.code_search.description":"second model description"}}})).unwrap();
    for exact in [false,true]{
        let mut options=fixture.options();options["tools"]=json!([]);options[if exact{"nativeSuppliedTools"}else{"customTools"}]=json!([descriptor]);
        let mut runtime=ToolRuntime::new(options,Arc::new(CustomSearch),Arc::new(NoHost));runtime.initialize(&CancellationToken::new()).await.unwrap();
        runtime.set_harness(harness.for_model("one"));let selected=runtime.selected_tools();assert_eq!(selected[0].definition["description"],"first model description");assert_eq!(selected[0].catalog_entry()["description"],"first model description");
        runtime.set_harness(harness.for_model("two"));assert_eq!(runtime.definitions()[0]["description"],"second model description");assert_eq!(runtime.execute_selected(&selected[0],json!({"query":"test"}),fixture.context()).await.unwrap()["content"],"custom service");runtime.close().await.unwrap();
    }
}
#[tokio::test]
async fn background_resource_activity_tracks_open_pipes_and_output_finalization() {
    let fixture = Fixture::new();
    for command in ["sleep 30", "exec 1>&- 2>&-; sleep 30"] {
        let activity = Arc::new(crate::resource_activity::ResourceActivity::new());
        let changes = Arc::new(tokio::sync::Notify::new());
        let observed = changes.clone();
        let _subscription = activity.subscribe(move |_| observed.notify_waiters());
        let host = Arc::new(ResourceHost {
            activity: activity.clone(),
        });
        let mut runtime = ToolRuntime::new(fixture.options(), host, Arc::new(NoHost));
        runtime.initialize(&CancellationToken::new()).await.unwrap();
        assert!(!activity.snapshot().active);
        let launched = runtime
            .execute(
                "Bash",
                json!({"command":command,"run_in_background":true}),
                fixture.context(),
            )
            .await
            .unwrap();
        assert_eq!(launched["isError"], false);
        if command.starts_with("exec") {
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let notified = changes.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if !activity.snapshot().active {
                        break;
                    }
                    notified.await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                runtime
                    .tool_context_call(
                        "backgroundTasks.get",
                        json!([launched["metadata"]["task_id"]])
                    )
                    .unwrap()["status"],
                "running"
            );
        } else {
            assert!(activity.snapshot().active);
        }
        runtime.close().await.unwrap();
        assert!(!activity.snapshot().active);
    }
}

fn direct_context(f: &Fixture) -> Value {
    json!({"cwd":f.path,"sessionId":"direct-owner","env":{},"currentTurn":0,"skillCatalog":[],"nativeProcessEnv":{"HOME":f.path,"CLAUDE_CONFIG_DIR":f.path.join("settings"),"PATH":"/usr/bin:/bin","AGENT_SHELL":"/bin/bash"},"nativeHomeDirectory":f.path,"nativeTempDirectory":f.path,"nativeOwner":{"readFileStatePresent":false,"externalReadFileState":false,"externalBackgroundTasks":false}})
}

#[tokio::test]
async fn direct_tools_preserve_optional_file_state_and_per_call_callbacks() {
    let f = Fixture::new();
    let owner = DirectToolOwner::new("direct-owner".into());
    let path = f.path.join("direct.txt");
    std::fs::write(&path, "original").unwrap();
    let context = direct_context(&f);
    let written = owner
        .execute(
            "Write".into(),
            json!({"file_path":"direct.txt","content":"written"}),
            context.clone(),
            Arc::new(NoHost),
            Arc::new(NoHost),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(written["isError"], false);
    let mut callback_context = context.clone();
    callback_context["nativeOwner"]["recordFileChange"] =
        json!({"__haloSdkNativeCallback":"file-change"});
    let bridge = Arc::new(FileChanges {
        records: Default::default(),
        rewrite_after_edit: true,
    });
    let edited = owner
        .execute(
            "Edit".into(),
            json!({"file_path":"direct.txt","old_string":"written","new_string":"edited"}),
            callback_context,
            bridge.clone(),
            Arc::new(NoHost),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(edited["isError"], false);
    assert_eq!(
        edited["content"],
        format!("Successfully edited {} (1 replacement).", path.display())
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "changed by callback"
    );
    assert_eq!(bridge.records.lock().unwrap().len(), 1);
    let written = owner
        .execute(
            "Write".into(),
            json!({"file_path":"direct.txt","content":"new callback channel"}),
            context,
            Arc::new(NoHost),
            Arc::new(NoHost),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(written["isError"], false);
    assert_eq!(bridge.records.lock().unwrap().len(), 1);
    owner.close().await;
}

#[tokio::test]
async fn direct_tools_share_shell_state_without_capturing_call_environment() {
    let f = Fixture::new();
    std::fs::create_dir(f.path.join("child")).unwrap();
    let owner = DirectToolOwner::new("direct-owner".into());
    let mut context = direct_context(&f);
    context["nativeProcessEnv"]["DIRECT_BASE"] = json!("first");
    let first = owner.execute("Bash".into(),json!({"command":"cd child; export DIRECT_SAVED=retained; printf '%s' \"$DIRECT_BASE\""}),context.clone(),Arc::new(NoHost),Arc::new(NoHost),CancellationToken::new()).await.unwrap();
    assert_eq!(first["content"], "first");
    context["nativeProcessEnv"]["DIRECT_BASE"] = json!("second");
    context["nativeProcessEnv"]["DIRECT_LATE"] = json!("second");
    context["env"] = json!({"DIRECT_BASE":false});
    let second = owner.execute("Bash".into(),json!({"command":"printf '%s|%s|%s|%s' \"$DIRECT_BASE\" \"$DIRECT_LATE\" \"$DIRECT_SAVED\" \"${PWD##*/}\""}),context.clone(),Arc::new(NoHost),Arc::new(NoHost),CancellationToken::new()).await.unwrap();
    assert_eq!(second["content"], "first|second|retained|child");
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let stopped = owner
        .execute(
            "Bash".into(),
            json!({"command":"sleep 2"}),
            context.clone(),
            Arc::new(NoHost),
            Arc::new(NoHost),
            cancelled.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        stopped["content"],
        "Command exited with code 130\n(No output)"
    );
    std::fs::write(f.path.join("cancelled.txt"), "still readable").unwrap();
    let read = owner
        .execute(
            "Read".into(),
            json!({"file_path":"cancelled.txt"}),
            context.clone(),
            Arc::new(NoHost),
            Arc::new(NoHost),
            cancelled,
        )
        .await
        .unwrap();
    assert_eq!(read["isError"], false);
    assert!(read["content"].as_str().unwrap().contains("still readable"));
    let absent = owner
        .execute(
            "Bash".into(),
            json!({"command":"exit 0","run_in_background":true}),
            context.clone(),
            Arc::new(NoHost),
            Arc::new(NoHost),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        absent["content"],
        "Background execution requires session-owned task services"
    );
    for name in ["TaskOutput", "TaskStop"] {
        let absent = owner
            .execute(
                name.into(),
                json!({"task_id":"missing"}),
                context.clone(),
                Arc::new(NoHost),
                Arc::new(NoHost),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(absent["content"], "Task 'missing' not found");
    }
    owner.close().await;
}

struct ExternalTasks {
    task: std::sync::Mutex<Value>,
    requests: std::sync::Mutex<Vec<Value>>,
    stop: bool,
}
#[async_trait]
impl HostBridge for ExternalTasks {
    async fn call(
        &self,
        method: &str,
        request: Value,
        _cancel: &CancellationToken,
    ) -> Result<Value> {
        assert_eq!(method, "direct.background");
        self.requests.lock().unwrap().push(request.clone());
        match request["method"].as_str().unwrap() {
            "start" | "get" => Ok(self.task.lock().unwrap().clone()),
            "stop" => Ok(json!(self.stop)),
            "wait" => {
                assert_eq!(
                    request["args"][0],
                    json!({"entryId":"original-entry","id":"external-task"})
                );
                let mut task = self.task.lock().unwrap();
                task["status"] = json!("completed");
                task["completedAt"] = json!(1001);
                task["exitCode"] = json!(0);
                Ok(task.clone())
            }
            "readOutput" => {
                assert_eq!(
                    request["args"][0],
                    json!({"entryId":"original-entry","id":"external-task"})
                );
                Ok(
                    json!({"entry":self.task.lock().unwrap().clone(),"preview":{"output":"owned by external registry","truncated":false}}),
                )
            }
            method => panic!("unexpected method {method}"),
        }
    }
}

#[tokio::test]
async fn direct_tools_use_external_task_identity_and_observe_stop_failure() {
    let f = Fixture::new();
    let owner = DirectToolOwner::new("direct-owner".into());
    let mut context = direct_context(&f);
    context["nativeOwner"]["externalBackgroundTasks"] = json!(true);
    let bridge = Arc::new(ExternalTasks {
        task: std::sync::Mutex::new(
            json!({"id":"external-task","nativeEntryId":"original-entry","command":"owned command","status":"running","startedAt":1000,"completedAt":null,"exitCode":null,"outputFile":"/external/output"}),
        ),
        requests: Default::default(),
        stop: false,
    });
    let started = owner
        .execute(
            "Bash".into(),
            json!({"command":"external launch","run_in_background":true,"timeout":"25"}),
            context.clone(),
            bridge.clone(),
            Arc::new(NoHost),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(started["isError"], false);
    assert!(started["content"]
        .as_str()
        .unwrap()
        .contains("Execution deadline: 25ms from launch."));
    assert_eq!(
        bridge.requests.lock().unwrap()[0]["args"][0]["timeoutMs"],
        25
    );
    let stop = owner
        .execute(
            "TaskStop".into(),
            json!({"task_id":"external-task"}),
            context.clone(),
            bridge.clone(),
            Arc::new(NoHost),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stop["content"], "Failed to stop task 'external-task'");
    let output = owner
        .execute(
            "TaskOutput".into(),
            json!({"task_id":"external-task"}),
            context,
            bridge.clone(),
            Arc::new(NoHost),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let output: Value = serde_json::from_str(output["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        output,
        json!({"retrieval_status":"success","task":{"task_id":"external-task","type":"bash","description":"owned command","status":"completed","result":"owned by external registry","error":null,"output_file":"/external/output","truncated":false,"exit_code":0,"started_at":"1970-01-01T00:00:01.000Z","ended_at":"1970-01-01T00:00:01.001Z"}})
    );
    owner.close().await;
    assert!(!bridge
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| ["dispose", "stopAll"].contains(&request["method"].as_str().unwrap())));
}
#[tokio::test]
async fn feedback_and_file_effects_match_fixtures() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/feedback.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let fixture = Fixture::new();
        for (name, content) in case["files"].as_object().unwrap() {
            std::fs::write(fixture.path.join(name), content.as_str().unwrap()).unwrap();
        }
        let runtime = runtime(&fixture).await;
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let actual = runtime
                .execute(
                    step["tool"].as_str().unwrap(),
                    step["input"].clone(),
                    fixture.context(),
                )
                .await
                .unwrap();
            let normalized: Value = serde_json::from_str(
                &serde_json::to_string(&actual)
                    .unwrap()
                    .replace(fixture.path.to_str().unwrap(), "<root>"),
            )
            .unwrap();
            assert_eq!(
                normalized, step["expected"],
                "case={}, step={index}",
                case["name"]
            );
        }
        for (name, content) in case["finalFiles"].as_object().unwrap() {
            assert_eq!(
                std::fs::read_to_string(fixture.path.join(name)).unwrap(),
                content.as_str().unwrap(),
                "case={}, file={name}",
                case["name"]
            );
        }
        runtime.close().await.unwrap();
    }
}
#[test]
fn declarative_tool_resources_match_fixtures() {
    let expected: Value = serde_json::from_str(include_str!("assets/definitions.json")).unwrap();
    assert_eq!(
        crate::harness::baseline().resource(ResourceId::ToolDefinitions),
        expected
    );
    let expected: Value =
        serde_json::from_str(include_str!("../skills/assets/builtins.json")).unwrap();
    assert_eq!(
        crate::harness::baseline().resource(ResourceId::BuiltinSkills),
        expected
    );
    let expected: Value =
        serde_json::from_str(include_str!("../commands/assets/builtins.json")).unwrap();
    assert_eq!(
        crate::harness::baseline().resource(ResourceId::CommandDefinitions),
        expected
    );
}
#[test]
fn mcp_results_match_fixtures_and_keep_external_text_opaque() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/mcp-results.json")).unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(mcp::format_result(&case["input"]), case["expected"]);
    }
    let harness =
        Harness::from_config(&json!({"templates":{"tools.mcp.image":"Image profile {mime}"}}))
            .unwrap()
            .for_model("fixture");
    let result = mcp::format_result_with_harness(
        &json!({"content":[{"type":"text","text":"foreign {mime} instructions"},{"type":"image","mimeType":"image/png","data":"aGk="}]}),
        &harness,
    );
    assert_eq!(
        result["content"],
        "foreign {mime} instructions\nImage profile image/png"
    );
    assert_eq!(result["images"][0]["data"], "aGk=");
}
#[tokio::test]
async fn model_text_selection_preserves_working_state_and_opaque_tool_data() {
    let fixture = Fixture::new();
    let harness = Harness::from_config(&json!({"models":{
        "a":{"tools.read.description":"Read profile A","tools.file.invalid_offset":"offset A","tools.goal.set":"Goal A","tools.todos.updated":"A {list}","context.todos.reminder":"Todos A {list}"},
        "b":{"tools.read.description":"Read profile B","tools.file.invalid_offset":"offset B","tools.goal.updated":"Goal B","context.todos.reminder":"Todos B {list}"}
    }})).unwrap();
    let a = harness.for_model("a");
    let b = harness.for_model("b");
    let runtime = runtime(&fixture).await;
    let mut context = fixture.context();
    context.harness = a.clone();
    runtime.set_harness(a.clone());
    let first_revision = runtime.tool_catalog_revision();
    let first_definition = runtime
        .definitions()
        .into_iter()
        .find(|tool| tool["name"] == "Read")
        .unwrap();
    assert_eq!(first_definition["description"], "Read profile A");
    assert_eq!(
        runtime
            .execute(
                "Read",
                json!({"file_path":"missing","offset":-1}),
                context.clone()
            )
            .await
            .unwrap()["content"],
        "offset A"
    );
    let goal = runtime
        .execute(
            "Goal",
            json!({"action":"set","objective":"literal {list} user data"}),
            context.clone(),
        )
        .await
        .unwrap();
    assert!(goal["content"].as_str().unwrap().starts_with("Goal A\n"));
    runtime
        .execute(
            "TodoWrite",
            json!({"todos":[{"content":"literal {list}","status":"pending"}]}),
            context.clone(),
        )
        .await
        .unwrap();
    runtime.set_harness(b.clone());
    assert!(runtime.tool_catalog_revision() > first_revision);
    let second_definition = runtime
        .definitions()
        .into_iter()
        .find(|tool| tool["name"] == "Read")
        .unwrap();
    assert_eq!(second_definition["description"], "Read profile B");
    assert_eq!(
        second_definition["input_schema"],
        first_definition["input_schema"]
    );
    assert_eq!(
        runtime.todo_attachment().unwrap()["content"][0]["text"],
        "Todos B [ ] literal {list}"
    );
    assert_eq!(runtime.get_goal()["objective"], "literal {list} user data");
    assert_eq!(
        runtime
            .execute(
                "Read",
                json!({"file_path":"missing","offset":-1}),
                context.clone()
            )
            .await
            .unwrap()["content"],
        "offset A",
        "an admitted call retains its model selection"
    );
    context.harness = b;
    assert_eq!(
        runtime
            .execute(
                "Read",
                json!({"file_path":"missing","offset":-1}),
                context.clone()
            )
            .await
            .unwrap()["content"],
        "offset B"
    );
    assert!(runtime
        .execute(
            "Goal",
            json!({"action":"update","note":"done {goal}"}),
            context
        )
        .await
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .starts_with("Goal B\n"));
    runtime.close().await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn completed_background_errors_render_for_the_consuming_model() {
    let fixture = Fixture::new();
    let harness = Harness::from_config(&json!({"models":{
        "launch":{"tools.shell.task_timed_out":"launch timeout {timeout}"},
        "consume":{"tools.shell.task_timed_out":"consume timeout {timeout}"}
    }}))
    .unwrap();
    let runtime = runtime(&fixture).await;
    let mut context = fixture.context();
    context.harness = harness.for_model("launch");
    let result = runtime
        .execute(
            "Bash",
            json!({"command":"sleep 10","run_in_background":true,"timeout":20}),
            context,
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], false, "{result}");
    let id = result["metadata"]["task_id"].as_str().unwrap();
    let consume = harness.for_model("consume");
    let task = runtime
        .tool_context_async_call_with_harness(
            "backgroundTasks.wait",
            json!([id]),
            &CancellationToken::new(),
            consume.clone(),
        )
        .await
        .unwrap();
    assert_eq!(task["error"], "consume timeout 20");
    let launch = runtime
        .tool_context_call_with_harness(
            "backgroundTasks.get",
            json!([id]),
            &harness.for_model("launch"),
        )
        .unwrap();
    assert_eq!(launch["error"], "launch timeout 20");
    runtime.set_harness(consume);
    let notices = runtime.drain_background_notices().await;
    assert_eq!(notices.len(), 1);
    assert!(notices[0].contains("consume timeout 20"), "{}", notices[0]);
    runtime.close().await.unwrap();
}
#[tokio::test]
async fn mcp_connection_errors_are_rendered_after_model_selection() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options["mcpServers"] = json!({"fixture":{"type":"unavailable-transport"}});
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    let harness = Harness::from_config(&json!({"models":{"a":{"tools.mcp.unsupported_transport":"Transport A"},"b":{"tools.mcp.unsupported_transport":"Transport B"}}})).unwrap();
    runtime.set_harness(harness.for_model("a"));
    assert_eq!(runtime.mcp_statuses()[0]["error"], "Transport A");
    runtime.set_harness(harness.for_model("b"));
    assert_eq!(runtime.mcp_statuses()[0]["error"], "Transport B");
    runtime.close().await.unwrap();
}
fn supplied_builtin(name: &str, implementation: &str) -> Value {
    let definitions = crate::harness::baseline().resource(ResourceId::ToolDefinitions);
    let definition = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == implementation)
        .unwrap();
    json!({"name":name,"description":definition["description"],"inputSchema":definition["input_schema"],"permissionLevel":"none","__haloSdkNativeTool":{"name":implementation}})
}
#[tokio::test]
async fn supplied_tool_pool_keeps_order_and_state_without_implicit_tools_or_connections() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path.join("file"), "before").unwrap();
    let mut options = fixture.options();
    options["nativeSuppliedTools"] = json!([]);
    options["mcpServers"] = json!({"must_not_start":{"command":"/missing/fixture/executable"}});
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    assert!(runtime.definitions().is_empty());
    assert!(runtime.mcp_statuses().is_empty());
    assert_eq!(
        runtime
            .execute("Read", json!({"file_path":"file"}), fixture.context())
            .await
            .unwrap()["isError"],
        true
    );
    let source = json!({"server":"fixture","name":"foreign","instructions":"opaque {body}"});
    runtime.replace_supplied_tools(vec![
        json!({"name":"Foreign","description":"external","inputSchema":{"type":"object"},"mcpSource":source}),
        supplied_builtin("Alias", "Read"),
        supplied_builtin("Alias", "Write"),
    ]).unwrap();
    assert_eq!(
        runtime
            .definitions()
            .iter()
            .map(|tool| tool["name"].clone())
            .collect::<Vec<_>>(),
        vec![json!("Foreign"), json!("Alias"), json!("Alias")]
    );
    assert_eq!(runtime.catalog_tools()[0]["mcpSource"], source);
    let read = runtime
        .execute("Alias", json!({"file_path":"file"}), fixture.context())
        .await
        .unwrap();
    assert_eq!(read["content"], "1\tbefore\n");
    assert!(runtime.is_concurrency_safe("Alias", &json!({})));
    runtime.set_goal(json!({"objective":"retained"})).unwrap();
    let revision = runtime.tool_catalog_revision();
    runtime
        .replace_supplied_tools(vec![supplied_builtin("Alias", "Write")])
        .unwrap();
    assert!(runtime.tool_catalog_revision() > revision);
    assert_eq!(runtime.get_goal()["objective"], "retained");
    assert_eq!(
        runtime
            .execute(
                "Alias",
                json!({"file_path":"file","content":"after"}),
                fixture.context()
            )
            .await
            .unwrap()["isError"],
        false
    );
    assert_eq!(
        std::fs::read_to_string(fixture.path.join("file")).unwrap(),
        "after"
    );
    assert!(runtime
        .replace_supplied_tools(vec![
            json!({"name":"broken","__haloSdkNativeTool":{"name":"missing"}})
        ])
        .is_err());
    assert_eq!(runtime.definitions()[0]["name"], "Alias");
    runtime.replace_supplied_tools(vec![]).unwrap();
    assert!(runtime.definitions().is_empty());
    runtime.close().await.unwrap();
}
#[tokio::test]
async fn external_read_state_is_authoritative_and_write_observers_see_its_committed_entry() {
    let fixture = Fixture::new();
    let bridge = Arc::new(ExternalReads {
        mutation_after_write: true,
        ..Default::default()
    });
    let mut options = fixture.options();
    options["nativeOwner"] = json!({"externalReadFileState":true,"recordFileChange":{"__haloSdkNativeCallback":"record"}});
    let mut runtime = ToolRuntime::new(options, bridge.clone(), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    let path = fixture.path.join("file");
    let written = runtime
        .execute(
            "Write",
            json!({"file_path":path,"content":"written"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(written["isError"], false);
    assert_eq!(bridge.writes.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert_eq!(
        bridge.values.lock().unwrap()[path.to_str().unwrap()]["timestamp"],
        0,
        "finalization must not overwrite an observer's mutation of the external Map"
    );
    let refused = runtime
        .execute(
            "Write",
            json!({"file_path":path,"content":"later"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(refused["isError"], true);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "written");
    bridge.values.lock().unwrap().clear();
    let refused = runtime
        .execute(
            "Edit",
            json!({"file_path":path,"old_string":"written","new_string":"later"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(refused["isError"], true);
    assert!(refused["content"]
        .as_str()
        .unwrap()
        .contains("recorded Read"));
    runtime
        .execute("Read", json!({ "file_path": path }), fixture.context())
        .await
        .unwrap();
    assert!(bridge
        .values
        .lock()
        .unwrap()
        .contains_key(path.to_str().unwrap()));
    let shared = runtime.shared_read_state();
    runtime.close().await.unwrap();
    drop(runtime);
    assert!(shared
        .context_call("readFileState.has", &json!([path]))
        .unwrap()
        .as_bool()
        .unwrap());
}
#[tokio::test]
async fn file_read_edit_and_stale_write_preserve_effects() {
    let f = Fixture::new();
    let r = runtime(&f).await;
    let path = f.path.join("file.txt");
    std::fs::write(&path, "first\nsecond\n").unwrap();
    let refused = r
        .execute(
            "Write",
            json!({"file_path":"file.txt","content":"lost"}),
            f.context(),
        )
        .await
        .unwrap();
    assert_eq!(refused["isError"], true);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
    let read = r
        .execute("Read", json!({"file_path":"file.txt"}), f.context())
        .await
        .unwrap();
    assert_eq!(read["content"], "1\tfirst\n2\tsecond\n3\t\n");
    let edit = r
        .execute(
            "Edit",
            json!({"file_path":"file.txt","old_string":"second","new_string":"updated"}),
            f.context(),
        )
        .await
        .unwrap();
    assert_eq!(edit["isError"], false);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nupdated\n");
    std::fs::write(&path, "external writer").unwrap();
    let write = r
        .execute(
            "Write",
            json!({"file_path":"file.txt","content":"overwrite"}),
            f.context(),
        )
        .await
        .unwrap();
    assert_eq!(write["isError"], true);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "external writer");
    r.close().await.unwrap();
}
#[tokio::test]
async fn low_level_file_change_callback_observes_effects_and_revokes_changed_edit_state() {
    let fixture = Fixture::new();
    let bridge = Arc::new(FileChanges {
        records: std::sync::Mutex::new(Vec::new()),
        rewrite_after_edit: true,
    });
    let mut options = fixture.options();
    options["nativeOwner"] = json!({"recordFileChange":{"__haloSdkNativeCallback":"file-change"}});
    let mut runtime = ToolRuntime::new(options, bridge.clone(), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    let created = runtime
        .execute(
            "Write",
            json!({"file_path":"file.txt","content":"before"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(created["isError"], false);
    let edited = runtime
        .execute(
            "Edit",
            json!({"file_path":"file.txt","old_string":"before","new_string":"after"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(edited["isError"], false);
    assert!(edited["content"].as_str().unwrap().ends_with(
        " Note: the file changed again after this edit. Re-read it before further changes."
    ));
    let records = bridge.records.lock().unwrap().clone();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["before"], "");
    assert_eq!(records[0]["after"], "before");
    assert_eq!(records[1]["before"], "before");
    assert_eq!(records[1]["after"], "after");
    assert_eq!(
        runtime
            .tool_context_call("readFileState.has", json!([fixture.path.join("file.txt")]))
            .unwrap(),
        false
    );
    assert_eq!(
        std::fs::read_to_string(fixture.path.join("file.txt")).unwrap(),
        "changed by callback"
    );
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn shared_working_state_is_authoritative_before_tool_initialization_and_discards_only_its_files(
) {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options["persistSession"] = json!(true);
    options["env"] = json!({"CLAUDE_CONFIG_DIR":fixture.path.join("config")});
    let working = Arc::new(WorkingState::new(&options));
    working
        .set_goal(json!({"objective":"before initialization"}))
        .unwrap();
    let mut runtime = ToolRuntime::new_with_working_state(
        options,
        Arc::new(NoHost),
        Arc::new(NoHost),
        Some(working.clone()),
    );
    assert_eq!(runtime.get_goal()["objective"], "before initialization");
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    runtime
        .execute(
            "Goal",
            json!({"action":"update","objective":"shared updated"}),
            fixture.context(),
        )
        .await
        .unwrap();
    runtime
        .execute(
            "TodoWrite",
            json!({"todos":[{"content":"pending","status":"pending"}]}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(working.get_goal()["objective"], "shared updated");
    let transcript = fixture.path.join("config/test.jsonl");
    std::fs::write(&transcript, "retain transcript").unwrap();
    runtime.close().await.unwrap();
    runtime.discard_persisted_working_state();
    assert!(!fixture.path.join("config/goals/test.json").exists());
    assert!(!fixture.path.join("config/todos/test.json").exists());
    assert_eq!(
        std::fs::read_to_string(transcript).unwrap(),
        "retain transcript"
    );
}
#[tokio::test]
async fn partial_read_allows_targeted_edit_but_not_replacement() {
    let f = Fixture::new();
    let r = runtime(&f).await;
    std::fs::write(f.path.join("file.txt"), "one\ntwo\nthree").unwrap();
    let read = r
        .execute(
            "Read",
            json!({"file_path":"file.txt","limit":1}),
            f.context(),
        )
        .await
        .unwrap();
    assert!(read["content"].as_str().unwrap().contains("Use offset=2"));
    assert_eq!(
        r.execute(
            "Edit",
            json!({"file_path":"file.txt","old_string":"one","new_string":"ONE"}),
            f.context()
        )
        .await
        .unwrap()["isError"],
        false
    );
    assert_eq!(
        r.execute(
            "Write",
            json!({"file_path":"file.txt","content":"bad"}),
            f.context()
        )
        .await
        .unwrap()["isError"],
        true
    );
    r.close().await.unwrap();
}
#[tokio::test]
async fn file_pagination_and_bounded_reads_match_javascript_numbers() {
    let fixture = Fixture::new();
    let runtime = runtime(&fixture).await;
    std::fs::write(fixture.path.join("text"), "one\ntwo\nthree").unwrap();
    let input: Value =
        serde_json::from_str(r#"{"file_path":"text","offset":2.0,"limit":1.0}"#).unwrap();
    let output = runtime
        .execute("Read", input, fixture.context())
        .await
        .unwrap();
    assert_eq!(
        output["content"],
        "2\ttwo\n\n... (showing lines 2-2 of 3. Use offset=3 to continue reading.)\n"
    );
    for value in [
        json!(-1),
        json!(1.5),
        json!(9007199254740992u64),
        json!("1"),
        Value::Null,
    ] {
        let output = runtime
            .execute(
                "Read",
                json!({"file_path":"text", "offset":value}),
                fixture.context(),
            )
            .await
            .unwrap();
        assert_eq!(output["content"], "offset must be a nonnegative integer");
    }
    let large = fixture.path.join("large");
    std::fs::File::create(&large)
        .unwrap()
        .set_len(8 * 1024 * 1024 + 1)
        .unwrap();
    let output = runtime
        .execute("Read", json!({"file_path":"large"}), fixture.context())
        .await
        .unwrap();
    assert_eq!(output["content"], format!("Failed to read file {}: File exceeds the 8388608 byte read limit. Use a streaming command to select a smaller portion.", large.display()));
    std::fs::write(fixture.path.join("empty"), "").unwrap();
    runtime
        .execute(
            "Read",
            json!({"file_path":"empty","offset":0,"limit":2}),
            fixture.context(),
        )
        .await
        .unwrap();
    let state = runtime
        .tool_context_call("readFileState.get", json!([fixture.path.join("empty")]))
        .unwrap();
    assert_eq!(state["offset"], 0);
    assert_eq!(state["limit"], 2);
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn notebook_read_state_and_pdf_page_selection_preserve_contract() {
    let fixture = Fixture::new();
    let runtime = runtime(&fixture).await;
    let notebook = json!({"cells":[{"cell_type":"code","source":["print(1)"],"outputs":[{"text":"","data":{"text/plain":["1"]}}]}]});
    let path = fixture.path.join("notebook.ipynb");
    std::fs::write(&path, notebook.to_string()).unwrap();
    let output = runtime
        .execute("Read", json!({ "file_path": path }), fixture.context())
        .await
        .unwrap();
    assert_eq!(
        output["content"],
        "[Cell 0] (code):\nprint(1)\n[Output]:\n1\n"
    );
    let state = runtime
        .tool_context_call("readFileState.get", json!([path]))
        .unwrap();
    assert_eq!(state["content"], output["content"]);
    assert_eq!(state["isPartialView"], true);
    std::fs::write(fixture.path.join("document.pdf"), b"%PDF fixture").unwrap();
    for pages in ["+2", "1-+2", "1-2-3", "1 - 0", "1\u{0085}-2"] {
        let output = runtime
            .execute(
                "Read",
                json!({"file_path":"document.pdf","pages":pages}),
                fixture.context(),
            )
            .await
            .unwrap();
        assert_eq!(output["isError"], true, "{pages}");
    }
    let output = runtime
        .execute(
            "Read",
            json!({"file_path":"document.pdf","pages":"\u{feff}2 \u{a0}-\u{a0} 4\u{feff}"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(output["content"]
        .as_str()
        .unwrap()
        .contains("Requested pages: 2-4."));
    runtime.close().await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn bash_retains_cwd_and_exported_environment_per_session() {
    let f = Fixture::new();
    std::fs::create_dir(f.path.join("nested")).unwrap();
    let r = runtime(&f).await;
    let result=r.execute("Bash",json!({"command":"cd nested\nexport SDK_TOOL_TEST='kept value'\nprintf first > artifact.txt"}),f.context()).await.unwrap();
    assert_eq!(result["isError"], false, "{result}");
    let result = r
        .execute(
            "Bash",
            json!({"command":"printf '%s\\n' \"$SDK_TOOL_TEST\"\ncat artifact.txt"}),
            f.context(),
        )
        .await
        .unwrap();
    assert_eq!(result["content"], "kept value\nfirst");
    assert_eq!(
        std::fs::read_to_string(f.path.join("nested/artifact.txt")).unwrap(),
        "first"
    );
    let independent = runtime(&f).await;
    let result = independent
        .execute(
            "Bash",
            json!({"command":"printf '%s' \"${SDK_TOOL_TEST-unset}\""}),
            f.context(),
        )
        .await
        .unwrap();
    assert_eq!(result["content"], "unset");
    independent.close().await.unwrap();
    r.close().await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn background_command_records_actual_output() {
    let f = Fixture::new();
    let r = runtime(&f).await;
    let result = r
        .execute(
            "Bash",
            json!({"command":"printf 'background result'","run_in_background":true}),
            f.context(),
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], false, "{result}");
    let id = result["metadata"]["task_id"].clone();
    let result = r
        .execute(
            "TaskOutput",
            json!({"task_id":id,"timeout":2000}),
            f.context(),
        )
        .await
        .unwrap();
    let parsed: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    assert_eq!(parsed["retrieval_status"], "success");
    assert_eq!(parsed["task"]["result"], "background result");
    assert_eq!(parsed["task"]["exit_code"], 0);
    r.close().await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn shell_deadline_covers_descendant_pipes_after_parent_exit() {
    let fixture = Fixture::new();
    let runtime = runtime(&fixture).await;
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime.execute(
            "Bash",
            json!({"command":"printf before; sleep 30 & exit 0","timeout":30}),
            fixture.context(),
        ),
    )
    .await
    .expect("descendant pipes must remain covered by the deadline")
    .unwrap();
    assert_eq!(result["isError"], true);
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("Command timed out after 30ms and was terminated.\nbefore"));
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    runtime.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn background_registry_context_shares_metadata_output_and_shutdown() {
    let fixture = Fixture::new();
    let runtime = runtime(&fixture).await;
    let cancel = CancellationToken::new();
    let task = runtime.tool_context_async_call("backgroundTasks.start", json!([{"command":"printf '%s' \"$NATIVE_BACKGROUND_TEST\"; sleep 30", "state":{"cwd":fixture.path,"envVars":[["NATIVE_BACKGROUND_TEST","shared registry"]]},"env":{"AGENT_SHELL":"/bin/bash"}}]), &cancel).await.unwrap();
    let id = task["id"].as_str().unwrap();
    assert_eq!(task["status"], "running");
    assert_eq!(
        runtime
            .tool_context_call("backgroundTasks.activeCount", json!([]))
            .unwrap(),
        1
    );
    assert_eq!(
        runtime
            .tool_context_call("backgroundTasks.getAll", json!([]))
            .unwrap()[0]["id"],
        id
    );
    assert_eq!(
        runtime
            .tool_context_call("backgroundTasks.stop", json!([id]))
            .unwrap(),
        true
    );
    runtime
        .tool_context_async_call("backgroundTasks.wait", json!([id]), &cancel)
        .await
        .unwrap();
    let task = runtime
        .tool_context_call("backgroundTasks.get", json!([id]))
        .unwrap();
    assert_eq!(task["status"], "stopped");
    assert_eq!(task["error"], "Stopped by request");
    assert!(task["completedAt"].as_i64().is_some());
    let output = runtime
        .tool_context_async_call("backgroundTasks.readOutput", json!([task]), &cancel)
        .await
        .unwrap();
    assert_eq!(output["truncated"], false);
    runtime
        .tool_context_call("backgroundTasks.dispose", json!([]))
        .unwrap();
    runtime
        .tool_context_async_call("backgroundTasks.flush", json!([]), &cancel)
        .await
        .unwrap();
    assert_eq!(
        runtime
            .tool_context_call("backgroundTasks.getAll", json!([]))
            .unwrap(),
        json!([])
    );
    assert!(!std::path::Path::new(task["outputFile"].as_str().unwrap()).exists());
    runtime.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn background_timeout_terminates_ignoring_children_and_retains_persistent_output() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options["persistSession"] = json!(true);
    options["env"] = json!({"CLAUDE_CONFIG_DIR":fixture.path.join("config")});
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    let launched = runtime.execute("Bash", json!({"command":"printf saved; trap '' TERM; sleep 30","run_in_background":true,"timeout":100}), fixture.context()).await.unwrap();
    let id = &launched["metadata"]["task_id"];
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime.execute("TaskOutput", json!({ "task_id": id }), fixture.context()),
    )
    .await
    .expect("background timeouts must terminate the group immediately")
    .unwrap();
    let parsed: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    assert_eq!(parsed["task"]["status"], "failed");
    assert_eq!(parsed["task"]["error"], "Timed out after 100ms");
    assert_eq!(parsed["task"]["result"], "saved");
    let path = std::path::PathBuf::from(launched["metadata"]["output_file"].as_str().unwrap());
    assert!(std::path::Path::new(&format!("{}.done", path.display())).exists());
    assert!(!std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".active-")));
    runtime.close().await.unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "saved");
}
#[cfg(unix)]
#[tokio::test]
async fn synchronous_abort_terminates_owned_shell_groups_without_stopping_other_sessions() {
    let fixture = Fixture::new();
    let runtime = runtime(&fixture).await;
    let other = super::tests::runtime(&fixture).await;
    let launched = runtime
        .execute(
            "Bash",
            json!({"command":"trap '' TERM; sleep 30","run_in_background":true}),
            fixture.context(),
        )
        .await
        .unwrap();
    let sibling = other
        .execute(
            "Bash",
            json!({"command":"sleep 30","run_in_background":true}),
            fixture.context(),
        )
        .await
        .unwrap();
    let task = runtime
        .tool_context_call(
            "backgroundTasks.get",
            json!([launched["metadata"]["task_id"]]),
        )
        .unwrap();
    let sibling = other
        .tool_context_call(
            "backgroundTasks.get",
            json!([sibling["metadata"]["task_id"]]),
        )
        .unwrap();
    runtime.abort_now();
    runtime.abort_now();
    let closed = tokio::time::timeout(std::time::Duration::from_secs(2), runtime.close()).await;
    if closed.is_err() {
        let group = std::process::Command::new("ps")
            .args(["-o", "pid,ppid,pgid,state", "-g", &task["pid"].to_string()])
            .output()
            .unwrap();
        eprintln!(
            "owned task at close deadline: {}; group: {}",
            runtime
                .tool_context_call(
                    "backgroundTasks.get",
                    json!([launched["metadata"]["task_id"]])
                )
                .unwrap(),
            String::from_utf8_lossy(&group.stdout)
        );
    }
    closed.unwrap().unwrap();
    unsafe {
        assert_eq!(libc::kill(task["pid"].as_u64().unwrap() as i32, 0), -1);
        assert_eq!(libc::kill(sibling["pid"].as_u64().unwrap() as i32, 0), 0);
    }
    other.close().await.unwrap();
}
#[tokio::test]
async fn skill_body_is_loaded_and_substituted_once() {
    let f = Fixture::new();
    let path = f.path.join("SKILL.md");
    std::fs::write(
        &path,
        "---\ndescription: A local fixture\n---\nRead $ARGUMENTS. Details$ARGUMENTS_SUFFIX",
    )
    .unwrap();
    let mut options = f.options();
    options["skillCatalog"] = json!([{"name":"fixture","description":"exact supplied metadata","source":{"kind":"file","path":path}}]);
    let mut r = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    r.initialize(&CancellationToken::new()).await.unwrap();
    let result = r
        .execute(
            "Skill",
            json!({"skill":"fixture","args":"$ARGUMENTS"}),
            f.context(),
        )
        .await
        .unwrap();
    assert_eq!(result["content"], "Read $ARGUMENTS. Details: $ARGUMENTS");
    assert_eq!(result["metadata"]["skill"]["name"], "fixture");
    r.close().await.unwrap();
}
#[tokio::test]
async fn disabled_skill_has_no_catalog_but_explicit_invalid_catalog_still_rejects() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options.as_object_mut().unwrap().remove("skillCatalog");
    options["tools"] = json!([]);
    let mut runtime = ToolRuntime::new(options.clone(), Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    assert_eq!(runtime.skill_catalog(), &json!([]));
    runtime.close().await.unwrap();
    options["skillCatalog"] = json!([{"name":"../invalid"}]);
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    assert!(runtime.initialize(&CancellationToken::new()).await.is_err());
    runtime.close().await.unwrap();
}
#[tokio::test]
async fn read_denial_resolves_directory_symlinks() {
    let f = Fixture::new();
    let private = f.path.join("private");
    std::fs::create_dir(&private).unwrap();
    std::fs::write(private.join("secret"), "test fixture").unwrap();
    let mut options = f.options();
    options["disallowedTools"] = json!(["Read(private/**)"]);
    let mut r = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    r.initialize(&CancellationToken::new()).await.unwrap();
    let result = r
        .execute("Read", json!({"file_path":"private/secret"}), f.context())
        .await
        .unwrap();
    assert_eq!(result["isError"], true);
    assert!(!result["content"].as_str().unwrap().contains("test fixture"));
    r.close().await.unwrap();
}
#[tokio::test]
async fn glob_preserves_depth_first_order_for_equal_millisecond_timestamps() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.path.join("a")).unwrap();
    std::fs::create_dir(fixture.path.join("node_modules")).unwrap();
    let paths = [
        fixture.path.join("a/first.txt"),
        fixture.path.join("z.txt"),
        fixture.path.join("node_modules/skip.txt"),
    ];
    let time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    for path in &paths {
        std::fs::write(path, "fixture").unwrap();
        std::fs::File::open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(time))
            .unwrap();
    }
    let runtime = runtime(&fixture).await;
    let result = runtime
        .execute("Glob", json!({"pattern":"**/*.txt"}), fixture.context())
        .await
        .unwrap();
    assert_eq!(
        result["content"],
        format!("{}\n{}\n", paths[0].display(), paths[1].display())
    );
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn grep_respects_literal_denied_paths_and_javascript_numeric_pagination() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.path.join("private[1]")).unwrap();
    std::fs::write(
        fixture.path.join("private[1]/secret.txt"),
        "needle hidden\n",
    )
    .unwrap();
    std::fs::write(
        fixture.path.join("visible.txt"),
        "needle first\nneedle second\nneedle third\n",
    )
    .unwrap();
    let mut options = fixture.options();
    options["nativeReadDenyRoots"] = json!([fixture.path.join("private[1]")]);
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    let mut context = fixture.context();
    context.env["AGENT_RIPGREP_PATH"] = json!("relative-override-is-ignored");
    let input: Value = serde_json::from_str(
        r#"{"pattern":"needle","output_mode":"content","offset":1.0,"head_limit":1.0}"#,
    )
    .unwrap();
    let result = runtime.execute("Grep", input, context).await.unwrap();
    assert_eq!(result["isError"], false, "{result}");
    let text = result["content"].as_str().unwrap();
    assert!(text.contains("visible.txt:2:needle second"));
    assert!(text.contains("[Showing lines 2-2 of 3 matching lines."));
    assert!(!text.contains("hidden"));
    let invalid = runtime
        .execute(
            "Grep",
            json!({"pattern":"[","output_mode":"content"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(invalid["content"]
        .as_str()
        .unwrap()
        .starts_with("Grep failed: rg exit code 2: "));
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn stdio_mcp_executes_and_preserves_uncertain_non_idempotent_effect() {
    let fixture = Fixture::new();
    let script = fixture.path.join("mcp-fixture.cjs");
    let effects = fixture.path.join("effects.json");
    std::fs::write(&script, r#"
const fs = require('node:fs');
const readline = require('node:readline');
const effectFile = process.argv[2];
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  let result;
  if (request.method === 'initialize') result = {capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}};
  if (request.method === 'tools/list') result = {tools: [{name:'write_effect', description:'Write a local fixture effect', inputSchema:{type:'object', properties:{text:{type:'string'}},required:['text']}}]};
  if (request.method === 'tools/call') {
    const records = fs.existsSync(effectFile) ? JSON.parse(fs.readFileSync(effectFile,'utf8')) : [];
    records.push(request.params.arguments.text);
    fs.writeFileSync(effectFile,JSON.stringify(records));
    if (records.length === 1) process.exit(0);
    result = {content:[{type:'text',text:fs.readFileSync(effectFile,'utf8')}]};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
"#).unwrap();
    let mut options = fixture.options();
    options["mcpServers"] =
        json!({"fixture":{"type":"stdio","command":"node","args":[script,effects]}});
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    assert_eq!(runtime.mcp_statuses()[0]["status"], "connected");
    let definition = runtime
        .definitions()
        .into_iter()
        .find(|d| d["name"] == "mcp__fixture__write_effect")
        .unwrap();
    let result = runtime
        .execute_with_definition(
            "mcp__fixture__write_effect",
            json!({"text":"first"}),
            fixture.context(),
            &definition,
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], true, "{result}");
    assert!(
        result["content"]
            .as_str()
            .unwrap()
            .contains("This operation was not replayed"),
        "{result}"
    );
    assert_eq!(std::fs::read_to_string(&effects).unwrap(), "[\"first\"]");
    let result = runtime
        .execute_with_definition(
            "mcp__fixture__write_effect",
            json!({"text":"second"}),
            fixture.context(),
            &definition,
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(
        std::fs::read_to_string(&effects).unwrap(),
        "[\"first\",\"second\"]"
    );
    runtime.close().await.unwrap();
}
#[tokio::test]
async fn sdk_mcp_serialized_descriptor_has_no_instance_and_uses_host_bridge() {
    let fixture = Fixture::new();
    let path = fixture.path.join("host-effect");
    let mut options = fixture.options();
    options["tools"] = json!([]);
    options["mcpServers"] = json!({"configured/key":{"type":"sdk","name":"service/name","description":"service details","instructions":"service usage","tools":[{"name":"write/result","description":"Write result","inputSchema":{"type":"object","properties":{"value":{"type":"string"}}}}]}});
    let mut runtime = ToolRuntime::new(
        options,
        Arc::new(HostedMcp { path: path.clone() }),
        Arc::new(NoHost),
    );
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    let definitions = runtime.catalog_tools();
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0]["name"], "mcp__service_name__write_result");
    assert_eq!(
        definitions[0]["mcpSource"],
        json!({"server":"configured/key","name":"write/result","toolDescription":"Write result","description":"service details","instructions":"service usage"})
    );
    let output = runtime
        .execute(
            "mcp__service_name__write_result",
            json!({"value":"effect"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(output["content"], "written through host");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "effect");
    let replaced = runtime
        .set_mcp_servers(json!({}), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(replaced, json!({"added":[],"removed":[],"errors":{}}));
    assert_eq!(runtime.catalog_tools(), definitions);
    assert!(runtime
        .toggle_mcp("configured/key", false, &CancellationToken::new())
        .await
        .unwrap_err()
        .message
        .contains("is not registered"));
    assert!(runtime
        .reconnect_mcp("configured/key", &CancellationToken::new())
        .await
        .unwrap_err()
        .message
        .starts_with("Unknown MCP server:"));
    let output = runtime
        .execute(
            "mcp__service_name__write_result",
            json!({"value":"still hosted"}),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(output["isError"], false);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "still hosted");
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn mcp_changed_definition_refuses_a_stale_request() {
    let fixture = Fixture::new();
    let script = fixture.path.join("catalog-fixture.cjs");
    let schema = fixture.path.join("definition.txt");
    std::fs::write(&schema, "first description").unwrap();
    std::fs::write(&script,r#"
const fs=require('node:fs'); const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(!('id'in request))return;
 let result={};
 if(request.method==='initialize')result={capabilities:{tools:{}},serverInfo:{name:'catalog',version:'1'}};
 if(request.method==='tools/list')result={tools:[{name:'read',description:fs.readFileSync(process.argv[2],'utf8'),inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]};
 if(request.method==='tools/call'){fs.writeFileSync(process.argv[3],'executed');result={content:[{type:'text',text:'executed'}]};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
"#).unwrap();
    let effect = fixture.path.join("effect");
    let mut options = fixture.options();
    options["mcpServers"] =
        json!({"catalog":{"type":"stdio","command":"node","args":[script,schema,effect]}});
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    let before = runtime.tool_catalog_revision();
    let definition = runtime
        .definitions()
        .into_iter()
        .find(|d| d["name"] == "mcp__catalog__read")
        .unwrap();
    std::fs::write(&schema, "changed description").unwrap();
    runtime
        .reconnect_mcp("catalog", &CancellationToken::new())
        .await
        .unwrap();
    assert!(runtime.tool_catalog_revision() > before);
    let result = runtime
        .execute_with_definition(
            "mcp__catalog__read",
            json!({}),
            fixture.context(),
            &definition,
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], true);
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("The stale call was not executed."));
    assert!(!effect.exists());
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn public_mcp_preparation_cannot_reopen_after_synchronous_close() {
    let fixture = Fixture::new();
    let script = fixture.path.join("startup.cjs");
    let starts = fixture.path.join("starts");
    std::fs::write(&script,r#"const fs=require('node:fs'),readline=require('node:readline');fs.appendFileSync(process.argv[2],'start\n');readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-1,message:'fixture rejected'}})+'\n');});"#).unwrap();
    let config = json!({"type":"stdio","command":"node","args":[script,starts]});
    let transport = Arc::new(mcp::public_transport::PublicTransport::new(
        config.clone(),
        fixture.options(),
        Arc::new(NoHost),
    ));
    let opening = transport.prepare_connect();
    transport.close().unwrap();
    assert!(opening.await.is_err());
    assert!(!transport.connected());
    assert!(!starts.exists());
    let manager = mcp::McpTools::from_configs(
        &json!({ "fixture": config }),
        fixture.options(),
        Arc::new(NoHost),
    )
    .unwrap();
    let opening = manager.prepare_connect_server("fixture").unwrap();
    assert_eq!(
        manager.live_status("fixture", &crate::harness::baseline())["state"],
        "connecting"
    );
    manager.disconnect_all();
    assert!(opening.await.unwrap_err().message.contains("cancelled"));
    manager.when_settled().await;
    assert!(!manager.is_connected("fixture"));
    assert!(!starts.exists());
    let manager = mcp::McpTools::from_configs(
        &json!({ "fixture": config }),
        fixture.options(),
        Arc::new(NoHost),
    )
    .unwrap();
    let first = manager.prepare_connect_server("fixture").unwrap();
    let second = manager.prepare_connect_server("fixture").unwrap();
    let (first, second) = tokio::join!(first, second);
    assert_eq!(
        first.unwrap_err().message,
        "MCP initialize failed for \"fixture\": fixture rejected"
    );
    assert_eq!(
        second.unwrap_err().message,
        "MCP initialize failed for \"fixture\": fixture rejected"
    );
    assert_eq!(std::fs::read_to_string(&starts).unwrap(), "start\n");
    manager.disconnect_all();
    manager.when_settled().await;
}

struct ElicitingHost;
#[cfg(unix)]
#[tokio::test]
async fn logical_mcp_close_preserves_owned_reaping_without_waiting_for_stdio_grace(){
    let fixture=Fixture::new();let script=fixture.path.join("mcp-retirement.cjs");
    std::fs::write(&script,r#"const readline=require('node:readline');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id===undefined)return;const result=request.method==='initialize'?{capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');});"#).unwrap();
    let mut options=fixture.options();options["mcpServers"]=json!({"fixture":{"command":"node","args":[script]}});
    let mut retiring=ToolRuntime::new(options,Arc::new(NoHost),Arc::new(NoHost));retiring.initialize(&CancellationToken::new()).await.unwrap();assert_eq!(retiring.owned_process_count(),1);
    let sibling=runtime(&fixture).await;let launched=sibling.execute("Bash",json!({"command":"sleep 30","run_in_background":true}),fixture.context()).await.unwrap();let child=sibling.tool_context_call("backgroundTasks.get",json!([launched["metadata"]["task_id"]])).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1),retiring.close()).await.expect("logical close must not wait for the five-second stdio grace").unwrap();
    let resources=retiring.process_retirement();assert_eq!(resources.count(),1);assert!(!resources.is_settled());
    tokio::time::timeout(std::time::Duration::from_secs(2),resources.force_reap()).await.unwrap().unwrap();assert_eq!(resources.count(),0);assert!(resources.is_settled());
    unsafe{assert_eq!(libc::kill(child["pid"].as_u64().unwrap() as i32,0),0);}
    sibling.close().await.unwrap();
}
#[async_trait]
impl HostBridge for ElicitingHost {
    async fn call(
        &self,
        method: &str,
        params: Value,
        _cancel: &CancellationToken,
    ) -> Result<Value> {
        assert_eq!(method, "callback");
        assert_eq!(params["callbackId"], "elicit-fixture");
        assert_eq!(params["args"][0]["serverName"], "remote");
        assert_eq!(params["args"][0]["message"], "Choose fixture value");
        Ok(json!({"action":"accept","content":{"value":"native approval"}}))
    }
}

struct RawRequestHost;
#[async_trait]
impl HostBridge for RawRequestHost {
    async fn call(&self, method: &str, params: Value, _: &CancellationToken) -> Result<Value> {
        assert_eq!(method, "mcp.transport.request");
        assert_eq!(params["callbackId"], "raw-request");
        assert_eq!(params["hasParams"],true);
        assert_eq!(params["params"], json!({"value":42}));
        Ok(json!({"value":{"accepted":42}}))
    }
}
#[tokio::test]
async fn selected_mcp_tools_keep_owner_identity_when_equal_definitions_are_replaced() {
    let fixture = Fixture::new();
    let script = fixture.path.join("selected-mcp.cjs");
    std::fs::write(&script,r#"
const fs=require('node:fs'),readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(!('id' in request))return;let result;
 if(request.method==='initialize')result={capabilities:{tools:{}},serverInfo:{name:'same',version:'1'}};
 if(request.method==='tools/list')result={tools:[{name:'write',description:'same declaration',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};
 if(request.method==='tools/call'){fs.appendFileSync(process.argv[2],'called\n');result={content:[{type:'text',text:'recorded'}]};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
"#).unwrap();
    let first = fixture.path.join("first-effect");
    let second = fixture.path.join("second-effect");
    let configuration =
        |path: &PathBuf| json!({"selected":{"type":"stdio","command":"node","args":[script,path]}});
    let mut options = fixture.options();
    options["mcpServers"] = configuration(&first);
    let mut runtime = ToolRuntime::new(options, Arc::new(NoHost), Arc::new(NoHost));
    runtime.initialize(&CancellationToken::new()).await.unwrap();
    assert!(
        !runtime.is_concurrency_safe("mcp__selected__write", &json!({})),
        "manager tools preserve the source's exclusive scheduling contract"
    );
    let previous = runtime
        .selected_tools()
        .into_iter()
        .find(|tool| tool.definition["name"] == "mcp__selected__write")
        .unwrap();
    runtime
        .set_mcp_servers(configuration(&second), &CancellationToken::new())
        .await
        .unwrap();
    let current = runtime
        .selected_tools()
        .into_iter()
        .find(|tool| tool.definition["name"] == "mcp__selected__write")
        .unwrap();
    assert_eq!(previous.definition, current.definition);
    let rejected = runtime
        .execute_selected(&previous, json!({}), fixture.context())
        .await
        .unwrap();
    assert_eq!(rejected["isError"], true);
    assert!(rejected["content"]
        .as_str()
        .unwrap()
        .contains("The stale call was not executed."));
    assert!(!first.exists());
    assert!(!second.exists());
    let accepted = runtime
        .execute_selected(&current, json!({}), fixture.context())
        .await
        .unwrap();
    assert_eq!(accepted["isError"], false);
    runtime
        .set_mcp_servers(json!({}), &CancellationToken::new())
        .await
        .unwrap();
    runtime
        .set_mcp_servers(configuration(&second), &CancellationToken::new())
        .await
        .unwrap();
    let replacement = runtime
        .selected_tools()
        .into_iter()
        .find(|tool| tool.definition["name"] == "mcp__selected__write")
        .unwrap();
    assert_eq!(current.definition, replacement.definition);
    assert_eq!(
        runtime
            .execute_selected(&current, json!({}), fixture.context())
            .await
            .unwrap()["isError"],
        true
    );
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "called\n");
    runtime.close().await.unwrap();
}
#[tokio::test]
async fn public_stdio_transport_preserves_raw_responses_handlers_and_graceful_close() {
    let fixture = Fixture::new();
    let script = fixture.path.join("raw-mcp.cjs");
    let log = fixture.path.join("lifecycle");
    std::fs::write(&script,r#"
const fs=require('node:fs'),readline=require('node:readline');const log=process.argv[2];
fs.appendFileSync(log,'start\n');process.on('SIGTERM',()=>{fs.appendFileSync(log,'term\n');process.exit(0);});
let pending;
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);
 if(!request.method&&request.id==='server-request'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:pending,result:request})+'\n');return;}
 if(!('id' in request)){fs.appendFileSync(log,'notify:'+request.params.value+'\n');return;}
 if(request.method==='callback'){pending=request.id;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'server-request',method:'custom/request',params:{value:42}})+'\n');return;}
 const response=request.method==='failure'?{jsonrpc:'2.0',id:request.id,error:{code:-987,message:'external message',data:{kept:true}}}:{jsonrpc:'2.0',id:request.id,result:request};
 process.stdout.write(JSON.stringify(response)+'\n');
});
"#).unwrap();
    let transport = mcp::public_transport::PublicTransport::new(
        json!({"type":"stdio","command":"node","args":[script,log]}),
        fixture.options(),
        Arc::new(RawRequestHost),
    );
    transport.set_request_handler("custom/request".into(), "raw-request".into());
    assert!(!transport.connected());
    assert_eq!(
        transport
            .send(
                json!({"jsonrpc":"2.0","id":1,"method":"echo"}),
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .message,
        "Stdio transport not connected"
    );
    let (first, second) = tokio::join!(transport.connect(), transport.connect());
    first.unwrap();
    second.unwrap();
    let request = json!({"jsonrpc":"2.0","id":-5.5,"method":"echo","params":{"opaque":"value"}});
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let response = transport.send(request.clone(), &cancelled).await.unwrap();
    assert_eq!(
        response,
        json!({"jsonrpc":"2.0","id":-5.5,"result":request})
    );
    let failure = transport
        .send(
            json!({"jsonrpc":"2.0","id":0,"method":"failure"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        failure,
        json!({"jsonrpc":"2.0","id":0,"error":{"code":-987,"message":"external message","data":{"kept":true}}})
    );
    let response = transport
        .send(
            json!({"jsonrpc":"2.0","id":8,"method":"callback"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response["result"],
        json!({"jsonrpc":"2.0","id":"server-request","result":{"accepted":42}})
    );
    transport
        .notify(json!({"jsonrpc":"2.0","method":"notification","params":{"value":"saved"}}))
        .await
        .unwrap();
    transport
        .send(
            json!({"jsonrpc":"2.0","id":9,"method":"echo"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    transport.close().unwrap();
    assert!(!transport.connected());
    transport.when_closed().await;
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        "start\nnotify:saved\nterm\n"
    );
}
#[tokio::test]
async fn external_sse_and_http_execute_real_tools_and_elicitation() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let fixture = Fixture::new();
    let script = fixture.path.join("http-mcp.cjs");
    std::fs::write(&script,r#"
const http=require('node:http'),fs=require('node:fs');
let sse,waiting;
function event(stream,value){stream.write('event: message\ndata: '+JSON.stringify(value)+'\n\n');}
const server=http.createServer((req,res)=>{
 if(req.method==='DELETE'){res.writeHead(200);res.end();return;}
 if(req.method==='GET'){sse=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: endpoint\ndata: /messages\n\n');return;}
 let raw='';req.on('data',data=>raw+=data);req.on('end',()=>{
  const request=JSON.parse(raw);
  const legacy=req.url==='/messages';
  if(!request.method&&request.id==='input-1'){
   fs.writeFileSync(process.argv[2],JSON.stringify(request.result));
   res.writeHead(202);res.end();
   event(waiting.stream,{jsonrpc:'2.0',id:waiting.id,result:{content:[{type:'text',text:fs.readFileSync(process.argv[2],'utf8')}]}});
   if(!waiting.legacy)waiting.stream.end();waiting=null;return;
  }
  if(!('id'in request)){res.writeHead(202);res.end();return;}
  let result;
  if(request.method==='initialize')result={capabilities:{tools:{}},serverInfo:{name:'http-fixture',version:'1'}};
  if(request.method==='tools/list')result={tools:[{name:'ask_and_write',description:'Ask then write a fixture file',inputSchema:{type:'object',properties:{}}}]};
  if(request.method==='tools/call'){
   let stream;if(legacy){res.writeHead(202);res.end();stream=sse;}else{res.writeHead(200,{'content-type':'text/event-stream'});stream=res;}
   waiting={stream,id:request.id,legacy};
   event(stream,{jsonrpc:'2.0',id:'input-1',method:'elicitation/create',params:{message:'Choose fixture value',requestedSchema:{type:'object',properties:{value:{type:'string'}}}}});return;
  }
  const response={jsonrpc:'2.0',id:request.id,result};
  if(legacy){res.writeHead(202);res.end();event(sse,response);}else{res.writeHead(200,{'content-type':'application/json','mcp-session-id':'fixture-session'});res.end(JSON.stringify(response));}
 });
});server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\n'));
"#).unwrap();
    for kind in ["sse", "http"] {
        let effect = fixture.path.join(format!("{kind}-effect.json"));
        let mut server = tokio::process::Command::new("node")
            .arg(&script)
            .arg(&effect)
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
        let port = lines.next_line().await.unwrap().unwrap();
        let mut options = fixture.options();
        options["onElicitation"] = json!({"__haloSdkNativeCallback":"elicit-fixture"});
        options["mcpServers"] = json!({"remote":{"type":kind,"url":format!("http://127.0.0.1:{port}/{}",if kind=="sse"{"sse"}else{"mcp"})}});
        let mut runtime = ToolRuntime::new(options, Arc::new(ElicitingHost), Arc::new(NoHost));
        runtime.initialize(&CancellationToken::new()).await.unwrap();
        assert_eq!(runtime.mcp_statuses()[0]["status"], "connected");
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            runtime.execute("mcp__remote__ask_and_write", json!({}), fixture.context()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["isError"], false, "{kind}: {result}");
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(&effect).unwrap()).unwrap();
        assert_eq!(
            saved,
            json!({"action":"accept","content":{"value":"native approval"}})
        );
        runtime.close().await.unwrap();
        server.kill().await.unwrap();
        server.wait().await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn retired_execution_preserves_tool_state_and_background_ownership() {
    let fixture = Fixture::new();
    let runtime = runtime(&fixture).await;
    runtime
        .execute(
            "Write",
            json!({"file_path":"kept.txt","content":"before"}),
            fixture.context(),
        )
        .await
        .unwrap();
    runtime
        .execute(
            "Bash",
            json!({"command":"export TOOL_CHECKPOINT_VALUE='survived'"}),
            fixture.context(),
        )
        .await
        .unwrap();
    runtime
        .set_goal(json!({"objective":"Keep working","doneWhen":["complete fixture"]}))
        .unwrap();
    let launched=runtime.execute("Bash",json!({"command":"sleep 0.1; printf 'completed after retirement'","run_in_background":true}),fixture.context()).await.unwrap();
    let checkpoint = runtime.retire_working_state();
    runtime.close().await.unwrap();
    let mut resumed = ToolRuntime::new(fixture.options(), Arc::new(NoHost), Arc::new(NoHost));
    resumed.restore_working_state(&checkpoint).unwrap();
    resumed.initialize(&CancellationToken::new()).await.unwrap();
    assert_eq!(resumed.get_goal()["objective"], "Keep working");
    assert_eq!(
        resumed
            .execute(
                "Edit",
                json!({"file_path":"kept.txt","old_string":"before","new_string":"after"}),
                fixture.context()
            )
            .await
            .unwrap()["isError"],
        false
    );
    assert_eq!(
        resumed
            .execute(
                "Bash",
                json!({"command":"printf '%s' \"$TOOL_CHECKPOINT_VALUE\""}),
                fixture.context()
            )
            .await
            .unwrap()["content"],
        "survived"
    );
    let output = resumed
        .execute(
            "TaskOutput",
            json!({"task_id":launched["metadata"]["task_id"],"timeout":2000}),
            fixture.context(),
        )
        .await
        .unwrap();
    let output: Value = serde_json::from_str(output["content"].as_str().unwrap()).unwrap();
    assert_eq!(output["task"]["result"], "completed after retirement");
    let notices = resumed.drain_background_notices().await;
    assert_eq!(notices.len(), 1);
    assert!(notices[0].contains("completed. Output file:"));
    resumed.close().await.unwrap();
    checkpoint.close().await;
}

#[test]
fn custom_read_state_map_preserves_value_identity_and_live_iteration() {
    let fixture = Fixture::new();
    let runtime = ToolRuntime::new(fixture.options(), Arc::new(NoHost), Arc::new(NoHost));
    runtime
        .tool_context_call(
            "readFileState.set",
            json!(["one",{"content":"first","timestamp":0}]),
        )
        .unwrap();
    runtime
        .tool_context_call(
            "readFileState.set",
            json!(["two",{"content":"second","timestamp":1}]),
        )
        .unwrap();
    let first = runtime
        .tool_context_call("readFileState.getEntry", json!(["one"]))
        .unwrap();
    runtime
        .tool_context_call(
            "readFileState.set",
            json!(["one",{"content":"replacement","timestamp":2}]),
        )
        .unwrap();
    let newer = runtime
        .tool_context_call("readFileState.getEntry", json!(["one"]))
        .unwrap();
    assert_eq!(first["sequence"], newer["sequence"]);
    assert_ne!(first["valueVersion"], newer["valueVersion"]);
    assert_eq!(
        runtime
            .tool_context_call(
                "readFileState.patchEntry",
                json!(["one", first["valueVersion"], "content", "obsolete", false])
            )
            .unwrap(),
        false
    );
    assert_eq!(
        runtime
            .tool_context_call(
                "readFileState.patchEntry",
                json!(["one", newer["valueVersion"], "content", "updated", false])
            )
            .unwrap(),
        true
    );
    let current = runtime
        .tool_context_call("readFileState.get", json!(["one"]))
        .unwrap();
    assert_eq!(current, json!({"content":"updated","timestamp":2}));
    let next = runtime
        .tool_context_call("readFileState.next", json!([newer["sequence"]]))
        .unwrap();
    assert_eq!(next["key"], "two");
    runtime
        .tool_context_call("readFileState.delete", json!(["one"]))
        .unwrap();
    runtime
        .tool_context_call(
            "readFileState.set",
            json!(["one",{"content":"new insertion"}]),
        )
        .unwrap();
    let next = runtime
        .tool_context_call("readFileState.next", json!([next["sequence"]]))
        .unwrap();
    assert_eq!(next["key"], "one");
}
