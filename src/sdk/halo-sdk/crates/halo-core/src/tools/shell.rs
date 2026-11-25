use super::shell_platform::{null_redirect, posix_to_windows, quote, windows_to_posix};
use super::{failure, success, utf16_prefix, ToolContext};
use crate::{
    error::Error,
    harness::{Message, ResolvedHarness, TextId},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{oneshot, Mutex, Notify},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
struct ShellState {
    cwd: String,
    env: HashMap<String, String>,
}

struct StateFile {
    path: PathBuf,
    cleaned: bool,
}

impl StateFile {
    fn create(directory: &Path) -> std::io::Result<Self> {
        Self::create_with(directory, "state", b"")
    }

    fn create_with(directory: &Path, extension: &str, contents: &[u8]) -> std::io::Result<Self> {
        use std::io::Write;
        let path = directory.join(format!("agent-shell-{}.{extension}", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&path)?;
        let file = Self {
            path,
            cleaned: false,
        };
        if !contents.is_empty() {
            handle.write_all(contents)?;
        }
        Ok(file)
    }

    async fn cleanup(&mut self) {
        let result = tokio::fs::remove_file(&self.path).await;
        self.cleaned = true;
        if let Err(error) = result {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error=%error,"shell state file cleanup failed");
            }
        }
    }
}

impl Drop for StateFile {
    fn drop(&mut self) {
        if !self.cleaned {
            if let Err(error) = std::fs::remove_file(&self.path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error=%error,"interrupted shell state file cleanup failed");
                }
            }
        }
    }
}

struct Task {
    value: StdMutex<Value>,
    done: Notify,
    cancel: CancellationToken,
    sequence: u64,
    pid: AtomicU32,
    cwd_warning: Option<Message>,
    settling: AtomicBool,
    preview: Arc<StdMutex<BackgroundPreview>>,
}
struct Starting<'a>(&'a ShellTools);
impl Drop for Starting<'_> {
    fn drop(&mut self) {
        self.0.starting.fetch_sub(1, Ordering::AcqRel);
        self.0.starts_done.notify_waiters();
    }
}
struct PersistedOutput {
    file: tokio::fs::File,
    written: usize,
    truncated: bool,
    failed: bool,
    marker: String,
    preview: Arc<StdMutex<BackgroundPreview>>,
}
impl PersistedOutput {
    async fn push(&mut self, bytes: &[u8]) -> bool {
        if self.failed {
            return false;
        }
        let remaining = BACKGROUND_FILE_LIMIT.saturating_sub(self.marker.len() + self.written);
        let count = bytes.len().min(remaining);
        let result = async {
            if count > 0 {
                self.file.write_all(&bytes[..count]).await?;
                self.written += count;
            }
            if count < bytes.len() && !self.truncated {
                self.truncated = true;
                self.file.write_all(self.marker.as_bytes()).await?;
                tracing::warn!(limit_bytes = BACKGROUND_FILE_LIMIT, "background command output truncated");
            }
            std::io::Result::Ok(())
        }.await;
        if let Err(error) = result {
            self.failed = true;
            tracing::warn!(error=%error, "background command output write failed");
        }
        !self.failed
    }
}
#[derive(Default)]
pub struct ShellTools {
    state: Mutex<ShellState>,
    tasks: Arc<StdMutex<HashMap<String, Arc<Task>>>>,
    starting: AtomicUsize,
    starts_done: Notify,
    next_sequence: AtomicU64,
    close_lock: Mutex<()>,
    closed: AtomicBool,
    close_done: Notify,
    lifetime: CancellationToken,
    directory: Mutex<Option<PathBuf>>,
    persistent: bool,
    notices: Arc<Mutex<VecDeque<Message>>>,
    processes: Arc<crate::processes::OwnedProcesses>,
    base_environment: Value,
    temporary_directory: PathBuf,
    activity: Option<Arc<crate::resource_activity::ResourceActivity>>,
    output: Option<Arc<super::output::OutputStore>>,
    result_budget: usize,
    configured_budget: bool,
}
pub(super) fn command_timeout(input: &Value) -> u64 {
    let number = crate::js::to_number_data(input.get("timeout"));
    (if number == 0.0 || number.is_nan() {
        120000.
    } else {
        number
    })
    .clamp(0., 600000.) as u64
}
fn shell_path(env: &Value) -> Result<String, Error> {
    let lookup = |name: &str| env[name].as_str().map(str::to_owned);
    let supported = |s: &str| s.contains("bash") || s.contains("zsh");
    if let Some(path) = lookup("AGENT_SHELL") {
        if supported(&path) && Path::new(&path).is_file() {
            return Ok(path);
        }
        tracing::warn!("Configured shell is unsupported or unavailable; trying discovery");
    }
    if cfg!(windows) {
        let mut paths = vec![];
        if let Some(p) = lookup("AGENT_GIT_BASH_PATH") {
            paths.push(p);
        }
        for base in ["C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git"] {
            paths.push(format!("{base}\\bin\\bash.exe"));
        }
        for p in paths {
            if Path::new(&p).is_file() {
                return Ok(p);
            }
        }
        return Err(Error::template(
            "SHELL_UNAVAILABLE",
            TextId::ToolsShellWindowsUnavailable,
            &[],
        ));
    }
    let env_shell = lookup("SHELL").unwrap_or_default();
    if supported(&env_shell) && Path::new(&env_shell).is_file() {
        return Ok(env_shell.clone());
    }
    let order = if env_shell.contains("bash") {
        ["bash", "zsh"]
    } else {
        ["zsh", "bash"]
    };
    let paths = lookup("PATH").unwrap_or_default();
    for name in order {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(name);
            if p.is_file() {
                return Ok(p.to_string_lossy().into_owned());
            }
        }
    }
    for name in order {
        for dir in ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"] {
            let p = format!("{dir}/{name}");
            if Path::new(&p).is_file() {
                return Ok(p);
            }
        }
    }
    Err(Error::template(
        "SHELL_UNAVAILABLE",
        TextId::ToolsShellUnavailable,
        &[],
    ))
}
fn is_zsh(shell: &str) -> bool {
    Path::new(shell)
        .file_stem()
        .is_some_and(|name| name.to_string_lossy().contains("zsh"))
}
fn filtered(key: &str) -> bool {
    [
        "_",
        "SHLVL",
        "BASH_LINENO",
        "BASH_SOURCE",
        "PWD",
        "__agent_ec",
        "__agent_cwd",
        "__agent_env_name",
        "FUNCNAME",
        "PIPESTATUS",
        "OLDPWD",
        "BASHOPTS",
        "BASH_ALIASES",
        "BASH_ARGC",
        "BASH_ARGV",
        "BASH_CMDS",
        "BASH_COMMAND",
        "BASH_EXECUTION_STRING",
        "BASH_REMATCH",
        "BASH_SUBSHELL",
        "BASH_VERSINFO",
        "BASH_VERSION",
        "COMP_WORDBREAKS",
        "DIRSTACK",
        "EUID",
        "GROUPS",
        "HOSTNAME",
        "HOSTTYPE",
        "IFS",
        "LINENO",
        "MACHTYPE",
        "OPTERR",
        "OPTIND",
        "OSTYPE",
        "PPID",
        "PS1",
        "PS2",
        "PS4",
        "RANDOM",
        "SECONDS",
        "SHELL",
        "SHELLOPTS",
        "UID",
    ]
    .contains(&key)
        || key.starts_with("BASH_FUNC_")
}
fn windows_posix(path: &str) -> String {
    if cfg!(windows) {
        windows_to_posix(path)
    } else {
        path.to_owned()
    }
}
async fn resolve_directory(
    mut state: ShellState,
    fallback: &str,
) -> Result<(ShellState, Option<Message>), Error> {
    async fn problem(path: &str) -> Option<&'static str> {
        if !Path::new(path).is_absolute() || path.contains(['\0', '\r', '\n']) {
            return Some("invalid_path");
        }
        match tokio::fs::metadata(path).await {
            Ok(metadata) if metadata.is_dir() => None,
            Ok(_) => Some("not_directory"),
            Err(error) => Some(match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::NotADirectory => "ENOTDIR",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "stat_failed",
            }),
        }
    }
    let Some(reason) = problem(&state.cwd).await else {
        return Ok((state, None));
    };
    if ["invalid_path", "not_directory", "ENOENT", "ENOTDIR"].contains(&reason)
        && !fallback.is_empty()
        && fallback != state.cwd
        && problem(fallback).await.is_none()
    {
        tracing::warn!(
            reason,
            "shell working directory unavailable; using session directory"
        );
        state.cwd = fallback.to_owned();
        let warning = Message::template(
            TextId::ToolsShellCwdFallback,
            &[
                ("reason", reason.into()),
                ("cwd", crate::js::stringify(&json!(fallback)).into()),
            ],
        );
        Ok((state, Some(warning)))
    } else {
        tracing::warn!(reason, "command not started: working directory unavailable");
        Err(Error::template(
            "SHELL_CWD",
            TextId::ToolsShellCwdUnavailable,
            &[("reason", reason.into())],
        ))
    }
}
async fn create_output_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await
}
/// The start record holds PENDING until restore has finished and the shell replaces it with STARTED.
/// Only an untouched PENDING proves the command never ran; anything else leaves that unknown.
const PENDING: &str = "pending";
const STARTED: &str = "started";

fn wrapper(
    command: &str,
    shell: &str,
    state: &ShellState,
    start: Option<&Path>,
    snapshot: Option<&Path>,
    harness: &ResolvedHarness,
    environment: &mut HashMap<String, String>,
) -> String {
    let command = null_redirect(command);
    let mut exports = String::new();
    let prefix = format!("HALO_SHELL_RESTORE_{}_", uuid::Uuid::new_v4().simple());
    let mut restored = Vec::new();
    let mut next = 0;
    for (k, v) in &state.env {
        if !filtered(k) {
            let name = loop {
                let candidate = format!("{prefix}{next}");
                next += 1;
                if !environment.contains_key(&candidate) && !state.env.contains_key(&candidate) {
                    break candidate;
                }
            };
            environment.insert(name.clone(), v.clone());
            exports.push_str(&format!("export {k}=\"${{{name}}}\"\n"));
            restored.push(name);
        }
    }
    // Restore after shell startup without putting persisted values in argv.
    if !restored.is_empty() {
        exports.push_str(&format!("unset {}", restored.join(" ")));
    }
    let mut script = Vec::new();
    if is_zsh(shell) {
        // zsh aborts a command whose glob matches nothing; bash passes the pattern on, as commands written for bash expect.
        script.push("setopt NO_NOMATCH".to_owned());
    }
    script.extend([
        format!(
            "cd {} 2>/dev/null || {{ printf '%s\\n' {} >&2; exit 127; }}",
            quote(&windows_posix(&state.cwd)),
            quote(harness.text(TextId::ToolsShellWrapperCwdMissing))
        ),
        exports,
    ]);
    if let Some(start) = start {
        // The command runs only once its start is recorded, so an empty record always means it did not run.
        script.push(format!(
            "builtin printf {STARTED} 2>/dev/null >| {} || {{ printf '%s\\n' {} >&2; exit 125; }}",
            quote(&windows_posix(&start.to_string_lossy())),
            quote(harness.text(TextId::ToolsShellWrapperStartUnrecorded))
        ));
    }
    script.extend([command.into(), "__agent_ec=$?".into()]);
    if let Some(file) = snapshot {
        let pwd = if cfg!(windows) { "pwd -P -W" } else { "pwd -P" };
        script.push(format!(
            "__agent_cwd=$({pwd} 2>/dev/null) || {{ __agent_cwd={}; printf '%s\\n' {} >&2; }}",
            quote(&state.cwd),
            quote(harness.text(TextId::ToolsShellWrapperCwdRetained))
        ));
        let fallback = if is_zsh(shell) {
            r#"for __agent_env_name in "${(@k)parameters}"; do
    if [[ ${(tP)__agent_env_name} == *export* ]]; then
        printf '%s=%s\0' "$__agent_env_name" "${(P)__agent_env_name}"
    fi
done"#
        } else {
            r#"while IFS= read -r __agent_env_name; do
    case "$__agent_env_name" in ''|[0-9]*|*[!a-zA-Z0-9_]*) continue;; esac
    if [[ ${!__agent_env_name+x} ]]; then
        printf '%s=%s\0' "$__agent_env_name" "${!__agent_env_name}"
    fi
done < <(compgen -e)"#
        };
        let file = quote(&windows_posix(&file.to_string_lossy()));
        // Reopen and truncate: env can reject -0 or fail partway through a dump.
        script.push(format!(
            "{{ printf '%s\\0' \"$__agent_cwd\" && /usr/bin/env -0 && printf '\\0'; }} >| {file} 2>/dev/null || \
             {{ printf '%s\\0' \"$__agent_cwd\" && {{ {fallback}; }} && printf '\\0'; }} >| {file} 2>/dev/null || true"
        ));
    }
    script.push("exit $__agent_ec".into());
    script.join("\n")
}
#[derive(Clone, Copy, PartialEq)]
enum Started {
    No,
    Yes,
    Unknown,
}

async fn read_start(file: &Path) -> Started {
    async fn read(file: &Path) -> std::io::Result<Vec<u8>> {
        // Only a regular file is read, and only enough of it to compare, so a replaced record cannot block or flood.
        if !tokio::fs::symlink_metadata(file).await?.file_type().is_file() {
            return Err(std::io::Error::other("not a regular file"));
        }
        let mut raw = Vec::with_capacity(8);
        tokio::fs::File::open(file).await?.take(8).read_to_end(&mut raw).await?;
        Ok(raw)
    }
    match read(file).await {
        Ok(raw) if raw == PENDING.as_bytes() => Started::No,
        Ok(raw) if raw == STARTED.as_bytes() => Started::Yes,
        Ok(_) => {
            tracing::warn!("command start record was altered");
            Started::Unknown
        }
        Err(error) => {
            tracing::warn!(%error, "command start record could not be read");
            Started::Unknown
        }
    }
}

async fn read_state(file: &Path) -> Option<ShellState> {
    let raw = match tokio::fs::read_to_string(file).await {
        Ok(raw) => raw,
        Err(error) => {
            tracing::warn!(%error, "shell state discarded: snapshot could not be read");
            return None;
        }
    };
    let state = parse_state(&raw);
    if state.is_none() {
        tracing::warn!("shell state discarded: malformed or incomplete snapshot");
    }
    state
}

/// Applies only what one command changed relative to the state it started from, so a command
/// running alongside keeps its changes once the session holds a snapshot.
fn apply_snapshot(state: &mut ShellState, before: &ShellState, after: ShellState) {
    if after.cwd != before.cwd {
        state.cwd = after.cwd;
    }
    for key in before.env.keys() {
        if !after.env.contains_key(key) {
            state.env.remove(key);
        }
    }
    for (key, value) in after.env {
        if before.env.get(&key) != Some(&value) {
            state.env.insert(key, value);
        }
    }
}

fn parse_state(raw: &str) -> Option<ShellState> {
    // The final empty record distinguishes a complete dump from a partial write.
    let mut records = raw.strip_suffix("\0\0")?.split('\0');
    let cwd = records.next()?.to_owned();
    let cwd = if cfg!(windows) {
        posix_to_windows(&cwd)
    } else {
        cwd
    };
    if !Path::new(&cwd).is_absolute() || cwd.contains(['\0', '\r', '\n']) {
        return None;
    }
    let mut env = HashMap::new();
    for record in records {
        let (key, value) = record.split_once('=')?;
        if filtered(key) {
            continue;
        }
        let mut name = key.bytes();
        if !name.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
            || !name.all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            // An inherited name need not be a shell identifier that can be restored with export.
            continue;
        }
        env.insert(key.to_owned(), value.to_owned());
    }
    Some(ShellState { cwd, env })
}

#[cfg(all(test, unix))]
mod migration_tests {
    use super::*;

