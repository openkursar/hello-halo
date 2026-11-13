use super::{failure, success, utf16_prefix};
use crate::harness::TextId;
use crate::skills::{load_with_harness, normalize_name};
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
    match load_with_harness(entry, args, harness).await {
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
