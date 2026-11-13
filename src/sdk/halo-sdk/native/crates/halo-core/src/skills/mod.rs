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
    let name = entry["name"].as_str().unwrap_or("");
    let source = &entry["source"];
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
    Ok(prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

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
