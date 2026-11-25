use super::*;
#[tokio::test]
async fn bridge_owned_errors_render_late_and_external_messages_remain_data(){
    let base=std::env::temp_dir().join(format!("native-search-errors-{}",uuid::Uuid::new_v4()));let root=base.join("workspace");let cache=base.join("cache");std::fs::create_dir_all(&root).unwrap();let module=base.join("backend.mjs");std::fs::write(&module,"export const unrelated = true;\n").unwrap();
    let pool=Arc::new(CodeSearchPool::new());let options=json!({"backend":"zvec-grep","nodePath":node(),"modulePath":module,"cachePath":cache});let service=CodeSearchService::new_with_pool(options,pool.clone()).unwrap();
    let request=json!({"root":root,"query":"test"});let owned=service.search(request.clone(),&CancellationToken::new()).await.unwrap_err();assert_eq!(owned.message,"The configured module does not expose createZvecGrep.");assert!(owned.harness.is_some());
    let text=crate::harness::Harness::from_config(&json!({"models":{"first":{"tools.code_search.bridge.missing_factory":"first model failure"},"second":{"tools.code_search.bridge.missing_factory":"second model failure"}}})).unwrap();assert_eq!(owned.render_for(&text.for_model("first")),"first model failure");assert_eq!(owned.render_for(&text.for_model("second")),"second model failure");
    std::fs::write(&module,"export async function createZvecGrep(){throw new Error('The configured module does not expose createZvecGrep.');}\n").unwrap();let external=service.search(request,&CancellationToken::new()).await.unwrap_err();assert!(external.harness.is_none());assert_eq!(external.render_for(&text.for_model("second")),"The configured module does not expose createZvecGrep.");
    service.dispose().await;pool.dispose().await;std::fs::remove_dir_all(base).unwrap();
}
#[cfg(windows)]
#[test]
fn code_search_converts_only_normalizable_verbatim_node_entry_paths() {
    for (input, expected) in [
        (r"\\?\D:\space (测试)\worker.cjs", r"D:\space (测试)\worker.cjs"),
        (r"\\?\UNC\server\share\worker.cjs", r"\\server\share\worker.cjs"),
        (r"\\?\D:\keep trailing.\worker.cjs", r"\\?\D:\keep trailing.\worker.cjs"),
        (r"\\?\Volume{11111111-1111-1111-1111-111111111111}\worker.cjs", r"\\?\Volume{11111111-1111-1111-1111-111111111111}\worker.cjs"),
    ] {
        assert_eq!(node_visible_path(Path::new(input)), PathBuf::from(expected));
    }
}

#[test]
fn windows_search_environment_matches_effective_values_not_key_spelling() {
    let direct = json!({"nativeProcessEnv": {
        "Path": "fixture-bin", "SystemRoot": "fixture-system", "ComSpec": "fixture-shell",
        "SDK_TEST_API_KEY": "fixture-secret"
    }});
    let host_callback = json!({"nativeProcessEnv": {
        "PATH": "fixture-bin", "SystemRoot": "fixture-system", "SYSTEMROOT": "fixture-system",
        "COMSPEC": "fixture-shell"
    }});
    let expected = json!({"PATH": "fixture-bin", "SYSTEMROOT": "fixture-system", "COMSPEC": "fixture-shell"});
    assert_eq!(search_environment(&direct, true).to_string(), expected.to_string());
    assert_eq!(search_environment(&host_callback, true).to_string(), expected.to_string());
    let mut different = host_callback.clone();
    different["nativeProcessEnv"]["PATH"] = json!("other-fixture-bin");
    assert_ne!(search_environment(&direct, true), search_environment(&different, true));
    different["nativeProcessEnv"]["PATH"] = json!("");
    assert_eq!(search_environment(&different, true)["PATH"], "");
    different["nativeProcessEnv"]["Path"] = json!("ignored-duplicate");
    assert_eq!(search_environment(&different, true)["PATH"], "");
    assert_eq!(search_environment(&direct, false), json!({"SystemRoot": "fixture-system"}));
}

