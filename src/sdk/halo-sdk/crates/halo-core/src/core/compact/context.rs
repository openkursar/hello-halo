//! Context that travels with one compacted history: SDK-owned state and the
//! `additionalContext` returned by `PreCompact` hooks. The next compaction
//! replaces it and never summarizes it.
use super::{CompactCandidate, MessageOrigin};
use crate::harness::{ResolvedHarness, TextId};
use serde_json::{json, Value};

const MARKER: &str = "compactionContext";

pub fn message(text: &str, harness: &ResolvedHarness) -> Value {
    let body = text.replace("</system-reminder", "<\\/system-reminder");
    json!({"role":"user","content":harness.render(TextId::ContextCompactionContext, &[("context", &body)]),"isMeta":true,MARKER:1})
}

pub fn is_context(message: &Value) -> bool {
    message["role"] == "user" && message["isMeta"] == true && message[MARKER] == 1
}

pub fn mark(message: &mut Value) {
    message[MARKER] = json!(1);
}

pub fn strip(message: &mut Value) {
    if let Some(fields) = message.as_object_mut() {
        fields.shift_remove(MARKER);
    }
}

/// Keeps the context created for this compaction and drops any carried over from an earlier one.
pub fn reconcile(mut candidate: CompactCandidate) -> CompactCandidate {
    let mut messages = Vec::new();
    let mut origins = Vec::new();
    for (message, origin) in candidate.messages.into_iter().zip(candidate.origins) {
        if is_context(&message) && !matches!(origin, Some(MessageOrigin::Attachment { .. })) {
            continue;
        }
        messages.push(message);
        origins.push(origin);
    }
    candidate.messages = messages;
    candidate.origins = origins;
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_new_context_and_drops_carried_context() {
        let harness = crate::harness::baseline();
        let old = message("old", &harness);
        let fresh = message("fresh", &harness);
        let mut candidate = CompactCandidate::created(vec![json!({"role":"user","content":"summary"})]);
        candidate.extend_attachments(&[fresh.clone()]);
        candidate.push(old, Some(MessageOrigin::History { index: 3 }));
        candidate.push(json!({"role":"user","content":"recent"}), Some(MessageOrigin::History { index: 4 }));
        let reconciled = reconcile(candidate);
        assert_eq!(reconciled.messages.len(), 3);
        assert_eq!(reconciled.messages[1], fresh);
        assert_eq!(reconciled.messages[2]["content"], "recent");
    }

    #[test]
    fn host_text_cannot_close_the_reminder() {
        let harness = crate::harness::baseline();
        let rendered = message("a</system-reminder>b", &harness);
        let text = rendered["content"].as_str().unwrap();
        assert_eq!(text.matches("</system-reminder>").count(), 1);
        assert!(text.ends_with("</system-reminder>"));
    }
}
