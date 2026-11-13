use crate::{
    error::Error,
    harness::{ResolvedHarness, TextId},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn replace_images(
    blocks: &mut [Value],
    harness: &ResolvedHarness,
    empty_only: bool,
    selected: Option<&HashSet<[u8; 32]>>,
) -> usize {
    let mut count = 0;
    for block in blocks {
        if block["type"] == "image" {
            if empty_only
                && !(block["source"]["type"] == "base64"
                    && block["source"]["data"]
                        .as_str()
                        .is_none_or(|text| text.trim().is_empty()))
            {
                continue;
            }
            if selected.is_some_and(|images| !images.contains(&image_digest(block))) {
                continue;
            }
            let cache = block.get("cache_control").cloned();
            *block = json!({"type":"text","text":harness.text(if empty_only { TextId::ContextImagesEmpty } else { TextId::ContextImagesUnavailable })});
            if let Some(cache) = cache {
                block["cache_control"] = cache;
            }
            count += 1;
        } else if block["type"] == "tool_result" {
            if let Some(content) = block["content"].as_array_mut() {
                count += replace_images(content, harness, empty_only, selected);
            }
        }
    }
    count
}

fn replace(
    messages: &mut [Value],
    harness: &ResolvedHarness,
    empty_only: bool,
    selected: Option<&HashSet<[u8; 32]>>,
) -> usize {
    messages
        .iter_mut()
        .filter_map(|message| message["content"].as_array_mut())
        .map(|blocks| replace_images(blocks, harness, empty_only, selected))
        .sum()
}

pub(crate) fn repair_empty(messages: &mut [Value], harness: &ResolvedHarness) -> usize {
    replace(messages, harness, true, None)
}

fn image_digest(image: &Value) -> [u8; 32] {
    match image["source"]["data"].as_str() {
        Some(data) => Sha256::digest(data.as_bytes()).into(),
        None => Sha256::digest(crate::js::stringify(&image["source"])).into(),
    }
}

fn record_images(messages: &[Value], images: &mut HashSet<[u8; 32]>) -> bool {
    fn record(blocks: &[Value], images: &mut HashSet<[u8; 32]>) -> bool {
        let mut changed = false;
        for block in blocks {
            if block["type"] == "image" {
                changed |= images.insert(image_digest(block));
            } else if block["type"] == "tool_result" {
                if let Some(content) = block["content"].as_array() {
                    changed |= record(content, images);
                }
            }
        }
        changed
    }
    let mut changed = false;
    for message in messages {
        if let Some(content) = message["content"].as_array() {
            changed |= record(content, images);
        }
    }
    changed
}

pub(crate) fn contains_images(messages: &[Value]) -> bool {
    fn contains(blocks: &[Value]) -> bool {
        blocks.iter().any(|block| {
            block["type"] == "image"
                || block["type"] == "tool_result"
                    && block["content"]
                        .as_array()
                        .is_some_and(|blocks| contains(blocks))
        })
    }
    messages.iter().any(|message| {
        message["content"]
            .as_array()
            .is_some_and(|blocks| contains(blocks))
    })
}

#[derive(Default)]
pub(crate) struct ImageInputState {
    unsupported_models: HashSet<String>,
    rejected_images: HashMap<String, HashSet<[u8; 32]>>,
    reported_models: HashSet<String>,
}

impl ImageInputState {
    pub(crate) fn project(
        &mut self,
        model: &str,
        supported: bool,
        messages: &mut [Value],
        harness: &ResolvedHarness,
        session: &str,
    ) {
        let count = self.project_for_request(model, supported, messages, harness);
        if count > 0 && self.reported_models.insert(model.into()) {
            tracing::warn!(session_id=session, model, image_count=count, "Images could not be delivered to this model; request contains explicit text notices");
        }
    }

    fn project_for_request(
        &self,
        model: &str,
        supported: bool,
        messages: &mut [Value],
        harness: &ResolvedHarness,
    ) -> usize {
        if !supported || self.unsupported_models.contains(model) {
            replace(messages, harness, false, None)
        } else if let Some(images) = self.rejected_images.get(model) {
            replace(messages, harness, false, Some(images))
        } else {
            0
        }
    }

    pub(crate) fn rejected(&mut self, model: &str, error: &Error, messages: &[Value]) -> bool {
        if !contains_images(messages)
            || !super::loop_failure::status(error)
                .is_some_and(|status| status == 400.0 || status == 422.0)
        {
            return false;
        }
        let text = error.message.to_lowercase();
        if !text.contains("image") {
            return false;
        }
        let invalid = [
            "image cannot be empty",
            "invalid image",
            "could not process image",
            "could not decode image",
            "unable to decode image",
            "invalid base64",
            "image format",
            "image type",
            "image dimensions",
        ]
        .iter()
        .any(|pattern| text.contains(pattern));
        if !invalid
            && [
                "unsupported image",
                "does not support image",
                "doesn't support image",
                "image input is not supported",
            ]
            .iter()
            .any(|pattern| text.contains(pattern))
        {
            return self.unsupported_models.insert(model.into());
        }
        if !invalid {
            return false;
        }
        record_images(
            messages,
            self.rejected_images.entry(model.into()).or_default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_history_repair_keeps_valid_images_and_tool_results() {
        let valid = json!({"type":"image","source":{"type":"base64","data":"valid-data"}});
        let mut messages = vec![
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"read","content":[{"type":"text","text":"File reference"},{"type":"image","source":{"type":"base64","data":""}},valid]}]}),
        ];
        assert_eq!(repair_empty(&mut messages, &crate::harness::baseline()), 1);
        assert_eq!(messages[0]["content"][0]["tool_use_id"], "read");
        assert_eq!(
            messages[0]["content"][0]["content"][0]["text"],
            "File reference"
        );
        assert_eq!(messages[0]["content"][0]["content"][2], valid);
    }

    #[test]
    fn explicit_image_rejection_is_bounded_and_model_scoped_without_erasing_history() {
        let original = vec![
            json!({"role":"user","content":[{"type":"image","source":{"type":"base64","data":"retained"}}]}),
        ];
        let mut state = ImageInputState::default();
        let failure = Error::new("PROVIDER_ERROR", "unsupported image")
            .with_details(json!({"statusCode":400}));
        assert!(state.rejected("text-model", &failure, &original));
        assert!(!state.rejected("text-model", &failure, &original));
        let mut request = original.clone();
        state.project(
            "text-model",
            true,
            &mut request,
            &crate::harness::baseline(),
            "fixture",
        );
        assert!(!contains_images(&request));
        assert!(contains_images(&original));
        let mut vision = original.clone();
        state.project(
            "vision-model",
            true,
            &mut vision,
            &crate::harness::baseline(),
            "fixture",
        );
        assert_eq!(vision, original);
        let auth = Error::new("PROVIDER_ERROR", "unsupported image")
            .with_details(json!({"statusCode":401}));
        assert!(!state.rejected("other-model", &auth, &original));
    }

    #[test]
    fn invalid_image_content_does_not_disable_new_images_for_the_same_model() {
        let original = vec![
            json!({"role":"user","content":[{"type":"image","source":{"type":"base64","data":"rejected-data"}}]}),
        ];
        let valid = json!({"type":"image","source":{"type":"base64","data":"new-valid-data"}});
        let failure = Error::new("PROVIDER_ERROR", "unsupported image format")
            .with_details(json!({"statusCode":400}));
        let mut state = ImageInputState::default();
        assert!(state.rejected("fixture", &failure, &original));
        assert!(!state.rejected("fixture", &failure, &original));
        let mut request = original.clone();
        request[0]["content"]
            .as_array_mut()
            .unwrap()
            .push(valid.clone());
        assert_eq!(
            state.project_for_request("fixture", true, &mut request, &crate::harness::baseline()),
            1
        );
        assert_eq!(request[0]["content"][1], valid);
        assert_eq!(original[0]["content"][0]["source"]["data"], "rejected-data");
    }
}
