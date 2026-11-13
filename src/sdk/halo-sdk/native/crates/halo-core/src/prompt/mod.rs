mod environment;
pub use environment::{probe as probe_environment, probe_sync as probe_environment_sync};
pub mod memory;
pub mod skill_context;
pub mod summary;
use crate::error::{Error, Result};
use crate::harness::TextId;
use serde_json::{json, Value};
use std::sync::OnceLock;
static SECTIONS: OnceLock<Value> = OnceLock::new();
fn sections() -> &'static Value {
    SECTIONS.get_or_init(|| {
        crate::harness::baseline().resource(crate::harness::ResourceId::PromptSections)
    })
}
pub fn constants() -> &'static Value {
    &sections()["constants"]
}
pub fn profile(model: &str, selection: &Value) -> Result<Value> {
    profile_with_harness(model, selection, &crate::harness::baseline())
}
pub fn profile_with_harness(
    model: &str,
    selection: &Value,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Value> {
    let fallback = json!("default");
    let id = if selection.is_string() {
        selection
    } else {
        selection["models"].get(model).unwrap_or_else(|| {
            selection
                .get("default")
                .filter(|value| !value.is_null())
                .unwrap_or(&fallback)
        })
    };
    let profiles = harness.resource(crate::harness::ResourceId::PromptSections);
    id.as_str()
        .and_then(|name| profiles["profiles"].get(name))
        .cloned()
        .ok_or_else(|| {
            Error::new("UNKNOWN_PROMPT_PROFILE", "")
                .with_harness(
                    TextId::PromptProfileUnknown,
                    &[("profile", crate::js::to_string(id).into())],
                )
                .with_details(json!({"name":"RangeError"}))
        })
}
pub fn split_at_boundary(prompt: &str) -> (String, String) {
    let (stable, dynamic) = split_text_at_boundary(crate::js::text::JsTextView::Utf8(prompt));
    let (crate::js::text::JsTextView::Utf8(stable), crate::js::text::JsTextView::Utf8(dynamic)) = (stable, dynamic) else {
        unreachable!("Splitting a UTF-8 view preserves its representation")
    };
    (stable.to_owned(), dynamic.to_owned())
}
pub fn split_text_at_boundary(prompt: crate::js::text::JsTextView<'_>) -> (crate::js::text::JsTextView<'_>, crate::js::text::JsTextView<'_>) {
    let boundary = constants()["PROMPT_CACHE_BOUNDARY"].as_str().unwrap();
    match prompt.split_once_ascii(boundary) {
        Some((stable, dynamic)) => (stable.trim_end(), dynamic.trim_start()),
        None => (prompt, crate::js::text::JsTextView::Utf8("")),
    }
}
pub fn assemble(options: &Value, environment: &Value) -> Result<Value> {
    assemble_with_harness(options, environment, &crate::harness::baseline())
}
pub fn assemble_with_harness(
    options: &Value,
    environment: &Value,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Value> {
    let boundary = constants()["PROMPT_CACHE_BOUNDARY"].as_str().unwrap();
    let system = &options["systemPrompt"];
    if let Some(replace) = options["customReplace"].as_str() {
        return Ok(json!(format!("{replace}\n\n{boundary}")));
    }
    if let Some(prompt) = system.as_str() {
        return Ok(json!(prompt));
    }
    let s = harness.resource(crate::harness::ResourceId::PromptSections);
    let names: Vec<_> = environment["tools"]
        .as_array()
        .or_else(|| options["tools"].as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().or_else(|| v["name"].as_str()))
                .collect()
        })
        .unwrap_or_default();
    let mask = usize::from(names.contains(&"Goal")) + 2 * usize::from(names.contains(&"TodoWrite"));
    let mut parts = vec![
        s["identitySection"].as_str().unwrap().to_owned(),
        s[if options["ultraEffort"].as_bool() == Some(true) {
            "howYouWorkUltraSection"
        } else {
            "howYouWorkSection"
        }].as_str().unwrap().to_owned(),
        s["computerSafetySection"].as_str().unwrap().to_owned(),
        s["runtimeSection"].as_str().unwrap().to_owned(),
        s[format!("toolUse{mask}")].as_str().unwrap().to_owned(),
        s["communicatingSection"].as_str().unwrap().to_owned(),
    ];
    let model = options["model"].as_str().unwrap_or("");
    let profile = profile_with_harness(model, &options["promptProfile"], harness)?;
    if let Some(g) = profile["conversationGuidance"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        parts.push(g.into());
    }
    parts.push(boundary.into());
    if names.contains(&"Skill") {
        parts.push(s["sessionGuidance"].as_str().unwrap().into());
    }
    let platform = environment["platform"]
        .as_str()
        .or_else(|| options["platform"].as_str())
        .unwrap_or(if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(windows) {
            "win32"
        } else {
            "linux"
        });
    if platform == "win32" {
        parts.push(s["windowsShellSection"].as_str().unwrap().into());
    }
    let cwd = options["cwd"].as_str().unwrap_or(".");
    let git = environment["isGitRepo"].as_bool().unwrap_or(false);
    let shell = environment["shell"].as_str().unwrap_or("unknown");
    let version = environment["osVersion"].as_str().unwrap_or(platform);
    let mut env = vec![
        harness.text(TextId::PromptEnvironmentHeading).into(),
        harness.render(TextId::PromptEnvironmentCwd, &[("cwd", cwd)]),
        harness.render(
            TextId::PromptEnvironmentGitRepository,
            &[("is_git", &git.to_string())],
        ),
    ];
    if git {
        if let Some(branch) = options["gitBranch"].as_str().filter(|s| !s.is_empty()) {
            env.push(harness.render(TextId::PromptEnvironmentGitBranch, &[("branch", branch)]));
        }
    }
    env.extend([
        harness.render(TextId::PromptEnvironmentPlatform, &[("platform", platform)]),
        harness.render(TextId::PromptEnvironmentShell, &[("shell", shell)]),
        harness.render(TextId::PromptEnvironmentOsVersion, &[("version", version)]),
        harness.render(TextId::PromptEnvironmentModel, &[("model", model)]),
    ]);
    parts.push(env.join("\n"));
    if let Some(memory) = options["memoryContent"].as_str().filter(|s| !s.is_empty()) {
        parts.push(format!("<memory>\n{memory}\n</memory>"));
    }
    if let Some(mcp) = options["mcpInstructions"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        parts.push(mcp.into());
    }
    if let Some(append) = options["customAppend"]
        .as_str()
        .or_else(|| system["append"].as_str())
        .filter(|s| !s.is_empty())
    {
        parts.push(append.into());
    }
    Ok(json!(parts.join("\n\n")))
}

pub fn service_instructions(tools: &[Value]) -> Option<String> {
    service_instructions_with_harness(tools, &crate::harness::baseline())
}
pub fn service_instructions_with_harness(
    tools: &[Value],
    harness: &crate::harness::ResolvedHarness,
) -> Option<String> {
    let mut services = Vec::new();
    let mut names = std::collections::HashSet::new();
    for tool in tools {
        let source = &tool["mcpSource"];
        if let (Some(server), Some(instructions)) = (
            source["server"].as_str(),
            source["instructions"]
                .as_str()
                .filter(|text| !text.is_empty()),
        ) {
            if names.insert(server) {
                services.push(json!({"server":server,"instructions":instructions}));
            }
        }
    }
    if services.is_empty() {
        return None;
    }
    Some(harness.render(
        TextId::PromptMcpServiceReference,
        &[("services", &crate::js::stringify(&Value::Array(services)))],
    ))
}
