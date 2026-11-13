/**
 * @module native/provider-factory
 * Provider factory and auto-detection.
 * Creates LlmProvider instances from configuration objects, with automatic
 * provider detection based on API key format and model name prefixes.
 * @license MIT
 */

import type { LlmProvider } from '../types/provider.js';
import { AnthropicProvider, OpenAiCompatProvider } from './providers.js';
import type { AnthropicProviderConfig } from '../llm/anthropic.js';
import type { OpenAiCompatProviderConfig, ProviderQuirks } from '../llm/openai-compat.js';

// ---------------------------------------------------------------------------
// ProviderConfig
// ---------------------------------------------------------------------------

/** Configuration for creating an LLM provider. */
export interface ProviderConfig {
  /** Provider type. If omitted, auto-detected from apiKey/model. */
  type?: 'anthropic' | 'openai-compat';
  /** API key */
  apiKey: string;
  /** Base URL override */
  baseUrl?: string;
  /** Default model */
  defaultModel?: string;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Anthropic API version header */
  apiVersion?: string;
  /** Anthropic beta feature headers */
  betas?: string[];
  /** Provider-specific quirks (OpenAI-compat only) */
  quirks?: ProviderQuirks;
  /** Provider identifier for OpenAI-compat (e.g. "deepseek", "groq") */
  providerId?: string;
  /** Provider display name for OpenAI-compat */
  providerName?: string;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an LLM provider from a configuration object.
 *
 * Auto-detection rules when `type` is omitted:
 * - API key starts with `sk-ant-` → Anthropic
 * - Otherwise → OpenAI-compat
 */
export function createProvider(config: ProviderConfig): LlmProvider {
  const providerType = config.type ?? detectProviderType(config);

  switch (providerType) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'openai-compat':
      return createOpenAiCompatProvider(config);
    default:
      throw new Error(`Unknown provider type: ${providerType}`);
  }
}

/**
 * Create a well-known pre-configured provider by name.
 * Reads API keys from environment variables.
 */
export function createWellKnownProvider(
  name: string,
  overrides?: Partial<ProviderConfig>,
): LlmProvider {
  const factory = WELL_KNOWN_PROVIDERS[name.toLowerCase()];
  if (!factory) {
    throw new Error(
      `Unknown provider: "${name}". Known providers: ${Object.keys(WELL_KNOWN_PROVIDERS).join(', ')}`,
    );
  }
  return factory(overrides);
}

/** List all well-known provider names. */
export function listWellKnownProviders(): string[] {
  return Object.keys(WELL_KNOWN_PROVIDERS);
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

function detectProviderType(config: ProviderConfig): 'anthropic' | 'openai-compat' {
  if (config.apiKey.startsWith('sk-ant-')) return 'anthropic';
  return 'openai-compat';
}

// ---------------------------------------------------------------------------
// Internal factory helpers
// ---------------------------------------------------------------------------

function createAnthropicProvider(config: ProviderConfig): AnthropicProvider {
  const anthConfig: AnthropicProviderConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    apiVersion: config.apiVersion,
    betas: config.betas,
    headers: config.headers,
    defaultModel: config.defaultModel,
  };
  return new AnthropicProvider(anthConfig);
}

function createOpenAiCompatProvider(config: ProviderConfig): OpenAiCompatProvider {
  const compatConfig: OpenAiCompatProviderConfig = {
    id: config.providerId ?? 'openai-compat',
    name: config.providerName ?? 'OpenAI Compatible',
    baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: config.apiKey,
    headers: config.headers,
    defaultModel: config.defaultModel,
    quirks: config.quirks,
  };
  return new OpenAiCompatProvider(compatConfig);
}

// ---------------------------------------------------------------------------
// Well-known provider factories
// ---------------------------------------------------------------------------

function getEnvKey(name: string): string {
  return typeof process !== 'undefined' ? (process.env?.[name] ?? '') : '';
}

const WELL_KNOWN_PROVIDERS: Record<
  string,
  (overrides?: Partial<ProviderConfig>) => LlmProvider
> = {
  anthropic: (o) =>
    createAnthropicProvider({
      apiKey: o?.apiKey ?? getEnvKey('ANTHROPIC_API_KEY'),
      baseUrl: o?.baseUrl,
      defaultModel: o?.defaultModel,
      headers: o?.headers,
      betas: o?.betas,
      apiVersion: o?.apiVersion,
    }),

  openai: (o) =>
    createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? getEnvKey('OPENAI_API_KEY'),
      providerId: 'openai',
      providerName: 'OpenAI',
      baseUrl: o?.baseUrl ?? 'https://api.openai.com/v1',
      defaultModel: o?.defaultModel,
      headers: o?.headers,
    }),

  deepseek: (o) =>
    createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? getEnvKey('DEEPSEEK_API_KEY'),
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      baseUrl: o?.baseUrl ?? 'https://api.deepseek.com/v1',
      defaultModel: o?.defaultModel,
      headers: o?.headers,
      quirks: o?.quirks ?? {
        reasoningField: 'reasoning_content',
        includeUsageInStream: true,
      },
    }),

  groq: (o) =>
    createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? getEnvKey('GROQ_API_KEY'),
      providerId: 'groq',
      providerName: 'Groq',
      baseUrl: o?.baseUrl ?? 'https://api.groq.com/openai/v1',
      defaultModel: o?.defaultModel,
      headers: o?.headers,
      quirks: o?.quirks ?? { includeUsageInStream: true },
    }),

  qwen: (o) =>
    createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? getEnvKey('DASHSCOPE_API_KEY'),
      providerId: 'qwen',
      providerName: 'Qwen (Alibaba)',
      baseUrl: o?.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: o?.defaultModel,
      headers: o?.headers,
      quirks: o?.quirks ?? { defaultTemperature: 0.55 },
    }),

  ollama: (o) => {
    const host = getEnvKey('OLLAMA_HOST') || 'http://localhost:11434';
    return createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? '',
      providerId: 'ollama',
      providerName: 'Ollama',
      baseUrl: o?.baseUrl ?? `${host.replace(/\/+$/, '')}/v1`,
      defaultModel: o?.defaultModel,
      headers: o?.headers,
    });
  },

  openrouter: (o) =>
    createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? getEnvKey('OPENROUTER_API_KEY'),
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      baseUrl: o?.baseUrl ?? 'https://openrouter.ai/api/v1',
      defaultModel: o?.defaultModel,
      headers: o?.headers,
      quirks: o?.quirks ?? { includeUsageInStream: true },
    }),

  mistral: (o) =>
    createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? getEnvKey('MISTRAL_API_KEY'),
      providerId: 'mistral',
      providerName: 'Mistral AI',
      baseUrl: o?.baseUrl ?? 'https://api.mistral.ai/v1',
      defaultModel: o?.defaultModel,
      headers: o?.headers,
      quirks: o?.quirks ?? {
        toolIdMaxLen: 9,
        toolIdAlphanumericOnly: true,
        fixToolUserSequence: true,
        includeUsageInStream: true,
      },
    }),

  xai: (o) =>
    createOpenAiCompatProvider({
      apiKey: o?.apiKey ?? getEnvKey('XAI_API_KEY'),
      providerId: 'xai',
      providerName: 'xAI (Grok)',
      baseUrl: o?.baseUrl ?? 'https://api.x.ai/v1',
      defaultModel: o?.defaultModel,
      headers: o?.headers,
    }),
};
