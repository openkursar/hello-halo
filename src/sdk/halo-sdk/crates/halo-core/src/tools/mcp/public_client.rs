use crate::{
    bridge::HostBridge,
    error::{Error, Result},
    harness::{fixed_text, ResolvedHarness, ResourceId, TextId},
    js::{text::JsText, value::JsValue},
    js_value,
};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, RwLock,
};
use tokio_util::sync::CancellationToken;

fn field<'a>(value: &'a JsValue, name: &str) -> &'a JsValue {
    value.get(name).unwrap_or(&JsValue::Undefined)
}

fn reference(value: &JsValue) -> Result<String> {
    field(value, "reference")
        .as_text()
        .and_then(JsText::as_utf8)
        .map(str::to_owned)
        .ok_or_else(|| Error::new("INVALID_HOST_DATA", "MCP response reference is missing"))
}

fn kind(value: &JsValue, expected: &str) -> bool {
    field(value, "kind").as_text().and_then(JsText::as_utf8) == Some(expected)
}

struct State {
    initialized: bool,
    server: JsValue,
    instructions: JsValue,
    tools_revision: u64,
    server_revision: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            initialized: false,
            server: JsValue::Null,
            instructions: JsValue::Undefined,
            tools_revision: 0,
            server_revision: 0,
        }
    }
}
pub struct PublicClient {
    server_name: JsText,
    elicitation: bool,
    state: RwLock<State>,
    next_id: AtomicU64,
    lifetime: CancellationToken,
}
pub enum ResultReceipt {
    Data(JsValue),
    Reference(String),
}
impl ResultReceipt {
    pub fn receipt(self) -> JsValue {
        match self {
            Self::Reference(reference) => js_value!({ "reference": reference }),
            Self::Data(value) => js_value!({ "value": value }),
        }
    }
}
impl PublicClient {
    pub fn new(server_name: JsText, elicitation: bool) -> Self {
        Self {
            server_name,
            elicitation,
            state: RwLock::new(State::default()),
            next_id: AtomicU64::new(1),
            lifetime: CancellationToken::new(),
        }
    }
    pub fn initialized(&self) -> bool {
        self.state.read().unwrap().initialized
    }
    pub fn server_info(&self) -> JsValue {
        self.state.read().unwrap().server.clone()
    }
    pub fn tools_revision(&self) -> u64 {
        self.state.read().unwrap().tools_revision
    }
    pub fn server_info_revision(&self) -> u64 {
        self.state.read().unwrap().server_revision
    }
    pub fn instructions(&self) -> JsValue {
        self.state.read().unwrap().instructions.clone()
    }
    pub fn close(&self) {
        self.lifetime.cancel();
        let mut state = self.state.write().unwrap();
        *state = State {
            tools_revision: state.tools_revision + 1,
            server_revision: state.server_revision + 1,
            ..State::default()
        };
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.lifetime.clone()
    }

