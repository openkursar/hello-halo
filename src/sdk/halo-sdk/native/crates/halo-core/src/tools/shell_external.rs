use super::{failure, success, ToolContext};
use crate::{
    bridge::HostBridge,
    error::{Error, Result},
    harness::TextId,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

async fn call(
    bridge: &Arc<dyn HostBridge>,
    method: &str,
    args: Value,
    _ctx: &ToolContext,
) -> Result<Value> {
    bridge
        .call(
            "direct.background",
            json!({"method":method,"args":args}),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
}

pub(super) async fn start(
    command: &str,
    state: Value,
    input: &Value,
    ctx: &ToolContext,
    bridge: Option<&Arc<dyn HostBridge>>,
) -> Value {
    let harness = &ctx.harness;
    let Some(bridge) = bridge else { return failure(harness.text(TextId::ToolsShellServicesRequired)); };
    let timeout = input
        .get("timeout")
        .filter(|value| !crate::js::is_undefined(value))
        .map(|_| super::shell::command_timeout(input));
    let mut request = json!({"command":command,"state":state,"fallbackCwd":ctx.cwd,"env":ctx.env});
    if let Some(timeout) = timeout {
        request["timeoutMs"] = json!(timeout);
    }
    let task = match call(bridge, "start", json!([request]), ctx).await {
        Ok(task) => task,
        Err(error) => {
            return failure(harness.render(
                TextId::ToolsShellBackgroundStartFailed,
                &[("error", &error.render_for(harness))],
            ))
        }
    };
    let id = crate::js::to_string(&task["id"]);
    let path = crate::js::to_string(task.get("outputFile").unwrap_or(&crate::js::undefined()));
    let metadata = json!({"task_id":task["id"],"output_file":task.get("outputFile").cloned().unwrap_or_else(crate::js::undefined)});
    if task["status"] == "failed" {
        let mut result = failure(harness.render(
            TextId::ToolsShellBackgroundLaunchFailed,
            &[
                ("id", &id),
                (
                    "error",
                    &crate::js::to_string(task.get("error").unwrap_or(&crate::js::undefined())),
                ),
            ],
        ));
        result["metadata"] = metadata;
        return result;
    }
    success(
        harness.render(
            TextId::ToolsShellBackgroundStarted,
            &[
                (
                    "warning",
                    &if crate::js::truthy(&task["cwdWarning"]) {
                        format!("{}\n", crate::js::to_string(&task["cwdWarning"]))
                    } else {
                        String::new()
                    },
                ),
                ("id", &id),
                ("path", &path),
                (
                    "deadline",
                    &timeout
                        .map(|value| {
                            harness.render(
                                TextId::ToolsShellDeadline,
                                &[("timeout", &value.to_string())],
                            )
                        })
                        .unwrap_or_else(|| harness.text(TextId::ToolsShellNoDeadline).into()),
                ),
            ],
        ),
        Some(metadata),
    )
}

fn instant(value: &Value, _ctx: &ToolContext) -> Result<String> {
    crate::js::number(value)
        .filter(|value| value.is_finite())
        .and_then(|value| chrono::DateTime::from_timestamp_millis(value.trunc() as i64))
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| {
            Error::template("INVALID_TASK_TIME", TextId::ToolsShellInvalidTime, &[])
                .with_details(json!({"name":"RangeError"}))
        })
}

pub(super) async fn task(
    name: &str,
    input: &Value,
    ctx: &ToolContext,
    bridge: Option<&Arc<dyn HostBridge>>,
) -> Result<Value> {
    let harness = &ctx.harness;
    let Some(id) = input["task_id"].as_str().filter(|id| !id.is_empty()) else { return Ok(failure(harness.text(TextId::ToolsShellMissingTaskId))); };
    let Some(bridge) = bridge else { return Ok(failure(harness.render(TextId::ToolsShellTaskNotFound,&[("id",id)]))); };
    let entry = call(bridge, "get", json!([id]), ctx).await?;
    if !crate::js::truthy(&entry) {
        return Ok(failure(
            harness.render(TextId::ToolsShellTaskNotFound, &[("id", id)]),
        ));
    }
    if name == "TaskStop" {
        if entry["status"] != "running" {
            return Ok(failure(harness.render(
                TextId::ToolsShellTaskNotRunning,
                &[
                    ("id", id),
                    ("status", &crate::js::to_string(&entry["status"])),
                ],
            )));
        }
        if !crate::js::truthy(&call(bridge, "stop", json!([id]), ctx).await?) {
            return Ok(failure(
                harness.render(TextId::ToolsShellStopFailed, &[("id", id)]),
            ));
        }
        return Ok(success(
            crate::js::stringify_pretty(
                &json!({"message":harness.text(TextId::ToolsShellStopRequested),"task_id":id}),
            ),
            None,
        ));
    }
    let outcome: Result<Value> = async {
        let reference = json!({"entryId":entry["nativeEntryId"],"id":id});
        if input["block"] != false && entry.get("completedAt") == Some(&Value::Null) {
            let timeout = crate::js::number(&input["timeout"]).filter(|number| number.is_finite()).unwrap_or(30000.).clamp(0.,600000.) as u64;
            tokio::select! {
                biased;
                _ = ctx.cancellation.cancelled() => return Ok(failure(harness.render(TextId::ToolsShellWaitCancelled,&[("id",id)]))),
                result = call(bridge,"wait",json!([reference]),ctx) => { result?; },
                _ = tokio::time::sleep(Duration::from_millis(timeout)) => {},
            }
        }
        let output = call(bridge,"readOutput",json!([reference]),ctx).await?;
        let entry = &output["entry"];
        let preview = &output["preview"];
        let ended = if crate::js::truthy(&entry["completedAt"]) { json!(instant(&entry["completedAt"],ctx)?) } else { Value::Null };
        let absent = crate::js::undefined();
        let property = |name| entry.get(name).cloned().unwrap_or_else(|| absent.clone());
        let nullable = |name| entry.get(name).filter(|value| !value.is_null() && !crate::js::is_undefined(value)).cloned().unwrap_or(Value::Null);
        Ok(success(crate::js::stringify_pretty(&json!({
            "retrieval_status":if entry.get("completedAt") == Some(&Value::Null) {"not_ready"} else {"success"},
            "task":{"task_id":property("id"),"type":"bash","description":property("command"),"status":property("status"),"result":preview.get("output").unwrap_or(&absent),"error":nullable("error"),"output_file":nullable("outputFile"),"truncated":preview.get("truncated").unwrap_or(&absent),"exit_code":property("exitCode"),"started_at":instant(&entry["startedAt"],ctx)?,"ended_at":ended}
        })),None))
    }.await;
    Ok(match outcome {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(task_id=id,error=%error,"task output retrieval failed");
            failure(harness.render(
                TextId::ToolsShellRetrievalFailed,
                &[("id", id), ("error", &error.render_for(harness))],
            ))
        }
    })
}
