use super::{failure, success, utf16_prefix, ToolContext};
use crate::harness::{ResolvedHarness, TextId};
use crate::{bridge::HostBridge, error::Error, http::HostTrust};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

enum RequestFailure {
    Aborted,
    Timeout,
    Network(reqwest::Error),
    Preparation(Error),
}

impl From<reqwest::Error> for RequestFailure {
    fn from(error: reqwest::Error) -> Self {
        Self::Network(error)
    }
}
impl From<Error> for RequestFailure {
    fn from(error: Error) -> Self {
        Self::Preparation(error)
    }
}
impl RequestFailure {
    fn result(self, harness: &ResolvedHarness, url: &str, body: bool) -> Value {
        match self {
            Self::Aborted => failure(harness.text(TextId::ToolsWebAborted)),
            Self::Timeout => failure(harness.text(TextId::ToolsWebTimeout)),
            Self::Network(error) if body => {
                failure(harness.render(TextId::ToolsWebBodyError, &[("error", &error.to_string())]))
            }
            Self::Network(error) => failure(harness.render(
                TextId::ToolsWebFetchFailed,
                &[("url", url), ("error", &error.to_string())],
            )),
            Self::Preparation(error) if error.is_abort() => {
                failure(harness.text(TextId::ToolsWebAborted))
            }
            Self::Preparation(error) => failure(harness.render(
                TextId::ToolsWebFetchFailed,
                &[("url", url), ("error", &error.render_for(harness))],
            )),
        }
    }
}

async fn request_step<T, E: Into<RequestFailure>>(
    future: impl Future<Output = Result<T, E>>,
    deadline: tokio::time::Instant,
    context: &ToolContext,
    phase: &'static str,
) -> Result<T, RequestFailure> {
    let outcome = tokio::select! {
        biased;
        _ = context.cancellation.cancelled() => Err(RequestFailure::Aborted),
        result = tokio::time::timeout_at(deadline, future) => match result {
            Ok(result) => result.map_err(Into::into),
            Err(_) => Err(RequestFailure::Timeout),
        },
    };
    if let Err(failure) = &outcome {
        let reason = match failure {
            RequestFailure::Aborted => "cancelled",
            RequestFailure::Timeout => "timeout",
            RequestFailure::Network(error) if error.is_connect() => "connection",
            RequestFailure::Network(_) => "response",
            RequestFailure::Preparation(error) if error.is_abort() => "cancelled",
            RequestFailure::Preparation(_) => "preparation",
        };
        tracing::warn!(session_id = %context.session_id, tool_use_id = %context.tool_use_id,
            phase, reason, "WebFetch request did not complete");
    }
    outcome
}

struct CachedClient {
    trust: Option<Arc<HostTrust>>,
    generation: Option<u64>,
    client: reqwest::Client,
}
#[derive(Default)]
struct ClientState {
    closed: bool,
    current: Option<CachedClient>,
}
#[derive(Default)]
pub struct WebTool {
    cache: Mutex<HashMap<String, (String, usize, Instant)>>,
    client: StdMutex<ClientState>,
}
fn render_body(body: &str, length: usize, harness: &ResolvedHarness) -> String {
    if length > 100000 {
        harness.render(
            TextId::ToolsWebTruncated,
            &[("body", body), ("length", &length.to_string())],
        )
    } else {
        body.to_owned()
    }
}
impl WebTool {
    pub fn close(&self) {
        let mut client = self
            .client
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        client.closed = true;
        client.current.take();
    }

