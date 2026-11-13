use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};

fn platform(options: &Value) -> &str {
    options["platform"]
        .as_str()
        .unwrap_or(if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(windows) {
            "win32"
        } else {
            "linux"
        })
}
fn release() -> String {
    #[cfg(unix)]
    {
        let mut name = std::mem::MaybeUninit::<libc::utsname>::uninit();
        unsafe {
            if libc::uname(name.as_mut_ptr()) == 0 {
                return std::ffi::CStr::from_ptr(name.assume_init().release.as_ptr())
                    .to_string_lossy()
                    .into_owned();
            }
        }
    }
    #[cfg(windows)]
    {
        #[repr(C)]
        struct Version {
            size: u32,
            major: u32,
            minor: u32,
            build: u32,
            platform: u32,
            service_pack: [u16; 128],
        }
        #[link(name = "ntdll")]
        extern "system" {
            fn RtlGetVersion(version: *mut Version) -> i32;
        }
        let mut version = Version {
            size: std::mem::size_of::<Version>() as u32,
            major: 0,
            minor: 0,
            build: 0,
            platform: 0,
            service_pack: [0; 128],
        };
        unsafe {
            if RtlGetVersion(&mut version) == 0 {
                return format!("{}.{}.{}", version.major, version.minor, version.build);
            }
        }
    }
    String::new()
}
fn environment(options: &Value, version: String, is_git: bool) -> Value {
    let platform = platform(options);
    let shell = crate::core::conventions::process_value(options, "SHELL").unwrap_or_default();
    let shell = if shell.contains("zsh") {
        "zsh"
    } else if shell.contains("bash") {
        "bash"
    } else if shell.contains("fish") {
        "fish"
    } else if platform == "win32" {
        "powershell"
    } else if shell.is_empty() {
        "unknown"
    } else {
        &shell
    };
    json!({"platform":platform,"shell":shell,"osVersion":version,"isGitRepo":is_git})
}

async fn output(
    program: &str,
    args: &[&str],
    cwd: Option<&str>,
    options: &Value,
) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut command = tokio::process::Command::new(program);
    command
        .env_clear()
        .envs(crate::core::conventions::merged_environment(
            &crate::core::conventions::process_environment(options),
            &[],
            false,
        ));
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(1_048_577);
    let completion = async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.ok()?;
        if bytes.len() > 1_048_576 {
            return None;
        }
        child
            .wait()
            .await
            .ok()?
            .success()
            .then(|| crate::js::trim_js(&String::from_utf8_lossy(&bytes)).to_owned())
    };
    tokio::time::timeout(Duration::from_secs(3), completion)
        .await
        .ok()
        .flatten()
}

fn output_sync(program: &str, args: &[&str], cwd: Option<&str>, options: &Value) -> Option<String> {
    use std::io::Read;
    let mut command = std::process::Command::new(program);
    command
        .env_clear()
        .envs(crate::core::conventions::merged_environment(
            &crate::core::conventions::process_environment(options),
            &[],
            false,
        ));
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .ok()
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut bytes = None;
    let outcome = loop {
        if bytes.is_none() {
            match receiver.recv_timeout(Duration::from_millis(5)) {
                Ok(Some(value)) if value.len() <= 1_048_576 => bytes = Some(value),
                Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break None,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            if let Some(bytes) = bytes.take() {
                break status
                    .success()
                    .then(|| crate::js::trim_js(&String::from_utf8_lossy(&bytes)).to_owned());
            }
        }
        if std::time::Instant::now() >= deadline {
            break None;
        }
        if bytes.is_some() {
            std::thread::sleep(Duration::from_millis(1));
        }
    };
    if outcome.is_none() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    outcome
}

pub async fn probe(options: &Value) -> Value {
    let version = if platform(options) == "win32" {
        format!("Windows {}", release())
    } else {
        output("uname", &["-s", "-r"], None, options)
            .await
            .unwrap_or_else(|| format!("{} {}", platform(options), release()))
    };
    let is_git = output(
        "git",
        &["rev-parse", "--is-inside-work-tree"],
        Some(options["cwd"].as_str().unwrap_or(".")),
        options,
    )
    .await
    .is_some();
    environment(options, version, is_git)
}

pub fn probe_sync(options: &Value) -> Value {
    let version = if platform(options) == "win32" {
        format!("Windows {}", release())
    } else {
        output_sync("uname", &["-s", "-r"], None, options)
            .unwrap_or_else(|| format!("{} {}", platform(options), release()))
    };
    let is_git = output_sync(
        "git",
        &["rev-parse", "--is-inside-work-tree"],
        Some(options["cwd"].as_str().unwrap_or(".")),
        options,
    )
    .is_some();
    environment(options, version, is_git)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn synchronous_and_async_environment_probes_share_observable_values() {
        let options = json!({"cwd":env!("CARGO_MANIFEST_DIR")});
        assert_eq!(probe(&options).await, probe_sync(&options));
        let mut replaced = options;
        replaced["platform"] = json!("win32");
        let environment = probe_sync(&replaced);
        assert!(environment["osVersion"]
            .as_str()
            .unwrap()
            .starts_with("Windows "));
        assert!(environment.get("gitBranch").is_none());
    }
}
