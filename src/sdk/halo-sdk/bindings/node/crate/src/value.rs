use crate::{decode, encode, failure};
use halo_core::{
    core::{cost::CostTracker, token_budget::TokenBudget},
    error::Error as CoreError,
    js,
};
use napi::{Error, Result, Status};
use napi_derive::napi;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[napi]
pub fn native_value(name: String, payload: String) -> Result<String> {
    let args = decode(&payload)?;
    let value = match name.as_str() {
        "tools.descriptors" => json!(halo_core::tools::builtin_descriptors()),
        "tools.filter" => {
            let names = args[0].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let allowed = args[1]["allowedTools"]
                .as_array()
                .filter(|items| !items.is_empty());
            let denied = args[1]["disallowedTools"]
                .as_array()
                .filter(|items| !items.is_empty());
            json!({"sameArray":allowed.is_none()&&denied.is_none(),"indices":names.iter().enumerate().filter(|(_,name)|allowed.is_none_or(|items|items.contains(name))&&denied.is_none_or(|items|!items.contains(name))).map(|(index,_)|index).collect::<Vec<_>>()})
        }
        "tools.find" => args[0]
            .as_array()
            .and_then(|items| items.iter().position(|name| name == &args[1]))
            .map(|index| json!(index))
            .unwrap_or_else(js::undefined),
        "resolveQueryConfig" => halo_core::core::config::resolve(&args[0]).map_err(failure)?,
        "config.defaultConventions" => halo_core::core::config::default_conventions(),
        "error.unreadableResponseBody" => serde_json::to_value(CoreError::template(
            "UNREADABLE_RESPONSE_BODY",
            halo_core::harness::TextId::ProvidersStreamUnreadableBody,
            &[],
        ))
        .expect("SDK errors are serializable"),
        "compact.micro" => {
            serde_json::to_value(halo_core::core::compact::local::micro_compact_receipt(
                args[0].as_array().map(Vec::as_slice).unwrap_or(&[]),
                js::number(&args[1]).unwrap_or(f64::NAN),
                &halo_core::harness::baseline(),
            ))
            .expect("compaction receipt is serializable")
        }
        "compact.api" => {
            let messages = args[0].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let total = if js::is_undefined(&args[1]) {
                halo_core::core::tokens::estimate_message_tokens(messages)
            } else {
                js::number(&args[1]).unwrap_or(f64::NAN)
            };
            json!(
                halo_core::core::compact::local::api_compact_indices_with_total(
                    messages,
                    total,
                    js::number(&args[2])
                )
            )
        }
        "compact.format" => json!(halo_core::core::compact::local::format_summary(
            args[0].as_str().unwrap_or("")
        )),
        "compact.prompt" => json!(halo_core::prompt::summary::build(
            &json!({"instructions":args[0]})
        )),
        "compact.shouldAuto" => json!(
            !js::truthy(&args[2])
                && js::number(&args[0]).unwrap_or(f64::NAN)
                    >= (js::number(&args[1]).unwrap_or(f64::NAN) * 0.9).floor()
        ),
        "compact.warning" => json!(halo_core::core::compact::token_warning(
            js::number(&args[0]).unwrap_or(f64::NAN),
            js::number(&args[1]).unwrap_or(f64::NAN),
        )),
        "compact.state" => {
            let mut state = args[0].clone();
            if args[1] == "success" {
                state["compactionCount"] = js::number_value(
                    js::number(&state["compactionCount"]).unwrap_or(f64::NAN) + 1.0,
                );
                state["consecutiveFailures"] = json!(0);
            } else {
                let failures = js::number(&state["consecutiveFailures"]).unwrap_or(f64::NAN) + 1.0;
                state["consecutiveFailures"] = js::number_value(failures);
                if failures >= 3.0 {
                    state["disabled"] = json!(true);
                }
            }
            state
        }
        "toolCalling.family" => json!(halo_core::llm::tool_calling::family(
            args[0].as_str().unwrap_or("")
        )),
        "modelQuirks.isQuirky" => json!(halo_core::llm::model_quirks::is_quirky(
            args[0].as_str().unwrap_or("")
        )),
        "modelQuirks.response" => halo_core::llm::model_quirks::apply_response_receipt(
            args[0].as_str().unwrap_or(""),
            &args[1],
        ),
        "toolCalling.mode" => json!(halo_core::llm::tool_calling::mode(&args[1])),
        "toolCalling.render" => json!(halo_core::llm::tool_calling::render::render_tools(
            args[0].as_array().map(Vec::as_slice).unwrap_or(&[]),
            args[1].as_str().unwrap_or("xml"),
            &halo_core::harness::baseline()
        )),
        "toolCalling.parseXml" => {
            let names: Vec<_> = args[1]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            serde_json::to_value(
                halo_core::llm::tool_calling::parser::xml(args[0].as_str().unwrap_or(""), &names)
                    .map_err(failure)?,
            )
            .expect("parsed tool calls are serializable")
        }
        "harness.catalog" => halo_core::harness::catalog(),
        "skills.builtinDefinitions" => halo_core::skills::builtin_definitions(),
        "estimateTokens" => js::number_value(halo_core::core::tokens::estimate_tokens(
            args[0].as_str().unwrap_or(""),
        )),
        "estimateMessageTokens" => {
            js::number_value(halo_core::core::tokens::estimate_message_tokens(
                args[0].as_array().map(Vec::as_slice).unwrap_or(&[]),
            ))
        }
        "truncateToolResult" => {
            let maximum = js::number(&args[1]).unwrap_or(f64::NAN);
            if maximum == f64::INFINITY {
                args[0].clone()
            } else {
                if !maximum.is_finite()
                    || maximum.fract() != 0.0
                    || maximum < 0.0
                    || maximum > 9_007_199_254_740_991.0
                {
                    return Err(failure(
                        CoreError::new(
                            "INVALID_BUDGET",
                            "Text output budget must be a nonnegative integer",
                        )
                        .with_details(json!({"name":"RangeError"})),
                    ));
                }
                json!(halo_core::core::truncate::truncate_content(
                    args[0].as_str().unwrap_or(""),
                    maximum as usize,
                    halo_core::core::truncate::RECOVERY_HINT
                ))
            }
        }
        "resolvePromptProfile" => {
            halo_core::prompt::profile(args[0].as_str().unwrap_or(""), &args[1]).map_err(failure)?
        }
        "splitAtBoundary" => {
            let (stable, dynamic) =
                halo_core::prompt::split_at_boundary(args[0].as_str().unwrap_or(""));
            json!([stable, dynamic])
        }
        "assembleSystemPrompt" => {
            let options = &args[0];
            let environment = if options
                .get("customReplace")
                .is_some_and(|value| !js::is_undefined(value))
            {
                json!({})
            } else {
                halo_core::prompt::probe_environment_sync(options)
            };
            halo_core::prompt::assemble(options, &environment).map_err(failure)?
        }
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unknown native value operation: {name}"),
            ))
        }
    };
    encode(&value)
}

