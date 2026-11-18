use super::transcript_path;
use serde_json::Value;
use std::time::UNIX_EPOCH;
use tokio::fs;

pub async fn latest_session(options: &Value) -> Option<String> {
    let placeholder = transcript_path("__placeholder__", options);
    let directory = placeholder.parent()?;
    let mut entries = match fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(error = %error, "Session history directory could not be read for continuation");
            return None;
        }
    };
    let mut candidates = Vec::new();
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => {
                let Ok(name) = entry.file_name().into_string() else {
                    tracing::warn!("Session history candidate has an unsupported filename encoding");
                    continue;
                };
                if name.ends_with(".jsonl") && !name.starts_with('.') && !name.starts_with("agent-") {
                    candidates.push(name);
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(error = %error, "Session history directory scan failed for continuation");
                return None;
            }
        }
    }
    candidates.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    let mut latest_mtime = 0.0;
    let mut latest = None;
    for name in candidates {
        let modified = match fs::metadata(directory.join(&name)).await.and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(error) => {
                tracing::warn!(candidate = name, error = %error, "Session history candidate could not be inspected for continuation");
                continue;
            }
        };
        let Ok(duration) = modified.duration_since(UNIX_EPOCH) else { continue; };
        let mtime = duration.as_secs() as f64 * 1000.0 + duration.subsec_nanos() as f64 / 1_000_000.0;
        if mtime > latest_mtime {
            latest_mtime = mtime;
            latest = Some(name[..name.len() - ".jsonl".len()].to_owned());
        }
    }
    latest
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs::{File, FileTimes}, time::Duration};

    #[tokio::test]
    async fn continuation_uses_the_latest_eligible_transcript_in_the_configured_store() {
        let root = std::env::temp_dir().join(format!("halo-continue-{}", uuid::Uuid::new_v4()));
        let options = json!({"cwd":"/fixture/workspace", "env":{"STORE":root}, "conventions":{"configDirEnv":"STORE"}});
        let path = transcript_path("ignored", &options);
        let directory = path.parent().unwrap();
        assert_eq!(latest_session(&options).await, None);
        fs::create_dir_all(directory).await.unwrap();
        for (name, modified) in [("older.jsonl", 1), ("b.jsonl", 2), ("a.jsonl", 2), (".private.jsonl", 5), ("agent-child.jsonl", 6), ("metadata.json", 7)] {
            let file = File::create(directory.join(name)).unwrap();
            file.set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(modified))).unwrap();
        }
        assert_eq!(latest_session(&options).await.as_deref(), Some("a"));
        fs::remove_dir_all(root).await.unwrap();
    }
}
