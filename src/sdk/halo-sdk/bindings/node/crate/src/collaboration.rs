use super::{decode, encode, failure};
use halo_core::collaboration::{self, artifacts, tool_contract};
use napi::{Error, Result, Status};
use napi_derive::napi;
use serde_json::{json, Value};
mod board;
mod callbacks;
pub(crate) use callbacks::Callbacks;
mod message_bus;
mod model_catalog;
mod runtime;
mod sdk;
mod store;
mod turn_gate;
mod workspaces;

#[napi]
pub struct NativeCollaborationValue;

#[napi]
impl NativeCollaborationValue {
    #[napi(constructor)]
    pub fn new(options: String) -> Result<Self> {
        decode(&options)?;
        Ok(Self)
    }

    #[napi]
    pub fn call(&self, name: String, payload: String) -> Result<String> {
        let input = decode(&payload)?;
        let value = match name.as_str() {
            "guidance" => json!(collaboration::guidance(&halo_core::harness::baseline())),
            "definitions" => json!(tool_contract::definitions()),
            "modelSelectionGuidance" => json!(tool_contract::model_selection_guidance(&input).map_err(failure)?),
            "planModelSelection" => collaboration::model_selection::plan_model_selection(&input).map_err(failure)?,
            "finalizeModelSelection" => collaboration::model_selection::finalize_model_selection(&input).map_err(failure)?,
            "queryModelProfiles" => collaboration::model_selection::query_model_profiles(&input).map_err(failure)?,
            "validateEffectiveReasoning" => collaboration::model_selection::validate_effective_reasoning(&input).map_err(failure)?,
            "validateModelSelectionRestore" => collaboration::model_selection::validate_model_selection_restore(&input).map_err(failure)?,
            "describeTool" => {
                let definitions = match input.get("modelSelection") {
                    Some(capability) => tool_contract::definitions_with_model_selection(&halo_core::harness::baseline(), capability).map_err(failure)?,
                    None => tool_contract::definitions(),
                };
                definitions.into_iter().find(|definition| definition["name"] == input["name"]).unwrap_or(Value::Null)
            },
            "parseInput" => tool_contract::parse_input_with_model_selection(
                input["name"].as_str().unwrap_or(""),
                input.get("input").unwrap_or(&Value::Null),
                input.get("modelSelection"),
            )
            .map_err(|error| failure(error.with_details(json!({"name":"TypeError"}))))?,
            "text" => tool_contract::text(
                input["text"].as_str().unwrap_or(""),
                input["isError"] == true,
            ),
            "feedback" => {
                let id = match input["kind"].as_str() {
                    Some("cancelled") => halo_core::harness::TextId::CollaborationFeedbackCancelled,
                    Some("invalid") => halo_core::harness::TextId::CollaborationArgumentsInvalid,
                    _ => halo_core::harness::TextId::CollaborationFeedbackOperationFailed,
                };
                json!(halo_core::harness::baseline().text(id))
            }
            "localSettings" => collaboration::local_settings(&input)
                .map_err(failure)?
                .unwrap_or(Value::Bool(false)),
            "appendPrompt" => collaboration::append_prompt(
                input.get("prompt").unwrap_or(&Value::Null),
                input["text"].as_str().unwrap_or(""),
            ),
            "resolvePublished" => artifacts::resolve_published(
                input["findings"].as_array().map_or(&[], Vec::as_slice),
                input["tasks"].as_array().map_or(&[], Vec::as_slice),
                input["ref"].as_str().unwrap_or(""),
            ),
            "conflictingPublisher" => artifacts::conflicting_publisher(
                input["findings"].as_array().map_or(&[], Vec::as_slice),
                input["tasks"].as_array().map_or(&[], Vec::as_slice),
                input["ref"].as_str().unwrap_or(""),
                input["claimantAppId"].as_str(),
            )
            .map(Value::String)
            .unwrap_or(Value::Null),
            "remapDeniedRoots" => {
                let workspace = serde_json::from_value(input["workspace"].clone())
                    .map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
                let roots = input["roots"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect::<Vec<_>>();
                json!(collaboration::workspaces::remap_denied_roots(
                    &roots, &workspace
                ))
            }
            "isPersonsOwnDelivery" => {
                json!(collaboration::message_bus::is_persons_own_delivery(&input))
            }
            "isRefusal" => json!(serde_json::from_value::<halo_core::error::Error>(input)
                .is_ok_and(|error| collaboration::is_refusal(&error))),
            "errorText" => {
                let harness = halo_core::harness::baseline();
                let name = input["name"].as_str().unwrap_or("");
                json!(match input["kind"].as_str() {
                    Some("member") => harness.render(
                        halo_core::harness::TextId::CollaborationDeliveryUnknownMember,
                        &[("name", name)]
                    ),
                    Some("contact") => harness.render(
                        halo_core::harness::TextId::CollaborationDeliveryContactForbidden,
                        &[("name", name)]
                    ),
                    _ => harness.render(
                        halo_core::harness::TextId::CollaborationMailboxFull,
                        &[("key", name)]
                    ),
                })
            }
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Unknown collaboration value operation: {name}"),
                ))
            }
        };
        encode(&value)
    }
}
