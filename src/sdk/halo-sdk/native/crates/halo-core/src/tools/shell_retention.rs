use std::{
    path::Path,
    time::{Duration, SystemTime},
};
use tokio::{fs, io::AsyncWriteExt};
pub async fn mark(path: &Path) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(path).await?;
    file.write_all(b"").await
}
pub async fn complete(path: &Path, pid: Option<u32>) -> std::io::Result<()> {
    mark(Path::new(&format!("{}.done", path.display()))).await?;
    if let Some(pid) = pid {
        remove(Path::new(&format!("{}.active-{pid}", path.display()))).await?;
    }
    if let Some(directory) = path.parent() {
        prune(directory).await?;
    }
    Ok(())
}
async fn remove(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
async fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        match tokio::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .await
        {
            Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")),
            Err(_) => true,
        }
    }
}
pub async fn prune(directory: &Path) -> std::io::Result<()> {
    let now = SystemTime::now();
    let mut entries = fs::read_dir(directory).await?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        files.push(entry.file_name().to_string_lossy().into_owned());
    }
    let pattern = regex::Regex::new(r"^(bash-[0-9a-f-]+\.output)\.active-(\d+)$").unwrap();
    let mut reclaimed = Vec::new();
    for name in &files {
        if let Some(captures) = pattern.captures(name) {
            if let Ok(pid) = captures[2].parse() {
                if !alive(pid).await {
                    let marker = format!("{}.done", &captures[1]);
                    mark(&directory.join(&marker)).await?;
                    remove(&directory.join(name)).await?;
                    reclaimed.push(marker);
                    tracing::warn!(task_id = &captures[1], "orphaned command output reclaimed");
                }
            }
        }
    }
    files.extend(reclaimed);
    let marked: std::collections::HashSet<_> = files
        .iter()
        .filter_map(|name| {
            name.strip_suffix(".done")
                .or_else(|| name.split_once(".active-").map(|v| v.0))
        })
        .collect();
    let output_name = regex::Regex::new(r"^bash-[0-9a-f-]+\.output$").unwrap();
    let completed_name = regex::Regex::new(r"^bash-[0-9a-f-]+\.output\.done$").unwrap();
    let mut completed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in &files {
        if output_name.is_match(name) && !marked.contains(name.as_str()) {
            let path = directory.join(name);
            match fs::symlink_metadata(&path).await {
                Ok(metadata)
                    if metadata.is_file()
                        && now
                            .duration_since(metadata.modified()?)
                            .unwrap_or(Duration::ZERO)
                            > Duration::from_secs(7 * 24 * 60 * 60) =>
                {
                    remove(&path).await?;
                    tracing::warn!("abandoned command output removed");
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        if !completed_name.is_match(name) || !seen.insert(name) {
            continue;
        }
        let marker = directory.join(name);
        let path = directory.join(name.trim_end_matches(".done"));
        match fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.is_file() => {
                completed.push((path, marker, metadata.len(), metadata.modified()?))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                remove(&marker).await?;
            }
            Err(error) => return Err(error),
        }
    }
    completed.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| a.0.cmp(&b.0)));
    let mut bytes = 0u64;
    let mut retained = 0usize;
    let mut removed = 0usize;
    for (path, marker, size, modified) in completed {
        if now.duration_since(modified).unwrap_or(Duration::ZERO)
            > Duration::from_secs(7 * 24 * 60 * 60)
            || retained >= 128
            || bytes + size > 256 * 1024 * 1024
        {
            remove(&path).await?;
            remove(&marker).await?;
            removed += 1;
        } else {
            bytes += size;
            retained += 1;
        }
    }
    if removed > 0 {
        tracing::warn!(
            removed,
            retained,
            bytes,
            "expired or over-budget command output removed"
        );
    }
    Ok(())
}
