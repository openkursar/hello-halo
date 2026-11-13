use super::{
    catalog::{self, stable_json, Catalog, QUERY_CHARACTERS, SEARCH_BYTES, STATE_BYTES},
    history, presentation,
};
use crate::{
    core::{
        tokens::estimate_tokens,
        truncate::{truncate_content_with_harness, recovery_hint},
    },
    error::{Error, Result},
    harness::{ResolvedHarness,TextId,ResourceId},
    js::{stringify, trim_js, utf16_len},
};
use serde_json::{json, Map, Value};
use std::{collections::HashSet,sync::Arc};

pub fn definitions() -> (Value, Value) { definitions_with_harness(&crate::harness::baseline()) }
pub fn definitions_with_harness(harness:&ResolvedHarness)->(Value,Value){
    let value=harness.resource(ResourceId::ToolDiscovery);
    (value["SEARCH_DEFINITION"].clone(),value["CALL_DEFINITION"].clone())
}
fn guide_key(item: &Value) -> String {
    stable_json(&json!([item["identity"], item["usageGuide"]]))
}
fn render_item(item: &Value, include: bool) -> Value {
    presentation::target(item, include)
}
fn span(prefix: &str, suffix: &str, payload: &str) -> Value {
    if prefix.is_empty() && suffix.is_empty() {
        json!({})
    } else {
        json!({"payloadOffset":utf16_len(prefix),"payloadLength":utf16_len(payload)})
    }
}
fn problem(message: &str) -> Value {
    json!({"content":message,"isError":true})
}
fn payload(tools: Vec<Value>, skipped: usize,harness:&ResolvedHarness) -> Value {
    let mut value = presentation::payload(tools);
    value["instructions"] = json!(harness.text(TextId::ContextDiscoverySearchBridge));
    if skipped > 0 {
        value["notice"] = json!(
            harness.text(TextId::ContextDiscoveryPartialResults)
        );
    } else if value["targets"].as_array().unwrap().is_empty() {
        value["notice"] =
            json!(harness.text(TextId::ContextDiscoveryNoResults));
    }
    value
}
#[derive(Clone)]
struct Pending {
    content: String,
    rendered: String,
    prefix: String,
    suffix: String,
    explicit: bool,
    settled: bool,
    definitions: Vec<Value>,
    payload: Value,
}

