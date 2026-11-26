use crate::bridge::{EventSink, HostBridge};
use crate::error::{Error, Result};
use crate::tools::{DirectToolOwner, ToolContext, ToolRuntime};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

const PROBE: &str = "HALO_SEARCH_ROOT_PROBE";
const NAME: &str = "tools::search::root_tests::explicit_search_roots_resolve_like_file_tool_paths";

struct NoHost;
#[async_trait]
impl HostBridge for NoHost {
    async fn call(&self, method: &str, _: Value, _: &CancellationToken) -> Result<Value> {
        Err(Error::new("UNEXPECTED_CALLBACK", method))
    }
}
#[async_trait]
impl EventSink for NoHost {
    async fn emit(&self, _: Value) -> Result<()> {
        Ok(())
    }
}

fn write(path: PathBuf, content: &str) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, content).unwrap();
    path
}

/// The ripgrep the Grep checks run: `AGENT_RIPGREP_PATH` when set, otherwise `rg` on PATH.
fn ripgrep() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("AGENT_RIPGREP_PATH").filter(|value| !value.is_empty()) {
        let configured = PathBuf::from(configured);
        assert!(configured.is_absolute() && configured.is_file(), "AGENT_RIPGREP_PATH is not an absolute file: {}", configured.display());
        return Some(configured);
    }
    let name = if cfg!(windows) { "rg.exe" } else { "rg" };
    std::env::split_paths(&std::env::var_os("PATH")?).map(|directory| directory.join(name)).find(|candidate| candidate.is_file())
}

fn skipped(checks: &str, reason: &str) {
    eprintln!("SKIPPED {checks}: {reason}");
}

struct Searches {
    work: PathBuf,
    env: Value,
    runtime: ToolRuntime,
    direct: DirectToolOwner,
    direct_context: Value,
}
impl Searches {
    /// Session and direct tools for `work`, both running `ripgrep` when one is given.
    async fn new(work: &Path, denied: &[&Path], ripgrep: Option<&Path>) -> Self {
        let env = ripgrep.map_or_else(|| json!({}), |ripgrep| json!({"AGENT_RIPGREP_PATH": ripgrep}));
        let mut runtime = ToolRuntime::new(
            json!({"cwd":work,"sessionId":"search-root","persistSession":false,"skillCatalog":[],"nativeReadDenyRoots":denied}),
            Arc::new(NoHost),
            Arc::new(NoHost),
        );
        runtime.initialize(&CancellationToken::new()).await.unwrap();
        Self {
            work: work.to_path_buf(),
            runtime,
            direct: DirectToolOwner::new("search-root".into()),
            direct_context: json!({"cwd":work,"sessionId":"search-root","env":env,"currentTurn":0,"skillCatalog":[],"readDenyRoots":denied,
                "nativeOwner":{"readFileStatePresent":false,"externalReadFileState":false,"externalBackgroundTasks":false}}),
            env,
        }
    }
    async fn close(self) {
        self.runtime.close().await.unwrap();
        self.direct.close().await;
    }
    async fn call(&self, name: &str, input: Value) -> Value {
        let context = ToolContext {
            session_id: "search-root".into(),
            cwd: self.work.to_string_lossy().into_owned(),
            env: self.env.clone(),
            current_turn: 0,
            tool_use_id: "search-root".into(),
            cancellation: CancellationToken::new(),
            harness: crate::harness::baseline(),
        };
        let session = self.runtime.execute(name, input.clone(), context).await.unwrap();
        let direct = self
            .direct
            .execute(name.into(), input.clone(), self.direct_context.clone(), Arc::new(NoHost), Arc::new(NoHost), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(session["isError"], direct["isError"], "{name} {input}");
        if name == "Grep" && session["isError"] == false {
            assert_eq!(listed(&session), listed(&direct), "{name} {input}");
        } else {
            assert_eq!(session["content"], direct["content"], "{name} {input}");
        }
        session
    }
}

fn listed(result: &Value) -> Vec<PathBuf> {
    assert_eq!(result["isError"], false, "{result}");
    let mut paths: Vec<PathBuf> = result["content"]
        .as_str()
        .unwrap()
        .lines()
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect();
    paths.sort();
    paths
}

fn sorted(paths: &[&Path]) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = paths.iter().map(|path| path.to_path_buf()).collect();
    paths.sort();
    paths
}

