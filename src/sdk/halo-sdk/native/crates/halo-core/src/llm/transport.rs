use crate::{bridge::HostBridge, error::{Error, Result}, http::HostTrust};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

pub(super) fn serialize_model_request(body: &Value) -> String {
    let Some(fields) = body.as_object() else { return crate::js::stringify(body); };
    let mut output = String::from("{");
    let mut first = true;
    for (key, value) in crate::js::data::entries(fields) {
        if key != "messages" && crate::js::is_undefined(value) { continue; }
        if !first { output.push(','); }
        first = false;
        output.push_str(&serde_json::to_string(key).unwrap());
        output.push(':');
        if key == "messages" {
            crate::js::data::append(value, &mut output);
        } else {
            output.push_str(&crate::js::stringify(value));
        }
    }
    output.push('}');
    output
}

struct ClientState {
    closed: bool,
    generation: Option<u64>,
    client: Option<reqwest::Client>,
}

pub struct ProviderTransport {
    trust: Option<Arc<HostTrust>>,
    supplied: bool,
    state: Mutex<ClientState>,
}

#[derive(Clone)]
pub struct AttemptClient {
    transport: Arc<ProviderTransport>,
    bridge: Option<Arc<dyn HostBridge>>,
}

impl AttemptClient {
    pub fn new(transport: Arc<ProviderTransport>, bridge: Arc<dyn HostBridge>) -> Self {
        Self { transport, bridge: Some(bridge) }
    }
    pub fn supplied(client: reqwest::Client) -> Self {
        Self { transport: ProviderTransport::supplied(client), bridge: None }
    }
    pub async fn client(&self, cancellation: &CancellationToken) -> Result<reqwest::Client> {
        self.transport.prepare(self.bridge.as_deref(), cancellation).await
    }
}

impl ProviderTransport {
    pub fn new(trust: Option<Arc<HostTrust>>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self { trust, supplied: false, state: Mutex::new(ClientState { closed: false, generation: None, client: None }) }))
    }

    pub fn supplied(client: reqwest::Client) -> Arc<Self> {
        Arc::new(Self { trust: None, supplied: true, state: Mutex::new(ClientState { closed: false, generation: None, client: Some(client) }) })
    }

    pub fn trust(&self) -> Option<Arc<HostTrust>> { self.trust.clone() }

    pub fn ensure_open(&self) -> Result<()> {
        if self.state.lock().unwrap().closed { Err(Error::new("PROVIDER_CLOSED", "Provider transport is closed")) } else { Ok(()) }
    }

    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.client.take();
    }

    pub async fn prepare(&self, bridge: Option<&dyn HostBridge>, cancellation: &CancellationToken) -> Result<reqwest::Client> {
        self.ensure_open()?;
        if cancellation.is_cancelled() { return Err(Error::cancelled()); }
        if self.trust.is_some() && !self.supplied {
            let bridge = bridge.ok_or_else(|| Error::new("TLS_TRUST_BRIDGE", "Host trust requires its owning callback bridge"))?;
            bridge.call("http.prepare", json!({}), cancellation).await?;
        }
        if cancellation.is_cancelled() { return Err(Error::cancelled()); }
        let snapshot = self.trust.as_ref().and_then(|trust| trust.snapshot());
        let generation = snapshot.as_ref().map(|snapshot| snapshot.generation);
        let mut state = self.state.lock().unwrap();
        if state.closed { return Err(Error::new("PROVIDER_CLOSED", "Provider transport is closed")); }
        if let Some(client) = &state.client {
            if self.supplied || state.generation == generation { return Ok(client.clone()); }
        }
        let builder = crate::http::with_trust(reqwest::Client::builder().no_proxy(), snapshot.as_ref())?;
        let client = builder.build().map_err(|error| Error::new("PROVIDER_ERROR", error.to_string()))?;
        state.generation = generation;
        state.client = Some(client.clone());
        Ok(client)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_messages_are_json_data_while_option_controls_keep_their_semantics() {
        let literal = json!({"__haloSdkNativeUndefined":true,"nested":{"__haloSdkNativeNumber":"NaN"}});
        let body = json!({"messages":[{"role":"assistant","content":[{"type":"tool_use","input":literal}]}],
            "max_tokens":crate::js::number_value(f64::INFINITY),"omitted":crate::js::undefined()});
        let encoded: Value = serde_json::from_str(&serialize_model_request(&body)).unwrap();
        assert_eq!(encoded["messages"][0]["content"][0]["input"], literal);
        assert!(encoded["max_tokens"].is_null());
        assert!(encoded.get("omitted").is_none());
    }
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Bridge(AtomicUsize);
    #[async_trait]
    impl HostBridge for Bridge {
        async fn call(&self, method: &str, _: serde_json::Value, _: &CancellationToken) -> Result<serde_json::Value> {
            assert_eq!(method, "http.prepare");
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(serde_json::Value::Null)
        }
    }

    #[test]
    fn construction_does_not_load_trust_or_construct_a_client() {
        let transport = ProviderTransport::new(Some(Arc::new(HostTrust::new()))).unwrap();
        assert!(transport.state.lock().unwrap().client.is_none());
        transport.close();
        assert_eq!(transport.ensure_open().unwrap_err().code, "PROVIDER_CLOSED");
    }

    #[tokio::test]
    async fn requests_observe_new_trust_without_mutating_issued_clients() {
        let trust = Arc::new(HostTrust::new());
        trust.update_certificates(Vec::new()).unwrap();
        let transport = ProviderTransport::new(Some(trust.clone())).unwrap();
        let bridge = Bridge(AtomicUsize::new(0));
        let cancellation = CancellationToken::new();
        let issued = transport.prepare(Some(&bridge), &cancellation).await.unwrap();
        transport.prepare(Some(&bridge), &cancellation).await.unwrap();
        assert_eq!(transport.state.lock().unwrap().generation, Some(1));
        trust.update_certificates(Vec::new()).unwrap();
        transport.prepare(Some(&bridge), &cancellation).await.unwrap();
        assert_eq!(transport.state.lock().unwrap().generation, Some(2));
        assert_eq!(bridge.0.load(Ordering::Relaxed), 3);
        transport.close();
        assert!(issued.get("http://127.0.0.1:1").build().is_ok());
        assert_eq!(transport.prepare(Some(&bridge), &cancellation).await.unwrap_err().code, "PROVIDER_CLOSED");
    }
}
