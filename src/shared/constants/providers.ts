/**
 * Built-in LLM Providers Configuration
 *
 * This module defines all built-in AI providers that Halo supports out of the box.
 * Users can select these providers and only need to enter their API key.
 *
 * Based on: 2026 Global Top LLM Providers (OpenAI Compatible Version)
 *
 * Design Principles:
 * - All providers support OpenAI-compatible chat/completions API
 * - Anthropic is the only exception (native Claude API)
 * - Providers are organized by region (China / Overseas)
 * - Each provider has a default model list that can be fetched dynamically
 */

import type { AuthType, ModelOption, ProviderId } from '../types/ai-sources'

// ============================================================================
// Provider Configuration Interface
// ============================================================================

/**
 * Built-in provider configuration
 */
export interface BuiltinProvider {
  /** Provider ID (unique identifier) */
  id: ProviderId
  /** Display name */
  name: string
  /** Authentication method */
  authType: AuthType
  /** Default API endpoint URL (base URL) */
  apiUrl: string
  /** API type for OpenAI compatible (default: chat_completions) */
  apiType?: 'chat_completions' | 'responses'
  /** Models list endpoint (for dynamic fetching) */
  modelsUrl?: string
  /** Pre-configured model list */
  models: ModelOption[]
  /** Provider description */
  description?: string
  /** Official website */
  website?: string
  /** Region: 'cn' for China, 'global' for overseas */
  region: 'cn' | 'global'
  /** Whether this provider is recommended */
  recommended?: boolean
  /** Icon name (lucide icon) */
  icon?: string
  /** Special notes for this provider */
  notes?: string
}

// ============================================================================
// Built-in Providers List
// ============================================================================

/**
 * All built-in providers
 * Organized by: Protocol entries first (Claude/OpenAI Compatible), then presets by region
 */
