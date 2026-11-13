use super::{
    collaboration_stream::{CollaborationStream, Continuation},
    command_runtime::{self, ActorState, InputOutcome},
    hooks,
    loop_owner::{LoopExecution, LoopOwner},
    loop_runtime::{id, select_model, thinking, LoopContext},
    token_budget::TokenBudget,
};
use crate::{
    bridge::EventSink,
    error::Result,
    history::{read_report_with_harness, resume_error, transcript_path, Journal},
    llm::provider::Provider,
    session::NativeSession,
    tools::ToolRuntime,
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub async fn run(session: Arc<NativeSession>) -> Result<()> {
    let mut options = session.options.clone();
    options["sessionId"] = json!(session.session_id);
    if options["nativeOwnershipBridge"] == true && options["nativeQuery"] != true {
        let lease=crate::bridge::HostBridge::call(session.as_ref(),"ownership.acquire",json!({"path":transcript_path(&session.session_id,&options),"sessionId":session.session_id}),&session.lifetime).await?;
        *session.ownership.lock().unwrap() = Some(lease);
    }
    let provider = Provider::new(&options, session.clone())?;
    let resolved_harness = session
        .harness
        .for_model(options["model"].as_str().unwrap());
    let mut tools = ToolRuntime::new_with_working_state(
        options.clone(),
        session.clone(),
        session.clone(),
        session.prepared_working.clone(),
    );
    tools.set_harness(resolved_harness.clone());
    if let Some(binding) = &session.inherited_collaboration {
        tools.attach_collaboration(binding.clone());
    } else if let Some(settings) = crate::collaboration::local_settings(&options)? {
        let owner = super::collaboration_adapter::SdkCollaboration::new(
            Arc::downgrade(&session),
            options.clone(),
            settings,
        )?;
        tools.attach_collaboration(owner.clone());
        session.set_execution_budget(owner.budget.clone());
        *session.owned_collaboration.lock().unwrap() = Some(owner);
    }
    if let Some(checkpoint) = &session.working_checkpoint {
        tools.restore_working_state(checkpoint)?;
    }
    if let Some(mcp) = &session.borrowed_mcp {
        tools.attach_borrowed_mcp(mcp.clone());
    }
    if let Some(search) = &session.borrowed_search {
        tools.attach_borrowed_search(search.clone());
    }
    if let Some(roots) = options["nativeReadDenyRoots"].as_array() {
        tools.attach_read_deny_floor(
            &roots
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        );
    }
    if let Err(error) = tools.initialize(&session.lifetime).await {
        if let Err(cleanup) = tools.close().await {
            tracing::warn!(code=%cleanup.code,"Failed session preparation cleanup");
        }
        if let Err(cleanup) = tools.process_retirement().force_reap().await {
            tracing::warn!(code=%cleanup.code,"Failed session preparation process retirement");
        }
        return Err(error);
    }
    if session.prepared_working.is_none()
        && session.working_checkpoint.is_none()
        && tools.get_goal().is_null()
    {
        if let Some(goal) = options.get("goal").filter(|goal| crate::js::truthy(goal)) {
            tools.set_goal(goal.clone())?;
        }
    }
    let tools = Arc::new(tools);
    *session.tools.lock().unwrap() = Some(tools.clone());
    if session.owned_collaboration.lock().unwrap().is_some()
        && tools
            .definitions()
            .iter()
            .any(|tool| tool["name"] == "mcp__halo-team__spawn_agent")
    {
        options["nativeLocalCollaboration"] = json!(true);
    }
    if options["nativeQuery"] == true && crate::js::truthy(&options["continue"])
        && !crate::js::truthy(&options["resume"])
    {
        if let Some(resume) = crate::history::latest_session(&options).await {
            tracing::info!(session_id = %resume, "Query continues the latest saved session");
            options["resume"] = json!(resume);
        }
    }
    let mut messages = options["nativeCheckpoint"]["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if messages.is_empty() {
        if let Some(resume) = options["resume"].as_str() {
            match read_report_with_harness(
                &transcript_path(resume, &options),
                options["resumeSessionAt"].as_str(),
                &resolved_harness,
            )
            .await
            {
                Ok(report) => {
                    if !report.anchor_found
                        || report.tool_context_damaged
                        || (options["strictResume"] == true && report.damaged > 0)
                    {
                        return Err(resume_error("incomplete"));
                    }
                    if report.messages.is_empty() && options["strictResume"] == true {
                        return Err(resume_error("unreadable"));
                    }
                    let (repaired, changes) =
                        super::messages::repair_with_harness(&report.messages, &resolved_harness);
                    if options["strictResume"] == true
                        && (changes.late_results > 0 || changes.duplicate_calls > 0)
                    {
                        return Err(resume_error("incomplete"));
                    }
                    messages = repaired;
                }
                Err(error) if options["strictResume"] == true => return Err(error),
                Err(error) => {
                    tracing::warn!(session_id=%session.session_id, code=%error.code, "Resume history unavailable; starting without history")
                }
            }
        }
    }
    options
        .as_object_mut()
        .unwrap()
        .shift_remove("nativeCheckpoint");
    let mut journal = Journal::new(&session.session_id, &options).await?;
    *session.transcript.lock().unwrap() = Some(journal.clone());
    let legacy = options["resume"].is_string()
        && !messages
            .iter()
            .any(|message| message.get("toolContext").is_some());
    let initial_tool_revision=tools.tool_catalog_revision();
    let initial_catalog:Vec<_>=tools.selected_tools().iter().map(crate::tools::SelectedTool::catalog_entry).collect();
    let mut discovery = super::tool_context::prepare_with_harness(
        &options,
        &initial_catalog,
        &messages,
        legacy,
        resolved_harness.clone(),
    )?
    .map(|state| Arc::new(Mutex::new(state)));
    if discovery.is_some() {
        journal.set_tool_context_mode().await;
    }
    if !messages.is_empty()
        && (options["forkSession"] == true || options.get("resumeSessionAt").is_some())
    {
        journal
            .checkpoint(
                &messages,
                "History retained at the selected session boundary.",
            )
            .await?;
    }
    let mut environment = if options["systemPrompt"].is_string(){json!({})}else{crate::prompt::probe_environment(&options).await};
    environment["tools"] = json!(tools.definitions());
    let model = options["model"].as_str().unwrap().to_owned();
    let mut context = LoopContext {
        environment,
        memory: Default::default(),
        skill_context: if tools
            .definitions()
            .iter()
            .any(|tool| tool["name"] == "Skill")
        {
            crate::prompt::skill_context::build_with_harness(
                &tools.skill_catalog_with_harness(&resolved_harness),
                &resolved_harness,
            )
        } else {
            None
        },
        compaction: Default::default(),
        image_input: Default::default(),
        tool_revision: initial_tool_revision,
        harness: resolved_harness,
        model: model.clone(),
        thinking: thinking(&options),
    };

    let window = options["contextWindow"]
        .as_f64()
        .filter(|n| *n > 0.0)
        .unwrap_or(200_000.0);
    let output = options["maxOutputTokens"]
        .as_f64()
        .filter(|n| *n > 0.0)
        .unwrap_or(16_384.0);
    let mut budget = TokenBudget::new(window, output);
    let mut execution = Arc::new(LoopExecution {
        session_id: session.session_id.clone(),
        harness: session.harness.clone(),
        cost: session.current_cost(),
        tool_context: session.tool_context.clone(),
        api_time_ms: session.api_time_ms.clone(),
        turn_count: session.turn_count.clone(),
        permission_denials: session.permission_denials.clone(),
        lifetime: session.lifetime.clone(),
        bridge: session.clone(),
        events: session.clone(),
        owner: Arc::new(SessionLoopOwner {
            session: session.clone(),
            journal: journal.clone(),
        }),
    });
    let hook_options = options.clone();
    let hook_session = session.clone();
    let startup_lease=session.execution_lease();
    let startup = crate::runtime::spawn(async move {
        let _lease=startup_lease;
        let mut input = hooks::input(&hook_options, "SessionStart", &hook_session.session_id);
        input["source"] = json!(if hook_options["resume"].is_string() {
            "resume"
        } else {
            "startup"
        });
        if hook_options["nativeQuery"] != true {
            hooks::run(
                &hook_options,
                "SessionStart",
                input,
                None,
                None,
                hook_session.as_ref(),
                &hook_session.lifetime,
            )
            .await;
        }
    });
    session
        .controls
        .prepare(
            &options,
            &tools,
            session.as_ref(),
            &session.lifetime,
            &context.harness,
        )
        .await?;
    if let Some(owner) = session.owned_collaboration.lock().unwrap().as_ref() {
        owner.update_options(session.controls.options(&session.options));
    }
    session
        .envelope(json!({"kind":"ready","sessionId":session.session_id}))
        .await?;
    session.preparation_delivered().await?;
    let result: Result<()> = async {
        loop {
            if session.lifetime.is_cancelled() { break; }
            {
                let mut commands = session.command_receiver.lock().await;
                while let Ok(command) = commands.try_recv() {
                    let mut state = ActorState { options:&options, tools:&tools, journal:&journal, budget:&mut budget, messages:&mut messages, discovery:&discovery, context:&mut context, manual:Some((&execution,&provider)), compacted:None };
                    let outcome = state.command(&command.name, &command.payload, &session, &session.lifetime).await;
                    let _ = command.result.send(outcome);
                }
            }
            if !session.has_pending_input() || !session.stream_requested() {
                tokio::select! { _ = session.lifetime.cancelled() => break, _ = session.wake.notified() => {} }
                continue;
            }
            let Some(cancellation) = session.begin_turn() else { continue; };
            let collaboration = session.owned_collaboration.lock().unwrap().clone();
            let mut combined = collaboration.as_ref().map(|_| CollaborationStream::new());
            loop {
                let start = Instant::now();
                if options["nativeQuery"] != true { session.controls.apply(&mut options); }
                select_model(&execution, &options, &tools, &mut context, &mut super::loop_budget::LoopBudget::Borrowed(&mut budget));
                if !admit_iteration(&session, &mut combined, collaboration.as_ref(), &cancellation, json!({"type":"system","subtype":"session_state_changed","state":"running","session_id":session.session_id,"uuid":id()})).await? { break; }
                let payloads = drain_payloads(&session, &options).await?;
                if options["nativeQuery"] != true { session.controls.apply(&mut options); select_model(&execution, &options, &tools, &mut context, &mut super::loop_budget::LoopBudget::Borrowed(&mut budget)); }
                if payloads.is_empty() {
                    if finish_iteration(&session, &mut combined, collaboration.as_ref(), &cancellation, true).await? { continue; }
                    break;
                }
                let mut run=execution.as_ref().clone();run.cost=session.start_cost_run(&options);execution=Arc::new(run);
                session.api_time_ms.store(0,std::sync::atomic::Ordering::Relaxed);
                let input = {
                    let mut state = ActorState {options:&options,tools:&tools,journal:&journal,budget:&mut budget,messages:&mut messages,discovery:&discovery,context:&mut context,manual:Some((&execution,&provider)),compacted:None};
                    command_runtime::intercept(&session, payloads, &mut state, &cancellation).await?
                };
                let no_result = match input {
                    InputOutcome::Local {markdown,is_error} => {
                        let current = if options["nativeQuery"] == true { options.clone() } else { session.controls.options(&options) };
                        for event in command_runtime::local_events(&session,&current,&tools,&markdown,is_error,&execution,start) {
                            if cancellation.is_cancelled() && event["subtype"] == "init" { continue; }
                            if event["type"] == "result" && event["modelUsage"].as_object().is_some_and(|usage| !usage.is_empty()) && options["nativeQuery"] != true { session.controls.record_result(&event); }
                            emit_outer(&session,&mut combined,event).await?;
                        }
                        false
                    }
                    InputOutcome::Continue(payloads) => {
                        if options["nativeQuery"] != true { session.controls.apply(&mut options); select_model(&execution, &options, &tools, &mut context, &mut super::loop_budget::LoopBudget::Borrowed(&mut budget)); }
                        append_inputs(payloads, &mut messages, &mut journal, &discovery).await?;
                        let mut definitions = tools.definitions();
                        if discovery.as_ref().is_some_and(|state|state.lock().unwrap().enabled()) { definitions.push(super::tool_context::state::definitions_with_harness(&context.harness).0); }
                        let commands = session.controls.supported_commands(&context.harness);
                        let skills = options.get("skills").filter(|skills| !skills.is_null() && !crate::js::is_undefined(skills)).cloned()
                            .unwrap_or_else(|| json!(tools.skill_catalog_with_harness(&context.harness).as_array().into_iter().flatten().map(|skill| &skill["name"]).collect::<Vec<_>>()));
                        let mut init = json!({"type":"system","subtype":"init","session_id":session.session_id,"tools":definitions.iter().map(|tool| &tool["name"]).collect::<Vec<_>>(),
                            "model":options["model"],"cwd":options["cwd"],"permissionMode":options["permissionMode"].as_str().unwrap_or("default"),"mcp_servers":tools.mcp_statuses(),
                            "slash_commands":commands.iter().map(|command| &command["name"]).collect::<Vec<_>>(),"skills":skills,"apiKeySource":"user","sdk_version":"1.0.0","uuid":id()});
                        if let Some(betas)=options.get("betas").filter(|value|!crate::js::is_undefined(value)){init["betas"]=betas.clone();}
                        if !admit_iteration(&session, &mut combined, collaboration.as_ref(), &cancellation, init).await? { break; }
                        session.permission_denials.lock().unwrap().clear();
                        session.turn_count.store(0,std::sync::atomic::Ordering::Relaxed);
                        session.api_time_ms.store(0,std::sync::atomic::Ordering::Relaxed);
                        let completed = combined.as_ref().map_or(0,CollaborationStream::completed_turns);
                        let outcome = super::loop_runtime::turn(&execution,&options,&mut context,&tools,&provider,&mut messages,&mut super::loop_budget::LoopBudget::Borrowed(&mut budget),cancellation.clone(),completed,&mut discovery).await;
                        let terminal=outcome.is_err();
                        if cancellation.is_cancelled(){tools.interrupt().await;}
                        let mut event=super::loop_runtime::conclude(&execution,outcome,&context,start,&cancellation).await?;
                        let no_result = event.is_none();
                        if let Some(event) = &mut event { event["permission_denials"] = json!(*session.permission_denials.lock().unwrap()); }
                        if session.lifetime.is_cancelled() { break; }
                        if let Some(event) = event {
                            if combined.is_none() && options["nativeQuery"] != true { session.controls.record_result(&event); }
                            emit_outer(&session, &mut combined, event).await?;
                            if terminal{super::loop_runtime::terminal_hooks(&execution,&options,&context.harness,&cancellation).await;}
                        }
                        no_result
                    }
                };
                if session.lifetime.is_cancelled() { break; }
                #[cfg(test)]
                if let Some(observer) = session.iteration_observer.lock().unwrap().as_ref() {
                    let _ = observer.send(messages.clone());
                }
                if !finish_iteration(&session, &mut combined, collaboration.as_ref(), &cancellation, no_result).await? { break; }
            }
            session.end_turn();
        }
        Ok(())
    }.await;
    session.end_turn();
    if let Err(error) = startup.await {
        tracing::warn!(session_id=%session.session_id,error=%error,"SessionStart hook failed");
    }
    let mut input = hooks::input(&options, "SessionEnd", &session.session_id);
    input["reason"] = json!("other");
    if options["nativeQuery"] != true {
        hooks::run(
            &options,
            "SessionEnd",
            input,
            None,
            None,
            session.as_ref(),
            &session.end_hook_cancellation,
        )
        .await;
    }
    journal.flush().await?;
    result
}

#[cfg(test)]
#[path = "engine/collaboration_tests.rs"]
mod collaboration_tests;

#[cfg(test)]
#[path = "engine/persistence_tests.rs"]
mod persistence_tests;

#[cfg(test)]
#[path = "engine/discovery_append_tests.rs"]
mod discovery_append_tests;

#[cfg(test)]
#[path = "engine/history_lifecycle_tests.rs"]
mod history_lifecycle_tests;

async fn emit_outer(
    session: &NativeSession,
    combined: &mut Option<CollaborationStream>,
    event: Value,
) -> Result<()> {
    if session.options["nativeQuery"] == true
        && event["type"] == "system"
        && event["subtype"] == "session_state_changed"
    {
        return Ok(());
    }
    let event = match combined {
        Some(stream) => stream.accept(event),
        None => Some(event),
    };
    if let Some(event) = event {
        session.emit(event).await?;
    }
    Ok(())
}

async fn admit_iteration(
    session: &NativeSession,
    combined: &mut Option<CollaborationStream>,
    collaboration: Option<&Arc<super::collaboration_adapter::SdkCollaboration>>,
    cancellation: &CancellationToken,
    event: Value,
) -> Result<bool> {
    match emit_outer(session, combined, event).await {
        Ok(()) => Ok(true),
        Err(_) if cancellation.is_cancelled() && !session.lifetime.is_cancelled() => {
            finish_iteration(session, combined, collaboration, cancellation, true).await?;
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

async fn finish_iteration(
    session: &NativeSession,
    combined: &mut Option<CollaborationStream>,
    collaboration: Option<&Arc<super::collaboration_adapter::SdkCollaboration>>,
    cancellation: &CancellationToken,
    no_result: bool,
) -> Result<bool> {
    if combined.is_none() {
        session.end_stream();
        if no_result && session.options["nativeQuery"] == true {
            session.envelope(json!({"kind":"streamEnd"})).await?;
        }
    }
    emit_outer(session, combined, json!({"type":"system","subtype":"session_state_changed","state":"idle","session_id":session.session_id,"uuid":id()})).await?;
    if let (Some(owner), Some(stream)) = (collaboration, combined.as_ref()) {
        match stream.after_run(owner, session, cancellation).await? {
            Continuation::Run => return Ok(true),
            Continuation::Finish => {
                session.end_stream();
                let events = combined
                    .take()
                    .unwrap()
                    .finish(owner.drain_usage(), cancellation.is_cancelled());
                let has_result = events.iter().any(|event| event["type"] == "result");
                for event in events {
                    if session.options["nativeQuery"] != true
                        && event["type"] == "result"
                        && (event["num_turns"].as_u64().unwrap_or(0) > 0
                            || event["modelUsage"]
                                .as_object()
                                .is_some_and(|models| !models.is_empty()))
                    {
                        session.controls.record_result(&event);
                    }
                    session.emit(event).await?;
                }
                if !has_result && session.options["nativeQuery"] == true {
                    session.envelope(json!({"kind":"streamEnd"})).await?;
                }
            }
            Continuation::Closed => {}
        }
    }
    session.complete_stream().await?;
    Ok(false)
}

async fn drain_payloads(session: &NativeSession, options: &Value) -> Result<Vec<Value>> {
    let mut pending = Vec::new();
    loop {
        let batch = session.take_inputs();
        if batch.is_empty() {
            break;
        }
        for input in batch {
            session
                .envelope(json!({"kind":"inputConsumed","id":input.id}))
                .await?;
            let hook_options = session.controls.options(options);
            let payload = if options["nativeQuery"] == true {
                input.payload
            } else {
                hooks::prepare_input(
                    &hook_options,
                    input.payload,
                    &session.session_id,
                    session,
                    &session.lifetime,
                )
                .await
            };
            pending.push(payload);
        }
    }
    Ok(pending)
}
async fn append_inputs(
    payloads: Vec<Value>,
    messages: &mut Vec<Value>,
    journal: &Journal,
    discovery: &Option<Arc<Mutex<super::tool_context::State>>>,
) -> Result<()> {
    let mut pending: Vec<_> = payloads
        .into_iter()
        .map(|payload| {
            if payload.is_string() {
                json!({"role":"user","content":payload})
            } else {
                payload
            }
        })
        .collect();
    if pending.is_empty() {
        return Ok(());
    }
    let mut message = if pending.len() == 1 {
        pending.remove(0)
    } else if pending.iter().all(|message| message["content"].is_string()) {
        let content = pending
            .iter()
            .map(|message| message["content"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n\n");
        json!({"role":"user","content":content})
    } else {
        let mut blocks = Vec::new();
        for message in pending {
            if let Some(text) = message["content"].as_str() {
                blocks.push(json!({"type":"text","text":text}));
            } else if let Some(content) = message["content"].as_array() {
                blocks.extend(content.clone());
            }
        }
        json!({"role":"user","content":blocks})
    };
    let notice = discovery.as_ref().and_then(|state| {
        let state = state.lock().unwrap();
        state.baseline_pending.then(|| state.recovery_message())
    });
    if let Some(notice) = notice {
        if notice["content"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        {
            journal
                .append("user", notice.clone(), &id(), None, true)
                .await?;
            messages.push(notice);
        } else {
            message["toolContext"] = notice["toolContext"].clone();
            message["toolContext"]["baselineAttachment"] = json!(false);
        }
        if let Some(state) = discovery {
            state.lock().unwrap().baseline_pending = false;
        }
    }
    journal
        .append(
            "user",
            message.clone(),
            &id(),
            None,
            message.get("toolContext").is_some(),
        )
        .await?;
    messages.push(message);
    Ok(())
}

struct SessionLoopOwner {
    session: Arc<NativeSession>,
    journal: Journal,
}
#[async_trait::async_trait]
impl LoopOwner for SessionLoopOwner {
    async fn apply_controls(&self, options: &mut Value) -> Result<Option<u64>> {
        Ok((options["nativeQuery"] == true).then(|| self.session.controls.apply(options)))
    }
    async fn pending_usage(&self) -> Result<Value> {
        Ok(self
            .session
            .owned_collaboration
            .lock()
            .unwrap()
            .as_ref()
            .map(|owner| owner.drain_usage())
            .unwrap_or_else(|| json!({})))
    }
    async fn budget_spent(&self) -> Result<Option<f64>> {
        Ok(self
            .session
            .get_execution_budget()
            .map(|budget| budget.spent()))
    }
    fn replay_pending_input(&self) -> bool { self.session.options["nativeQuery"] == true }
    async fn pending_input(&self, options: &Value) -> Result<Option<Value>> {
        let payloads = drain_payloads(&self.session, options).await?;
        let mut messages = Vec::new();
        append_inputs(payloads, &mut messages, &self.journal, &None).await?;
        Ok(messages.pop())
    }
    async fn context_message(&self, message: &Value) -> Result<()> {
        self.journal
            .append("user", message.clone(), &id(), None, true)
            .await
    }
    async fn assistant_block(&self, frame: &Value, response_uuid: &str) -> Result<()> {
        let mut message = frame["message"].clone();
        message.as_object_mut().unwrap().shift_remove("usage");
        self.journal
            .append(
                "assistant",
                message,
                frame["uuid"].as_str().unwrap_or(""),
                Some(response_uuid),
                true,
            )
            .await
    }
    async fn assistant_message(&self, frame: &Value) -> Result<()> {
        let mut message = frame["message"].clone();
        if let Some(message) = message.as_object_mut() {
            message.shift_remove("content");
            message.shift_remove("toolContext");
        }
        let response = frame["uuid"].as_str().unwrap_or("");
        self.journal
            .append(
                "assistant_metadata",
                message,
                response,
                Some(response),
                false,
            )
            .await
    }
    async fn discarded_response(&self, frame: &Value) -> Result<()> {
        self.assistant_message(frame).await
    }
    async fn tool_result_message(&self, frame: &Value) -> Result<()> {
        self.journal
            .append(
                "user",
                frame["message"].clone(),
                frame["uuid"].as_str().unwrap_or(""),
                None,
                true,
            )
            .await
    }
    async fn compact(&self, messages: &[Value], summary: &str) -> Result<()> {
        self.journal.checkpoint(messages, summary).await
    }
}
