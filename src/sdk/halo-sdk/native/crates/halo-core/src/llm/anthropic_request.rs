use super::cache::{
    add_cache_breakpoints, add_system_prompt_cache_breakpoint, limit_cache_breakpoints,
};
use super::image_budget::{assert_image_body_budget, assert_image_request_budget};
use crate::bridge::HostBridge;
use crate::error::{Error, Result};
use crate::js::truthy;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub async fn build_body(
    request: &Value,
    config: &Value,
    bridge: &dyn HostBridge,
    cancellation: &CancellationToken,
) -> Result<Value> {
    assert_image_request_budget(array(&request["messages"]))?;
    let model = request["model"].as_str().filter(|model| !model.is_empty()).or(config["defaultModel"].as_str()).filter(|model| !model.is_empty())
        .ok_or_else(|| Error::new("INVALID_MODEL", "No model specified: set ProviderRequest.model or AnthropicProviderConfig.defaultModel."))?;
    let model = regex::Regex::new(r"(?i)\[(1|2)m\]")
        .unwrap()
        .replace_all(model, "")
        .to_string();
    let max_tokens = request["maxTokens"]
        .as_f64()
        .filter(|n| *n > 0.0)
        .unwrap_or(16_384.0);
    let has_thinking =
        request.get("thinking").is_some() && request["thinking"]["type"] != "disabled";
    let thinking = match request["thinking"]["type"].as_str() {
        Some("adaptive") => Some(json!({"type":"adaptive"})),
        Some("enabled") => Some(
            json!({"type":"enabled","budget_tokens":(max_tokens - 1.0).min(request["thinking"]["budgetTokens"].as_f64().unwrap_or(0.0))}),
        ),
        Some("disabled") => Some(json!({"type":"disabled"})),
        _ => None,
    };
    let provider_options = &request["providerOptions"];
    let enable_caching = provider_options["enableCaching"].as_bool().unwrap_or(true);
    let extended = provider_options["extendedTtl"].as_bool().unwrap_or(false);
    let skip_write = provider_options["skipCacheWrite"]
        .as_bool()
        .unwrap_or(false);
    let messages = add_cache_breakpoints(
        array(&request["messages"]),
        enable_caching,
        skip_write,
        extended,
    );
    let mut system = if truthy(&request["systemPrompt"]) {
        Some(if enable_caching {
            add_system_prompt_cache_breakpoint(&request["systemPrompt"], extended)
        } else {
            request["systemPrompt"].clone()
        })
    } else {
        None
    };
    let identity = &config["requestIdentity"];
    if truthy(&identity["systemPrefix"]) && system.is_some() {
        let messages = prefix_messages(&request["messages"], identity);
        let prefix = invoke(
            bridge,
            &identity["systemPrefix"],
            json!([messages, {"signal":{"__haloSdkNativeSignal":true}}]),
            cancellation,
        )
        .await?;
        system = match system.unwrap() {
            Value::String(text) => Some(json!([prefix,{"type":"text","text":text}])),
            Value::Array(mut blocks) => {
                blocks.insert(0, prefix);
                Some(Value::Array(blocks))
            }
            other => Some(other),
        };
    }
    let mut body =
        json!({"model":model,"max_tokens":max_tokens,"messages":normalize_messages(&messages)});
    if let Some(system) = system {
        body["system"] = system;
    }
    let tools = array(&request["tools"]);
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.iter().enumerate().map(|(index, tool)| {
            let mut schema = tool["input_schema"].clone();
            if !truthy(&schema["type"]) {
                let mut object = Map::new(); object.insert("type".into(), json!("object"));
                if let Some(schema) = schema.as_object() { object.extend(schema.clone()); }
                schema = Value::Object(object);
            }
            let mut declaration = json!({"name":tool["name"],"description":tool["description"],"input_schema":schema});
            if enable_caching && index == tools.len() - 1 { declaration["cache_control"] = json!({"type":"ephemeral"}); }
            declaration
        }).collect());
    }
    if !has_thinking {
        body["temperature"] = request
            .get("temperature")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(json!(1));
    }
    if truthy(&request["toolChoice"]) {
        body["tool_choice"] = request["toolChoice"].clone();
    }
    for (source, target) in [("topP", "top_p"), ("topK", "top_k")] {
        if let Some(value) = request.get(source) {
            body[target] = value.clone();
        }
    }
    if !array(&request["stopSequences"]).is_empty() {
        body["stop_sequences"] = request["stopSequences"].clone();
    }
    if let Some(thinking) = thinking {
        body["thinking"] = thinking;
    }
    for (source, target) in [
        ("metadata", "metadata"),
        ("contextManagement", "context_management"),
    ] {
        if truthy(&identity[source]) {
            body[target] = identity[source].clone();
        }
    }
    let mut output = Map::new();
    if truthy(&provider_options["effort"]) {
        output.insert("effort".into(), provider_options["effort"].clone());
    }
    if truthy(&provider_options["taskBudget"]) {
        let mut task = Map::new();
        task.insert("type".into(), json!("tokens"));
        if let Some(values) = provider_options["taskBudget"].as_object() {
            task.extend(values.clone());
        }
        output.insert("task_budget".into(), Value::Object(task));
    }
    if !output.is_empty() {
        body["output_config"] = Value::Object(output);
    }
    limit_cache_breakpoints(&mut body);
    assert_image_body_budget(&body)?;
    Ok(body)
}

