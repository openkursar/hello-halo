use super::{
    anthropic_stream::{AnthropicProvider, AnthropicStream},
    openai_request,
    openai_stream::{self, OpenAiStream},
    transport::{AttemptClient, ProviderTransport},
};
use crate::{
    bridge::HostBridge,
    error::{Error, Result},
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
enum ProviderKind {
    Anthropic(AnthropicProvider),
    OpenAi {
        config: Value,
        http: AttemptClient,
    },
    Custom(Arc<dyn HostBridge>),
}

#[derive(Clone)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub capabilities: Value,
    kind: ProviderKind,
    configuration: Option<Arc<ProviderConfiguration>>,
}
struct ProviderConfiguration {
    prompt_tools: bool,
    mode: String,
    inner_id: String,
    harness: Arc<crate::harness::Harness>,
    resolved: Mutex<Option<(String, Arc<crate::harness::ResolvedHarness>)>>,
}
impl ProviderConfiguration {
    fn resolve(&self, model: &str) -> Arc<crate::harness::ResolvedHarness> {
        let mut resolved = self.resolved.lock().unwrap();
        if let Some((saved, value)) = &*resolved {
            if saved == model {
                return value.clone();
            }
        }
        let value = self.harness.for_model(model);
        *resolved = Some((model.into(), value.clone()));
        value
    }
}

impl Provider {
    pub fn new(options: &Value, bridge: Arc<dyn HostBridge>) -> Result<Self> {
        if options["provider"]["__haloSdkNativeProvider"] == true {
            return Self::configure(options, Self::custom(&options["provider"], bridge));
        }
        let transport = ProviderTransport::new(bridge.http_trust())?;
        Self::with_transport(options, bridge, transport)
    }
    pub fn with_client(
        options: &Value,
        bridge: Arc<dyn HostBridge>,
        client: reqwest::Client,
    ) -> Result<Self> {
        Self::with_transport(options, bridge, ProviderTransport::supplied(client))
    }
    pub fn with_transport(
        options: &Value,
        bridge: Arc<dyn HostBridge>,
        transport: Arc<ProviderTransport>,
    ) -> Result<Self> {
        Self::configure(options, Self::raw(options, bridge, transport)?)
    }
    fn configure(options: &Value, mut provider: Self) -> Result<Self> {
        let mode = super::tool_calling::mode(options);
        let prompt_tools = mode != "native" || options["nativePromptAdapter"] == true;
        let config = ProviderConfiguration {
            prompt_tools,
            mode: mode.into(),
            inner_id: provider.id.clone(),
            harness: crate::harness::Harness::from_config(&options["harnessText"])?,
            resolved: Mutex::new(None),
        };
        if prompt_tools {
            provider.id = format!("{}:{mode}", provider.id);
            provider.name = format!("{} ({mode})", provider.name);
            provider.capabilities["toolCalling"] = json!(true);
        }
        provider.configuration = Some(Arc::new(config));
        Ok(provider)
    }
    fn custom(descriptor: &Value, bridge: Arc<dyn HostBridge>) -> Self {
        Self {
            id: descriptor["id"].as_str().unwrap_or("custom").into(),
            name: descriptor["name"].as_str().unwrap_or("Custom").into(),
            capabilities: descriptor["capabilities"].clone(),
            kind: ProviderKind::Custom(bridge),
            configuration: None,
        }
    }
    fn raw(options: &Value, bridge: Arc<dyn HostBridge>, transport: Arc<ProviderTransport>) -> Result<Self> {
        let descriptor = &options["provider"];
        if descriptor["__haloSdkNativeProvider"] == true {
            return Ok(Self::custom(descriptor, bridge));
        }
        let http = AttemptClient::new(transport, bridge.clone());
        let builtin = &descriptor["__haloSdkNativeBuiltinProvider"];
        let config = if builtin.is_object() {
            builtin["config"].clone()
        } else {
            let environment = &options["env"];
            let key = options["apiKey"]
                .as_str()
                .or(environment["ANTHROPIC_API_KEY"].as_str())
                .map(str::to_owned)
                .or_else(|| process_env(options, "ANTHROPIC_API_KEY"));
            if key.as_deref().is_none_or(str::is_empty) {
                return Err(Error::new("MISSING_PROVIDER","createSession() requires options.provider, options.apiKey, or ANTHROPIC_API_KEY in env."));
            }
            let url = options["anthropicBaseUrl"]
                .as_str()
                .or(environment["ANTHROPIC_BASE_URL"].as_str())
                .map(str::to_owned)
                .or_else(|| process_env(options, "ANTHROPIC_BASE_URL"))
                .unwrap_or_else(|| "https://api.anthropic.com".into());
            let mut config = json!({"apiKey":key,"baseUrl":url});
            if let Some(identity) = options.get("requestIdentity") {
                config["requestIdentity"] = identity.clone();
            }
            config
        };
        match builtin["kind"].as_str().unwrap_or("anthropic") {
            "anthropic" => Ok(Self {
                id: "anthropic".into(),
                name: "Anthropic".into(),
                capabilities: json!({"streaming":true,"toolCalling":true,"thinking":true,"imageInput":true,"pdfInput":true,"audioInput":false,"videoInput":false,"caching":true,"systemPromptStyle":"top_level"}),
                kind: ProviderKind::Anthropic(AnthropicProvider::with_http(config, bridge, http)),
                configuration: None,
            }),
            "openai-compat" => Ok(Self {
                id: config["id"].as_str().unwrap_or("openai-compat").into(),
                name: config["name"]
                    .as_str()
                    .unwrap_or("OpenAI Compatible")
                    .into(),
                capabilities: openai_request::capabilities(&config),
                kind: ProviderKind::OpenAi { config, http },
                configuration: None,
            }),
            kind => Err(Error::new(
                "PROVIDER_UNAVAILABLE",
                format!("Native provider implementation is unavailable: {kind}"),
            )),
        }
    }

