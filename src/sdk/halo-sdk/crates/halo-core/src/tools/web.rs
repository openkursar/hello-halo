use super::{failure, success, ToolContext};
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
#[derive(Clone)]
struct CacheEntry {
    body: String,
    saved: Option<super::output::SaveState>,
    complete_text: bool,
    response_limited: bool,
    stamp: Instant,
}
#[derive(Default)]
pub struct WebTool {
    cache: Mutex<HashMap<String, CacheEntry>>,
    client: StdMutex<ClientState>,
    store: std::sync::OnceLock<Arc<super::output::OutputStore>>,
    preview_limit: Option<usize>,
    configured_limit: bool,
}
const RESPONSE_LIMIT: usize = 10 * 1024 * 1024;

fn budget_label(harness: &ResolvedHarness, limit: usize, configured: bool) -> String {
    let id = if configured {
        crate::harness::TextId::ToolsOutputBudgetConfigured
    } else {
        crate::harness::TextId::ToolsOutputBudgetPreview
    };
    harness.render(id, &[("character_limit", &limit.to_string())])
}

fn storage_notice(
    saved: Option<&super::output::SaveState>,
    path_available: bool,
    harness: &ResolvedHarness,
) -> String {
    use crate::harness::TextId;
    if path_available {
        if let Some(path) = saved.and_then(super::output::SaveState::path) {
            return harness.render(
                TextId::ToolsWebRetained,
                &[("path", &path.to_string_lossy())],
            );
        }
    }
    let reason = match saved {
        Some(super::output::SaveState::Partial { reason, .. })
        | Some(super::output::SaveState::Failed { reason }) => reason.render(harness),
        Some(super::output::SaveState::Complete { .. }) => {
            harness.text(TextId::ToolsOutputReasonUnsafeCopy).into()
        }
        None => harness.text(TextId::ToolsOutputReasonUnavailable).into(),
    };
    harness.render(TextId::ToolsWebNotSaved, &[("reason", &reason)])
}

fn fit_web_text(
    body: &str,
    notices: &[String],
    limit: usize,
    label: &str,
    harness: &ResolvedHarness,
) -> String {
    if notices.is_empty() {
        return crate::js::utf16_prefix_without_split(body, limit);
    }
    let notice_len: usize = notices
        .iter()
        .map(|notice| crate::js::utf16_len(notice))
        .sum::<usize>()
        .saturating_add(2 * notices.len());
    if notice_len.saturating_add(2) >= limit {
        let short = harness.render(
            crate::harness::TextId::ToolsOutputShort,
            &[("budget", label)],
        );
        return if crate::js::utf16_len(&short) <= limit {
            short
        } else if limit == 0 {
            String::new()
        } else {
            crate::js::utf16_prefix(
                harness.text(crate::harness::TextId::ContextTruncationMarker),
                limit,
            )
        };
    }
    let available = limit - notice_len - 2;
    let preview = crate::js::utf16_prefix_without_split(body, available);
    format!("{preview}\n\n{}", notices.join("\n"))
}

impl WebTool {
    pub fn new(
        store: Option<Arc<super::output::OutputStore>>,
        preview_limit: usize,
        configured_limit: bool,
    ) -> Self {
        let tool = Self {
            preview_limit: Some(preview_limit),
            configured_limit,
            ..Self::default()
        };
        if let Some(store) = store {
            let _ = tool.store.set(store);
        }
        tool
    }

    pub fn set_store(&self, store: Arc<super::output::OutputStore>) {
        let _ = self.store.set(store);
    }

    fn limit(&self) -> usize {
        self.preview_limit.unwrap_or(100_000)
    }

    fn store(&self) -> Option<&Arc<super::output::OutputStore>> {
        self.store.get()
    }

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

