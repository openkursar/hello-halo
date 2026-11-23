mod yaml;
use crate::error::{Error, Result};
use crate::harness::{Message, TextId};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use tokio::{fs::File, io::AsyncReadExt};

pub fn builtin_definitions() -> Value {
    builtin_definitions_with_harness(&crate::harness::baseline())
}
pub fn builtin_definitions_with_harness(harness: &crate::harness::ResolvedHarness) -> Value {
    harness.resource(crate::harness::ResourceId::BuiltinSkills)
}
pub fn normalize_name(raw: &str) -> Option<String> {
    let raw = crate::js::trim_js(raw);
    let name = raw.strip_suffix(".md").unwrap_or(raw);
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|c| c < ' ' || "\\/<>\"&".contains(c))
    {
        None
    } else {
        Some(name.into())
    }
}
fn invalid(index: isize, reason: Message) -> Error {
    tracing::warn!(index, reason = %reason.render(&crate::harness::baseline()), "Explicit skill catalog rejected");
    Error::template(
        "INVALID_SKILL_CATALOG",
        TextId::ToolsSkillInvalidCatalog,
        &[("index", index.to_string().into()), ("reason", reason)],
    )
    .with_details(json!({"name":"TypeError"}))
}
pub fn snapshot_catalog(catalog: &Value) -> Result<Value> {
    let entries = catalog.as_array().ok_or_else(|| {
        invalid(
            -1,
            Message::template(TextId::ToolsSkillCatalogExpectedArray, &[]),
        )
    })?;
    let mut names = HashSet::new();
    let mut out = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let index = index as isize;
        let raw = entry["name"].as_str().ok_or_else(|| {
            invalid(
                index,
                Message::template(TextId::ToolsSkillCatalogNameType, &[]),
            )
        })?;
        let name = normalize_name(raw)
            .filter(|n| n.to_lowercase() != "list")
            .ok_or_else(|| {
                invalid(
                    index,
                    Message::template(TextId::ToolsSkillCatalogReservedName, &[]),
                )
            })?;
        if !names.insert(name.to_lowercase()) {
            return Err(invalid(
                index,
                Message::template(TextId::ToolsSkillCatalogDuplicateName, &[]),
            ));
        }
        let description = entry["description"].as_str().ok_or_else(|| {
            invalid(
                index,
                Message::template(TextId::ToolsSkillCatalogDescriptionType, &[]),
            )
        })?;
        for key in ["whenToUse", "argumentHint"] {
            if entry
                .get(key)
                .is_some_and(|v| !crate::js::is_undefined(v) && !v.is_string())
            {
                return Err(invalid(
                    index,
                    Message::template(
                        TextId::ToolsSkillCatalogOptionalFieldType,
                        &[("field", key.into())],
                    ),
                ));
            }
        }
        let source = &entry["source"];
        match source["kind"].as_str() {
            Some("file") => {
                if !source["path"]
                    .as_str()
                    .is_some_and(|s| Path::new(s).is_absolute() && !s.contains('\0'))
                {
                    return Err(invalid(
                        index,
                        Message::template(TextId::ToolsSkillCatalogFileSourcePath, &[]),
                    ));
                }
            }
            Some("builtin") => {
                if !builtin_definitions()
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| b["name"] == source["name"])
                {
                    return Err(invalid(
                        index,
                        Message::template(TextId::ToolsSkillCatalogUnknownBuiltinSource, &[]),
                    ));
                }
            }
            _ => {
                return Err(invalid(
                    index,
                    Message::template(TextId::ToolsSkillCatalogInvalidSource, &[]),
                ))
            }
        }
        let source = if source["kind"] == "file" {
            json!({"kind":"file","path":source["path"]})
        } else {
            json!({"kind":"builtin","name":source["name"]})
        };
        let mut value = json!({"name":name,"description":description,"whenToUse":crate::js::undefined(),"argumentHint":crate::js::undefined(),"source":source});
        for key in ["whenToUse", "argumentHint"] {
            if let Some(v) = entry.get(key) {
                value[key] = v.clone();
            }
        }
        out.push(value);
    }
    Ok(Value::Array(out))
}
pub fn search_dirs(options: &Value) -> Vec<PathBuf> {
    let cwd = options["cwd"].as_str().unwrap_or(".");
    let home = crate::core::conventions::home(options);
    let dirs: Vec<_> = options["conventions"]["agentDirs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| vec![".agents".into(), ".claude".into()]);
    let mut result = Vec::new();
    for dir in &dirs {
        result.push(Path::new(cwd).join(dir).join("commands"));
        result.push(Path::new(cwd).join(dir).join("skills"));
    }
    result.push(Path::new(&crate::core::conventions::config_dir(options)).join("skills"));
    for dir in &dirs {
        result.push(Path::new(&home).join(dir).join("commands"));
        result.push(Path::new(&home).join(dir).join("skills"));
    }
    let mut seen = HashSet::new();
    result.retain(|p| seen.insert(p.clone()));
    result
}
fn frontmatter_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| {
        let whitespace = r"\x09\x0b\x0c\x20\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
        regex::Regex::new(&format!(r"\A\u{{feff}}?---[{whitespace}]*\r?\n([\s\S]*?)\r?\n---[{whitespace}]*(?:\r?\n|\z)")).unwrap()
    })
}
fn split_document(raw: &str) -> (Option<&str>, &str) {
    match frontmatter_pattern().captures(raw) {
        Some(capture) => (
            capture.get(1).map(|part| part.as_str()),
            &raw[capture.get(0).unwrap().end()..],
        ),
        None => (None, raw),
    }
}
fn metadata_text(content: &str) -> Value {
    let (front, body) = split_document(content);
    let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content);
    let opened = without_bom.split_once('\n').is_some_and(|(line, _)| {
        line.strip_prefix("---")
            .is_some_and(|tail| tail.chars().all(crate::js::is_whitespace))
    });
    if front.is_none() && opened {
        tracing::warn!("Skill metadata header is incomplete or exceeds its read limit");
        return json!({"description":""});
    }
    let fields = front.and_then(yaml::fields);
    if front.is_some() && fields.is_none() {
        tracing::warn!("Invalid skill metadata; using body description");
    }
    let fallback = body
        .split('\n')
        .map(crate::js::trim_js)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("");
    let field = |name: &str| {
        fields
            .as_ref()
            .and_then(|fields| fields.get(name))
            .map(|value| crate::js::trim_js(value))
            .filter(|value| !value.is_empty())
    };
    json!({"description":field("description").unwrap_or(fallback),"whenToUse":field("whenToUse").map(|value| json!(value)).unwrap_or_else(crate::js::undefined),"argumentHint":field("argumentHint").or_else(||field("argument-hint")).map(|value|json!(value)).unwrap_or_else(crate::js::undefined)})
}
async fn metadata(path: &Path) -> Value {
    let content = match File::open(path).await {
        Ok(mut file) => {
            let metadata = match file.metadata().await {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => {
                    tracing::warn!(
                        "Skill metadata could not be read: source is not a regular file"
                    );
                    return json!({"description":""});
                }
                Err(error) => {
                    tracing::warn!(error=%error,"Skill metadata could not be read");
                    return json!({"description":""});
                }
            };
            let mut bytes = vec![0; metadata.len().min(16384) as usize];
            match file.read(&mut bytes).await {
                Ok(count) => String::from_utf8_lossy(&bytes[..count]).into_owned(),
                Err(e) => {
                    tracing::warn!(error=%e,"Skill metadata could not be read");
                    return json!({"description":""});
                }
            }
        }
        Err(e) => {
            tracing::warn!(error=%e,"Skill metadata could not be read");
            return json!({"description":""});
        }
    };
    metadata_text(&content)
}
pub async fn resolve_catalog(options: &Value) -> Result<Value> {
    resolve_catalog_with_harness(options, &crate::harness::baseline()).await
}
pub async fn resolve_catalog_with_harness(
    options: &Value,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Value> {
    if let Some(catalog) = options.get("skillCatalog") {
        return snapshot_catalog(catalog);
    }
    let mut names = HashSet::new();
    let mut seen_dirs = HashSet::new();
    let mut seen_files = HashSet::new();
    let mut found = Vec::new();
    for dir in search_dirs(options) {
        let canonical = match tokio::fs::canonicalize(&dir).await {
            Ok(p) => p,
            Err(e) => {
                if !matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) {
                    tracing::warn!(error=%e,"Skill directory could not be scanned");
                }
                continue;
            }
        };
        if !seen_dirs.insert(canonical) {
            continue;
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error=%e,"Skill directory could not be scanned");
                continue;
            }
        };
        let mut paths = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| Error::new("SKILL_DISCOVERY", e.to_string()))?
        {
            paths.push(entry.path());
        }
        paths.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
        for flat in [true, false] {
            for path in &paths {
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let source = if flat {
                    if !name.ends_with(".md") || name == "SKILL.md" || !path.is_file() {
                        continue;
                    }
                    path.clone()
                } else {
                    if !path.is_dir() {
                        continue;
                    }
                    let source = path.join("SKILL.md");
                    if !source.is_file() {
                        continue;
                    }
                    source
                };
                let Some(name) = normalize_name(if flat {
                    name.strip_suffix(".md").unwrap()
                } else {
                    name
                }) else {
                    continue;
                };
                if name.to_lowercase() == "list" || names.contains(&name.to_lowercase()) {
                    continue;
                }
                let canonical = match tokio::fs::canonicalize(&source).await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(error=%e,"Discovered skill could not be resolved");
                        continue;
                    }
                };
                if !seen_files.insert(canonical) {
                    continue;
                }
                names.insert(name.to_lowercase());
                let mut entry = metadata(&source).await;
                entry["name"] = json!(name);
                entry["source"] = json!({"kind":"file","path":source});
                found.push(entry);
            }
        }
    }
    for builtin in builtin_definitions_with_harness(harness)
        .as_array()
        .unwrap()
    {
        if names.insert(builtin["name"].as_str().unwrap().to_lowercase()) {
            let mut entry = builtin.clone();
            entry.as_object_mut().unwrap().remove("instructions");
            entry["source"] = json!({"kind":"builtin","name":builtin["name"]});
            found.push(entry);
        }
    }
    found.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
    Ok(Value::Array(found))
}
pub async fn load(entry: &Value, args: &str) -> Result<String> {
    load_with_harness(entry, args, &crate::harness::baseline()).await
}
pub async fn load_with_harness(
    entry: &Value,
    args: &str,
    harness: &crate::harness::ResolvedHarness,
) -> Result<String> {
    load_instructions(entry, args, harness, false).await
}

