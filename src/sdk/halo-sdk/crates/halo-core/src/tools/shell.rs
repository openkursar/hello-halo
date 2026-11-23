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
        let path = directory.join(format!("agent-shell-{}.state", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?;
        Ok(Self {
            path,
            cleaned: false,
        })
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
fn extract_exports(command: &str) -> HashMap<String, String> {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        let whitespace = r"\x09-\x0d\x20\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
        regex::Regex::new(&format!(r#"(?m)^[{whitespace}]*export[{whitespace}]+([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^{whitespace}]*))"#)).unwrap()
    });
    pattern
        .captures_iter(command)
        .map(|capture| {
            (
                capture[1].to_owned(),
                capture
                    .get(2)
                    .or_else(|| capture.get(3))
                    .or_else(|| capture.get(4))
                    .map(|value| value.as_str().to_owned())
                    .unwrap_or_default(),
            )
        })
        .collect()
}
async fn create_output_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).await
}
fn wrapper(
    command: &str,
    shell: &str,
    state: &ShellState,
    file: Option<&Path>,
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
        command.into(),
        "__agent_ec=$?".into(),
    ]);
    if let Some(file) = file {
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
        let script=wrapper("printf wrapper-command-marker >nul","bash",&state,None,&crate::harness::baseline(),&mut env);
        assert!(script.find("cd ").unwrap()<script.find("printf wrapper-command-marker").unwrap());assert!(script.find("export FILTER=").unwrap()<script.find("printf wrapper-command-marker").unwrap());
        assert!(script.contains("printf wrapper-command-marker >/dev/null"));assert!(!script.contains("\\!"));assert!(!script.contains("select(.x != .y)"));assert!(env.values().any(|value|value=="select(.x != .y) 'quote'"));assert_eq!(state.env["FILTER"],"select(.x != .y) 'quote'");
        let mut file=StateFile::create(&root).unwrap();let path=file.path.clone();assert!(path.exists());file.cleanup().await;file.cleanup().await;assert!(!path.exists());finish(root,shell).await;
    }
    async fn wait(shell: &ShellTools, id: &Value, ctx: &ToolContext) -> Value {
        shell.context_async_call("backgroundTasks.wait", &json!([id]), &json!({}),
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
        let output=shell.read_output(&task,&ctx.harness,32768).await.unwrap();assert_eq!(output["truncated"],true);assert_eq!(output["output"].as_str().unwrap().len(),32768);assert_eq!(tokio::fs::metadata(task["outputFile"].as_str().unwrap()).await.unwrap().len(),40000);assert!(task.get("output").is_none());
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
        let output = shell.read_output(&task, &ctx.harness, 32768).await.unwrap();
        assert_eq!(output["truncated"], true);
        assert!(tokio::fs::read_to_string(path).await.unwrap().ends_with("later output was not saved here.]"));
        let task_output=shell.task("TaskOutput",&json!({"task_id":task["id"],"block":false}),&ctx).await;
        let value:Value=serde_json::from_str(task_output["content"].as_str().unwrap()).unwrap();
        let preview=value["task"]["result"].as_str().unwrap();
        assert!(preview.contains("The saved file is also incomplete"));
        assert!(preview.contains("8388608-byte file limit"));
        tokio::fs::remove_file(path).await.unwrap();
        let output = shell.read_output(&task, &ctx.harness, 32768).await.unwrap();
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
        let output=shell.read_output(&task,&ctx.harness,32768).await.unwrap();
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
        assert!(preview.contains("Showing the first 32768 bytes of saved output"));
        assert!(preview.contains("Additional captured output is available at"));
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
    fn only_zsh_gets_the_option_that_lets_unmatched_globs_through() {
        let state = ShellState { cwd: "/".into(), env: HashMap::new() };
        let script = |shell: &str| wrapper("echo x", shell, &state, None, &crate::harness::baseline(), &mut HashMap::new());
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
            shell, &state, Some(&file.path), &crate::harness::baseline(), &mut HashMap::new(),
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
                let script = wrapper("printf '%s\\0%s' \"$PATH\" \"$Z_DIAGNOSTIC\"", shell, &state, Some(&file),
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

#[derive(Default)]
struct Capture {
    head: Vec<u16>,
    tail: Vec<u16>,
}
impl Capture {
    fn push(&mut self, s: &str) {
        let units: Vec<u16> = s.encode_utf16().collect();
        let head = (32768 - self.head.len()).min(units.len());
        self.head.extend_from_slice(&units[..head]);
        self.tail.extend_from_slice(&units[head..]);
        if self.tail.len() > 32768 {
            self.tail.drain(..self.tail.len() - 32768);
        }
    }
    fn text(&self) -> String {
        format!(
            "{}{}",
            String::from_utf16_lossy(&self.head),
            String::from_utf16_lossy(&self.tail)
        )
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
    async fn mark_incomplete(&self) {
        let mut state = self.state.lock().await;
        if let Some(writer) = &mut state.writer {
            writer.mark_incomplete(super::output::SaveReason::UnsafeCopy);
        } else if state.failed.is_none() {
            state.failed = Some(super::output::SaveReason::UnsafeCopy);
        }
    }
    async fn finish(&self) -> Option<super::output::SaveState> {
        let mut state = self.state.lock().await;
        if let Some(writer) = state.writer.take() {
            Some(writer.finish().await)
        } else {
            state
                .failed
                .map(|reason| super::output::SaveState::Failed { reason })
        }
    }
}
async fn drain<R: AsyncRead + Unpin>(
    mut reader: R,
    output: Option<Arc<Mutex<PersistedOutput>>>,
    sink: Option<Arc<CaptureSink>>,
    cancel: CancellationToken,
    harness: Arc<ResolvedHarness>,
    _activity: Option<crate::resource_activity::ResourceLease>,
) -> String {
    let mut buffer = [0u8; 8192];
    let mut pending = Vec::new();
    let mut capture = Capture::default();
    loop {
        let count = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(error=%e,"command output read failed");
                if let Some(sink) = &sink {
                    sink.mark_incomplete().await;
                }
                break;
            }
        };
        if let Some(file) = &output {
            let mut state = file.lock().await;
            let marker = harness
                .render(TextId::ToolsShellOutputTruncated, &[("byte_limit", &(8 * 1024 * 1024).to_string())])
                .as_bytes()
                .to_vec();
            let remaining = (8 * 1024 * 1024usize).saturating_sub(marker.len() + state.written);
            let written = count.min(remaining);
            if written > 0 {
                if let Err(error) = state.file.write_all(&buffer[..written]).await {
                    state.failed = true;
                    cancel.cancel();
                    tracing::warn!(error=%error,"background command output write failed");
                    break;
                }
                state.written += written;
            }
            if written < count && !state.truncated {
                state.truncated = true;
                if let Err(error) = state.file.write_all(&marker).await {
                    state.failed = true;
                    cancel.cancel();
                    tracing::warn!(error=%error,"background command output write failed");
                    break;
                }
                tracing::warn!(
                    limit_bytes = 8 * 1024 * 1024,
                    "background command output truncated"
                );
            }
        }
        if let Some(sink) = &sink {
            sink.push(&buffer[..count]).await;
        }
        pending.extend_from_slice(&buffer[..count]);
        loop {
            match std::str::from_utf8(&pending) {
                Ok(text) => {
                    capture.push(text);
                    pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        capture.push(std::str::from_utf8(&pending[..valid]).unwrap());
                        pending.drain(..valid);
                    }
                    if let Some(invalid) = e.error_len() {
                        capture.push("�");
                        pending.drain(..invalid);
                    } else {
                        break;
                    }
                }
            }
        }
    }
    if !pending.is_empty() {
        capture.push(&String::from_utf8_lossy(&pending));
    }
    capture.text()
}
struct RunResult {
    pid: u32,
    code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
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
    let background = output.is_some();
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
        state_file.as_ref().map(|file| file.path.as_path()),
        &ctx.harness,
        &mut environment,
    );
    let mut cmd = Command::new(shell);
    cmd.arg("-c")
        .arg(script)
        .current_dir(&state.cwd)
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
    let stdout = crate::runtime::spawn(drain(
        stdout_pipe,
        output.clone(),
        sink.clone(),
        cancel.clone(),
        ctx.harness.clone(),
        stdout_activity,
    ));
    let stderr = crate::runtime::spawn(drain(
        stderr_pipe,
        output,
        sink.clone(),
        cancel.clone(),
        ctx.harness.clone(),
        stderr_activity,
    ));
    let mut timed_out = false;
    let mut aborted = false;
    let deadline = async {
        match timeout {
            Some(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending().await,
        }
    };
    let completion = async {
        let output = tokio::join!(stdout, stderr);
        let status = owned_process.wait().await;
        (status, output)
    };
    tokio::pin!(completion);
    let result = tokio::select! {
        result = &mut completion => Some(result),
        _ = cancel.cancelled() => { aborted = true; None },
        _ = deadline => { timed_out = true; None },
    };
    let (status, (stdout, stderr)) = match result {
        Some(result) => result,
        None => {
            owned_process.terminate(background).await;
            if background {
                completion.await
            } else {
                match tokio::time::timeout(Duration::from_secs(5), &mut completion).await {
                    Ok(result) => result,
                    Err(_) => {
                        owned_process.terminate(true).await;
                        completion.await
                    }
                }
            }
        }
    };
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
    let parsed = if let Some(file) = &mut state_file {
        let parsed = read_state(&file.path).await;
        file.cleanup().await;
        parsed
    } else {
        None
    };
    let saved = match sink {
        Some(sink) => sink.finish().await,
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
        state: parsed,
        saved,
    })
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
    let head = crate::js::utf16_prefix(output, available / 2);
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
    async fn read_output(
        &self,
        value: &Value,
        harness: &ResolvedHarness,
        cap: usize,
    ) -> std::result::Result<Value, String> {
        let path = value["outputFile"]
            .as_str()
            .or_else(|| value["output_file"].as_str())
            .unwrap_or("");
        let mut file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!("command output is no longer retained");
                return Ok(json!({"output":harness.text(TextId::ToolsShellOutputExpired),"truncated":true,"expired":true,"shownBytes":0,"fileComplete":false}));
            }
            Err(error) => return Err(error.to_string()),
        };
        let mut bytes = vec![0; cap + 1];
        let count = file
            .read(&mut bytes)
            .await
            .map_err(|error| error.to_string())?;
        let shown = count.min(cap);
        Ok(json!({
            "output": String::from_utf8_lossy(&bytes[..shown]),
            "truncated": value["outputTruncated"] == true || value["truncated"] == true || count > cap,
            "expired": false,
            "shownBytes": shown,
            "fileComplete": value["outputTruncated"] != true && value["truncated"] != true
        }))
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
            "backgroundTasks.readOutput" => self
                .read_output(&args[0], &harness, 32768)
                .await
                .map_err(|error| Error::new("BACKGROUND_OUTPUT", error)),
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
                if let Some(next) = r.state {
                    let mut state = self.state.lock().await;
                    state.cwd = next.cwd;
                    state.env.extend(next.env);
                } else {
                    self.state.lock().await.env.extend(extract_exports(command));
                }
                let mut output = r.stdout.trim_end_matches(['\r', '\n']).to_owned();
                let stderr = crate::js::trim_js(&r.stderr);
                if !stderr.is_empty() {
                    if !output.is_empty() {
                        output.push('\n');
                    }
                    output.push_str(stderr);
                }
                if output.is_empty() {
                    output = harness.text(TextId::ToolsShellNoOutput).into();
                }
                let label = budget_label(&harness, self.result_budget, self.configured_budget);
                let (prefix, suffix) = if r.timed_out {
                    let rendered = harness.render(
                        TextId::ToolsShellTimedOut,
                        &[("timeout", &timeout.to_string()), ("output", "\u{0}")],
                    );
                    let (prefix, suffix) = rendered
                        .split_once('\u{0}')
                        .expect("timeout template carries one output slot");
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
                let fixed = crate::js::utf16_len(&prefix)
                    .saturating_add(crate::js::utf16_len(&output))
                    .saturating_add(crate::js::utf16_len(&suffix));
                let notice = if fixed > self.result_budget {
                    saved_notice(r.saved.as_ref(), &label, &harness)
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
                let notice_used = !notice.is_empty() && text.contains(&notice);
                let saved_path = r.saved.as_ref().and_then(super::output::SaveState::path);
                if !notice_used {
                    if let Some(path) = saved_path {
                        super::output::remove_saved(path).await;
                    }
                }
                let mut result = if r.code == 0 && !r.timed_out {
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
        let task = Arc::new(Task {
            value: StdMutex::new(value),
            done: Notify::new(),
            cancel: self.lifetime.child_token(),
            sequence: self.next_sequence.fetch_add(1, Ordering::Relaxed),
            pid: AtomicU32::new(0),
            cwd_warning: cwd_warning.clone(),
            settling: AtomicBool::new(false),
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
                    value["status"] = json!(if task.cancel.is_cancelled() {
                        "stopped"
                    } else if r.code == 0 {
                        "completed"
                    } else {
                        "failed"
                    });
                    if r.timed_out {
                        value["error"] = json!(Message::template(
                            TextId::ToolsShellTaskTimedOut,
                            &[("timeout", timeout.unwrap_or(0).to_string().into())]
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
        let Some(task) = self
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .cloned()
        else {
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
        let cap = if self.configured_budget {
            self.result_budget.saturating_sub(2048).min(32768)
        } else {
            32768
        };
        match self.read_output(&value, harness, cap).await {
            Ok(output) => {
                let mut preview = output["output"].as_str().unwrap_or("").to_owned();
                if output["expired"] != true && output["truncated"] == true {
                    let path = value["output_file"].as_str().unwrap_or("");
                    let notice = if output["fileComplete"] == true {
                        harness.render(
                            TextId::ToolsShellTaskOutputMore,
                            &[
                                ("shown_bytes", &output["shownBytes"].as_u64().unwrap_or(0).to_string()),
                                ("path", path),
                            ],
                        )
                    } else {
                        harness.render(
                            TextId::ToolsShellTaskOutputIncomplete,
                            &[
                                ("shown_bytes", &output["shownBytes"].as_u64().unwrap_or(0).to_string()),
                                ("path", path),
                                ("byte_limit", &(8 * 1024 * 1024).to_string()),
                            ],
                        )
                    };
                    if !preview.is_empty() {
                        preview.push('\n');
                    }
                    preview.push_str(&notice);
                }
                value["result"] = json!(preview);
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