#[test]
fn nullable_timeouts_keep_defaults_and_reject_other_invalid_numbers() {
    let base = json!({"backend":"zvec-grep","nodePath":"/node","modulePath":"/backend","cachePath":"/cache"});
    for absent in [Value::Null, crate::js::undefined()] {
        let mut options = base.clone();
        options["idleTimeoutMs"] = absent.clone();
        options["timeoutMs"] = absent;
        let configured = settings(options).unwrap();
        assert_eq!(configured.idle_ms, 30000);
        assert_eq!(configured.timeout_ms, 300000);
    }
    for invalid in [
        json!(0),
        json!(-1),
        json!(0.5),
        json!(900001),
        json!("30000"),
        json!(false),
        json!({}),
    ] {
        let mut options = base.clone();
        options["timeoutMs"] = invalid;
        assert!(settings(options).is_err());
    }
}
fn node() -> String {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|p| p.is_file())
        .unwrap()
        .to_string_lossy()
        .into_owned()
}
#[tokio::test]
async fn backend_reuse_preserves_effective_search_environment() {
    let base = std::env::temp_dir().join(format!("search-env-{}", uuid::Uuid::new_v4()));
    let root = base.join("workspace");
    let cache = base.join("cache");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("sample.ts"), "export const sample = true;\n").unwrap();
    let module = base.join("backend.cjs");
    std::fs::write(&module, r#"
const { join } = require('node:path');
const { root } = JSON.parse(process.argv[2]);
process.on('message', request => {
  if (request.type === 'close') { process.disconnect(); return; }
  const matches = process.env.PATH === request.query;
  const hit = { path: join(root, 'sample.ts'), lineStart: 1, lineEnd: 1,
    snippet: JSON.stringify({ pid: process.pid, matches }), truncated: false };
  process.send({ type: 'result', id: request.id, result: { hits: [hit], freshness: 'fresh', exhaustive: false } });
});
process.send({ type: 'ready' });
"#).unwrap();
    let pool = Arc::new(CodeSearchPool::new());
    let mut environment = search_environment(&Value::Null, cfg!(windows));
    environment.as_object_mut().unwrap().remove("PATH");
    let make_service = |key: &str, bin: &str| {
        let mut supplied = environment.clone();
        supplied[key] = json!(bin);
        let options = json!({"backend":"zvec-grep","nodePath":node(),"modulePath":module,
            "workerPath":module,"cachePath":cache,"nativeProcessEnv":supplied});
        CodeSearchService::new_with_pool(options, pool.clone()).unwrap()
    };
    let direct = make_service(if cfg!(windows) { "Path" } else { "PATH" }, "fixture-bin-a");
    let via_host = make_service("PATH", "fixture-bin-a");
    let different = make_service("PATH", "fixture-bin-b");
    let search = |owner: CodeSearchService, bin: &'static str| {
        let request = json!({"root":root,"query":bin});
        async move {
            let result = owner.search(request, &CancellationToken::new()).await.unwrap();
            let details: Value = serde_json::from_str(result["hits"][0]["snippet"].as_str().unwrap()).unwrap();
            assert_eq!(details["matches"], true);
            (owner, details["pid"].as_u64().unwrap())
        }
    };
    let (direct, first) = search(direct, "fixture-bin-a").await;
    let (via_host, second) = search(via_host, "fixture-bin-a").await;
    assert_eq!(second, first);
    let (different, third) = search(different, "fixture-bin-b").await;
    assert_ne!(third, first);
    for owner in [direct, via_host, different] {
        owner.dispose().await;
    }
    pool.dispose().await;
    std::fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn optional_backend_is_shared_scoped_refreshable_and_cancelled() {
    let base = std::env::temp_dir().join(format!("native-search-test-{}", uuid::Uuid::new_v4()));
    let root = base.join("workspace");
    let cache = base.join("cache");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("code.rs"), "pub fn known_source() {}\n").unwrap();
    let module = base.join("backend.mjs");
    std::fs::write(&module,r#"
import fs from 'node:fs';import path from 'node:path';
export async function createZvecGrep(options){
 const mark=path.join(options.root,'open-count');
 fs.writeFileSync(mark,String(Number(fs.existsSync(mark)?fs.readFileSync(mark,'utf8'):0)+1));
 if(options.embedding!=='local/potion-code-16m-v2'||options.device!=='cpu'||options.embeddingConcurrency!==1)throw Error('Wrong backend settings');
 let root;
 return {
  async index(settings){if(settings.follow!==false||settings.rootPaths[0].follow!==false)throw Error('Follow must remain disabled');root=settings.rootPaths[0].absolutePath;fs.writeFileSync(path.join(options.root,'index-count'),String(Number(fs.existsSync(path.join(options.root,'index-count'))?fs.readFileSync(path.join(options.root,'index-count'),'utf8'):0)+1));},
  async context(request){if(request.query==='block')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);if(request.query==='outside')return{items:[{file:{absolutePath:process.argv[1]},range:{kind:'text',startLine:1,endLine:1},content:'outside',status:'fresh'}]};const file=path.join(root,'code.rs');return{items:[{file:{absolutePath:file},range:{kind:'text',startLine:1,endLine:1},content:fs.readFileSync(file,'utf8'),status:'fresh'}]};},
  async close(){}
 };
}

