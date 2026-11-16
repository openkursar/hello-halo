use crate::{
    bridge::HostBridge,
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    js::{text::JsText, value::JsValue},
    js_value,
    tools::failure,
};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};
use tokio_util::sync::CancellationToken;

fn nullish(value: &Value) -> bool {
    value.is_null() || crate::js::is_undefined(value)
}

pub fn is_sdk_config(value: &Value) -> bool {
    value.is_object()
        && value["type"] == "sdk"
        && value
            .get("instance")
            .is_some_and(|instance| !nullish(instance))
}

pub fn descriptors(
    server: &JsValue,
    source_server: &JsText,
    definitions: &JsValue,
    kind: &str,
) -> Result<Vec<JsValue>> {
    let server_name = field(server, "name")
        .as_text()
        .cloned()
        .unwrap_or_else(|| "".into());
    let service = |name: &str, fallback: &str| {
        server
            .get(name)
            .filter(|value| !matches!(value, JsValue::Null | JsValue::Undefined))
            .or_else(|| server.get(fallback))
            .cloned()
            .unwrap_or(JsValue::Undefined)
    };
    let mut result = Vec::new();
    let mut names = HashSet::new();
    for (index, definition) in definitions.as_array().into_iter().flatten().enumerate() {
        if kind == "registered" && field(definition, "enabled").as_bool() == Some(false) {
            continue;
        }
        let tool = field(definition, "name")
            .as_text()
            .cloned()
            .unwrap_or_else(|| "".into());
        let name = format!("mcp__{}__{}", normalize(&server_name), normalize(&tool));
        if !names.insert(name.clone()) {
            tracing::warn!(name, "MCP tool identity collision");
            return Err(Error::template(
                "MCP_IDENTITY_COLLISION",
                TextId::ToolsMcpIdentityCollision,
                &[("name", name.into())],
            )
            .with_details(json!({"name":"McpToolIdentityError"})));
        }
        let description = definition.get("description").and_then(JsValue::as_text);
        let description = if kind == "registered" {
            description.cloned().unwrap_or_else(|| "".into())
        } else {
            description.cloned().ok_or_else(|| {
                Error::new(
                    "INVALID_MCP_DESCRIPTION",
                    "Cannot read properties of undefined (reading 'length')",
                )
                .with_details(json!({"name":"TypeError"}))
            })?
        };
        let rendered = if description.len() > 2048 {
            crate::harness::baseline().render_text(
                TextId::ToolsMcpDescriptionTruncated,
                &[("description", &description.slice(0.0, Some(2048.0)))],
            )
        } else {
            description.clone()
        };
        result.push(js_value!({
            "name":name,
            "mcpSource":{"server":source_server,"description":service("description","instanceDescription"),"instructions":service("instructions","instanceInstructions"),"name":&tool,"toolDescription":description},
            "description":rendered,"inputSchema":field(definition,"inputSchema"),"permissionLevel":"execute","concurrencySafe":field(field(definition,"annotations"),"readOnlyHint").as_bool() == Some(true),
            "nativeMcp":{"kind":kind,"serverName":&server_name,"toolName":&tool,"index":index}
        }));
    }
    Ok(result)
}

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    value.get(name).unwrap_or(&JsValue::Undefined)
}

fn normalize(name: &JsText) -> String {
    name.units()
        .map(|unit| {
            if unit <= 127
                && ((unit as u8).is_ascii_alphanumeric()
                    || unit == b'_' as u16
                    || unit == b'-' as u16)
            {
                unit as u8 as char
            } else {
                '_'
            }
        })
        .collect()
}

pub fn assert_unique_data(descriptors: &[JsValue]) -> Result<()> {
    let mut names = HashSet::new();
    for descriptor in descriptors {
        let name = field(descriptor, "name")
            .as_text()
            .cloned()
            .unwrap_or_else(|| "".into());
        if !names.insert(name.clone()) {
            tracing::warn!("MCP tool identity collision");
            return Err(Error::new_text(
                "MCP_IDENTITY_COLLISION",
                crate::harness::baseline()
                    .render_text(TextId::ToolsMcpIdentityCollision, &[("name", &name)]),
            )
            .with_details(json!({"name":"McpToolIdentityError"})));
        }
    }
    Ok(())
}

