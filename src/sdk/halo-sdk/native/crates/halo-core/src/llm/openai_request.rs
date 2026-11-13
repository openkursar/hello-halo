use super::{
    image_budget::{assert_image_body_budget, assert_image_request_budget},
    model_quirks::{apply_response, is_o_series, is_quirky},
};
use crate::{
    error::{Error, Result},
    js::truthy,
};
#[cfg(test)]
use crate::js::stringify;
use serde_json::{json, Map, Value};

pub fn capabilities(config: &Value) -> Value {
    json!({"streaming":true,"toolCalling":true,"thinking":truthy(&config["quirks"]["reasoningField"]),"imageInput":true,"pdfInput":false,"audioInput":false,"videoInput":false,"caching":false,"systemPromptStyle":"system_message"})
}

pub fn resolve_model(request: &Value, config: &Value) -> Result<String> {
    let model = if truthy(&request["model"]) {
        &request["model"]
    } else {
        &config["defaultModel"]
    };
    model.as_str().filter(|value|!value.is_empty()).map(str::to_owned).ok_or_else(|| Error::new("MISSING_MODEL","No model specified: set ProviderRequest.model or OpenAiCompatProviderConfig.defaultModel."))
}

pub fn build_headers(config: &Value) -> Value {
    let mut headers = json!({"Content-Type":"application/json"});
    if truthy(&config["apiKey"]) {
        headers["Authorization"] = json!(format!(
            "Bearer {}",
            config["apiKey"].as_str().unwrap_or("")
        ));
    }
    if let Some(extra) = config["headers"].as_object() {
        headers.as_object_mut().unwrap().extend(extra.clone());
    }
    headers
}

pub fn build_body(request: &Value, config: &Value, stream: bool) -> Result<Value> {
    build_body_with_harness(request, config, stream, &crate::harness::baseline())
}
pub fn build_body_with_harness(
    request: &Value,
    config: &Value,
    stream: bool,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Value> {
    let input = request["messages"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    assert_image_request_budget(input)?;
    let model = resolve_model(request, config)?;
    let quirks = &config["quirks"];
    let messages = messages(input, &request["systemPrompt"], quirks, harness)?;
    let o_series = is_o_series(&model);
    let mut body = json!({"model":model,"messages":messages,"stream":stream});
    if let Some(maximum) = request.get("maxTokens").filter(|value| !value.is_null()) {
        body[if o_series {
            "max_completion_tokens"
        } else {
            "max_tokens"
        }] = maximum.clone();
    }
    if stream && truthy(&quirks["includeUsageInStream"]) {
        body["stream_options"] = json!({"include_usage":true});
    }
    if let Some(tools) = request["tools"]
        .as_array()
        .filter(|tools| !tools.is_empty())
    {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| {
                let mut function = Map::new();
                for (to, from) in [
                    ("name", "name"),
                    ("description", "description"),
                    ("parameters", "input_schema"),
                ] {
                    if let Some(value) = tool.get(from) {
                        function.insert(to.into(), value.clone());
                    }
                }
                json!({"type":"function","function":function})
            })
            .collect::<Vec<_>>());
    }
    if !o_series {
        if let Some(temperature) = request
            .get("temperature")
            .filter(|value| !value.is_null())
            .or_else(|| quirks.get("defaultTemperature"))
        {
            body["temperature"] = temperature.clone();
        }
    }
    if let Some(top_p) = request.get("topP") {
        body["top_p"] = top_p.clone();
    }
    if let Some(stop) = request["stopSequences"]
        .as_array()
        .filter(|stop| !stop.is_empty())
    {
        body["stop"] = json!(stop);
    }
    if (o_series || truthy(&quirks["reasoningEffort"]))
        && truthy(&request["providerOptions"]["reasoning_effort"])
    {
        body["reasoning_effort"] = request["providerOptions"]["reasoning_effort"].clone();
    }
    assert_image_body_budget(&body)?;
    Ok(body)
}

