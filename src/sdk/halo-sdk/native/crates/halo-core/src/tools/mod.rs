mod direct;
mod file;
mod glob_matcher;
pub mod mcp;
mod mcp_sse;
mod process_retirement;
mod search;
mod shell;
mod shell_external;
mod shell_platform;
mod shell_retention;
mod skill;
mod supplied;
mod web;
mod working_state;
use crate::harness::{Harness, ResolvedHarness, ResourceId, TextId};
use crate::{
    bridge::{EventSink, HostBridge},
    error::{Error, Result},
};
pub use direct::DirectToolOwner;
pub use file::{FileAdmission, FileAdmissionPreparation, FileReadStateStore};
pub use process_retirement::ProcessRetirement;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, RwLock,
};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;
pub use working_state::{render_goal, WorkingState};
const BUILTIN_NAMES: [&str; 13] = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "WebFetch",
    "Skill",
    "Goal",
    "TodoWrite",
    "TaskStop",
    "TaskOutput",
    "AskUserQuestion",
];
fn builtin_permission(name: &str) -> &'static str {
    match name {
        "Read" | "Glob" | "Grep" | "WebFetch" | "CodeSearch" => "readonly",
        "Write" | "Edit" => "write",
        "Skill" | "Goal" | "TodoWrite" | "TaskOutput" | "AskUserQuestion" => "none",
        _ => "execute",
    }
}
fn builtin_concurrency_safe(name: &str) -> bool {
    ["Read", "Glob", "Grep", "WebFetch", "Skill", "CodeSearch"].contains(&name)
}
pub fn builtin_descriptors() -> Vec<Value> {
    let definitions = crate::harness::baseline().resource(ResourceId::ToolDefinitions);
    BUILTIN_NAMES.iter().map(|name| {
        let definition = definitions.as_array().unwrap().iter().find(|definition| definition["name"] == *name).unwrap();
        let mut descriptor = json!({"name":name,"description":definition["description"],"inputSchema":definition["input_schema"],"permissionLevel":builtin_permission(name),"concurrencySafe":builtin_concurrency_safe(name),"freshInstance":(["Read","Write","Edit","Glob","Grep"].contains(name))});
        if *name == "AskUserQuestion" { descriptor["requiresUserInteraction"] = json!(true); }
        descriptor
    }).collect()
}
#[derive(Clone)]
pub struct ToolContext {
    pub session_id: String,
    pub cwd: String,
    pub env: Value,
    pub current_turn: u32,
    pub tool_use_id: String,
    pub cancellation: CancellationToken,
    pub harness: Arc<ResolvedHarness>,
}
#[derive(Clone)]
pub struct SelectedTool {
    pub definition: Value,
    mcp: Option<mcp::ManagedTool>,
    source: Option<Value>,
}
impl SelectedTool {
    pub fn unbound(mut definition: Value) -> Self {
        let source = definition
            .as_object_mut()
            .and_then(|definition| definition.remove("mcpSource"));
        Self {
            definition,
            mcp: None,
            source,
        }
    }
    pub fn catalog_entry(&self) -> Value {
        let mut definition = self.definition.clone();
        if let Some(source) = &self.source {
            definition["mcpSource"] = source.clone();
        }
        definition
    }
}
pub struct ToolRuntime {
    options: Value,
    bridge: Arc<dyn HostBridge>,
    definitions: Vec<Value>,
    files: file::FileTools,
    shell: Arc<shell::ShellTools>,
    owns_shell: AtomicBool,
    web: web::WebTool,
    mcp: mcp::McpTools,
    owns_mcp: bool,
    borrowed_denied: Vec<String>,
    collaboration: Option<Arc<dyn crate::collaboration::CollaborationTools>>,
    catalog: Value,
    working: Arc<WorkingState>,
    code_search: Option<Arc<crate::search::CodeSearchService>>,
    external_code_search: bool,
    owns_code_search: bool,
    processes: Arc<crate::processes::OwnedProcesses>,
    text: RwLock<(Option<Arc<ResolvedHarness>>, u64)>,
    supplied: RwLock<Option<Arc<supplied::SuppliedTools>>>,
    supplied_revision: AtomicU64,
}
#[derive(Clone)]
pub struct BorrowedMcp {
    manager: mcp::McpTools,
    denied: Vec<String>,
}
#[derive(Clone)]
pub struct BorrowedSearch(Arc<crate::search::CodeSearchService>);
#[derive(Clone)]
pub struct ToolCheckpoint {
    shell: Arc<shell::ShellTools>,
    reads: Value,
    working: Value,
}
impl ToolCheckpoint {
    pub fn abort_now(&self) {
        self.shell.abort_now();
    }
    pub async fn interrupt(&self) {
        self.shell.interrupt().await;
    }
    pub async fn close(&self) {
        self.shell.close().await;
    }
}
impl ToolRuntime {
    pub fn new(options: Value, bridge: Arc<dyn HostBridge>, _events: Arc<dyn EventSink>) -> Self {
        Self::new_with_working_state(options, bridge, _events, None)
    }
    pub fn new_with_working_state(
        options: Value,
        bridge: Arc<dyn HostBridge>,
        _events: Arc<dyn EventSink>,
        working: Option<Arc<WorkingState>>,
    ) -> Self {
        let shell = Arc::new(shell::ShellTools::new_with_activity(
            &options,
            bridge.resource_activity(),
        ));
        let external_code_search = options["nativeCodeSearchBridge"] == true
            && crate::js::truthy(&options["codeSearch"])
            && options["tools"]
                .as_array()
                .is_none_or(|tools| tools.iter().any(|tool| tool == "CodeSearch"))
            && !options["disallowedTools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool == "CodeSearch"))
            && !options["customTools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == "CodeSearch"));
        Self {
            files: file::FileTools::new(&options, bridge.clone()),
            working: working.unwrap_or_else(|| Arc::new(WorkingState::new(&options))),
            mcp: mcp::McpTools::new(bridge.clone()),
            owns_mcp: true,
            borrowed_denied: Vec::new(),
            collaboration: None,
            external_code_search,
            options,
            bridge,
            definitions: Vec::new(),
            shell,
            owns_shell: AtomicBool::new(true),
            web: Default::default(),
            catalog: json!([]),
            code_search: None,
            owns_code_search: true,
            processes: Arc::new(crate::processes::OwnedProcesses::default()),
            text: RwLock::new((None, 0)),
            supplied: RwLock::new(None),
            supplied_revision: AtomicU64::new(0),
        }
    }
    pub fn attach_collaboration(
        &mut self,
        binding: Arc<dyn crate::collaboration::CollaborationTools>,
    ) {
        self.collaboration = Some(binding);
    }
    pub fn set_harness(&self, harness: Arc<ResolvedHarness>) {
        let mut text = self.text.write().unwrap_or_else(|error| error.into_inner());
        if text
            .0
            .as_ref()
            .is_some_and(|previous| !Arc::ptr_eq(previous, &harness))
        {
            text.1 += 1;
        }
        text.0 = Some(harness);
    }
    pub fn resolved_harness(&self) -> Arc<ResolvedHarness> {
        self.text
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .0
            .clone()
            .unwrap_or_else(crate::harness::baseline)
    }
    pub fn read_deny_roots(&self) -> Vec<String> {
        self.files
            .deny
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }
    pub fn attach_read_deny_floor(&mut self, roots: &[String]) {
        for root in roots {
            let path = file::real_path(std::path::Path::new(root));
            if !self.files.deny.contains(&path) {
                self.files.deny.push(path);
            }
        }
    }
    pub fn borrowed_mcp(&self) -> BorrowedMcp {
        let mut denied = self.borrowed_denied.clone();
        if let Some(values) = self.options["disallowedTools"].as_array() {
            denied.extend(values.iter().filter_map(Value::as_str).map(str::to_owned));
        }
        BorrowedMcp {
            manager: self.mcp.clone(),
            denied,
        }
    }
    pub fn attach_borrowed_mcp(&mut self, borrowed: BorrowedMcp) {
        self.mcp = borrowed.manager;
        self.borrowed_denied = borrowed.denied;
        self.owns_mcp = false;
    }
    pub fn borrowed_search(&self) -> Option<BorrowedSearch> {
        self.code_search
            .as_ref()
            .map(|service| BorrowedSearch(service.clone()))
    }
    pub fn attach_borrowed_search(&mut self, borrowed: BorrowedSearch) {
        self.code_search = Some(borrowed.0);
        self.owns_code_search = false;
    }
    pub fn retire_working_state(&self) -> ToolCheckpoint {
        self.owns_shell.store(false, Ordering::Release);
        ToolCheckpoint {
            shell: self.shell.clone(),
            reads: self
                .files
                .context_call("readFileState.entries", &json!([]))
                .expect("known file state operation"),
            working: self.working.capture(),
        }
    }
    pub fn restore_working_state(&mut self, checkpoint: &ToolCheckpoint) -> Result<()> {
        self.shell = checkpoint.shell.clone();
        self.owns_shell.store(false, Ordering::Release);
        self.files.context_call("readFileState.clear", &json!([]))?;
        if let Some(entries) = checkpoint.reads.as_array() {
            for entry in entries {
                self.files.context_call("readFileState.set", entry)?;
            }
        }
        self.working.restore(&checkpoint.working);
        Ok(())
    }
    pub async fn initialize(&mut self, cancel: &CancellationToken) -> Result<()> {
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        if self
            .text
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .0
            .is_none()
        {
            self.set_harness(
                Harness::from_config(&self.options["harnessText"])?
                    .for_model(self.options["model"].as_str().unwrap_or("")),
            );
        }
        if let Some(descriptors) = self.options.get("nativeSuppliedTools") {
            let descriptors = descriptors
                .as_array()
                .ok_or_else(|| {
                    Error::template(
                        "INVALID_SUPPLIED_TOOLS",
                        TextId::ToolsSuppliedArrayRequired,
                        &[],
                    )
                })?
                .clone();
            self.replace_supplied_tools(descriptors)?;
            let enabled = self
                .supplied
                .read()
                .unwrap()
                .as_ref()
                .unwrap()
                .contains("Skill");
            self.catalog = if enabled {
                match self
                    .options
                    .get("skillCatalog")
                    .filter(|value| !crate::js::is_undefined(value))
                {
                    Some(catalog) => crate::skills::snapshot_catalog(catalog)?,
                    None => {
                        crate::skills::resolve_catalog_with_harness(
                            &self.options,
                            &self.resolved_harness(),
                        )
                        .await?
                    }
                }
            } else {
                json!([])
            };
            return Ok(());
        }
        if self.collaboration.is_some() && self.options["mcpServers"].get("halo-team").is_some() {
            return Err(Error::template(
                "COLLABORATION_OWNER",
                TextId::CollaborationSetupOwnerConflict,
                &[],
            ));
        }
        if let Some(search) = self
            .options
            .get("codeSearch")
            .filter(|v| crate::js::truthy(v) && self.owns_code_search)
        {
            if let Some(cache) = code_search_cache_root(&self.options)? {
                if !self.files.deny.contains(&cache) {
                    self.files.deny.push(cache);
                }
            }
            let selected = self.options["tools"]
                .as_array()
                .is_none_or(|tools| tools.iter().any(|v| v == "CodeSearch"));
            let denied = self.options["disallowedTools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|v| v == "CodeSearch"));
            if selected && !denied && self.custom("CodeSearch").is_none() {
                let mut configuration = search.clone();
                configuration["nativeProcessEnv"] =
                    crate::core::conventions::process_environment(&self.options);
                if !self.external_code_search {
                    self.code_search =
                        Some(Arc::new(crate::search::CodeSearchService::new_with_pool(
                            configuration,
                            self.bridge
                                .code_search_pool()
                                .unwrap_or_else(crate::search::default_pool),
                        )?));
                }
            }
        }
        let explicit_catalog = self
            .options
            .get("skillCatalog")
            .filter(|catalog| !crate::js::is_undefined(catalog))
            .map(crate::skills::snapshot_catalog)
            .transpose()?;
        let skill_enabled = (self.custom("Skill").is_some()
            || self.options["tools"]
                .as_array()
                .is_none_or(|tools| tools.iter().any(|tool| tool == "Skill")))
            && !self.options["disallowedTools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool == "Skill"));
        self.catalog = if skill_enabled {
            match explicit_catalog {
                Some(catalog) => catalog,
                None => {
                    crate::skills::resolve_catalog_with_harness(
                        &self.options,
                        &self.resolved_harness(),
                    )
                    .await?
                }
            }
        } else {
            json!([])
        };
        let all = self
            .resolved_harness()
            .resource(ResourceId::ToolDefinitions);
        let all = all.as_array().expect("builtin tool resource is an array");
        let selection = self.options["tools"].as_array();
        self.definitions = BUILTIN_NAMES
            .iter()
            .filter(|name| selection.is_none_or(|s| s.iter().any(|n| n.as_str() == Some(name))))
            .filter_map(|name| all.iter().find(|v| v["name"] == *name).cloned())
            .collect();
        if (self.code_search.is_some()
            || self.external_code_search && crate::js::truthy(&self.options["codeSearch"]))
            && selection.is_none_or(|tools| tools.iter().any(|tool| tool == "CodeSearch"))
        {
            self.definitions.push(
                self.resolved_harness()
                    .resource(ResourceId::CodeSearchDefinition),
            );
        }
        if let Some(custom) = self.options["customTools"].as_array() {
            self.definitions
                .retain(|definition| !custom.iter().any(|tool| definition["name"] == tool["name"]));
            for tool in custom {
                self.definitions.push(json!({"name":tool["name"],"description":tool["description"],"input_schema":tool["inputSchema"]}));
            }
        }
        if self.owns_mcp {
            self.mcp.initialize(&self.options, cancel).await?;
        }
        if let Some(denied) = self.options["disallowedTools"].as_array() {
            self.definitions
                .retain(|t| !denied.iter().any(|d| d == &t["name"]));
        }
        Ok(())
    }
    pub fn catalog_tools(&self) -> Vec<Value> {
        self.catalog_selection()
            .into_iter()
            .map(|tool| tool.catalog_entry())
            .collect()
    }
    fn catalog_selection(&self) -> Vec<SelectedTool> {
        if let Some(supplied) = self.supplied.read().unwrap().as_ref().cloned() {
            return supplied
                .definitions(&self.resolved_harness())
                .into_iter()
                .map(SelectedTool::unbound)
                .collect();
        }
        let custom = self.options["customTools"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let custom_names: std::collections::HashSet<_> = custom
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        let mut definitions: Vec<Value> = self
            .definitions
            .iter()
            .filter(|definition| !custom_names.contains(definition["name"].as_str().unwrap_or("")))
            .cloned()
            .collect();
        let harness = self.resolved_harness();
        if !definitions.is_empty() {
            let builtin = harness.resource(ResourceId::ToolDefinitions);
            for definition in &mut definitions {
                let name = definition["name"].as_str().unwrap_or("");
                if name == "CodeSearch" {
                    *definition = harness.resource(ResourceId::CodeSearchDefinition);
                } else if let Some(current) = builtin
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|current| current["name"] == name)
                {
                    *definition = current.clone();
                }
            }
        }
        for source in custom {
            let mut definition = if source["__haloSdkNativeToolDefinition"]
                == "CodeSearchDefinition"
            {
                harness.resource(ResourceId::CodeSearchDefinition)
            } else {
                json!({"name":source["name"],"description":source["description"],"input_schema":source["inputSchema"]})
            };
            if let Some(metadata) = source.get("mcpSource") {
                definition["mcpSource"] = metadata.clone();
            }
            definitions.push(definition);
        }
        if let Some(binding) = self
            .collaboration
            .as_ref()
            .filter(|binding| binding.inherited())
        {
            definitions.extend(binding.definitions_with_harness(&harness));
        }
        let mut definitions: Vec<SelectedTool> =
            definitions.into_iter().map(SelectedTool::unbound).collect();
        definitions.extend(self.mcp.selected_tools().into_iter().map(|tool| {
            let mut selected = SelectedTool::unbound(tool.definition(&harness));
            selected.mcp = Some(tool);
            selected
        }));
        if let Some(binding) = self
            .collaboration
            .as_ref()
            .filter(|binding| !binding.inherited())
        {
            definitions.extend(
                binding
                    .definitions_with_harness(&harness)
                    .into_iter()
                    .map(SelectedTool::unbound),
            );
        }
        if let Some(denied) = self.options["disallowedTools"].as_array() {
            definitions.retain(|t| !denied.iter().any(|d| d == &t.definition["name"]));
        }
        definitions.retain(|tool| {
            !self
                .borrowed_denied
                .iter()
                .any(|name| tool.definition["name"] == *name)
        });
        definitions
    }
    pub fn definitions(&self) -> Vec<Value> {
        self.selected_tools()
            .into_iter()
            .map(|tool| tool.definition)
            .collect()
    }
    pub fn selected_tools(&self) -> Vec<SelectedTool> {
        self.catalog_selection()
    }
    pub async fn execute_selected(
        &self,
        tool: &SelectedTool,
        input: Value,
        ctx: ToolContext,
    ) -> Result<Value> {
        if let Some(binding) = &tool.mcp {
            return binding
                .execute(input, &ctx.cancellation, &ctx.harness)
                .await;
        }
        self.execute(tool.definition["name"].as_str().unwrap_or(""), input, ctx)
            .await
    }
    pub fn tool_catalog_revision(&self) -> u64 {
        self.mcp.revision()
            + self.supplied_revision.load(Ordering::Acquire)
            + self
                .text
                .read()
                .unwrap_or_else(|error| error.into_inner())
                .1
    }
    pub async fn reconnect_mcp(&self, server: &str, cancel: &CancellationToken) -> Result<()> {
        self.mcp.reconnect(server, cancel).await?;
        self.mcp.validate_names()
    }
    pub async fn toggle_mcp(
        &self,
        server: &str,
        enabled: bool,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.mcp.toggle(server, enabled, cancel).await?;
        self.mcp.validate_names()
    }
    pub async fn set_mcp_servers(
        &self,
        servers: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let result = self
            .mcp
            .set_servers(&servers, cancel, &self.resolved_harness())
            .await?;
        self.mcp.validate_names()?;
        Ok(result)
    }
    pub async fn execute_with_definition(
        &self,
        name: &str,
        input: Value,
        ctx: ToolContext,
        expected_definition: &Value,
    ) -> Result<Value> {
        let supplied = self.supplied.read().unwrap().is_some();
        if supplied {
            return self.execute(name, input, ctx).await;
        }
        if name.starts_with("mcp__halo-team__")
            && self.collaboration.is_some()
            && self.custom(name).is_none()
        {
            return self
                .collaboration
                .as_ref()
                .unwrap()
                .call_with_harness(name, input, &ctx.cancellation, ctx.harness.clone())
                .await;
        }
        if name.starts_with("mcp__") && self.custom(name).is_none() {
            self.mcp
                .execute(
                    name,
                    input,
                    &ctx.cancellation,
                    Some(expected_definition),
                    &ctx.harness,
                )
                .await
        } else {
            self.execute(name, input, ctx).await
        }
    }
    pub fn skill_catalog(&self) -> &Value {
        &self.catalog
    }
    pub fn skill_catalog_scope<'a>(&self, harness: &'a ResolvedHarness) -> &'a str {
        if self.options.get("skillCatalog").is_some_and(|value| !crate::js::is_undefined(value)) {
            "explicit"
        } else { harness.scope() }
    }
    pub fn skill_catalog_with_harness(&self, harness: &ResolvedHarness) -> Value {
        let mut catalog = self.catalog.clone();
        if self
            .options
            .get("skillCatalog")
            .is_some_and(|value| !crate::js::is_undefined(value))
        {
            return catalog;
        }
        let builtins = crate::skills::builtin_definitions_with_harness(harness);
        if let Some(entries) = catalog.as_array_mut() {
            for entry in entries
                .iter_mut()
                .filter(|entry| entry["source"]["kind"] == "builtin")
            {
                if let Some(definition) = builtins
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|definition| definition["name"] == entry["source"]["name"])
                {
                    for key in ["description", "argumentHint"] {
                        if let Some(value) = definition.get(key) {
                            entry[key] = value.clone();
                        }
                    }
                }
            }
        }
        catalog
    }
    pub fn mcp_statuses(&self) -> Vec<Value> {
        self.mcp_statuses_with_harness(&self.resolved_harness())
    }
    pub fn mcp_statuses_with_harness(&self, harness: &ResolvedHarness) -> Vec<Value> {
        let mut statuses = self.mcp.statuses_with_harness(harness);
        if self.collaboration.is_some() {
            statuses.push(json!({"name":"halo-team","status":"connected"}));
        }
        statuses
    }
    pub fn mcp_instructions(&self) -> String {
        self.mcp.instructions()
    }
    pub fn permission_level(&self, name: &str) -> &str {
        if let Some(tool) = self.supplied_tool(name) {
            return match tool.descriptor["permissionLevel"].as_str() {
                Some("none") => "none",
                Some("readonly") => "readonly",
                Some("write") => "write",
                _ => "execute",
            };
        }
        if let Some(tool) = self.custom(name) {
            return tool["permissionLevel"].as_str().unwrap_or("execute");
        }
        builtin_permission(name)
    }
    pub fn requires_user_interaction(&self, name: &str) -> bool {
        if let Some(tool) = self.supplied_tool(name) {
            return tool.descriptor["requiresUserInteraction"] == true;
        }
        name == "AskUserQuestion"
            || self
                .custom(name)
                .is_some_and(|t| t["requiresUserInteraction"] == true)
    }
    pub fn is_concurrency_safe(&self, name: &str, _input: &Value) -> bool {
        if let Some(tool) = self.supplied_tool(name) {
            if tool.descriptor["isConcurrencySafe"]["__haloSdkNativeCallback"].is_string() {
                return false;
            }
            return tool.descriptor["__haloSdkNativeTool"]["concurrencySafe"]
                .as_bool()
                .unwrap_or_else(|| {
                    tool.implementation
                        .as_deref()
                        .is_some_and(|name| builtin_concurrency_safe(name))
                });
        }
        if self.custom(name).is_some() {
            return false;
        }
        self.collaboration.as_ref().is_some_and(|binding| {
            name.starts_with("mcp__halo-team__") && binding.is_readonly(name)
        }) || builtin_concurrency_safe(name)
            || self
                .mcp
                .tools()
                .iter()
                .any(|t| t.definition["name"] == name && t.hosted && t.readonly)
    }
    pub async fn concurrency_safe(
        &self,
        name: &str,
        input: &Value,
        cancel: &CancellationToken,
    ) -> bool {
        if let Some(tool) = self.supplied_tool(name) {
            if tool.descriptor["isConcurrencySafe"]["__haloSdkNativeCallback"].is_string() {
                return match self
                    .bridge
                    .call(
                        "tools.concurrencySafe",
                        json!({"name":name,"input":input}),
                        cancel,
                    )
                    .await
                {
                    Ok(value) => value == true,
                    Err(error) => {
                        tracing::warn!(name,error=%error,"Tool concurrency classification failed; using exclusive execution");
                        false
                    }
                };
            }
            return self.is_concurrency_safe(name, input);
        }
        if let Some(tool) = self.custom(name) {
            if tool.get("isConcurrencySafe").is_none() {
                return false;
            }
            return match self
                .bridge
                .call(
                    "tools.concurrencySafe",
                    json!({"name":name,"input":input}),
                    cancel,
                )
                .await
            {
                Ok(value) => value == true,
                Err(error) => {
                    tracing::warn!(name,error=%error,"Tool concurrency classification failed; using exclusive execution");
                    false
                }
            };
        }
        self.is_concurrency_safe(name, input)
    }
    pub fn shared_read_state(&self) -> Arc<FileReadStateStore> {
        self.files.shared_read_state()
    }
    pub fn tool_context_call(&self, method: &str, args: Value) -> Result<Value> {
        self.tool_context_call_with_harness(method, args, &self.resolved_harness())
    }
    pub fn tool_context_call_with_harness(
        &self,
        method: &str,
        args: Value,
        harness: &ResolvedHarness,
    ) -> Result<Value> {
        if method == "codeSearch.result" {
            return Ok(format_code_search_result(&args[0], harness));
        }
        if method == "codeSearch.error" {
            return Ok(failure(if args[0].is_null() {
                harness.text(TextId::ToolsCodeSearchUnavailable).to_owned()
            } else {
                Error::from_host(args[0].clone()).render_for(harness)
            }));
        }
        if method == "backgroundTasks.dispose" {
            self.shell.begin_close();
            let shell = self.shell.clone();
            crate::runtime::shared()?.spawn(
                async move {
                    shell.close().await;
                }
                .with_current_subscriber(),
            );
            return Ok(Value::Null);
        }
        if method.starts_with("backgroundTasks.") {
            return self.shell.context_call(method, &args, harness);
        }
        self.files.context_call(method, &args)
    }
    pub async fn tool_context_async_call(
        &self,
        method: &str,
        args: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        self.tool_context_async_call_with_harness(
            method,
            args,
            cancellation,
            self.resolved_harness(),
        )
        .await
    }
    pub async fn tool_context_async_call_with_harness(
        &self,
        method: &str,
        args: Value,
        cancellation: &CancellationToken,
        harness: Arc<ResolvedHarness>,
    ) -> Result<Value> {
        self.shell
            .context_async_call(method, &args, &self.options, cancellation, harness)
            .await
    }
    fn custom(&self, name: &str) -> Option<&Value> {
        self.options["customTools"]
            .as_array()?
            .iter()
            .find(|t| t["name"] == name)
    }
    fn supplied_tool(&self, name: &str) -> Option<Arc<supplied::SuppliedTool>> {
        self.supplied
            .read()
            .unwrap()
            .as_ref()
            .and_then(|tools| tools.get(name))
    }
    pub fn replace_supplied_tools(&self, descriptors: Vec<Value>) -> Result<()> {
        let supplied = Arc::new(supplied::SuppliedTools::new(descriptors)?);
        *self.supplied.write().unwrap() = Some(supplied);
        self.supplied_revision.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    pub fn get_goal(&self) -> Value {
        self.working.get_goal()
    }
    pub fn set_goal(&self, value: Value) -> Result<Value> {
        self.working.set_goal(value)
    }
    pub fn drain_goal_change(&self) -> Value {
        self.working.drain_goal_change()
    }
    pub fn todos(&self) -> Value {
        self.working.todos()
    }
    pub fn discard_persisted_working_state(&self) {
        self.working.discard_persisted();
    }
    pub fn release_working_state(&self) {
        self.working.release();
    }
    pub fn todo_attachment(&self) -> Option<Value> {
        self.working
            .todo_attachment_with_harness(&self.resolved_harness())
    }
    pub async fn execute(&self, name: &str, input: Value, ctx: ToolContext) -> Result<Value> {
        if ctx.cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let supplied = self.supplied_tool(name);
        let exact = self.supplied.read().unwrap().is_some();
        if exact && supplied.is_none() {
            return Ok(failure(
                ctx.harness.render(TextId::ToolsUnknown, &[("name", name)]),
            ));
        }
        if let Some(tool) = supplied
            .as_ref()
            .filter(|tool| tool.descriptor["__haloSdkNativeMcp"].is_object())
        {
            return mcp::public_bridge::invoke(
                &json!({"name":name,"nativeMcp":tool.descriptor["__haloSdkNativeMcp"]}),
                input,
                self.bridge.clone(),
                &ctx.cancellation,
                &ctx.harness,
            )
            .await;
        }
        if supplied
            .as_ref()
            .is_some_and(|tool| tool.implementation.is_none())
            || (!exact && self.custom(name).is_some())
        {
            let mut context = json!({"sessionId":ctx.session_id,"cwd":ctx.cwd,"env":ctx.env,"currentTurn":ctx.current_turn,"toolUseId":ctx.tool_use_id,"nativeContextId":crate::js::stringify(&json!([ctx.session_id,ctx.tool_use_id])),"nativeCatalogOwner":self.options["nativeCatalogOwner"]});
            if self.options["nativeOwner"]["recordFileChange"]["__haloSdkNativeCallback"]
                .is_string()
            {
                context["recordFileChange"] =
                    self.options["nativeOwner"]["recordFileChange"].clone();
            }
            let input_wire = crate::js::wire::WireDocument::encode(
                &crate::js::value::JsValue::from_json(input.clone()),
            )
            .to_json();
            return self
                .bridge
                .call(
                    "tools.execute",
                    json!({"name":name,"input":input,"inputWire":input_wire,"context":context}),
                    &ctx.cancellation,
                )
                .await;
        }
        let implementation = supplied
            .as_ref()
            .and_then(|tool| tool.implementation.as_deref())
            .unwrap_or(name);
        self.execute_implementation(name, implementation, input, ctx, None)
            .await
    }
    pub async fn execute_builtin(
        &self,
        name: &str,
        input: Value,
        ctx: ToolContext,
    ) -> Result<Value> {
        self.execute_builtin_admitted(name, input, ctx, None).await
    }
    pub fn prepare_file_admission(&self, name: &str, input: &Value, cwd: &str) -> Option<FileAdmissionPreparation> {
        self.files.prepare_admission(name, input, cwd)
    }
    pub async fn execute_builtin_admitted(
        &self,
        name: &str,
        input: Value,
        mut ctx: ToolContext,
        admitted: Option<FileAdmission>,
    ) -> Result<Value> {
        ctx.cancellation = direct::execution_cancellation(name, ctx.cancellation);
        self.execute_implementation(name, name, input, ctx, admitted).await
    }
    async fn execute_implementation(
        &self,
        name: &str,
        implementation: &str,
        input: Value,
        ctx: ToolContext,
        admitted: Option<FileAdmission>,
    ) -> Result<Value> {
        let harness = &ctx.harness;
        let result = match implementation {
            "Read" | "Write" | "Edit" => self.files.execute_admitted(implementation, &input, &ctx, admitted).await?,
            "Bash"
                if self.options["nativeOwner"]
                    .get("backgroundTasksPresent")
                    .is_some() =>
            {
                self.shell
                    .execute_external(
                        &input,
                        ctx,
                        &self.options,
                        (self.options["nativeOwner"]["externalBackgroundTasks"] == true)
                            .then_some(&self.bridge),
                    )
                    .await
            }
            "Bash" => self.shell.execute(&input, ctx).await,
            "TaskStop" | "TaskOutput"
                if self.options["nativeOwner"]
                    .get("backgroundTasksPresent")
                    .is_some() =>
            {
                shell_external::task(
                    implementation,
                    &input,
                    &ctx,
                    (self.options["nativeOwner"]["externalBackgroundTasks"] == true)
                        .then_some(&self.bridge),
                )
                .await?
            }
            "TaskStop" | "TaskOutput" => self.shell.task(implementation, &input, &ctx).await,
            "Glob" => search::glob(&input, &ctx, &self.files.deny).await,
            "Grep" => {
                search::grep(
                    &input,
                    &ctx,
                    &self.files.deny,
                    self.processes.clone(),
                    &crate::core::conventions::process_environment(&self.options),
                )
                .await
            }
            "WebFetch" => self.web.execute(&input, &ctx, Some(self.bridge.as_ref())).await,
            "CodeSearch" if self.code_search.is_some() || self.external_code_search => {
                let mut request = input.clone();
                request["root"] = json!(ctx.cwd);
                request["readDenyRoots"] = json!(self.files.deny);
                let result = if self.external_code_search {
                    self.bridge
                        .call("codeSearch.search", request, &ctx.cancellation)
                        .await
                } else {
                    self.code_search
                        .as_ref()
                        .unwrap()
                        .search(request, &ctx.cancellation)
                        .await
                };
                match result {
                    Ok(result) => format_code_search_result(&result, harness),
                    Err(error) if ctx.cancellation.is_cancelled() => return Err(error),
                    Err(error) => failure(error.render_for(harness)),
                }
            }
            "Skill" => {
                skill::execute(
                    &self.skill_catalog_with_harness(&ctx.harness),
                    &input,
                    &ctx.harness,
                )
                .await
            }
            "Goal" => self.working.goal_with_harness(&input, &ctx.harness),
            "TodoWrite" => self.working.set_todos_with_harness(&input, &ctx.harness),
            "AskUserQuestion" => ask_user(&input, &ctx.harness),
            _ if name.starts_with("mcp__halo-team__") && self.collaboration.is_some() => {
                self.collaboration
                    .as_ref()
                    .unwrap()
                    .call_with_harness(name, input, &ctx.cancellation, ctx.harness.clone())
                    .await?
            }
            _ if name.starts_with("mcp__") => {
                self.mcp
                    .execute(name, input, &ctx.cancellation, None, &ctx.harness)
                    .await?
            }
            _ => failure(harness.render(TextId::ToolsUnknown, &[("name", name)])),
        };
        Ok(result)
    }
    pub fn begin_close(&self) {
        if self.owns_shell.load(Ordering::Acquire) {
            self.shell.begin_close();
        }
        if self.owns_mcp {
            self.mcp.disconnect_all();
        }
    }
    pub fn owned_process_count(&self) -> usize {
        self.processes.count()
            + if self.owns_shell.load(Ordering::Acquire) {
                self.shell.process_registry().count()
            } else {
                0
            }
            + if self.owns_mcp {
                self.mcp.owned_process_count()
            } else {
                0
            }
    }
    pub fn process_retirement(&self) -> Arc<ProcessRetirement> {
        let mut owners = vec![self.processes.clone()];
        if self.owns_shell.load(Ordering::Acquire) {
            owners.push(self.shell.process_registry());
        }
        let mut retirement = ProcessRetirement::new(owners, Vec::new());
        if self.owns_mcp {
            retirement.append(self.mcp.process_retirement());
        }
        Arc::new(retirement)
    }
    pub async fn close(&self) -> Result<()> {
        self.web.close();
        if self.owns_shell.load(Ordering::Acquire) {
            self.shell.close().await;
        }
        if self.owns_mcp {
            self.mcp.close().await;
        }
        if self.owns_code_search {
            if let Some(search) = &self.code_search {
                search.dispose().await;
            }
        }
        Ok(())
    }
    pub fn abort_now(&self) {
        self.web.close();
        self.processes.abort_now();
        if self.owns_shell.load(Ordering::Acquire) {
            self.shell.abort_now();
        }
        if self.owns_mcp {
            self.mcp.abort_now();
        }
        if self.owns_code_search {
            if let Some(search) = &self.code_search {
                search.abort_now();
            }
        }
    }
    pub async fn drain_background_notices(&self) -> Vec<String> {
        self.shell.drain_notices(&self.resolved_harness()).await
    }
    pub async fn active_background_tasks(&self) -> usize {
        self.shell.active_count()
    }
    pub async fn stop_task(&self, id: &str) -> bool {
        self.shell.stop(
            id,
            crate::harness::Message::template(TextId::ToolsShellStopped, &[]),
        )
    }
    pub async fn interrupt(&self) {
        self.shell.interrupt().await;
    }
}
fn code_search_cache_root(options: &Value) -> Result<Option<std::path::PathBuf>> {
    let Some(search) = options
        .get("codeSearch")
        .filter(|value| crate::js::truthy(value))
    else {
        return Ok(None);
    };
    let configured = search["cachePath"]
        .as_str()
        .filter(|path| std::path::Path::new(path).is_absolute())
        .ok_or_else(|| {
            Error::template(
                "INVALID_CODE_SEARCH",
                TextId::ToolsCodeSearchAbsoluteCache,
                &[],
            )
            .with_details(json!({"name":"TypeError"}))
        })?;
    let cache = file::real_path(std::path::Path::new(configured));
    let workspace = file::real_path(std::path::Path::new(options["cwd"].as_str().unwrap_or(".")));
    let filesystem_root = cache
        .ancestors()
        .last()
        .unwrap_or(std::path::Path::new(std::path::MAIN_SEPARATOR_STR))
        .to_path_buf();
    let shared = [
        filesystem_root,
        std::path::PathBuf::from(
            options["nativeHomeDirectory"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    home(&json!({
                        "nativeProcessEnv": crate::core::conventions::process_environment(options)
                    }))
                }),
        ),
        crate::core::conventions::temp_dir(options),
        std::path::PathBuf::from("/tmp"),
        std::path::PathBuf::from("/var/tmp"),
    ];
    if file::denied(&cache, &[workspace.clone()])
        || file::denied(&workspace, &[cache.clone()])
        || shared
            .iter()
            .any(|root| file::denied(root, &[cache.clone()]))
    {
        return Err(Error::template(
            "INVALID_CODE_SEARCH",
            TextId::ToolsCodeSearchDedicatedCache,
            &[],
        )
        .with_details(json!({"name":"TypeError"})));
    }
    Ok(Some(cache))
}

pub fn resolve_read_deny_roots(options: &Value) -> Result<Vec<String>> {
    let mut roots = file::deny_roots(options);
    if let Some(cache) = code_search_cache_root(options)? {
        if !roots.contains(&cache) {
            roots.push(cache);
        }
    }
    Ok(roots
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

pub fn format_code_search_result(result: &Value, harness: &ResolvedHarness) -> Value {
    let mut sections = vec![harness.render(
        TextId::ToolsCodeSearchRanked,
        &[("freshness", result["freshness"].as_str().unwrap_or(""))],
    )];
    if let Some(hits) = result["hits"].as_array() {
        for hit in hits {
            sections.push(format!(
                "{}:{}-{}\n{}{}",
                hit["path"].as_str().unwrap_or(""),
                hit["lineStart"],
                hit["lineEnd"],
                hit["snippet"].as_str().unwrap_or(""),
                if hit["truncated"] == true {
                    harness.text(TextId::ToolsCodeSearchSnippetShortened)
                } else {
                    ""
                }
            ));
        }
        if hits.is_empty() {
            sections.push(harness.text(TextId::ToolsCodeSearchNoCandidates).into());
        }
    }
    let mut metadata = json!({"type":"code_search"});
    metadata
        .as_object_mut()
        .unwrap()
        .extend(result.as_object().unwrap().clone());
    success(sections.join("\n\n"), Some(metadata))
}
pub fn success(content: impl Into<String>, metadata: Option<Value>) -> Value {
    let mut value = json!({"content":content.into(),"isError":false});
    if let Some(metadata) = metadata {
        value["metadata"] = metadata;
    }
    value
}
pub fn failure(content: impl Into<String>) -> Value {
    json!({"content":content.into(),"isError":true})
}
pub use crate::core::conventions::{config_dir, home};
pub use crate::core::truncate::truncate_content as truncate;
pub use crate::js::utf16_prefix;
fn ask_user(input: &Value, harness: &ResolvedHarness) -> Value {
    let Some(questions) = input["questions"].as_array().filter(|a| !a.is_empty()) else {
        return failure(harness.text(TextId::ToolsAskMissingQuestions));
    };
    for q in questions {
        let Some(text) = q["question"].as_str().filter(|s| !s.is_empty()) else {
            return failure(harness.text(TextId::ToolsAskMissingQuestion));
        };
        if q["options"]
            .as_array()
            .is_none_or(|options| options.len() < 2)
        {
            return failure(harness.render(TextId::ToolsAskMissingOptions, &[("question", text)]));
        }
    }
    let mut texts = std::collections::HashSet::new();
    for q in questions {
        let text = q["question"].as_str().unwrap();
        let mut labels = std::collections::HashSet::new();
        if !texts.insert(text)
            || q["options"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .any(|(index, option)| {
                    let key = match option.get("label") {
                        None => "undefined".into(),
                        Some(value) if crate::js::is_undefined(value) => "undefined".into(),
                        Some(value) if value.is_object() || value.is_array() => {
                            format!("object-{index}")
                        }
                        Some(value) => crate::js::stringify(value),
                    };
                    !labels.insert(key)
                })
        {
            return failure(harness.text(TextId::ToolsAskDuplicate));
        }
    }
    let answers: Vec<_> = match &input["answers"] {
        Value::Object(answers) => crate::js::ordered_object(answers).into_iter().collect(),
        Value::Array(answers) => answers
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        _ => Vec::new(),
    };
    if !answers.is_empty() {
        let mut lines = vec![harness.text(TextId::ToolsAskDecisions).into()];
        for (question, answer) in answers {
            lines.extend([
                String::new(),
                harness.render(TextId::ToolsAskQuestion, &[("question", &question)]),
                harness.render(
                    TextId::ToolsAskAnswer,
                    &[("answer", &crate::js::to_string(&answer))],
                ),
            ]);
            let details = &input["annotations"][&question];
            if crate::js::truthy(&details["notes"]) {
                lines.push(harness.render(
                    TextId::ToolsAskFeedback,
                    &[("notes", &crate::js::to_string(&details["notes"]))],
                ));
            }
            if crate::js::truthy(&details["preview"]) {
                lines.push(harness.render(
                    TextId::ToolsAskPreview,
                    &[("preview", &crate::js::to_string(&details["preview"]))],
                ));
            }
        }
        success(
            lines.join("\n"),
            Some(
                json!({"questions":questions,"answers":input["answers"],"annotations":if crate::js::is_undefined(&input["annotations"]) {&Value::Null}else{&input["annotations"]},"type":"ask_user"}),
            ),
        )
    } else {
        success(
            harness.render(
                TextId::ToolsAskWaiting,
                &[(
                    "questions",
                    &questions
                        .iter()
                        .map(|q| q["question"].as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join(", "),
                )],
            ),
            Some(json!({"questions":questions,"type":"ask_user"})),
        )
    }
}

#[cfg(test)]
mod tests;
