use crate::{
    error::{Error, Result},
    js::{is_undefined, number, truthy, undefined},
};
use serde_json::{json, Value};

fn optional(options: &Value, key: &str) -> Value {
    options.get(key).cloned().unwrap_or_else(undefined)
}
fn nullish(options: &Value, key: &str, default: Value) -> Value {
    options
        .get(key)
        .filter(|value| !value.is_null() && !is_undefined(value))
        .cloned()
        .unwrap_or(default)
}
pub fn default_conventions() -> Value {
    json!({"memoryFiles":["AGENTS.md","CLAUDE.md"],"memorySubdirs":["",".agents",".claude"],"agentDirs":[".agents",".claude"],"configDirEnv":"CLAUDE_CONFIG_DIR","userConfigDirName":".claude"})
}

pub fn resolve(options: &Value) -> Result<Value> {
    if !truthy(&options["model"]) {
        return Err(Error::new(
            "MISSING_MODEL",
            "Options.model is required; the SDK does not pick a model on its own.",
        ));
    }
    let skill_catalog = if options
        .get("skillCatalog")
        .is_some_and(|value| !is_undefined(value))
    {
        crate::skills::snapshot_catalog(&options["skillCatalog"])?
    } else {
        undefined()
    };
    let window = if truthy(&options["contextWindow"])
        && number(&options["contextWindow"]).is_some_and(|value| value > 0.0)
    {
        options["contextWindow"].clone()
    } else {
        if options["betas"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == "context-1m-2025-08-07"))
        {
            tracing::warn!("betas requests the 1M context window but Options.contextWindow was not raised; budgeting against the 200000-token default");
        }
        json!(200_000)
    };
    let output = if truthy(&options["maxOutputTokens"])
        && number(&options["maxOutputTokens"]).is_some_and(|value| value > 0.0)
    {
        options["maxOutputTokens"].clone()
    } else {
        json!(16_384)
    };
    let cwd = nullish(
        options,
        "cwd",
        options["nativeProcessCwd"]
            .as_str()
            .map(|value| json!(value))
            .unwrap_or_else(|| {
                json!(std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy())
            }),
    );
    let mut normalized = options.clone();
    normalized["cwd"] = cwd.clone();
    let read_deny = crate::tools::resolve_read_deny_roots(&normalized)?;
    let discovery = if options
        .get("toolDiscovery")
        .is_some_and(|value| !is_undefined(value))
    {
        super::tool_context::catalog::validate_options(&options["toolDiscovery"])
            .map_err(|error| error.with_details(json!({"name":"TypeError"})))?;
        options["toolDiscovery"].clone()
    } else {
        undefined()
    };
    let mut conventions = default_conventions();
    if truthy(&options["conventions"]) {
        if let Some(overrides) = options["conventions"].as_object() {
            conventions
                .as_object_mut()
                .unwrap()
                .extend(overrides.clone());
        }
    }
    let thinking = options
        .get("thinking")
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or_else(|| {
            super::effort::thinking_for_budget(
                &optional(options, "maxThinkingTokens"),
                truthy(&options["adaptiveThinking"]),
            )
        });
    let mut result = json!({
        "skillCatalog":skill_catalog,"model":options["model"],"maxTokens":output,"contextWindow":window,
        "maxTurns":nullish(options,"maxTurns",json!(100)),"maxBudgetUsd":nullish(options,"maxBudgetUsd",crate::js::number_value(f64::INFINITY)),
        "modelPricing":nullish(options,"modelPricing",json!({})),"cwd":cwd,"env":nullish(options,"env",json!({})),
        "systemPrompt":nullish(options,"systemPrompt",json!({"type":"preset","preset":"default"})),"promptProfile":optional(options,"promptProfile"),
        "ultraEffort":options["ultraEffort"].as_bool()==Some(true),
        "thinking":thinking,"thinkingExplicit":(["thinking","maxThinkingTokens"].iter().any(|key|options.get(*key).is_some_and(|value|!is_undefined(value)))),
        "adaptiveThinking":nullish(options,"adaptiveThinking",json!(false)),"effort":nullish(options,"effort",json!("high")),
        "toolResultBudget":nullish(options,"toolResultBudget",json!(50_000)),"includePartialMessages":nullish(options,"includePartialMessages",json!(false)),
        "permissionMode":nullish(options,"permissionMode",json!("default")),"allowedTools":optional(options,"allowedTools"),"disallowedTools":optional(options,"disallowedTools"),
        "readDenyRoots":read_deny,"mcpServers":optional(options,"mcpServers"),"toolDiscovery":discovery,"hooks":optional(options,"hooks"),"canUseTool":optional(options,"canUseTool"),"abortSignal":undefined(),
        "fallbackModel":optional(options,"fallbackModel"),"betas":optional(options,"betas"),"taskBudget":optional(options,"taskBudget"),"additionalDirectories":optional(options,"additionalDirectories"),
        "settingSources":optional(options,"settingSources"),"conventions":conventions,"toolCallingMode":crate::llm::tool_calling::mode(options),
        "turnEndChecks":{"openWork":nullish(&options["turnEndChecks"],"openWork",json!(true)),"completion":nullish(&options["turnEndChecks"],"completion",json!(false))}
    });
    if let Some(harness) = options
        .get("harnessText")
        .filter(|value| !is_undefined(value))
    {
        crate::harness::Harness::from_config(harness)?;
        result["harnessText"] = harness.clone();
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_configuration_matches_baseline_values_and_failures() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/config-baseline.json")).unwrap();
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let result = resolve(&case["options"]);
            if let Some(expected) = case.get("error") {
                let error = result.unwrap_err();
                assert_eq!(
                    error.message,
                    expected["message"].as_str().unwrap(),
                    "case {index}"
                );
                let name = error
                    .details
                    .as_ref()
                    .and_then(|details| details["name"].as_str())
                    .unwrap_or("Error");
                assert_eq!(name, expected["name"].as_str().unwrap(), "case {index}");
            } else {
                let mut result = result.unwrap();
                result.as_object_mut().unwrap().shift_remove("abortSignal");
                assert_eq!(result.as_object_mut().unwrap().shift_remove("ultraEffort"), Some(json!(false)));
                assert_eq!(
                    crate::js::stringify(&result),
                    case["expected"].as_str().unwrap(),
                    "case {index}"
                );
            }
        }
    }
}