    async fn render_cached(
        &self,
        entry: &CacheEntry,
        harness: &ResolvedHarness,
    ) -> String {
        use crate::harness::TextId;
        let limit = self.limit();
        let label = budget_label(harness, limit, self.configured_limit);
        let path_available = match entry
            .saved
            .as_ref()
            .and_then(super::output::SaveState::path)
        {
            Some(path) => tokio::fs::metadata(path).await.is_ok(),
            None => false,
        };
        let mut notices = Vec::new();
        if !entry.complete_text && !entry.response_limited {
            match (path_available, entry.saved.as_ref()) {
                (true, Some(super::output::SaveState::Complete { path, .. })) => {
                    notices.push(harness.render(
                        TextId::ToolsWebTruncated,
                        &[("budget", &label), ("path", &path.to_string_lossy())],
                    ));
                }
                (true, Some(super::output::SaveState::Partial { path, reason, .. })) => {
                    notices.push(harness.render(
                        TextId::ToolsWebTruncatedPartial,
                        &[
                            ("budget", &label),
                            ("path", &path.to_string_lossy()),
                            ("reason", &reason.render(harness)),
                        ],
                    ));
                }
                (_, Some(super::output::SaveState::Failed { reason })) => {
                    notices.push(harness.render(
                        TextId::ToolsWebTruncatedNoSave,
                        &[("budget", &label), ("reason", &reason.render(harness))],
                    ));
                }
                (_, Some(_)) => {
                    notices.push(harness.text(TextId::ToolsWebCacheUnavailable).into());
                }
                _ => {
                    notices.push(harness.render(
                        TextId::ToolsWebTruncatedNoSave,
                        &[
                            ("budget", &label),
                            (
                                "reason",
                                harness
                                    .text(TextId::ToolsOutputReasonUnavailable)
                             .into(),
                            ),
                        ],
                    ));
                }
            }
        }
        if entry.response_limited {
            notices.push(harness.render(
                TextId::ToolsWebResponseLimit,
                &[
                    ("byte_limit", &RESPONSE_LIMIT.to_string()),
                    (
                        "storage_notice",
                        &storage_notice(entry.saved.as_ref(), path_available, harness),
                    ),
                ],
            ));
        }
        fit_web_text(&entry.body, &notices, limit, &label, harness)
    }

