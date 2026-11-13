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
fn filtered(key: &str) -> bool {
    [
        "_",
        "SHLVL",
        "BASH_LINENO",
        "BASH_SOURCE",
        "PWD",
        "__agent_ec",
        "__agent_cwd",
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
    let mut script = vec![
        format!(
            "cd {} 2>/dev/null || {{ printf '%s\\n' {} >&2; exit 127; }}",
            quote(&windows_posix(&state.cwd)),
            quote(harness.text(TextId::ToolsShellWrapperCwdMissing))
        ),
        exports,
        command.into(),
        "__agent_ec=$?".into(),
    ];
    if let Some(file) = file {
        let pwd = if cfg!(windows) { "pwd -P -W" } else { "pwd -P" };
        script.push(format!(
            "__agent_cwd=$({pwd} 2>/dev/null) || {{ __agent_cwd={}; printf '%s\\n' {} >&2; }}",
            quote(&state.cwd),
            quote(harness.text(TextId::ToolsShellWrapperCwdRetained))
        ));
        script.push(format!(
            "{{ printf '%s\\n' \"$__agent_cwd\"; env; }} > {} 2>/dev/null || true",
            quote(&windows_posix(&file.to_string_lossy()))
        ));
    }
    script.push("exit $__agent_ec".into());
    script.join("\n")
}
async fn read_state(file: &Path) -> Option<ShellState> {
    let raw = tokio::fs::read_to_string(file).await.ok()?;
    let mut lines = raw.strip_suffix('\n').unwrap_or(&raw).split('\n');
    let cwd = lines.next()?.to_owned();
    let cwd = if cfg!(windows) {
        posix_to_windows(&cwd)
    } else {
        cwd
    };
    if !Path::new(&cwd).is_absolute() || cwd.contains(['\0', '\r', '\n']) {
        tracing::warn!("shell state discarded: invalid working directory");
        return None;
    }
    let mut env = HashMap::new();
    let mut key = String::new();
    let mut value = String::new();
    let flush = |k: &str, v: &str, env: &mut HashMap<String, String>| {
        if !k.is_empty() && !filtered(k) {
            env.insert(k.into(), v.into());
        }
    };
    let regex = regex::Regex::new(r"^([A-Za-z_][A-Za-z0-9_]*)=").unwrap();
    for line in lines {
        if let Some(c) = regex.captures(line) {
            flush(&key, &value, &mut env);
            key = c[1].into();
            value = line[c[0].len()..].into();
        } else if !key.is_empty() {
            value.push('\n');
            value.push_str(line);
        }
    }
    flush(&key, &value, &mut env);
    Some(ShellState { cwd, env })
}

#[cfg(all(test, unix))]
mod restore_tests {
    use super::*;

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
    total: usize,
}
impl Capture {
    fn push(&mut self, s: &str) {
        let units: Vec<u16> = s.encode_utf16().collect();
        self.total += units.len();
        let head = (32768 - self.head.len()).min(units.len());
        self.head.extend_from_slice(&units[..head]);
        self.tail.extend_from_slice(&units[head..]);
        if self.tail.len() > 32768 {
            self.tail.drain(..self.tail.len() - 32768);
        }
    }
    fn text(&self, harness: &ResolvedHarness) -> String {
        let mark = if self.total > 65536 {
            harness.render(
                TextId::ToolsShellCaptureTruncated,
                &[("omitted", &(self.total - 65536).to_string())],
            )
        } else {
            String::new()
        };
        format!(
            "{}{mark}{}",
            String::from_utf16_lossy(&self.head),
            String::from_utf16_lossy(&self.tail)
        )
    }
}
async fn drain<R: AsyncRead + Unpin>(
    mut reader: R,
    output: Option<Arc<Mutex<PersistedOutput>>>,
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
                break;
            }
        };
        if let Some(file) = &output {
            let mut state = file.lock().await;
            let marker = harness.text(TextId::ToolsShellOutputTruncated).as_bytes();
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
                if let Err(error) = state.file.write_all(marker).await {
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
    capture.text(&harness)
}
struct RunResult {
    pid: u32,
    code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
    state: Option<ShellState>,
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
        false,
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
        cancel.clone(),
        ctx.harness.clone(),
        stdout_activity,
    ));
    let stderr = crate::runtime::spawn(drain(
        stderr_pipe,
        output,
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
impl ShellTools {
    pub(super) fn process_registry(&self) -> Arc<crate::processes::OwnedProcesses> {
        self.processes.clone()
    }
    pub fn new_with_activity(
        options: &Value,
        activity: Option<Arc<crate::resource_activity::ResourceActivity>>,
    ) -> Self {
        let persistent = options["persistSession"] != false;
        let directory =
            persistent.then(|| PathBuf::from(super::config_dir(options)).join("bash-output"));
        Self {
            directory: Mutex::new(directory),
            persistent,
            base_environment: crate::core::conventions::process_environment(options),
            temporary_directory: crate::core::conventions::temp_dir(options),
            activity,
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
    ) -> std::result::Result<Value, String> {
        let path = value["outputFile"]
            .as_str()
            .or_else(|| value["output_file"].as_str())
            .unwrap_or("");
        let mut file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!("command output is no longer retained");
                return Ok(
                    json!({"output":harness.text(TextId::ToolsShellOutputExpired),"truncated":true}),
                );
            }
            Err(error) => return Err(error.to_string()),
        };
        let mut bytes = vec![0; 32769];
        let count = file
            .read(&mut bytes)
            .await
            .map_err(|error| error.to_string())?;
        Ok(
            json!({"output":String::from_utf8_lossy(&bytes[..count.min(32768)]),"truncated":value["outputTruncated"] == true || value["truncated"] == true || count > 32768}),
        )
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
                .read_output(&args[0], &harness)
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
                if r.timed_out {
                    return failure(crate::core::truncate::truncate_content_with_harness(
                        &harness.render(
                            TextId::ToolsShellTimedOut,
                            &[("timeout", &timeout.to_string()), ("output", &output)],
                        ),
                        50000,
                        harness.text(TextId::ToolsShellRecovery),
                        &harness,
                    ));
                }
                let text = if r.code == 0 {
                    output
                } else {
                    harness.render(
                        TextId::ToolsShellExited,
                        &[("code", &r.code.to_string()), ("output", &output)],
                    )
                };
                let text = crate::core::truncate::truncate_content_with_harness(
                    &text,
                    50000,
                    harness.text(TextId::ToolsShellRecovery),
                    &harness,
                );
                if r.code == 0 {
                    success(text, None)
                } else {
                    failure(text)
                }
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
        match self.read_output(&value, harness).await {
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
    pub async fn interrupt(&self) {
        self.stop_all(Message::template(TextId::ToolsShellInterrupted, &[]));
    }
}
