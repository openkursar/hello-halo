use super::*;
use crate::bridge::EventSink;

struct NoCallbacks;
#[async_trait]
impl HostBridge for NoCallbacks {
    async fn call(&self, method: &str, _: Value, _: &CancellationToken) -> Result<Value> {
        panic!("unexpected host callback: {method}");
    }
}
#[async_trait]
impl EventSink for NoCallbacks {
    async fn emit(&self, _: Value) -> Result<()> { Ok(()) }
}

#[tokio::test]
async fn clear_installs_neither_live_nor_durable_state_until_checkpoint_finishes() {
    let directory = std::env::temp_dir().join(format!("halo-clear-checkpoint-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let definition = json!({"name":"mcp__fixture__lookup","description":"Complete lookup definition.","inputSchema":{"type":"object"},
        "mcpSource":{"server":"fixture","name":"lookup"}});
    let options = json!({"sessionId":"clear-fixture","model":"fixture","cwd":directory,"env":{"HOME":directory,"CLAUDE_CONFIG_DIR":directory.join("records")},
        "nativeSuppliedTools":[definition],"settingSources":[],"collaboration":false,"toolCallingMode":"native","toolResultBudget":32768,
        "contextWindow":200000,"maxOutputTokens":4096,
        "toolDiscovery":{"services":{"fixture":{"identity":"installation","loading":"deferred","summary":"Fixture records."}}}});
    let mut tools = ToolRuntime::new(options.clone(), Arc::new(NoCallbacks), Arc::new(NoCallbacks));
    tools.initialize(&CancellationToken::new()).await.unwrap();
    let tools = Arc::new(tools);
    let harness = crate::harness::baseline();
    let mut state = tool_context::State::new(&tools.catalog_tools(), &options["toolDiscovery"],32768,100000.0,&[],false).unwrap();
    let found = state.search(&json!({"query":"select:mcp__fixture__lookup"}), "search");
    let (_, record) = state.settle("search", found, "", "");
    state.commit(&record.unwrap()).unwrap();
    let messages = vec![state.recovery_message(), json!({"role":"user","content":"BEFORE_CLEAR_CONTEXT"})];
    let discovery = Arc::new(Mutex::new(state));
    let journal = Journal::new("clear-fixture", &options).await.unwrap();
    journal.checkpoint(&messages, "Initial checkpoint").await.unwrap();
    let path = crate::history::transcript_path("clear-fixture", &options);
    let original = tokio::fs::read(&path).await.unwrap();
    let (entered, release) = journal.pause_next_checkpoint();
    let retained = discovery.clone();
    let owner_tools = tools.clone();
    let clearing = tokio::spawn(async move {
        let mut messages = messages;
        let discovery = Some(discovery);
        let mut budget = TokenBudget::new(200000.0,4096.0);
        let mut context = LoopContext { environment: json!({}), memory: Default::default(), skill_context: None,
            compaction: Default::default(), tool_revision: 0, harness: harness.clone(), model: "fixture".into(),
            thinking: Value::Null, image_input: Default::default() };
        let mut actor = ActorState { options:&options, tools:&owner_tools, journal:&journal, messages:&mut messages,
            discovery:&discovery, budget:&mut budget, context:&mut context, manual:None, compacted:None };
        actor.clear(&CancellationToken::new()).await.unwrap();
        messages
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), entered).await.unwrap().unwrap();
    let before = async {
        assert!(!clearing.is_finished());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
        let prior = crate::history::read_report(&path, None).await.unwrap();
        assert!(crate::js::stringify(&json!(prior.messages)).contains("BEFORE_CLEAR_CONTEXT"));
        assert_eq!(tool_context::history::read_snapshot(&prior.messages).unwrap().unwrap()["definitions"].as_array().unwrap().len(),1);
        assert_eq!(retained.lock().unwrap().snapshot()["definitions"].as_array().unwrap().len(),1);
    };
    before.await;
    release.send(()).unwrap();
    let messages = clearing.await.unwrap();
    assert!(!crate::js::stringify(&json!(messages)).contains("BEFORE_CLEAR_CONTEXT"));
    assert_eq!(retained.lock().unwrap().snapshot()["definitions"],json!([]));
    let saved = crate::history::read_report(&path,None).await.unwrap();
    assert_eq!(tool_context::history::read_snapshot(&saved.messages).unwrap().unwrap()["definitions"],json!([]));
    assert!(!crate::js::stringify(&json!(saved.messages)).contains("BEFORE_CLEAR_CONTEXT"));
    tools.close().await.unwrap();
    tokio::fs::remove_dir_all(directory).await.unwrap();
}
