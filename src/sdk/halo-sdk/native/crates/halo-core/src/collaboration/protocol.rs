use crate::harness::{baseline, ResolvedHarness, TextId};
use serde_json::{json, Value};

pub const LEAD: &str = "lead";
pub const SELF_NODE_ID: &str = "SELF";
pub const MAX_MESSAGES: usize = 2000;
pub const MAX_FORWARD_DEPTH: usize = 999;

pub fn member_address(member: &Value) -> String {
    if member["isLead"] == true {
        LEAD.into()
    } else if member["memberName"] == LEAD {
        member["appId"].as_str().unwrap_or("").into()
    } else {
        member["memberName"].as_str().unwrap_or("").into()
    }
}

pub fn session_key(app: &str, team: &str, epoch: &str) -> String {
    format!("app-chat:{app}:team:{team}:{epoch}")
}
pub fn parse_session_key(key: &str) -> Option<Value> {
    let fields: Vec<_> = key.split(':').collect();
    (fields.len() == 5 && fields[0] == "app-chat" && fields[2] == "team")
        .then(|| json!({"appId":fields[1],"teamId":fields[3],"epochId":fields[4]}))
}
pub fn coordinator_id(conversation: &str) -> String {
    format!("space-conv-{conversation}")
}
pub fn parse_coordinator_id(id: &str) -> Option<&str> {
    id.strip_prefix("space-conv-")
}
pub fn is_remote(member: &Value) -> bool {
    member["origin"] == "remote" && member["ownerNodeId"] != SELF_NODE_ID
}

pub fn activity_subject(text: &str, max: usize) -> String {
    activity_subject_with_harness(text, max, &baseline())
}
pub fn activity_subject_with_harness(text: &str, max: usize, harness: &ResolvedHarness) -> String {
    let first = text
        .split('\n')
        .find(|line| !crate::js::trim_js(line).is_empty())
        .unwrap_or("");
    let first = crate::js::trim_js(first);
    let collapsed = first
        .split(crate::js::is_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let units: Vec<_> = collapsed.encode_utf16().collect();
    if units.len() > max {
        harness.render(
            TextId::CollaborationActivityTruncated,
            &[(
                "message",
                &String::from_utf16_lossy(&units[..max.saturating_sub(1)]),
            )],
        )
    } else {
        collapsed
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn render_deliveries(
    deliveries: &[super::runtime::TeamDelivery],
    name: &str,
    name_of: impl Fn(&str) -> String,
) -> String {
    render_deliveries_with_harness(deliveries, name, name_of, &baseline())
}
pub fn render_deliveries_with_harness(
    deliveries: &[super::runtime::TeamDelivery],
    name: &str,
    name_of: impl Fn(&str) -> String,
    harness: &ResolvedHarness,
) -> String {
    deliveries
        .iter()
        .map(|delivery| {
            let envelope = &delivery.envelope;
            let from = envelope["fromAppId"]
                .as_str()
                .map(&name_of)
                .unwrap_or_else(|| harness.text(TextId::CollaborationDeliveryHostSender).into());
            harness.render(
                TextId::CollaborationDeliveryMemberMessage,
                &[
                    ("name", name),
                    ("sender", &from),
                    ("request", envelope["correlationId"].as_str().unwrap_or("")),
                    ("message", envelope["body"].as_str().unwrap_or("")),
                ],
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