fn messages(
    input: &[Value],
    system: &Value,
    quirks: &Value,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    if truthy(system) {
        let text = if let Some(text) = system.as_str() {
            text.to_owned()
        } else {
            system
                .as_array()
                .into_iter()
                .flatten()
                .map(|block| block["text"].as_str().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n\n")
        };
        result.push(json!({"role":"system","content":text}));
    }
    for message in input {
        if message["content"].is_string() {
            result.push(json!({"role":message["role"],"content":message["content"]}));
            continue;
        }
        let blocks = message["content"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if message["role"] == "assistant" {
            let mut text = String::new();
            let mut tools = Vec::new();
            for block in blocks {
                match block["type"].as_str().unwrap_or("") {
                    "text"=>text.push_str(block["text"].as_str().unwrap_or("")),
                    "tool_use"=>tools.push(json!({"id":scrub_id(block["id"].as_str().unwrap_or(""),quirks)?,"type":"function","function":{"name":block["name"],"arguments":crate::js::data::stringify(&block["input"])}})),
                    _=>{}
                }
            }
            let mut assistant = json!({"role":"assistant"});
            if !text.is_empty() || tools.is_empty() {
                assistant["content"] = json!(text);
            }
            if !tools.is_empty() {
                assistant["tool_calls"] = json!(tools);
            }
            result.push(assistant);
        } else if message["role"] == "user" {
            let mut others = Vec::new();
            let mut images = Vec::new();
            let mut tools = 0;
            for block in blocks {
                if block["type"] != "tool_result" {
                    others.push(block.clone());
                    continue;
                }
                tools += 1;
                let content = if let Some(text) = block["content"].as_str() {
                    text.to_owned()
                } else {
                    block["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|block| block["type"] == "text")
                        .map(|block| block["text"].as_str().unwrap_or(""))
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                result.push(json!({"role":"tool","tool_call_id":scrub_id(block["tool_use_id"].as_str().unwrap_or(""),quirks)?,"content":content}));
                let attached: Vec<_> = block["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|block| block["type"] == "image")
                    .cloned()
                    .collect();
                if !attached.is_empty() {
                    images.push(json!({"type":"text","text":harness.render(crate::harness::TextId::ProvidersHistoryToolImages,&[("id",block["tool_use_id"].as_str().unwrap_or(""))])}));
                    images.extend(attached);
                }
            }
            if !others.is_empty() || !images.is_empty() {
                images.extend(others);
                result.push(json!({"role":"user","content":user_content(&images)}));
            } else if tools == 0 {
                result.push(json!({"role":"user","content":""}));
            }
        }
    }
    if truthy(&quirks["fixToolUserSequence"]) {
        let mut index = 0;
        while index + 1 < result.len() {
            if result[index]["role"] == "tool" && result[index + 1]["role"] == "user" {
                result.insert(index + 1, json!({"role":"assistant","content":harness.text(crate::harness::TextId::ProvidersHistorySequenceCompletion)}));
                index += 2;
            } else {
                index += 1;
            }
        }
    }
    Ok(result)
}

fn user_content(blocks: &[Value]) -> Value {
    if blocks.iter().all(|block| block["type"] == "text") {
        return json!(blocks
            .iter()
            .map(|block| block["text"].as_str().unwrap_or(""))
            .collect::<String>());
    }
    json!(blocks.iter().map(|block|match block["type"].as_str().unwrap_or("") {
        "text"=>json!({"type":"text","text":block["text"]}),
        "image"=>json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",block["source"]["media_type"].as_str().unwrap_or("undefined"),block["source"]["data"].as_str().unwrap_or("undefined"))}}),
        _=>json!({"type":"text","text":""})
    }).collect::<Vec<_>>())
}

fn scrub_id(id: &str, quirks: &Value) -> Result<String> {
    let id = if truthy(&quirks["toolIdAlphanumericOnly"]) {
        id.chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
    } else {
        id.to_owned()
    };
    if !truthy(&quirks["toolIdMaxLen"]) {
        return Ok(id);
    }
    let limit = quirks["toolIdMaxLen"].as_f64().unwrap_or(0.0).trunc();
    if !limit.is_finite() || limit > 536_870_888.0 {
        return Err(Error::new("INVALID_STRING_LENGTH", "Invalid string length")
            .with_details(json!({"name":"RangeError"})));
    }
    let units: Vec<u16> = id.encode_utf16().collect();
    let end = if limit < 0.0 {
        (units.len() as f64 + limit).max(0.0) as usize
    } else {
        (limit as usize).min(units.len())
    };
    let mut units = units[..end].to_vec();
    let length = limit.max(0.0) as usize;
    if length > units.len() {
        units.resize(length, b'0' as u16);
    }
    String::from_utf16(&units).map_err(|_| {
        Error::new(
            "JS_STRING_UNREPRESENTABLE",
            "Tool identifier truncation produced an unpaired UTF-16 surrogate",
        )
    })
}

pub fn finish_reason(reason: &str) -> &str {
    match reason {
        "stop" => "end_turn",
        "tool_calls" => "tool_use",
        "length" => "max_tokens",
        "content_filter" => "content_filtered",
        other => other,
    }
}

pub fn parse_usage(usage: &Value) -> Value {
    if !truthy(usage) {
        return json!({"input_tokens":0,"output_tokens":0});
    }
    let input = usage["prompt_tokens"].as_f64().unwrap_or(0.0);
    let reported = usage["prompt_tokens_details"]
        .get("cached_tokens")
        .filter(|value| !value.is_null())
        .unwrap_or(&usage["prompt_cache_hit_tokens"]);
    let cached = reported
        .as_f64()
        .filter(|value| value.is_finite())
        .map(|value| value.min(input).max(0.0))
        .unwrap_or(0.0);
    let mut result = json!({"input_tokens":input-cached,"output_tokens":usage["completion_tokens"].as_f64().unwrap_or(0.0)});
    if cached > 0.0 {
        result["cache_read_input_tokens"] = json!(cached);
    }
    result
}

pub fn parse_response(response: &Value, model: &str) -> Result<Value> {
    parse_response_with_harness(response, model, &crate::harness::baseline())
}

pub fn parse_response_with_harness(response: &Value, model: &str, harness: &crate::harness::ResolvedHarness) -> Result<Value> {
    let choice = &response["choices"][0];
    let message = &choice["message"];
    let mut content = Vec::new();
    if message["thinking"]["content"]
        .as_str()
        .is_some_and(|text| !text.is_empty())
    {
        let mut block = json!({"type":"thinking","thinking":message["thinking"]["content"]});
        if message["thinking"]["signature"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        {
            block["signature"] = message["thinking"]["signature"].clone();
        }
        content.push(block);
    } else {
        for field in [
            "reasoning_content",
            "thinking_content",
            "reasoning_text",
            "reasoning",
        ] {
            if truthy(&message[field]) {
                content.push(json!({"type":"thinking","thinking":message[field]}));
                break;
            }
        }
    }
    if truthy(&message["content"]) {
        content.push(json!({"type":"text","text":message["content"]}));
    }
    let refusal = (!truthy(&message["content"]))
        .then(|| message["refusal"].as_str().filter(|text| !text.is_empty())).flatten();
    let mut invalid_calls = 0;
    for tool in message["tool_calls"].as_array().into_iter().flatten() {
        let function = &tool["function"];
        let input = match &function["arguments"] {
            Value::String(text) => serde_json::from_str::<Value>(text).ok(),
            Value::Null => Some(json!({})),
            value => Some(value.clone()),
        };
        let Some(input) = input.filter(Value::is_object) else { invalid_calls += 1; continue; };
        content.push(json!({"type":"tool_use","id":tool["id"].as_str().unwrap_or(""),"name":function["name"].as_str().unwrap_or(""),"input":input}));
    }
    if invalid_calls > 0 {
        content.retain(|block| block["type"] != "tool_use");
        tracing::warn!(invalid_calls,"Complete response calls withheld because an argument object was unreadable");
    }
    if content.is_empty() && refusal.is_none() {
        content.push(json!({"type":"text","text":""}));
    }
    let result = json!({"id":response["id"].as_str().unwrap_or("unknown"),"content":content,"stopReason":finish_reason(choice["finish_reason"].as_str().unwrap_or("stop")),"usage":parse_usage(&response["usage"]),"model":response["model"].as_str().unwrap_or(model)});
    let mut result = if is_quirky(model) {
        apply_response(model, &result)
    } else {
        result
    };
    if let Some(refusal) = refusal {
        let content = result["content"].as_array_mut().unwrap();
        let index = content.iter().position(|block| block["type"] == "tool_use").unwrap_or(content.len());
        content.insert(index, json!({"type":"text","text":refusal}));
    }
    if invalid_calls > 0 {
        result["unreadableToolCall"] = json!(harness.text(crate::harness::TextId::ProvidersResponseUnreadableArguments));
        result["stopReason"] = json!("tool_use");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_and_response_shapes_match_baseline() {
        let fixtures: Value =
            serde_json::from_str(include_str!("fixtures/openai-baseline.json")).unwrap();
        for fixture in fixtures["requests"].as_array().unwrap() {
            let body = build_body(
                &fixture["request"],
                &fixture["config"],
                fixture["stream"] == true,
            )
            .unwrap();
            assert_eq!(
                stringify(&body),
                stringify(&fixture["expected"]),
                "{}",
                fixture["name"]
            );
        }
        for fixture in fixtures["responses"].as_array().unwrap() {
            let response =
                parse_response(&fixture["response"], fixture["model"].as_str().unwrap()).unwrap();
            let mut expected = fixture["expected"].clone();
            if fixture["name"] == "raw-tools" {
                expected["content"] = json!([{"type":"text","text":""}]);
                expected["stopReason"] = json!("tool_use");
                expected["unreadableToolCall"] = json!(crate::harness::TextId::ProvidersResponseUnreadableArguments.default_text());
            }
            assert_eq!(
                stringify(&response),
                stringify(&expected),
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn paired_tool_images_and_explicit_sequence_quirk_keep_text_exact() {
        let request = json!({"model":"m","maxTokens":100,"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"a-b","content":[{"type":"text","text":"result"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"YWJj"}}]},{"type":"text","text":"next"}]}]});
        let body=build_body(&request,&json!({"quirks":{"toolIdAlphanumericOnly":true,"toolIdMaxLen":4,"fixToolUserSequence":true}}),true).unwrap();
        assert_eq!(
            body["messages"][0],
            json!({"role":"tool","tool_call_id":"ab00","content":"result"})
        );
        assert_eq!(
            body["messages"][1],
            json!({"role":"assistant","content":"Done."})
        );
        assert_eq!(
            body["messages"][2]["content"][0]["text"],
            "Images from tool result a-b:"
        );
        assert_eq!(
            body["messages"][2]["content"][1]["image_url"]["url"],
            "data:image/png;base64,YWJj"
        );
    }
    #[test]
    fn o_series_and_cached_usage_match_original_fields() {
        let body=build_body(&json!({"model":"openai/o3-mini","messages":[],"maxTokens":123,"temperature":0.2,"topP":null,"providerOptions":{"reasoning_effort":"high"}}),&json!({}),true).unwrap();
        assert_eq!(body["max_completion_tokens"], 123);
        assert!(body.get("temperature").is_none());
        assert_eq!(body["top_p"], Value::Null);
        assert_eq!(
            parse_usage(
                &json!({"prompt_tokens":100,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":60}})
            ),
            json!({"input_tokens":40.0,"output_tokens":4.0,"cache_read_input_tokens":60.0})
        );
    }
}
