/**
 * Server/enterprise configuration from environment variables.
 *
 * Lets a deployment drive Halo's runtime config purely through env vars — the
 * norm for container/serverless platforms — without editing any file. Reads
 * plain `process.env` only, so it is platform-agnostic (not bound to any
 * specific function platform).
 *
 * Precedence: a set env var wins; otherwise the persisted config / built-in
 * default stands. Applied during headless server boot, before remote access
 * starts, so the service token and the LLM source are in effect on the first
 * request.
 *
 * Recognized variables (all optional):
 *   HALO_REMOTE_PASSWORD   service access token; required if none is configured
 *   HALO_AI_PROVIDER       LLM provider id (anthropic | openai | custom | ...)
 *   HALO_AI_API_URL        LLM endpoint base URL (the deployment's own model gateway)
 *   HALO_AI_API_KEY        LLM API key
 *   HALO_AI_MODEL          model id
 *   HALO_PROXY             egress proxy URL; falls back to HTTPS_PROXY / HTTP_PROXY
 *   HALO_PROXY_ONLY        comma-separated hosts that alone take the proxy;
 *                          "*" proxies every host, unset keeps the product.json default
 *   HALO_NO_PROXY          comma-separated hosts always reached directly (an
 *                          inherited NO_PROXY is honored as it is, without this)
 */
import { v4 as uuidv4 } from 'uuid'
import type { AISource, ProviderId } from '../../shared/types'
import { getConfig, saveConfig } from './config.service'
import { decodeFromStorage } from './crypto-envelope'

const LEGACY_SERVER_PASSWORD = 'halo123'
const EXAMPLE_SERVER_PASSWORD = 'change-me-to-a-long-random-token'
const FALLBACK_MODEL = 'claude-opus-4-5-20251101'
const FALLBACK_API_URL = 'https://api.anthropic.com'

/** The first of `names` that is set to something other than blanks. */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name]
    if (v != null && v.trim() !== '') return v.trim()
  }
  return undefined
}

function envList(name: string): string[] | undefined {
  const raw = env(name)
  return raw === undefined ? undefined : raw.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Apply environment-variable overrides onto the persisted config.
 * No-op for any concern whose env vars are absent.
 */
export function applyEnvConfig(): void {
  const cfg = getConfig()
  const overrides: Record<string, unknown> = {}

  const envPwd = env('HALO_REMOTE_PASSWORD')
  const password = envPwd ?? (cfg.remoteAccess?.password ? decodeFromStorage(cfg.remoteAccess.password) : '')
  if (password.length < 4 || password === LEGACY_SERVER_PASSWORD || password === EXAMPLE_SERVER_PASSWORD) {
    throw new Error('Set HALO_REMOTE_PASSWORD to a unique access token before starting Halo Server')
  }
  if (envPwd) overrides.remoteAccess = { ...cfg.remoteAccess, password: envPwd }

  // --- LLM source (the deployment's own model gateway) ---
  // Triggered when at least an endpoint or a key is provided. Replaces the
  // active source so an env change takes effect on the next boot. When absent,
  // the persisted/UI-configured source is left untouched.
  const aiKey = env('HALO_AI_API_KEY')
  const aiUrl = env('HALO_AI_API_URL')
  if (aiKey || aiUrl) {
    const provider = (env('HALO_AI_PROVIDER') || 'anthropic') as ProviderId
    const apiUrl = aiUrl || FALLBACK_API_URL
    const apiKey = aiKey || ''
    const model = env('HALO_AI_MODEL') || FALLBACK_MODEL
    const now = new Date().toISOString()
    const name = `${provider} (env)`
    const legacyProvider = provider === 'openai' ? 'openai' : provider === 'anthropic' ? 'anthropic' : 'custom'
    const sources = cfg.aiSources?.sources ?? []
    const managed = sources.find(s => s.managedBy === 'server-env')
    const only = sources.length === 1 ? sources[0] : undefined
    // Older deployments wrote one active account and mirrored its credentials into api.
    const legacy = !managed && only && only.id === cfg.aiSources?.currentId && only.name === name &&
      only.provider === provider && only.authType === 'api-key' && cfg.api?.provider === legacyProvider &&
      only.apiUrl === cfg.api.apiUrl && only.model === cfg.api.model && only.apiKey === cfg.api.apiKey
      ? only : undefined
    const previous = managed?.provider === provider ? managed : legacy
    const source: AISource = {
      id: previous?.id ?? uuidv4(),
      managedBy: 'server-env',
      name,
      provider,
      authType: 'api-key',
      apiUrl,
      apiKey,
      model,
      availableModels: [{ id: model, name: model }],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    overrides.aiSources = {
      ...cfg.aiSources, version: 2, currentId: source.id, currentGroupId: null,
      sources: [...sources.filter(s => s !== managed && s !== previous), source],
    }
    // Keep the legacy api field consistent for any code path still reading it.
    overrides.api = { provider: legacyProvider, apiKey, apiUrl, model }
  }

  // --- Egress proxy ---
  // Only route lists are persistent. proxy-policy resolves the proxy URL from
  // the live environment so credentials never enter a configuration snapshot.
  const network: Record<string, unknown> = {}
  const proxyOnly = envList('HALO_PROXY_ONLY')
  if (proxyOnly) network.proxyOnly = proxyOnly.includes('*') ? [] : proxyOnly
  const noProxy = envList('HALO_NO_PROXY')
  if (noProxy) network.noProxy = noProxy.join(',')
  if (Object.keys(network).length > 0) {
    overrides.network = { ...cfg.network, ...network }
  }

  if (Object.keys(overrides).length > 0) {
    saveConfig(overrides)
    console.log(
      `[EnvConfig] applied overrides: ${Object.keys(overrides).join(', ')}` +
        `${overrides.aiSources ? ` (LLM provider=${env('HALO_AI_PROVIDER') || 'anthropic'})` : ''}`,
    )
  }
}
