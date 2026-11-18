use super::{content_size, cost_report, mcp_report, number};
use crate::{
    error::Result,
    harness::{ResolvedHarness, ResourceId, TextId},
};
use serde_json::{json, Value};

pub struct Effect {
    pub method: &'static str,
    pub args: Vec<Value>,
    pub wait: bool,
}
pub struct Plan {
    pub effect: Option<Effect>,
    pub result: Value,
}
impl Plan {
    pub fn value(&self) -> Value {
        json!({"result":self.result,"effects":self.effect.iter().map(|effect|json!({"method":effect.method,"args":effect.args,"wait":effect.wait})).collect::<Vec<_>>()})
    }
}
pub fn fields(name: &str) -> &'static [&'static str] {
    match name {
        "model" => &["model"],
        "help" => &["commands"],
        "context" => &["model", "messages"],
        "cost" | "usage" => &["cost"],
        "mcp" => &["mcpServerStatuses"],
        "status" => &["sessionId", "model", "cwd", "messages", "mcpServerStatuses"],
        _ => &[],
    }
}
pub fn plan(
    name: &str,
    args: &str,
    snapshot: &Value,
    harness: &ResolvedHarness,
) -> Result<Option<Plan>> {
    let mut effect = None;
    let markdown = match name {
        "clear" => {
            effect = Some(Effect {
                method: "clearMessages",
                args: vec![],
                wait: true,
            });
            harness.text(TextId::CommandsLocalCleared).into()
        }
        "compact" => {
            let instructions =
                (!crate::js::trim_js(args).is_empty()).then(|| crate::js::trim_js(args).to_owned());
            effect = Some(Effect {
                method: "compactSession",
                args: vec![instructions
                    .clone()
                    .map(|value| json!(value))
                    .unwrap_or_else(crate::js::undefined)],
                wait: true,
            });
            instructions
                .map(|instructions| {
                    harness.render(
                        TextId::CommandsLocalCompactInstructions,
                        &[("instructions", &instructions)],
                    )
                })
                .unwrap_or_else(|| harness.text(TextId::CommandsLocalCompactStarted).into())
        }
        "model" => {
            let model = snapshot["model"].as_str().unwrap_or("");
            let target = crate::js::trim_js(args);
            if target.is_empty() {
                harness.render(TextId::CommandsLocalCurrentModel, &[("model", model)])
            } else {
                effect = Some(Effect {
                    method: "setModel",
                    args: vec![json!(target)],
                    wait: false,
                });
                harness.render(
                    TextId::CommandsLocalModelSwitched,
                    &[("model", model), ("target", target)],
                )
            }
        }
        "init" => {
            return Ok(Some(Plan {
                effect: None,
                result: harness.resource(ResourceId::CommandDefinitions)["initMessages"].clone(),
            }))
        }
        "help" => {
            let commands = snapshot["commands"].as_array().cloned().unwrap_or_default();
            let mut text = harness.text(TextId::CommandsLocalHelpHeading).to_owned();
            if commands.is_empty() {
                text.push_str(harness.text(TextId::CommandsLocalHelpEmpty));
            }
            for command in commands {
                let hint = command["argumentHint"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(" {s}"))
                    .unwrap_or_default();
                text.push_str(&harness.render(
                    TextId::CommandsLocalHelpEntry,
                    &[
                        ("name", command["name"].as_str().unwrap_or("")),
                        ("hint", &hint),
                        ("description", command["description"].as_str().unwrap_or("")),
                    ],
                ));
            }
            text
        }
        "context" => {
            let messages = snapshot["messages"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let chars: usize = messages.iter().map(|m| content_size(&m["content"])).sum();
            harness.render(
                TextId::CommandsLocalContext,
                &[
                    ("model", snapshot["model"].as_str().unwrap_or("")),
                    ("messages", &messages.len().to_string()),
                    ("characters", &number(chars as f64)),
                    ("tokens", &number((chars as f64 / 4.).round())),
                ],
            )
        }
        "mcp" => mcp_report(&snapshot["mcpServerStatuses"], false, harness),
        "status" => harness.render(
            TextId::CommandsLocalStatus,
            &[
                ("session", snapshot["sessionId"].as_str().unwrap_or("")),
                ("model", snapshot["model"].as_str().unwrap_or("")),
                ("cwd", snapshot["cwd"].as_str().unwrap_or("")),
                (
                    "messages",
                    &snapshot["messages"]
                        .as_array()
                        .map(Vec::len)
                        .unwrap_or(0)
                        .to_string(),
                ),
                (
                    "servers",
                    &mcp_report(&snapshot["mcpServerStatuses"], true, harness),
                ),
            ],
        ),
        "cost" => cost_report(&snapshot["cost"], false, harness),
        "usage" => cost_report(&snapshot["cost"], true, harness),
        _ => return Ok(None),
    };
    Ok(Some(Plan {
        effect,
        result: json!({"kind":"system","markdown":markdown}),
    }))
}