#[napi]
pub struct NativeSseParser {
    inner: Mutex<halo_core::llm::stream_parser::StreamParser>,
}
#[napi]
impl NativeSseParser {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(halo_core::llm::stream_parser::StreamParser::default()),
        }
    }
    #[napi]
    pub fn feed(&self, text: String) -> Result<String> {
        encode(
            &serde_json::to_value(self.inner.lock().unwrap().feed(&text).map_err(failure)?)
                .expect("SSE records are serializable"),
        )
    }
}

#[napi]
pub struct NativeReadState {
    inner: Arc<halo_core::tools::FileReadStateStore>,
}
#[napi]
impl NativeReadState {
    #[napi]
    pub fn call(&self, method: String, payload: String) -> Result<String> {
        encode(
            &self
                .inner
                .context_call(&method, &decode(&payload)?)
                .map_err(failure)?,
        )
    }
}
#[napi]
pub struct NativeToolText {
    inner: Arc<halo_core::harness::ResolvedHarness>,
}
#[napi]
impl NativeToolText {
    #[napi]
    pub fn call(&self, method: String, payload: String) -> Result<String> {
        let args = decode(&payload)?;
        let value = match method.as_str() {
            "codeSearch.result" => halo_core::tools::format_code_search_result(&args[0], &self.inner),
            "codeSearch.error" => halo_core::tools::failure(if args[0].is_null() {
                self.inner.text(halo_core::harness::TextId::ToolsCodeSearchUnavailable).to_owned()
            } else { CoreError::from_host(args[0].clone()).render_for(&self.inner) }),
            _ => return Err(failure(CoreError::new("UNKNOWN_OPERATION", "Unknown tool text operation"))),
        };
        encode(&value)
    }
}

#[napi(object, object_from_js = false)]
pub struct NativeSharedToolState {
    pub run_id: String,
    pub read_identity: String,
    pub cost: NativeCostTracker,
    pub reads: NativeReadState,
    pub text: NativeToolText,
    pub catalog_owner: String,
    pub catalog_scope: String,
    pub skills: NativeSkillCatalog,
}