/// The child process gets a synthetic home folder, so no search reaches the real one.
#[tokio::test]
async fn explicit_search_roots_resolve_like_file_tool_paths() {
    let Some(root) = std::env::var_os(PROBE).map(PathBuf::from) else {
        let root = std::env::temp_dir().join(format!("halo-search-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        let root = std::fs::canonicalize(&root).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--test-threads=1", "--nocapture"])
            .env(PROBE, &root)
            .env("HOME", root.join("home"))
            .env("USERPROFILE", root.join("home"))
            .output()
            .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}\n{stderr}");
        assert!(stdout.contains("1 passed"), "{stdout}");
        stderr.lines().filter(|line| line.starts_with("SKIPPED ")).for_each(|line| eprintln!("{line}"));
        return;
    };
    let home = root.join("home");
    let work = root.join("work");
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    assert_eq!(std::env::var_os(variable).map(PathBuf::from), Some(home.clone()));

    let markdown = write(home.join("notes/a.md"), "needle in home\n");
    let text = write(home.join("notes/b.txt"), "needle in text\n");
    write(home.join("secret/s.md"), "needle secret\n");
    let decoy = write(work.join("~/notes/decoy.md"), "needle decoy\n");
    let nested = write(work.join("sub/c.md"), "needle nested\n");
    let denied = home.join("secret");
    let ripgrep = ripgrep();
    let searches = Searches::new(&work, &[&denied], ripgrep.as_deref()).await;

    let found = searches.call("Glob", json!({"pattern":"**/*.md","path":"~/notes"})).await;
    assert_eq!(listed(&found), sorted(&[&markdown]));
    let found = searches.call("Glob", json!({"pattern":"**/*.md","path":" ~ "})).await;
    assert_eq!(listed(&found), sorted(&[&markdown]));
    if ripgrep.is_some() {
        let found = searches.call("Grep", json!({"pattern":"needle","path":"~"})).await;
        assert_eq!(listed(&found), sorted(&[&markdown, &text]));
        let found = searches.call("Grep", json!({"pattern":"needle","path":"~/notes","glob":"*.md"})).await;
        assert_eq!(listed(&found), sorted(&[&markdown]));
        let found = searches.call("Grep", json!({"pattern":"needle","path":"~/notes/b.txt"})).await;
        assert_eq!(listed(&found), sorted(&[&text]));
    }

    for (name, input) in [
        ("Glob", json!({"pattern":"*","path":"~/secret"})),
        ("Grep", json!({"pattern":"needle","path":"~/secret"})),
    ] {
        let refused = searches.call(name, input).await;
        assert_eq!(refused["isError"], true, "{refused}");
        assert_eq!(
            refused["content"],
            format!("Permission to read {} has been denied.", denied.display())
        );
    }

    let found = searches.call("Glob", json!({"pattern":"~/notes/*.md"})).await;
    assert_eq!(listed(&found), sorted(&[&decoy]));
    let found = searches.call("Glob", json!({"pattern":"**/*.md"})).await;
    assert_eq!(listed(&found), sorted(&[&decoy, &nested]));
    if ripgrep.is_some() {
        let found = searches.call("Grep", json!({"pattern":"needle","glob":"~/notes/*.md"})).await;
        assert_eq!(listed(&found), sorted(&[&decoy]));
        let found = searches.call("Grep", json!({"pattern":"needle","path":"sub"})).await;
        assert_eq!(listed(&found), sorted(&[&nested]));
        let found = searches.call("Grep", json!({"pattern":"needle","path":"./~/notes"})).await;
        assert_eq!(listed(&found), sorted(&[&decoy]));
    } else {
        skipped("Grep result checks", "ripgrep was not found: AGENT_RIPGREP_PATH is unset and PATH has no rg");
    }
    searches.close().await;
}

/// An explicit path is NFC; a working directory spelled in NFD must still bound
/// the glob check that rg skips for an explicitly named file.
#[tokio::test]
async fn an_explicit_file_under_a_decomposed_working_directory_keeps_its_glob_check() {
    let root = std::env::temp_dir().join(format!("halo-search-nfd-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    let root = std::fs::canonicalize(&root).unwrap();
    let work = root.join("cafe\u{301}");
    let file = write(work.join("src/a.ts"), "needle\n");
    let shown = PathBuf::from(file.to_string_lossy().nfc().collect::<String>());
    assert_ne!(shown, file);
    if !shown.is_file() {
        skipped("decomposed working directory checks", "this filesystem distinguishes Unicode normalization forms, so the NFC path does not name the file");
        std::fs::remove_dir_all(&root).unwrap();
        return;
    }
    let ripgrep = ripgrep();
    let searches = Searches::new(&work, &[], ripgrep.as_deref()).await;
    let excluded = crate::harness::baseline().text(crate::harness::TextId::ToolsGrepFileExcluded).to_owned();
    for glob in ["!src", "*.py"] {
        let result = searches.call("Grep", json!({"pattern":"needle","path":"src/a.ts","glob":glob})).await;
        assert_eq!(result["isError"], false, "{glob}: {result}");
        assert_eq!(result["content"], excluded, "{glob}");
    }
    if ripgrep.is_some() {
        let found = searches.call("Grep", json!({"pattern":"needle","path":"src/a.ts","glob":"*.ts"})).await;
        assert_eq!(listed(&found), sorted(&[&shown]));
    } else {
        skipped("Grep result checks", "ripgrep was not found: AGENT_RIPGREP_PATH is unset and PATH has no rg");
    }
    searches.close().await;
    std::fs::remove_dir_all(&root).unwrap();
}
