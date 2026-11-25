use super::{failure, file, success, ToolContext};
use crate::harness::TextId;
use serde_json::Value;
use std::{borrow::Cow, path::Path, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const ERROR_EXAMPLES: usize = 3;
const ERROR_LINE_BYTES: usize = 1024;

#[derive(Default)]
struct SearchErrors {
    total: usize,
    examples: Vec<String>,
}

impl SearchErrors {
    fn record(&mut self, describe: impl FnOnce() -> String) {
        self.total += 1;
        if self.examples.len() < ERROR_EXAMPLES {
            self.examples.push(describe());
        }
    }

    async fn stderr(mut source: impl AsyncRead + Unpin) -> Self {
        let mut errors = Self::default();
        let mut line = Vec::new();
        let mut continued = false;
        let mut buffer = [0; 8192];
        loop {
            let read = match source.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    tracing::warn!(error=%error, "Content search stderr could not be read");
                    break;
                }
            };
            for part in buffer[..read].split_inclusive(|&b| b == b'\n') {
                let terminated = part.ends_with(b"\n");
                let content = if terminated { &part[..part.len() - 1] } else { part };
                if errors.examples.len() < ERROR_EXAMPLES {
                    let take = content.len().min(ERROR_LINE_BYTES + 1 - line.len());
                    line.extend_from_slice(&content[..take]);
                }
                continued = !terminated;
                if terminated {
                    errors.record(|| diagnostic_line(&line));
                    line.clear();
                }
            }
        }
        if continued { errors.record(|| diagnostic_line(&line)); }
        errors
    }

    fn grep_summary(&self, harness: &crate::harness::ResolvedHarness) -> String {
        let mut text = self.examples.join("\n");
        let omitted = self.total - self.examples.len();
        if omitted > 0 {
            text.push_str(&harness.render(TextId::ToolsGrepMoreErrors, &[("count", &omitted.to_string())]));
        }
        text
    }
}

fn diagnostic_line(line: &[u8]) -> String {
    if line.len() <= ERROR_LINE_BYTES {
        String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line)).into_owned()
    } else {
        format!("{}…", String::from_utf8_lossy(&line[..ERROR_LINE_BYTES]))
    }
}

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
    let mut pending = vec![(base.clone(), real_base, true, 0)];
    let mut entries = Vec::new();
    let mut unreadable = SearchErrors::default();
    while let Some((path, real_path, directory, depth)) = pending.pop() {
        if ctx.cancellation.is_cancelled() {
            return failure(harness.text(TextId::ToolsGlobAborted));
        }
        if file::denied_real(&real_path, denials) {
            continue;
        }
        if directory {
            let mut reader = match tokio::fs::read_dir(&path).await {
                Ok(reader) => reader,
                Err(_) if depth > 0 => {
                    unreadable.record(|| diagnostic_line(path.to_string_lossy().as_bytes()));
                    continue;
                }
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
                    Err(_) if depth > 0 => {
                        unreadable.record(|| diagnostic_line(path.to_string_lossy().as_bytes()));
                        break;
                    }
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
                if kind.is_dir() {
                    let display = name.to_string_lossy();
                    if !skip.contains(&display.as_ref()) && matcher.can_descend(depth, &display) {
                        pending.push((entry.path(), real_path.join(&name), true, depth + 1));
                    }
                } else if kind.is_file() {
                    pending.push((entry.path(), real_path.join(&name), false, depth + 1));
                }
            }
        } else if matcher.matches(&path.strip_prefix(&base).unwrap_or(&path).to_string_lossy()) {
            match tokio::fs::metadata(&path).await {
                Ok(metadata) => entries.push((path, file::modified(&metadata))),
                Err(error) => tracing::warn!(error=%error,"Glob file metadata could not be read"),
            }
        }
    }
    if entries.is_empty() && unreadable.total == 0 {
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
    if unreadable.total > 0 {
        tracing::warn!(directories = unreadable.total, "Glob could not read all directories");
        if entries.is_empty() {
            output.push_str(harness.text(TextId::ToolsGlobNoReadableMatches));
            output.push('\n');
        }
        output.push_str(&harness.render(TextId::ToolsGlobPartial, &[
            ("count", &unreadable.total.to_string()), ("paths", &unreadable.examples.join("\n")),
        ]));
    }
    success(output, None)
}