    async fn fixture() -> (PathBuf, ShellTools, ToolContext) {
        let root = std::env::temp_dir().join(format!("halo-shell-tests-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let root = tokio::fs::canonicalize(root).await.unwrap();
        let shell = ShellTools::new_with_activity(&json!({"persistSession":false,"nativeTempDirectory":std::env::temp_dir(),
            "nativeProcessEnv":{"PATH":"/usr/bin:/bin","HOME":root,"AGENT_SHELL":"/bin/bash"}}), None);
        let context = ToolContext { session_id: uuid::Uuid::new_v4().to_string(), cwd: root.to_string_lossy().into(),
            env: json!({"AGENT_SHELL":"/bin/bash"}), current_turn:0, tool_use_id:String::new(),
            cancellation: CancellationToken::new(), harness:crate::harness::baseline() };
        (root, shell, context)
    }
    #[tokio::test]
    async fn state_parser_preserves_values_filters_internal_keys_and_rejects_invalid_cwd() {
        let (root, shell, ctx) = fixture().await;
        let file = root.join("state");
        assert!(read_state(&file).await.is_none());
        let raw = [
            &ctx.cwd, "FOO=bar", "BAZ=qux", "VAR=key=value=more", "EMPTY=", "PATH=expected",
            "MULTILINE=line1\nPATH=/missing\nNEW_KEY=not-a-variable\nλ\n", "VAR2=ok",
            "SHLVL=2", "BASH_VERSION=5.1", "PIPESTATUS=0", "_=last", "PWD=/stale",
            "__agent_cwd=/stale", "__agent_ec=0", "__agent_env_name=FOO",
            "BASH_FUNC_foo%%=() { echo bar; }", "café=ok", "with.dot=value", "BAD-NAME=value",
            "1KEY=value", "MYVAR=keep", "", "",
        ].join("\0");
        tokio::fs::write(&file, raw).await.unwrap();
        let state = read_state(&file).await.unwrap();
        assert_eq!(state.cwd, ctx.cwd);
        for (key, value) in [
            ("FOO", "bar"), ("BAZ", "qux"), ("VAR", "key=value=more"), ("EMPTY", ""),
            ("PATH", "expected"), ("MULTILINE", "line1\nPATH=/missing\nNEW_KEY=not-a-variable\nλ\n"),
            ("VAR2", "ok"), ("MYVAR", "keep"),
        ] {
            assert_eq!(state.env.get(key).map(String::as_str), Some(value));
        }
        for key in ["SHLVL", "BASH_VERSION", "PIPESTATUS", "_", "PWD", "__agent_cwd", "__agent_ec",
            "__agent_env_name", "BASH_FUNC_foo%%", "NEW_KEY", "café", "with.dot", "BAD-NAME", "1KEY"] {
            assert!(!state.env.contains_key(key));
        }
        for invalid in [
            "", "/workspace\nFOO=bar\n", "/workspace\0PATH=partial", "/workspace\0PATH=partial\0",
            "\0FOO=bar\0\0", "relative/path\0FOO=bar\0\0", "/line\nfeed\0FOO=bar\0\0",
            "PATH=/usr/bin\0FOO=bar\0\0", "SECRET=fixture-value\0FOO=bar\0\0",
            "/workspace\0not-an-entry\0\0",
        ] {
            assert!(parse_state(invalid).is_none());
        }
        finish(root, shell).await;
    }
    #[tokio::test]
    async fn shell_selection_and_wrapper_restore_are_environment_scoped() {
        let (root,shell,ctx)=fixture().await;
        let first=root.join("first-bash");let second=root.join("second-bash");tokio::fs::write(&first,"").await.unwrap();tokio::fs::write(&second,"").await.unwrap();
        assert_eq!(shell_path(&json!({"AGENT_SHELL":first,"AGENT_GIT_BASH_PATH":second})).unwrap(),first.to_string_lossy());
        assert_eq!(shell_path(&json!({"AGENT_SHELL":second})).unwrap(),second.to_string_lossy());
        assert_eq!(shell_path(&json!({"AGENT_SHELL":first,"MODEL_API_KEY":"different"})).unwrap(),first.to_string_lossy());
        let base=json!({"AGENT_SHELL":first});let mut overrides=json!({"SHELL":second});overrides["AGENT_SHELL"]=crate::js::undefined();
        let merged=crate::core::conventions::merged_environment(&base,&[&overrides],false);
        assert_eq!(shell_path(&json!(merged)).unwrap(),second.to_string_lossy());
        let state=ShellState{cwd:ctx.cwd,env:HashMap::from([("FILTER".into(),"select(.x != .y) 'quote'".into())])};let mut env=HashMap::new();
        let script=wrapper("printf wrapper-command-marker >nul","bash",&state,None,None,&crate::harness::baseline(),&mut env);
        assert!(script.find("cd ").unwrap()<script.find("printf wrapper-command-marker").unwrap());assert!(script.find("export FILTER=").unwrap()<script.find("printf wrapper-command-marker").unwrap());
        assert!(script.contains("printf wrapper-command-marker >/dev/null"));assert!(!script.contains("\\!"));assert!(!script.contains("select(.x != .y)"));assert!(env.values().any(|value|value=="select(.x != .y) 'quote'"));assert_eq!(state.env["FILTER"],"select(.x != .y) 'quote'");
        let mut file=StateFile::create(&root).unwrap();let path=file.path.clone();assert!(path.exists());file.cleanup().await;file.cleanup().await;assert!(!path.exists());finish(root,shell).await;
    }
    async fn wait(shell: &ShellTools, id: &Value, ctx: &ToolContext) -> Value {
        shell.context_async_call("backgroundTasks.wait", &json!([id]), &json!({}),
            &CancellationToken::new(), ctx.harness.clone()).await.unwrap()
    }
    async fn read_preview(shell: &ShellTools, task: &Value, ctx: &ToolContext) -> Value {
        shell.context_async_call("backgroundTasks.readOutput", &json!([task]), &json!({}),
            &CancellationToken::new(), ctx.harness.clone()).await.unwrap()
    }
    #[tokio::test]
    async fn background_output_is_exact_bounded_and_independent_of_invoking_cancel() {
        let (root,shell,ctx)=fixture().await;
        assert!(shell.context_call("backgroundTasks.get",&json!(["unknown"]),&ctx.harness).unwrap().is_null());
        shell.execute(&json!({"command":"export BACKGROUND_SAVED=saved-value"}),ctx.clone()).await;
        let mut launch=ctx.clone();launch.env["BACKGROUND_CONFIG"]=json!("session-value");
        let result=shell.execute(&json!({"command":"printf \"$BACKGROUND_CONFIG:$BACKGROUND_SAVED\"; export BACKGROUND_SAVED=changed","run_in_background":true}),launch.clone()).await;
        let task=wait(&shell,&result["metadata"]["task_id"],&ctx).await;
        assert_eq!(task["status"],"completed");assert_eq!(tokio::fs::read_to_string(task["outputFile"].as_str().unwrap()).await.unwrap(),"session-value:saved-value");
        assert_eq!(shell.execute(&json!({"command":"printf \"$BACKGROUND_SAVED\""}),ctx.clone()).await["content"],"saved-value");
        let result=shell.execute(&json!({"command":"printf '%040000d' 0","run_in_background":true}),ctx.clone()).await;
        let task=wait(&shell,&result["metadata"]["task_id"],&ctx).await;
        let output=read_preview(&shell,&task,&ctx).await;assert_eq!(output["truncated"],true);assert_eq!(output["shownBytes"],32768);assert_eq!(tokio::fs::metadata(task["outputFile"].as_str().unwrap()).await.unwrap().len(),40000);assert!(task.get("output").is_none());
        let result=shell.execute(&json!({"command":"sleep 30","run_in_background":true}),launch.clone()).await;
        assert!(result["content"].as_str().unwrap().contains("No execution deadline was set"));assert!(result["content"].as_str().unwrap().contains("session is closed or interrupted"));
        let id=result["metadata"]["task_id"].clone();launch.cancellation.cancel();assert_eq!(shell.context_call("backgroundTasks.get",&json!([id]),&ctx.harness).unwrap()["status"],"running");
        assert!(shell.stop(id.as_str().unwrap(),Message::template(TextId::ToolsShellStopped,&[])));let stopped=wait(&shell,&id,&ctx).await;assert_eq!(stopped["status"],"stopped");
        let path=stopped["outputFile"].as_str().unwrap().to_owned();shell.close().await;assert!(!Path::new(&path).exists());assert_eq!(shell.context_call("backgroundTasks.getAll",&json!([]),&ctx.harness).unwrap(),json!([]));tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn interruption_stops_owned_tasks_synchronously_without_closing_the_shell() {
        let (root,shell,ctx)=fixture().await;
        let (other_root,other,other_ctx)=fixture().await;
        let launch=json!({"command":"sleep 30","run_in_background":true});
        let first=shell.execute(&launch,ctx.clone()).await;
        let unrelated=other.execute(&launch,other_ctx.clone()).await;
        shell.begin_interrupt();
        assert_eq!(shell.context_call("backgroundTasks.get",&json!([first["metadata"]["task_id"]]),&ctx.harness).unwrap()["status"],"stopped");
        assert_eq!(other.context_call("backgroundTasks.get",&json!([unrelated["metadata"]["task_id"]]),&other_ctx.harness).unwrap()["status"],"running");
        assert!(!ctx.cancellation.is_cancelled());
        assert!(!shell.lifetime.is_cancelled());
        assert_eq!(wait(&shell,&first["metadata"]["task_id"],&ctx).await["status"],"stopped");
        let next=shell.execute(&launch,ctx.clone()).await;
        assert_eq!(shell.context_call("backgroundTasks.get",&json!([next["metadata"]["task_id"]]),&ctx.harness).unwrap()["status"],"running");
        shell.interrupt().await;
        assert_eq!(wait(&shell,&next["metadata"]["task_id"],&ctx).await["status"],"stopped");
        other.interrupt().await;
        assert_eq!(wait(&other,&unrelated["metadata"]["task_id"],&other_ctx).await["status"],"stopped");
        finish(root,shell).await;
        finish(other_root,other).await;
    }
    #[tokio::test]
    async fn background_timeouts_and_exit_codes_remain_terminal() {
        let (root,shell,ctx)=fixture().await;
        let result=shell.execute(&json!({"command":"sleep 30","timeout":50,"run_in_background":true}),ctx.clone()).await;
        assert!(result["content"].as_str().unwrap().contains("Execution deadline: 50ms from launch"));let task=wait(&shell,&result["metadata"]["task_id"],&ctx).await;assert_eq!(task["status"],"failed");assert!(task["error"].as_str().unwrap().contains("Timed out"));
        let result=shell.execute(&json!({"command":"printf failure; exit 7","run_in_background":true}),ctx.clone()).await;let task=wait(&shell,&result["metadata"]["task_id"],&ctx).await;assert_eq!(task["status"],"failed");assert_eq!(task["exitCode"],7);finish(root,shell).await;
    }
    #[tokio::test]
    async fn process_defaults_and_caller_overrides_are_applied_to_real_shells() {
        let (root,shell,mut ctx)=fixture().await;
        let state=ShellState{cwd:ctx.cwd.clone(),env:HashMap::new()};
        let command="printf '%s|%s|%s|%s' \"$LANG\" \"$LC_ALL\" \"$AGENT_MODE\" \"$GIT_EDITOR\"";
        let execute=|context:ToolContext,base:Value|{ let state=state.clone(); let processes=shell.processes.clone(); async move {run(command,state,&context,None,CancellationToken::new(),None,None,processes,base,std::env::temp_dir(),None,None).await} };
        let base=json!({"PATH":"/usr/bin:/bin","AGENT_SHELL":"/bin/bash","LANG":"","LC_ALL":""});
        let result=execute(ctx.clone(),base.clone()).await.unwrap();assert_eq!(result.stdout,"C.UTF-8|C.UTF-8|1|true");
        ctx.env=json!({"AGENT_SHELL":"/bin/bash","LANG":"caller","GIT_EDITOR":"custom"});ctx.env["AGENT_MODE"]=crate::js::undefined();
        let result=execute(ctx.clone(),base).await.unwrap();assert_eq!(result.stdout,"caller|C.UTF-8||custom");
        ctx.env=json!({"AGENT_SHELL":"/bin/bash"});
        let result=execute(ctx,json!({"PATH":"/usr/bin:/bin","AGENT_SHELL":"/bin/bash","LANG":"en_US.UTF-8","LC_ALL":""})).await.unwrap();assert_eq!(result.stdout,"en_US.UTF-8||1|true");
        finish(root,shell).await;
    }
    #[test]
    fn output_truncation_keeps_boundaries_omission_counts_and_safe_recovery_hint() {
        let harness=crate::harness::baseline();
        let truncate=|text:&str,max|crate::core::truncate::truncate_content_with_harness(text,max,"Inspect any saved command output. If repeating the command is safe, filter its output or redirect it to a file.",&harness);
        for text in ["a".repeat(100),"x".repeat(50000)] { assert_eq!(truncate(&text,50000),text); }
        let output=truncate(&"a".repeat(50200),50000);assert!(output.contains("omitted from the middle"));assert!(output.starts_with(&"a".repeat(1000)));assert!(output.ends_with(&"a".repeat(1000)));assert!(output.len()<=50000);
        let head="HEAD".repeat(50);let tail="TAIL".repeat(50);let output=truncate(&format!("{head}{}{tail}","X".repeat(50000)),50000);assert!(output.starts_with(&head)&&output.ends_with(&tail));
        let lines=(0..100).map(|i|format!("line {i}")).collect::<Vec<_>>().join("\n");let output=truncate(&lines,400);assert!(output.contains("chars omitted from the middle"));assert!(output.contains("If repeating the command is safe"));assert!(output.len()<=400);
        let output=truncate(&"a".repeat(50),20);assert!(output.contains("truncated"));assert!(output.len()<=20);
    }
    #[tokio::test]
    async fn completed_task_eviction_keeps_running_tasks_and_output_until_owner_close() {
        let (root,shell,ctx)=fixture().await;
        let running=shell.execute(&json!({"command":"sleep 60","run_in_background":true}),ctx.clone()).await;
        let first=shell.execute(&json!({"command":"true","run_in_background":true}),ctx.clone()).await;
        let first_task=wait(&shell,&first["metadata"]["task_id"],&ctx).await;
        let mut last=Value::Null;
        for _ in 0..128 { let result=shell.execute(&json!({"command":"true","run_in_background":true}),ctx.clone()).await;last=wait(&shell,&result["metadata"]["task_id"],&ctx).await; }
        assert!(shell.context_call("backgroundTasks.get",&json!([first["metadata"]["task_id"]]),&ctx.harness).unwrap().is_null());
        assert_eq!(shell.context_call("backgroundTasks.get",&json!([running["metadata"]["task_id"]]),&ctx.harness).unwrap()["status"],"running");
        assert_eq!(last["status"],"completed");assert_eq!(shell.context_call("backgroundTasks.getAll",&json!([]),&ctx.harness).unwrap().as_array().unwrap().len(),129);
        assert!(Path::new(first_task["outputFile"].as_str().unwrap()).exists());finish(root,shell).await;
    }
    #[tokio::test]
    async fn resource_flood_bounds_persisted_output_and_missing_output_has_recovery_feedback() {
        let (root, shell, ctx) = fixture().await;
        let result = shell.execute(&json!({"command":"/usr/bin/head -c 67108864 /dev/zero | /usr/bin/tr '\\000' x; printf FINAL_MARKER","timeout":30000,"run_in_background":true}), ctx.clone()).await;
        assert_eq!(result["isError"], false);
        let task = wait(&shell, &result["metadata"]["task_id"], &ctx).await;
        assert_eq!(task["status"], "completed");
        let path = task["outputFile"].as_str().unwrap();
        assert!(tokio::fs::metadata(path).await.unwrap().len() <= 8 * 1024 * 1024);
        assert_eq!(task["outputTruncated"], true);
        let output = read_preview(&shell, &task, &ctx).await;
        assert_eq!(output["truncated"], true);
        assert!(tokio::fs::read_to_string(path).await.unwrap().ends_with("later output was not saved here.]"));
        let task_output=shell.task("TaskOutput",&json!({"task_id":task["id"],"block":false}),&ctx).await;
        let value:Value=serde_json::from_str(task_output["content"].as_str().unwrap()).unwrap();
        let preview=value["task"]["result"].as_str().unwrap();
        assert!(preview.contains("The saved file is also incomplete"));
        assert!(preview.contains("8388608-byte file limit"));
        tokio::fs::remove_file(path).await.unwrap();
        let output = read_preview(&shell, &task, &ctx).await;
        assert_eq!(output["truncated"], true);
        assert!(output["output"].as_str().unwrap().contains("no longer available"));
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn exact_background_output_has_one_notice_and_task_control_is_owner_scoped() {
        let (root,shell,ctx)=fixture().await;let (other_root,other,other_ctx)=fixture().await;
        let result=shell.execute(&json!({"command":"printf 'one\\n\\n'; printf two >&2","run_in_background":true}),ctx.clone()).await;
        let task=wait(&shell,&result["metadata"]["task_id"],&ctx).await;
        let path=task["outputFile"].as_str().unwrap();assert_eq!(tokio::fs::read_to_string(path).await.unwrap(),"one\n\ntwo");
        let notices=shell.drain_notices(&ctx.harness).await;assert_eq!(notices.len(),1);assert!(notices[0].contains(path));assert!(shell.drain_notices(&ctx.harness).await.is_empty());
        let result=shell.execute(&json!({"command":"sleep 30","run_in_background":true}),ctx.clone()).await;let id=&result["metadata"]["task_id"];
        assert_eq!(other.context_call("backgroundTasks.stop",&json!([id]),&other_ctx.harness).unwrap(),false);
        assert_eq!(shell.context_call("backgroundTasks.stop",&json!([id]),&ctx.harness).unwrap(),true);
        let stopped=wait(&shell,id,&ctx).await;assert_eq!(stopped["status"],"stopped");
        let running=other.execute(&json!({"command":"sleep 30","run_in_background":true}),other_ctx.clone()).await;
        shell.close().await;assert_eq!(other.context_call("backgroundTasks.get",&json!([running["metadata"]["task_id"]]),&other_ctx.harness).unwrap()["status"],"running");
        tokio::fs::remove_dir_all(root).await.unwrap();finish(other_root,other).await;
    }
    async fn finish(root: PathBuf, shell: ShellTools) {
        shell.close().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    async fn fake_shell(root: &Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("fake-bash");
        tokio::fs::write(&path, format!("#!/bin/sh\n{body}\n")).await.unwrap();
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).await.unwrap();
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn script_file_transport_keeps_the_shell_argument_short_however_large_the_state() {
        let (root, shell, mut ctx) = fixture().await;
        let log = root.join("argv-log");
        let bash = fake_shell(&root, &format!(
            "printf '%s %s\\n' \"$#\" \"${{#1}}\" >> {}\nexec /bin/bash \"$@\"", quote(&log.to_string_lossy()))).await;
        ctx.env = json!({"AGENT_SHELL": bash, "AGENT_TEST_SCRIPT_FILE": "1"});
        let exports = (0..150).map(|index| format!("export RESTORED_VARIABLE_{index:03}=value-{index}")).collect::<Vec<_>>().join("; ");
        let first = shell.execute(&json!({"command": exports}), ctx.clone()).await;
        assert_eq!(first["isError"], false);
        let padding = "x".repeat(20_000);
        let next = shell.execute(
            &json!({"command": format!(": {padding}\nprintf '%s %s' \"$RESTORED_VARIABLE_000\" \"$RESTORED_VARIABLE_149\"")}), ctx.clone()).await;
        assert_eq!(next["isError"], false);
        assert_eq!(next["content"], "value-0 value-149");
        let background = shell.execute(&json!({"command": "printf \"$RESTORED_VARIABLE_149\"", "run_in_background": true}), ctx.clone()).await;
        let task = tokio::time::timeout(Duration::from_secs(10), wait(&shell, &background["metadata"]["task_id"], &ctx)).await.unwrap();
        assert_eq!(task["status"], "completed");
        assert_eq!(tokio::fs::read_to_string(task["outputFile"].as_str().unwrap()).await.unwrap(), "value-149");
        let calls = tokio::fs::read_to_string(&log).await.unwrap();
        assert_eq!(calls.lines().count(), 3);
        for call in calls.lines() {
            let (count, length) = call.split_once(' ').unwrap();
            assert_eq!(count, "1");
            assert!(length.parse::<usize>().unwrap() < 512, "{call}");
        }
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn posix_shells_keep_the_released_invocation() {
        let (root, shell, ctx) = fixture().await;
        let result = shell.execute(&json!({"command": "\"$0\" -c 'printf inner'"}), ctx.clone()).await;
        assert_eq!(result["isError"], false);
        assert_eq!(result["content"], "inner");
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn later_commands_see_only_state_the_previous_command_actually_left() {
        let (root, shell, ctx) = fixture().await;
        tokio::fs::create_dir(root.join("sub")).await.unwrap();
        let run = |command: &str| {
            let (input, ctx, shell) = (json!({"command": command}), ctx.clone(), &shell);
            async move { shell.execute(&input, ctx).await }
        };
        assert_eq!(run("export KEPT=one REMOVED=two").await["isError"], false);
        assert_eq!(run("unset REMOVED").await["isError"], false);
        assert_eq!(run("printf '%s:%s' \"${KEPT-unset}\" \"${REMOVED-unset}\"").await["content"], "one:unset");
        let exited = run("exit 7\nexport NEVER_RUN=yes").await;
        assert_eq!(exited["isError"], true);
        assert_eq!(run("cd sub && exit 0").await["isError"], false);
        let next = run("printf '%s:%s' \"${NEVER_RUN-unset}\" \"$PWD\"").await;
        assert_eq!(next["content"], format!("unset:{}", root.display()));
        let (slow, changed) = tokio::join!(run("sleep 0.6; echo plain"), run("export HOME=changed-home"));
        assert_eq!((slow["isError"].clone(), changed["isError"].clone()), (json!(false), json!(false)));
        assert_eq!(run("printf '%s' \"$HOME\"").await["content"], "changed-home");
        let (first, second) = tokio::join!(run("sleep 0.6; export FIRST=one"), run("export SECOND=two"));
        assert_eq!((first["isError"].clone(), second["isError"].clone()), (json!(false), json!(false)));
        assert_eq!(run("printf '%s:%s' \"${FIRST-missing}\" \"${SECOND-missing}\"").await["content"], "one:two");
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn output_beyond_the_capture_window_is_never_reported_as_no_output() {
        let (root, shell, ctx) = fixture().await;
        for redirect in ["", " >&2"] {
            let command = format!("{{ printf '\\n%.0s' $(seq 1 33000); echo MIDDLE_MARKER; printf '\\n%.0s' $(seq 1 33000); }}{redirect}");
            let result = shell.execute(&json!({"command": command}), ctx.clone()).await;
            assert_eq!(result["isError"], false);
            let content = result["content"].as_str().unwrap();
            assert_ne!(content, "(No output)");
            assert_eq!(content.matches("characters of output omitted here").count(), 1, "{redirect}");
            assert_eq!(content.matches("[Command output reached").count(), 1, "{redirect}");
        }
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn a_process_holding_one_output_stream_ends_at_the_deadline_with_its_output() {
        let (root, shell, ctx) = fixture().await;
        for held in ["sleep 30 2>/dev/null &", "sleep 30 >/dev/null &"] {
            let command = format!("echo one-pipe; {held}");
            let started = std::time::Instant::now();
            let result = tokio::time::timeout(Duration::from_secs(10),
                shell.execute(&json!({"command": command, "timeout": 300}), ctx.clone())).await.unwrap();
            assert!(started.elapsed() < Duration::from_secs(4), "{held}: {:?}", started.elapsed());
            let content = result["content"].as_str().unwrap();
            assert!(content.contains("timed out after 300ms") && content.contains("one-pipe"), "{held}: {content}");
            assert!(!content.contains("still running after forced termination"), "{held}: {content}");
            let background = shell.execute(&json!({"command": command, "timeout": 300, "run_in_background": true}), ctx.clone()).await;
            let task = tokio::time::timeout(Duration::from_secs(10), wait(&shell, &background["metadata"]["task_id"], &ctx)).await.unwrap();
            assert_eq!(task["status"], "failed", "{held}");
            assert_eq!(tokio::fs::read_to_string(task["outputFile"].as_str().unwrap()).await.unwrap(), "one-pipe\n");
        }
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn a_process_that_survives_forced_termination_cannot_hang_the_command() {
        let (root, shell, ctx) = fixture().await;
        let command = "echo before; perl -e 'use POSIX; POSIX::setsid(); sleep 4' &";
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(10),
            shell.execute(&json!({"command": command, "timeout": 300}), ctx.clone())).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(6), "{:?}", started.elapsed());
        assert_eq!(result["isError"], true);
        let content = result["content"].as_str().unwrap();
        assert!(content.starts_with("Command reached its 300ms deadline"), "{content}");
        assert!(content.contains("before") && !content.contains("was terminated"), "{content}");
        let background = shell.execute(&json!({"command": command, "timeout": 300, "run_in_background": true}), ctx.clone()).await;
        let task = tokio::time::timeout(Duration::from_secs(10), wait(&shell, &background["metadata"]["task_id"], &ctx)).await.unwrap();
        assert_eq!(task["status"], "failed");
        assert!(task["error"].as_str().unwrap().contains("could not all be confirmed stopped"), "{}", task["error"]);
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn a_command_that_ran_is_never_reported_as_not_started() {
        let (root, shell, mut ctx) = fixture().await;
        let startup = root.join("startup.sh");
        tokio::fs::write(&startup, "printf() { return 1; }\n").await.unwrap();
        ctx.env = json!({"AGENT_SHELL": "/bin/bash", "BASH_ENV": startup});
        let result = shell.execute(&json!({"command": "echo ran > ran-file; echo visible"}), ctx.clone()).await;
        assert_eq!(result["isError"], false, "{}", result["content"]);
        assert_eq!(result["content"], "visible");
        assert!(root.join("ran-file").exists());
        ctx.env = json!({"AGENT_SHELL": "/bin/bash"});
        let limited = shell.execute(&json!({"command": "echo touched > happened; ulimit -f 0"}), ctx.clone()).await;
        assert!(!limited["content"].as_str().unwrap().contains("not started"), "{}", limited["content"]);
        assert!(root.join("happened").exists());
        finish(root, shell).await;
    }

    async fn private_temp_fixture() -> (PathBuf, PathBuf, ShellTools, ToolContext) {
        let (root, _, ctx) = fixture().await;
        let temp = root.join("private-temp");
        tokio::fs::create_dir(&temp).await.unwrap();
        let shell = ShellTools::new_with_activity(&json!({"persistSession":false,"nativeTempDirectory":temp,
            "nativeProcessEnv":{"PATH":"/usr/bin:/bin","HOME":root,"AGENT_SHELL":"/bin/bash"}}), None);
        (root, temp, shell, ctx)
    }

    #[tokio::test]
    async fn a_missing_start_record_is_reported_as_unconfirmed_not_as_success() {
        let (root, temp, shell, mut ctx) = private_temp_fixture().await;
        let startup = root.join("startup.sh");
        tokio::fs::write(&startup, "rm -f \"$PRIVATE_TEMP\"/agent-shell-*.start; exit 0\n").await.unwrap();
        ctx.env = json!({"AGENT_SHELL": "/bin/bash", "BASH_ENV": startup, "PRIVATE_TEMP": temp});
        let foreground = shell.execute(&json!({"command": "echo ran > actual"}), ctx.clone()).await;
        assert_eq!(foreground["isError"], true);
        assert!(foreground["content"].as_str().unwrap().starts_with("Command result unconfirmed"), "{}", foreground["content"]);
        let background = shell.execute(&json!({"command": "echo ran > actual", "run_in_background": true}), ctx.clone()).await;
        let task = tokio::time::timeout(Duration::from_secs(10), wait(&shell, &background["metadata"]["task_id"], &ctx)).await.unwrap();
        assert_eq!(task["status"], "failed");
        assert!(task["error"].as_str().unwrap().starts_with("Unconfirmed:"), "{}", task["error"]);
        assert!(!root.join("actual").exists());
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn a_command_that_empties_temporary_files_is_not_reported_as_not_started() {
        let (root, temp, shell, mut ctx) = private_temp_fixture().await;
        ctx.env = json!({"AGENT_SHELL": "/bin/bash", "PRIVATE_TEMP": temp});
        let result = shell.execute(
            &json!({"command": "echo ran > actual; for f in \"$PRIVATE_TEMP\"/*; do : > \"$f\"; done"}), ctx.clone()).await;
        assert_eq!(result["isError"], true);
        assert!(result["content"].as_str().unwrap().starts_with("Command result unconfirmed"), "{}", result["content"]);
        assert!(root.join("actual").exists());
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn a_start_that_cannot_be_recorded_keeps_the_command_from_running() {
        let (root, temp, shell, mut ctx) = private_temp_fixture().await;
        let startup = root.join("startup.sh");
        // A directory cannot be written as a file even by root.
        tokio::fs::write(&startup, "for f in \"$PRIVATE_TEMP\"/agent-shell-*.start; do rm -f \"$f\"; mkdir \"$f\"; done\n").await.unwrap();
        ctx.env = json!({"AGENT_SHELL": "/bin/bash", "BASH_ENV": startup, "PRIVATE_TEMP": temp});
        let result = shell.execute(&json!({"command": "echo ran > actual"}), ctx.clone()).await;
        assert_eq!(result["isError"], true);
        let content = result["content"].as_str().unwrap();
        assert!(content.ends_with("agent-sdk: the command start could not be recorded; command not started"), "{content}");
        assert!(!root.join("actual").exists());
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn a_shell_that_ends_before_the_command_is_reported_as_not_started() {
        let (root, shell, mut ctx) = fixture().await;
        let marker = root.join("ran");
        ctx.env = json!({"AGENT_SHELL": fake_shell(&root, "exit 0").await});
        let command = format!("printf ran > {}", quote(&marker.to_string_lossy()));
        let foreground = shell.execute(&json!({"command": command}), ctx.clone()).await;
        assert_eq!(foreground["isError"], true);
        let content = foreground["content"].as_str().unwrap();
        assert!(content.starts_with("Command not started: the shell ended with code 0"), "{content}");
        assert!(!content.contains("(No output)"));
        let background = shell.execute(&json!({"command": command, "run_in_background": true}), ctx.clone()).await;
        let task = wait(&shell, &background["metadata"]["task_id"], &ctx).await;
        assert_eq!(task["status"], "failed");
        assert!(task["error"].as_str().unwrap().starts_with("Not started: the shell ended with code 0"));
        assert!(!marker.exists());
        ctx.env = json!({"AGENT_SHELL": fake_shell(&root, "printf 'restore failed' >&2; exit 2").await});
        let failed = shell.execute(&json!({"command": command}), ctx.clone()).await;
        assert_eq!(failed["content"], "Command not started: the shell ended with code 2 before reaching it, so no part of the command ran.\nrestore failed");
        ctx.env = json!({"AGENT_SHELL": "/bin/bash"});
        let exited = shell.execute(&json!({"command": "printf partial; exit 0"}), ctx.clone()).await;
        assert_eq!(exited["isError"], false);
        assert_eq!(exited["content"], "partial");
        finish(root, shell).await;
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn zsh_nonportable_export_keeps_the_working_directory_path_and_other_exports() {
        let (root, shell, mut ctx) = fixture().await;
        ctx.env = json!({"AGENT_SHELL": "/bin/zsh", "LC_ALL": "en_US.UTF-8", "ZDOTDIR": root});
        let child = root.join("sub");
        tokio::fs::create_dir(&child).await.unwrap();
        let first = shell.execute(
            &json!({"command": "cd sub && export café=ok PORTABLE=retained PATH=/missing && test \"$café\" = ok"}),
            ctx.clone(),
        ).await;
        assert_eq!(first["isError"], false);
        let next = shell.execute(
            &json!({"command": "printf '%s\\n' \"$PWD\" \"$PORTABLE\" \"$PATH\""}), ctx,
        ).await;
        assert_eq!(next["isError"], false);
        assert_eq!(next["content"], format!("{}\nretained\n/missing", child.display()));
        finish(root, shell).await;
    }

    #[tokio::test]
    async fn cwd_recovers_after_external_removal_and_retains_exports() {
        let (root, shell, ctx) = fixture().await;
        let child = root.join("child"); tokio::fs::create_dir(&child).await.unwrap();
        shell.execute(&json!({"command":format!("cd {}; export HALO_CWD_TEST=retained", quote(&child.to_string_lossy()))}),ctx.clone()).await;
        tokio::fs::remove_dir(&child).await.unwrap();
        let result = shell.execute(&json!({"command":"printf '%s\\n' \"$HALO_CWD_TEST\" \"$PWD\"; pwd -P"}),ctx.clone()).await;
        assert_eq!(result["isError"],false);
        let text = result["content"].as_str().unwrap();
        assert!(text.contains("retained") && text.contains("Running in session directory"));
        assert!(!text.contains(child.to_str().unwrap()));
        assert_eq!(shell.state.lock().await.cwd,ctx.cwd);
        assert_eq!(shell.execute(&json!({"command":"echo recovered"}),ctx).await["content"],"recovered");
        finish(root,shell).await;
    }

    #[tokio::test]
    async fn deleted_current_directory_retains_exports_and_original_cwd_even_if_recreated() {
        let (root,shell,ctx)=fixture().await;
        let child=root.join("child"); tokio::fs::create_dir(&child).await.unwrap();
        let result=shell.execute(&json!({"command":format!("cd {}; export HALO_CWD_TEST=retained; rmdir {}; (exit 7)",quote(&child.to_string_lossy()),quote(&child.to_string_lossy()))}),ctx.clone()).await;
        assert_eq!(result["isError"],true); assert!(result["content"].as_str().unwrap().contains("code 7"));
        { let state=shell.state.lock().await; assert_eq!(state.cwd,ctx.cwd); assert_eq!(state.env["HALO_CWD_TEST"],"retained"); }
        tokio::fs::create_dir(&child).await.unwrap();
        let result=shell.execute(&json!({"command":"echo \"$HALO_CWD_TEST\"; pwd -P"}),ctx.clone()).await;
        assert_eq!(result["isError"],false); assert!(result["content"].as_str().unwrap().contains("retained"));
        assert_eq!(shell.state.lock().await.cwd,ctx.cwd);
        finish(root,shell).await;
    }

    #[tokio::test]
    async fn background_cwd_recovery_is_announced_before_completion() {
        let (root,shell,ctx)=fixture().await;
        let child=root.join("child");tokio::fs::create_dir(&child).await.unwrap();
        shell.execute(&json!({"command":format!("cd {}; export HALO_CWD_TEST=background",quote(&child.to_string_lossy()))}),ctx.clone()).await;
        tokio::fs::remove_dir(&child).await.unwrap();
        let result=shell.execute(&json!({"command":"echo \"$HALO_CWD_TEST\"; pwd -P","run_in_background":true}),ctx.clone()).await;
        assert_eq!(result["isError"],false);assert!(result["content"].as_str().unwrap().contains("Running in session directory"));
        let task=wait(&shell,&result["metadata"]["task_id"],&ctx).await;
        assert_eq!(task["status"],"completed");
        let output=read_preview(&shell,&task,&ctx).await;
        assert!(output["output"].as_str().unwrap().contains("background"));
        assert!(output["output"].as_str().unwrap().contains(&ctx.cwd));
        finish(root,shell).await;
    }

    #[tokio::test]
    async fn task_output_names_the_delivered_preview_range() {
        let (root,shell,ctx)=fixture().await;
        let result=shell.execute(&json!({"command":"/usr/bin/seq 1 12000","run_in_background":true}),ctx.clone()).await;
        assert_eq!(result["isError"],false);
        let task=wait(&shell,&result["metadata"]["task_id"],&ctx).await;
        assert_eq!(task["status"],"completed");
        let output=shell.task("TaskOutput",&json!({"task_id":result["metadata"]["task_id"],"block":false}),&ctx).await;
        assert_eq!(output["isError"],false);
        let value:Value=serde_json::from_str(output["content"].as_str().unwrap()).unwrap();
        let preview=value["task"]["result"].as_str().unwrap();
        assert!(preview.contains("The preview represents 32768 of"));
        assert!(preview.contains("additional captured output is available at"));
        assert!(preview.contains(task["outputFile"].as_str().unwrap()));
        finish(root,shell).await;
    }

    #[tokio::test]
    async fn missing_both_directories_refuses_foreground_and_background_without_effects() {
        for background in [false,true] {
            let (root,shell,ctx)=fixture().await;
            let child=root.join("child");tokio::fs::create_dir(&child).await.unwrap();
            shell.execute(&json!({"command":format!("cd {}",quote(&child.to_string_lossy()))}),ctx.clone()).await;
            tokio::fs::remove_dir_all(&root).await.unwrap();
            let result=shell.execute(&json!({"command":"export HALO_NOT_EXECUTED=yes; echo MUST_NOT_RUN","run_in_background":background}),ctx.clone()).await;
            assert_eq!(result["isError"],true);
            let text=result["content"].as_str().unwrap(); assert!(text.contains("Command not started"));assert!(!text.contains("MUST_NOT_RUN"));
            assert!(!shell.state.lock().await.env.contains_key("HALO_NOT_EXECUTED")); assert!(shell.tasks.lock().unwrap().is_empty());
            shell.close().await;
        }
    }

    #[tokio::test]
    async fn valid_saved_cwd_survives_missing_origin_and_invalid_states_are_redacted() {
        let (root,shell,ctx)=fixture().await;
        let other=root.with_extension("other");tokio::fs::create_dir(&other).await.unwrap();
        shell.execute(&json!({"command":format!("cd {}",quote(&other.to_string_lossy()))}),ctx.clone()).await;
        tokio::fs::remove_dir(&root).await.unwrap();
        let result=shell.execute(&json!({"command":"pwd -P"}),ctx.clone()).await;
        assert_eq!(result["isError"],false);assert!(!result["content"].as_str().unwrap().contains("Running in session directory"));
        assert_eq!(shell.state.lock().await.cwd,other.to_string_lossy());
        tokio::fs::create_dir(&root).await.unwrap();
        shell.state.lock().await.cwd="SECRET=fixture-value".into();
        let result=shell.execute(&json!({"command":"pwd -P"}),ctx.clone()).await;
        assert_eq!(result["isError"],false);let text=result["content"].as_str().unwrap(); assert!(text.contains("invalid_path"));assert!(!text.contains("fixture-value"));assert_eq!(shell.state.lock().await.cwd,ctx.cwd);
        let child=root.join("replacement");tokio::fs::write(&child,"replacement").await.unwrap(); shell.state.lock().await.cwd=child.to_string_lossy().into();
        let result=shell.execute(&json!({"command":"pwd -P"}),ctx.clone()).await;
        assert_eq!(result["isError"],false);assert!(result["content"].as_str().unwrap().contains("not_directory")); assert_eq!(shell.state.lock().await.cwd,ctx.cwd);
        tokio::fs::remove_dir(other).await.unwrap();finish(root,shell).await;
    }
}

#[cfg(all(test, unix))]
mod restore_tests {
    use super::*;

    #[test]
    fn windows_script_path_is_one_quoted_forward_slash_argument() {
        assert_eq!(
            windows_script_argument(Path::new(r"C:\Users\dev{1} x\AppData\Local\Temp\agent-shell-1.sh")),
            "\"C:/Users/dev{1} x/AppData/Local/Temp/agent-shell-1.sh\""
        );
    }

    #[test]
    fn only_zsh_gets_the_option_that_lets_unmatched_globs_through() {
        let state = ShellState { cwd: "/".into(), env: HashMap::new() };
        let script = |shell: &str| wrapper("echo x", shell, &state, None, None, &crate::harness::baseline(), &mut HashMap::new());
        assert!(script("/bin/zsh").starts_with("setopt NO_NOMATCH\n"));
        assert!(script("/usr/local/bin/zsh-5.9").starts_with("setopt NO_NOMATCH\n"));
        assert!(!script("/bin/bash").contains("setopt"));
        assert!(!script("/usr/bin/bash").contains("NO_NOMATCH"));
    }

    #[tokio::test]
    async fn state_file_is_private_and_cleanup_survives_early_return() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("halo-shell-private-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let file = StateFile::create(&directory).unwrap();
        let path = file.path.clone();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        tokio::fs::write(&path, "synthetic environment state")
            .await
            .unwrap();
        drop(file);
        assert!(!path.exists());
        let mut file = StateFile::create(&directory).unwrap();
        let path = file.path.clone();
        file.cleanup().await;
        assert!(!path.exists());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    async fn check_failed_env_dump(shell: &str, emit: &str) {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("halo-shell-env-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let root = tokio::fs::canonicalize(root).await.unwrap();
        let child = root.join("sub");
        tokio::fs::create_dir(&child).await.unwrap();
        let env = root.join("fixture env");
        let program = format!("#!/bin/sh\nprintf '%s\\n' \"$1\" >> emitter-calls\n{emit}\nexit 1\n");
        tokio::fs::write(&env, program).await.unwrap();
        tokio::fs::set_permissions(&env, std::fs::Permissions::from_mode(0o700)).await.unwrap();
        let state = ShellState { cwd: root.to_string_lossy().into_owned(), env: HashMap::new() };
        let file = StateFile::create(&root).unwrap();
        let script = wrapper(
            "cd sub && printf x >> command-calls && export KEEP='first\nPATH=/missing' && (exit 7)",
            shell, &state, None, Some(&file.path), &crate::harness::baseline(), &mut HashMap::new(),
        ).replace("/usr/bin/env", &quote(env.to_str().unwrap()));
        let output = Command::new(shell).args(["-c", &script]).env_clear()
            .env("HOME", &root).env("PATH", "/missing").output().await.unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(tokio::fs::read(child.join("command-calls")).await.unwrap(), b"x");
        assert_eq!(tokio::fs::read(child.join("emitter-calls")).await.unwrap(), b"-0\n");
        let saved = read_state(&file.path).await.unwrap();
        assert_eq!(saved.cwd, child.to_string_lossy());
        assert_eq!(saved.env["KEEP"], "first\nPATH=/missing");
        assert!(!saved.env.contains_key("PARTIAL"));
        drop(file);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn rejecting_env_dump_falls_back_without_rerunning_the_command() {
        check_failed_env_dump("/bin/bash", "").await;
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn partial_env_dump_is_replaced_before_zsh_fallback() {
        check_failed_env_dump("/bin/zsh", "printf 'PARTIAL=discard\\0incomplete'").await;
    }

    #[tokio::test]
    async fn multiline_environment_cannot_replace_path_in_the_next_command() {
        let root = std::env::temp_dir().join(format!("halo-shell-snapshot-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let root = tokio::fs::canonicalize(root).await.unwrap();
        let file = root.join("state");
        let value = "first\nPATH=/missing\nSNAPSHOT_NOT_A_KEY=fixture\n";
        for shell in ["/bin/bash", "/bin/zsh"].into_iter().filter(|shell| Path::new(shell).is_file()) {
            let mut state = ShellState { cwd: root.to_string_lossy().into_owned(), env: HashMap::new() };
            for round in 0..2 {
                let mut env = HashMap::from([("PATH".into(), "/usr/bin:/bin".into()), ("HOME".into(), state.cwd.clone())]);
                if round == 0 {
                    env.insert("Z_DIAGNOSTIC".into(), value.into());
                }
                let script = wrapper("printf '%s\\0%s' \"$PATH\" \"$Z_DIAGNOSTIC\"", shell, &state, None, Some(&file),
                    &crate::harness::baseline(), &mut env);
                let output = Command::new(shell).args(["-c", &script]).env_clear().envs(env).output().await.unwrap();
                assert!(output.status.success());
                assert_eq!(output.stdout, format!("/usr/bin:/bin\0{value}").as_bytes());
                state = read_state(&file).await.unwrap();
                assert_eq!(state.env["PATH"], "/usr/bin:/bin");
                assert_eq!(state.env["Z_DIAGNOSTIC"], value);
                assert!(!state.env.contains_key("SNAPSHOT_NOT_A_KEY"));
            }
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn persisted_values_stay_out_of_argv_and_override_shell_startup() {
        let root =
            std::env::temp_dir().join(format!("halo-shell-restore-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let root = tokio::fs::canonicalize(root).await.unwrap();
        let startup = root.join("startup.sh");
        tokio::fs::write(&startup, "export RESTORED=startup\nexport PATH=/missing\n")
            .await
            .unwrap();
        let marker = "synthetic-argv-marker quote'\" $literal `text`\ncontinuation";
        let state = ShellState {
            cwd: root.to_string_lossy().into_owned(),
            env: HashMap::from([
                ("RESTORED".into(), marker.into()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
        };
        let mut environment = HashMap::from([
            ("HOME".into(), root.to_string_lossy().into_owned()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("BASH_ENV".into(), startup.to_string_lossy().into_owned()),
        ]);
        let file = root.join("state");
        let script = wrapper(
            "if read -r received; then exit 9; fi; printf '%s' \"$RESTORED\"",
            "/bin/bash",
            &state,
            None,
            Some(&file),
            &crate::harness::baseline(),
            &mut environment,
        );
        assert!(!script.contains(marker));
        let output = Command::new("/bin/bash")
            .args(["-c", &script])
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout == marker.as_bytes());
        let restored = read_state(&file).await.unwrap();
        assert_eq!(restored.cwd, state.cwd);
        assert!(restored
            .env
            .get("RESTORED")
            .is_some_and(|value| value == marker));
        assert!(restored
            .env
            .keys()
            .all(|key| !key.starts_with("HALO_SHELL_RESTORE_")));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::*;
    use crate::tools::output::OutputStore;

    const INVALID: &[u8] = &[0xd6, 0xd0, 0xce, 0xc4];
    const PRINT_INVALID: &str = r"printf '\326\320\316\304'";
    const NOTICE: &str = "Some output was not valid UTF-8";

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TempDirectory, ShellTools, ToolContext) {
        let path = std::env::temp_dir().join(format!("halo-shell-encoding-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let directory = TempDirectory(path);
        let options = json!({"persistSession": false, "nativeTempDirectory": directory.path()});
        let shell = ShellTools::new_with_store(&options, None, Some(OutputStore::new(&options)));
        let ctx = ToolContext {
            session_id: uuid::Uuid::new_v4().to_string(),
            cwd: directory.path().to_string_lossy().into_owned(),
            env: json!({}),
            current_turn: 0,
            tool_use_id: String::new(),
            cancellation: CancellationToken::new(),
            harness: crate::harness::baseline(),
        };
        (directory, shell, ctx)
    }

    #[tokio::test]
    async fn foreground_invalid_stdout_saves_exact_bytes_without_replay() {
        let (directory, shell, ctx) = fixture();
        let output = shell.execute(&json!({"command": format!("printf run >> effect; {PRINT_INVALID}")}), ctx).await;
        assert_eq!(output["isError"], false);
        let text = output["content"].as_str().unwrap();
        assert!(text.starts_with("����\n"), "{text}");
        assert_eq!(text.matches(NOTICE).count(), 1, "{text}");
        let path = output["__haloSdkNativeSavedOutput"].as_str().unwrap();
        assert!(text.contains(path), "{text}");
        assert_eq!(tokio::fs::read(path).await.unwrap(), INVALID);
        assert_eq!(tokio::fs::read(directory.path().join("effect")).await.unwrap(), b"run");
        shell.close().await;
    }

    #[tokio::test]
    async fn foreground_checks_stderr_independently_and_preserves_exit_code() {
        let (_directory, shell, ctx) = fixture();
        let command = format!(r"printf '\302\251'; {PRINT_INVALID} >&2; exit 7");
        let output = shell.execute(&json!({"command":command}), ctx).await;
        assert_eq!(output["isError"], true);
        let text = output["content"].as_str().unwrap();
        assert!(text.starts_with("Command exited with code 7\n©\n����\n"), "{text}");
        assert_eq!(text.matches(NOTICE).count(), 1, "{text}");
        let path = output["__haloSdkNativeSavedOutput"].as_str().unwrap();
        assert!(text.contains(path), "{text}");
        let bytes = tokio::fs::read(path).await.unwrap();
        // The shared raw sink can receive either pipe first.
        assert!(bytes == ["©".as_bytes(), INVALID].concat() || bytes == [INVALID, "©".as_bytes()].concat(), "{bytes:?}");
        shell.close().await;
    }

    #[tokio::test]
    async fn foreground_keeps_valid_utf8_including_an_encoded_replacement_character() {
        let (directory, shell, ctx) = fixture();
        let command = r"printf '\344\270\255\346\226\207\360\237\230\200\357\277\275\302\251'";
        let output = shell.execute(&json!({"command":command}), ctx).await;
        assert_eq!(output["isError"], false);
        assert_eq!(output["content"], "中文😀�©");
        assert!(output.get("__haloSdkNativeSavedOutput").is_none());
        assert!(tokio::fs::read_dir(directory.path()).await.unwrap().next_entry().await.unwrap().is_none());
        shell.close().await;
    }

    #[tokio::test]
    async fn task_output_identifies_invalid_utf8_and_points_to_raw_file() {
        let (_directory, shell, ctx) = fixture();
        let launch = shell.execute(&json!({"command":PRINT_INVALID,"run_in_background":true}), ctx.clone()).await;
        assert_eq!(launch["isError"], false, "{}", launch["content"]);
        let output = shell.task("TaskOutput", &json!({"task_id":launch["metadata"]["task_id"]}), &ctx).await;
        assert_eq!(output["isError"], false, "{}", output["content"]);
        let data: Value = serde_json::from_str(output["content"].as_str().unwrap()).unwrap();
        let task = &data["task"];
        assert_eq!(task["status"], "completed");
        assert_eq!(task["exit_code"], 0);
        let text = task["result"].as_str().unwrap();
        assert!(text.starts_with("����\n"), "{text}");
        assert_eq!(text.matches(NOTICE).count(), 1, "{text}");
        let path = task["output_file"].as_str().unwrap();
        assert!(text.contains(path), "{text}");
        assert_eq!(tokio::fs::read(path).await.unwrap(), INVALID);
        shell.close().await;
    }

    async fn wait_for_raw(path: &str, expected: &[u8]) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if tokio::fs::read(path).await.is_ok_and(|bytes| bytes == expected) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        }).await.unwrap();
    }

    async fn task_output(shell: &ShellTools, ctx: &ToolContext, id: &Value, block: bool) -> Value {
        let output = shell.task("TaskOutput", &json!({"task_id": id, "block": block}), ctx).await;
        assert_eq!(output["isError"], false, "{}", output["content"]);
        serde_json::from_str(output["content"].as_str().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn background_preview_decodes_interleaved_stdout_and_stderr_separately() {
        let (directory, shell, ctx) = fixture();
        let command = r"printf '\302'; while [ ! -f first ]; do sleep 0.02; done; printf X >&2; while [ ! -f second ]; do sleep 0.02; done; printf '\251'";
        let launch = shell.execute(&json!({"command": command, "timeout": 20000, "run_in_background": true}), ctx.clone()).await;
        assert_eq!(launch["isError"], false, "{}", launch["content"]);
        let path = launch["metadata"]["output_file"].as_str().unwrap();
        wait_for_raw(path, b"\xc2").await;
        tokio::fs::write(directory.path().join("first"), "").await.unwrap();
        wait_for_raw(path, b"\xc2X").await;
        tokio::fs::write(directory.path().join("second"), "").await.unwrap();
        let output = task_output(&shell, &ctx, &launch["metadata"]["task_id"], true).await;
        assert_eq!(output["task"]["result"], "X©");
        assert_eq!(output["task"]["truncated"], false);
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"\xc2X\xa9");
        shell.close().await;
    }

    #[tokio::test]
    async fn background_preview_never_combines_invalid_bytes_from_different_pipes() {
        let (directory, shell, ctx) = fixture();
        let command = r"printf '\302'; while [ ! -f release ]; do sleep 0.02; done; printf '\251' >&2";
        let launch = shell.execute(&json!({"command": command, "timeout": 20000, "run_in_background": true}), ctx.clone()).await;
        assert_eq!(launch["isError"], false, "{}", launch["content"]);
        let path = launch["metadata"]["output_file"].as_str().unwrap();
        wait_for_raw(path, b"\xc2").await;
        tokio::fs::write(directory.path().join("release"), "").await.unwrap();
        let output = task_output(&shell, &ctx, &launch["metadata"]["task_id"], true).await;
        let text = output["task"]["result"].as_str().unwrap();
        assert!(text.starts_with("��\n"), "{text}");
        assert_eq!(text.matches(NOTICE).count(), 1, "{text}");
        assert!(text.contains(path), "{text}");
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"\xc2\xa9");
        shell.close().await;
    }

    #[tokio::test]
    async fn live_and_stopped_task_previews_do_not_claim_complete_output() {
        let (_directory, shell, ctx) = fixture();
        let command = r"printf '\360\237'; exec sleep 30";
        let launch = shell.execute(&json!({"command": command, "run_in_background": true}), ctx.clone()).await;
        assert_eq!(launch["isError"], false, "{}", launch["content"]);
        let path = launch["metadata"]["output_file"].as_str().unwrap();
        let id = &launch["metadata"]["task_id"];
        wait_for_raw(path, b"\xf0\x9f").await;
        let request = json!([{"id": id}]);
        let native_preview = || shell.context_async_call(
            "backgroundTasks.readOutput", &request, &Value::Null,
            &ctx.cancellation, ctx.harness.clone(),
        );
        let live = task_output(&shell, &ctx, id, false).await;
        let preview = native_preview().await.unwrap();
        assert_eq!(preview["fileComplete"], false);
        assert_eq!(preview["shownBytes"], 0);
        assert_eq!(live["retrieval_status"], "not_ready");
        assert_eq!(live["task"]["truncated"], true);
        let text = live["task"]["result"].as_str().unwrap();
        assert!(text.contains("still being captured"), "{text}");
        assert!(!text.contains('�'), "{text}");
        let stop = shell.task("TaskStop", &json!({"task_id":id}), &ctx).await;
        assert_eq!(stop["isError"], false);
        let stopped = task_output(&shell, &ctx, id, true).await;
        let preview = native_preview().await.unwrap();
        assert_eq!(preview["fileComplete"], false);
        assert_eq!(preview["shownBytes"], 0);
        assert_eq!(stopped["task"]["status"], "stopped");
        assert_eq!(stopped["task"]["truncated"], true);
        let text = stopped["task"]["result"].as_str().unwrap();
        assert!(text.contains("2 bytes"), "{text}");
        assert!(text.contains("inside a multibyte character"), "{text}");
        assert!(text.contains(path), "{text}");
        assert!(!text.contains("file limit") && !text.contains('�'), "{text}");
        shell.close().await;
    }

    #[tokio::test]
    async fn foreground_timeout_preserves_an_incomplete_utf8_tail() {
        let (_directory, shell, ctx) = fixture();
        let output = shell.execute(&json!({"command": r"printf '\360\237'; exec sleep 30", "timeout": 1500}), ctx).await;
        assert_eq!(output["isError"], true);
        let text = output["content"].as_str().unwrap();
        assert!(text.contains("1500ms"), "{text}");
        assert!(text.contains("2 bytes"), "{text}");
        assert!(text.contains("inside a multibyte character"), "{text}");
        assert!(!text.contains("(No output)") && !text.contains('�'), "{text}");
        let path = output["__haloSdkNativeSavedOutput"].as_str().unwrap();
        assert!(text.contains(path), "{text}");
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"\xf0\x9f");
        shell.close().await;
    }

    #[tokio::test]
    async fn encoding_notice_respects_the_result_budget_and_only_keeps_disclosed_files() {
        let (_directory, mut shell, ctx) = fixture();
        shell.result_budget = 512;
        shell.configured_budget = true;
        let output = shell.execute(&json!({"command": format!("{PRINT_INVALID}; printf '%0500d' 0")}), ctx.clone()).await;
        let text = output["content"].as_str().unwrap();
        assert!(crate::js::utf16_len(text) <= 512, "{text}");
        assert!(text.ends_with('.'), "{text}");
        assert!(text.contains(NOTICE), "{text}");
        assert!(text.contains("command output was omitted"), "{text}");
        let path = output["__haloSdkNativeSavedOutput"].as_str().unwrap();
        assert!(text.contains(path), "{text}");
        let mut expected = INVALID.to_vec();
        expected.extend([b'0'; 500]);
        assert_eq!(tokio::fs::read(path).await.unwrap(), expected);

        shell.result_budget = 16;
        let output = shell.execute(&json!({"command": PRINT_INVALID}), ctx).await;
        let text = output["content"].as_str().unwrap();
        assert!(crate::js::utf16_len(text) <= 16, "{text}");
        assert!(!text.contains('�'), "{text}");
        assert!(output.get("__haloSdkNativeSavedOutput").is_none());
        let mut files = tokio::fs::read_dir(Path::new(path).parent().unwrap()).await.unwrap();
        assert_eq!(files.next_entry().await.unwrap().unwrap().path(), Path::new(path));
        assert!(files.next_entry().await.unwrap().is_none());
        shell.close().await;
    }

    #[test]
    fn decoder_preserves_utf8_across_every_multibyte_split() {
        for expected in ["©", "中", "😀", "�"] {
            for split in 1..expected.len() {
                let mut decoder = Utf8Decoder::default();
                let mut text = String::new();
                let (head, tail) = expected.as_bytes().split_at(split);
                decoder.push(head, |part, _| text.push_str(part));
                assert!(text.is_empty());
                decoder.push(tail, |part, _| text.push_str(part));
                assert_eq!(decoder.finish(true, |part, _| text.push_str(part)), (false, 0));
                assert_eq!(text, expected);
            }
        }
    }

    #[test]
    fn decoder_replaces_an_incomplete_sequence_only_at_eof() {
        for (eof, invalid, omitted, expected) in [(true, true, 0, "a�"), (false, false, 2, "a")] {
            let mut decoder = Utf8Decoder::default();
            let mut text = String::new();
            decoder.push(b"a\xf0\x9f", |part, _| text.push_str(part));
            assert_eq!(decoder.finish(eof, |part, _| text.push_str(part)), (invalid, omitted));
            assert_eq!(text, expected);
        }
    }

    #[tokio::test]
    async fn failed_save_does_not_claim_a_path_or_change_success() {
        let (_directory, shell, ctx) = fixture();
        shell.output.as_ref().unwrap().close().await;
        let output = shell.execute(&json!({"command":PRINT_INVALID}), ctx).await;
        assert_eq!(output["isError"], false);
        let text = output["content"].as_str().unwrap();
        assert_eq!(text.matches(NOTICE).count(), 1, "{text}");
        assert!(text.contains("A complete raw copy could not be saved"), "{text}");
        assert!(output.get("__haloSdkNativeSavedOutput").is_none());
        shell.close().await;
    }

    #[test]
    fn file_limit_labels_raw_output_as_a_prefix() {
        let mut preview = BackgroundPreview::new(64);
        preview.push(0, "�", 1);
        preview.push(0, "a", 1);
        preview.pipes[0].invalid_utf8 = true;
        preview.pipes[0].eof = Some(true);
        preview.pipes[1].eof = Some(true);
        preview.file_limited = true;
        let output = preview.render("limited.output", false, &crate::harness::baseline());
        let text = output["output"].as_str().unwrap();
        assert!(text.starts_with("�a\n"), "{text}");
        assert!(text.contains("Only a captured prefix"), "{text}");
        assert!(text.contains("limited.output"), "{text}");
        assert!(text.contains("8388608-byte file limit"), "{text}");
        assert_eq!(output["shownBytes"], 2);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["fileComplete"], false);
    }

    #[test]
    fn capture_window_keeps_or_omits_whole_characters() {
        let harness = crate::harness::baseline();
        let prefix = "a".repeat(32767);
        let mut capture = Capture::default();
        capture.push(&prefix);
        capture.push("😀");
        assert_eq!(capture.text(&harness), format!("{prefix}😀"));

        let mut capture = Capture::default();
        capture.push(&prefix);
        capture.push("😀😀");
        capture.push(&"z".repeat(32767));
        let text = capture.text(&harness);
        assert!(text.starts_with(&prefix));
        assert!(text.ends_with(&"z".repeat(32767)));
        assert!(!text.contains('�'));
    }

    #[test]
    fn preview_byte_cap_does_not_replace_part_of_a_valid_character() {
        for cap in 2..=4 {
            let mut preview = BackgroundPreview::new(cap);
            preview.push(0, "a😀", 5);
            preview.push(1, "z", 1);
            preview.pipes[0].received = 5;
            preview.pipes[1].received = 1;
            preview.pipes[0].eof = Some(true);
            preview.pipes[1].eof = Some(true);
            let output = preview.render("preview.output", false, &crate::harness::baseline());
            let text = output["output"].as_str().unwrap();
            assert!(text.starts_with("a\n"), "{text}");
            assert!(!text.contains('�') && !text.contains(NOTICE), "{text}");
            assert!(text.contains("1 of 6 captured bytes"), "{text}");
            assert_eq!(output["truncated"], true);
            assert_eq!(output["fileComplete"], true);
            assert_eq!(output["shownBytes"], 1);
        }
    }
}

#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
    invalid: bool,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8], mut emit: impl FnMut(&str, usize)) {
        let mut input = if self.pending.is_empty() {
            bytes
        } else {
            self.pending.extend_from_slice(bytes);
            &self.pending
        };
        let mut trailing = [0; 3];
        let mut trailing_len = 0;
        while !input.is_empty() {
            match std::str::from_utf8(input) {
                Ok(text) => {
                    emit(text, text.len());
                    break;
                }
                Err(error) => {
                    let (valid, rest) = input.split_at(error.valid_up_to());
                    if !valid.is_empty() {
                        emit(std::str::from_utf8(valid).expect("validated UTF-8 prefix"), valid.len());
                    }
                    if let Some(length) = error.error_len() {
                        self.invalid = true;
                        emit("�", length);
                        input = &rest[length..];
                    } else {
                        trailing_len = rest.len();
                        trailing[..trailing_len].copy_from_slice(rest);
                        break;
                    }
                }
            }
        }
        self.pending.clear();
        self.pending.extend_from_slice(&trailing[..trailing_len]);
    }

    fn finish(self, eof: bool, mut emit: impl FnMut(&str, usize)) -> (bool, usize) {
        if eof && !self.pending.is_empty() {
            emit("�", self.pending.len());
            (true, 0)
        } else {
            (self.invalid, self.pending.len())
        }
    }
}

#[derive(Default)]
struct Capture {
    head: Vec<u16>,
    tail: Vec<u16>,
    omitted: usize,
}
impl Capture {
    fn push(&mut self, s: &str) {
        let units: Vec<u16> = s.encode_utf16().collect();
        let head = (32768 - self.head.len()).min(units.len());
        self.head.extend_from_slice(&units[..head]);
        self.tail.extend_from_slice(&units[head..]);
        if self.tail.len() > 32768 {
            let excess = self.tail.len() - 32768;
            self.tail.drain(..excess);
            self.omitted += excess;
        }
    }
    fn text(self, harness: &ResolvedHarness) -> String {
        let mut head = self.head.as_slice();
        let mut tail = self.tail.as_slice();
        let split_head = head.last().is_some_and(|unit| (0xd800..=0xdbff).contains(unit));
        if self.omitted == 0 {
            if split_head {
                return char::decode_utf16(self.head.into_iter().chain(self.tail))
                    .map(|character| character.expect("captured text came from Unicode"))
                    .collect();
            }
            return format!("{}{}", String::from_utf16_lossy(head), String::from_utf16_lossy(tail));
        }
        if split_head {
            head = &head[..head.len() - 1];
        }
        if tail.first().is_some_and(|unit| (0xdc00..=0xdfff).contains(unit)) {
            tail = &tail[1..];
        }
        let omitted = self.omitted + self.head.len() - head.len() + self.tail.len() - tail.len();
        let marker = harness.render(
            TextId::ToolsShellCaptureOmitted,
            &[("omitted", &omitted.to_string())],
        );
        format!("{}{marker}{}", String::from_utf16_lossy(head), String::from_utf16_lossy(tail))
    }
}
struct Drained {
    text: String,
    omitted: bool,
    invalid_utf8: bool,
    withheld: usize,
    eof: bool,
}

const BACKGROUND_FILE_LIMIT: usize = 8 * 1024 * 1024;
const BACKGROUND_PREVIEW_LIMIT: usize = 32 * 1024;

#[derive(Default)]
struct PipePreview {
    received: usize,
    shown: usize,
    withheld: usize,
    invalid_utf8: bool,
    eof: Option<bool>,
}

struct BackgroundPreview {
    text: String,
    pipes: [PipePreview; 2],
    cap: usize,
    display_cut: bool,
    file_limited: bool,
    save_failed: bool,
}

impl BackgroundPreview {
    fn new(cap: usize) -> Self {
        Self {
            text: String::new(),
            pipes: Default::default(),
            cap,
            display_cut: false,
            file_limited: false,
            save_failed: false,
        }
    }

    fn push(&mut self, pipe: usize, text: &str, raw_bytes: usize) {
        if self.display_cut {
            return;
        }
        let mut end = self.cap.saturating_sub(self.text.len()).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        self.display_cut = end < text.len();
        self.text.push_str(&text[..end]);
        self.pipes[pipe].shown += if self.display_cut { end } else { raw_bytes };
    }

    fn render(&self, path: &str, running: bool, harness: &ResolvedHarness) -> Value {
        use super::output::SaveReason;
        let received: usize = self.pipes.iter().map(|pipe| pipe.received).fold(0, usize::saturating_add);
        let shown: usize = self.pipes.iter().map(|pipe| pipe.shown).sum();
        let withheld = self.pipes.iter().filter(|pipe| pipe.eof == Some(false)).map(|pipe| pipe.withheld).sum();
        let incomplete = !running && self.pipes.iter().any(|pipe| pipe.eof != Some(true));
        let invalid = self.pipes.iter().any(|pipe| pipe.invalid_utf8);
        let file_complete = !(running || incomplete || self.file_limited || self.save_failed);
        let shown_bytes = shown.to_string();
        let mut text = self.text.clone();
        let mut append = |line: &str| {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(line);
        };
        if let Some(notice) = encoding_notice(harness, invalid, withheld,
            (!self.save_failed).then(|| Path::new(path)), file_complete,
            self.save_failed.then_some(SaveReason::WriteFailed)) {
            append(&notice);
        }
        if running {
            append(&harness.render(TextId::ToolsShellTaskOutputLive, &[("shown_bytes", &shown_bytes)]));
        } else if incomplete && withheld == 0 {
            append(&harness.render(TextId::ToolsShellTaskOutputCaptureEnded, &[("shown_bytes", &shown_bytes)]));
        }
        if self.save_failed {
            append(harness.text(TextId::ToolsShellTaskOutputSaveUnconfirmed));
        } else if self.file_limited {
            append(&harness.render(TextId::ToolsShellTaskOutputFileLimit, &[
                ("shown_bytes", &shown_bytes), ("path", path), ("byte_limit", &BACKGROUND_FILE_LIMIT.to_string()),
            ]));
        } else if self.display_cut && file_complete {
            append(&harness.render(TextId::ToolsShellTaskOutputPreviewCut, &[
                ("shown_bytes", &shown_bytes), ("received_bytes", &received.to_string()), ("path", path),
            ]));
        }
        json!({"output": text, "truncated": self.display_cut || !file_complete,
            "shownBytes": shown, "fileComplete": file_complete, "noticesIncluded": true})
    }
}

struct CaptureSinkState {
    pending: Vec<u8>,
    total: usize,
    writer: Option<super::output::OutputWriter>,
    failed: Option<super::output::SaveReason>,
}
struct CaptureSink {
    state: Mutex<CaptureSinkState>,
    store: Arc<super::output::OutputStore>,
    threshold: usize,
    marker: Option<String>,
}
impl CaptureSink {
    fn new(
        store: Arc<super::output::OutputStore>,
        threshold: usize,
        marker: Option<String>,
    ) -> Self {
        Self {
            state: Mutex::new(CaptureSinkState {
                pending: Vec::new(),
                total: 0,
                writer: None,
                failed: None,
            }),
            store,
            threshold,
            marker,
        }
    }
    async fn push(&self, bytes: &[u8]) {
        let mut state = self.state.lock().await;
        if state.failed.is_some() {
            return;
        }
        state.total = state.total.saturating_add(bytes.len());
        if state.writer.is_some() {
            state.writer.as_mut().unwrap().write_bytes(bytes).await;
            return;
        }
        if state.total < self.threshold {
            state.pending.extend_from_slice(bytes);
            return;
        }
        match self.store.begin("bash", self.marker.clone()).await {
            Ok(writer) => {
                state.writer = Some(writer);
                let pending = std::mem::take(&mut state.pending);
                let mut writer = state.writer.take().unwrap();
                writer.write_bytes(&pending).await;
                writer.write_bytes(bytes).await;
                state.writer = Some(writer);
            }
            Err(reason) => {
                state.failed = Some(reason);
                state.pending.clear();
            }
        }
    }
    async fn finish(&self, force_save: bool, complete: bool) -> Option<super::output::SaveState> {
        use super::output::{SaveReason, SaveState};
        let mut state = self.state.lock().await;
        let mut writer = match state.writer.take() {
            Some(writer) => writer,
            None => {
                if let Some(reason) = state.failed {
                    return Some(SaveState::Failed { reason });
                }
                if !force_save {
                    return (!complete).then_some(SaveState::Failed { reason: SaveReason::UnsafeCopy });
                }
                match self.store.begin("bash", self.marker.clone()).await {
                    Ok(mut writer) => {
                        writer.write_bytes(&state.pending).await;
                        writer
                    }
                    Err(reason) => return Some(SaveState::Failed { reason }),
                }
            }
        };
        if !complete {
            writer.mark_incomplete(SaveReason::UnsafeCopy);
        }
        Some(writer.finish().await)
    }
}
/// Collects one output pipe until EOF, or until `detach` fires because processes that survived
/// forced termination still hold it; the pipe is then closed.
async fn drain<R: AsyncRead + Unpin>(
    mut reader: R,
    output: Option<Arc<Mutex<PersistedOutput>>>,
    sink: Option<Arc<CaptureSink>>,
    cancel: CancellationToken,
    harness: Arc<ResolvedHarness>,
    _activity: Option<crate::resource_activity::ResourceLease>,
    detach: CancellationToken,
    stopping: CancellationToken,
    pipe: usize,
) -> Drained {
    let mut buffer = [0u8; 8192];
    let mut decoder = Utf8Decoder::default();
    let mut capture = Capture::default();
    let eof = loop {
        let read = tokio::select! {
            read = reader.read(&mut buffer) => Some(read),
            _ = detach.cancelled() => None,
        };
        let Some(read) = read else {
            break false;
        };
        let count = match read {
            Ok(0) => break !stopping.is_cancelled(),
            Ok(n) => n,
            Err(error) => {
                tracing::warn!(error=%error,"command output read failed");
                break false;
            }
        };
        let bytes = &buffer[..count];
        if let Some(output) = &output {
            let mut state = output.lock().await;
            let saved = state.push(bytes).await;
            // Publish decoded fragments in capture order, releasing split characters only when complete.
            let mut preview = state.preview.lock().unwrap_or_else(|error| error.into_inner());
            decoder.push(bytes, |text, raw_bytes| preview.push(pipe, text, raw_bytes));
            let stream = &mut preview.pipes[pipe];
            stream.received = stream.received.saturating_add(count);
            stream.invalid_utf8 = decoder.invalid;
            stream.withheld = decoder.pending.len();
            preview.save_failed = !saved;
            preview.file_limited = state.truncated;
            if !saved {
                cancel.cancel();
                break false;
            }
        } else {
            if let Some(sink) = &sink {
                sink.push(bytes).await;
            }
            decoder.push(bytes, |text, _| capture.push(text));
        }
    };
    let (invalid_utf8, withheld) = if let Some(output) = &output {
        let state = output.lock().await;
        let mut preview = state.preview.lock().unwrap_or_else(|error| error.into_inner());
        let (invalid_utf8, withheld) = decoder.finish(eof, |text, raw_bytes| preview.push(pipe, text, raw_bytes));
        let stream = &mut preview.pipes[pipe];
        stream.invalid_utf8 = invalid_utf8;
        stream.withheld = withheld;
        stream.eof = Some(eof);
        (invalid_utf8, withheld)
    } else {
        decoder.finish(eof, |text, _| capture.push(text))
    };
    Drained {
        omitted: capture.omitted > 0,
        text: capture.text(&harness),
        invalid_utf8,
        withheld,
        eof,
    }
}
/// How long a terminated command may take to exit and close its output before termination escalates.
const TERMINATION_GRACE: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(5)
};
async fn settle<P: std::future::Future, E: std::future::Future>(
    pipes: &mut std::pin::Pin<&mut P>,
    exit: &mut std::pin::Pin<&mut E>,
    output: &mut Option<P::Output>,
    status: &mut Option<E::Output>,
) {
    // The shell is reaped only after its output closes, so its process group can still be signalled.
    if output.is_none() {
        *output = Some(pipes.as_mut().await);
    }
    if status.is_none() {
        *status = Some(exit.as_mut().await);
    }
}
/// Git for Windows' runtime silently truncates a long argument, so there the script goes in a file.
fn script_in_file(ctx: &ToolContext) -> bool {
    #[cfg(test)]
    if ctx.env.get("AGENT_TEST_SCRIPT_FILE").is_some() {
        return true;
    }
    let _ = ctx;
    cfg!(windows)
}
fn script_argument(cmd: &mut Command, shell: &str, path: &Path) {
    #[cfg(windows)]
    {
        // A batch file runs under cmd.exe, which needs the standard library's escaping instead.
        let batch = Path::new(shell).extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
        if !batch {
            cmd.raw_arg(windows_script_argument(path));
            return;
        }
    }
    let _ = shell;
    cmd.arg(path);
}
struct RunResult {
    pid: u32,
    code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
    aborted: bool,
    started: Started,
    unconfirmed: bool,
    omitted: bool,
    invalid_utf8: bool,
    withheld: usize,
    state: Option<ShellState>,
    saved: Option<super::output::SaveState>,
}
async fn run(
    command: &str,
    state: ShellState,
    ctx: &ToolContext,
    timeout: Option<u64>,
    cancel: CancellationToken,
    output: Option<Arc<Mutex<PersistedOutput>>>,
    launch: Option<oneshot::Sender<Result<u32, Error>>>,
    processes: Arc<crate::processes::OwnedProcesses>,
    base_environment: Value,
    temporary_directory: PathBuf,
    activity: Option<Arc<crate::resource_activity::ResourceActivity>>,
    sink: Option<Arc<CaptureSink>>,
) -> Result<RunResult, Error> {
    let (state, warning) = resolve_directory(state, &ctx.cwd).await?;
    let warning = warning
        .map(|warning| format!("{}\n", warning.render(&ctx.harness)))
        .unwrap_or_default();
    let mut defaults = json!({"AGENT_MODE":"1","GIT_EDITOR":"true"});
    if !crate::js::truthy(&base_environment["LC_ALL"])
        && !crate::js::truthy(&base_environment["LANG"])
    {
        defaults["LC_ALL"] = json!("C.UTF-8");
        defaults["LANG"] = json!("C.UTF-8");
    }
    let mut environment = crate::core::conventions::merged_environment(
        &base_environment,
        &[&defaults, &ctx.env],
        cfg!(windows),
    );
    let shell = shell_path(&json!(environment))?;
    if command.contains('\0') {
        return Err(Error::from(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "nul byte found in provided data",
        )));
    }
    let background = output.is_some();
    let mut start_file = StateFile::create_with(&temporary_directory, "start", PENDING.as_bytes()).map_err(|error| {
        tracing::warn!(session_id=%ctx.session_id,tool_use_id=%ctx.tool_use_id,error=%error,
            "shell private start record creation failed");
        Error::from(error)
    })?;
    let mut state_file = if background {
        None
    } else {
        Some(StateFile::create(&temporary_directory).map_err(|error| {
            tracing::warn!(session_id=%ctx.session_id,tool_use_id=%ctx.tool_use_id,error=%error,
                "shell private state file creation failed");
            Error::from(error)
        })?)
    };
    let script = wrapper(
        command,
        &shell,
        &state,
        Some(&start_file.path),
        state_file.as_ref().map(|file| file.path.as_path()),
        &ctx.harness,
        &mut environment,
    );
    let mut script_file = if script_in_file(ctx) {
        Some(
            StateFile::create_with(&temporary_directory, "sh", script.as_bytes()).map_err(|error| {
                tracing::warn!(session_id=%ctx.session_id,tool_use_id=%ctx.tool_use_id,error=%error,
                    "shell private script file creation failed");
                Error::from(error)
            })?,
        )
    } else {
        None
    };
    let mut cmd = Command::new(&shell);
    match &script_file {
        Some(file) => script_argument(&mut cmd, &shell, &file.path),
        None => {
            cmd.arg("-c").arg(&script);
        }
    }
    cmd.current_dir(&state.cwd)
        .stdin(Stdio::null())
        .env_clear()
        .envs(&environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = Error::from(error);
            if let Some(launch) = launch {
                let _ = launch.send(Err(message.clone()));
            }
            return Err(message);
        }
    };
    let pid = child.id().unwrap();
    let stdout_pipe = child.stdout.take().unwrap();
    let stderr_pipe = child.stderr.take().unwrap();
    let stdout_activity = background
        .then(|| activity.as_ref().map(|activity| activity.lease()))
        .flatten();
    let stderr_activity = background
        .then(|| activity.as_ref().map(|activity| activity.lease()))
        .flatten();
    let owned_process = processes.track(child, cfg!(unix));
    if let Some(launch) = launch {
        let _ = launch.send(Ok(pid));
    }
    let detach = CancellationToken::new();
    let stopping = CancellationToken::new();
    let stdout = crate::runtime::spawn(drain(
        stdout_pipe,
        output.clone(),
        sink.clone(),
        cancel.clone(),
        ctx.harness.clone(),
        stdout_activity,
        detach.clone(),
        stopping.clone(),
        0,
    ));
    let stderr = crate::runtime::spawn(drain(
        stderr_pipe,
        output,
        sink.clone(),
        cancel.clone(),
        ctx.harness.clone(),
        stderr_activity,
        detach.clone(),
        stopping.clone(),
        1,
    ));
    let mut timed_out = false;
    let mut aborted = false;
    let deadline = async {
        match timeout {
            Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending().await,
        }
    };
    let pipes = async { tokio::join!(stdout, stderr) };
    tokio::pin!(pipes);
    let exit = owned_process.wait();
    tokio::pin!(exit);
    let mut output = None;
    let mut status = None;
    let finished = tokio::select! {
        _ = settle(&mut pipes, &mut exit, &mut output, &mut status) => true,
        _ = cancel.cancelled() => { aborted = true; false },
        _ = deadline => { timed_out = true; false },
    };
    let mut unconfirmed = false;
    if !finished {
        stopping.cancel();
        #[cfg(windows)]
        let terminate = |force| {
            super::shell_platform::terminate_windows_shell(&owned_process, Path::new(&shell), force)
        };
        #[cfg(not(windows))]
        let terminate = |force| {
            let process = &owned_process;
            async move {
                process.terminate(force).await;
                None::<bool>
            }
        };
        unconfirmed = terminate(background).await == Some(false);
        let settled = tokio::time::timeout(
            TERMINATION_GRACE,
            settle(&mut pipes, &mut exit, &mut output, &mut status),
        )
        .await
        .is_ok();
        if !settled || unconfirmed {
            if let Some(confirmed) = terminate(true).await {
                unconfirmed = !confirmed;
            }
            let settled = tokio::time::timeout(
                TERMINATION_GRACE,
                settle(&mut pipes, &mut exit, &mut output, &mut status),
            )
            .await
            .is_ok();
            if !settled {
                unconfirmed = true;
                tracing::warn!(session_id=%ctx.session_id,tool_use_id=%ctx.tool_use_id,pid,background,
                    "command processes still running after forced termination");
                detach.cancel();
                if output.is_none() {
                    output = Some(pipes.as_mut().await);
                }
            }
        }
    }
    let (stdout, stderr) = output.expect("output is collected or detached");
    let status = status.unwrap_or_else(|| {
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "process did not exit after forced termination",
        ))
    });
    let omitted = [&stdout, &stderr]
        .iter()
        .any(|pipe| matches!(pipe, Ok(drained) if drained.omitted));
    let invalid_utf8 = [&stdout, &stderr]
        .iter()
        .any(|pipe| matches!(pipe, Ok(drained) if drained.invalid_utf8));
    let withheld = [&stdout, &stderr]
        .iter()
        .filter_map(|pipe| pipe.as_ref().ok().map(|drained| drained.withheld))
        .sum();
    let capture_complete = [&stdout, &stderr]
        .iter()
        .all(|pipe| matches!(pipe, Ok(drained) if drained.eof));
    let stdout = stdout.map(|drained| drained.text);
    let stderr = stderr.map(|drained| drained.text);
    let stdout = stdout.map_err(|e| {
        Error::template(
            "SHELL_CAPTURE",
            TextId::ToolsShellStdoutFailed,
            &[("error", e.to_string().into())],
        )
    })?;
    let stderr = format!(
        "{warning}{}",
        stderr.map_err(|e| Error::template(
            "SHELL_CAPTURE",
            TextId::ToolsShellStderrFailed,
            &[("error", e.to_string().into())]
        ))?
    );
    if let Some(file) = &mut script_file {
        file.cleanup().await;
    }
    let started = read_start(&start_file.path).await;
    start_file.cleanup().await;
    let parsed = match &mut state_file {
        Some(file) => {
            let parsed = if started == Started::Yes {
                read_state(&file.path).await
            } else {
                None
            };
            file.cleanup().await;
            parsed
        }
        None => None,
    };
    match started {
        Started::No if !timed_out && !aborted => {
            tracing::warn!(session_id=%ctx.session_id,tool_use_id=%ctx.tool_use_id,background,
                script_chars=script.len(),"command not started: shell ended before reaching it")
        }
        Started::Unknown => {
            tracing::warn!(session_id=%ctx.session_id,tool_use_id=%ctx.tool_use_id,background,
                "command start unconfirmed: start record missing")
        }
        _ => {}
    }
    let saved = match sink {
        Some(sink) => sink.finish(invalid_utf8 || withheld > 0, capture_complete).await,
        None => None,
    };
    Ok(RunResult {
        pid,
        code: if timed_out {
            124
        } else if aborted {
            130
        } else {
            status.ok().and_then(|s| s.code()).unwrap_or(128)
        },
        stdout,
        stderr,
        timed_out,
        aborted,
        started,
        unconfirmed,
        omitted,
        invalid_utf8,
        withheld,
        state: parsed,
        saved,
    })
}
/// Git for Windows' runtime rewrites its command line: unquoted braces and tildes are expanded and a
/// doubled backslash collapses even inside quotes. A double-quoted forward-slash path passes through
/// verbatim; Windows paths cannot contain a double quote.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_script_argument(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('\\', "/"))
}
fn stored_message(value: &Value) -> Message {
    serde_json::from_value::<Message>(value.clone())
        .unwrap_or_else(|_| crate::js::to_string(value).into())
}
fn render_error(value: &Value, harness: &ResolvedHarness) -> Value {
    if value.is_null() {
        Value::Null
    } else {
        json!(stored_message(value).render(harness))
    }
}
fn budget_label(harness: &ResolvedHarness, limit: usize, configured: bool) -> String {
    let id = if configured {
        TextId::ToolsOutputBudgetConfigured
    } else {
        TextId::ToolsOutputBudgetPreview
    };
    harness.render(id, &[("character_limit", &limit.to_string())])
}

fn saved_notice(
    saved: Option<&super::output::SaveState>,
    budget: &str,
    harness: &ResolvedHarness,
) -> String {
    match saved {
        Some(super::output::SaveState::Complete { path, .. }) => harness.render(
            TextId::ToolsShellOutputReached,
            &[("budget", budget), ("path", &path.to_string_lossy())],
        ),
        Some(super::output::SaveState::Partial {
            path,
            bytes,
            reason,
        }) => harness.render(
            TextId::ToolsShellOutputReachedPartial,
            &[
                ("budget", budget),
                ("path", &path.to_string_lossy()),
                ("saved_bytes", &bytes.to_string()),
                ("reason", &reason.render(harness)),
            ],
        ),
        Some(super::output::SaveState::Failed { reason }) => harness.render(
            TextId::ToolsShellOutputReachedNoSave,
            &[("budget", budget), ("reason", &reason.render(harness))],
        ),
        None => harness.render(
            TextId::ToolsShellOutputReachedNoSave,
            &[
                ("budget", budget),
                ("reason", harness.text(TextId::ToolsOutputReasonUnavailable)),
            ],
        ),
    }
}

fn encoding_notice(
    harness: &ResolvedHarness,
    invalid_utf8: bool,
    withheld: usize,
    path: Option<&Path>,
    complete: bool,
    reason: Option<super::output::SaveReason>,
) -> Option<String> {
    let issue = match (invalid_utf8, withheld) {
        (false, 0) => return None,
        (true, 0) => harness.text(TextId::ToolsShellInvalidUtf8).to_owned(),
        (false, bytes) => harness.render(TextId::ToolsShellWithheldUtf8, &[("bytes", &bytes.to_string())]),
        (true, bytes) => format!("{} {}", harness.text(TextId::ToolsShellInvalidUtf8),
            harness.render(TextId::ToolsShellWithheldUtf8, &[("bytes", &bytes.to_string())])),
    };
    Some(match path {
        Some(path) => harness.render(
            if complete { TextId::ToolsShellEncodingSaved } else { TextId::ToolsShellEncodingPrefix },
            &[("issue", &issue), ("path", &path.to_string_lossy())],
        ),
        None => harness.render(
            TextId::ToolsShellEncodingNoSave,
            &[("issue", &issue), ("reason", &reason.unwrap_or(super::output::SaveReason::NoLocation).render(harness))],
        ),
    })
}

fn fit_shell_text(
    prefix: &str,
    suffix: &str,
    output: &str,
    budget: usize,
    label: &str,
    notice: &str,
    harness: &ResolvedHarness,
) -> String {
    let fixed = crate::js::utf16_len(prefix)
        .saturating_add(crate::js::utf16_len(suffix))
        .saturating_add(crate::js::utf16_len(output));
    if notice.is_empty() && fixed <= budget {
        return format!("{prefix}{output}{suffix}");
    }
    // Output that fits is shown once, followed by the notice, rather than split into overlapping halves.
    if fixed.saturating_add(crate::js::utf16_len(notice)).saturating_add(1) <= budget {
        return format!("{prefix}{output}\n{notice}{suffix}");
    }
    let reserve = crate::js::utf16_len(prefix)
        .saturating_add(crate::js::utf16_len(suffix))
        .saturating_add(crate::js::utf16_len(notice))
        .saturating_add(2);
    if reserve >= budget {
        let short = harness.render(TextId::ToolsOutputShort, &[("budget", label)]);
        if crate::js::utf16_len(&short) <= budget {
            return short;
        }
        if budget == 0 {
            return String::new();
        }
        return crate::js::utf16_prefix(
            harness.text(TextId::ContextTruncationMarker),
            budget,
        );
    }
    let available = budget - reserve;
    let head = crate::js::utf16_prefix_without_split(output, available / 2);
    let tail = crate::js::utf16_suffix(output, available - available / 2);
    format!("{prefix}{head}\n{notice}\n{tail}{suffix}")
}

impl ShellTools {
    pub(super) fn process_registry(&self) -> Arc<crate::processes::OwnedProcesses> {
        self.processes.clone()
    }
    #[cfg(test)]
    pub fn new_with_activity(
        options: &Value,
        activity: Option<Arc<crate::resource_activity::ResourceActivity>>,
    ) -> Self {
        Self::new_with_store(options, activity, None)
    }
    pub fn new_with_store(
        options: &Value,
        activity: Option<Arc<crate::resource_activity::ResourceActivity>>,
        output: Option<Arc<super::output::OutputStore>>,
    ) -> Self {
        let persistent = options["persistSession"] != false;
        let configured = options["toolResultBudget"].as_u64();
        let result_budget = configured
            .map(|value| value.min(50_000) as usize)
            .unwrap_or(50_000);
        let directory =
            persistent.then(|| PathBuf::from(super::config_dir(options)).join("bash-output"));
        Self {
            directory: Mutex::new(directory),
            persistent,
            base_environment: crate::core::conventions::process_environment(options),
            temporary_directory: crate::core::conventions::temp_dir(options),
            activity,
            output,
            result_budget,
            configured_budget: configured.is_some_and(|value| value < 50_000),
            ..Self::default()
        }
    }
    pub fn abort_now(&self) {
        self.begin_close();
        self.processes.abort_now();
    }
    pub async fn drain_notices(&self, harness: &ResolvedHarness) -> Vec<String> {
        self.notices
            .lock()
            .await
            .drain(..)
            .map(|notice| utf16_prefix(&notice.render(harness), 4096))
            .collect()
    }
    pub fn active_count(&self) -> usize {
        let tasks: Vec<_> = self
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .cloned()
            .collect();
        let mut active = 0;
        for task in tasks {
            if task.value.lock().unwrap_or_else(|error| error.into_inner())["ended_at"].is_null() {
                active += 1;
            }
        }
        active + self.starting.load(Ordering::Acquire)
    }
    pub fn stop(&self, id: &str, reason: Message) -> bool {
        let task = self
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .cloned();
        let Some(task) = task else { return false };
        let mut value = task.value.lock().unwrap_or_else(|error| error.into_inner());
        if value["status"] != "running" {
            return false;
        }
        if task.settling.load(Ordering::Acquire) {
            return true;
        }
        value["status"] = json!("stopped");
        value["error"] = json!(reason);
        task.cancel.cancel();
        true
    }
    fn public_task(task: &Task, harness: &ResolvedHarness) -> Value {
        let value = task.value.lock().unwrap_or_else(|error| error.into_inner());
        let timestamp = |field: &str| {
            value[field]
                .as_str()
                .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
                .map(|date| json!(date.timestamp_millis()))
                .unwrap_or(Value::Null)
        };
        let mut public = json!({"id":value["task_id"],"command":value["description"],"status":value["status"],"outputFile":value["output_file"],"exitCode":value["exit_code"],"error":render_error(&value["error"],harness),"startedAt":timestamp("started_at"),"completedAt":timestamp("ended_at")});
        let pid = task.pid.load(Ordering::Acquire);
        if pid != 0 {
            public["pid"] = json!(pid);
        }
        if let Some(warning) = &task.cwd_warning {
            public["cwdWarning"] = json!(warning.render(harness));
        }
        if value["truncated"] == true {
            public["outputTruncated"] = json!(true);
        }
        public
    }
    pub fn context_call(
        &self,
        method: &str,
        args: &Value,
        harness: &ResolvedHarness,
    ) -> crate::error::Result<Value> {
        use crate::error::Error;
        match method {
            "backgroundTasks.activeCount" => Ok(json!(if self.lifetime.is_cancelled() {
                0
            } else {
                self.active_count()
            })),
            "backgroundTasks.get" | "backgroundTasks.snapshot" => {
                if method == "backgroundTasks.get" && self.lifetime.is_cancelled() {
                    return Ok(Value::Null);
                }
                let id = args[0].as_str().unwrap_or("");
                Ok(self
                    .tasks
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(id)
                    .map(|task| Self::public_task(task, harness))
                    .unwrap_or(Value::Null))
            }
            "backgroundTasks.getAll" => {
                if self.lifetime.is_cancelled() {
                    return Ok(json!([]));
                }
                let mut tasks: Vec<_> = self
                    .tasks
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .values()
                    .cloned()
                    .collect();
                tasks.sort_by_key(|task| task.sequence);
                Ok(Value::Array(
                    tasks
                        .iter()
                        .map(|task| Self::public_task(task, harness))
                        .collect(),
                ))
            }
            "backgroundTasks.stop" => Ok(json!(self.stop(
                args[0].as_str().unwrap_or(""),
                Message::template(TextId::ToolsShellStopped, &[])
            ))),
            "backgroundTasks.stopAll" => {
                self.stop_all(Message::template(TextId::ToolsShellInterrupted, &[]));
                Ok(Value::Null)
            }
            _ => Err(Error::template(
                "INVALID_TOOL_CONTEXT",
                TextId::ToolsShellUnknownOperation,
                &[("method", method.into())],
            )),
        }
    }
    pub fn begin_close(&self) {
        self.stop_all(Message::template(TextId::ToolsShellClosed, &[]));
        self.lifetime.cancel();
    }
    fn stop_all(&self, reason: Message) {
        let tasks: Vec<_> = self
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .cloned()
            .collect();
        for id in tasks {
            self.stop(&id, reason.clone());
        }
    }
    fn background_preview_limit(&self) -> usize {
        if self.configured_budget {
            self.result_budget.saturating_sub(2048).min(BACKGROUND_PREVIEW_LIMIT)
        } else {
            BACKGROUND_PREVIEW_LIMIT
        }
    }

    fn lookup_task(&self, id: &str) -> Option<Arc<Task>> {
        self.tasks.lock().unwrap_or_else(|error| error.into_inner()).get(id).cloned()
    }

    async fn read_output(
        task: Option<&Task>,
        path: &str,
        running: bool,
        harness: &ResolvedHarness,
    ) -> std::result::Result<Value, String> {
        use std::io::ErrorKind;
        let missing = |output: String| json!({
            "output": output, "truncated": true, "shownBytes": 0,
            "fileComplete": false, "noticesIncluded": true
        });
        match tokio::fs::metadata(path).await {
            Ok(metadata) if metadata.is_file() => {},
            Ok(_) => return Err(std::io::Error::from(ErrorKind::InvalidData).to_string()),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                tracing::warn!("command output is no longer retained");
                return Ok(missing(harness.text(TextId::ToolsShellOutputExpired).into()));
            }
            Err(error) => return Err(error.to_string()),
        }
        let Some(task) = task else {
            tracing::warn!("decoded command preview is no longer retained");
            return Ok(missing(harness.render(TextId::ToolsShellTaskPreviewExpired, &[("path", path)])));
        };
        let preview = task.preview.lock().unwrap_or_else(|error| error.into_inner());
        Ok(preview.render(path, running, harness))
    }
    pub async fn context_async_call(
        &self,
        method: &str,
        args: &Value,
        options: &Value,
        cancel: &CancellationToken,
        harness: Arc<crate::harness::ResolvedHarness>,
    ) -> crate::error::Result<Value> {
        use crate::error::Error;
        match method {
            "backgroundTasks.readOutput" => {
                let task = self.lookup_task(args[0]["id"].as_str().unwrap_or(""));
                let (path, running) = task.as_ref().map(|task| {
                    let value = task.value.lock().unwrap_or_else(|error| error.into_inner());
                    (value["output_file"].as_str().unwrap_or("").to_owned(), value["ended_at"].is_null())
                }).unwrap_or_else(|| (args[0]["outputFile"].as_str().unwrap_or("").to_owned(), false));
                Self::read_output(task.as_deref(), &path, running, &harness).await
                    .map_err(|error| Error::new("BACKGROUND_OUTPUT", error))
            }
            "backgroundTasks.wait" => {
                let task = self
                    .tasks
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(args[0].as_str().unwrap_or(""))
                    .cloned();
                if let Some(task) = task {
                    let notified = task.done.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    let pending = task.value.lock().unwrap_or_else(|error| error.into_inner())
                        ["ended_at"]
                        .is_null();
                    if pending {
                        tokio::select! { _ = notified => {}, _ = cancel.cancelled() => return Err(Error::cancelled()) }
                    }
                    return Ok(Self::public_task(&task, &harness));
                }
                Ok(Value::Null)
            }
            "backgroundTasks.flush" => {
                loop {
                    let notified = self.starts_done.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if self.starting.load(Ordering::Acquire) == 0 {
                        break;
                    }
                    tokio::select! { _ = notified => {}, _ = cancel.cancelled() => return Err(Error::cancelled()) }
                }
                if self.lifetime.is_cancelled() {
                    let notified = self.close_done.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if !self.closed.load(Ordering::Acquire) {
                        tokio::select! { _ = notified => {}, _ = cancel.cancelled() => return Err(Error::cancelled()) }
                    }
                }
                Ok(Value::Null)
            }
            "backgroundTasks.start" => {
                let request = &args[0];
                let command = request["command"].as_str().ok_or_else(|| {
                    Error::template(
                        "INVALID_TOOL_CONTEXT",
                        TextId::ToolsShellInvalidCommand,
                        &[],
                    )
                })?;
                let mut state = ShellState {
                    cwd: request["state"]["cwd"].as_str().unwrap_or("").into(),
                    env: HashMap::new(),
                };
                if let Some(entries) = request["state"]["envVars"].as_array() {
                    for entry in entries {
                        if let (Some(name), Some(value)) = (entry[0].as_str(), entry[1].as_str()) {
                            state.env.insert(name.into(), value.into());
                        }
                    }
                }
                let ctx = ToolContext {
                    session_id: options["sessionId"].as_str().unwrap_or("").into(),
                    cwd: request["fallbackCwd"].as_str().unwrap_or(&state.cwd).into(),
                    env: request["env"].clone(),
                    current_turn: 0,
                    tool_use_id: String::new(),
                    cancellation: cancel.clone(),
                    harness: harness.clone(),
                };
                let timeout = request["timeoutMs"]
                    .as_f64()
                    .map(|value| value.max(0.0) as u64);
                let result = self.background(command, state, ctx, timeout).await;
                if result["isError"] == true {
                    return Err(Error::new(
                        "BACKGROUND_START",
                        result["content"]
                            .as_str()
                            .unwrap_or(harness.text(TextId::ToolsShellStartUnknown)),
                    ));
                }
                self.context_call(
                    "backgroundTasks.get",
                    &json!([result["metadata"]["task_id"]]),
                    &harness,
                )
            }
            _ => Err(Error::template(
                "INVALID_TOOL_CONTEXT",
                TextId::ToolsShellUnknownOperation,
                &[("method", method.into())],
            )),
        }
    }

    pub async fn execute(&self, input: &Value, ctx: ToolContext) -> Value {
        self.execute_with_environment(
            input,
            ctx,
            self.base_environment.clone(),
            self.temporary_directory.clone(),
        )
        .await
    }
    pub async fn execute_external(
        &self,
        input: &Value,
        ctx: ToolContext,
        options: &Value,
        bridge: Option<&Arc<dyn crate::bridge::HostBridge>>,
    ) -> Value {
        if crate::js::truthy(&input["run_in_background"]) {
            let Some(command) = input["command"]
                .as_str()
                .filter(|command| !command.is_empty())
            else {
                return failure(ctx.harness.text(TextId::ToolsShellMissingCommand));
            };
            let state = {
                let mut state = self.state.lock().await;
                if state.cwd.is_empty() {
                    state.cwd = ctx.cwd.clone();
                }
                json!({"cwd":state.cwd,"envVars":state.env.iter().map(|(name,value)| json!([name,value])).collect::<Vec<_>>()})
            };
            return super::shell_external::start(command, state, input, &ctx, bridge).await;
        }
        self.execute_with_environment(
            input,
            ctx,
            crate::core::conventions::process_environment(options),
            crate::core::conventions::temp_dir(options),
        )
        .await
    }
    async fn execute_with_environment(
        &self,
        input: &Value,
        ctx: ToolContext,
        base_environment: Value,
        temporary_directory: PathBuf,
    ) -> Value {
        let harness = ctx.harness.clone();
        let Some(command) = input["command"].as_str().filter(|s| !s.is_empty()) else {
            return failure(harness.text(TextId::ToolsShellMissingCommand));
        };
        let timeout = command_timeout(input);
        let mut state = self.state.lock().await;
        if state.cwd.is_empty() {
            state.cwd = ctx.cwd.clone();
        }
        let start = state.clone();
        drop(state);
        if crate::js::truthy(&input["run_in_background"]) {
            return self
                .background(
                    command,
                    start,
                    ctx,
                    input
                        .get("timeout")
                        .filter(|value| !crate::js::is_undefined(value))
                        .map(|_| timeout),
                )
                .await;
        }
        let cancellation = ctx.cancellation.child_token();
        let lifetime = self.lifetime.clone();
        let mut foreground_context = ctx.clone();
        foreground_context.env = Value::Object(
            ctx.env
                .as_object()
                .into_iter()
                .flat_map(|values| values.iter())
                .filter(|(_, value)| value.is_string())
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        );
        let sink = self.output.as_ref().map(|store| {
            Arc::new(CaptureSink::new(
                store.clone(),
                self.result_budget.min(32768),
                Some(harness.render(
                    TextId::ToolsShellOutputTruncated,
                    &[("byte_limit", &super::output::FILE_LIMIT.to_string())],
                )),
            ))
        });
        let before = start.clone();
        let running = run(
            command,
            start,
            &foreground_context,
            Some(timeout),
            cancellation.clone(),
            None,
            None,
            self.processes.clone(),
            base_environment,
            temporary_directory,
            self.activity.clone(),
            sink,
        );
        tokio::pin!(running);
        let result = tokio::select! {
            result = &mut running => result,
            _ = lifetime.cancelled() => {
                cancellation.cancel();
                running.await
            }
        };
        match result {
            Ok(r) => {
                let not_started = r.started == Started::No && !r.timed_out && !r.aborted;
                let unknown = r.started == Started::Unknown && !r.timed_out && !r.aborted;
                if let Some(next) = r.state {
                    apply_snapshot(&mut *self.state.lock().await, &before, next);
                }
                let mut output = r.stdout.trim_end_matches(['\r', '\n']).to_owned();
                let stderr = crate::js::trim_js(&r.stderr);
                if !stderr.is_empty() {
                    if !output.is_empty() {
                        output.push('\n');
                    }
                    output.push_str(stderr);
                }
                if output.is_empty() && r.withheld == 0 && !not_started && !unknown {
                    output = harness.text(TextId::ToolsShellNoOutput).into();
                }
                let label = budget_label(&harness, self.result_budget, self.configured_budget);
                let (prefix, suffix) = if r.unconfirmed {
                    let rendered = if r.timed_out {
                        harness.render(
                            TextId::ToolsShellTimedOutUnconfirmed,
                            &[("timeout", &timeout.to_string()), ("output", "\u{0}")],
                        )
                    } else {
                        harness.render(TextId::ToolsShellStoppedUnconfirmed, &[("output", "\u{0}")])
                    };
                    let (prefix, suffix) = rendered
                        .split_once('\u{0}')
                        .expect("termination template carries one output slot");
                    (prefix.to_owned(), suffix.to_owned())
                } else if r.timed_out {
                    let rendered = harness.render(
                        TextId::ToolsShellTimedOut,
                        &[("timeout", &timeout.to_string()), ("output", "\u{0}")],
                    );
                    let (prefix, suffix) = rendered
                        .split_once('\u{0}')
                        .expect("timeout template carries one output slot");
                    (prefix.to_owned(), suffix.to_owned())
                } else if not_started || unknown {
                    let id = if not_started {
                        TextId::ToolsShellNotStarted
                    } else {
                        TextId::ToolsShellUnconfirmed
                    };
                    let rendered =
                        harness.render(id, &[("code", &r.code.to_string()), ("output", "\u{0}")]);
                    let (prefix, suffix) = rendered
                        .split_once('\u{0}')
                        .expect("start template carries one output slot");
                    let prefix = if output.is_empty() { prefix.trim_end() } else { prefix };
                    (prefix.to_owned(), suffix.to_owned())
                } else if r.code == 0 {
                    (String::new(), String::new())
                } else {
                    let rendered = harness.render(
                        TextId::ToolsShellExited,
                        &[("code", &r.code.to_string()), ("output", "\u{0}")],
                    );
                    let (prefix, suffix) = rendered
                        .split_once('\u{0}')
                        .expect("exit template carries one output slot");
                    (prefix.to_owned(), suffix.to_owned())
                };
                let saved_path = r.saved.as_ref().and_then(super::output::SaveState::path);
                let encoding_notice = {
                    use super::output::SaveState;
                    let complete = matches!(&r.saved, Some(SaveState::Complete { .. }));
                    let reason = match &r.saved {
                        Some(SaveState::Failed { reason }) => Some(*reason),
                        _ => None,
                    };
                    encoding_notice(&harness, r.invalid_utf8, r.withheld, saved_path, complete, reason)
                };
                let suffix = match &encoding_notice {
                    Some(notice) => format!("{suffix}\n{notice}"),
                    None => suffix,
                };
                let fixed = crate::js::utf16_len(&prefix)
                    .saturating_add(crate::js::utf16_len(&output))
                    .saturating_add(crate::js::utf16_len(&suffix));
                let notice = if fixed > self.result_budget || r.omitted {
                    if encoding_notice.is_some() {
                        harness.render(TextId::ToolsShellInvalidUtf8OutputOmitted, &[("budget", &label)])
                    } else {
                        saved_notice(r.saved.as_ref(), &label, &harness)
                    }
                } else {
                    String::new()
                };
                let text = fit_shell_text(
                    &prefix,
                    &suffix,
                    &output,
                    self.result_budget,
                    &label,
                    &notice,
                    &harness,
                );
                let notice_used = (!notice.is_empty() && text.contains(&notice))
                    || encoding_notice.as_ref().is_some_and(|notice| text.ends_with(notice));
                if !notice_used {
                    if let Some(path) = saved_path {
                        super::output::remove_saved(path).await;
                    }
                }
                let mut result = if r.code == 0 && !r.timed_out && !not_started && !unknown {
                    success(text, None)
                } else {
                    failure(text)
                };
                result["__haloSdkNativeOutput"] = json!("bash_preview");
                if notice_used {
                    if let Some(path) = saved_path {
                        result["__haloSdkNativeSavedOutput"] = json!(path);
                    }
                }
                result
            }
            Err(e) => failure(harness.render(
                TextId::ToolsShellLaunchFailed,
                &[("error", &e.render_for(&harness))],
            )),
        }
    }
    async fn background(
        &self,
        command: &str,
        state: ShellState,
        ctx: ToolContext,
        timeout: Option<u64>,
    ) -> Value {
        let harness = ctx.harness.clone();
        {
            let tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
            if self.lifetime.is_cancelled() {
                return failure(harness.text(TextId::ToolsShellRegistryClosed));
            }
            let mut active = 0;
            for task in tasks.values() {
                if task.value.lock().unwrap_or_else(|error| error.into_inner())["status"]
                    == "running"
                {
                    active += 1;
                }
            }
            if active + self.starting.load(Ordering::Acquire) >= 32 {
                return failure(harness.text(TextId::ToolsShellCapacity));
            }
            self.starting.fetch_add(1, Ordering::AcqRel);
        }
        let _starting = Starting(self);
        let (state, cwd_warning) = match resolve_directory(state, &ctx.cwd).await {
            Ok(resolved) => resolved,
            Err(error) => {
                return failure(harness.render(
                    TextId::ToolsShellBackgroundStartFailed,
                    &[("error", &error.render_for(&harness))],
                ))
            }
        };
        let mut directory = self.directory.lock().await;
        if directory.is_none() {
            let p = self
                .temporary_directory
                .join(format!("agent-bash-{}", uuid::Uuid::new_v4()));
            if let Err(e) = create_output_directory(&p).await {
                return failure(harness.render(
                    TextId::ToolsShellBackgroundStartFailed,
                    &[("error", &e.to_string())],
                ));
            }
            *directory = Some(p);
        }
        let directory_path = directory.as_ref().unwrap();
        if let Err(error) = create_output_directory(directory_path).await {
            return failure(harness.render(
                TextId::ToolsShellBackgroundStartFailed,
                &[("error", &error.to_string())],
            ));
        }
        if self.persistent {
            if let Err(error) = super::shell_retention::prune(directory_path).await {
                tracing::warn!(error=%error,"command output retention failed");
                return failure(harness.render(
                    TextId::ToolsShellBackgroundStartFailed,
                    &[("error", &error.to_string())],
                ));
            }
        }
        let id = format!("bash-{}", uuid::Uuid::new_v4());
        let path = directory.as_ref().unwrap().join(format!("{id}.output"));
        let mut open = tokio::fs::OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            open.mode(0o600);
        }
        let file = match open.open(&path).await {
            Ok(f) => f,
            Err(e) => {
                return failure(harness.render(
                    TextId::ToolsShellBackgroundStartFailed,
                    &[("error", &e.to_string())],
                ))
            }
        };
        if self.lifetime.is_cancelled() || ctx.cancellation.is_cancelled() {
            return failure(harness.text(TextId::ToolsShellBackgroundCancelledLaunch));
        }
        let value = json!({"task_id":id,"type":"bash","description":utf16_prefix(command,4096),"status":"running","result":"","error":null,"output_file":path,"truncated":false,"exit_code":null,"started_at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"ended_at":null});
        let preview = Arc::new(StdMutex::new(BackgroundPreview::new(self.background_preview_limit())));
        let task = Arc::new(Task {
            value: StdMutex::new(value),
            done: Notify::new(),
            cancel: self.lifetime.child_token(),
            sequence: self.next_sequence.fetch_add(1, Ordering::Relaxed),
            pid: AtomicU32::new(0),
            cwd_warning: cwd_warning.clone(),
            settling: AtomicBool::new(false),
            preview: preview.clone(),
        });
        self.tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id.clone(), task.clone());
        let command = command.to_owned();
        let output = Arc::new(Mutex::new(PersistedOutput {
            file,
            written: 0,
            truncated: false,
            failed: false,
            marker: harness.render(TextId::ToolsShellOutputTruncated, &[("byte_limit", &BACKGROUND_FILE_LIMIT.to_string())]),
            preview,
        }));
        let notices = self.notices.clone();
        let lifetime = self.lifetime.clone();
        let persistent = self.persistent;
        let tasks = self.tasks.clone();
        let (launched, launch_ready) = oneshot::channel();
        let launched_task = task.clone();
        let processes = self.processes.clone();
        let base_environment = self.base_environment.clone();
        let temporary_directory = self.temporary_directory.clone();
        let activity = self.activity.clone();
        crate::runtime::spawn(async move {
            let outcome = run(
                &command,
                state,
                &ctx,
                timeout,
                task.cancel.clone(),
                Some(output.clone()),
                Some(launched),
                processes,
                base_environment,
                temporary_directory,
                activity.clone(),
                None,
            )
            .await;
            let finalization_activity = activity.as_ref().map(|activity| activity.lease());
            task.settling.store(true, Ordering::Release);
            let process_id = outcome.as_ref().ok().map(|result| result.pid);
            let mut value = task
                .value
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            match outcome {
                Ok(r) => {
                    value["exit_code"] = if r.timed_out || task.cancel.is_cancelled() {
                        Value::Null
                    } else {
                        json!(r.code)
                    };
                    let settled = !task.cancel.is_cancelled() && !r.timed_out;
                    let start_problem = match r.started {
                        Started::No if settled => Some(TextId::ToolsShellTaskNotStarted),
                        Started::Unknown if settled => Some(TextId::ToolsShellTaskUnconfirmed),
                        _ => None,
                    };
                    value["status"] = json!(if task.cancel.is_cancelled() {
                        "stopped"
                    } else if r.code == 0 && start_problem.is_none() {
                        "completed"
                    } else {
                        "failed"
                    });
                    if let Some(id) = start_problem {
                        value["error"] =
                            json!(Message::template(id, &[("code", r.code.to_string().into())]));
                    }
                    if r.timed_out {
                        value["error"] = json!(Message::template(
                            TextId::ToolsShellTaskTimedOut,
                            &[("timeout", timeout.unwrap_or(0).to_string().into())]
                        ));
                    }
                    if r.unconfirmed {
                        let reason = if value["error"].is_null() {
                            Message::template(TextId::ToolsShellStopped, &[])
                        } else {
                            stored_message(&value["error"])
                        };
                        value["error"] = json!(Message::template(
                            TextId::ToolsShellTaskTerminationUnconfirmed,
                            &[("reason", reason)]
                        ));
                    }
                }
                Err(e) => {
                    value["status"] = json!("failed");
                    value["error"] = json!(e.as_harness_message());
                }
            }
            {
                let mut output = output.lock().await;
                value["truncated"] = json!(output.truncated);
                if let Err(error) = output.file.flush().await {
                    output.failed = true;
                    tracing::warn!(error=%error,"background command output write failed");
                }
                if output.failed {
                    output.preview.lock().unwrap_or_else(|error| error.into_inner()).save_failed = true;
                    value["status"] = json!("failed");
                    value["error"] = json!(Message::template(
                        TextId::ToolsShellOutputPersistenceFailed,
                        &[]
                    ));
                }
            }
            drop(output);
            if persistent {
                if let Some(path) = value["output_file"].as_str() {
                    if let Err(error) =
                        super::shell_retention::complete(Path::new(path), process_id).await
                    {
                        value["status"] = json!("failed");
                        value["error"] = json!(Message::template(
                            TextId::ToolsShellOutputFinalizationFailed,
                            &[]
                        ));
                        tracing::warn!(error=%error,"background output finalization failed");
                    }
                }
            }
            value["ended_at"] =
                json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            *task.value.lock().unwrap_or_else(|error| error.into_inner()) = value.clone();
            if !lifetime.is_cancelled() {
                let error = if value["error"].is_null() {
                    Message::from("")
                } else {
                    Message::template(
                        TextId::ToolsShellNoticeError,
                        &[("error", stored_message(&value["error"]))],
                    )
                };
                let truncated = if value["truncated"] == true {
                    Message::template(TextId::ToolsShellNoticeTruncated, &[])
                } else {
                    Message::from("")
                };
                let notice = Message::template(
                    TextId::ToolsShellNotice,
                    &[
                        ("id", value["task_id"].as_str().unwrap_or("").into()),
                        ("status", value["status"].as_str().unwrap_or("").into()),
                        ("error", error),
                        ("truncated", truncated),
                        ("path", value["output_file"].as_str().unwrap_or("").into()),
                    ],
                );
                let mut queue = notices.lock().await;
                if queue.len() == 256 {
                    queue.pop_front();
                    tracing::warn!("oldest shell notice evicted from full session queue");
                }
                queue.push_back(notice);
            }
            {
                let mut tasks = tasks.lock().unwrap_or_else(|error| error.into_inner());
                let mut completed: Vec<_> = tasks
                    .iter()
                    .filter(|(_, task)| {
                        !task.value.lock().unwrap_or_else(|error| error.into_inner())["ended_at"]
                            .is_null()
                    })
                    .map(|(id, task)| (id.clone(), task.sequence))
                    .collect();
                completed.sort_by_key(|(_, sequence)| *sequence);
                let excess = completed.len().saturating_sub(128);
                for (id, _) in completed.into_iter().take(excess) {
                    tasks.remove(&id);
                }
            }
            drop(finalization_activity);
            task.done.notify_waiters();
        });
        match launch_ready.await {
            Ok(Ok(pid)) => {
                launched_task.pid.store(pid, Ordering::Release);
                if self.persistent {
                    let marker =
                        std::path::PathBuf::from(format!("{}.active-{pid}", path.display()));
                    if let Err(error) = super::shell_retention::mark(&marker).await {
                        tracing::warn!(error=%error,"background output active marker failed");
                    }
                    if !launched_task
                        .value
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())["ended_at"]
                        .is_null()
                    {
                        let _ = tokio::fs::remove_file(marker).await;
                    }
                }
            }
            result => {
                let error = match result {
                    Ok(Err(error)) => error.as_harness_message(),
                    _ => {
                        let value = launched_task
                            .value
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        if value["error"].is_null() {
                            Message::template(TextId::ToolsShellLaunchPreparationFailed, &[])
                        } else {
                            stored_message(&value["error"])
                        }
                    }
                };
                let mut result = failure(harness.render(
                    TextId::ToolsShellBackgroundLaunchFailed,
                    &[("id", &id), ("error", &error.render(&harness))],
                ));
                result["metadata"] = json!({"task_id":id,"output_file":path});
                return result;
            }
        }
        success(
            harness.render(
                TextId::ToolsShellBackgroundStarted,
                &[
                    (
                        "warning",
                        &cwd_warning
                            .map(|warning| format!("{}\n", warning.render(&harness)))
                            .unwrap_or_default(),
                    ),
                    ("id", &id),
                    ("path", &path.to_string_lossy()),
                    (
                        "deadline",
                        &timeout
                            .map(|ms| {
                                harness.render(
                                    TextId::ToolsShellDeadline,
                                    &[("timeout", &ms.to_string())],
                                )
                            })
                            .unwrap_or_else(|| harness.text(TextId::ToolsShellNoDeadline).into()),
                    ),
                ],
            ),
            Some(json!({"task_id":id,"output_file":path})),
        )
    }
    pub async fn task(&self, name: &str, input: &Value, ctx: &ToolContext) -> Value {
        let harness = &ctx.harness;
        let Some(id) = input["task_id"].as_str().filter(|s| !s.is_empty()) else {
            return failure(harness.text(TextId::ToolsShellMissingTaskId));
        };
        let Some(task) = self.lookup_task(id) else {
            return failure(harness.render(TextId::ToolsShellTaskNotFound, &[("id", id)]));
        };
        if name == "TaskStop" {
            let mut value = task.value.lock().unwrap_or_else(|error| error.into_inner());
            if value["status"] != "running" {
                return failure(harness.render(
                    TextId::ToolsShellTaskNotRunning,
                    &[("id", id), ("status", value["status"].as_str().unwrap())],
                ));
            }
            value["status"] = json!("stopped");
            value["error"] = json!(Message::template(TextId::ToolsShellStopped, &[]));
            task.cancel.cancel();
            return success(
                serde_json::to_string_pretty(
                    &json!({"message":harness.text(TextId::ToolsShellStopRequested),"task_id":id}),
                )
                .unwrap(),
                None,
            );
        }
        let notified = task.done.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if input["block"] != false
            && task.value.lock().unwrap_or_else(|error| error.into_inner())["ended_at"].is_null()
        {
            let timeout = input["timeout"]
                .as_f64()
                .unwrap_or(30000.)
                .clamp(0., 600000.) as u64;
            tokio::select! {_=notified=>{},_=tokio::time::sleep(Duration::from_millis(timeout))=>{},_=ctx.cancellation.cancelled()=>return failure(harness.render(TextId::ToolsShellWaitCancelled, &[("id", id)]))}
        }
        let mut value = task
            .value
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        value["error"] = render_error(&value["error"], harness);
        let path = value["output_file"].as_str().unwrap_or("");
        match Self::read_output(Some(&task), path, value["ended_at"].is_null(), harness).await {
            Ok(output) => {
                value["result"] = output["output"].clone();
                value["truncated"] = output["truncated"].clone();
            }
            Err(error) => {
                tracing::warn!(task_id = id, error, "task output retrieval failed");
                return failure(harness.render(
                    TextId::ToolsShellRetrievalFailed,
                    &[("id", id), ("error", &error)],
                ));
            }
        }
        success(serde_json::to_string_pretty(&json!({"retrieval_status":if value["ended_at"].is_null(){"not_ready"}else{"success"},"task":value})).unwrap(),None)
    }
    pub async fn close(&self) {
        let _close = self.close_lock.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        self.begin_close();
        loop {
            let notified = self.starts_done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.starting.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
        let tasks: Vec<_> = self
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .cloned()
            .collect();
        for task in tasks {
            {
                let mut value = task.value.lock().unwrap_or_else(|error| error.into_inner());
                if value["status"] == "running" {
                    value["status"] = json!("stopped");
                    value["error"] = json!(Message::template(TextId::ToolsShellClosed, &[]));
                }
            }
            let notified = task.done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if task.value.lock().unwrap_or_else(|error| error.into_inner())["ended_at"].is_null() {
                notified.await;
            }
        }
        if !self.persistent {
            if let Some(path) = self.directory.lock().await.take() {
                if let Err(e) = tokio::fs::remove_dir_all(path).await {
                    tracing::warn!(error=%e,"background command output cleanup failed");
                }
            }
        }
        self.notices.lock().await.clear();
        self.tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.closed.store(true, Ordering::Release);
        self.close_done.notify_waiters();
    }
    pub fn begin_interrupt(&self) {
        self.stop_all(Message::template(TextId::ToolsShellInterrupted, &[]));
    }
    pub async fn interrupt(&self) {
        self.begin_interrupt();
    }
}
