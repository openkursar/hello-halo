use crate::harness::{fixed_text, ResolvedHarness, ResourceId, TextId};
use crate::{
    bridge::HostBridge,
    error::{Error, Result},
};
use indexmap::IndexMap;
pub mod builtins;
pub mod metadata;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;
#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub name: String,
    pub args: String,
}
pub fn parse(input: &str) -> Option<Invocation> {
    let first = crate::js::trim_end_js(crate::js::trim_js(input).split('\n').next()?);
    let rest = first.strip_prefix('/')?;
    if rest.starts_with('/') || rest.starts_with(crate::js::is_whitespace) || rest.is_empty() {
        return None;
    }
    let end = rest.find(crate::js::is_whitespace).unwrap_or(rest.len());
    let name = &rest[..end];
    if name.contains('/') {
        return None;
    }
    Some(Invocation {
        name: name.into(),
        args: crate::js::trim_js(&rest[end..]).into(),
    })
}
fn command_type_error(message: &str) -> Error {
    Error::new("INVALID_COMMAND", message).with_details(json!({"name":"TypeError"}))
}
fn canonical_name(value: &Value) -> Result<String> {
    Ok(value
        .as_str()
        .ok_or_else(|| command_type_error("cmd.name.toLowerCase is not a function"))?
        .to_lowercase())
}
fn alias_values(value: &Value) -> Result<std::borrow::Cow<'_, [Value]>> {
    if !crate::js::truthy(value) {
        return Ok(std::borrow::Cow::Borrowed(&[]));
    }
    if let Some(values) = value.as_array() {
        return Ok(std::borrow::Cow::Borrowed(values));
    }
    if let Some(text) = value.as_str() {
        return Ok(std::borrow::Cow::Owned(
            text.chars()
                .map(|character| json!(character.to_string()))
                .collect(),
        ));
    }
    Err(command_type_error("cmd.aliases is not iterable"))
}
#[derive(Clone)]
enum Executor {
    Builtin(String),
    Skill(Value),
    Callback,
    Host,
}
#[derive(Clone)]
struct Entry {
    metadata: Value,
    executor: Executor,
    reference: Option<String>,
}
#[derive(Default)]
pub struct CommandRegistry {
    entries: IndexMap<String, Entry>,
    aliases: HashMap<String, String>,
}
impl CommandRegistry {
    pub fn from_options(options: &Value, skills: &Value, skill_enabled: bool) -> Result<Self> {
        Self::from_options_with_harness(options, skills, skill_enabled, &crate::harness::baseline())
    }
    pub fn from_options_with_harness(
        options: &Value,
        skills: &Value,
        skill_enabled: bool,
        harness: &ResolvedHarness,
    ) -> Result<Self> {
        let builtins = harness.resource(ResourceId::CommandDefinitions);
        let mut registry = Self::default();
        for meta in builtins["commands"].as_array().unwrap() {
            registry.register(
                meta.clone(),
                Executor::Builtin(meta["name"].as_str().unwrap().into()),
            )?;
        }
        if skill_enabled {
            if let Some(skills) = skills.as_array() {
                for skill in skills {
                    let mut metadata = json!({"type":"prompt","name":skill["name"],"description":skill["description"],"source":if skill["source"]["kind"]=="builtin"{"builtin"}else{"user"}});
                    for key in ["whenToUse", "argumentHint"] {
                        if let Some(v) = skill[key].as_str().filter(|s| !s.is_empty()) {
                            metadata[key] = json!(v);
                        }
                    }
                    registry.register(metadata, Executor::Skill(skill.clone()))?;
                }
            }
        }
        for metadata in metadata::normalize(options.get("slashCommands")) {
            let callback = if metadata["type"] == "local" {
                "call"
            } else {
                "getPromptForCommand"
            };
            let executor = if metadata
                .get(callback)
                .is_some_and(|value| !crate::js::is_undefined(value))
            {
                Executor::Callback
            } else {
                Executor::Host
            };
            registry.register(metadata, executor)?;
        }
        Ok(registry)
    }
    fn remove_aliases(&mut self, metadata: &Value) -> Result<()> {
        if !crate::js::truthy(&metadata["aliases"]) {
            return Ok(());
        }
        let owner = canonical_name(&metadata["name"])?;
        for alias in alias_values(&metadata["aliases"])?.iter() {
            let alias = alias
                .as_str()
                .ok_or_else(|| command_type_error("alias.toLowerCase is not a function"))?
                .to_lowercase();
            if self.aliases.get(&alias) == Some(&owner) {
                self.aliases.remove(&alias);
            }
        }
        Ok(())
    }
    fn register(&mut self, metadata: Value, executor: Executor) -> Result<Option<Entry>> {
        self.register_entry(metadata, executor, None)
    }
    fn register_entry(
        &mut self,
        metadata: Value,
        executor: Executor,
        reference: Option<String>,
    ) -> Result<Option<Entry>> {
        let name = canonical_name(&metadata["name"])?;
        if let Some(previous) = self.entries.get(&name).map(|entry| entry.metadata.clone()) {
            self.remove_aliases(&previous)?;
        }
        let previous = self.entries.insert(
            name.clone(),
            Entry {
                metadata: metadata.clone(),
                executor,
                reference,
            },
        );
        for alias in alias_values(&metadata["aliases"])?.iter() {
            let alias = alias
                .as_str()
                .ok_or_else(|| command_type_error("alias.toLowerCase is not a function"))?;
            self.aliases.insert(alias.to_lowercase(), name.clone());
        }
        Ok(previous)
    }
    fn get(&self, name: &str) -> Option<&Entry> {
        let key = name.to_lowercase();
        self.entries.get(&key).or_else(|| {
            self.aliases
                .get(&key)
                .and_then(|owner| self.entries.get(owner))
        })
    }
    pub fn register_reference(
        &mut self,
        reference: String,
        metadata: Value,
        previous: Option<Value>,
    ) -> Result<Option<String>> {
        let key = metadata["name"].as_str().unwrap_or("").to_lowercase();
        if let (Some(entry), Some(previous)) = (self.entries.get_mut(&key), previous) {
            entry.metadata = previous;
        }
        let replaced = self
            .register_entry(metadata, Executor::Host, Some(reference))?
            .and_then(|entry| entry.reference);
        Ok(replaced)
    }
    pub fn unregister_reference(
        &mut self,
        name: &str,
        current: Option<Value>,
    ) -> Result<Option<String>> {
        let key = name.to_lowercase();
        let Some(entry) = self.entries.get(&key) else {
            return Ok(None);
        };
        let metadata = current.unwrap_or_else(|| entry.metadata.clone());
        self.remove_aliases(&metadata)?;
        Ok(self
            .entries
            .shift_remove(&key)
            .and_then(|entry| entry.reference))
    }
    pub fn reference(&self, name: &str, canonical: bool) -> Option<&str> {
        let entry = if canonical {
            self.entries.get(&name.to_lowercase())
        } else {
            self.get(name)
        }?;
        entry.reference.as_deref()
    }
    pub fn references(&self) -> Vec<String> {
        self.entries
            .values()
            .filter_map(|entry| entry.reference.clone())
            .collect()
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.aliases.clear();
    }
    pub fn size(&self) -> usize {
        self.entries.len()
    }
    pub(crate) fn advertised_with_harness(
        &self,
        names: &[String],
        harness: &ResolvedHarness,
    ) -> Vec<Value> {
        names
            .iter()
            .filter_map(|name| self.get(name))
            .map(|entry| {
                let metadata = metadata_with_harness(entry, harness);
                let mut result =
                    json!({"name":metadata["name"],"description":metadata["description"]});
                if let Some(hint) = metadata["argumentHint"]
                    .as_str()
                    .filter(|hint| !hint.is_empty())
                {
                    result["argumentHint"] = json!(hint);
                }
                result
            })
            .collect()
    }
    pub async fn list(
        &self,
        bridge: &dyn HostBridge,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        self.list_with_harness(bridge, cancel, &crate::harness::baseline())
            .await
    }
    pub async fn list_with_harness(
        &self,
        bridge: &dyn HostBridge,
        cancel: &CancellationToken,
        harness: &ResolvedHarness,
    ) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        for entry in self.entries.values() {
            if entry.metadata["isHidden"] == true
                || entry.metadata["userInvocable"] == false
                || !enabled(&entry.metadata, bridge, cancel).await?
            {
                continue;
            }
            out.push(metadata_with_harness(entry, harness));
        }
        Ok(out)
    }
    pub async fn slash_commands(
        &self,
        bridge: &dyn HostBridge,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        Ok(self
            .list(bridge, cancel)
            .await?
            .into_iter()
            .map(|v| {
                let mut out = json!({"name":v["name"],"description":v["description"]});
                if let Some(hint) = v["argumentHint"].as_str().filter(|s| !s.is_empty()) {
                    out["argumentHint"] = json!(hint);
                }
                out
            })
            .collect())
    }
}
fn metadata_with_harness(entry: &Entry, harness: &ResolvedHarness) -> Value {
    match &entry.executor {
        Executor::Builtin(name) => harness.resource(ResourceId::CommandDefinitions)["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == *name)
            .unwrap()
            .clone(),
        _ => entry.metadata.clone(),
    }
}
async fn enabled(
    metadata: &Value,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
) -> Result<bool> {
    if let Some(id) = metadata["isEnabled"]["__haloSdkNativeCallback"].as_str() {
        let value = bridge
            .call("callback", json!({"callbackId":id,"args":[]}), cancel)
            .await?;
        return Ok(if value.is_null() || crate::js::is_undefined(&value) {
            true
        } else {
            crate::js::truthy(&value)
        });
    }
    Ok(true)
}
#[async_trait]
pub trait CommandHost: Send + Sync {
    async fn clear_messages(&self) -> Result<()>;
    async fn compact_session(&self, instructions: Option<String>) -> Result<()>;
    async fn set_model(&self, model: String) -> Result<()>;
}
#[derive(Debug)]
pub enum DispatchOutcome {
    Unknown,
    Disabled(Value),
    HostHandled(Value),
    LocalResult {
        command: Value,
        markdown: String,
    },
    PromptReplacement {
        command: Value,
        messages: Vec<Value>,
    },
}
pub async fn dispatch(
    registry: &CommandRegistry,
    name: &str,
    args: &str,
    snapshot: &Value,
    host: &dyn CommandHost,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
) -> Result<DispatchOutcome> {
    dispatch_with_harness(
        registry,
        name,
        args,
        snapshot,
        host,
        bridge,
        cancel,
        &crate::harness::baseline(),
    )
    .await
}
pub async fn dispatch_with_harness(
    registry: &CommandRegistry,
    name: &str,
    args: &str,
    snapshot: &Value,
    host: &dyn CommandHost,
    bridge: &dyn HostBridge,
    cancel: &CancellationToken,
    harness: &ResolvedHarness,
) -> Result<DispatchOutcome> {
    let Some(entry) = registry.get(name) else {
        return Ok(DispatchOutcome::Unknown);
    };
    let metadata = metadata_with_harness(entry, harness);
    if entry.metadata["userInvocable"] == false || !enabled(&entry.metadata, bridge, cancel).await?
    {
        return Ok(DispatchOutcome::Disabled(metadata));
    }
    let result = match &entry.executor {
        Executor::Host => return Ok(DispatchOutcome::HostHandled(metadata)),
        Executor::Skill(skill) => {
            let body = crate::skills::load_with_harness(skill, args, harness).await?;
            let content = format!(
                "{}{}{}{}\n{}",
                fixed_text(ResourceId::SkillProtocol, &["invocation", "name_prefix"]),
                skill["name"].as_str().unwrap(),
                fixed_text(ResourceId::SkillProtocol, &["invocation", "body_prefix"]),
                body,
                fixed_text(ResourceId::SkillProtocol, &["invocation", "close"]),
            );
            return Ok(DispatchOutcome::PromptReplacement {
                command: metadata,
                messages: vec![json!({"role":"user", "content":content})],
            });
        }
        Executor::Callback => {
            let key = if entry.metadata["type"] == "local" {
                "call"
            } else {
                "getPromptForCommand"
            };
            let result = bridge
                .call(
                    "commands.execute",
                    json!({"command":entry.metadata,"method":key,"args":args,"context":snapshot}),
                    cancel,
                )
                .await?;
            if key == "getPromptForCommand" {
                return Ok(DispatchOutcome::PromptReplacement {
                    command: metadata,
                    messages: result.as_array().cloned().unwrap_or_default(),
                });
            }
            result["markdown"].as_str().unwrap_or("").to_owned()
        }
        Executor::Builtin(name) => {
            let Some(plan) = builtins::plan(name, args, snapshot, harness)? else {
                return Ok(DispatchOutcome::HostHandled(metadata));
            };
            if let Some(effect) = plan.effect {
                match effect.method {
                    "clearMessages" => host.clear_messages().await?,
                    "compactSession" => {
                        host.compact_session(effect.args[0].as_str().map(str::to_owned))
                            .await?
                    }
                    "setModel" => {
                        host.set_model(effect.args[0].as_str().unwrap_or("").into())
                            .await?
                    }
                    _ => unreachable!(),
                }
            }
            if let Some(messages) = plan.result.as_array() {
                return Ok(DispatchOutcome::PromptReplacement {
                    command: metadata,
                    messages: messages.clone(),
                });
            }
            plan.result["markdown"].as_str().unwrap_or("").to_owned()
        }
    };
    Ok(DispatchOutcome::LocalResult {
        command: metadata,
        markdown: result,
    })
}

fn content_size(v: &Value) -> usize {
    if let Some(s) = v.as_str() {
        return s.encode_utf16().count();
    }
    if let Some(blocks) = v.as_array() {
        return blocks.iter().map(content_size).sum();
    }
    match v["type"].as_str() {
        Some("text") => content_size(&v["text"]),
        Some("thinking") => content_size(&v["thinking"]),
        Some("tool_result") => content_size(&v["content"]),
        Some("tool_use") => {
            crate::js::stringify(&v["input"]).encode_utf16().count() + content_size(&v["name"])
        }
        _ => 0,
    }
}
fn number(n: f64) -> String {
    let text = format!("{n:.0}");
    let mut out = String::new();
    for (i, c) in text.chars().enumerate() {
        if i > 0 && (text.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}
fn mcp_report(servers: &Value, status: bool, harness: &ResolvedHarness) -> String {
    let servers = servers.as_array().map(Vec::as_slice).unwrap_or(&[]);
    if servers.is_empty() {
        return if status {
            harness.text(TextId::CommandsLocalMcpStatusEmpty)
        } else {
            harness.text(TextId::CommandsLocalMcpEmpty)
        }
        .into();
    }
    let mut text = if status {
        ""
    } else {
        harness.text(TextId::CommandsLocalMcpHeading)
    }
    .to_owned();
    text.push_str(harness.text(TextId::CommandsLocalMcpColumns));
    for server in servers {
        text.push_str(&format!(
            "| {} | {} |\n",
            server["name"].as_str().unwrap_or(""),
            server["status"].as_str().unwrap_or("")
        ));
    }
    text
}
fn duration(ms: f64) -> String {
    if ms < 1000. {
        format!("{ms} ms")
    } else if ms < 60000. {
        format!("{} s", crate::js::to_fixed(ms / 1000., 2))
    } else {
        let minutes = (ms / 60000.).floor();
        format!(
            "{minutes}m {}s",
            crate::js::to_fixed(ms / 1000. - minutes * 60., 1)
        )
    }
}
fn cost_report(s: &Value, usage: bool, harness: &ResolvedHarness) -> String {
    let get = |key: &str| s[key].as_f64().unwrap_or(0.);
    let token = |key: &str| s["tokens"][key].as_f64().unwrap_or(0.);
    let mut text = if usage {
        harness.render(
            TextId::CommandsLocalUsage,
            &[
                ("turns", &get("numTurns").to_string()),
                (
                    "tokens",
                    &number(
                        ["input", "output", "cacheCreate", "cacheRead"]
                            .iter()
                            .map(|k| token(k))
                            .sum(),
                    ),
                ),
            ],
        )
    } else {
        harness.render(
            TextId::CommandsLocalCost,
            &[
                ("cost", &crate::js::to_fixed(get("totalCostUsd"), 4)),
                ("wall_duration", &duration(get("totalDurationMs"))),
                ("api_duration", &duration(get("totalApiDurationMs"))),
                ("turns", &get("numTurns").to_string()),
            ],
        )
    };
    text.push_str(harness.text(TextId::CommandsLocalTokenColumns));
    for (label, key) in [
        (harness.text(TextId::CommandsLocalTokenInput), "input"),
        (harness.text(TextId::CommandsLocalTokenOutput), "output"),
        (
            harness.text(TextId::CommandsLocalTokenCacheCreate),
            "cacheCreate",
        ),
        (
            harness.text(TextId::CommandsLocalTokenCacheRead),
            "cacheRead",
        ),
    ] {
        text.push_str(&format!("| {label} | {} |\n", number(token(key))));
    }
    if usage {
        text.push_str(harness.text(TextId::CommandsLocalQuotaUnavailable));
    } else if get("numTurns") == 0. {
        text.push_str(harness.text(TextId::CommandsLocalInflightUnavailable));
    }
    text
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Host(std::sync::Mutex<Vec<Value>>);
    #[async_trait]
    impl CommandHost for Host {
        async fn clear_messages(&self) -> Result<()> {
            self.0.lock().unwrap().push(json!(["clear"]));
            Ok(())
        }
        async fn compact_session(&self, instructions: Option<String>) -> Result<()> {
            self.0
                .lock()
                .unwrap()
                .push(json!(["compact", instructions]));
            Ok(())
        }
        async fn set_model(&self, model: String) -> Result<()> {
            self.0.lock().unwrap().push(json!(["model", model]));
            Ok(())
        }
    }
    #[async_trait]
    impl HostBridge for Host {
        async fn call(&self, method: &str, _: Value, _: &CancellationToken) -> Result<Value> {
            panic!("unexpected callback {method}");
        }
    }
    #[tokio::test]
    async fn skill_command_wraps_instructions_in_the_recoverable_envelope() {
        let path =
            std::env::temp_dir().join(format!("native-skill-command-{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&path, "Review these changes$ARGUMENTS_SUFFIX.").unwrap();
        let skills = json!([{"name":"qux","description":"Review changes","source":{"kind":"file","path":path}}]);
        let registry = CommandRegistry::from_options(&json!({}), &skills, true).unwrap();
        let host = Host::default();
        let result = dispatch(
            &registry,
            "qux",
            "hello world",
            &json!({}),
            &host,
            &host,
            &CancellationToken::new(),
        )
        .await;
        std::fs::remove_file(path).unwrap();
        let DispatchOutcome::PromptReplacement { messages, .. } = result.unwrap() else {
            panic!("expected skill prompt replacement");
        };
        assert_eq!(
            messages,
            vec![
                json!({"role":"user","content":"<skill-instructions name=\"qux\">\nReview these changes: hello world.\n</skill-instructions>"})
            ]
        );
        assert_eq!(
            crate::prompt::skill_context::collect_active(&messages, &[]),
            vec![json!({"name":"qux"})]
        );
    }
    #[tokio::test]
    async fn command_results_and_host_effects_match_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!("fixtures/results.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let host = Host::default();
            let registry = CommandRegistry::from_options(&json!({}), &json!([]), true).unwrap();
            let mut snapshot = fixture["snapshot"].clone();
            if snapshot.get("commands").is_none() {
                snapshot["commands"] = json!(registry
                    .list(&host, &CancellationToken::new())
                    .await
                    .unwrap());
            }
            let result = dispatch(
                &registry,
                fixture["name"].as_str().unwrap(),
                fixture["args"].as_str().unwrap(),
                &snapshot,
                &host,
                &host,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let result = match result {
                DispatchOutcome::LocalResult { markdown, .. } => {
                    json!({"kind":"local-result","markdown":markdown})
                }
                DispatchOutcome::PromptReplacement { messages, .. } => {
                    json!({"kind":"prompt-replacement","messages":messages})
                }
                other => panic!("unexpected result {other:?}"),
            };
            assert_eq!(result, fixture["expected"], "{}", fixture["name"]);
            assert_eq!(json!(*host.0.lock().unwrap()), fixture["effects"]);
        }
    }
    #[tokio::test]
    async fn model_text_overrides_reach_command_metadata_and_prompt_replacement() {
        let harness = crate::harness::Harness::from_config(&json!({"models":{"fixture":{"commands.init.description":"Initialize fixture","commands.init.instructions":"Fixture instructions","commands.local.cleared":"Cleared fixture"}}})).unwrap().for_model("fixture");
        let registry = CommandRegistry::from_options(&json!({}), &json!([]), true).unwrap();
        let host = Host::default();
        let cancel = CancellationToken::new();
        let commands = registry
            .list_with_harness(&host, &cancel, &harness)
            .await
            .unwrap();
        assert_eq!(
            commands
                .iter()
                .find(|command| command["name"] == "init")
                .unwrap()["description"],
            "Initialize fixture"
        );
        match dispatch_with_harness(
            &registry,
            "init",
            "",
            &json!({}),
            &host,
            &host,
            &cancel,
            &harness,
        )
        .await
        .unwrap()
        {
            DispatchOutcome::PromptReplacement { messages, .. } => {
                assert_eq!(messages[0]["content"], "Fixture instructions")
            }
            other => panic!("unexpected result {other:?}"),
        }
        match dispatch_with_harness(
            &registry,
            "clear",
            "",
            &json!({}),
            &host,
            &host,
            &cancel,
            &harness,
        )
        .await
        .unwrap()
        {
            DispatchOutcome::LocalResult { markdown, .. } => {
                assert_eq!(markdown, "Cleared fixture")
            }
            other => panic!("unexpected result {other:?}"),
        }
        assert_eq!(*host.0.lock().unwrap(), vec![json!(["clear"])]);
    }
    #[test]
    fn parses_only_first_line_and_rejects_paths() {
        assert_eq!(
            parse(" /help topic\nsecond "),
            Some(Invocation {
                name: "help".into(),
                args: "topic".into()
            })
        );
        for input in ["//foo", "/tmp/a.log", "/", "/ command"] {
            assert_eq!(parse(input), None);
        }
    }
    #[test]
    fn overlay_replaces_handler_and_releases_aliases() {
        let registry = CommandRegistry::from_options(
            &json!({"slashCommands":[{"name":"clear","description":"host"}]}),
            &json!([]),
            true,
        )
        .unwrap();
        assert!(registry.get("reset").is_none());
        assert!(matches!(
            registry.get("clear").unwrap().executor,
            Executor::Host
        ));
    }
}
