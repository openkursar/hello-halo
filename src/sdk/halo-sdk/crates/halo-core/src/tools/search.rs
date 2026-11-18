use super::{failure, file, success, ToolContext};
use crate::harness::TextId;
use serde_json::Value;
use std::process::Stdio;
use tokio::{io::AsyncReadExt, process::Command};
pub async fn glob(input: &Value, ctx: &ToolContext, denials: &[std::path::PathBuf]) -> Value {
    let harness = &ctx.harness;
    let Some(pattern) = input["pattern"].as_str().filter(|s| !s.is_empty()) else {
        return failure(harness.text(TextId::ToolsSearchMissingPattern));
    };
    let base = file::resolve(&ctx.cwd, input["path"].as_str().unwrap_or("."));
    if !base.exists() {
        return failure(harness.render(
            TextId::ToolsGlobDirectoryMissing,
            &[("path", &base.to_string_lossy())],
        ));
    }
    if !base.is_dir() {
        return failure(harness.render(
            TextId::ToolsGlobNotDirectory,
            &[("path", &base.to_string_lossy())],
        ));
    }
    if file::denied(&base, denials) {
        return failure(harness.render(
            TextId::ToolsSearchDenied,
            &[("path", &base.to_string_lossy())],
        ));
    }
    let matcher = match super::glob_matcher::Matcher::new(pattern, cfg!(windows)) {
        Ok(matcher) => matcher,
        Err(e) => {
            return failure(harness.render(TextId::ToolsGlobFailed, &[("error", &e.to_string())]))
        }
    };
    let skip = [
        "node_modules",
        "__pycache__",
        "target",
        "dist",
        "build",
        ".next",
        ".nuxt",
        ".git",
        ".hg",
        ".svn",
        ".npm",
        ".yarn",
        ".cache",
        ".cargo",
        ".gradle",
    ];
    let real_base = if denials.is_empty() {
        base.clone()
    } else {
        file::real_path(&base)
    };
    let mut pending = vec![(base.clone(), real_base, true)];
    let mut entries = Vec::new();
    while let Some((path, real_path, directory)) = pending.pop() {
        if ctx.cancellation.is_cancelled() {
            return failure(harness.text(TextId::ToolsGlobAborted));
        }
        if file::denied_real(&real_path, denials) {
            continue;
        }
        if directory {
            let mut reader = match tokio::fs::read_dir(&path).await {
                Ok(reader) => reader,
                Err(error) => {
                    return failure(
                        harness.render(TextId::ToolsGlobFailed, &[("error", &error.to_string())]),
                    )
                }
            };
            let mut children = Vec::new();
            loop {
                match reader.next_entry().await {
                    Ok(Some(entry)) => children.push(entry),
                    Ok(None) => break,
                    Err(error) => {
                        return failure(
                            harness
                                .render(TextId::ToolsGlobFailed, &[("error", &error.to_string())]),
                        )
                    }
                }
            }
            children.sort_by_key(|entry| entry.file_name());
            for entry in children.into_iter().rev() {
                let name = entry.file_name();
                let kind = match entry.file_type().await {
                    Ok(kind) => kind,
                    Err(error) => {
                        tracing::warn!(error=%error,"Glob entry could not be inspected");
                        continue;
                    }
                };
                if kind.is_dir() && !skip.contains(&name.to_string_lossy().as_ref()) {
                    pending.push((entry.path(), real_path.join(&name), true));
                } else if kind.is_file() {
                    pending.push((entry.path(), real_path.join(&name), false));
                }
            }
        } else if matcher.matches(&path.strip_prefix(&base).unwrap_or(&path).to_string_lossy()) {
            match tokio::fs::metadata(&path).await {
                Ok(metadata) => entries.push((path, file::modified(&metadata))),
                Err(error) => tracing::warn!(error=%error,"Glob file metadata could not be read"),
            }
        }
    }
    if entries.is_empty() {
        return success(
            harness.render(
                TextId::ToolsGlobNoFiles,
                &[("pattern", pattern), ("path", &base.to_string_lossy())],
            ),
            None,
        );
    }
    entries.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut output = entries
        .iter()
        .take(250)
        .map(|(p, _)| format!("{}\n", p.display()))
        .collect::<String>();
    if entries.len() > 250 {
        output.push_str(&harness.render(
            TextId::ToolsGlobTruncated,
            &[
                ("omitted", &(entries.len() - 250).to_string()),
                ("total", &entries.len().to_string()),
            ],
        ));
    }
    success(output, None)
}
pub async fn grep(
    input: &Value,
    ctx: &ToolContext,
    denials: &[std::path::PathBuf],
    processes: std::sync::Arc<crate::processes::OwnedProcesses>,
    base_environment: &Value,
) -> Value {
    let harness = &ctx.harness;
    let Some(pattern) = input["pattern"].as_str().filter(|s| !s.is_empty()) else {
        return failure(harness.text(TextId::ToolsSearchMissingPattern));
    };
    let path = file::resolve(&ctx.cwd, input["path"].as_str().unwrap_or("."));
    if file::denied(&path, denials) {
        return failure(harness.render(
            TextId::ToolsSearchDenied,
            &[("path", &path.to_string_lossy())],
        ));
    }
    let env =
        crate::core::conventions::merged_environment(base_environment, &[&ctx.env], cfg!(windows));
    let executable = env
        .get("AGENT_RIPGREP_PATH")
        .map(String::as_str)
        .filter(|path| std::path::Path::new(path).is_absolute())
        .unwrap_or("rg");
    let mut cmd = Command::new(executable);
    let mode = input["output_mode"]
        .as_str()
        .filter(|mode| !mode.is_empty())
        .unwrap_or("files_with_matches");
    match mode {
        "files_with_matches" => {
            cmd.arg("-l");
        }
        "count" => {
            cmd.arg("-c");
        }
        "content" if input["-n"] != false => {
            cmd.arg("-n");
        }
        _ => {}
    }
    if crate::js::truthy(&input["-i"]) {
        cmd.arg("-i");
    }
    if crate::js::truthy(&input["multiline"]) {
        cmd.args(["-U", "--multiline-dotall"]);
    }
    if let Some(n) = input.get("-C").or_else(|| input.get("context")) {
        cmd.args(["-C", &crate::js::to_string(n)]);
    } else {
        for key in ["-A", "-B"] {
            if let Some(n) = input.get(key) {
                cmd.args([key, &crate::js::to_string(n)]);
            }
        }
    }
    if let Some(kind) = input["type"].as_str() {
        let normalized = kind.to_lowercase();
        let kinds = match normalized.as_str() {
            "js" => vec!["js", "jsx", "mjs", "cjs"],
            "ts" => vec!["ts", "tsx", "mts", "cts"],
            "py" | "python" => vec!["py", "pyi"],
            "rust" | "rs" => vec!["rs"],
            "sh" | "shell" | "bash" => vec!["sh", "bash", "zsh"],
            "yaml" | "yml" => vec!["yaml", "yml"],
            "md" | "markdown" => vec!["md", "markdown"],
            "c" => vec!["c", "h"],
            "cpp" => vec!["cpp", "hpp", "cc", "hh", "cxx"],
            "rb" | "ruby" => vec!["rb"],
            "kt" | "kotlin" => vec!["kt", "kts"],
            "css" => vec!["css", "scss", "sass", "less"],
            "html" => vec!["html", "htm"],
            "go" | "java" | "php" | "swift" | "json" | "toml" | "xml" => vec![normalized.as_str()],
            _ => vec![],
        };
        for ext in kinds {
            cmd.args(["--glob", &format!("*.{ext}")]);
        }
    }
    if let Some(glob) = input["glob"].as_str().filter(|glob| !glob.is_empty()) {
        cmd.args(["--glob", glob]);
    }
    let root = file::real_path(&path);
    for denied in denials.iter().filter(|_| root.is_dir()) {
        if let Ok(relative) = denied.strip_prefix(&root) {
            if !relative.as_os_str().is_empty() {
                let relative = relative.to_string_lossy();
                let relative = if cfg!(windows) {
                    relative.replace('\\', "/")
                } else {
                    relative.into_owned()
                };
                let escaped: String = relative
                    .chars()
                    .map(|character| match character {
                        '\\' => "\\\\".into(),
                        '*' | '?' | '[' | ']' | '{' | '}' => format!("[{character}]"),
                        _ => character.to_string(),
                    })
                    .collect();
                cmd.args(["--glob", &format!("!/{escaped}")]);
            }
        }
    }
    // rg reads globs relative to its working directory: start it where the search starts.
    let scope = SearchScope::new(&path);
    cmd.arg("--").arg(pattern).arg(scope.argument());
    if let Some(directory) = scope.directory() {
        cmd.current_dir(directory);
    }
    cmd.env_clear().envs(&env).stdin(Stdio::null());
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error=%e,"Content search failed");
            return if e.kind() == std::io::ErrorKind::NotFound && executable == "rg" {
                failure(harness.text(TextId::ToolsGrepUnavailable))
            } else {
                failure(harness.render(TextId::ToolsGrepFailed, &[("error", &e.to_string())]))
            };
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let owned_process = processes.track(child, false);
    let errors = crate::runtime::spawn(async move {
        let mut bytes = Vec::new();
        if let Err(error) = stderr.read_to_end(&mut bytes).await {
            tracing::warn!(error=%error,"Content search stderr could not be read");
        }
        bytes
    });
    let mut output = String::new();
    let mut characters = 0;
    let mut early = false;
    let mut buffer = [0u8; 65536];
    loop {
        let count = tokio::select! {
            result = stdout.read(&mut buffer) => match result {
                Ok(count) => count,
                Err(error) => {
                    owned_process.abort_now();
                    let _ = owned_process.wait().await;
                    let _ = errors.await;
                    tracing::warn!(error=%error,"Content search stdout could not be read");
                    return failure(harness.render(TextId::ToolsGrepFailed, &[("error", &error.to_string())]));
                }
            },
            _ = ctx.cancellation.cancelled() => {
                owned_process.terminate(false).await;
                let _ = owned_process.wait().await;
                let _ = errors.await;
                tracing::warn!(reason = "aborted", "Content search failed");
                return failure(harness.text(TextId::ToolsGrepAborted));
            }
        };
        if count == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&buffer[..count]);
        characters += chunk.encode_utf16().count();
        output.push_str(&chunk);
        if characters > 100000 {
            early = true;
            owned_process.terminate(false).await;
        }
    }
    let status = owned_process.wait().await;
    let errors = errors.await.unwrap_or_default();
    if !early
        && !status
            .as_ref()
            .is_ok_and(|status| matches!(status.code(), Some(0 | 1)))
    {
        let code = status
            .as_ref()
            .ok()
            .and_then(|status| status.code())
            .map(|code| code.to_string())
            .unwrap_or_else(|| "null".into());
        let signal = status
            .as_ref()
            .ok()
            .and_then(status_signal)
            .map(|signal| format!(" ({signal})"))
            .unwrap_or_default();
        tracing::warn!(reason = "exit", exit_code = code, "Content search failed");
        return failure(harness.render(
            TextId::ToolsGrepExit,
            &[
                ("code", &code),
                ("signal", &signal),
                ("error", &String::from_utf8_lossy(&errors)),
            ],
        ));
    }
    if crate::js::trim_js(&output).is_empty() {
        let shown = path.to_string_lossy();
        let filters = [("glob", &input["glob"]), ("type", &input["type"])]
            .iter()
            .filter_map(|(name, value)| value.as_str().filter(|value| !value.is_empty()).map(|value| format!("{name} \"{value}\"")))
            .collect::<Vec<_>>()
            .join(" and ");
        return success(
            if filters.is_empty() {
                harness.render(TextId::ToolsGrepNoMatches, &[("pattern", pattern), ("path", &shown)])
            } else {
                harness.render(
                    TextId::ToolsGrepNoMatchesFiltered,
                    &[("pattern", pattern), ("path", &shown), ("filters", &filters)],
                )
            },
            None,
        );
    }
    let output = scope.display(&output);
    let lines: Vec<_> = output
        .strip_suffix('\n')
        .unwrap_or(&output)
        .split('\n')
        .collect();
    let offset = input["offset"].as_f64().unwrap_or(0.0);
    let limit = input["head_limit"].as_f64().unwrap_or(250.0);
    let shown: Vec<_> = lines
        .iter()
        .skip(if offset > 0.0 { offset as usize } else { 0 })
        .take(if limit > 0.0 {
            limit as usize
        } else {
            usize::MAX
        })
        .copied()
        .collect();
    let mut result = shown.join("\n");
    if offset > 0.0 || shown.len() < lines.len() || early {
        let first = crate::js::to_string(&serde_json::json!(offset + 1.0));
        let last = crate::js::to_string(&serde_json::json!(offset + shown.len() as f64));
        result.push_str(&harness.render(
            TextId::ToolsGrepPagination,
            &[
                ("first", &first),
                ("last", &last),
                (
                    "lower_bound",
                    if early {
                        harness.text(TextId::ToolsGrepLowerBound)
                    } else {
                        ""
                    },
                ),
                ("total", &lines.len().to_string()),
            ],
        ));
    }
    success(
        crate::core::truncate::truncate_content_with_harness(
            &result,
            50000,
            harness.text(TextId::ToolsGrepRecovery),
            harness,
        ),
        None,
    )
}