export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  // ============================================================================
  // Protocol Entries (Top 2 - Always visible, support custom URL)
  // ============================================================================
  {
    id: 'anthropic',
    name: 'Claude (Recommended)',
    authType: 'api-key',
    apiUrl: 'https://api.anthropic.com',
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }
    ],
    description: 'Anthropic official or compatible proxy',
    website: 'https://console.anthropic.com/',
    region: 'global',
    recommended: true,
    icon: 'brain'
  },
  {
    id: 'openai',
    name: 'OpenAI Compatible',
    authType: 'api-key',
    apiUrl: 'https://api.openai.com/v1',
    modelsUrl: 'https://api.openai.com/v1/models',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'o1', name: 'o1' },
      { id: 'o1-mini', name: 'o1-mini' }
    ],
    description: 'OpenAI or any compatible API endpoint',
    website: 'https://platform.openai.com/',
    region: 'global',
    recommended: true,
    icon: 'bot'
  },

  // ============================================================================
  // China Region Providers (Presets)
  // ============================================================================
  {
    id: 'deepseek',
    name: 'DeepSeek',
    authType: 'api-key',
    apiUrl: 'https://api.deepseek.com',
    modelsUrl: 'https://api.deepseek.com/models',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat (V3.2)' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' }
    ],
    description: 'DeepSeek official API with V3.2 and R1 reasoning model',
    website: 'https://platform.deepseek.com/',
    region: 'cn',
    recommended: true,
    icon: 'search',
    notes: 'R1 model returns reasoning_content field for chain of thought'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    authType: 'api-key',
    apiUrl: 'https://api.siliconflow.cn/v1',
    modelsUrl: 'https://api.siliconflow.cn/v1/models',
    models: [
      { id: 'Pro/deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
      { id: 'Pro/deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
      { id: 'Pro/zai-org/GLM-4.7', name: 'GLM-4.7' },
      { id: 'Pro/moonshotai/Kimi-K2.5', name: 'Kimi K2.5' }
    ],
    description: 'SiliconFlow aggregator with multiple models',
    website: 'https://siliconflow.cn/',
    region: 'cn',
    recommended: true,
    icon: 'cpu',
    notes: 'Model IDs contain slashes, may need URL encoding. 402 = insufficient balance'
  },
  {
    id: 'aliyun',
    name: 'Aliyun DashScope (Qwen)',
    authType: 'api-key',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    models: [
      { id: 'qwen3-max', name: 'Qwen3 Max' },
      { id: 'qwen3-coder', name: 'Qwen3 Coder' },
      { id: 'qwen-plus', name: 'Qwen Plus' }
    ],
    description: 'Alibaba Cloud Qwen models',
    website: 'https://dashscope.console.aliyun.com/',
    region: 'cn',
    icon: 'cloud',
    notes: 'Base URL must include compatible-mode. Use extra_body.enable_search for web search'
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (Kimi)',
    authType: 'api-key',
    apiUrl: 'https://api.moonshot.ai/v1',
    modelsUrl: 'https://api.moonshot.ai/v1/models',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'kimi-k2', name: 'Kimi K2' },
      { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K' }
    ],
    description: 'Moonshot AI Kimi models',
    website: 'https://platform.moonshot.ai/',
    region: 'cn',
    icon: 'moon',
    notes: 'Kimi K2.5 is the latest multimodal agentic model'
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI (GLM)',
    authType: 'api-key',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    models: [
      { id: 'glm-4.7', name: 'GLM-4.7' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus' }
    ],
    description: 'Zhipu AI GLM models',
    website: 'https://open.bigmodel.cn/',
    region: 'cn',
    icon: 'sparkles',
    notes: 'GLM-4.7 is 355B MoE model with strong coding capabilities'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    authType: 'api-key',
    apiUrl: 'https://api.minimax.io/v1',
    modelsUrl: 'https://api.minimax.io/v1/models',
    models: [
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1' },
      { id: 'MiniMax-M1', name: 'MiniMax M1' }
    ],
    description: 'MiniMax AI models',
    website: 'https://www.minimaxi.com/',
    region: 'cn',
    icon: 'minimize',
    notes: 'China mainland use api.minimaxi.com, global use api.minimax.io'
  },
  {
    id: 'yi',
    name: '01.AI (Yi)',
    authType: 'api-key',
    apiUrl: 'https://api.lingyiwanwu.com/v1',
    modelsUrl: 'https://api.lingyiwanwu.com/v1/models',
    models: [
      { id: 'yi-lightning', name: 'Yi Lightning' },
      { id: 'yi-large', name: 'Yi Large' },
      { id: 'yi-medium', name: 'Yi Medium 200K' }
    ],
    description: '01.AI Yi models',
    website: 'https://platform.lingyiwanwu.com/',
    region: 'cn',
    icon: 'eye',
    notes: 'Yi-Lightning uses MoE architecture with 40% faster inference'
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    authType: 'api-key',
    apiUrl: 'https://api.stepfun.com/v1',
    modelsUrl: 'https://api.stepfun.com/v1/models',
    models: [
      { id: 'step-2', name: 'Step-2 (Trillion)' },
      { id: 'step-2-mini', name: 'Step-2 Mini' }
    ],
    description: 'StepFun with trillion-parameter models',
    website: 'https://platform.stepfun.com/',
    region: 'cn',
    icon: 'film',
    notes: 'Step-2 is trillion-parameter MoE model. Supports video_url content type'
  },

  // ============================================================================
  // Global/Overseas Providers (Presets)
  // ============================================================================
  {
    id: 'openrouter',
    name: 'OpenRouter',
    authType: 'api-key',
    apiUrl: 'https://openrouter.ai/api/v1',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    models: [
      { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5' },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
      { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro' },
      { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' }
    ],
    description: 'OpenRouter aggregator with 400+ models',
    website: 'https://openrouter.ai/',
    region: 'global',
    recommended: true,
    icon: 'route',
    notes: 'Requires HTTP-Referer and X-Title headers. Supports model array for failover'
  },
  {
    id: 'groq',
    name: 'Groq',
    authType: 'api-key',
    apiUrl: 'https://api.groq.com/openai/v1',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    models: [
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }
    ],
    description: 'Groq ultra-fast inference',
    website: 'https://console.groq.com/',
    region: 'global',
    icon: 'zap',
    notes: 'Do not set temperature=0, use 0.01 instead. Strict rate limits, implement exponential backoff'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    authType: 'api-key',
    apiUrl: 'https://api.mistral.ai/v1',
    modelsUrl: 'https://api.mistral.ai/v1/models',
    models: [
      { id: 'mistral-large-2512', name: 'Mistral Large' },
      { id: 'mistral-medium-3.1', name: 'Mistral Medium 3.1' },
      { id: 'codestral-2508', name: 'Codestral' }
    ],
    description: 'Mistral AI French models',
    website: 'https://console.mistral.ai/',
    region: 'global',
    icon: 'wind',
    notes: 'safe_prompt parameter for content filtering'
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    authType: 'api-key',
    apiUrl: 'https://api.deepinfra.com/v1/openai',
    modelsUrl: 'https://api.deepinfra.com/v1/openai/models',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', name: 'Qwen3 235B' }
    ],
    description: 'DeepInfra cost-effective inference',
    website: 'https://deepinfra.com/',
    region: 'global',
    icon: 'server',
    notes: 'Cold models may have 10s+ startup delay'
  },
  {
    id: 'together',
    name: 'Together AI',
    authType: 'api-key',
    apiUrl: 'https://api.together.xyz/v1',
    modelsUrl: 'https://api.together.xyz/v1/models',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', name: 'Llama 4 Maverick' }
    ],
    description: 'Together AI inference platform',
    website: 'https://api.together.xyz/',
    region: 'global',
    icon: 'users',
    notes: 'Supports repetition_penalty parameter'
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    authType: 'api-key',
    apiUrl: 'https://api.fireworks.ai/inference/v1',
    modelsUrl: 'https://api.fireworks.ai/inference/v1/models',
    models: [
      { id: 'accounts/fireworks/models/deepseek-v3p2', name: 'DeepSeek V3.2' },
      { id: 'accounts/fireworks/models/deepseek-r1-0528', name: 'DeepSeek R1' },
      { id: 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B' }
    ],
    description: 'Fireworks AI fast inference',
    website: 'https://fireworks.ai/',
    region: 'global',
    icon: 'flame',
    notes: 'Model IDs have long path format'
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    authType: 'api-key',
    apiUrl: 'https://api.x.ai/v1',
    modelsUrl: 'https://api.x.ai/v1/models',
    models: [
      { id: 'grok-4', name: 'Grok-4' },
      { id: 'grok-4.1-fast', name: 'Grok-4.1 Fast' },
      { id: 'grok-3', name: 'Grok-3' }
    ],
    description: 'xAI Grok models',
    website: 'https://x.ai/',
    region: 'global',
    icon: 'message-circle',
    notes: 'Grok-4.1 Fast has 2M context window for agentic tasks'
  },

  // ============================================================================
  // OAuth Providers
  // ============================================================================
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    authType: 'oauth',
    apiUrl: 'https://api.githubcopilot.com',
    models: [], // Fetched dynamically after OAuth login
    description: 'Login with GitHub account',
    website: 'https://github.com/features/copilot',
    region: 'global',
    icon: 'github'
  },

]

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get provider by ID
 */
