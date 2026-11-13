use crate::harness::TextId;
pub mod artifacts;
pub mod board_pages;
pub mod board_writes;
pub mod journal;
pub mod message_bus;
pub mod protocol;
pub mod runtime;
pub mod store;
pub mod tool_contract;
pub mod turn_gate;
pub mod workspaces;

pub use runtime::{
    CollaborationRuntime, MemberExecutionRequest, RuntimeOptions, SessionExecutor, SourceDelivery,
    TeamDelivery, TurnCompletion,
};

pub fn guidance(harness: &crate::harness::ResolvedHarness) -> &str {
    harness.text(crate::harness::TextId::CollaborationGuidance)
}

pub fn is_refusal(error: &crate::error::Error) -> bool {
    if let Some(name) = error
        .details
        .as_ref()
        .and_then(|details| details.get("name"))
        .and_then(serde_json::Value::as_str)
    {
        return name == "CollaborationRefusal"
            && error
                .details
                .as_ref()
                .is_some_and(|details| details["collaborationRefusal"] == true);
    }
    matches!(
        error.code.as_str(),
        "closed"
            | "member_missing"
            | "caller_stopped"
            | "execution_replaced"
            | "member_limit"
            | "reserved_name"
            | "target_stopped"
            | "stop_self"
            | "stop_forbidden"
            | "record_forbidden"
            | "task_forbidden"
            | "task_parent_scope"
            | "task_update_scope"
            | "artifact_owner"
            | "artifact_scope"
            | "artifact_denied"
            | "artifact_conflict"
            | "artifact_unavailable"
            | "board_archive_unavailable"
    )
}

pub fn local_settings(
    options: &serde_json::Value,
) -> crate::error::Result<Option<serde_json::Value>> {
    let selected = &options["collaboration"];
    if selected == false || selected["mode"] == "hosted" {
        return Ok(None);
    }
    if options["mcpServers"].get("halo-team").is_some() {
        if selected["mode"] == "local" {
            return Err(crate::error::Error::new("COLLABORATION_OWNER", "")
                .with_harness(TextId::CollaborationSetupOwnerConflict, &[]));
        }
        return Ok(None);
    }
    if selected["mode"] == "local" {
        return Ok(Some(selected.clone()));
    }
    if options["disallowedTools"].as_array().is_some_and(|tools| {
        tools.iter().any(|v| {
            matches!(
                v.as_str(),
                Some("Agent" | "spawn_agent" | "mcp__halo-team__spawn_agent")
            )
        })
    }) {
        return Ok(None);
    }
    if options["tools"]
        .as_array()
        .is_some_and(|tools| !tools.iter().any(|v| v == "spawn_agent"))
    {
        return Ok(None);
    }
    Ok(Some(serde_json::json!({})))
}

pub fn append_prompt(prompt: &serde_json::Value, text: &str) -> serde_json::Value {
    if let Some(prompt) = prompt.as_str() {
        return serde_json::Value::String(format!("{prompt}\n\n{text}"));
    }
    let mut result = serde_json::json!({"type":"preset","preset":"default"});
    if let Some(fields) = prompt.as_object() {
        result.as_object_mut().unwrap().extend(fields.clone());
    }
    result["append"] = crate::js::trim_js(&format!(
        "{}\n\n{text}",
        prompt["append"].as_str().unwrap_or("")
    ))
    .into();
    result
}

#[async_trait::async_trait]
pub trait CollaborationTools: Send + Sync {
    fn inherited(&self) -> bool {
        false
    }
    fn definitions(&self) -> Vec<serde_json::Value>;
    fn definitions_with_harness(
        &self,
        _harness: &crate::harness::ResolvedHarness,
    ) -> Vec<serde_json::Value> {
        self.definitions()
    }
    async fn call(
        &self,
        name: &str,
        input: serde_json::Value,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> crate::error::Result<serde_json::Value>;
    async fn call_with_harness(
        &self,
        name: &str,
        input: serde_json::Value,
        cancellation: &tokio_util::sync::CancellationToken,
        _harness: std::sync::Arc<crate::harness::ResolvedHarness>,
    ) -> crate::error::Result<serde_json::Value> {
        self.call(name, input, cancellation).await
    }
    fn is_readonly(&self, name: &str) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[test]
    fn source_and_child_prompts_match_recorded_provider_requests() {
        let expected: Value = serde_json::from_str(include_str!(
            "../harness/fixtures/collaboration-prompts.json"
        ))
        .unwrap();
        let harness = crate::harness::baseline();
        let base = json!("Base collaboration fixture.");
        assert_eq!(append_prompt(&base, guidance(&harness)), expected["root"]);
        let identity = harness.render(
            TextId::CollaborationIdentityChild,
            &[("name", "\"reader\""), ("guidance", guidance(&harness))],
        );
        assert_eq!(append_prompt(&base, &identity), expected["child"]);
    }
    #[test]
    fn an_external_error_code_does_not_claim_a_known_refusal_after_an_uncertain_write() {
        let error = crate::error::Error::new("task_forbidden", "The store failed after writing")
            .with_details(json!({"name":"Error"}));
        assert!(!is_refusal(&error));
        assert!(is_refusal(
            &crate::error::Error::new("task_forbidden", "")
                .with_harness(TextId::CollaborationFeedbackTaskForbidden, &[])
        ));
    }
}