pub async fn invoke_data(
    descriptor: &JsValue,
    input: JsValue,
    bridge: Arc<dyn HostBridge>,
    cancellation: &CancellationToken,
) -> Result<JsValue> {
    let mut request = field(descriptor, "nativeMcp").clone();
    if let Some(fields) = request.as_object_mut() {
        fields.insert("input".into(), input);
        fields.insert("publicName".into(), field(descriptor, "name").clone());
    }
    bridge
        .call_data("mcp.public.call", request, cancellation)
        .await
}

pub fn handler_failure(
    descriptor: &JsValue,
    message: &JsText,
    harness: &ResolvedHarness,
) -> JsValue {
    let name = field(field(descriptor, "nativeMcp"), "toolName")
        .as_text()
        .cloned()
        .unwrap_or_else(|| "".into());
    js_value!({"content":harness.render_text(TextId::ToolsMcpHandlerFailed, &[("tool", &name),("error", message)]),"isError":true})
}

/// Synchronous access to values that remain owned by the host for this formatting call.
pub trait ResultAccess {
    type Value: Copy;
    type Iterator;
    type Error;
    fn get(
        &mut self,
        value: Self::Value,
        name: &str,
    ) -> std::result::Result<Self::Value, Self::Error>;
    fn truthy(&self, value: Self::Value) -> std::result::Result<bool, Self::Error>;
    fn nullish(&self, value: Self::Value) -> std::result::Result<bool, Self::Error>;
    fn is_string(&self, value: Self::Value) -> std::result::Result<bool, Self::Error>;
    fn text(&self, value: Self::Value) -> std::result::Result<JsText, Self::Error>;
    fn string_length(&self, value: Self::Value) -> std::result::Result<usize, Self::Error>;
    fn stringify(
        &mut self,
        value: Option<Self::Value>,
    ) -> std::result::Result<Self::Value, Self::Error>;
    fn iterate(
        &mut self,
        value: Option<Self::Value>,
    ) -> std::result::Result<Self::Iterator, Self::Error>;
    fn next(
        &mut self,
        iterator: &mut Self::Iterator,
    ) -> std::result::Result<Option<Self::Value>, Self::Error>;
    fn close_iterator(&mut self, iterator: &mut Self::Iterator, error: Self::Error) -> Self::Error;
}

pub enum ErrorFlag<V> {
    Boolean(bool),
    Original(V),
}
pub struct FormattedResult<V> {
    pub content: JsText,
    pub is_error: ErrorFlag<V>,
    pub images: Vec<(V, V)>,
}
enum TextPart<V> {
    Text(JsText),
    Original(V),
}

fn is_text<A: ResultAccess>(
    access: &A,
    value: A::Value,
    expected: &str,
) -> std::result::Result<bool, A::Error> {
    Ok(access.is_string(value)? && access.text(value)?.as_utf8() == Some(expected))
}