    pub async fn execute(
        &self,
        input: &Value,
        ctx: &ToolContext,
        bridge: Option<&dyn HostBridge>,
    ) -> Value {
        let harness = &ctx.harness;
        let Some(raw) = input["url"].as_str().filter(|s| !s.is_empty()) else {
            return failure(harness.text(crate::harness::TextId::ToolsWebMissingUrl));
        };
        let url = if let Some(rest) = raw.strip_prefix("http://") {
            format!("https://{rest}")
        } else {
            raw.into()
        };
        let parsed = match reqwest::Url::parse(&url) {
            Ok(u) => u,
            Err(_) => {
                return failure(harness.render(
                    crate::harness::TextId::ToolsWebInvalidUrl,
                    &[("url", raw)],
                ))
            }
        };
        let cached = {
            let mut cache = self.cache.lock().await;
            cache.retain(|_, entry| entry.stamp.elapsed() < Duration::from_secs(900));
            cache.get(&url).cloned()
        };
        if let Some(entry) = cached {
            let mut result = success(self.render_cached(&entry, harness).await, None);
            result["__haloSdkNativeOutput"] = json!("web_preview");
            return result;
        }
        if ctx.cancellation.is_cancelled() {
            return failure(harness.text(crate::harness::TextId::ToolsWebAborted));
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
        let mut response = match request_step(
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
                    crate::harness::TextId::ToolsWebRedirect,
                    &[("url", response.url().as_str())],
                ),
                None,
            );
        }
        if !response.status().is_success() {
            return failure(harness.render(
                crate::harness::TextId::ToolsWebHttpError,
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
        let (body, response_limited) =
            match read_body(&mut response, deadline, ctx).await {
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
        let length = crate::js::utf16_len(&text);
        let limit = self.limit();
        let complete_text = length <= limit;
        let saved = if !complete_text || response_limited {
            match self.store() {
                Some(store) => Some(store.save_text("web", &text).await),
                None => Some(super::output::SaveState::Failed {
                    reason: super::output::SaveReason::StorageUnavailable,
                }),
            }
        } else {
            None
        };
        let label = budget_label(harness, limit, self.configured_limit);
        let path_available = match saved
            .as_ref()
            .and_then(super::output::SaveState::path)
        {
            Some(path) => tokio::fs::metadata(path).await.is_ok(),
            None => false,
        };
        let mut notices = Vec::new();
        if !complete_text && !response_limited {
            match saved.as_ref() {
                Some(super::output::SaveState::Complete { path, .. }) => notices.push(
                    harness.render(
                        crate::harness::TextId::ToolsWebTruncated,
                        &[("budget", &label), ("path", &path.to_string_lossy())],
                    ),
                ),
                Some(super::output::SaveState::Partial { path, reason, .. }) => {
                    notices.push(harness.render(
                        crate::harness::TextId::ToolsWebTruncatedPartial,
                        &[
                            ("budget", &label),
                            ("path", &path.to_string_lossy()),
                            ("reason", &reason.render(harness)),
                        ],
                    ))
                }
                Some(super::output::SaveState::Failed { reason }) => notices.push(
                    harness.render(
                        crate::harness::TextId::ToolsWebTruncatedNoSave,
                        &[("budget", &label), ("reason", &reason.render(harness))],
                    ),
                ),
                None => notices.push(harness.render(
                    crate::harness::TextId::ToolsWebTruncatedNoSave,
                    &[
                        ("budget", &label),
                        (
                            "reason",
                            harness.text(crate::harness::TextId::ToolsOutputReasonUnavailable),
                        ),
                    ],
                )),
            }
        }
        if response_limited {
            notices.push(harness.render(
                crate::harness::TextId::ToolsWebResponseLimit,
                &[
                    ("byte_limit", &RESPONSE_LIMIT.to_string()),
                    (
                        "storage_notice",
                        &storage_notice(saved.as_ref(), path_available, harness),
                    ),
                ],
            ));
        }
        let shown = fit_web_text(&text, &notices, limit, &label, harness);
        let preview = crate::js::utf16_prefix_without_split(&text, limit);
        self.cache.lock().await.insert(
            url,
            CacheEntry {
                body: preview,
                saved: saved.clone(),
                complete_text,
                response_limited,
                stamp: Instant::now(),
            },
        );
        let mut result = success(shown, None);
        result["__haloSdkNativeOutput"] = json!("web_preview");
        if let Some(path) = saved.as_ref().and_then(super::output::SaveState::path) {
            result["__haloSdkNativeSavedOutput"] = json!(path);
        }
        result
    }
}
async fn read_body(
    response: &mut reqwest::Response,
    deadline: tokio::time::Instant,
    ctx: &ToolContext,
) -> Result<(String, bool), RequestFailure> {
    let mut bytes = Vec::new();
    let mut limited = false;
    loop {
        let chunk = request_step(response.chunk(), deadline, ctx, "body").await?;
        let Some(chunk) = chunk else { break };
        let remaining = RESPONSE_LIMIT.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            limited = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), limited))
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

    #[test]
    fn markdown_conversion_preserves_original_web_tool_cases() {
        for (html, expected) in [
            ("<h1>Title</h1><h2>Sub</h2>",vec!["# Title","## Sub"]),
            ("<a href=\"https://example.com\">Click</a>",vec!["[Click](https://example.com)"]),
            ("<strong>Bold</strong> and <em>Italic</em>",vec!["**Bold**","*Italic*"]),
            ("<code>const x = 1</code>",vec!["`const x = 1`"]),
            ("<pre><code>function foo() {}</code></pre>",vec!["```","function foo() {}"]),
            ("<ul><li>Apple</li><li>Banana</li></ul>",vec!["- Apple","- Banana"]),
            ("&amp; &lt; &gt; &quot; &nbsp;",vec!["&","<",">","\""]),
        ] {
            let markdown = html_to_markdown(html);
            for fragment in expected { assert!(markdown.contains(fragment),"{html}: {fragment}"); }
        }
        for (html, forbidden, visible) in [
            ("<p>Hello</p><script>alert(\"xss\")</script>","alert","Hello"),
            ("<style>.foo { color: red; }</style><p>Content</p>","color","Content"),
            ("<!-- secret -->Visible","secret","Visible"),
        ] {
            let markdown = html_to_markdown(html);
            assert!(!markdown.contains(forbidden));
            assert!(markdown.contains(visible));
        }
        assert!(!html_to_markdown("<p>A</p>\n\n\n\n<p>B</p>").contains("\n\n\n"));
        let markdown = html_to_markdown("<div><span class=\"foo\">Text</span></div>");
        assert!(!markdown.contains('<'));
        assert!(!markdown.contains('>'));
        assert!(markdown.contains("Text"));
    }

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
            CacheEntry {
                body: "opaque {length}".into(),
                saved: Some(super::super::output::SaveState::Failed {
                    reason: super::super::output::SaveReason::StorageUnavailable,
                }),
                complete_text: false,
                response_limited: false,
                stamp: Instant::now(),
            },
        );
        let harness = crate::harness::Harness::from_config(&json!({"models":{
            "a":{"tools.web.truncated_no_save":"A {budget} | {reason}"},
            "b":{"tools.web.truncated_no_save":"B {budget} | {reason}"}
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
        let first = tool.execute(&input, &context, None).await["content"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(first.starts_with("opaque {length}\n\nA 100000-UTF-16-code-unit preview limit | "));
        assert!(first.contains("output storage is unavailable"));
        context.harness = harness.for_model("b");
        let second = tool.execute(&input, &context, None).await["content"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(second.starts_with("opaque {length}\n\nB 100000-UTF-16-code-unit preview limit | "));
    }
}