/// A directory search runs inside the directory, so a glob is read relative to it; rg then prints
/// paths relative to it, and they are shown under the path the caller gave. Any other path is searched as given.
struct SearchScope<'a> {
    shown: &'a std::path::Path,
    inside: bool,
}
impl<'a> SearchScope<'a> {
    fn new(shown: &'a std::path::Path) -> Self {
        Self { shown, inside: shown.is_dir() }
    }
    fn argument(&self) -> &std::ffi::OsStr {
        if self.inside { std::ffi::OsStr::new(".") } else { self.shown.as_os_str() }
    }
    fn directory(&self) -> Option<&std::path::Path> {
        self.inside.then_some(self.shown)
    }
    fn display(&self, output: &str) -> String {
        if !self.inside {
            return output.to_owned();
        }
        let separator = std::path::MAIN_SEPARATOR;
        let shown = self.shown.to_string_lossy();
        let shown = shown.trim_end_matches(separator);
        let prefix = format!(".{separator}");
        output
            .split_inclusive('\n')
            .map(|line| match line.strip_prefix(&prefix) {
                Some(rest) => format!("{shown}{separator}{rest}"),
                None => line.to_owned(),
            })
            .collect()
    }
}

fn status_signal(status: &std::process::ExitStatus) -> Option<&'static str> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        match status.signal()? {
            libc::SIGTERM => Some("SIGTERM"),
            libc::SIGKILL => Some("SIGKILL"),
            libc::SIGINT => Some("SIGINT"),
            libc::SIGABRT => Some("SIGABRT"),
            libc::SIGSEGV => Some("SIGSEGV"),
            libc::SIGPIPE => Some("SIGPIPE"),
            _ => Some("unknown"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grep_environment_inherits_without_mutating_and_removes_explicit_undefined() {
        let base = serde_json::json!({"PATH":"/system/bin","SHARED":"inherited","REMOVE":"remove"});
        let mut overrides = serde_json::json!({"PATH":"/session/bin"});
        overrides["REMOVE"] = crate::js::undefined();
        let mut actual = crate::core::conventions::merged_environment(&base, &[&overrides], false);
        assert_eq!(actual.get("PATH").map(String::as_str), Some("/session/bin"));
        assert_eq!(actual.get("SHARED").map(String::as_str), Some("inherited"));
        assert!(!actual.contains_key("REMOVE"));
        actual.insert("SHARED".into(), "changed".into());
        assert_eq!(base["SHARED"], "inherited");
        assert_eq!(overrides["PATH"], "/session/bin");
    }

    #[test]
    fn grep_environment_folds_windows_names_but_preserves_posix_case() {
        let base = serde_json::json!({"PATH":"system","SYSTEMROOT":"old"});
        let overrides = serde_json::json!({"Path":"session","agent_ripgrep_path":"host tools","SystemRoot":"new"});
        let windows = crate::core::conventions::merged_environment(&base, &[&overrides], true);
        assert_eq!(windows.get("PATH").map(String::as_str), Some("session"));
        assert_eq!(windows.get("SYSTEMROOT").map(String::as_str), Some("new"));
        assert_eq!(windows.get("AGENT_RIPGREP_PATH").map(String::as_str), Some("host tools"));
        assert_eq!(windows.len(), 3);
        let posix = crate::core::conventions::merged_environment(&base, &[&overrides], false);
        assert_eq!(posix.get("PATH").map(String::as_str), Some("system"));
        assert_eq!(posix.get("Path").map(String::as_str), Some("session"));
        assert!(!posix.contains_key("AGENT_RIPGREP_PATH"));
    }

    #[test]
    fn grep_override_requires_a_platform_absolute_path() {
        assert!(!std::path::Path::new("relative/rg").is_absolute());
        #[cfg(windows)]
        {
            assert!(!std::path::Path::new("C:relative\\rg.exe").is_absolute());
            assert!(std::path::Path::new(r"\\server\tools\rg.exe").is_absolute());
        }
        #[cfg(unix)]
        assert!(std::path::Path::new("/host tools/rg").is_absolute());
    }

    #[test]
    fn a_directory_search_starts_in_the_directory_and_restores_the_shown_path() {
        let root = std::env::temp_dir();
        let scope = SearchScope::new(&root);
        assert_eq!(scope.argument(), ".");
        assert_eq!(scope.directory(), Some(root.as_path()));
        let sep = std::path::MAIN_SEPARATOR;
        let shown = root.to_string_lossy();
        let shown = shown.trim_end_matches(sep);
        let rg = format!(".{sep}src{sep}a.ts:3:needle\n.{sep}b.ts\n--\n.{sep}b.ts-4-context\nplain text\n");
        assert_eq!(scope.display(&rg), format!("{shown}{sep}src{sep}a.ts:3:needle\n{shown}{sep}b.ts\n--\n{shown}{sep}b.ts-4-context\nplain text\n"));
    }

    #[test]
    fn a_file_or_missing_path_is_searched_as_given() {
        for path in [std::env::current_exe().unwrap(), std::env::temp_dir().join("halo-grep-missing-path-for-test/nowhere")] {
            let scope = SearchScope::new(&path);
            assert!(scope.directory().is_none());
            assert_eq!(scope.argument(), path.as_os_str());
            assert_eq!(scope.display("2:./not-a-path-prefix\n"), "2:./not-a-path-prefix\n");
            assert_eq!(scope.display("./looks-like-content\n"), "./looks-like-content\n");
        }
    }
}