fn format_block<A: ResultAccess>(
    access: &mut A,
    block: A::Value,
    parts: &mut Vec<TextPart<A::Value>>,
    images: &mut Vec<(A::Value, A::Value)>,
    harness: &ResolvedHarness,
) -> std::result::Result<(), A::Error> {
    let kind = access.get(block, "type")?;
    if is_text(access, kind, "text")? {
        let text = access.get(block, "text")?;
        if access.is_string(text)? {
            parts.push(TextPart::Original(access.get(block, "text")?));
            return Ok(());
        }
    }
    let kind = access.get(block, "type")?;
    if !is_text(access, kind, "image")? {
        parts.push(TextPart::Original(access.stringify(Some(block))?));
        return Ok(());
    }
    let mime = access.get(block, "mimeType")?;
    let data = access.get(block, "data")?;
    if !access.is_string(data)? {
        let supplied = (!access.nullish(mime)?).then_some(mime);
        let encoded = access.stringify(supplied)?;
        parts.push(TextPart::Text(harness.render_text(
            TextId::ToolsMcpImageMissingData,
            &[("mime", &access.text(encoded)?)],
        )));
        tracing::warn!("MCP image rejected: missing data");
        return Ok(());
    }
    let data = access.get(block, "data")?;
    let bytes = if access.string_length(data)? <= super::MAX_MCP_IMAGE_BASE64_CHARS {
        let data = access.get(block, "data")?;
        let text = access.text(data)?;
        super::decoded_image_bytes(text.len(), text.units())
    } else {
        None
    };
    let mime_text = if access.is_string(mime)? {
        access.text(mime)?
    } else {
        "".into()
    };
    if !mime_text.as_utf8().is_some_and(super::supported_image_mime) {
        let supplied = (!access.nullish(mime)?).then_some(mime);
        let encoded = access.stringify(supplied)?;
        parts.push(TextPart::Text(harness.render_text(
            TextId::ToolsMcpImageInvalidMime,
            &[("mime", &access.text(encoded)?)],
        )));
        tracing::warn!("MCP image rejected: unsupported MIME type");
        return Ok(());
    }
    let data = access.get(block, "data")?;
    if access.string_length(data)? > super::MAX_MCP_IMAGE_BASE64_CHARS
        || bytes.is_some_and(|bytes| bytes > super::MAX_MCP_IMAGE_BYTES)
    {
        parts.push(TextPart::Text(
            harness.render_text(TextId::ToolsMcpImageLimit, &[("mime", &mime_text)]),
        ));
        let data = access.get(block, "data")?;
        let _ = access.string_length(data)?;
        tracing::warn!("MCP image rejected: size limit");
    } else if bytes.is_none() {
        parts.push(TextPart::Text(harness.render_text(
            TextId::ToolsMcpImageInvalidBase64,
            &[("mime", &mime_text)],
        )));
        let data = access.get(block, "data")?;
        let _ = access.string_length(data)?;
        tracing::warn!("MCP image rejected: invalid base64");
    } else if images.len() >= super::MAX_MCP_IMAGES {
        parts.push(TextPart::Text(
            harness.text(TextId::ToolsMcpImageCount).into(),
        ));
        tracing::warn!("MCP image rejected: per-result count limit");
    } else {
        images.push((mime, access.get(block, "data")?));
        parts.push(TextPart::Text(
            harness.render_text(TextId::ToolsMcpImage, &[("mime", &mime_text)]),
        ));
    }
    Ok(())
}

pub fn format_public_result<A: ResultAccess>(
    descriptor: &JsValue,
    result: A::Value,
    access: &mut A,
    harness: &ResolvedHarness,
) -> std::result::Result<FormattedResult<A::Value>, A::Error> {
    let owned = field(descriptor, "nativeMcp");
    let registered = field(owned, "kind").as_text().and_then(JsText::as_utf8) == Some("registered");
    if !access.truthy(result)? {
        let name = field(owned, "toolName")
            .as_text()
            .cloned()
            .unwrap_or_else(|| "".into());
        let server = field(owned, "serverName")
            .as_text()
            .cloned()
            .unwrap_or_else(|| "".into());
        let content = if registered {
            harness.render_text(TextId::ToolsMcpEmptyResult, &[("tool", &name)])
        } else {
            harness.render_text(
                TextId::ToolsMcpToolNotFound,
                &[("tool", &name), ("server", &server)],
            )
        };
        return Ok(FormattedResult {
            content,
            is_error: ErrorFlag::Boolean(true),
            images: Vec::new(),
        });
    }
    let content = access.get(result, "content")?;
    let content = if registered && access.nullish(content)? {
        None
    } else {
        Some(content)
    };
    let error = access.get(result, "isError")?;
    let is_error = if access.nullish(error)? {
        ErrorFlag::Boolean(false)
    } else {
        ErrorFlag::Original(error)
    };
    let mut iterator = access.iterate(content)?;
    let mut parts = Vec::new();
    let mut images = Vec::new();
    while let Some(block) = access.next(&mut iterator)? {
        if let Err(error) = format_block(access, block, &mut parts, &mut images, harness) {
            return Err(access.close_iterator(&mut iterator, error));
        }
    }
    let mut text = crate::js::text::JsTextBuilder::with_capacity(0);
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            text.push_str("\n");
        }
        match part {
            TextPart::Text(part) => text.push_text(&part),
            TextPart::Original(value) if !access.nullish(value)? => {
                text.push_text(&access.text(value)?)
            }
            _ => {}
        }
    }
    Ok(FormattedResult {
        content: text.finish(),
        is_error,
        images,
    })
}

pub fn assert_unique(descriptors: &[Value]) -> Result<()> {
    let mut names = HashSet::new();
    for descriptor in descriptors {
        let name = descriptor["name"].as_str().unwrap_or("");
        if !names.insert(name) {
            tracing::warn!(name, "MCP tool identity collision");
            return Err(Error::template(
                "MCP_IDENTITY_COLLISION",
                TextId::ToolsMcpIdentityCollision,
                &[("name", name.into())],
            )
            .with_details(json!({"name":"McpToolIdentityError"})));
        }
    }
    Ok(())
}

