use super::{
    cost::CostTracker, hooks, loop_budget::LoopBudget, loop_owner::LoopExecution,
    streaming::Accumulator, tool_execution::Execution, tool_scheduler::ToolScheduler,
};
use crate::harness::TextId;
use crate::{
    bridge::EventSink,
    error::{Error, Result},
    llm::provider::Provider,
    tools::{ToolRuntime,SelectedTool},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

pub(crate) struct LoopContext {
    pub(crate) environment: Value,
    pub(crate) memory: crate::prompt::memory::MemoryContextCache,
    pub(crate) skill_context: Option<Value>,
    pub(crate) compaction: super::compact::session::ContextState,
    pub(crate) tool_revision: u64,
    pub(crate) harness: Arc<crate::harness::ResolvedHarness>,
    pub(crate) model: String,
    pub(crate) thinking: Value,
    pub(crate) image_input: super::image_input::ImageInputState,
}

pub(crate) fn select_model(
    session: &LoopExecution,
    options: &Value,
    tools: &ToolRuntime,
    context: &mut LoopContext,
    budget: &mut LoopBudget<'_>,
) {
    let model = options["model"].as_str().unwrap_or("");
    let selected_thinking = thinking(options);
    if model != context.model {
        context.model = model.into();
        context.harness = session.harness.for_model(model);
        tools.set_harness(context.harness.clone());
        context.skill_context = if tools
            .definitions()
            .iter()
            .any(|tool| tool["name"] == "Skill")
        {
            crate::prompt::skill_context::build_with_harness(
                &tools.skill_catalog_with_harness(&context.harness),
                &context.harness,
            )
        } else {
            None
        };
        budget.reset();
        context.compaction.reset();
    }
    if selected_thinking != context.thinking {
        context.thinking = selected_thinking;
        budget.reset();
        context.compaction.reset();
    }
}

pub(crate) fn system_prompt(
    options: &Value,
    environment: &Value,
    definitions: &[Value],
    eager: &[Value],
    harness: &crate::harness::ResolvedHarness,
) -> Result<Value> {
    let mut options = options.clone();
    if let Some(identity) = options.get("nativeCollaborationIdentity") {
        let name = crate::js::stringify(&identity["name"]);
        let guidance = crate::collaboration::guidance(harness);
        let text = harness.render(
            crate::harness::TextId::CollaborationIdentityChild,
            &[("name", &name), ("guidance", guidance)],
        );
        options["systemPrompt"] =
            crate::collaboration::append_prompt(&options["systemPrompt"], &text);
    } else if options["nativeLocalCollaboration"] == true {
        options["systemPrompt"] = crate::collaboration::append_prompt(
            &options["systemPrompt"],
            crate::collaboration::guidance(harness),
        );
    }
    if options["systemPrompt"].is_string() {
        return Ok(options["systemPrompt"].clone());
    }
    let mut environment = environment.clone();
    environment["tools"] = json!(definitions);
    if let Some(reference) = crate::prompt::service_instructions_with_harness(eager, harness) {
        options["mcpInstructions"] = json!(reference);
    } else {
        options
            .as_object_mut()
            .unwrap()
            .shift_remove("mcpInstructions");
    }
    let prompt = crate::prompt::assemble_with_harness(&options, &environment, harness)?;
    let (stable, dynamic) = crate::prompt::split_at_boundary(prompt.as_str().unwrap());
    Ok(if dynamic.is_empty() {
        prompt
    } else {
        json!([{"type":"text","text":stable,"cache_control":{"type":"ephemeral"}},{"type":"text","text":dynamic}])
    })
}

fn public_event(mut event: Value) -> Value {
    if let Some(message) = event.get_mut("message").and_then(Value::as_object_mut) {
        message.shift_remove("toolContext");
    }
    event
}

pub(crate) async fn turn(
    session: &Arc<LoopExecution>,
    options: &Value,
    context: &mut LoopContext,
    tools: &Arc<ToolRuntime>,
    provider: &Provider,
    messages: &mut Vec<Value>,
    budget: &mut LoopBudget<'_>,
    cancellation: CancellationToken,
    completed_turns: u64,
    discovery: &mut Option<Arc<Mutex<super::tool_context::State>>>,
) -> Result<Option<(String, u32, Option<String>, u64)>> {
    let mut transient = Vec::<usize>::new();
    let outcome=async {
    let mut active_options = options.clone();
    let mut model_revision = 0;
    let max_turns = crate::js::number(&options["maxTurns"]).unwrap_or(100.0);
    let allowance=Arc::new(Mutex::new(super::compact::session::OutputAllowance::default()));
    let mut active_skills=Vec::new();
    let mut reactive_compactions=0u32;
    let mut capacity_recovery=false;
    let mut overflow_pending=false;
    let mut turn_index=0u32;
    let mut stagnation=super::stagnation::StagnationDetector::default();
    let recitation_interval=crate::prompt::constants()["GOAL_RECITATION_INTERVAL"].as_u64().unwrap_or(25);
    let mut turns_since_goal=recitation_interval;
    let mut open_checked:Option<String>=None;
    let mut completion_checked=false;
    let mut answer_before_check=String::new();
    let mut max_tokens_recovery=0u64;
    let mut unreadable_retries=0u64;
    let mut empty_response_retries=0u8;
    let mut format_recoveries=0u8;
    let mut format_failures=HashSet::new();
    let mut recovery=FailureRecovery::default();
    let mut own_replies=HashSet::new();
    loop {
        if turn_index as f64+1.0+completed_turns as f64>max_turns {break;}
        turn_index+=1;
        session.turn_count.store(turn_index-1,std::sync::atomic::Ordering::Relaxed);
        if cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        if let Some(current)=session.owner.apply_controls(&mut active_options).await? {
            if current != model_revision {
                model_revision=current;
                *allowance.lock().unwrap()=Default::default();
                reactive_compactions=0;capacity_recovery=false;budget.reset();context.compaction.reset();recovery.used_fallback=false;recovery.retry_attempt=0;
            }
        }
        let options = &active_options;
        let model = options["model"].as_str().unwrap_or("");
        select_model(session, options, tools, context, budget);
        session.owner.context_state(model,context.compaction.compacted_history_tokens,context.compaction.deferred_history_tokens).await?;
        session.collect_usage().await?;
        check_execution_budget(session, options).await?;
        drain_input(session,options,messages).await?;
        let mut execution_definitions=refresh_tools(session,options,tools,context,messages,budget,discovery).await?;
        let pending=session.owner.notices(tools).await?;
        let change=session.owner.goal_change(tools).await?;let goal=session.owner.goal(tools).await?;let todos=session.owner.todos(tools).await?;
        let goal_notice=if !change.is_null(){
            session.emit(json!({"type":"system","subtype":"goal_updated","goal":change["current"],"source":"user","session_id":session.session_id,"uuid":id()})).await?;
            Some(super::goal_reminders::goal_change_notice_text_with_harness(&change["previous"],&change["current"],&context.harness))
        }else if goal["status"]=="active"&&turns_since_goal>=recitation_interval{Some(super::goal_reminders::goal_recitation_text_with_harness(&goal,todos.as_array().map(Vec::as_slice).unwrap_or(&[]),&context.harness))}else{None};
        if goal_notice.is_some(){turns_since_goal=0;}else if goal["status"]=="active"{turns_since_goal+=1;}
        if let Some(notice)=super::loop_notices::build_notice_message_with_harness(&[json!({"label":context.harness.text(crate::harness::TextId::ContextNoticesBackgroundUpdates),"items":pending}),json!({"text":goal_notice})],&context.harness){push_transient(messages,&mut transient,notice);}
        let (definitions, eager) = match discovery {
            Some(state) => {
                let state = state.lock().unwrap();
                if state.enabled() {
                    execution_definitions.push(SelectedTool::unbound(super::tool_context::state::definitions_with_harness(&context.harness).0));
                }
                (state.model_definitions.clone(), state.catalog.eager.clone())
            }
            None => (execution_definitions.iter().map(|tool|tool.definition.clone()).collect(),execution_definitions.iter().map(SelectedTool::catalog_entry).collect()),
        };
        let system = system_prompt(options, &context.environment, &definitions, &eager,&context.harness)?;
        let effort=super::effort::resolve(options);
        let thinking=super::token_budget::effective_thinking(&effort.thinking,budget.max_output_tokens());
        budget.configure_output(thinking.clone(), allowance.lock().unwrap().limit);
        let mut injected=Vec::new();let mut user_context=context.memory.user_context_with_harness(options,&context.harness).await;
        if !user_context.is_null(){user_context["isMeta"]=json!(true);injected.push(user_context);}
        if let Some(skills)=&context.skill_context{let mut skills=skills.clone();skills["isMeta"]=json!(true);injected.push(skills);}
        let repaired_images=super::image_input::repair_empty(messages,&context.harness);
        let relabeled=super::image_media_type::correct(messages);
        if repaired_images+relabeled>0{budget.reset();context.compaction.reset();if repaired_images>0{tracing::warn!(session_id=%session.session_id,count=repaired_images,"Replaced empty recorded image blocks with explicit unavailable notices");}if relabeled>0{tracing::warn!(count=relabeled,"Relabeled images whose declared type did not match their content");}session.owner.history_replaced(messages).await?;session.owner.context_state(model,None,None).await?;}
        let combined:Vec<_>=injected.iter().chain(messages.iter()).cloned().collect();
        let mut projected=super::tool_context::history::project(&super::messages::repair_with_harness(&combined,&context.harness).0);
        context.image_input.project(model,provider.capabilities["imageInput"]!=false,&mut projected,&context.harness,&session.session_id);
        if provider.capabilities["caching"]==true{projected=super::messages::cache_breakpoint(projected);}
        let mut request = json!({"model":model,"messages":projected,"systemPrompt":system,"tools":definitions,"maxTokens":budget.max_output_tokens(),"thinking":thinking,"stream":true,
            "providerOptions":{"fallbackModelAvailable":!recovery.used_fallback&&crate::js::truthy(&options["fallbackModel"])}});
        if crate::js::truthy(&options["effort"]){request["providerOptions"]["effort"]=options["effort"].clone();}else if options["nativeResolvedConfig"]!=true{request["providerOptions"]["effort"]=json!("high");}
        if let Some(temperature)=effort.temperature{request["temperature"]=json!(temperature);}
        if let Some(reasoning)=effort.reasoning{request["providerOptions"]["reasoning_effort"]=json!(reasoning);}
        if crate::js::truthy(&options["taskBudget"]){request["providerOptions"]["taskBudget"]=options["taskBudget"].clone();}
        let estimate = budget.estimate_request(&request);
        if let Some(state)=discovery { let mut fixed=request.clone();fixed["messages"]=json!(injected);state.lock().unwrap().set_recovery_budget(((budget.available_input_tokens()-budget.estimate_request(&fixed)-1024.0)/1.2).max(0.0)); }
        let history_tokens=budget.estimate_request(&json!({"messages":messages}));
        let boundary=context.compaction.compacted_history_tokens.unwrap_or(f64::NEG_INFINITY).max(context.compaction.deferred_history_tokens.unwrap_or(f64::NEG_INFINITY));
        let new_work=history_tokens-boundary>=budget.available_input_tokens()*0.1;
        let must_recover=overflow_pending||estimate>=budget.available_input_tokens();
        if must_recover||(budget.should_compact_request(&request)&&new_work){
            if (overflow_pending&&reactive_compactions>=1)||(!overflow_pending&&must_recover&&capacity_recovery){return Err(super::compact::compact_error_template("capacity",TextId::ContextExecutionCapacityAfterRecovery,&[]));}
            let attachments=working_attachments(session,tools,discovery,messages,&mut active_skills,&context.harness).await?;
            let snapshot=discovery.as_ref().map(|state|state.lock().unwrap().snapshot());
            match super::compact::session::compact_request(session,options,provider,messages,budget,&request,&injected,&attachments,snapshot,allowance.clone(),&cancellation,super::compact::session::CompactTrigger::Automatic { reactive: must_recover }).await {
                Ok(result)=>{own_replies=result.retained_indices(&own_replies);transient.clear();turns_since_goal=0;context.compaction.deferred_history_tokens=None;context.compaction.compacted_history_tokens=Some(budget.estimate_request(&json!({"messages":messages})));if overflow_pending{reactive_compactions+=1;}else if must_recover{capacity_recovery=true;}overflow_pending=false;turn_index-=1;continue;},
                Err(error) if error.code=="COMPACT_ERROR"&&!cancellation.is_cancelled()&&!must_recover=>{context.compaction.deferred_history_tokens=Some(history_tokens);tracing::warn!(reason=%error.message,input_tokens=estimate,"Proactive summary was unusable; continuing with retained context below the input capacity");turn_index-=1;continue;},
                Err(error)=>{
                    if recovery.recover(&error,true,false,None,session,&mut active_options,context,budget,messages,&own_replies,&allowance,&mut reactive_compactions,&mut capacity_recovery,&mut overflow_pending,&cancellation).await?{turn_index-=1;continue;}
                    if !cancellation.is_cancelled()&&error.code!="BUDGET_EXCEEDED"&&super::loop_failure::provider(&error).is_none(){return Err(Error::template("CONTEXT_RECOVERY",TextId::ContextExecutionContextRecoveryFailed,&[("error",error.as_harness_message())]));}
                    return Err(error);
                },
            }
        }
        let maximum=budget.request_max_tokens(estimate,None);
        if maximum<1.0||(thinking["type"]=="enabled"&&maximum<=thinking["budgetTokens"].as_f64().unwrap_or(0.0)){return Err(super::compact::compact_error_template("capacity",TextId::ContextExecutionThinkingCapacity,&[]));}
        request["maxTokens"]=json!(maximum);
        let started = Instant::now();
        let turn_cancel = cancellation.child_token();
        let opened=provider.stream(request.clone(),turn_cancel.clone()).await;
        let (mut stream,mut failure)=match opened{Ok(stream)=>(Some(stream),None),Err(error)=>(None,Some(error))};
        let mut content_started=false;
        let execution = Arc::new(Execution {
            options: Arc::new(options.clone()),
            tools: tools.clone(),
            bridge: session.clone(),
            events: session.tool_events(),
            session_id: session.session_id.clone(),
            turn: turn_index,
            cancellation: turn_cancel,
            definitions: execution_definitions,
            completed: Default::default(),
            denials: Default::default(),
            context: session.tool_context.clone(),
            harness:context.harness.clone(),
            discovery: discovery.clone(),
        });
        let scheduler = ToolScheduler::new(execution.clone());
        let mut goal_before_tools=None;
        let mut accumulated = Accumulator::new_with_harness(&session.session_id, model, context.harness.clone());
        let mut retry_response = false;
        let mut discard_response = false;
        accumulated.discovery = discovery.clone();
        loop {
            if failure.is_some(){break;}
            let event = match stream.as_mut().unwrap().next().await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            };
            if event["type"] == "retry" {
                let receipt = (accumulated.committed == 0 && accumulated.has_reported_usage()).then(|| {
                    let mut frame = assistant(&session.session_id, &accumulated.id, &accumulated.model, vec![], &accumulated.usage, None);
                    frame["uuid"] = json!(accumulated.response_id);
                    frame
                });
                if let Err(error) = accumulated.reset() {
                    failure = Some(error);
                    break;
                }
                if let Some(frame) = receipt {
                    let recorded = async {
                        session.charge_usage(&frame["message"]["usage"], frame["message"]["model"].as_str().unwrap_or(model)).await?;
                        session.owner.discarded_response(&frame).await
                    }.await;
                    session.turn_count.store(turn_index, std::sync::atomic::Ordering::Relaxed);
                    if let Err(error) = recorded {
                        tracing::warn!(session_id=%session.session_id,code=%error.code,"Interrupted response accounting callback failed; stopping provider retry");
                        failure = Some(error);
                        break;
                    }
                }
                if let Err(error) = check_execution_budget(session, options).await {
                    tracing::warn!(session_id=%session.session_id, "Provider retry stopped at the execution budget");
                    failure = Some(error);
                    break;
                }
                let retry_status = event["status"].as_f64();
                session.emit(json!({"type":"system","subtype":"api_retry","attempt":event["attempt"],"max_retries":event["maxRetries"],"retry_delay_ms":event["delayMs"],"error_status":event["status"],"error":super::loop_failure::classify(retry_status),"error_message":event["message"],"session_id":session.session_id,"uuid":id()})).await?;
                continue;
            }
            if event["type"]=="content_block_start"||event["type"].as_str().is_some_and(|kind|kind.ends_with("_delta")&&kind!="message_delta"){content_started=true;}
            match accumulated.accept(&event) {
                Ok(Some(frame)) => {
                    if options["includePartialMessages"] == true {
                        for event in accumulated.deferred_events(&frame) {
                            session.emit(json!({"type":"stream_event","event":wire_event(&event),"parent_tool_use_id":null,"uuid":id(),"session_id":session.session_id})).await?;
                        }
                    }
                    if let Err(error) = session.emit(public_event(frame)).await {
                        failure = Some(error);
                        break;
                    }
                    if let Err(error) =
                        commit_frames(session,&mut accumulated, false, &scheduler, tools, &mut goal_before_tools).await
                    {
                        failure = Some(error);
                        break;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
            if options["includePartialMessages"] == true && accumulated.visible_event(&event) {
                let mut event = event;
                if event["type"] == "message_delta" {
                    event["usage"] = accumulated.usage.clone();
                }
                if let Err(error) = session.emit(json!({"type":"stream_event","event":wire_event(&event),"parent_tool_use_id":null,"uuid":id(),"session_id":session.session_id})).await { failure = Some(error); break; }
            }
        }
        session.api_time_ms.fetch_add(started.elapsed().as_millis() as u64,std::sync::atomic::Ordering::Relaxed);
        if failure.is_none() {
            match accumulated.finish() {
                Ok(frames) => {
                    retry_response = accumulated.needs_response_recovery()
                        && (answer_before_check.is_empty() || accumulated.stop.as_deref() == Some("tool_use"));
                    discard_response = retry_response || (answer_before_check.is_empty()
                        && accumulated.has_no_answer_or_call() && accumulated.stop.as_deref() != Some("max_tokens"));
                    for frame in frames {
                        if options["includePartialMessages"] == true {
                            for event in accumulated.deferred_events(&frame) {
                                session.emit(json!({"type":"stream_event","event":wire_event(&event),"parent_tool_use_id":null,"uuid":id(),"session_id":session.session_id})).await?;
                            }
                        }
                        if let Err(error) = session.emit(public_event(frame)).await {
                            failure = Some(error);
                            break;
                        }
                    }
                    if !discard_response {
                        if let Err(error) =
                            commit_frames(session,&mut accumulated, true, &scheduler, tools, &mut goal_before_tools).await
                        {
                            failure = Some(error);
                        }
                    }
                }
                Err(error) => failure = Some(error),
            }
        }
        if let Some(stream)=&mut stream{if let Err(error)=stream.close().await{tracing::warn!(code=%error.code,"Provider iterator cleanup failed");}}
        if failure.is_some() {
            scheduler.stop();
        }
        let finished = scheduler.finish().await;
        session
            .permission_denials
            .lock()
            .unwrap()
            .extend(execution.denials.lock().unwrap().clone());
        if let Err(error) = &finished {
            if failure.is_none() {
                failure = Some(error.clone());
            }
        }
        let mut content = accumulated.content();
        if failure.is_some() {
            content.truncate(accumulated.committed);
        }
        let calls: Vec<_> = content
            .iter()
            .filter(|block| block["type"] == "tool_use")
            .cloned()
            .collect();
        let mut results = match finished {
            Ok(results) => results,
            Err(_) => calls.iter().map(|call| execution.completed.lock().unwrap().get(call["id"].as_str().unwrap_or("")).cloned().unwrap_or_else(|| json!({"toolUseId":call["id"],"isError":true,"content":context.harness.text(if cancellation.is_cancelled(){TextId::ContextToolsInterruptedUser}else{TextId::ContextToolsInterruptedStream})}))).collect(),
        };
        if failure.is_none() {
            for result in results.iter_mut().filter(|result| result["formatRecovery"] == true) {
                let call_id = result["toolUseId"].as_str().unwrap_or("");
                let key = accumulated.format_fingerprints.get(call_id).cloned().unwrap_or_else(|| {
                    let input = calls.iter().find(|call| call["id"] == call_id).map(|call| crate::js::stringify(&call["input"])).unwrap_or_default();
                    super::stagnation::content_digest(&input)
                });
                if format_recoveries >= 2 || !format_failures.insert(key) {
                    result["content"] = json!(context.harness.text(TextId::ContextDiscoveryRecoveryExhausted));
                    failure = Some(Error::template("TOOL_FORMAT_RECOVERY", TextId::ContextDiscoveryRecoveryExhausted, &[]));
                    tracing::warn!(session_id=%session.session_id, attempts=format_recoveries, "CallTool format recovery stopped without progress");
                } else {
                    format_recoveries += 1;
                }
            }
        }
        if failure.is_none()||accumulated.committed>0||accumulated.has_reported_usage(){
            session.charge_usage(&accumulated.usage,&accumulated.model).await?;
            if failure.is_none(){budget.observe(&request,&accumulated.usage);}
            session.turn_count.store(turn_index,std::sync::atomic::Ordering::Relaxed);
        }
        if failure.is_none(){
            recovery.retry_attempt=0;
            reactive_compactions=0;capacity_recovery=false;overflow_pending=false;
            let mut notice=None;
            for result in &results{
                if let Some(call)=calls.iter().find(|call|call["id"]==result["toolUseId"]){
                    let content=result["content"].as_str().unwrap_or("");let mut record=json!({"toolName":call["name"],"inputDigest":super::stagnation::content_digest(&crate::js::stringify(&call["input"])),"isError":result["isError"]==true,"resultDigest":super::stagnation::content_digest(content)});
                    if result["isError"]==true{record["errorType"]=json!(crate::js::utf16_prefix(content,80));}
                    if let Some(next)=stagnation.record_with_harness(record,&context.harness){notice=Some(next);}
                }
            }
            if let(Some(notice),Some(last))=(notice,results.last_mut()){
                if !discovery.as_ref().is_some_and(|state|state.lock().unwrap().has_search_result(last["toolUseId"].as_str().unwrap_or(""))){last["content"]=json!(super::truncate::truncate_content_with_harness(&context.harness.render(TextId::ContextExecutionStagnationEnvelope,&[("content",last["content"].as_str().unwrap_or("")),("notice",&notice)]),options["toolResultBudget"].as_u64().unwrap_or(50_000)as usize,super::truncate::recovery_hint(&context.harness),&context.harness));}
            }
        }
        let text = content
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !content.is_empty() && !discard_response {
            let mut message = json!({"role":"assistant","content":content});
            if let Some(record) =
                accumulated.tool_context_record(message["content"].as_array().unwrap().len())?
            {
                message["toolContext"] = record;
            }
            own_replies.insert(messages.len());
            messages.push(message);
        }
        if failure.is_none()||accumulated.committed>0||accumulated.has_reported_usage() {
            let mut frame=assistant(&session.session_id,&accumulated.id,&accumulated.model,content.clone(),&accumulated.usage,if failure.is_some(){None}else{accumulated.stop.as_deref()});
            frame["uuid"]=json!(accumulated.response_id);
            if let Some(record)=accumulated.tool_context_record(content.len())?{frame["message"]["toolContext"]=record;}
            let recorded = if discard_response || (failure.is_some() && accumulated.committed == 0) {
                session.owner.discarded_response(&frame).await
            } else {
                session.owner.assistant_message(&frame).await
            };
            if let Err(error)=recorded{failure.get_or_insert(error);}
        }
        if !results.is_empty() {
            let result_blocks: Vec<_> = results.iter().map(tool_result_block).collect();
            let mut message = json!({"role":"user","content":result_blocks});
            let mut record = None;
            for result in &results {
                record = super::tool_context::history::merge(
                    record.as_ref(),
                    result.get("toolContext"),
                )?;
            }
            if let Some(record) = record {
                message["toolContext"] = record;
            }
            if let Some(state) = discovery {
                state.lock().unwrap().finalize_results(&mut message)?;
            }
            let mut frame = json!({"type":"user","message":message,"parent_tool_use_id":null,"uuid":id(),"session_id":session.session_id});
            match session.owner.tool_result_message(&frame).await {
                Ok(()) => {
                    if let (Some(state), Some(record)) = (discovery.as_ref(), message.get("toolContext")) {
                        state.lock().unwrap().commit(record)?;
                    }
                }
                Err(mut error) => {
                    if let Some(state) = discovery {
                        let mut state = state.lock().unwrap();
                        let mut discarded = 0;
                        for block in message["content"].as_array_mut().unwrap() {
                            if state.has_search_result(block["tool_use_id"].as_str().unwrap_or("")) {
                                block["content"] = json!(context.harness.text(TextId::ContextDiscoveryNotSaved));
                                block["is_error"] = json!(true);
                                discarded += 1;
                            }
                        }
                        state.finish_step();
                        if discarded > 0 {
                            tracing::warn!(session_id=%session.session_id, count=discarded,"Discarded uncommitted tool discoveries after a result write failure");
                        }
                    }
                    message.as_object_mut().unwrap().shift_remove("toolContext");
                    frame["message"] = message.clone();
                    super::loop_failure::flag(&mut error, "toolResultPersistenceFailed", json!(true));
                    failure = Some(error);
                }
            }
            messages.push(message);
            if !session.lifetime.is_cancelled() {
                let mut event = public_event(frame);
                let blocks = std::mem::take(event["message"]["content"].as_array_mut().unwrap());
                for block in blocks {
                    let mut fragment = event.clone();
                    fragment["message"]["content"] = json!([block]);
                    session.emit(fragment).await?;
                }
            }
        }
        if let Some(state) = discovery {
            state.lock().unwrap().finish_step();
        }
        if let Some(mut error) = failure {
            if accumulated.committed==0 && !cancellation.is_cancelled() {
                if recovery.recover(&error,false,content_started,Some(&request),session,&mut active_options,context,budget,messages,&own_replies,&allowance,&mut reactive_compactions,&mut capacity_recovery,&mut overflow_pending,&cancellation).await?{turn_index-=1;continue;}
            }
            if accumulated.committed>0&&!cancellation.is_cancelled(){
                let template = if error.details.as_ref().is_some_and(|details| details["toolResultPersistenceFailed"] == true) {
                    TextId::ContextExecutionResultsNotSaved
                } else { TextId::ContextExecutionResultsPreserved };
                error=Error::template(error.code.clone(),template,&[("error",error.as_harness_message())]).with_details(error.details.clone().unwrap_or_else(||json!({})));
                super::loop_failure::flag(&mut error,"toolResultsPreserved",json!(true));
            }
            if cancellation.is_cancelled(){super::loop_failure::flag(&mut error,"interruptedToolUse",json!(!calls.is_empty()));}
            return Err(error);
        }
        if let Some(before)=goal_before_tools{
            let after=session.owner.goal(tools).await?;if after["updatedAt"]!=before["updatedAt"]{turns_since_goal=0;session.emit(json!({"type":"system","subtype":"goal_updated","goal":after,"source":"agent","session_id":session.session_id,"uuid":id()})).await?;}
        }
        if retry_response {
            if empty_response_retries >= 2 {
                tracing::warn!(session_id=%session.session_id,model,retries=empty_response_retries,"Unusable model response recovery exhausted");
                return Err(Error::template("EMPTY_MODEL_RESPONSE", TextId::ContextExecutionEmptyResponse, &[]));
            }
            empty_response_retries += 1;
            tracing::warn!(session_id=%session.session_id,model,retry=empty_response_retries,"Model returned no usable completion or tool call; resending the retained request");
            continue;
        }
        empty_response_retries = 0;
        let no_answer = accumulated.has_no_answer_or_call();
        let stop=accumulated.stop;
        if calls.is_empty(){
            if discovery.as_ref().is_some_and(|state| state.lock().unwrap().enabled()) && matches!(crate::js::trim_js(&text), "<CallTool>" | "<CallTool></CallTool>") {
                if format_recoveries >= 2 || !format_failures.insert("text:CallTool".into()) {
                    tracing::warn!(session_id=%session.session_id, "Repeated empty CallTool text could not be recovered");
                    return Err(Error::template("TOOL_FORMAT_RECOVERY", TextId::ContextDiscoveryRecoveryExhausted, &[]));
                }
                format_recoveries += 1;
                push_transient(messages, &mut transient, json!({"role":"user","content":context.harness.text(TextId::ContextDiscoveryTextCall),"isMeta":true}));
                continue;
            }
            if let Some(detail)=accumulated.unreadable_tool_call{
                if unreadable_retries<crate::prompt::constants()["UNREADABLE_TOOL_CALL_RETRY_LIMIT"].as_u64().unwrap_or(2){
                    unreadable_retries+=1;tracing::warn!(attempt=unreadable_retries,"Unreadable tool call; asking the model to resend");
                    push_transient(messages,&mut transient,json!({"role":"user","content":context.harness.render(TextId::ContextExecutionUnreadableRetry,&[("detail",&detail)]),"isMeta":true}));continue;
                }
                tracing::warn!(session_id=%session.session_id, limit=unreadable_retries,"Unreadable tool call recovery exhausted without execution");
                return Err(Error::template("TOOL_FORMAT_RECOVERY", TextId::ContextExecutionUnreadableExhausted, &[]));
            }
            if stop.as_deref()==Some("max_tokens")&&max_tokens_recovery<crate::prompt::constants()["MAX_TOKENS_RECOVERY_LIMIT"].as_u64().unwrap_or(3){max_tokens_recovery+=1;push_transient(messages,&mut transient,json!({"role":"user","content":context.harness.text(crate::harness::TextId::ContextRecoveryMaxTokens),"isMeta":true}));continue;}
            if no_answer && answer_before_check.is_empty() {
                tracing::warn!(session_id=%session.session_id,model,unreadable_retries,max_tokens_recovery,"Model stopped without a usable answer or tool call");
                let reason: String = stop.as_deref().unwrap_or("unknown").chars().take(64).collect();
                return Err(Error::template("MODEL_RESPONSE_STOPPED", TextId::ContextExecutionStoppedWithoutAnswer, &[("reason", reason.into())]));
            }
            let(prevent,blocking)=hooks::stop_with_harness(options,&session.session_id,session.as_ref(),session.as_ref(),&cancellation,&context.harness).await?;
            if prevent{return Ok(None);}
            if !blocking.is_empty(){for mut message in blocking{message["isMeta"]=json!(true);push_transient(messages,&mut transient,message);}max_tokens_recovery=0;continue;}
            let mut check=None;
            if options["turnEndChecks"]["openWork"]!=false{
                let goal=session.owner.goal(tools).await?;let todos=session.owner.todos(tools).await?;let todos=todos.as_array().map(Vec::as_slice).unwrap_or(&[]);
                let text=super::goal_reminders::open_work_check_text_with_harness(&goal,todos,&context.harness);let key=super::goal_reminders::open_work_state_key(&goal,todos);
                if text.is_some()&&open_checked.as_ref()!=Some(&key){open_checked=Some(key);check=text;}
            }
            if check.is_none()&&options["turnEndChecks"]["completion"]==true&&!completion_checked{completion_checked=true;check=Some(super::goal_reminders::completion_check_text(&context.harness).into());}
            if let Some(check)=check{
                if !crate::js::trim_js(&text).is_empty(){answer_before_check=text;}
                if let Some(notice)=super::loop_notices::build_notice_message_with_harness(&[json!({"label":context.harness.text(crate::harness::TextId::ContextNoticesBackgroundUpdates),"items":session.owner.notices(tools).await?}),json!({"text":check})],&context.harness){push_transient(messages,&mut transient,notice);}max_tokens_recovery=0;continue;
            }
            let change=session.owner.goal_change(tools).await?;if !change.is_null(){
                if let Some(notice)=super::loop_notices::build_notice_message_with_harness(&[json!({"text":super::goal_reminders::goal_change_notice_text_with_harness(&change["previous"],&change["current"],&context.harness)})],&context.harness){push_transient(messages,&mut transient,notice);}
                session.emit(json!({"type":"system","subtype":"goal_updated","goal":change["current"],"source":"user","session_id":session.session_id,"uuid":id()})).await?;turns_since_goal=0;continue;
            }
            if drain_input(session,options,messages).await?{max_tokens_recovery=0;continue;}
            return Ok(Some((if crate::js::trim_js(&text).is_empty(){answer_before_check}else{text},turn_index,stop,session.api_time_ms.load(std::sync::atomic::Ordering::Relaxed))));
        }
        max_tokens_recovery=0;
    }
    session.emit(json!({"type":"system","subtype":"max_turns_reached","max_turns":crate::js::number_value(max_turns),"turn_count":turn_index as u64+completed_turns,"session_id":session.session_id,"uuid":id()})).await?;
    Err(Error::template("MAX_TURNS_EXCEEDED",TextId::ContextExecutionMaxTurns,&[("completed",(turn_index as u64+completed_turns).to_string().into()),("maximum",crate::js::to_string(&crate::js::number_value(max_turns)).into())]))
    }.await;
    if !transient.is_empty() {
        let transient: std::collections::HashSet<_> = transient.into_iter().collect();
        let mut index = 0;
        messages.retain(|_| {
            let keep = !transient.contains(&index);
            index += 1;
            keep
        });
    }
    outcome
}

fn push_transient(messages: &mut Vec<Value>, indices: &mut Vec<usize>, message: Value) {
    indices.push(messages.len());
    messages.push(message);
}

async fn check_execution_budget(session: &LoopExecution, options: &Value) -> Result<()> {
    let spent = session.budget_spent().await?;
    let maximum = crate::js::number(&options["maxBudgetUsd"]).unwrap_or(f64::INFINITY);
    if spent >= maximum {
        return Err(Error::template("BUDGET_EXCEEDED", TextId::ContextExecutionBudget, &[
            ("spent", crate::js::to_fixed(spent, 4).into()),
            ("maximum", crate::js::to_fixed(maximum, 4).into()),
        ]));
    }
    Ok(())
}

async fn refresh_tools(
    session: &LoopExecution,
    options: &Value,
    tools: &ToolRuntime,
    context: &mut LoopContext,
    messages: &mut Vec<Value>,
    budget: &mut LoopBudget<'_>,
    discovery: &mut Option<Arc<Mutex<super::tool_context::State>>>,
) -> Result<Vec<SelectedTool>> {
    if let Some(descriptors) = session.owner.changed_tools().await? {
        tools.replace_supplied_tools(descriptors)?;
    }
    let revision = tools.tool_catalog_revision();
    let selected=tools.selected_tools();
    if revision == context.tool_revision {
        return Ok(selected);
    }
    context.tool_revision = revision;
    if let Some(state) = discovery {
        let snapshot = state.lock().unwrap().snapshot();
        let tools:Vec<_>=selected.iter().map(SelectedTool::catalog_entry).collect();
        let native = options["toolCallingMode"].as_str().unwrap_or("native") == "native";
        let empty = json!({"services":{}});
        let policy = if native {
            options.get("toolDiscovery").unwrap_or(&empty)
        } else {
            &empty
        };
        let mut next = super::tool_context::State::new_with_harness(
            &tools,
            policy,
            options["toolResultBudget"].as_u64().unwrap_or(50_000) as usize,
            budget.available_input_tokens(),
            options["disallowedTools"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            native && snapshot["discoveryEntries"] == true,
            context.harness.clone(),
        )?;
        let unchanged = {
            let previous = state.lock().unwrap();
            next.catalog.generation == previous.catalog.generation && previous.uses_harness(&context.harness)
        };
        let next = if unchanged {
            state.clone()
        } else {
            next.restore(&snapshot);
            Arc::new(Mutex::new(next))
        };
        let notice = {
            let state = next.lock().unwrap();
            state.baseline_pending.then(|| state.recovery_message())
        };
        if let Some(mut notice) = notice {
            if notice["content"] == "" {
                notice["content"] = json!(context.harness.text(crate::harness::TextId::ContextDiscoveryConfigurationChanged));
            }
            session.owner.context_message(&notice).await?;
            messages.push(notice);
            next.lock().unwrap().baseline_pending = false;
        }
        *state = next.clone();
        session.owner.tool_context_changed(next).await?;
    }
    budget.reset();
    context.compaction.reset();
    tracing::debug!(session_id=%session.session_id,revision,"Session tool catalog refreshed");
    Ok(selected)
}

pub(crate) async fn working_attachments(
    session: &LoopExecution,
    tools: &ToolRuntime,
    discovery: &Option<Arc<Mutex<super::tool_context::State>>>,
    messages: &[Value],
    active_skills: &mut Vec<Value>,
    harness: &crate::harness::ResolvedHarness,
) -> Result<Vec<Value>> {
    let mut attachments = Vec::new();
    if let Some(state) = discovery {
        attachments.push(state.lock().unwrap().recovery_message());
    }
    let goal = session.owner.goal(tools).await?;
    let todos = session.owner.todos(tools).await?;
    if goal["status"] == "active" {
        if let Some(message) = super::loop_notices::build_notice_message_with_harness(
            &[
                json!({"text":super::goal_reminders::goal_recitation_text_with_harness(&goal,todos.as_array().map(Vec::as_slice).unwrap_or(&[]),harness)}),
            ],
            harness,
        ) {
            attachments.push(message);
        }
    }
    let todo = session.owner.todo_attachment(tools).await?;
    if !todo.is_null() {
        attachments.push(todo);
    }
    if tools
        .definitions()
        .iter()
        .any(|tool| tool["name"] == "Skill")
    {
        *active_skills = crate::prompt::skill_context::collect_active(messages, active_skills);
        if let Some(skills) =
            crate::prompt::skill_context::build_active_with_harness(active_skills, harness)
        {
            attachments.push(skills);
        }
    }
    Ok(attachments)
}

async fn commit_frames(
    session: &LoopExecution,
    accumulated: &mut Accumulator,
    complete: bool,
    scheduler: &ToolScheduler,
    tools: &ToolRuntime,
    goal_before: &mut Option<Value>,
) -> Result<()> {
    for frame in accumulated.frames_to_commit(complete) {
        session
            .owner
            .assistant_block(&frame, &accumulated.response_id)
            .await?;
        accumulated.committed += 1;
        for block in frame["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_use" {
                if block["name"] == "Goal" && goal_before.is_none() {
                    *goal_before = Some(session.owner.goal(tools).await?);
                }
                scheduler.enqueue(
                    block.clone(),
                    accumulated
                        .unreadable
                        .get(block["id"].as_str().unwrap_or(""))
                        .cloned(),
                    accumulated.format_rejections.contains(block["id"].as_str().unwrap_or("")),
                )?;
            }
        }
    }
    Ok(())
}

fn tool_result_block(result: &Value) -> Value {
    let mut content = result["content"].clone();
    if let Some(images) = result["images"]
        .as_array()
        .filter(|images| !images.is_empty())
    {
        let mut blocks = Vec::new();
        if content.as_str().is_some_and(|text| !text.is_empty()) {
            blocks.push(json!({"type":"text","text":content}));
        }
        blocks.extend(images.iter().map(|image| json!({"type":"image","source":{"type":"base64","media_type":image["mimeType"],"data":image["data"]}})));
        content = json!(blocks);
    }
    let mut block =
        json!({"type":"tool_result","tool_use_id":result["toolUseId"],"content":content});
    if result["isError"] == true {
        block["is_error"] = json!(true);
    }
    block
}

pub(crate) fn thinking(options: &Value) -> Value {
    super::effort::resolve(options).thinking
}
pub(crate) fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub(super) fn assistant(
    session: &str,
    message: &str,
    model: &str,
    content: Vec<Value>,
    usage: &Value,
    stop: Option<&str>,
) -> Value {
    json!({"type":"assistant","message":{"id":message,"type":"message","role":"assistant","model":model,"content":content,"stop_reason":stop,"stop_sequence":null,"usage":usage},"parent_tool_use_id":null,"uuid":id(),"session_id":session})
}
pub(crate) fn result_event(
    session: &str,
    cost: &CostTracker,
    text: String,
    turns: u32,
    stop: Option<String>,
    start: Instant,
    api_ms: u64,
    error: Option<&Error>,
) -> Value {
    let subtype = match error.map(|error| error.code.as_str()) {
        None => "success",
        Some("MAX_TURNS_EXCEEDED") => "error_max_turns",
        Some("BUDGET_EXCEEDED") => "error_max_budget_usd",
        _ => "error_during_execution",
    };
    let mut result = json!({"type":"result","subtype":subtype,"result":text,"is_error":error.is_some(),"num_turns":turns,"total_cost_usd":cost.total_cost_usd(),"usage":cost.usage(),"modelUsage":cost.model_usage(),"session_id":session,"stop_reason":stop,"duration_ms":start.elapsed().as_millis() as u64,"duration_api_ms":api_ms,"permission_denials":[],"uuid":id()});
    if let Some(error) = error {
        result["errors"] = json!([error.message]);
    }
    result
}
fn wire_event(event: &Value) -> Value {
    let kind = event["type"].as_str().unwrap_or("");
    if [
        "text_delta",
        "thinking_delta",
        "input_json_delta",
        "signature_delta",
        "reasoning_delta",
    ]
    .contains(&kind)
    {
        let (field, source, kind) = match kind {
            "text_delta" => ("text", "text", kind),
            "input_json_delta" => ("partial_json", "partialJson", kind),
            "signature_delta" => ("signature", "signature", kind),
            "reasoning_delta" => ("thinking", "reasoning", "thinking_delta"),
            _ => ("thinking", "thinking", kind),
        };
        let mut delta = json!({"type":kind});
        delta[field] = event[source].clone();
        json!({"type":"content_block_delta","index":event["index"],"delta":delta})
    } else if kind == "message_start" {
        json!({"type":kind,"message":{"id":event["id"],"type":"message","role":"assistant","model":event["model"],"content":[],"usage":event["usage"],"stop_reason":event["stopReason"],"stop_sequence":null}})
    } else if kind == "message_delta" {
        json!({"type":kind,"delta":{"type":"message_delta","stop_reason":event["stopReason"],"stop_sequence":null},"usage":event.get("usage").cloned().unwrap_or(json!({"output_tokens":0}))})
    } else {
        event.clone()
    }
}

async fn drain_input(
    session: &LoopExecution,
    options: &Value,
    messages: &mut Vec<Value>,
) -> Result<bool> {
    let Some(message) = session.owner.pending_input(options).await? else {
        return Ok(false);
    };
    let content = if message["content"].is_array() {
        message["content"].clone()
    } else {
        json!([{"type":"text","text":message["content"]}])
    };
    messages.push(message);
    if session.owner.replay_pending_input() {
    session.emit_unobserved(json!({"type":"user","isReplay":true,"message":{"role":"user","content":content},"session_id":session.session_id,"parent_tool_use_id":null,"uuid":id()})).await?;
    }
    Ok(true)
}

#[derive(Default)]
struct FailureRecovery {
    used_fallback: bool,
    retry_attempt: u32,
    reasoning_stripped: bool,
}
impl FailureRecovery {
    async fn recover(
        &mut self,
        error: &Error,
        compacting: bool,
        content_started: bool,
        request: Option<&Value>,
        execution: &LoopExecution,
        options: &mut Value,
        context: &mut LoopContext,
        budget: &mut LoopBudget<'_>,
        messages: &mut Vec<Value>,
        own_replies: &HashSet<usize>,
        allowance: &Arc<Mutex<super::compact::session::OutputAllowance>>,
        reactive: &mut u32,
        capacity: &mut bool,
        overflow: &mut bool,
        cancel: &CancellationToken,
    ) -> Result<bool> {
        if cancel.is_cancelled() || error.is_abort() || error.code == "BUDGET_EXCEEDED" {
            return Ok(false);
        }
        let model = options["model"].as_str().unwrap_or("");
        let image_messages = request.and_then(|request|request["messages"].as_array()).map(Vec::as_slice).unwrap_or(messages.as_slice());
        if !content_started && context.image_input.rejected(model,error,image_messages) {
            budget.reset();
            context.compaction.reset();
            tracing::warn!(session_id=%execution.session_id,model,"Provider rejected image input; retrying once with explicit text notices while retaining original history");
            execution.owner.context_state(model,None,None).await?;
            return Ok(true);
        }
        if !compacting && !content_started {
            if let Some(request) = request {
                if let Some(limit) =
                    allowance
                        .lock()
                        .unwrap()
                        .correct(request, error, &execution.session_id)
                {
                    budget.configure_output(request["thinking"].clone(), Some(limit));
                    return Ok(true);
                }
            }
        }
        if !self.reasoning_stripped && super::loop_failure::invalid_thinking(error) {
            self.reasoning_stripped = true;
            let removed = super::messages::strip_reasoning_indexed_with_harness(
                messages,
                |index, _| own_replies.contains(&index),
                &context.harness,
            );
            if removed > 0 {
                budget.reset();
                context.compaction.reset();
                tracing::warn!(
                    removed_blocks = removed,
                    "Provider rejected recorded reasoning; resending without it"
                );
                execution.owner.history_replaced(messages).await?;
                return Ok(true);
            }
        }
        let provider = super::loop_failure::provider(error);
        let fallback = options["fallbackModel"]
            .as_str()
            .filter(|model| !model.is_empty())
            .map(str::to_owned);
        let can_fallback = !self.used_fallback && fallback.is_some();
        if let Some(failure) = &provider {
            let immediate = failure.model_fallback && can_fallback;
            if !immediate
                && failure.retryable
                && !failure.retries_exhausted
                && self.retry_attempt < crate::retry::MAX_RETRIES
            {
                let delay = crate::retry::delay_for_attempt(self.retry_attempt);
                self.retry_attempt += 1;
                tracing::warn!(attempt=self.retry_attempt,status=?failure.status,reason=%error.message,"Provider call failed; retrying");
                execution
                    .emit(super::loop_failure::retry_event(
                        &execution.session_id,
                        self.retry_attempt,
                        delay,
                        error,
                    ))
                    .await?;
                tokio::select! {_=cancel.cancelled()=>{},_=tokio::time::sleep(std::time::Duration::from_secs_f64(delay/1000.0))=>{}}
                return Ok(true);
            }
            if can_fallback && (immediate || failure.retryable) {
                let from = options["model"].as_str().unwrap_or("").to_owned();
                let to = fallback.unwrap();
                let reason = if immediate {
                    error.render_for(&context.harness)
                } else {
                    context
                        .harness
                        .render(TextId::ContextExecutionRetryExhausted, &[("model", &from)])
                };
                options["model"] = json!(to);
                self.used_fallback = true;
                self.retry_attempt = 0;
                *allowance.lock().unwrap() = Default::default();
                *reactive = 0;
                *capacity = false;
                budget.reset();
                context.compaction.reset();
                execution.emit(json!({"type":"system","subtype":"model_fallback","from_model":from,"to_model":to,"reason":reason,"error_status":failure.status,"session_id":execution.session_id,"uuid":id()})).await?;
                return Ok(true);
            }
        }
        if !compacting
            && request.is_some()
            && super::compact::is_context_exceeded(error)
            && *reactive < 1
        {
            *overflow = true;
            return Ok(true);
        }
        Ok(false)
    }
}

pub(crate) type LoopOutcome = Result<Option<(String, u32, Option<String>, u64)>>;
pub(crate) async fn conclude(
    execution: &LoopExecution,
    outcome: LoopOutcome,
    context: &LoopContext,
    start: Instant,
    cancellation: &CancellationToken,
) -> Result<Option<Value>> {
    if matches!(outcome, Ok(None)) {
        return Ok(None);
    }
    execution.collect_usage().await?;
    let (mut event, _error) = match outcome {
        Ok(Some((text, turns, stop, api_ms))) => (
            result_event(
                &execution.session_id,
                &execution.cost.lock().unwrap(),
                text,
                turns,
                stop,
                start,
                api_ms,
                None,
            ),
            None,
        ),
        Ok(None) => unreachable!(),
        Err(mut error) => {
            let aborted = cancellation.is_cancelled() || error.is_abort();
            if aborted {
                let interrupted = error
                    .details
                    .as_ref()
                    .is_some_and(|details| details["interruptedToolUse"] == true);
                error = Error::template("ABORTED", TextId::ContextExecutionAborted, &[]);
                if !execution.lifetime.is_cancelled() {
                    execution.emit(json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":context.harness.text(if interrupted{TextId::ContextExecutionInterruptedTool}else{TextId::ContextExecutionInterruptedUser})}]},"parent_tool_use_id":null,"uuid":id(),"session_id":execution.session_id})).await?;
                }
            }
            error.message = error.render_for(&context.harness);
            let terminal_limit = matches!(
                error.code.as_str(),
                "BUDGET_EXCEEDED" | "MAX_TURNS_EXCEEDED"
            );
            let preserved = error
                .details
                .as_ref()
                .is_some_and(|details| details["toolResultsPreserved"] == true);
            if !aborted && !terminal_limit && !preserved && !execution.lifetime.is_cancelled() {
                let mut frame = assistant(
                    &execution.session_id,
                    &id(),
                    "<synthetic>",
                    vec![json!({"type":"text","text":error.message})],
                    &json!({"input_tokens":0,"output_tokens":0}),
                    Some("stop_sequence"),
                );
                frame["message"]["stop_sequence"] = json!("");
                frame["error"] = json!(super::loop_failure::classify(super::loop_failure::status(
                    &error
                )));
                execution.emit(frame).await?;
            }
            let stop = match error.code.as_str() {
                "BUDGET_EXCEEDED" => Some("max_budget".into()),
                "MAX_TURNS_EXCEEDED" => Some("max_turns".into()),
                _ => None,
            };
            (
                result_event(
                    &execution.session_id,
                    &execution.cost.lock().unwrap(),
                    error.message.clone(),
                    execution
                        .turn_count
                        .load(std::sync::atomic::Ordering::Relaxed),
                    stop,
                    start,
                    execution
                        .api_time_ms
                        .load(std::sync::atomic::Ordering::Relaxed),
                    Some(&error),
                ),
                Some(error),
            )
        }
    };
    event["permission_denials"] = json!(*execution.permission_denials.lock().unwrap());
    Ok(Some(event))
}
struct DiscardEvents;
#[async_trait::async_trait]
impl EventSink for DiscardEvents {
    async fn emit(&self, _event: Value) -> Result<()> {
        Ok(())
    }
}
pub(crate) async fn terminal_hooks(
    execution: &LoopExecution,
    options: &Value,
    harness: &crate::harness::ResolvedHarness,
    cancel: &CancellationToken,
) {
    if let Err(error) = hooks::stop_with_harness(
        options,
        &execution.session_id,
        execution,
        &DiscardEvents,
        cancel,
        harness,
    )
    .await
    {
        tracing::warn!(session_id=%execution.session_id,code=%error.code,"Terminal Stop hook did not complete");
    }
}
