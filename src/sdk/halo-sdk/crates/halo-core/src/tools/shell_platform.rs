use serde_json::Value;
use std::collections::HashSet;

pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
pub(super) fn windows_to_posix(value: &str) -> String {
    let portable = value.replace('\\', "/");
    let bytes = portable.as_bytes();
    if bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(1) == Some(&b':')
        && bytes.get(2) == Some(&b'/')
    {
        format!("/{}{}", portable[..1].to_lowercase(), &portable[2..])
    } else {
        portable
    }
}
pub(super) fn posix_to_windows(value: &str) -> String {
    let parts: Vec<_> = value.split('/').collect();
    if parts[0].is_empty() {
        let drive = if parts.get(1) == Some(&"cygdrive") {
            2
        } else {
            1
        };
        if let Some(letter) = parts
            .get(drive)
            .filter(|letter| letter.len() == 1 && letter.as_bytes()[0].is_ascii_alphabetic())
        {
            let rest = &parts[drive + 1..];
            return format!("{}:\\{}", letter.to_uppercase(), rest.join("\\"));
        }
    }
    parts.join("\\")
}
pub(super) fn null_redirect(command: &str) -> String {
    let mut output = String::new();
    let mut copied = 0;
    let mut scan = 0;
    while let Some(relative) = command[scan..].find('>') {
        let mut target = scan + relative + 1;
        while let Some(character) = command[target..]
            .chars()
            .next()
            .filter(|character| crate::js::is_whitespace(*character))
        {
            target += character.len_utf8();
        }
        scan = target;
        if command
            .get(target..target + 3)
            .is_none_or(|word| !word.eq_ignore_ascii_case("nul"))
        {
            continue;
        }
        let following = command[target + 3..].chars().next();
        if following.is_none_or(|character| {
            crate::js::is_whitespace(character) || "|&;)".contains(character)
        }) {
            output.push_str(&command[copied..target]);
            output.push_str("/dev/null");
            copied = target + 3;
            scan = copied;
        }
    }
    if copied == 0 {
        return command.into();
    }
    output.push_str(&command[copied..]);
    output
}

#[cfg(any(windows, test))]
fn windows_ps_executable(shell: &std::path::Path) -> Option<std::path::PathBuf> {
    let name = shell.file_name()?.to_str()?;
    if !["bash.exe", "sh.exe"].iter().any(|candidate| name.eq_ignore_ascii_case(candidate)) {
        return None;
    }
    let directory = std::path::absolute(shell.parent()?).ok()?;
    [directory.join("ps.exe"), directory.join("../usr/bin/ps.exe")]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

#[cfg(any(windows, test))]
fn native_process_table(output: &[u8]) -> std::io::Result<Vec<Value>> {
    let text = std::str::from_utf8(output)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "native process table was not UTF-8"))?;
    match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(Value::Array(rows)) if !rows.is_empty() => Ok(rows),
        Ok(row @ Value::Object(_)) => Ok(vec![row]),
        _ => Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "native process table was incomplete or invalid")),
    }
}

#[cfg(windows)]
async fn capture_process_table(
    executable: &std::path::Path,
    args: &[&str],
    deadline: std::time::Duration,
) -> std::io::Result<Vec<u8>> {
    use std::{io, process::Stdio};
    use tokio::io::AsyncReadExt;

    const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;
    let mut child = tokio::process::Command::new(executable)
        .args(args)
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().expect("process table capture has stdout");
    let operation = async {
        let mut output = Vec::new();
        stdout.take(OUTPUT_LIMIT + 1).read_to_end(&mut output).await?;
        if output.len() as u64 > OUTPUT_LIMIT {
            return Err(io::Error::other("process table output exceeded its capture limit"));
        }
        let status = child.wait().await?;
        if !status.success() {
            return Err(io::Error::other(status.to_string()));
        }
        Ok(output)
    };
    match tokio::time::timeout(deadline, operation).await {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "process table capture timed out")),
    }
}

#[cfg(windows)]
async fn windows_process_snapshot(root: u32, ps: &std::path::Path) -> std::io::Result<Vec<u32>> {
    use std::time::Duration;

    let powershell = crate::processes::windows_system_directory()?.join("WindowsPowerShell/v1.0/powershell.exe");
    let native = capture_process_table(
        &powershell,
        &[
            "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parent';e={$_.ParentProcessId}},@{n='created';e={if ($null -ne $_.CreationDate) {$_.CreationDate.ToFileTimeUtc()}}} | ConvertTo-Json -Compress",
        ],
        Duration::from_secs(4),
    ).await?;
    let native = native_process_table(&native)?;
    let posix = capture_process_table(ps, &["-e"], Duration::from_secs(2)).await?;
    let posix = String::from_utf8_lossy(&posix);
    if !posix.lines().next().is_some_and(|line| line.split_ascii_whitespace().take(4).eq(["PID", "PPID", "PGID", "WINPID"])) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "MSYS process table has unexpected columns"));
    }
    Ok(owned_windows_processes(root, &native, &posix, std::process::id()))
}