pub async fn invoke(
    descriptor: &Value,
    input: Value,
    bridge: Arc<dyn HostBridge>,
    cancellation: &CancellationToken,
    harness: &ResolvedHarness,
) -> Result<Value> {
    let owned = &descriptor["nativeMcp"];
    let name = owned["toolName"].as_str().unwrap_or("");
    let server = owned["serverName"].as_str().unwrap_or("");
    let registered = owned["kind"] == "registered";
    let mut request = owned.clone();
    request["input"] = input;
    request["publicName"] = descriptor["name"].clone();
    let response = bridge.call("mcp.public.call", request, cancellation).await;
    let response = match response {
        Ok(response) => response,
        Err(error) if registered => {
            return Ok(failure(harness.render(
                TextId::ToolsMcpHandlerFailed,
                &[("tool", name), ("error", &error.render_for(harness))],
            )))
        }
        Err(error) => return Err(error),
    };
    if !crate::js::truthy(&response) {
        return Ok(failure(if registered {
            harness.render(TextId::ToolsMcpEmptyResult, &[("tool", name)])
        } else {
            harness.render(
                TextId::ToolsMcpToolNotFound,
                &[("tool", name), ("server", server)],
            )
        }));
    }
    Ok(super::format_result_with_harness(&response, harness))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    #[test]
    fn public_descriptors_match_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../fixtures/public-mcp-bridge.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let mut actual = descriptors(
                &JsValue::from_json(fixture["metadata"].clone()),
                &fixture["source"].as_str().unwrap().into(),
                &JsValue::from_json(fixture["definitions"].clone()),
                fixture["kind"].as_str().unwrap(),
            )
            .unwrap();
            for tool in &mut actual {
                tool.as_object_mut().unwrap().shift_remove("nativeMcp");
            }
            assert_eq!(
                crate::js::stringify(&JsValue::Array(actual).try_into_json().unwrap()),
                crate::js::stringify(&fixture["expected"])
            );
        }
        let duplicate=descriptors(&js_value!({"name":"server"}),&"source".into(),&js_value!([{"name":"a/b","description":"first","inputSchema":{}},{"name":"a.b","description":"second","inputSchema":{}}]),"sdk").unwrap_err();
        assert_eq!(duplicate.details.unwrap()["name"], "McpToolIdentityError");
    }
    struct Callback {
        result: Result<Value>,
    }
    #[async_trait]
    impl HostBridge for Callback {
        async fn call(&self, method: &str, params: Value, _: &CancellationToken) -> Result<Value> {
            assert_eq!(method, "mcp.public.call");
            assert_eq!(params["registrationId"], "original-handler");
            assert_eq!(params["input"], json!({"value":42}));
            self.result.clone()
        }
    }
    #[tokio::test]
    async fn public_sdk_and_registered_callbacks_preserve_error_contracts() {
        let harness = crate::harness::baseline();
        let make = |kind| json!({"name":"mcp__server__tool","nativeMcp":{"kind":kind,"serverName":"server","toolName":"tool","index":0,"registrationId":"original-handler"}});
        for (kind, expected) in [
            ("sdk", "MCP tool \"tool\" not found on server \"server\"."),
            ("registered", "MCP tool \"tool\" returned no result."),
        ] {
            let output = invoke(
                &make(kind),
                json!({"value":42}),
                Arc::new(Callback {
                    result: Ok(crate::js::undefined()),
                }),
                &CancellationToken::new(),
                &harness,
            )
            .await
            .unwrap();
            assert_eq!(output["content"], expected);
        }
        let callback = || {
            Arc::new(Callback {
                result: Err(Error::new("HOST_FAILURE", "original failure")),
            })
        };
        assert_eq!(
            invoke(
                &make("sdk"),
                json!({"value":42}),
                callback(),
                &CancellationToken::new(),
                &harness
            )
            .await
            .unwrap_err()
            .message,
            "original failure"
        );
        let output = invoke(
            &make("registered"),
            json!({"value":42}),
            callback(),
            &CancellationToken::new(),
            &harness,
        )
        .await
        .unwrap();
        assert_eq!(
            output["content"],
            "MCP tool \"tool\" failed: original failure"
        );
    }
}