fn prefix_messages(messages: &Value, identity: &Value) -> Value {
    if identity["systemPrefixMessages"] != "first-user-text" {
        return messages.clone();
    }
    let user = messages
        .as_array()
        .into_iter()
        .flatten()
        .find(|message| message["role"] == "user");
    let content = user.map(|user| &user["content"]);
    let text = content
        .and_then(|content| {
            content.as_str().or_else(|| {
                content
                    .as_array()
                    .and_then(|blocks| blocks.iter().find(|block| block["type"] == "text"))
                    .and_then(|block| block["text"].as_str())
            })
        })
        .unwrap_or("");
    json!([{"role":"user","content":text}])
}

pub async fn invoke(
    bridge: &dyn HostBridge,
    callback: &Value,
    args: Value,
    cancellation: &CancellationToken,
) -> Result<Value> {
    let callback_id = callback["__haloSdkNativeCallback"]
        .as_str()
        .ok_or_else(|| Error::new("INVALID_CALLBACK", "Host callback is not registered"))?;
    bridge
        .call(
            "callback",
            json!({"callbackId":callback_id,"args":args}),
            cancellation,
        )
        .await
}

pub async fn build_headers(
    config: &Value,
    provider_options: &Value,
    thinking: bool,
    attempt: u32,
    bridge: &dyn HostBridge,
    cancellation: &CancellationToken,
) -> Result<Value> {
    let mut headers = json!({"content-type":"application/json","x-api-key":config["apiKey"],"anthropic-version":config["apiVersion"].as_str().unwrap_or("2023-06-01")});
    if let Some(identity) = config
        .get("requestIdentity")
        .filter(|identity| truthy(identity))
    {
        if let Some(values) = identity["headers"].as_object() {
            headers.as_object_mut().unwrap().extend(values.clone());
        }
        if truthy(&identity["headersForAttempt"]) {
            let values = invoke(
                bridge,
                &identity["headersForAttempt"],
                json!([attempt,{"signal":{"__haloSdkNativeSignal":true}}]),
                cancellation,
            )
            .await?;
            if let Some(values) = values.as_object() {
                headers.as_object_mut().unwrap().extend(values.clone());
            }
        }
        headers["x-client-request-id"] = json!(uuid::Uuid::new_v4().to_string());
    }
    let mut betas = Vec::<String>::new();
    for (enabled, beta) in [
        (thinking, "interleaved-thinking-2025-05-14"),
        (
            truthy(&config["requestIdentity"]["contextManagement"]),
            "context-management-2025-06-27",
        ),
        (
            provider_options["enable1mContext"]
                .as_bool()
                .unwrap_or(false),
            "context-1m-2025-08-07",
        ),
        (
            truthy(&provider_options["taskBudget"]),
            "task-budgets-2026-03-13",
        ),
    ] {
        if enabled {
            betas.push(beta.to_owned());
        }
    }
    for beta in array(&config["betas"])
        .iter()
        .filter_map(Value::as_str)
        .filter(|beta| !beta.is_empty())
    {
        if !betas.iter().any(|item| item == beta) {
            betas.push(beta.to_owned());
        }
    }
    if !betas.is_empty() {
        headers["anthropic-beta"] = json!(betas.join(","));
    }
    if let Some(values) = config["headers"].as_object() {
        headers.as_object_mut().unwrap().extend(values.clone());
    }
    Ok(headers)
}

