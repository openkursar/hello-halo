use crate::{
    error::{Error, Result},
    js::{stringify, utf16_len},
};
use serde_json::Value;

const MAX_BASE64: usize = 20 * 1024 * 1024;
const MAX_BODY: usize = 24 * 1024 * 1024;

pub fn assert_image_request_budget(messages: &[Value]) -> Result<()> {
    fn visit(blocks: &[Value], count: &mut usize, total: &mut usize) -> Result<()> {
        for block in blocks {
            if block["type"] == "image" && block["source"]["type"] == "base64" {
                *count += 1;
                *total += utf16_len(block["source"]["data"].as_str().unwrap_or(""));
            } else if block["type"] == "tool_result" {
                if let Some(blocks) = block["content"].as_array() {
                    visit(blocks, count, total)?;
                }
            }
            if *total > MAX_BASE64 {
                tracing::error!(
                    image_count = *count,
                    base64_chars = *total,
                    limit = MAX_BASE64,
                    "Image request exceeds base64 payload budget"
                );
                return Err(Error::template(
                    "IMAGE_BUDGET",
                    crate::harness::TextId::ProvidersImagesPayloadBudget,
                    &[
                        ("limit", MAX_BASE64.to_string().into()),
                        ("count", count.to_string().into()),
                    ],
                ));
            }
        }
        Ok(())
    }
    let (mut count, mut total) = (0, 0);
    for message in messages {
        if let Some(blocks) = message["content"].as_array() {
            visit(blocks, &mut count, &mut total)?;
        }
    }
    Ok(())
}

pub fn assert_image_body_budget(body: &Value) -> Result<()> {
    fn has_image(value: &Value) -> bool {
        match value {
            Value::Array(values) => values.iter().any(has_image),
            Value::Object(values) => {
                value["type"] == "image"
                    || value["type"] == "image_url"
                    || values.values().any(has_image)
            }
            _ => false,
        }
    }
    if !body["messages"].is_array() || !has_image(&body["messages"]) {
        return Ok(());
    }
    let bytes = stringify(body).len();
    if bytes > MAX_BODY {
        tracing::error!(
            bytes,
            limit = MAX_BODY,
            "Image request exceeds serialized body budget"
        );
        return Err(Error::template(
            "IMAGE_BUDGET",
            crate::harness::TextId::ProvidersImagesBodyBudget,
            &[("limit", MAX_BODY.to_string().into())],
        ));
    }
    Ok(())
}