export function getBuiltinProvider(id: ProviderId): BuiltinProvider | undefined {
  return BUILTIN_PROVIDERS.find(p => p.id === id)
}

/**
 * Check if a provider ID is built-in
 */
export function isBuiltinProvider(id: string): boolean {
  return BUILTIN_PROVIDERS.some(p => p.id === id)
}

/**
 * Get all recommended providers
 */
export function getRecommendedProviders(): BuiltinProvider[] {
  return BUILTIN_PROVIDERS.filter(p => p.recommended)
}

/**
 * Get providers by region
 */
export function getProvidersByRegion(region: 'cn' | 'global'): BuiltinProvider[] {
  return BUILTIN_PROVIDERS.filter(p => p.region === region)
}

/**
 * Get all API-key based providers (exclude OAuth)
 */
export function getApiKeyProviders(): BuiltinProvider[] {
  return BUILTIN_PROVIDERS.filter(p => p.authType === 'api-key')
}

/**
 * Get provider display info for UI
 */
export function getProviderDisplayInfo(id: ProviderId): {
  name: string
  icon: string
  description: string
} {
  const provider = getBuiltinProvider(id)
  if (provider) {
    return {
      name: provider.name,
      icon: provider.icon || 'server',
      description: provider.description || ''
    }
  }
  return {
    name: id,
    icon: 'server',
    description: ''
  }
}

/**
 * Get default model for a provider
 */
export function getDefaultModel(id: ProviderId): string | undefined {
  const provider = getBuiltinProvider(id)
  return provider?.models[0]?.id
}

/**
 * Check if provider requires OAuth
 */
export function isOAuthProvider(id: ProviderId): boolean {
  const provider = getBuiltinProvider(id)
  return provider?.authType === 'oauth'
}

/**
 * Check if provider is Anthropic (uses native API, not OpenAI-compat)
 */
export function isAnthropicProvider(id: ProviderId): boolean {
  return id === 'anthropic'
}

/**
 * Get all provider IDs
 */
export function getAllProviderIds(): ProviderId[] {
  return BUILTIN_PROVIDERS.map(p => p.id)
}