    async fn prepare_client(
        &self,
        bridge: Option<&dyn HostBridge>,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<reqwest::Client, Error> {
        if self
            .client
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .closed
        {
            return Err(Error::cancelled());
        }
        let trust = bridge.and_then(HostBridge::http_trust);
        if trust.is_some() {
            bridge
                .unwrap()
                .call("http.prepare", json!({}), cancellation)
                .await?;
        }
        if cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let snapshot = trust.as_ref().and_then(|trust| trust.snapshot());
        let generation = snapshot.as_ref().map(|snapshot| snapshot.generation);
        let mut state = self
            .client
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(Error::cancelled());
        }
        if let Some(current) = &state.current {
            let same_trust = match (&current.trust, &trust) {
                (None, None) => true,
                (Some(previous), Some(next)) => Arc::ptr_eq(previous, next),
                _ => false,
            };
            if same_trust && current.generation == generation {
                return Ok(current.client.clone());
            }
        }
        let client = crate::http::with_trust(reqwest::Client::builder(), snapshot.as_ref())?
            .build()
            .map_err(|error| Error::new("WEB_CLIENT", error.to_string()))?;
        state.current = Some(CachedClient {
            trust,
            generation,
            client: client.clone(),
        });
        Ok(client)
    }

    pub async fn execute(
        &self,
        input: &Value,
        ctx: &ToolContext,
        bridge: Option<&dyn HostBridge>,
    ) -> Value {
        let harness = &ctx.harness;
        let Some(raw) = input["url"].as_str().filter(|s| !s.is_empty()) else {
            return failure(harness.text(TextId::ToolsWebMissingUrl));
        };
        let url = if let Some(rest) = raw.strip_prefix("http://") {
            format!("https://{rest}")
        } else {
            raw.into()
        };
        let parsed = match reqwest::Url::parse(&url) {
            Ok(u) => u,
            Err(_) => return failure(harness.render(TextId::ToolsWebInvalidUrl, &[("url", raw)])),
        };
        {
            let mut cache = self.cache.lock().await;
            cache.retain(|_, (_, _, stamp)| stamp.elapsed() < Duration::from_secs(900));
            if let Some((body, length, _)) = cache.get(&url) {
                return success(render_body(body, *length, harness), None);
            }
        }
        if ctx.cancellation.is_cancelled() {
            return failure(harness.text(TextId::ToolsWebAborted));
        }
        let deadline = tokio::time::Instant::now() + FETCH_TIMEOUT;
        let client = match request_step(
            self.prepare_client(bridge, &ctx.cancellation),
            deadline,
            ctx,
            "client",
        )
        .await
        {
            Ok(client) => client,
            Err(error) => return error.result(harness, &url, false),
        };
        let response = match request_step(
            client
                .get(&url)
                .header("User-Agent", "agent-sdk")
                .header(
                    "Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                )
                .send(),
            deadline,
            ctx,
            "headers",
        )
        .await
        {
            Ok(response) => response,
            Err(error) => return error.result(harness, &url, false),
        };
        if response.url().host_str() != parsed.host_str() {
            return success(
                harness.render(
                    TextId::ToolsWebRedirect,
                    &[("url", response.url().as_str())],
                ),
                None,
            );
        }
        if !response.status().is_success() {
            return failure(harness.render(
                TextId::ToolsWebHttpError,
                &[
                    ("status", &response.status().as_u16().to_string()),
                    ("url", &url),
                ],
            ));
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let body = match request_step(response.text(), deadline, ctx, "body").await {
            Ok(body) => body,
            Err(error) => return error.result(harness, &url, true),
        };
        let mut text = if kind.contains("html") {
            html_to_markdown(&body)
        } else if kind.contains("json") {
            serde_json::from_str::<Value>(&body)
                .and_then(|v| serde_json::to_string_pretty(&v))
                .unwrap_or(body)
        } else {
            body
        };
        let length = text.encode_utf16().count();
        if length > 100000 {
            text = utf16_prefix(&text, 100000);
        }
        self.cache
            .lock()
            .await
            .insert(url, (text.clone(), length, Instant::now()));
        success(render_body(&text, length, harness), None)
    }
}
pub fn html_to_markdown(html: &str) -> String {
    fn replace(s: String, p: &str, r: &str) -> String {
        regex::Regex::new(p)
            .unwrap()
            .replace_all(&s, r)
            .into_owned()
    }
    let mut s = html.to_owned();
    for tag in ["script", "style", "noscript"] {
        s = replace(s, &format!("(?is)<{tag}.*?</{tag}>"), "");
    }
    s = replace(s, "(?s)<!--.*?-->", "");
    for i in 1..=6 {
        s = replace(
            s,
            &format!("(?is)<h{i}[^>]*>(.*?)</h{i}>"),
            &format!("\n{} $1\n", "#".repeat(i)),
        );
    }
    for (p, r) in [
        (r#"(?is)<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#, "[$2]($1)"),
        (
            r#"(?is)<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*/?>"#,
            "![$1]($2)",
        ),
        (
            r#"(?is)<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*/?>"#,
            "![$2]($1)",
        ),
        (r#"(?is)<img[^>]*src="([^"]*)"[^>]*/?>"#, "![]($1)"),
        ("(?is)<(strong|b)>(.*?)</(strong|b)>", "**$2**"),
        ("(?is)<(em|i)>(.*?)</(em|i)>", "*$2*"),
        (
            "(?is)<pre[^>]*><code[^>]*>(.*?)</code></pre>",
            "\n```\n$1\n```\n",
        ),
        ("(?is)<pre[^>]*>(.*?)</pre>", "\n```\n$1\n```\n"),
        ("(?is)<code>(.*?)</code>", "`$1`"),
        ("(?is)<li[^>]*>(.*?)</li>", "- $1\n"),
        ("(?i)</?[ou]l[^>]*>", "\n"),
    ] {
        s = replace(s, p, r);
    }
    s = regex::Regex::new("(?is)<tr[^>]*>(.*?)</tr>")
        .unwrap()
        .replace_all(&s, |c: &regex::Captures| {
            let cells = regex::Regex::new("(?is)<t[hd][^>]*>(.*?)</t[hd]>")
                .unwrap()
                .replace_all(&c[1], |c: &regex::Captures| format!("| {} ", c[1].trim()))
                .into_owned();
            format!("{cells}|\n")
        })
        .into_owned();
    for (p, r) in [
        ("(?i)</?table[^>]*>", "\n"),
        ("(?i)</?t(head|body|foot)[^>]*>", ""),
        (r"(?i)<br\s*/?>", "\n"),
        ("(?i)</?p[^>]*>", "\n"),
        ("(?i)</?div[^>]*>", "\n"),
        ("(?i)</?blockquote[^>]*>", "\n"),
        (r"(?i)<hr\s*/?>", "\n---\n"),
        ("<[^>]+>", ""),
    ] {
        s = replace(s, p, r);
    }
    for (a, b) in [
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
        ("&nbsp;", " "),
    ] {
        s = s.replace(a, b);
    }
    for (p, radix) in [(r"&#(\d+);", 10), (r"&#x([0-9a-fA-F]+);", 16)] {
        s = regex::Regex::new(p)
            .unwrap()
            .replace_all(&s, |c: &regex::Captures| {
                let n = u32::from_str_radix(&c[1], radix).unwrap_or(0) as u16;
                String::from_utf16_lossy(&[n])
            })
            .into_owned();
    }
    s = replace(s, r"[ \t]+", " ");
    s = replace(s, r"\n{3,}", "\n\n");
    s.lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct TrustBridge {
        trust: Arc<HostTrust>,
        prepares: AtomicUsize,
    }
    #[async_trait]
    impl HostBridge for TrustBridge {
        fn http_trust(&self) -> Option<Arc<HostTrust>> {
            Some(self.trust.clone())
        }
        async fn call(
            &self,
            method: &str,
            _: Value,
            _: &tokio_util::sync::CancellationToken,
        ) -> Result<Value, Error> {
            assert_eq!(method, "http.prepare");
            self.prepares.fetch_add(1, Ordering::Relaxed);
            Ok(Value::Null)
        }
    }

    #[tokio::test]
    async fn client_reuses_connections_and_replaces_trust_without_crossing_owner_boundaries() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            for requests in [2, 1, 1] {
                let (mut stream, _) = listener.accept().await.unwrap();
                for _ in 0..requests {
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        request.push(stream.read_u8().await.unwrap());
                    }
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                        .await
                        .unwrap();
                }
                assert_eq!(stream.read(&mut [0]).await.unwrap(), 0);
            }
        });
        let trust = Arc::new(HostTrust::new());
        trust.update_certificates(Vec::new()).unwrap();
        let bridge = TrustBridge {
            trust: trust.clone(),
            prepares: AtomicUsize::new(0),
        };
        let first = WebTool::default();
        let second = WebTool::default();
        let cancellation = tokio_util::sync::CancellationToken::new();
        for path in ["one", "two"] {
            let client = first
                .prepare_client(Some(&bridge), &cancellation)
                .await
                .unwrap();
            assert_eq!(
                client
                    .get(format!("http://{address}/{path}"))
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "ok"
            );
        }
        trust.update_certificates(Vec::new()).unwrap();
        {
            let client = first
                .prepare_client(Some(&bridge), &cancellation)
                .await
                .unwrap();
            assert_eq!(
                client
                    .get(format!("http://{address}/updated"))
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "ok"
            );
        }
        first.close();
        assert!(first
            .prepare_client(Some(&bridge), &cancellation)
            .await
            .unwrap_err()
            .is_abort());
        {
            let client = second
                .prepare_client(Some(&bridge), &cancellation)
                .await
                .unwrap();
            assert_eq!(
                client
                    .get(format!("http://{address}/second-owner"))
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "ok"
            );
        }
        second.close();
        tokio::time::timeout(Duration::from_secs(2), peer)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bridge.prepares.load(Ordering::Relaxed), 4);
    }

    #[tokio::test]
    async fn body_observes_request_deadline_and_cancellation_and_closes_connection() {
        for abort in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let peer = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nfirst")
                    .await
                    .unwrap();
                let mut byte = [0];
                let closed = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte))
                    .await
                    .expect("dropped response must release its connection")
                    .unwrap();
                assert_eq!(closed, 0);
            });
            let context = ToolContext {
                session_id: "body-lifecycle".into(),
                cwd: ".".into(),
                env: json!({}),
                current_turn: 0,
                tool_use_id: "body-lifecycle".into(),
                cancellation: tokio_util::sync::CancellationToken::new(),
                harness: crate::harness::baseline(),
            };
            let client = reqwest::Client::new();
            let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
            let response = match request_step(
                client.get(format!("http://{address}/")).send(),
                deadline,
                &context,
                "headers",
            )
            .await
            {
                Ok(response) => response,
                Err(_) => panic!("local server must return headers before the deadline"),
            };
            if abort {
                context.cancellation.cancel();
            } else {
                tokio::time::sleep_until(deadline).await;
            }
            let result = request_step(response.text(), deadline, &context, "body").await;
            assert!(matches!(
                (abort, result),
                (false, Err(RequestFailure::Timeout)) | (true, Err(RequestFailure::Aborted))
            ));
            peer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cached_body_retains_data_and_renders_current_model_feedback() {
        let tool = WebTool::default();
        tool.cache.lock().await.insert(
            "https://fixture.invalid/".into(),
            ("opaque {length}".into(), 100001, Instant::now()),
        );
        let harness = crate::harness::Harness::from_config(&json!({"models":{
            "a":{"tools.web.truncated":"A {body} {length}"},
            "b":{"tools.web.truncated":"B {body} {length}"}
        }}))
        .unwrap();
        let mut context = ToolContext {
            session_id: "fixture".into(),
            cwd: ".".into(),
            env: json!({}),
            current_turn: 0,
            tool_use_id: "fixture".into(),
            cancellation: tokio_util::sync::CancellationToken::new(),
            harness: harness.for_model("a"),
        };
        let input = json!({"url":"https://fixture.invalid/"});
        assert_eq!(
            tool.execute(&input, &context, None).await["content"],
            "A opaque {length} 100001"
        );
        context.harness = harness.for_model("b");
        assert_eq!(
            tool.execute(&input, &context, None).await["content"],
            "B opaque {length} 100001"
        );
    }
}