    pub async fn stream(
        &self,
        request: Value,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream> {
        let tools = request["tools"].as_array().cloned().unwrap_or_default();
        let configuration = self.configuration.as_ref().unwrap();
        let harness = configuration.resolve(request["model"].as_str().unwrap_or(""));
        let adapter = (configuration.prompt_tools && !tools.is_empty())
            .then(|| (configuration, harness.clone()));
        let request = if let Some((adapter, harness)) = &adapter {
            super::tool_calling::adapt_request(
                &request,
                &adapter.mode,
                &adapter.inner_id,
                &self.capabilities,
                harness,
            )?
        } else {
            request
        };
        let inner = match &self.kind {
            ProviderKind::Anthropic(provider) => {
                RawProviderStream::Anthropic(provider.stream(request, cancellation).await?)
            }
            ProviderKind::OpenAi { config, http } => {
                RawProviderStream::OpenAi(OpenAiStream::with_http(
                    config.clone(),
                    request,
                    http.clone(),
                    cancellation,
                    &harness,
                )?)
            }
            ProviderKind::Custom(bridge) => {
                let id = bridge
                    .call("provider.start", request, &cancellation)
                    .await?;
                RawProviderStream::Custom {
                    bridge: bridge.clone(),
                    id,
                    cancellation,
                    done: false,
                }
            }
        };
        Ok(ProviderStream {
            inner,
            adapter: adapter
                .map(|(_, harness)| super::tool_calling::StreamAdapter::new(tools, harness)),
        })
    }
    pub async fn complete(&self, request: Value, cancellation: CancellationToken) -> Result<Value> {
        let tools = request["tools"].as_array().cloned().unwrap_or_default();
        let configuration = self.configuration.as_ref().unwrap();
        let harness = configuration.resolve(request["model"].as_str().unwrap_or(""));
        let adapter = (configuration.prompt_tools && !tools.is_empty())
            .then(|| (configuration, harness.clone()));
        let request = if let Some((adapter, harness)) = &adapter {
            super::tool_calling::adapt_request(
                &request,
                &adapter.mode,
                &adapter.inner_id,
                &self.capabilities,
                harness,
            )?
        } else {
            request
        };
        let response = self.complete_raw(request, cancellation, &harness).await?;
        if let Some((_, harness)) = adapter {
            super::tool_calling::adapt_response(response, &tools, &harness)
        } else {
            Ok(response)
        }
    }
    async fn complete_raw(
        &self,
        request: Value,
        cancellation: CancellationToken,
        harness: &crate::harness::ResolvedHarness,
    ) -> Result<Value> {
        match &self.kind {
            ProviderKind::Anthropic(provider) => {
                let model = provider.resolve_model(&request)?;
                let mut stream = provider.stream(request, cancellation).await?;
                let mut collector = super::anthropic_response::ResponseCollector::new(model);
                let outcome = async {
                    while let Some(event) = stream.next().await? {
                        collector.event(&event)?;
                    }
                    Ok(collector.finish())
                }
                .await;
                stream.close().await?;
                outcome
            }
            ProviderKind::OpenAi { config, http } => {
                openai_stream::complete_with_http(
                    config,
                    &request,
                    http,
                    &cancellation,
                    harness,
                )
                .await
            }
            ProviderKind::Custom(bridge) => {
                bridge
                    .call("provider.complete", request, &cancellation)
                    .await
            }
        }
    }
    pub async fn list_models(&self, cancellation: &CancellationToken) -> Result<Value> {
        match &self.kind {
            ProviderKind::Anthropic(provider) => provider.list_models(cancellation).await,
            ProviderKind::OpenAi { config, http } => {
                let client = http.client(cancellation).await?;
                Ok(openai_stream::list_models(config, &client).await)
            }
            ProviderKind::Custom(bridge) => {
                bridge
                    .call("provider.models", json!({}), cancellation)
                    .await
            }
        }
    }
    pub async fn health_check(&self, cancellation: &CancellationToken) -> Result<Value> {
        match &self.kind {
            ProviderKind::Anthropic(provider) => Ok(provider.health_check()),
            ProviderKind::OpenAi { config, http } => {
                openai_stream::health_check_with_http(config, http, cancellation).await
            }
            ProviderKind::Custom(bridge) => {
                bridge
                    .call("provider.health", json!({}), cancellation)
                    .await
            }
        }
    }
}

pub struct ProviderStream {
    inner: RawProviderStream,
    adapter: Option<super::tool_calling::StreamAdapter>,
}
enum RawProviderStream {
    Anthropic(AnthropicStream),
    OpenAi(OpenAiStream),
    Custom {
        bridge: Arc<dyn HostBridge>,
        id: Value,
        cancellation: CancellationToken,
        done: bool,
    },
}
impl ProviderStream {
    pub async fn next(&mut self) -> Result<Option<Value>> {
        let Some(adapter) = self.adapter.as_mut() else {
            return self.inner.next().await;
        };
        loop {
            if let Some(event) = adapter.next() {
                return Ok(Some(event));
            }
            let Some(event) = self.inner.next().await? else {
                return Ok(None);
            };
            adapter.event(event)?;
        }
    }
    pub async fn close(&mut self) -> Result<()> {
        self.inner.close().await
    }
}
impl RawProviderStream {
    pub async fn next(&mut self) -> Result<Option<Value>> {
        match self {
            Self::Anthropic(stream) => stream.next().await,
            Self::OpenAi(stream) => stream.next().await,
            Self::Custom {
                bridge,
                id,
                cancellation,
                done,
            } => {
                if *done {
                    return Ok(None);
                }
                let result = bridge
                    .call("provider.next", json!({"streamId":id}), cancellation)
                    .await?;
                if result["done"] == true {
                    *done = true;
                    Ok(None)
                } else {
                    Ok(result.get("value").cloned())
                }
            }
        }
    }
    pub async fn close(&mut self) -> Result<()> {
        match self {
            Self::Anthropic(stream) => stream.close().await,
            Self::OpenAi(stream) => stream.close().await,
            Self::Custom {
                bridge,
                id,
                done,
                cancellation,
            } => {
                if !*done {
                    *done = true;
                    let cancelled = cancellation.is_cancelled();
                    let result = bridge
                        .call(
                            "provider.return",
                            json!({"streamId":id,"cancelled":cancelled}),
                            &CancellationToken::new(),
                        )
                        .await;
                    if cancelled {
                        if let Err(error) = result {
                            tracing::warn!(code=%error.code,"Provider stream cleanup failed after cancellation");
                        }
                    } else {
                        result?;
                    }
                }
                Ok(())
            }
        }
    }
}

fn process_env(options: &Value, name: &str) -> Option<String> {
    match options.get("nativeProcessEnv") {
        Some(environment) => environment[name].as_str().map(str::to_owned),
        None => std::env::var(name).ok(),
    }
}