#[cfg(windows)]
pub(super) async fn terminate_windows_shell(
    process: &crate::processes::OwnedProcess,
    shell: &std::path::Path,
    force: bool,
) -> Option<bool> {
    if let (Some(root), Some(ps)) = (process.id(), windows_ps_executable(shell)) {
        match windows_process_snapshot(root, &ps).await {
            Ok(pids) if !pids.is_empty() => {
                return Some(process.terminate_windows_tree(pids).await);
            }
            Ok(_) => tracing::warn!(pid = root, "MSYS process table had no owned PIDs; using native tree termination"),
            Err(error) => tracing::warn!(pid = root, error=%error, "MSYS process ancestry could not be observed; using native tree termination"),
        }
    }
    process.terminate(force).await;
    None
}

#[cfg(any(windows, test))]
pub(super) fn owned_windows_processes(
    root: u32,
    native: &[Value],
    posix: &str,
    current_pid: u32,
) -> Vec<u32> {
    // A process can still name its original parent after Windows reuses that parent's PID.
    let creation_times: std::collections::HashMap<_, _> = native
        .iter()
        .filter_map(|row| Some((row["pid"].as_u64()?, row["created"].as_u64()?)))
        .collect();
    let mut native_ids = vec![root];
    let mut owned: HashSet<_> = [root].into_iter().collect();
    let mut posix_ids = HashSet::new();
    let rows: Vec<_> = posix
        .split('\n')
        .filter_map(|line| {
            let mut cells = line.split_ascii_whitespace();
            let first = cells.next()?;
            let pid = match first {
                "S" | "I" | "O" => cells.next()?,
                _ => first,
            }.parse::<u32>().ok()?;
            let parent = cells.next()?.parse::<u32>().ok()?;
            cells.next()?.parse::<u32>().ok()?;
            let native = cells.next()?.parse::<u32>().ok()?;
            (pid != 0 && native != current_pid).then_some((pid, parent, native))
        })
        .collect();
    loop {
        let mut changed = false;
        for row in native {
            if let (Some(pid), Some(parent)) = (
                crate::js::safe_integer(&row["pid"]),
                crate::js::safe_integer(&row["parent"]),
            ) {
                if pid > 0
                    && pid <= u32::MAX as i64
                    && pid != i64::from(current_pid)
                    && parent > 0
                    && parent <= u32::MAX as i64
                    && owned.contains(&(parent as u32))
                    && creation_times.get(&(pid as u64)).is_none_or(|child| {
                        creation_times.get(&(parent as u64)).is_some_and(|parent| child >= parent)
                    })
                    && owned.insert(pid as u32)
                {
                    native_ids.push(pid as u32);
                    changed = true;
                }
            }
        }
        for (pid, parent, native) in &rows {
            if owned.contains(native) || posix_ids.contains(parent) {
                if owned.insert(*native) {
                    native_ids.push(*native);
                    changed = true;
                }
                if posix_ids.insert(*pid) {
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    native_ids
        .into_iter()
        .filter(|pid| *pid > 0 && *pid != current_pid)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_conversion_preserves_drive_unc_and_relative_paths() {
        for (input, expected) in [
            (r"D:\bar\baz", "/d/bar/baz"),
            ("C:/Users/foo", "/c/Users/foo"),
            (r"C:\Foo", "/c/Foo"),
            (r"Z:\Bar", "/z/Bar"),
            (r"\\server\share\file", "//server/share/file"),
            (r".\config", "./config"),
            ("/already/posix", "/already/posix"),
        ] {
            assert_eq!(windows_to_posix(input), expected, "{input:?}");
        }
        for (input, expected) in [
            ("/d/bar", r"D:\bar"),
            ("/c/foo", r"C:\foo"),
            ("/Z/bar", r"Z:\bar"),
            ("/cygdrive/c/Users/foo", r"C:\Users\foo"),
            ("//server/share/file", r"\\server\share\file"),
            ("/c", "C:\\"),
            ("/c/", "C:\\"),
            ("foo/bar", r"foo\bar"),
        ] {
            assert_eq!(posix_to_windows(input), expected, "{input:?}");
        }
        let original = r"C:\Users\foo\bar";
        assert_eq!(posix_to_windows(&windows_to_posix(original)), original);
    }

    #[test]
    fn redirections_and_quotes_preserve_remaining_literal_cases() {
        for (input, expected) in [
            ("cmd 2>nul", "cmd 2>/dev/null"),
            ("cmd 2>NUL", "cmd 2>/dev/null"),
            ("cat nul.txt", "cat nul.txt"),
            ("echo nul", "echo nul"),
        ] {
            assert_eq!(null_redirect(input), expected, "{input:?}");
        }
        assert_eq!(quote("a b c"), "'a b c'");
        assert_eq!(quote("$PATH"), "'$PATH'");
    }

    #[test]
    fn windows_ps_is_found_beside_supported_shells_or_in_git_usr_bin() {
        let root = std::env::temp_dir().join(format!("halo-shell-ps-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        let usr_bin = root.join("usr/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&usr_bin).unwrap();
        assert!(windows_ps_executable(&bin.join("bash.exe")).is_none());
        std::fs::write(usr_bin.join("ps.exe"), "fixture").unwrap();
        let ps = windows_ps_executable(&bin.join("BaSh.ExE")).unwrap();
        assert_eq!(ps.canonicalize().unwrap(), usr_bin.join("ps.exe").canonicalize().unwrap());
        std::fs::write(bin.join("ps.exe"), "fixture").unwrap();
        assert_eq!(windows_ps_executable(&bin.join("sh.exe")), Some(bin.join("ps.exe")));
        assert!(windows_ps_executable(&bin.join("node.exe")).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_ancestry_does_not_traverse_through_the_host_or_zero_pid() {
        let native = native_process_table(br#"[
            {"pid":101,"parent":100}, {"pid":200,"parent":100}, {"pid":201,"parent":200},
            {"pid":400,"parent":0}, {"pid":102,"parent":999}, {"pid":103,"parent":102}
        ]"#).unwrap();
        let posix = "PID PPID PGID WINPID TTY UID STIME COMMAND\r\n 11 1 11 101 ? 1 00:00 bash\r\n 12 11 11 0 ? 1 00:00 transient\r\nS 13 12 11 102 ? 1 00:00 sleep\r\n 14 11 11 200 ? 1 00:00 host\r\n 15 14 11 201 ? 1 00:00 unrelated\r\n";
        assert_eq!(owned_windows_processes(100, &native, posix, 200), [100, 101, 102, 103]);
        assert_eq!(native_process_table(b"\xef\xbb\xbf{\"pid\":1,\"parent\":0}").unwrap().len(), 1);
        assert!(native_process_table(b"not JSON").is_err());
        assert!(native_process_table(b"[]").is_err());
    }

    #[test]
    fn windows_ancestry_rejects_a_child_older_than_its_reused_parent_pid() {
        let native = native_process_table(br#"[
            {"pid":102,"parent":101,"created":134085024000000001},
            {"pid":103,"parent":101,"created":134085024000000002},
            {"pid":104,"parent":101,"created":134085024000000003},
            {"pid":105,"parent":102,"created":134085024000000004},
            {"pid":106,"parent":101},
            {"pid":107,"parent":106,"created":134085024000000005},
            {"pid":100,"parent":200,"created":134085024000000000},
            {"pid":101,"parent":100,"created":134085024000000002}
        ]"#).unwrap();
        assert_eq!(owned_windows_processes(100, &native, "", 200), [100, 101, 103, 104, 106]);
    }

    #[test]
    fn windows_paths_redirections_and_process_ancestry_match_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/shell-platform.json")).unwrap();
        for case in fixture["windowsToPosix"].as_array().unwrap() {
            assert_eq!(
                windows_to_posix(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["posixToWindows"].as_array().unwrap() {
            assert_eq!(
                posix_to_windows(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["nullRedirect"].as_array().unwrap() {
            assert_eq!(
                null_redirect(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["quotes"].as_array().unwrap() {
            assert_eq!(
                quote(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["ancestry"].as_array().unwrap() {
            assert_eq!(
                serde_json::json!(owned_windows_processes(
                    case["root"].as_u64().unwrap() as u32,
                    case["native"].as_array().unwrap(),
                    case["posix"].as_str().unwrap(),
                    case["self"].as_u64().unwrap() as u32
                )),
                case["expected"]
            );
        }
    }
}