pub struct State {
    identity: String,
    pub catalog: Catalog,
    pub model_definitions: Vec<Value>,
    pub discovery_entries: bool,
    discovered: Map<String, Value>,
    pending: Vec<(String, Pending)>,
    result_characters: usize,
    recovery_tokens: f64,
    pub baseline_pending: bool,
    harness:Arc<ResolvedHarness>,
}
impl State {
    pub fn new(
        tools: &[Value],
        options: &Value,
        result_characters: usize,
        recovery_tokens: f64,
        disallowed: &[Value],
        historical: bool,
    ) -> Result<Self> {
        Self::new_with_harness(tools,options,result_characters,recovery_tokens,disallowed,historical,crate::harness::baseline())
    }
    pub fn new_with_harness(
        tools: &[Value],
        options: &Value,
        result_characters: usize,
        recovery_tokens: f64,
        disallowed: &[Value],
        historical: bool,
        harness:Arc<ResolvedHarness>,
    ) -> Result<Self> {
        let catalog = Catalog::new_with_harness(tools, options,&harness)?;
        let discovery_entries = !catalog.deferred.is_empty() || historical;
        if discovery_entries {
            if tools
                .iter()
                .any(|tool| tool["name"] == "ToolSearch" || tool["name"] == "CallTool")
            {
                return Err(Error::template("TOOL_DISCOVERY", TextId::ContextDiscoveryReservedNames, &[]));
            }
            if !catalog.deferred.is_empty()
                && disallowed
                    .iter()
                    .any(|name| name == "ToolSearch" || name == "CallTool")
            {
                return Err(Error::template("TOOL_DISCOVERY", TextId::ContextDiscoveryRequiredEntryDisabled, &[]));
            }
        }
        let mut model_definitions: Vec<_> = catalog.eager.iter().map(catalog::definition).collect();
        if discovery_entries {
            let (search, call) = definitions_with_harness(&harness);
            model_definitions.extend([search, call]);
        }
        Ok(Self {
            identity: uuid::Uuid::new_v4().to_string(),
            catalog,
            model_definitions,
            discovery_entries,
            discovered: Map::new(),
            pending: Vec::new(),
            result_characters,
            recovery_tokens,
            baseline_pending: true,
            harness,
        })
    }
    pub fn identity(&self) -> &str { &self.identity }
    pub fn uses_harness(&self, harness: &Arc<ResolvedHarness>) -> bool { Arc::ptr_eq(&self.harness, harness) }
    pub fn search_definition(&self) -> Value { definitions_with_harness(&self.harness).0 }
    pub fn enabled(&self) -> bool {
        !self.catalog.deferred.is_empty()
    }
    pub fn set_recovery_budget(&mut self, tokens: f64) {
        self.recovery_tokens = tokens.max(0.0);
    }
    pub fn snapshot(&self) -> Value {
        json!({"version":1,"generation":self.catalog.generation,"discoveryEntries":self.discovery_entries,"directory":self.catalog.directory,"definitions":self.discovered.values().cloned().collect::<Vec<_>>()})
    }
    pub fn restore(&mut self, snapshot: &Value) {
        self.baseline_pending = snapshot["generation"] != self.catalog.generation;
        self.discovered.clear();
        for definition in snapshot["definitions"].as_array().into_iter().flatten() {
            let name = definition["definition"]["name"].as_str().unwrap_or("");
            if self.catalog.deferred.get(name).is_some_and(|current| {
                current["version"] == definition["version"]
                    && current["identity"] == definition["identity"]
            }) {
                self.discovered.insert(name.into(), definition.clone());
            }
        }
        self.pending.clear();
    }
    pub fn commit(&mut self, record: &Value) -> Result<()> {
        if !history::valid_record(record) {
            return Err(Error::template("TOOL_DISCOVERY", TextId::ContextDiscoveryInvalidCommit, &[]));
        }
        for discovery in record["discoveries"].as_array().into_iter().flatten() {
            for definition in discovery["definitions"].as_array().into_iter().flatten() {
                let current = self
                    .catalog
                    .deferred
                    .get(definition["definition"]["name"].as_str().unwrap_or(""));
                if current.is_none_or(|current| {
                    current["version"] != definition["version"]
                        || current["identity"] != definition["identity"]
                }) {
                    return Err(Error::template("TOOL_DISCOVERY", TextId::ContextDiscoveryUnavailableCommit, &[]));
                }
            }
        }
        for discovery in record["discoveries"].as_array().into_iter().flatten() {
            for definition in discovery["definitions"].as_array().into_iter().flatten() {
                self.discovered.insert(
                    definition["definition"]["name"].as_str().unwrap().into(),
                    definition.clone(),
                );
            }
            self.pending
                .retain(|(id, _)| discovery["callId"] != id.as_str());
        }
        Ok(())
    }
    pub fn normalize(&self, call: &Value) -> (Value, Option<Value>, Option<String>) {
        let (call, origin, error, _) = self.normalize_raw(call, None);
        (call, origin, error)
    }
    pub fn normalize_raw(&self, call: &Value, raw: Option<&str>) -> (Value, Option<Value>, Option<String>, bool) {
        let reject = |id: TextId, format: bool| (call.clone(), None, Some(self.harness.text(id).into()), format);
        if call["name"] != "CallTool" || !self.discovery_entries {
            return (call.clone(), None, self.catalog.deferred.contains_key(call["name"].as_str().unwrap_or("")).then(|| self.harness.text(TextId::ContextDiscoveryDirectCallForbidden).into()), false);
        }
        let invocation = match super::invocation::decode(&call["input"], raw) {
            Ok(invocation) => invocation,
            Err(failure) => {
                use super::invocation::Failure;
                let id = match failure {
                    Failure::MissingTarget => TextId::ContextDiscoveryInvalidCall,
                    Failure::InvalidEnvelope => TextId::ContextDiscoveryInvalidCall,
                    Failure::InvalidArguments => TextId::ContextDiscoveryInvalidObject,
                    Failure::ConflictingKeys => TextId::ContextDiscoveryConflictingKeys,
                    Failure::Limit => TextId::ContextDiscoveryDecodeLimit,
                    Failure::Incomplete => TextId::ContextDiscoveryInvalidJson,
                };
                tracing::warn!(call_id=%call["id"], reason=?failure, "CallTool input was rejected before execution");
                return reject(id, true);
            }
        };
        let Some(definition) = self.catalog.deferred.get(&invocation.target) else {
            if serde_json::from_str::<Value>(&invocation.target).is_ok_and(|value| value.is_object() || value.is_array()) {
                return reject(TextId::ContextDiscoveryTargetIsJson, true);
            }
            return reject(TextId::ContextDiscoveryUnavailableTarget, false);
        };
        if self.discovered.get(&invocation.target).is_none_or(|loaded| loaded["version"] != definition["version"] || loaded["identity"] != definition["identity"]) {
            return reject(TextId::ContextDiscoveryUndiscovered, false);
        }
        let mut origin = json!({"id":call["id"],"definitionVersion":definition["version"],"input":invocation.original});
        if let Some(raw) = invocation.raw_input { origin["rawInput"] = json!(raw); }
        if !invocation.normalization.is_empty() { origin["normalization"] = json!(invocation.normalization); }
        (json!({"type":"tool_use","id":call["id"],"name":invocation.target,"input":invocation.input}), Some(origin), None, false)
    }
    pub fn search(&mut self, input: &Value, call_id: &str) -> Value {
        if call_id.is_empty() {
            return problem(self.harness.text(TextId::ContextDiscoveryMissingId));
        }
        if let Some((_, prior)) = self.pending.iter().find(|(id, _)| id == call_id) {
            return json!({"content":prior.content,"isError":false});
        }
        if input["query"].as_str().is_some_and(|query| {
            utf16_len(query) > QUERY_CHARACTERS * 2 || query.chars().count() > QUERY_CHARACTERS
        }) {
            tracing::warn!(
                call_id,
                limit = QUERY_CHARACTERS,
                "Tool search query exceeds its input bound"
            );
            return problem(self.harness.text(TextId::ContextDiscoveryQueryLimit));
        }
        if input["query"]
            .as_str()
            .is_none_or(|query| trim_js(query).is_empty())
            || input
                .get("server")
                .is_some_and(|server| !server.is_string())
            || input.get("max_results").is_some_and(|max| {
                max.as_f64()
                    .is_none_or(|max| max.fract() != 0.0 || !(1.0..=10.0).contains(&max))
            })
        {
            return problem(
                self.harness.text(TextId::ContextDiscoveryInvalidSearch),
            );
        }
        let query = input["query"].as_str().unwrap();
        let matches = self.catalog.search(query, input["server"].as_str());
        let explicit = query.starts_with("select:");
        let mut selected = Vec::<Value>::new();
        let mut display = Vec::new();
        let mut guides: HashSet<String> = self.discovered.values().map(guide_key).collect();
        let mut omitted = 0usize;
        for candidate in matches
            .into_iter()
            .take(input["max_results"].as_u64().unwrap_or(5) as usize)
        {
            let name = candidate["definition"]["name"].as_str().unwrap();
            let known = self.discovered.contains_key(name);
            let key = guide_key(&candidate);
            let item = if known && !explicit {
                json!({"tool":name,"version":candidate["version"],"already_loaded":true})
            } else {
                render_item(
                    &candidate,
                    candidate["usageGuide"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
                        && !guides.contains(&key),
                )
            };
            let mut with = display.clone();
            with.push(item.clone());
            let candidate_text = stringify(&payload(with, 1,&self.harness));
            let mut reserved = self.discovered.clone();
            for definition in self
                .pending
                .iter()
                .flat_map(|(_, pending)| pending.definitions.iter())
                .chain(selected.iter())
                .chain((!known).then_some(&candidate))
            {
                reserved.insert(
                    definition["definition"]["name"].as_str().unwrap().into(),
                    definition.clone(),
                );
            }
            let definitions: Vec<_> = reserved.values().cloned().collect();
            let recovery = self.render_recovery(&definitions);
            if utf16_len(&candidate_text) > self.result_characters
                || candidate_text.len() > SEARCH_BYTES
                || stable_json(&json!(definitions)).len() > STATE_BYTES
                || estimate_tokens(&recovery) > self.recovery_tokens
            {
                omitted += 1;
                continue;
            }
            display.push(item);
            guides.insert(key);
            if !known {
                selected.push(candidate);
            }
        }
        let body = payload(display, omitted,&self.harness);
        let content = stringify(&body);
        if omitted > 0 {
            tracing::warn!(
                call_id,
                omitted,
                result_characters = self.result_characters,
                recovery_tokens = self.recovery_tokens,
                "Complete tool definitions did not fit the discovery budget"
            );
        }
        if utf16_len(&content) > self.result_characters {
            return problem(self.harness.text(TextId::ContextDiscoveryResultBudget));
        }
        self.pending.push((
            call_id.into(),
            Pending {
                content: content.clone(),
                rendered: content.clone(),
                prefix: String::new(),
                suffix: String::new(),
                explicit,
                settled: false,
                definitions: selected,
                payload: body,
            },
        ));
        json!({"content":content,"isError":false})
    }
    pub fn settle(&mut self, call_id: &str, result: Value, prefix: &str, suffix: &str) -> (Value, Option<Value>) {
        let (result, record, _) = self.settle_receipt(call_id, result, prefix, suffix);
        (result, record)
    }
    pub fn settle_receipt(
        &mut self,
        call_id: &str,
        result: Value,
        prefix: &str,
        suffix: &str,
    ) -> (Value, Option<Value>, bool) {
        let Some(index) = self.pending.iter().position(|(id, _)| id == call_id) else {
            return (result, None, false);
        };
        let pending = &mut self.pending[index].1;
        let content = result["content"].as_str().unwrap_or("");
        let expected = utf16_len(prefix) + utf16_len(&pending.content) + utf16_len(suffix);
        let reason = if result["isError"] == true {
            Some("tool-error")
        } else if expected > self.result_characters {
            Some("character-budget")
        } else if utf16_len(content) != expected {
            Some("payload-changed")
        } else if content.len() > SEARCH_BYTES {
            Some("byte-budget")
        } else if content != format!("{prefix}{}{suffix}", pending.content) {
            Some("payload-changed")
        } else {
            None
        };
        if let Some(reason) = reason {
            self.pending.remove(index);
            tracing::warn!(
                call_id,
                reason,
                "Tool discovery result was rejected; definitions were not committed"
            );
            let result = json!({"content":truncate_content_with_harness(self.harness.text(TextId::ContextDiscoveryRejectedResult),self.result_characters.min(SEARCH_BYTES),recovery_hint(&self.harness),&self.harness),"isError":true});
            return (result, None, true);
        }
        pending.settled = true;
        pending.rendered = content.into();
        pending.prefix = prefix.into();
        pending.suffix = suffix.into();
        let shown: Vec<_> = pending.payload["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item.get("arguments_schema").is_some())
            .collect();
        let mut record = json!({"version":2});
        if !pending.definitions.is_empty() {
            record["discoveries"] = json!([{"callId":call_id,"definitions":pending.definitions}]);
        }
        if !shown.is_empty() {
            let mut presentation = json!({"callId":call_id,"definitions":shown.iter().map(|item|item["version"].clone()).collect::<Vec<_>>(),"guides":shown.iter().filter(|item|item.get("usage_guide").is_some()).map(|item|item["version"].clone()).collect::<Vec<_>>()});
            presentation.as_object_mut().unwrap().extend(
                span(prefix, suffix, &pending.content)
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            record["presentations"] = json!([presentation]);
        }
        let has_record = record.as_object().unwrap().len() > 1;
        (result, has_record.then_some(record), false)
    }
    pub fn recovery_message(&self) -> Value {
        json!({"role":"user","content":self.render_recovery(&self.discovered.values().cloned().collect::<Vec<_>>()),"isMeta":true,"toolContext":{"version":2,"baseline":self.snapshot(),"baselineAttachment":true}})
    }
    fn render_recovery(&self, definitions: &[Value]) -> String {
        if self.catalog.directory.is_empty() && definitions.is_empty() {
            return if self.discovery_entries {
                self.harness.text(TextId::ContextDiscoveryNoServices).into()
            } else {
                String::new()
            };
        }
        let mut guides = HashSet::new();
        let rendered: Vec<_> = definitions
            .iter()
            .map(|item| {
                let include = item["usageGuide"]
                    .as_str()
                    .is_some_and(|guide| !guide.is_empty())
                    && guides.insert(guide_key(item));
                render_item(item, include)
            })
            .collect();
        self.harness.render(TextId::ContextDiscoveryRecovery,&[("directory",&self.catalog.directory),("definitions",&stringify(&presentation::payload(rendered)))])
    }
    pub fn finalize_results(&mut self, message: &mut Value) -> Result<()> {
        self.finalize_results_receipt(message).map(|_| ())
    }
    pub fn finalize_results_receipt(&mut self, message: &mut Value) -> Result<Option<Vec<usize>>> {
        let Some(blocks) = message["content"].as_array_mut() else {
            return Ok(None);
        };
        if !blocks.iter().any(|block| {
            block["type"] == "tool_result"
                && self
                    .pending
                    .iter()
                    .any(|(id, _)| block["tool_use_id"] == id.as_str())
        }) {
            return Ok(None);
        }
        let mut known: HashSet<String> = self
            .discovered
            .values()
            .filter_map(|item| item["version"].as_str().map(str::to_owned))
            .collect();
        let mut guides: HashSet<String> = self.discovered.values().map(guide_key).collect();
        let mut discoveries = Vec::new();
        let mut presentations = Vec::new();
        let mut updates = Vec::new();
        let mut interrupted = Vec::new();
        for (block_index, block) in blocks.iter().enumerate() {
            if block["type"] != "tool_result" || block["is_error"] == true {
                continue;
            }
            let Some(index) = self
                .pending
                .iter()
                .position(|(id, _)| block["tool_use_id"] == id.as_str())
            else {
                continue;
            };
            let (call_id, pending) = &self.pending[index];
            if !pending.settled {
                interrupted.push((block_index,call_id.clone(),truncate_content_with_harness(self.harness.text(TextId::ContextDiscoveryInterrupted),self.result_characters.min(SEARCH_BYTES).min(block["content"].as_str().map(utf16_len).unwrap_or(self.result_characters)),recovery_hint(&self.harness),&self.harness)));
                continue;
            }
            if block["content"] != pending.rendered {
                continue;
            }
            let mut definitions = Vec::new();
            let mut tools = Vec::new();
            for item in pending.payload["targets"].as_array().unwrap() {
                let Some(definition) = self
                    .catalog
                    .deferred
                    .get(item["tool"].as_str().unwrap_or(""))
                else {
                    tools.push(item.clone());
                    continue;
                };
                if definition["version"] != item["version"] || item.get("arguments_schema").is_none() {
                    tools.push(item.clone());
                    continue;
                }
                let version = definition["version"].as_str().unwrap();
                if known.contains(version) && !pending.explicit {
                    tools.push(json!({"tool":definition["definition"]["name"],"version":version,"already_loaded":true}));
                    continue;
                }
                if !known.contains(version) {
                    let Some(candidate) = pending
                        .definitions
                        .iter()
                        .find(|candidate| candidate["version"] == version)
                    else {
                        return Err(Error::template("TOOL_DISCOVERY", TextId::ContextDiscoveryMissingResultSnapshot, &[]));
                    };
                    definitions.push(candidate.clone());
                    known.insert(version.into());
                }
                let mut item = item.clone();
                if crate::js::truthy(&item["usage_guide"]) && !guides.insert(guide_key(definition))
                {
                    item.as_object_mut().unwrap().shift_remove("usage_guide");
                }
                tools.push(item);
            }
            let mut payload = pending.payload.clone();
            payload["targets"] = json!(tools);
            let payload_text = stringify(&payload);
            let content = format!("{}{}{}", pending.prefix, payload_text, pending.suffix);
            if utf16_len(&content) > utf16_len(&pending.rendered)
                || content.len() > pending.rendered.len()
            {
                return Err(Error::template("TOOL_DISCOVERY", TextId::ContextDiscoveryFinalizationBudget, &[]));
            }
            if !definitions.is_empty() {
                discoveries.push(json!({"callId":call_id,"definitions":definitions}));
            }
            let shown: Vec<_> = tools
                .iter()
                .filter(|item| item.get("arguments_schema").is_some())
                .collect();
            if !shown.is_empty() {
                let mut presentation = json!({"callId":call_id,"definitions":shown.iter().map(|item|item["version"].clone()).collect::<Vec<_>>(),"guides":shown.iter().filter(|item|item.get("usage_guide").is_some()).map(|item|item["version"].clone()).collect::<Vec<_>>()});
                presentation.as_object_mut().unwrap().extend(
                    span(&pending.prefix, &pending.suffix, &payload_text)
                        .as_object()
                        .unwrap()
                        .clone(),
                );
                presentations.push(presentation);
            }
            updates.push((
                block_index,
                call_id.clone(),
                content,
                payload_text,
                payload,
                definitions,
            ));
        }
        let changed = interrupted.iter().map(|item| item.0).chain(updates.iter().map(|item| item.0)).collect();
        for (index, call_id, content) in interrupted {
            blocks[index]["content"] = json!(content);
            blocks[index]["is_error"] = json!(true);
            self.pending.retain(|(id, _)| id != &call_id);
            tracing::warn!(call_id, "Unsettled tool discovery result was discarded");
        }
        for (index, call_id, content, payload_text, payload, definitions) in updates {
            blocks[index]["content"] = json!(content);
            if let Some((_, pending)) = self.pending.iter_mut().find(|(id, _)| id == &call_id) {
                pending.content = payload_text;
                pending.rendered = content;
                pending.payload = payload;
                pending.definitions = definitions;
            }
        }
        let mut record = message
            .get("toolContext")
            .cloned()
            .unwrap_or(json!({"version":2}));
        record["version"] = json!(2);
        for key in ["discoveries", "presentations"] {
            record.as_object_mut().unwrap().shift_remove(key);
        }
        if !discoveries.is_empty() {
            record["discoveries"] = json!(discoveries);
        }
        if !presentations.is_empty() {
            record["presentations"] = json!(presentations);
        }
        if record.as_object().unwrap().len() > 1 {
            message["toolContext"] = record;
        } else {
            message.as_object_mut().unwrap().shift_remove("toolContext");
        }
        Ok(Some(changed))
    }
    pub fn clear(&mut self) {
        self.discovered.clear();
        self.pending.clear();
        self.baseline_pending = true;
    }
    pub fn finish_step(&mut self) {
        self.pending.clear();
    }
    pub fn has_search_result(&self,call_id:&str)->bool{self.pending.iter().any(|(id,_)|id==call_id)}
}
