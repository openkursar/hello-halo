use crate::bridge::HostBridge;
use crate::harness::{fixed_text, ResourceId};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct RpcHandler {
    pub bridge: Arc<dyn HostBridge>,
    pub callback: Option<String>,
    pub server: String,
    pub cancellation: CancellationToken,
    pub requests: Option<Arc<RwLock<HashMap<String, String>>>>,
}
impl RpcHandler {
    pub async fn answer(&self, message: Value) -> Value {
        let id = message["id"].clone();
        if let Some(requests) = &self.requests {
            let callback = requests
                .read()
                .unwrap()
                .get(message["method"].as_str().unwrap_or(""))
                .cloned();
            let Some(callback) = callback else {
                return crate::js::undefined();
            };
            let result = self.bridge.call("mcp.transport.request",json!({"callbackId":callback,"hasParams":message.get("params").is_some(),"params":message.get("params").cloned().unwrap_or(Value::Null)}),&self.cancellation).await;
            return match result {
                Ok(result) => {
                    json!({"jsonrpc":"2.0","id":id,"result":result.get("value").cloned().unwrap_or(Value::Null)})
                }
                Err(error) => {
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error.message}})
                }
            };
        }
        if message["method"] != "elicitation/create" || self.callback.is_none() {
            return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("{}{}",fixed_text(ResourceId::McpProtocol, &["method_not_found_prefix"]),message["method"].as_str().unwrap_or(""))}});
        }
        let mut request = json!({"serverName":self.server});
        if let Some(params) = message["params"].as_object() {
            request.as_object_mut().unwrap().extend(params.clone());
        }
        let result=self.bridge.call("callback",json!({"callbackId":self.callback,"args":[request,{"signal":{"__haloSdkNativeSignal":true}}]}),&self.cancellation).await;
        match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => {
                tracing::warn!(server=%self.server,error=%error,"MCP request handler failed");
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":error.to_string()}})
            }
        }
    }
}