"#).unwrap();
    let options = json!({"backend":"zvec-grep","nodePath":node(),"modulePath":module,"cachePath":cache,"idleTimeoutMs":30000,"timeoutMs":3000});
    let first = CodeSearchService::new(options.clone()).unwrap();
    let second = CodeSearchService::new(options.clone()).unwrap();
    assert_eq!(diagnostics(), json!({"workers":0,"pending":0,"running":0}));
    let request = json!({"root":root,"query":"known source"});
    let result = first
        .search(request.clone(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["hits"][0]["snippet"], "pub fn known_source() {}\n");
    assert_eq!(result["freshness"], "fresh");
    let result = second
        .search(request.clone(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["freshness"], "possibly_stale");
    let workspace_index = std::fs::read_dir(cache.join("workspaces"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read_to_string(workspace_index.join("open-count")).unwrap(),
        "1"
    );
    assert_eq!(
        std::fs::read_to_string(workspace_index.join("index-count")).unwrap(),
        "1"
    );
    let mut refreshed = request.clone();
    refreshed["refresh"] = json!(true);
    second
        .search(refreshed, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(workspace_index.join("index-count")).unwrap(),
        "2"
    );
    let restricted =
        json!({"root":root,"query":"known source","readDenyRoots":[root.join("private")]});
    assert_eq!(
        second
            .search(restricted, &CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "read_denied"
    );
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        signal.cancel();
    });
    let blocked = json!({"root":root,"query":"block"});
    assert_eq!(
        second.search(blocked, &cancel).await.unwrap_err().code,
        "cancelled"
    );
    let result = second
        .search(request.clone(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["freshness"], "fresh");
    assert_eq!(
        std::fs::read_to_string(workspace_index.join("open-count")).unwrap(),
        "2"
    );
    first.dispose().await;
    assert_eq!(diagnostics()["workers"], 1);
    second.dispose().await;
    assert_eq!(diagnostics(), json!({"workers":0,"pending":0,"running":0}));
    std::fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn host_pools_isolate_capacity_shutdown_and_resource_activity() {
    let base =
        std::env::temp_dir().join(format!("native-search-scope-test-{}", uuid::Uuid::new_v4()));
    let root = base.join("workspace");
    let cache = base.join("cache");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("code.rs"), "scoped source\n").unwrap();
    let module = base.join("backend.mjs");
    std::fs::write(&module,r#"
import fs from 'node:fs';import path from 'node:path';
export async function createZvecGrep(options){
 const mark=path.join(options.root,'open-count');fs.writeFileSync(mark,String(Number(fs.existsSync(mark)?fs.readFileSync(mark,'utf8'):0)+1));let root;
 return {async index(settings){root=settings.rootPaths[0].absolutePath;},async context(request){if(request.query==='block'){fs.writeFileSync(path.join(options.root,'blocked'),'yes');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return{items:[{file:{absolutePath:path.join(root,'code.rs')},range:{kind:'text',startLine:1,endLine:1},content:fs.readFileSync(path.join(root,'code.rs'),'utf8'),status:'fresh'}]};},async close(){}};
}
"#).unwrap();
    let options = json!({"backend":"zvec-grep","nodePath":node(),"modulePath":module,"cachePath":cache,"idleTimeoutMs":30000,"timeoutMs":3000});
    let scope = Arc::new(CodeSearchPool::new());
    let other_scope = Arc::new(CodeSearchPool::new());
    let first = CodeSearchService::new_with_pool(options.clone(), scope.clone()).unwrap();
    let second =
        Arc::new(CodeSearchService::new_with_pool(options.clone(), scope.clone()).unwrap());
    let other = CodeSearchService::new_with_pool(options, other_scope.clone()).unwrap();
    assert_eq!(
        scope.diagnostics(),
        json!({"workers":0,"pending":0,"running":0})
    );
    assert!(!scope.resource_activity().snapshot().active);
    assert!(!cache.exists());
    let request = json!({"root":root,"query":"known"});
    first
        .search(request.clone(), &CancellationToken::new())
        .await
        .unwrap();
    second
        .search(request.clone(), &CancellationToken::new())
        .await
        .unwrap();
    let index = std::fs::read_dir(cache.join("workspaces"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read_to_string(index.join("open-count")).unwrap(),
        "1"
    );
    assert!(scope.resource_activity().snapshot().active);
    other
        .search(request.clone(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(index.join("open-count")).unwrap(),
        "2"
    );
    assert!(other_scope.resource_activity().snapshot().active);
    first.dispose().await;
    assert_eq!(scope.diagnostics()["workers"], 1);
    assert!(scope.resource_activity().snapshot().active);
    let blocked_owner = second.clone();
    let blocked_root = root.clone();
    let blocked = tokio::spawn(async move {
        blocked_owner
            .search(
                json!({"root":blocked_root,"query":"block"}),
                &CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !index.join("blocked").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        other.search(request.clone(), &CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["hits"][0]["snippet"], "scoped source\n");
    scope.abort_now();
    assert_eq!(blocked.await.unwrap().unwrap_err().code, "cancelled");
    assert!(!scope.resource_activity().snapshot().active);
    assert!(other_scope.resource_activity().snapshot().active);
    assert_eq!(other_scope.diagnostics()["workers"], 1);
    assert_eq!(
        other
            .search(request, &CancellationToken::new())
            .await
            .unwrap()["hits"][0]["snippet"],
        "scoped source\n"
    );
    second.dispose().await;
    other.dispose().await;
    assert!(!other_scope.resource_activity().snapshot().active);
    assert_eq!(
        other_scope.diagnostics(),
        json!({"workers":0,"pending":0,"running":0})
    );
    other_scope.dispose().await;
    std::fs::remove_dir_all(base).unwrap();
}
