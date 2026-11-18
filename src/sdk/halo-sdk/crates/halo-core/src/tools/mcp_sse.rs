use super::mcp::rpc::RpcHandler;
use crate::error::{Error, Result};
use crate::harness::TextId;
use futures_util::StreamExt;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;
struct OpeningReader {
    cancel: CancellationToken,
    reader: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for OpeningReader {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            self.cancel.cancel();
            reader.abort();
        }
    }
}
#[derive(Default)]
struct Parser {
    pending: Vec<u8>,
    event: String,
    data: Vec<String>,
}
impl Parser {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<(String, String)>> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > 16 * 1024 * 1024 {
            return Err(Error::template(
                "MCP_SSE_LIMIT",
                TextId::ToolsMcpSseLimit,
                &[],
            ));
        }
        let mut out = Vec::new();
        while let Some(index) = self.pending.iter().position(|b| *b == b'\n') {
            let mut line = self.pending.drain(..=index).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push((std::mem::take(&mut self.event), self.data.join("\n")));
                    self.data.clear();
                }
                self.event.clear();
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).into());
            } else if let Some(event) = line.strip_prefix("event:") {
                self.event = event.trim_start().into();
            }
        }
        Ok(out)
    }
}
fn request_headers(
    mut request: reqwest::RequestBuilder,
    headers: &Value,
) -> reqwest::RequestBuilder {
    if let Some(headers) = headers.as_object() {
        for (k, v) in headers {
            if let Some(value) = v.as_str() {
                request = request.header(k, value);
            }
        }
    }
    request
}
#[derive(Clone)]
pub(super) struct ReplyTarget {
    pub client: reqwest::Client,
    pub endpoint: String,
    pub headers: Value,
    pub session_id: Option<String>,
    pub protocol_version: Option<String>,
    pub lifetime: CancellationToken,
    pub activity: Option<Arc<crate::resource_activity::ResourceActivity>>,
}
impl ReplyTarget {
    async fn post(&self, payload: &Value) -> Result<()> {
        let _activity = self.activity.as_ref().map(|activity| activity.lease());
        let mut request = request_headers(
            self.client
                .post(&self.endpoint)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .json(payload),
            &self.headers,
        );
        if let Some(session) = &self.session_id {
            request = request.header("Mcp-Session-Id", session);
        }
        if let Some(version) = &self.protocol_version {
            request = request.header("MCP-Protocol-Version", version);
        }
        let response = tokio::select! {
            result=request.send()=>result.map_err(|error|Error::new("MCP_SSE_POST",error.to_string()))?,
            _=self.lifetime.cancelled()=>return Err(Error::template("MCP_CLOSED",TextId::ToolsMcpHttpTransportClosed,&[])),
            _=tokio::time::sleep(Duration::from_secs(30))=>return Err(Error::template("MCP_TIMEOUT",TextId::ToolsMcpHttpTimedOut,&[])),
        };
        if !response.status().is_success() {
            return Err(Error::template(
                "MCP_SSE_POST",
                TextId::ToolsMcpResponsePostFailed,
                &[("status", response.status().as_u16().to_string().into())],
            ));
        }
        Ok(())
    }
}
async fn answer_request(handler: Arc<RpcHandler>, target: ReplyTarget, request: Value) {
    let response = handler.answer(request).await;
    if crate::js::is_undefined(&response) {
        return;
    }
    if let Err(error) = target.post(&response).await {
        tracing::warn!(error=%error,"MCP request response could not be delivered");
    }
}
pub struct SseConnection {
    client: reqwest::Client,
    endpoint: String,
    headers: Value,
    pending: Pending,
    cancel: CancellationToken,
    reader: tokio::task::JoinHandle<()>,
}
impl SseConnection {
    pub fn connected(&self) -> bool {
        !self.cancel.is_cancelled() && !self.reader.is_finished()
    }
    pub async fn connect(
        url: &str,
        headers: Value,
        caller: &CancellationToken,
        handler: Arc<RpcHandler>,
    ) -> Result<Self> {
        let resource_lease = handler
            .bridge
            .resource_activity()
            .map(|activity| activity.lease());
        let client = reqwest::Client::new();
        let request = request_headers(
            client.get(url).header("Accept", "text/event-stream"),
            &headers,
        );
        let response = tokio::select! {r=request.send()=>r.map_err(|e|Error::new("MCP_SSE",e.to_string()))?,_=caller.cancelled()=>return Err(Error::cancelled())};
        if !response.status().is_success() {
            return Err(Error::template(
                "MCP_SSE",
                TextId::ToolsMcpSseConnectError,
                &[
                    ("status", response.status().as_u16().to_string().into()),
                    (
                        "reason",
                        response.status().canonical_reason().unwrap_or("").into(),
                    ),
                ],
            ));
        }
        let base = response.url().clone();
        let cancel = CancellationToken::new();
        let pending: Pending = Default::default();
        let reader_pending = pending.clone();
        let reader_cancel = cancel.clone();
        let (endpoint_tx, endpoint_rx) = oneshot::channel();
        let reader_client = client.clone();
        let reader_headers = headers.clone();
        let reader = crate::runtime::spawn(async move {
            let _resource_lease = resource_lease;
            let mut target: Option<ReplyTarget> = None;
            let mut callbacks = tokio::task::JoinSet::new();
            let mut endpoint_tx = Some(endpoint_tx);
            let mut stream = response.bytes_stream();
            let mut parser = Parser::default();
            loop {
                let next = tokio::select! {
                    r=stream.next()=>r,
                    _=reader_cancel.cancelled()=>break,
                    Some(result)=callbacks.join_next(), if !callbacks.is_empty()=> { if let Err(error)=result {tracing::warn!(error=%error,"MCP callback task failed");}continue; }
                };
                let bytes = match next {
                    Some(Ok(b)) => b,
                    Some(Err(e)) => {
                        tracing::warn!(error=%e,"MCP SSE stream failed");
                        break;
                    }
                    None => break,
                };
                let events = match parser.push(&bytes) {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::warn!(error=%e,"MCP SSE message rejected");
                        break;
                    }
                };
                for (event, data) in events {
                    if event == "endpoint" {
                        if let Some(tx) = endpoint_tx.take() {
                            let endpoint = base
                                .join(&data)
                                .map(|u| u.to_string())
                                .map_err(|e| Error::new("MCP_SSE_ENDPOINT", e.to_string()));
                            if let Ok(endpoint) = &endpoint {
                                target = Some(ReplyTarget {
                                    client: reader_client.clone(),
                                    endpoint: endpoint.clone(),
                                    headers: reader_headers.clone(),
                                    session_id: None,
                                    protocol_version: None,
                                    lifetime: reader_cancel.clone(),
                                    activity: handler.bridge.resource_activity(),
                                });
                            }
                            let _ = tx.send(endpoint);
                        }
                    } else if event == "message" || event.is_empty() {
                        match serde_json::from_str::<Value>(&data) {
                            Ok(value)
                                if value.get("method").is_some() && value.get("id").is_some() =>
                            {
                                if let Some(target) = &target {
                                    callbacks.spawn(
                                        answer_request(handler.clone(), target.clone(), value)
                                            .with_current_subscriber(),
                                    );
                                } else {
                                    tracing::warn!(
                                        "MCP server request arrived before SSE endpoint"
                                    );
                                }
                            }
                            Ok(value) => {
                                if let Some(id) = super::mcp::rpc_id(&value["id"]) {
                                    if let Some(tx) = reader_pending.lock().await.remove(&id) {
                                        let _ = tx.send(Ok(value));
                                    }
                                }
                            }
                            Err(e) => tracing::warn!(error=%e,"MCP SSE JSON rejected"),
                        }
                    }
                }
            }
            for (_, tx) in reader_pending.lock().await.drain() {
                let _ = tx.send(Err(Error::template(
                    "MCP_CLOSED",
                    TextId::ToolsMcpSseClosed,
                    &[],
                )));
            }
        });
        let mut opening = OpeningReader {
            cancel: cancel.clone(),
            reader: Some(reader),
        };
        let endpoint = tokio::select! {r=endpoint_rx=>r.map_err(|_|Error::template("MCP_SSE_ENDPOINT", TextId::ToolsMcpSseNoEndpoint, &[]))?,_=caller.cancelled()=>Err(Error::cancelled()),_=tokio::time::sleep(Duration::from_secs(30))=>Err(Error::template("MCP_SSE_ENDPOINT", TextId::ToolsMcpSseEndpointTimeout, &[]))};
        match endpoint {
            Ok(endpoint) => Ok(Self {
                client,
                endpoint,
                headers,
                pending,
                cancel,
                reader: opening.reader.take().unwrap(),
            }),
            Err(e) => Err(e),
        }
    }
    pub async fn request(&self, payload: &Value, caller: &CancellationToken) -> Result<Value> {
        let id = super::mcp::rpc_id(&payload["id"])
            .ok_or_else(|| Error::template("MCP_ID", TextId::ToolsMcpMissingId, &[]))?;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        let future = async {
            self.post(payload).await?;
            rx.await
                .map_err(|_| Error::template("MCP_CLOSED", TextId::ToolsMcpSseClosed, &[]))?
        };
        let result = tokio::select! {r=future=>r,_=caller.cancelled()=>Err(Error::cancelled()),_=self.cancel.cancelled()=>Err(Error::template("MCP_CLOSED", TextId::ToolsMcpSseClosed, &[]))};
        self.pending.lock().await.remove(&id);
        result
    }
    pub async fn post(&self, payload: &Value) -> Result<()> {
        self.post_with_error(payload, TextId::ToolsMcpSseRequestPostFailed)
            .await
    }
    pub async fn notify(&self, payload: &Value) -> Result<()> {
        tokio::select! {
            result=self.post_with_error(payload,TextId::ToolsMcpSseNotificationFailed)=>result,
            _=self.cancel.cancelled()=>Err(Error::template("MCP_CLOSED",TextId::ToolsMcpHttpTransportClosed,&[])),
            _=tokio::time::sleep(Duration::from_secs(30))=>Err(Error::template("MCP_TIMEOUT",TextId::ToolsMcpHttpTimedOut,&[])),
        }
    }
    async fn post_with_error(&self, payload: &Value, message: TextId) -> Result<()> {
        let response = request_headers(
            self.client
                .post(&self.endpoint)
                .header("Content-Type", "application/json")
                .json(payload),
            &self.headers,
        )
        .send()
        .await
        .map_err(|e| Error::new("MCP_SSE_POST", e.to_string()))?;
        if !response.status().is_success() {
            return Err(Error::template(
                "MCP_SSE_POST",
                message,
                &[("status", response.status().as_u16().to_string().into())],
            ));
        }
        Ok(())
    }
    pub async fn close(&self) {
        self.cancel.cancel();
        self.reader.abort();
        for (_, tx) in self.pending.lock().await.drain() {
            let _ = tx.send(Err(Error::template(
                "MCP_CLOSED",
                TextId::ToolsMcpSseClosed,
                &[],
            )));
        }
    }
    pub fn abort_now(&self) {
        self.cancel.cancel();
        self.reader.abort();
    }
}
impl Drop for SseConnection {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.reader.abort();
    }
}
pub async fn response_message(
    response: reqwest::Response,
    id: Value,
    handler: Arc<RpcHandler>,
    target: ReplyTarget,
) -> Result<Value> {
    let mut parser = Parser::default();
    let mut stream = response.bytes_stream();
    let mut callbacks = tokio::task::JoinSet::new();
    loop {
        let next = tokio::select! {
            next=stream.next()=>next,
            Some(result)=callbacks.join_next(),if !callbacks.is_empty()=>{if let Err(error)=result{tracing::warn!(error=%error,"MCP callback task failed");}continue;}
        };
        let Some(bytes) = next else {
            break;
        };
        let bytes = bytes.map_err(|error| Error::new("MCP_SSE", error.to_string()))?;
        for (_, data) in parser.push(&bytes)? {
            let value: Value = serde_json::from_str(&data)?;
            if value.get("method").is_some() && value.get("id").is_some() {
                callbacks.spawn(
                    answer_request(handler.clone(), target.clone(), value)
                        .with_current_subscriber(),
                );
            } else if value["id"] == id {
                return Ok(value);
            }
        }
    }
    Err(Error::template(
        "MCP_HTTP",
        TextId::ToolsMcpMissingResult,
        &[],
    ))
}