#[napi]
pub struct NativeSkillCatalog {
    inner: halo_core::core::skill_catalog_view::SkillCatalogSnapshot,
}
#[napi]
impl NativeSkillCatalog {
    #[napi]
    pub fn snapshot(&self) -> Result<String> {
        encode(self.inner.value().map_err(failure)?)
    }
}
pub(crate) fn shared_tool_state(
    state: halo_core::core::loop_owner::SharedToolState,
) -> NativeSharedToolState {
    NativeSharedToolState {
        run_id: state.run_id,
        read_identity: state.read_identity,
        cost: NativeCostTracker::from_shared(state.cost),
        reads: NativeReadState { inner: state.reads },
        text: NativeToolText { inner: state.text },
        catalog_owner: state.skills.owner.identity().into(),
        catalog_scope: state.skills.scope.clone(),
        skills: NativeSkillCatalog { inner: state.skills },
    }
}

#[napi]
pub struct NativeCostTracker {
    pub(crate) inner: Arc<Mutex<CostTracker>>,
}
impl NativeCostTracker {
    pub(crate) fn from_shared(inner: Arc<Mutex<CostTracker>>) -> Self {
        Self { inner }
    }
}
#[napi]
impl NativeCostTracker {
    #[napi(constructor)]
    pub fn new(model: String, context_window: f64, pricing: String) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(Mutex::new(CostTracker::new(
                &model,
                context_window,
                decode(&pricing)?,
            ))),
        })
    }
    #[napi]
    pub fn call(&self, name: String, payload: String) -> Result<String> {
        encode(
            &self
                .inner
                .lock()
                .unwrap()
                .call(&name, &decode(&payload)?)
                .map_err(failure)?,
        )
    }
}

#[napi]
pub struct NativeTokenBudget {
    pub(crate) inner: Arc<Mutex<TokenBudget>>,
}
impl NativeTokenBudget {
    pub(crate) fn from_shared(inner: Arc<Mutex<TokenBudget>>) -> Self {
        Self { inner }
    }
}
#[napi]
impl NativeTokenBudget {
    #[napi(constructor)]
    pub fn new(context_window: f64, max_output_tokens: f64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TokenBudget::new(
                context_window,
                max_output_tokens,
            ))),
        }
    }
    #[napi]
    pub fn call(&self, name: String, payload: String) -> Result<String> {
        let args = decode(&payload)?;
        let mut budget = self.inner.lock().unwrap();
        let messages = || args[0].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let value = match name.as_str() {
            "harness.catalog" => halo_core::harness::catalog(),
            "contextWindow" => js::number_value(budget.context_window),
            "maxOutputTokens" => js::number_value(budget.max_output_tokens),
            "configureOutput" => {
                budget.configure_output(args[0].clone(), js::number(&args[1]));
                Value::Null
            }
            "outputReservationTokens" => js::number_value(budget.output_reservation_tokens()),
            "requestMaxTokens" => js::number_value(budget.request_max_tokens(
                js::number(&args[0]).unwrap_or(f64::NAN),
                js::number(&args[1]),
            )),
            "availableInputTokens" => js::number_value(budget.available_input_tokens()),
            "targetInputTokens" => js::number_value(budget.target_input_tokens()),
            "estimateRequest" => js::number_value(budget.estimate_request(&args[0])),
            "observe" => {
                budget.observe(&args[0], &args[1]);
                Value::Null
            }
            "compactionTriggerTokens" => js::number_value(budget.compaction_trigger_tokens()),
            "shouldCompactRequest" => json!(budget.should_compact_request(&args[0])),
            "reset" => {
                budget.reset();
                Value::Null
            }
            "updateFromUsage" => {
                budget.update_from_usage(js::number(&args[0]).unwrap_or(f64::NAN));
                Value::Null
            }
            "currentInputTokens" => js::number_value(budget.current_input_tokens(messages())),
            "remainingInputTokens" => js::number_value(budget.remaining_input_tokens(messages())),
            "usageRatio" => js::number_value(budget.usage_ratio(messages())),
            "shouldCompact" => json!(budget.should_compact(messages())),
            "summaryMetrics" => {
                let used = budget.current_input_tokens(messages());
                let percent = js::to_fixed(budget.usage_ratio(messages()) * 100.0, 1);
                json!({"used":js::number_value(used),"window":js::number_value(budget.context_window),"percent":percent})
            }
            "formatSummary" => json!(format!(
                "{} / {} tokens ({}%)",
                args[0].as_str().unwrap_or(""),
                args[1].as_str().unwrap_or(""),
                args[2].as_str().unwrap_or("")
            )),
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Unknown token budget operation: {name}"),
                ))
            }
        };
        encode(&value)
    }
}
