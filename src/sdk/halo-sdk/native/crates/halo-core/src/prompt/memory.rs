use crate::harness::{ResolvedHarness, TextId};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy)]
enum Source {
    User,
    Project,
    Parent,
}
struct MemoryFile {
    path: PathBuf,
    content: String,
    source: Source,
}
struct ContextData {
    files: Vec<MemoryFile>,
    date: String,
}
fn convention(options: &Value, key: &str, fallback: &[&str]) -> Vec<String> {
    options["conventions"][key]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| fallback.iter().map(|value| value.to_string()).collect())
}
fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut result = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            _ => result.push(component),
        }
    }
    result
}
async fn probe(
    directory: &Path,
    names: &[String],
    subdirs: &[String],
    cwd: &Path,
    home: &Path,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<MemoryFile>,
) {
    for subdir in subdirs {
        for name in names {
            let path = directory.join(subdir).join(name);
            match tokio::fs::read(&path).await {
                Ok(bytes) => {
                    let raw = String::from_utf8_lossy(&bytes);
                    let content = crate::js::trim_js(&raw);
                    if content.is_empty() {
                        continue;
                    }
                    let identity = tokio::fs::canonicalize(&path)
                        .await
                        .unwrap_or_else(|_| absolute(&path));
                    if seen.insert(identity) {
                        let resolved = absolute(&path);
                        let source = if resolved.starts_with(home) && !resolved.starts_with(cwd) {
                            Source::User
                        } else if resolved.starts_with(cwd) {
                            Source::Project
                        } else {
                            Source::Parent
                        };
                        files.push(MemoryFile {
                            path,
                            content: content.to_owned(),
                            source,
                        });
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                Err(error) => tracing::warn!(error=%error,"Project instructions could not be read"),
            }
        }
    }
}
async fn collect(options: &Value) -> Vec<MemoryFile> {
    let cwd = absolute(Path::new(options["cwd"].as_str().unwrap_or(".")));
    let raw_home = PathBuf::from(crate::core::conventions::home(options));
    let home = absolute(&raw_home);
    let sources = options["settingSources"]
        .as_array()
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_else(|| vec!["user", "project", "local"]);
    let names = convention(options, "memoryFiles", &["AGENTS.md", "CLAUDE.md"]);
    let subdirs = convention(options, "memorySubdirs", &["", ".agents", ".claude"]);
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    if sources.contains(&"user") {
        let home_config = raw_home.join(
            options["conventions"]["userConfigDirName"]
                .as_str()
                .unwrap_or(".claude"),
        );
        probe(
            &home_config,
            &names,
            &subdirs,
            &cwd,
            &home,
            &mut seen,
            &mut files,
        )
        .await;
        let config_key = options["conventions"]["configDirEnv"]
            .as_str()
            .unwrap_or("CLAUDE_CONFIG_DIR");
        let configured = if options.get("env").is_some() {
            options["env"][config_key].as_str().map(str::to_owned)
        } else {
            crate::core::conventions::process_value(options, config_key)
        };
        if let Some(configured) = configured.filter(|value| !value.is_empty()) {
            let configured = PathBuf::from(configured);
            if absolute(&configured) != absolute(&home_config) {
                probe(
                    &configured,
                    &names,
                    &subdirs,
                    &cwd,
                    &home,
                    &mut seen,
                    &mut files,
                )
                .await;
            }
        }
    }
    if sources.contains(&"project") || sources.contains(&"local") {
        let mut current = cwd.clone();
        loop {
            probe(
                &current, &names, &subdirs, &cwd, &home, &mut seen, &mut files,
            )
            .await;
            if current == home || !current.pop() {
                break;
            }
        }
    }
    files
}
fn format_memory(
    files: &[MemoryFile],
    include_paths: bool,
    harness: &ResolvedHarness,
) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let parts = files
        .iter()
        .map(|file| {
            if !include_paths {
                return file.content.clone();
            }
            let source = harness.text(match file.source {
                Source::User => TextId::ContextMemorySourceUser,
                Source::Project => TextId::ContextMemorySourceProject,
                Source::Parent => TextId::ContextMemorySourceParent,
            });
            harness.render(
                TextId::ContextMemoryFile,
                &[
                    ("path", &file.path.to_string_lossy()),
                    ("source", source),
                    ("content", &file.content),
                ],
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(if include_paths {
        format!(
            "{}\n\n{parts}",
            harness.text(TextId::ContextMemoryInstructions)
        )
    } else {
        parts
    })
}
pub async fn load(options: &Value, include_paths: bool) -> Option<String> {
    load_with_harness(options, include_paths, &crate::harness::baseline()).await
}
pub async fn load_with_harness(
    options: &Value,
    include_paths: bool,
    harness: &ResolvedHarness,
) -> Option<String> {
    format_memory(&collect(options).await, include_paths, harness)
}
fn message(data: &ContextData, harness: &ResolvedHarness) -> Value {
    let mut sections = Vec::new();
    if let Some(memory) = format_memory(&data.files, true, harness) {
        sections.push(harness.render(TextId::ContextMemorySection, &[("memory", &memory)]));
    }
    let date = harness.render(TextId::ContextMemoryCurrentDate, &[("date", &data.date)]);
    sections.push(harness.render(TextId::ContextMemoryDateSection, &[("current_date", &date)]));
    json!({"role":"user","content":[{"type":"text","text":harness.render(TextId::ContextMemoryWrapper,&[("sections",&sections.join("\n"))])}]})
}
async fn context_data(options: &Value) -> ContextData {
    let files = collect(options).await;
    ContextData {
        files,
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
    }
}
#[derive(Default)]
pub struct MemoryContextCache {
    entries: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<ContextData>>>>,
}
impl MemoryContextCache {
    pub async fn user_context(&self, options: &Value) -> Value {
        self.user_context_with_harness(options, &crate::harness::baseline())
            .await
    }
    pub async fn user_context_with_harness(
        &self,
        options: &Value,
        harness: &ResolvedHarness,
    ) -> Value {
        let key = format!(
            "{}|{}",
            options["cwd"].as_str().unwrap_or("."),
            chrono::Local::now().format("%Y-%m-%d")
        );
        let cell = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(key)
            .or_default()
            .clone();
        message(cell.get_or_init(|| context_data(options)).await, harness)
    }
}
pub async fn user_context(options: &Value) -> Value {
    user_context_with_harness(options, &crate::harness::baseline()).await
}
pub async fn user_context_with_harness(options: &Value, harness: &ResolvedHarness) -> Value {
    message(&context_data(options).await, harness)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("halo-memory-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) { std::fs::remove_dir_all(&self.0).unwrap(); }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn memory_context_matches_fixture_bytes_and_symlink_order() {
        let fixtures: Value = serde_json::from_str(include_str!("fixtures/memory.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let directory = Directory::new();
            for (name, content) in fixture["files"].as_object().unwrap() {
                let path = directory.0.join(name);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, content.as_str().unwrap()).unwrap();
            }
            std::os::unix::fs::symlink(".agents", directory.0.join("home/work/.claude")).unwrap();
            let options = json!({"cwd":directory.0.join("home/work"),"env":{"HOME":directory.0.join("home"),"CLAUDE_CONFIG_DIR":directory.0.join("extra")},"settingSources":fixture["sources"]});
            let normalize = |value: Value| {
                let text = serde_json::to_string(&value).unwrap().replace(directory.0.to_str().unwrap(), "<root>");
                let text = regex::Regex::new(r"Today's date is \d{4}-\d{2}-\d{2}\.").unwrap().replace_all(&text, "Today's date is <date>.");
                serde_json::from_str::<Value>(&text).unwrap()
            };
            assert_eq!(normalize(json!(load(&options, false).await)), fixture["raw"]);
            assert_eq!(normalize(json!(load(&options, true).await)), fixture["annotated"]);
            assert_eq!(normalize(user_context(&options).await), fixture["message"]);
        }
    }
    #[tokio::test]
    async fn cache_retains_source_data_and_selects_text_without_cross_session_file_cache() {
        let directory = Directory::new();
        let instructions = directory.0.join("AGENTS.md");
        std::fs::write(&instructions, "original {date} content").unwrap();
        let options = json!({"cwd":directory.0,"env":{"HOME":directory.0},"settingSources":["project"]});
        let harness = crate::harness::Harness::from_config(&json!({"models":{"a":{"context.memory.current_date":"A {date}","context.memory.wrapper":"A wrapper\n{sections}"},"b":{"context.memory.current_date":"B {date}","context.memory.wrapper":"B wrapper\n{sections}"}}})).unwrap();
        let cache = MemoryContextCache::default();
        let a = cache.user_context_with_harness(&options, &harness.for_model("a")).await;
        assert!(a["content"][0]["text"].as_str().unwrap().starts_with("A wrapper\n"));
        assert!(a["content"][0]["text"].as_str().unwrap().contains("\nA "));
        std::fs::write(&instructions, "changed content").unwrap();
        let b = cache.user_context_with_harness(&options, &harness.for_model("b")).await;
        let b = b["content"][0]["text"].as_str().unwrap();
        assert!(b.starts_with("B wrapper\n"));
        assert!(b.contains("\nB "));
        assert!(b.contains("original {date} content"));
        let other = MemoryContextCache::default().user_context_with_harness(&options, &harness.for_model("b")).await;
        assert!(other["content"][0]["text"].as_str().unwrap().contains("changed content"));
    }
}