fn grep_pattern(pattern: &str) -> Cow<'_, str> {
    if !pattern.contains('$') { return pattern.into(); }
    static CARRIAGE_RETURN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^\\(?:r|x0d|u000d|u0000000d|[xu]\{0*d\})").unwrap()
    });
    // Only change line-end assertions; the global --crlf flag also changes dot and literal CR matches.
    let mut result = String::new();
    let mut start = 0;
    let mut depth = 0usize;
    let mut extended = false;
    let mut groups = Vec::new();
    let mut chars = pattern.char_indices();
    while let Some((index, character)) = chars.next() {
        match character {
            '#' if extended => { chars.by_ref().find(|(_, c)| *c == '\n'); }
            '\r' if !extended => return pattern.into(),
            '\\' => {
                if CARRIAGE_RETURN.is_match(&pattern[index..]) { return pattern.into(); }
                chars.next();
            }
            '(' if depth == 0 => {
                let previous = extended;
                let mut flags = chars.clone();
                let mut standalone = false;
                if matches!(flags.next(), Some((_, '?'))) {
                    let mut enabled = true;
                    let mut next = extended;
                    for (_, flag) in flags.by_ref() {
                        match flag {
                            'x' => next = enabled,
                            '-' => enabled = false,
                            'i' | 'm' | 's' | 'R' | 'U' | 'u' => {}
                            ':' | ')' => {
                                extended = next;
                                standalone = flag == ')';
                                chars = flags;
                                break;
                            }
                            _ => break,
                        }
                    }
                }
                if !standalone { groups.push(previous); }
            }
            ')' if depth == 0 => extended = groups.pop().unwrap_or(false),
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            '$' if depth == 0 => {
                result.push_str(&pattern[start..index]);
                result.push_str("(?R:$)");
                start = index + 1;
            }
            _ => {}
        }
    }
    if start == 0 { return pattern.into(); }
    result.push_str(&pattern[start..]);
    result.into()
}

fn grep_glob(pattern: &str, windows: bool) -> Cow<'_, str> {
    if windows && pattern.contains('\\') {
        pattern.replace('\\', "/").into()
    } else {
        pattern.into()
    }
}

