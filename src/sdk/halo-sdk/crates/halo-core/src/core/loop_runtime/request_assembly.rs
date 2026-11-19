use super::{system_prompt, LoopContext};
use crate::core::{effort, image_input, loop_budget::LoopBudget, loop_owner::LoopExecution, messages, token_budget, tool_context};
use crate::error::Result;
use serde_json::{json, Value};

pub(crate) struct Inputs<'a> {
    pub definitions: &'a [Value],
    pub eager: &'a [Value],
    pub output_limit: Option<f64>,
    pub fallback_available: bool,
}

pub(crate) enum History<'a> {
    Live(&'a mut [Value]),
    ReadOnly(&'a [Value]),
}

pub(crate) struct Assembled {
    pub request: Value,
    pub injected: Vec<Value>,
    pub thinking: Value,
}

pub(crate) async fn assemble(
    execution: &LoopExecution,
    options: &Value,
    context: &mut LoopContext,
    capabilities: &Value,
    history: History<'_>,
    budget: &mut LoopBudget<'_>,
    inputs: Inputs<'_>,
) -> Result<Assembled> {
    let model = options["model"].as_str().unwrap_or("");
    let system = system_prompt(
        options,
        &context.environment,
        inputs.definitions,
        inputs.eager,
        &context.harness,
    )?;
    let effort = effort::resolve(options);
    let thinking = token_budget::effective_thinking(&effort.thinking, budget.max_output_tokens());
    budget.configure_output(thinking.clone(), inputs.output_limit);
    let mut injected = Vec::new();
    let mut user_context = context
        .memory
        .user_context_with_harness(options, &context.harness)
        .await;
    if !user_context.is_null() {
        user_context["isMeta"] = json!(true);
        injected.push(user_context);
    }
    if let Some(skills) = &context.skill_context {
        let mut skills = skills.clone();
        skills["isMeta"] = json!(true);
        injected.push(skills);
    }
    let history: &[Value] = match history {
        History::Live(history) => {
            let (empty, relabeled) = image_input::repair_recorded(history, &context.harness);
            if empty + relabeled > 0 {
                budget.reset();
                context.compaction.reset();
                if empty > 0 {
                    tracing::warn!(session_id=%execution.session_id,count=empty,"Replaced empty recorded image blocks with explicit unavailable notices");
                }
                if relabeled > 0 {
                    tracing::warn!(count=relabeled,"Relabeled images whose declared type did not match their content");
                }
                execution.owner.history_replaced(history).await?;
                execution.owner.context_state(model, None, None).await?;
            }
            history
        }
        History::ReadOnly(history) => history,
    };
    let combined: Vec<_> = injected.iter().chain(history).cloned().collect();
    let mut projected = tool_context::history::project(
        &messages::repair_with_harness(&combined, &context.harness).0,
    );
    context.image_input.project(
        model,
        capabilities["imageInput"] != false,
        &mut projected,
        &context.harness,
        &execution.session_id,
    );
    if capabilities["caching"] == true {
        projected = messages::cache_breakpoint(projected);
    }
    let mut request = json!({"model":model,"messages":projected,"systemPrompt":system,"tools":inputs.definitions,"maxTokens":budget.max_output_tokens(),"thinking":thinking,"stream":true,
        "providerOptions":{"fallbackModelAvailable":inputs.fallback_available}});
    if thinking.is_null() {
        request.as_object_mut().unwrap().remove("thinking");
    }
    if crate::js::truthy(&options["effort"]) {
        request["providerOptions"]["effort"] = options["effort"].clone();
    } else if options["nativeResolvedConfig"] != true {
        request["providerOptions"]["effort"] = json!("high");
    }
    if let Some(temperature) = effort.temperature {
        request["temperature"] = json!(temperature);
    }
    if let Some(reasoning) = effort.reasoning {
        request["providerOptions"]["reasoning_effort"] = json!(reasoning);
    }
    if crate::js::truthy(&options["taskBudget"]) {
        request["providerOptions"]["taskBudget"] = options["taskBudget"].clone();
    }
    Ok(Assembled { request, injected, thinking })
}