    async fn transport(
        bridge: &Arc<dyn HostBridge>,
        method: &str,
        args: JsValue,
        response: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<JsValue> {
        let mut request = js_value!({ "method": method, "args": args });
        if let Some(response) = response {
            request
                .as_object_mut()
                .unwrap()
                .insert("response".into(), response.into());
        }
        bridge.call_data("mcp.transport", request, cancel).await
    }

    pub async fn initialize(
        &self,
        bridge: Arc<dyn HostBridge>,
        harness: &ResolvedHarness,
    ) -> Result<()> {
        let uncancelled = CancellationToken::new();
        if self.elicitation {
            Self::transport(
                &bridge,
                "setRequestHandler",
                js_value!(["elicitation/create", { "nativeHandler": "elicitation" }]),
                None,
                &uncancelled,
            )
            .await?;
        }
        let mut capabilities = js_value!({ "roots": { "listChanged": false } });
        if self.elicitation {
            capabilities
                .as_object_mut()
                .unwrap()
                .insert("elicitation".into(), js_value!({}));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let response = Self::transport(
            &bridge,
            "send",
            js_value!([{
                "jsonrpc": "2.0", "id": id, "method": "initialize",
                "params": { "protocolVersion": "2024-11-05", "capabilities": capabilities,
                    "clientInfo": { "name": "agent-sdk", "version": "1.0.0" } }
            }]),
            Some("initialize"),
            &uncancelled,
        )
        .await?;
        if kind(&response, "error") {
            let message = field(&response, "message")
                .as_text()
                .ok_or_else(|| Error::new("INVALID_HOST_DATA", "MCP error text is missing"))?;
            return Err(Error::new_text(
                "MCP_INITIALIZE",
                harness.render_text(
                    TextId::ToolsMcpInitializeFailed,
                    &[("server", &self.server_name), ("error", message)],
                ),
            ));
        }
        if !kind(&response, "initialize") {
            return Err(Error::new(
                "INVALID_HOST_DATA",
                "MCP initialization response is invalid",
            ));
        }
        let capabilities = field(&response, "capabilitiesReference")
            .as_text()
            .and_then(JsText::as_utf8)
            .ok_or_else(|| {
                Error::new("INVALID_HOST_DATA", "MCP capabilities reference is missing")
            })?;
        {
            let mut state = self.state.write().unwrap();
            state.server_revision += 1;
            state.server = field(&response, "server").clone();
            state.instructions = field(&response, "instructions").clone();
        }
        Self::transport(
            &bridge,
            "notify",
            js_value!([{ "jsonrpc": "2.0", "method": "notifications/initialized" }]),
            None,
            &uncancelled,
        )
        .await?;
        self.state.write().unwrap().initialized = true;
        let supports_tools = bridge
            .call_data(
                "mcp.client.capabilities",
                js_value!({ "reference": capabilities }),
                &uncancelled,
            )
            .await?;
        if supports_tools.truthy() {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let response = Self::transport(
                &bridge,
                "send",
                js_value!([{ "jsonrpc": "2.0", "id": id, "method": "tools/list" }]),
                Some("tools"),
                &uncancelled,
            )
            .await?;
            if kind(&response, "error") {
                bridge
                    .call_data(
                        "mcp.client.warning",
                        js_value!({ "reference": reference(&response)? }),
                        &uncancelled,
                    )
                    .await?;
            } else {
                if !kind(&response, "tools") {
                    return Err(Error::new(
                        "INVALID_HOST_DATA",
                        "MCP tool-list response is invalid",
                    ));
                }
                self.state.write().unwrap().tools_revision += 1;
                let publication = if response.get("reference").is_some() {
                    js_value!({ "reference": reference(&response)? })
                } else {
                    js_value!({ "value": [] })
                };
                bridge
                    .call_data("mcp.client.tools", publication, &uncancelled)
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn elicitation(&self, bridge: Arc<dyn HostBridge>) -> Result<JsValue> {
        bridge
            .call_data("mcp.elicitation", js_value!({}), &CancellationToken::new())
            .await
    }

    pub async fn call_tool(
        &self,
        name: &JsText,
        arguments: JsValue,
        bridge: Arc<dyn HostBridge>,
        cancel: &CancellationToken,
        harness: &ResolvedHarness,
    ) -> Result<ResultReceipt> {
        if !self.initialized() {
            return Ok(ResultReceipt::Data(js_value!({
                "content": [{ "type": "text", "text": harness.render_text(TextId::ToolsMcpNotInitialized, &[("server", &self.server_name)]) }],
                "isError": true
            })));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        let request = js_value!({ "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": name, "arguments": arguments } });
        let response = Self::transport(
            &bridge,
            "send",
            js_value!([request, { "nativeSignal": true }]),
            Some("tool"),
            cancel,
        )
        .await;
        if cancel.is_cancelled() {
            let submitted = match Self::transport(
                &bridge,
                "wasSubmitted",
                js_value!([id]),
                None,
                &CancellationToken::new(),
            )
            .await
            {
                Ok(value) => value.as_bool() == Some(true),
                Err(error) => {
                    tracing::warn!(error=%error, "MCP tool request submission could not be observed after cancellation");
                    false
                }
            };
            if submitted {
                let notification = js_value!({ "jsonrpc": "2.0", "method": "notifications/cancelled",
                    "params": { "requestId": id, "reason": fixed_text(ResourceId::McpProtocol, &["cancelled_reason"]) } });
                if let Err(error) = Self::transport(
                    &bridge,
                    "notifyDetached",
                    js_value!([notification]),
                    None,
                    &CancellationToken::new(),
                )
                .await
                {
                    tracing::warn!(error=%error, "Tool cancellation could not be delivered");
                }
            }
            return Err(Error::template(
                "MCP_CANCELLED",
                TextId::ToolsMcpToolRequestCancelled,
                &[],
            ));
        }
        let response = response?;
        if kind(&response, "error") {
            let message = field(&response, "message")
                .as_text()
                .ok_or_else(|| Error::new("INVALID_HOST_DATA", "MCP error text is missing"))?;
            return Ok(ResultReceipt::Data(js_value!({
                "content": [{ "type": "text", "text": harness.render_text(TextId::ToolsMcpClientToolError,
                    &[("server", &self.server_name), ("tool", name), ("error", message)]) }], "isError": true
            })));
        }
        if kind(&response, "result") {
            return Ok(ResultReceipt::Reference(reference(&response)?));
        }
        if kind(&response, "empty") {
            return Ok(ResultReceipt::Data(
                js_value!({ "content": [{ "type": "text", "text": "" }], "isError": false }),
            ));
        }
        Err(Error::new(
            "INVALID_HOST_DATA",
            "MCP tool response is invalid",
        ))
    }
}

#[cfg(test)]
#[path = "public_client_tests.rs"]
mod tests;