pub(crate) async fn load_for_model(
    entry: &Value,
    args: &str,
    harness: &crate::harness::ResolvedHarness,
) -> Result<String> {
    load_instructions(entry, args, harness, true).await
}

async fn load_instructions(
    entry: &Value,
    args: &str,
    harness: &crate::harness::ResolvedHarness,
    include_resource_base: bool,
) -> Result<String> {
    let name = entry["name"].as_str().unwrap_or("");
    let source = &entry["source"];
    let mut resource_base = None;
    let body = if source["kind"] == "builtin" {
        builtin_definitions_with_harness(harness)
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == source["name"])
            .and_then(|v| v["instructions"].as_str())
            .ok_or_else(|| {
                Error::template(
                    "SKILL_UNAVAILABLE",
                    TextId::ToolsSkillUnavailable,
                    &[("name", name.into())],
                )
            })?
            .to_owned()
    } else {
        let path = source["path"]
            .as_str()
            .ok_or_else(|| Error::template("SKILL_SOURCE", TextId::ToolsSkillSourceInvalid, &[]))?;
        let path = if include_resource_base {
            // A linked SKILL.md uses resources beside its target, not beside the link.
            let resolved = tokio::fs::canonicalize(path)
                .await
                .map_err(|e| Error::new("SKILL_READ", e.to_string()))?;
            let directory = resolved
                .parent()
                .and_then(Path::to_str)
                .ok_or_else(|| Error::template("SKILL_SOURCE", TextId::ToolsSkillSourceInvalid, &[]))?;
            resource_base = Some(quote_resource_directory(directory));
            resolved
        } else {
            PathBuf::from(path)
        };
        let mut file = File::open(path)
            .await
            .map_err(|e| Error::new("SKILL_READ", e.to_string()))?;
        let bytes = crate::filesystem::read_bounded(&mut file, 1024 * 1024)
            .await
            .map_err(|mut error| {
                error.code = "SKILL_READ".into();
                error
            })?;
        split_document(&String::from_utf8_lossy(&bytes))
            .1
            .to_owned()
    };
    let re = regex::Regex::new(r"\$ARGUMENTS_SUFFIX|\$ARGUMENTS").unwrap();
    let prompt = re
        .replace_all(&body, |caps: &regex::Captures| {
            if &caps[0] == "$ARGUMENTS_SUFFIX" {
                if crate::js::trim_js(args).is_empty() {
                    String::new()
                } else {
                    format!(": {args}")
                }
            } else {
                args.into()
            }
        })
        .trim_matches(crate::js::is_whitespace)
        .to_owned();
    if prompt.is_empty() {
        return Err(Error::template(
            "SKILL_EMPTY",
            TextId::ToolsSkillEmpty,
            &[("name", name.into())],
        ));
    }
    if prompt.len() > 1024 * 1024 {
        return Err(Error::template(
            "SKILL_LIMIT",
            TextId::ToolsSkillLimit,
            &[("name", name.into())],
        ));
    }
    if let Some(directory) = resource_base {
        let prefix = harness.render(TextId::ToolsSkillResourceBase, &[("directory", &directory)]);
        return Ok(format!("{prefix}\n{prompt}"));
    }
    Ok(prompt)
}