fn grep_file_matches(glob: &str, relative: &Path) -> Result<bool, globset::Error> {
    let (exclude, glob) = glob.strip_prefix('!').map_or((false, glob), |glob| (true, glob));
    let directories_only = glob.ends_with('/');
    let anchored = glob.trim_end_matches('/').contains('/');
    let matcher = globset::GlobBuilder::new(glob.trim_matches('/'))
        .literal_separator(true)
        .backslash_escape(true)
        .build()?
        .compile_matcher();
    let matches = |path: &Path| {
        let candidate = if anchored { path } else { Path::new(path.file_name().unwrap_or_default()) };
        matcher.is_match(candidate)
    };
    let matched = !directories_only && matches(relative);
    let excluded_parent = exclude && relative.ancestors().skip(1).any(matches);
    Ok((matched || excluded_parent) != exclude)
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
    let kind = input["type"].as_str().filter(|value| !value.is_empty());
    let glob = input["glob"].as_str().filter(|value| !value.is_empty());
    if kind.is_some() && glob.is_some_and(|glob| !glob.starts_with('!')) {
        return failure(harness.text(TextId::ToolsGrepCombinedFilters));
    }
    if kind.is_some() && path.is_file() {
        return failure(harness.text(TextId::ToolsGrepSingleFileFilter));
    }
    let glob = glob.map(|glob| grep_glob(glob, cfg!(windows)));
    if let Some(glob) = &glob {
        // rg bypasses file filters for an explicit file. Only precheck a known relative path.
        if let Some(relative) = path.strip_prefix(&ctx.cwd).ok().filter(|_| path.is_file()) {
            match grep_file_matches(glob, relative) {
                Ok(false) => return success(harness.text(TextId::ToolsGrepFileExcluded), None),
                Err(error) => return failure(harness.render(
                    TextId::ToolsGrepFailed, &[("error", &error.to_string())],
                )),
                Ok(true) => {}
            }
        }
    }
    let env =
        crate::core::conventions::merged_environment(base_environment, &[&ctx.env], cfg!(windows));
    let executable = env
        .get("AGENT_RIPGREP_PATH")
        .map(String::as_str)
        .filter(|path| Path::new(path).is_absolute())
        .unwrap_or("rg");
    #[cfg(windows)]
    let program = if executable == "rg" {
        let path = env.get("PATH").filter(|path| !path.is_empty()).cloned();
        let resolved = if let Some(path) = path {
            let timeout = std::time::Duration::from_secs(5);
            let deadline = std::time::Instant::now() + timeout;
            let cancel = ctx.cancellation.clone();
            let lookup = tokio::task::spawn_blocking(move || {
                super::windows_executable::resolve("rg", &path, Some(".EXE"), || {
                    !cancel.is_cancelled() && std::time::Instant::now() < deadline
                })
            });
            tokio::select! {
                biased;
                _ = ctx.cancellation.cancelled() => {
                    tracing::warn!(reason = "aborted", "Content search executable lookup interrupted");
                    return failure(harness.text(TextId::ToolsGrepAborted));
                }
                result = tokio::time::timeout(timeout, lookup) => match result {
                    Ok(Ok(path)) => path,
                    Ok(Err(error)) => {
                        tracing::warn!(%error, "Content search executable lookup failed");
                        return failure(harness.render(TextId::ToolsGrepFailed, &[("error", &error.to_string())]));
                    }
                    Err(_) => {
                        tracing::warn!(reason = "deadline", "Content search executable lookup timed out");
                        return failure(harness.text(TextId::ToolsGrepUnavailable));
                    }
                }
            }
        } else {
            None
        };
        let Some(program) = resolved else {
            tracing::warn!(reason = "not_found", "Ripgrep is not available on the session PATH");
            return failure(harness.text(TextId::ToolsGrepUnavailable));
        };
        program
    } else {
        std::path::PathBuf::from(executable)
    };
    #[cfg(not(windows))]
    let program = executable;
    let mut cmd = Command::new(program);
    cmd.arg("--no-config");
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
    if let Some(kind) = kind {
        let normalized = kind.to_lowercase();
        let kind = match normalized.as_str() {
            "rs" => "rust",
            "shell" | "bash" => "sh",
            "yml" => "yaml",
            "rb" => "ruby",
            "kt" => "kotlin",
            other => other,
        };
        if kind == "css" {
            cmd.args(["--type-add", "css:*.sass", "--type-add", "css:*.less"]);
        }
        cmd.args(["--type", kind]);
    }
    if let Some(glob) = glob {
        cmd.arg("--glob").arg(glob.as_ref());
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
    cmd.arg("--").arg(grep_pattern(pattern).as_ref()).arg(scope.argument());
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
    let stderr = child.stderr.take().unwrap();
    let owned_process = processes.track(child, false);
    let errors = crate::runtime::spawn(SearchErrors::stderr(stderr));
    let mut bytes = Vec::new();
    let mut next_size_check = 100_000;
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
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > next_size_check {
            let units = String::from_utf8_lossy(&bytes).encode_utf16().count();
            if units > 100_000 {
                early = true;
                owned_process.terminate(false).await;
                break;
            }
            next_size_check = bytes.len() + (100_000 - units);
        }
    }
    drop(stdout);
    let status = owned_process.wait().await;
    let errors = errors.await.unwrap_or_default();
    let exit_code = status.as_ref().ok().and_then(|status| status.code());
    let partial = exit_code == Some(2) && !bytes.is_empty();
    if partial {
        tracing::warn!(exit_code = 2, "Content search returned partial results");
    } else if !early && !matches!(exit_code, Some(0 | 1)) {
        let code = exit_code
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
                ("error", &errors.grep_summary(harness)),
            ],
        ));
    }
    if !early && exit_code == Some(1) {
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
    if bytes.is_empty() {
        return success(harness.text(TextId::ToolsGrepEmptyOutput), None);
    }
    let output = scope.display(&String::from_utf8_lossy(&bytes));
    let lines: Vec<_> = output.lines().collect();
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
    let mut result = if matches!(shown.as_slice(), [""]) {
        harness.text(TextId::ToolsGrepEmptyLine).to_owned()
    } else {
        shown.join("\n")
    };
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
    if partial {
        let note = harness.render(TextId::ToolsGrepPartial, &[
            ("error", &errors.grep_summary(harness)),
        ]);
        result = format!("{note}\n\n{result}");
    }
    let result = crate::core::truncate::truncate_content_with_harness(
        &result, 50000, harness.text(TextId::ToolsGrepRecovery), harness,
    );
    if partial { failure(result) } else { success(result, None) }
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

    #[tokio::test]
    async fn stderr_preview_drains_long_lines_and_counts_an_unterminated_tail() {
        let bytes = format!("first\r\n{}\nlast visible\n\nlast omitted", "x".repeat(40_000));
        let errors = SearchErrors::stderr(bytes.as_bytes()).await;
        assert_eq!(errors.total, 5);
        assert_eq!(errors.examples.len(), ERROR_EXAMPLES);
        assert_eq!(errors.examples[0], "first");
        assert_eq!(errors.examples[1], format!("{}…", "x".repeat(ERROR_LINE_BYTES)));
        assert_eq!(errors.examples[2], "last visible");
    }

    #[test]
    fn windows_grep_globs_use_path_separators_without_changing_posix_escapes() {
        assert_eq!(grep_glob(r"src\**\*.rs", true), "src/**/*.rs");
        assert_eq!(grep_glob(r"src/\*.rs", false), r"src/\*.rs");
    }

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