pub fn normalize_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let content = if message["content"].is_string() {
                message["content"].clone()
            } else {
                Value::Array(
                    array(&message["content"])
                        .iter()
                        .map(normalize_block)
                        .collect(),
                )
            };
            json!({"role":message["role"],"content":content})
        })
        .collect()
}

fn normalize_block(block: &Value) -> Value {
    let mut output = match block["type"].as_str().unwrap_or("") {
        "text" => json!({"type":"text","text":block["text"]}),
        "thinking" => {
            let mut value = json!({"type":"thinking","thinking":block["thinking"]});
            if truthy(&block["signature"]) {
                value["signature"] = block["signature"].clone();
            }
            return value;
        }
        "tool_use" => {
            json!({"type":"tool_use","id":block["id"],"name":block["name"],"input":block["input"]})
        }
        "tool_result" => {
            let mut value = json!({"type":"tool_result","tool_use_id":block["tool_use_id"],"content":block["content"]});
            if truthy(&block["is_error"]) {
                value["is_error"] = json!(true);
            }
            value
        }
        "image" | "document" => json!({"type":block["type"],"source":block["source"]}),
        _ => return block.clone(),
    };
    if truthy(&block["cache_control"]) {
        output["cache_control"] = block["cache_control"].clone();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opening_user_projection_is_opt_in_and_preserves_exact_text() {
        let fixtures: Value =
            serde_json::from_str(include_str!("fixtures/prefix-projection.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            assert_eq!(
                prefix_messages(&fixture["messages"], &json!({})),
                fixture["messages"]
            );
            assert_eq!(
                prefix_messages(
                    &fixture["messages"],
                    &json!({"systemPrefixMessages":"first-user-text"})
                ),
                fixture["projected"]
            );
        }
    }
    use async_trait::async_trait;
    struct NoCallbacks;
    #[async_trait]
    impl HostBridge for NoCallbacks {
        async fn call(
            &self,
            _method: &str,
            _params: Value,
            _cancellation: &CancellationToken,
        ) -> Result<Value> {
            Err(Error::new(
                "UNEXPECTED_CALLBACK",
                "Unexpected test callback",
            ))
        }
    }
    #[tokio::test]
    async fn request_and_header_shapes_match_baseline() {
        let fixtures: Value =
            serde_json::from_str(include_str!("fixtures/anthropic-baseline.json")).unwrap();
        for fixture in fixtures["requests"].as_array().unwrap() {
            let result = build_body(
                &fixture["request"],
                &fixture["config"],
                &NoCallbacks,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                crate::js::stringify(&result),
                crate::js::stringify(&fixture["expected"]),
                "{}",
                fixture["name"]
            );
        }
        for fixture in fixtures["headerCases"].as_array().unwrap() {
            let mut result = build_headers(
                &fixture["config"],
                &fixture["options"],
                fixture["thinking"] == true,
                fixture["attempt"].as_u64().unwrap() as u32,
                &NoCallbacks,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            result
                .as_object_mut()
                .unwrap()
                .remove("x-client-request-id");
            assert_eq!(
                crate::js::stringify(&result),
                crate::js::stringify(&fixture["expected"]),
                "{}",
                fixture["name"]
            );
        }
    }
}
