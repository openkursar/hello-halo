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
 *   HALO_REMOTE_PASSWORD   service access token (Authorization: Bearer <token>); default "halo123"
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

const DEFAULT_SERVICE_PASSWORD = 'halo123'
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

  // --- Service access token (the fixed "PIN" used as a Bearer API key) ---
  // Env wins (authoritative plaintext). With no env: keep an existing persisted
  // value (enableRemoteAccess decodes it internally — it may be encoded at rest,
  // so we must not treat it as plaintext here), else seed the default.
  const envPwd = env('HALO_REMOTE_PASSWORD')
  if (envPwd) {
    overrides.remoteAccess = { ...cfg.remoteAccess, password: envPwd }
  } else if (!cfg.remoteAccess?.password) {
    overrides.remoteAccess = { ...cfg.remoteAccess, password: DEFAULT_SERVICE_PASSWORD }
  }

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
    // Conversations bind to a source id; a fresh id each boot would orphan them.
    const previous = cfg.aiSources?.sources?.find(s => s.name === name)
    const source: AISource = {
      id: previous?.id ?? uuidv4(),
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
    overrides.aiSources = { version: 2, currentId: source.id, sources: [source] }
    // Keep the legacy api field consistent for any code path still reading it.
    const legacyProvider = provider === 'openai' ? 'openai' : provider === 'anthropic' ? 'anthropic' : 'custom'
    overrides.api = { provider: legacyProvider, apiKey, apiUrl, model }
  }

  // --- Egress proxy ---
  // A container has no Settings page, so env is how its proxy is set. Each
  // field is written only when its variable is, so the persisted value and the
  // product.json `proxyOnly` default otherwise stand.
  const network: Record<string, unknown> = {}
  const proxy = env('HALO_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')
  if (proxy) network.proxy = proxy
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
