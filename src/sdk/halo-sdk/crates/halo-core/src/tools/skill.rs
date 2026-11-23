use super::{failure, success, utf16_prefix};
use crate::harness::TextId;
use crate::skills::{load_for_model, normalize_name};
use serde_json::{json, Value};

pub async fn execute(
    catalog: &Value,
    input: &Value,
    harness: &crate::harness::ResolvedHarness,
) -> Value {
    let Some(raw) = input["skill"]
        .as_str()
        .filter(|s| !crate::js::trim_js(s).is_empty())
    else {
        tracing::warn!(reason = "missing skill name", "Skill invocation rejected");
        return failure(harness.text(TextId::ToolsSkillMissing));
    };
    if input
        .get("args")
        .is_some_and(|v| !crate::js::is_undefined(v) && !v.is_string())
    {
        tracing::warn!(
            reason = "arguments must be text",
            "Skill invocation rejected"
        );
        return failure(harness.text(TextId::ToolsSkillInvalidArguments));
    }
    let Some(name) = normalize_name(raw) else {
        tracing::warn!(reason = "invalid catalog name", "Skill invocation rejected");
        return failure(harness.text(TextId::ToolsSkillInvalidName));
    };
    let args = input["args"].as_str().unwrap_or("");
    let entries = catalog.as_array().map(Vec::as_slice).unwrap_or(&[]);
    if name.to_lowercase() == "list" {
        let query = crate::js::trim_js(args).to_lowercase();
        let filtered: Vec<_> = entries
            .iter()
            .filter(|e| {
                query.is_empty()
                    || e["name"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
            })
            .collect();
        let mut lines = vec![harness.render(
            TextId::ToolsSkillListHeader,
            &[("count", &filtered.len().to_string())],
        )];
        let mut length = lines[0].len();
        let mut included = 0;
        for entry in &filtered {
            let desc = crate::js::collapse_whitespace(
                entry["description"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(harness.text(TextId::ToolsSkillNoDescription)),
            );
            let line = format!(
                "  {} — {}",
                entry["name"].as_str().unwrap(),
                utf16_prefix(&desc, 200)
            );
            let size = line.encode_utf16().count();
            if length + size > 15800 {
                break;
            }
            lines.push(line);
            length += size + 1;
            included += 1;
        }
        if included < filtered.len() {
            lines.push(harness.render(
                TextId::ToolsSkillListOmitted,
                &[("count", &(filtered.len() - included).to_string())],
            ));
        }
        return success(lines.join("\n"), None);
    }
    let Some(entry) = entries
        .iter()
        .find(|e| e["name"].as_str().unwrap_or("").to_lowercase() == name.to_lowercase())
    else {
        tracing::warn!(name, reason = "not found", "Skill invocation rejected");
        return failure(harness.render(TextId::ToolsSkillNotFound, &[("name", &name)]));
    };
    match load_for_model(entry, args, harness).await {
        Ok(prompt) => success(
            prompt,
            Some(json!({"skill":{"name":entry["name"],"source":entry["source"]}})),
        ),
        Err(e) => {
            tracing::warn!(name,error=%e,"Skill instructions could not be loaded");
            failure(e.render_for(harness))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invocation_validates_inputs_uses_pinned_sources_and_bounds_filtered_listings() {
        let root = std::env::temp_dir().join(format!("halo-skill-tool-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".agents/commands")).unwrap();
        let path = root.join(".agents/commands/Commit.md");
        std::fs::write(&path, "---\ndescription: Project procedure\n---\nCheck project rules$ARGUMENTS_SUFFIX.").unwrap();
        let catalog = crate::skills::resolve_catalog(&json!({"cwd":root,"env":{"HOME":root.join("home")},"nativeProcessEnv":{}})).await.unwrap();
        let harness = crate::harness::baseline();
        let result = execute(&catalog, &json!({"skill":"commit","args":"selected paths"}), &harness).await;
        let directory = std::fs::canonicalize(path.parent().unwrap()).unwrap();
        let expected = format!("Base directory for this skill: {}. Resolve the skill's relative file references (scripts, references, assets) from this directory.\nCheck project rules: selected paths.", json!(directory));
        assert_eq!(result["content"], expected);
        let listed = execute(&catalog, &json!({"skill":"list"}), &harness).await;
        assert!(listed["content"].as_str().unwrap().contains("Project procedure"));
        assert!(!listed["content"].as_str().unwrap().contains("Base directory"));
        let builtin = execute(&catalog, &json!({"skill":"pull-request"}), &harness).await;
        assert_eq!(builtin["isError"], false);
        assert!(!builtin["content"].as_str().unwrap().contains("Base directory"));
        for input in [json!({"skill":"../private"}),json!({"skill":"commit","args":{}})] {
            assert_eq!(execute(&catalog,&input,&harness).await["isError"],true);
        }
        std::fs::write(&path,"Value: $ARGUMENTS; suffix$ARGUMENTS_SUFFIX").unwrap();
        let result = execute(&catalog, &json!({"skill":"commit","args":"$& $ARGUMENTS"}), &harness).await;
        assert_eq!(result["content"].as_str().unwrap().split_once('\n').unwrap().1, "Value: $& $ARGUMENTS; suffix: $& $ARGUMENTS");
        std::fs::write(&path,"x".repeat(1024*1024+1)).unwrap();
        let oversized = execute(&catalog,&json!({"skill":"commit"}),&harness).await;
        assert_eq!(oversized["isError"],true);
        assert!(oversized["content"].as_str().unwrap().contains("byte read limit"));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(execute(&catalog,&json!({"skill":"commit"}),&harness).await["isError"],true);
        let entries: Vec<_> = (0..100).map(|index|json!({"name":format!("entry-{index:03}"),"description":"detail ".repeat(50),"source":{"kind":"builtin","name":"commit"}})).collect();
        let listed = execute(&json!(entries),&json!({"skill":"LIST"}),&harness).await;
        let text = listed["content"].as_str().unwrap();
        assert!(text.encode_utf16().count()<16000);
        assert!(text.contains("entries omitted"));
        let narrowed = execute(&json!(entries),&json!({"skill":"list","args":"entry-099"}),&harness).await;
        assert!(narrowed["content"].as_str().unwrap().contains("Available skills (1)"));
        assert!(narrowed["content"].as_str().unwrap().contains("entry-099"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linked_skill_uses_its_targets_quoted_resource_directory() {
        let root = std::env::temp_dir().join(format!("halo-skill-tool-{}", uuid::Uuid::new_v4()));
        let target_dir = root.join("package \"quoted\"\n<assets>");
        std::fs::create_dir_all(&target_dir).unwrap();
        let target = target_dir.join("SKILL.md");
        std::fs::write(&target, "Use assets/data.txt.").unwrap();
        let source = root.join("SKILL.md");
        std::os::unix::fs::symlink(&target, &source).unwrap();
        let catalog = json!([{"name":"linked","description":"Resources","source":{"kind":"file","path":source}}]);
        let result = execute(&catalog, &json!({"skill":"linked"}), &crate::harness::baseline()).await;
        let (header, body) = result["content"].as_str().unwrap().split_once('\n').unwrap();
        let encoded = header.strip_prefix("Base directory for this skill: ").unwrap().split_once(". Resolve").unwrap().0;
        assert!(encoded.ends_with(r#"package \"quoted\"\n\u003cassets>""#));
        assert_eq!(serde_json::from_str::<std::path::PathBuf>(encoded).unwrap(), std::fs::canonicalize(target_dir).unwrap());
        assert_eq!(body, "Use assets/data.txt.");
        std::fs::remove_dir_all(root).unwrap();
    }
}
