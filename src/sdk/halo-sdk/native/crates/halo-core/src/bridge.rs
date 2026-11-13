use crate::error::Result;
use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// Host-scoped capabilities; execution owners retain their own request and session state.
#[derive(Clone, Default)]
pub struct HostServices {
    pub code_search_pool: Option<std::sync::Arc<crate::search::CodeSearchPool>>,
    pub http_trust: Option<std::sync::Arc<crate::http::HostTrust>>,
}

#[async_trait]
pub trait HostBridge: Send + Sync {
    fn resource_activity(&self)->Option<std::sync::Arc<crate::resource_activity::ResourceActivity>> { None }
    fn code_search_pool(&self)->Option<std::sync::Arc<crate::search::CodeSearchPool>> { None }
    fn http_trust(&self)->Option<std::sync::Arc<crate::http::HostTrust>> { None }
    async fn call(
        &self,
        method: &str,
        params: Value,
        cancellation: &CancellationToken,
    ) -> Result<Value>;

    /// Data calls preserve JavaScript values; control-only hosts must opt in explicitly.
    async fn call_data(
        &self,
        _method: &str,
        _params: crate::js::value::JsValue,
        _cancellation: &CancellationToken,
    ) -> Result<crate::js::value::JsValue> {
        Err(crate::error::Error::new(
            "HOST_DATA_UNSUPPORTED",
            "The host does not support lossless data callbacks",
        ))
    }
}

#[async_trait]
pub trait EventSink: Send + Sync {
    async fn emit(&self, event: Value) -> Result<()>;
}