fn quote_resource_directory(directory: &str) -> String {
    // JSON quoting keeps the path on one line; escape '<' so it cannot close the slash marker.
    json!(directory).to_string().replace('<', "\\u003c")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SkillFiles(PathBuf);
    impl SkillFiles {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("halo-skill-tests-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn write(&self, relative: &str, content: &str) -> PathBuf {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, content).unwrap();
            path
        }
        fn options(&self) -> Value {
            json!({"cwd":self.0.join("project"),"env":{"HOME":self.0.join("home"),"CLAUDE_CONFIG_DIR":self.0.join("config")},"nativeProcessEnv":{}})
        }
    }
    impl Drop for SkillFiles {
        fn drop(&mut self) { std::fs::remove_dir_all(&self.0).unwrap(); }
    }

    #[tokio::test]
    async fn filesystem_precedence_pins_flat_project_sources_before_config_home_and_builtins() {
        let files = SkillFiles::new();
        let selected = files.write("project/.agents/skills/commit.md", "---\ndescription: project\n---\nProject $ARGUMENTS");
        files.write("project/.agents/skills/commit/SKILL.md", "Directory workflow");
        files.write("config/skills/commit.md", "Config workflow");
        files.write("home/.agents/skills/commit.md", "Home workflow");
        files.write("project/.agents/skills/list.md", "Reserved");
        files.write("project/.agents/skills/SKILL.md", "Not a named workflow");
        let options = files.options();
        let catalog = resolve_catalog(&options).await.unwrap();
        let entries = catalog.as_array().unwrap();
        let matching: Vec<_> = entries.iter().filter(|entry| entry["name"] == "commit").collect();
        assert_eq!(matching.len(), 1);
        let entry = matching[0];
        assert_eq!(entry["source"]["path"], json!(selected));
        assert_eq!(entry["description"], "project");
        assert!(entry.get("instructions").is_none());
        assert!(!entries.iter().any(|entry| entry["name"] == "list" || entry["name"] == "SKILL"));
        assert_eq!(load(entry, "target").await.unwrap(), "Project target");
        std::fs::remove_file(&selected).unwrap();
        assert!(load(entry, "target").await.is_err());
        files.write("project/.agents/skills/commit.md", "Repaired $ARGUMENTS");
        assert_eq!(load(entry, "target").await.unwrap(), "Repaired target");
        assert_eq!(resolve_catalog(&json!({"skillCatalog":[]})).await.unwrap(), json!([]));
    }

    #[tokio::test]
    async fn configuration_sources_precede_home_and_custom_conventions_are_respected() {
        let files = SkillFiles::new();
        let configured = files.write("config/skills/review.md", "Config workflow");
        files.write("home/.agents/skills/review.md", "Home workflow");
        let custom = files.write("project/.custom/skills/custom/SKILL.md", "Custom workflow");
        let mut options = files.options();
        options["conventions"] = json!({"agentDirs":[".custom",".agents"]});
        let catalog = resolve_catalog(&options).await.unwrap();
        let entries = catalog.as_array().unwrap();
        assert_eq!(entries.iter().find(|entry| entry["name"] == "review").unwrap()["source"]["path"], json!(configured));
        assert_eq!(entries.iter().find(|entry| entry["name"] == "custom").unwrap()["source"]["path"], json!(custom));
    }

    #[tokio::test]
    async fn metadata_is_bounded_and_instruction_loading_refuses_partial_workflows() {
        let files = SkillFiles::new();
        let oversized_header = files.write("header.md", &format!("---\ndescription: {}\n---\nBody", "x".repeat(16384)));
        assert_eq!(metadata(&oversized_header).await["description"], "");
        let path = files.write("large.md", &"x".repeat(1024 * 1024 + 1));
        let entry = json!({"name":"large","source":{"kind":"file","path":path}});
        assert!(load(&entry, "").await.is_err());
        std::fs::write(&path, "---\ndescription: small\n---\n$ARGUMENTS $ARGUMENTS_SUFFIX").unwrap();
        assert_eq!(load(&entry, "$ARGUMENTS $& $$").await.unwrap(), "$ARGUMENTS $& $$ : $ARGUMENTS $& $$");
        assert_eq!(load(&entry, "").await.unwrap_err().code, "SKILL_EMPTY");
        assert!(load(&entry, &"x".repeat(1024 * 1024)).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_packages_and_alias_directories_are_deduplicated() {
        let files = SkillFiles::new();
        files.write("project/.agents/skills/package/SKILL.md", "Linked workflow");
        std::os::unix::fs::symlink(files.0.join("project/.agents"), files.0.join("project/.claude")).unwrap();
        std::os::unix::fs::symlink(files.0.join("project/.agents/skills/package"), files.0.join("project/.agents/skills/linked")).unwrap();
        let catalog = resolve_catalog(&files.options()).await.unwrap();
        let entries: Vec<_> = catalog.as_array().unwrap().iter().filter(|entry| entry["description"] == "Linked workflow").collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(load(entries[0], "").await.unwrap(), "Linked workflow");
    }

    #[tokio::test]
    async fn builtin_bodies_match_definitions_and_explicit_empty_catalogs_stay_empty() {
        for definition in builtin_definitions().as_array().unwrap() {
            let entry = json!({"name":definition["name"],"source":{"kind":"builtin","name":definition["name"]}});
            assert_eq!(load(&entry, "request details").await.unwrap(), definition["instructions"].as_str().unwrap().replace("$ARGUMENTS", "request details").trim());
        }
        assert_eq!(resolve_catalog(&json!({"skillCatalog":[]})).await.unwrap(), json!([]));
    }

    #[tokio::test]
    async fn discovered_metadata_supports_layouts_yaml_fallbacks_and_deferred_current_bodies() {
        let files = SkillFiles::new();
        files.write("project/.claude/skills/foo.md", "---\ndescription: Foo skill\n---\nFoo body");
        files.write("project/.claude/skills/bar/SKILL.md", "---\ndescription: Bar skill\nargumentHint: <query>\n---\nBar body");
        files.write("project/.claude/skills/baz.md", "---\nname: baz\n---\nFirst real line of baz\nSecond line");
        files.write("project/.claude/skills/broken.md", "---\nthis is :: not :: yaml\nstill broken\n---\nfallback first line");
        files.write("project/.agents/skills/review/SKILL.md", "Directory copy");
        let review = files.write("project/.agents/skills/review.md", "---\ndescription: >-\n  Review the changes\n  before publishing.\nargument-hint: <path>\n---\nOriginal instructions");
        files.write("project/.agents/skills/sequence.md", "---\n- one\n- two\n---\nFallback description.");
        let catalog = resolve_catalog(&files.options()).await.unwrap();
        let find = |name: &str| catalog.as_array().unwrap().iter().find(|entry|entry["name"] == name).unwrap();
        assert_eq!(find("foo")["description"], "Foo skill");
        assert_eq!(find("bar")["argumentHint"], "<query>");
        assert_eq!(find("baz")["description"], "First real line of baz");
        assert!(find("broken")["description"].is_string());
        assert_eq!(find("review")["description"], "Review the changes before publishing.");
        assert_eq!(find("review")["argumentHint"], "<path>");
        assert_eq!(find("sequence")["description"], "Fallback description.");
        assert!(!crate::js::stringify(&catalog).contains("Original instructions"));
        std::fs::write(review, "Updated instructions.").unwrap();
        assert_eq!(load(find("review"), "").await.unwrap(), "Updated instructions.");
    }

    #[test]
    fn metadata_matches_fixture_failsafe_yaml_and_frontmatter() {
        let fixtures: Value = serde_json::from_str(include_str!("fixtures/metadata.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            assert_eq!(
                metadata_text(fixture["content"].as_str().unwrap()),
                fixture["expected"],
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn explicit_catalog_discards_extra_source_fields_and_preserves_undefined() {
        let snapshot = snapshot_catalog(&json!([{"name":"\u{feff}commit.md\u{feff}","description":"metadata","source":{"kind":"builtin","name":"commit","instructions":"discard"}}])).unwrap();
        assert_eq!(
            snapshot,
            json!([{"name":"commit","description":"metadata","whenToUse":crate::js::undefined(),"argumentHint":crate::js::undefined(),"source":{"kind":"builtin","name":"commit"}}])
        );
        assert_eq!(
            normalize_name("\u{0085}name\u{0085}"),
            Some("\u{0085}name\u{0085}".into())
        );
    }
}
