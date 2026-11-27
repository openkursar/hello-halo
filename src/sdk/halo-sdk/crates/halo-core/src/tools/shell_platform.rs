#[cfg(any(windows, test))]
mod windows_ancestry;
#[cfg(windows)]
mod windows_stop;
#[cfg(windows)]
pub(super) use windows_stop::{terminate_windows_shell, WINDOWS_STOP_BUDGET};

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

#[cfg(windows)]
async fn capture_process_table(
    executable: &std::path::Path,
    deadline: std::time::Duration,
) -> std::io::Result<Vec<u8>> {
    use std::{io, process::Stdio};
    use tokio::io::AsyncReadExt;

    const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;
    let mut child = tokio::process::Command::new(executable)
        .arg("-e")
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
    fn windows_paths_redirections_and_quotes_match_fixtures() {
        let fixture: serde_json::Value =
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
    }
}
