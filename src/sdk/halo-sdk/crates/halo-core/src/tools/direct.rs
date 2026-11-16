use super::{file, search, shell, shell_external, skill, web, ToolContext, WorkingState};
use crate::{
    bridge::{EventSink, HostBridge},
    error::{Error, Result},
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use tokio_util::sync::CancellationToken;

pub(super) fn execution_cancellation(
    name: &str,
    cancellation: CancellationToken,
) -> CancellationToken {
    if ["Bash", "Grep", "WebFetch", "TaskOutput", "TaskStop"].contains(&name) {
        cancellation
    } else {
        CancellationToken::new()
    }
}

pub struct DirectToolOwner {
    session_id: String,
    shell: OnceLock<Arc<shell::ShellTools>>,
    working: OnceLock<Arc<WorkingState>>,
    web: web::WebTool,
    processes: Arc<crate::processes::OwnedProcesses>,
    lifetime: CancellationToken,
    calls: Mutex<Vec<CancellationToken>>,
}

impl DirectToolOwner {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            shell: OnceLock::new(),
            working: OnceLock::new(),
            web: web::WebTool::default(),
            processes: Arc::new(crate::processes::OwnedProcesses::default()),
            lifetime: CancellationToken::new(),
            calls: Mutex::new(Vec::new()),
        }
    }
    fn shell(
        &self,
        context: &Value,
        activity: Option<Arc<crate::resource_activity::ResourceActivity>>,
    ) -> Arc<shell::ShellTools> {
        self.shell
            .get_or_init(|| {
                let mut options = context.clone();
                options["persistSession"] = json!(false);
                Arc::new(shell::ShellTools::new_with_activity(&options, activity))
            })
            .clone()
    }
    fn working(&self, context: &Value) -> Arc<WorkingState> {
        self.working
            .get_or_init(|| {
                let mut options = json!({"sessionId":self.session_id});
                for key in [
                    "nativeProcessEnv",
                    "nativeHomeDirectory",
                    "nativeTempDirectory",
                ] {
                    if let Some(value) = context.get(key) {
                        options[key] = value.clone();
                    }
                }
                Arc::new(WorkingState::new(&options))
            })
            .clone()
    }
    pub async fn execute(
        &self,
        implementation: String,
        input: Value,
        context: Value,
        bridge: Arc<dyn HostBridge>,
        events: Arc<dyn EventSink>,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_admitted(implementation, input, context, bridge, events, cancel, None)
            .await
    }
    pub async fn execute_admitted(
        &self,
        implementation: String,
        input: Value,
        mut context: Value,
        bridge: Arc<dyn HostBridge>,
        _events: Arc<dyn EventSink>,
        cancel: CancellationToken,
        admitted: Option<file::FileAdmission>,
    ) -> Result<Value> {
        if self.lifetime.is_cancelled() {
            return Err(Error::cancelled());
        }
        context["sessionId"] = json!(self.session_id);
        context["nativeReadDenyRoots"] = context["readDenyRoots"].clone();
        let cancellation = cancel.child_token();
        {
            let mut calls = self.calls.lock().unwrap_or_else(|error| error.into_inner());
            if self.lifetime.is_cancelled() {
                return Err(Error::cancelled());
            }
            calls.retain(|call| !call.is_cancelled());
            calls.push(cancellation.clone());
        }
        struct Call(CancellationToken);
        impl Drop for Call {
            fn drop(&mut self) {
                self.0.cancel();
            }
        }
        let _call = Call(cancellation.clone());
        let ctx = ToolContext {
            session_id: self.session_id.clone(),
            cwd: context["cwd"].as_str().unwrap_or("").into(),
            env: context.get("env").cloned().unwrap_or_else(|| json!({})),
            current_turn: context["currentTurn"].as_u64().unwrap_or(0) as u32,
            tool_use_id: context["toolUseId"].as_str().unwrap_or("").into(),
            cancellation: execution_cancellation(&implementation, cancellation),
            harness: crate::harness::Harness::from_config(&context["harnessText"])?
                .for_model(context["model"].as_str().unwrap_or("")),
        };
        let background =
            (context["nativeOwner"]["externalBackgroundTasks"] == true).then_some(&bridge);
        Ok(match implementation.as_str() {
            "Read" | "Write" | "Edit" => {
                file::FileTools::new(&context, bridge)
                    .execute_admitted(&implementation, &input, &ctx, admitted)
                    .await?
            }
            "Bash" => {
                self.shell(&context, bridge.resource_activity())
                    .execute_external(&input, ctx, &context, background)
                    .await
            }
            "TaskOutput" | "TaskStop" => {
                shell_external::task(&implementation, &input, &ctx, background).await?
            }
            "Glob" => search::glob(&input, &ctx, &file::deny_roots(&context)).await,
            "Grep" => {
                search::grep(
                    &input,
                    &ctx,
                    &file::deny_roots(&context),
                    self.processes.clone(),
                    &crate::core::conventions::process_environment(&context),
                )
                .await
            }
            "WebFetch" => self.web.execute(&input, &ctx, Some(bridge.as_ref())).await,
            "Skill" => {
                let catalog = match context
                    .get("skillCatalog")
                    .filter(|value| !crate::js::is_undefined(value))
                {
                    Some(catalog) => catalog.clone(),
                    None => {
                        crate::skills::resolve_catalog_with_harness(&context, &ctx.harness).await?
                    }
                };
                skill::execute(&catalog, &input, &ctx.harness).await
            }
            "Goal" => self
                .working(&context)
                .goal_with_harness(&input, &ctx.harness),
            "TodoWrite" => self
                .working(&context)
                .set_todos_with_harness(&input, &ctx.harness),
            "AskUserQuestion" => super::ask_user(&input, &ctx.harness),
            _ => super::failure(ctx.harness.render(
                crate::harness::TextId::ToolsUnknown,
                &[("name", &implementation)],
            )),
        })
    }
    pub fn abort_now(&self) {
        self.lifetime.cancel();
        self.web.close();
        for call in self
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain(..)
        {
            call.cancel();
        }
        self.processes.abort_now();
        if let Some(shell) = self.shell.get() {
            shell.abort_now();
        }
    }
    pub async fn close(&self) {
        self.abort_now();
        if let Some(shell) = self.shell.get() {
            shell.close().await;
        }
    }
}
impl Drop for DirectToolOwner {
    fn drop(&mut self) {
        self.abort_now();
    }
}
