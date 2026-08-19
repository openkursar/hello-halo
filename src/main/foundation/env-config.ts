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
 */
import { v4 as uuidv4 } from 'uuid'
import type { AISource, ProviderId } from '../../shared/types'
import { getConfig, saveConfig } from './config.service'

const DEFAULT_SERVICE_PASSWORD = 'halo123'
const FALLBACK_MODEL = 'claude-opus-4-5-20251101'
const FALLBACK_API_URL = 'https://api.anthropic.com'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v != null && v.trim() !== '' ? v.trim() : undefined
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
    const source: AISource = {
      id: uuidv4(),
      name: `${provider} (env)`,
      provider,
      authType: 'api-key',
      apiUrl,
      apiKey,
      model,
      availableModels: [{ id: model, name: model }],
      createdAt: now,
      updatedAt: now,
    }
    overrides.aiSources = { version: 2, currentId: source.id, sources: [source] }
    // Keep the legacy api field consistent for any code path still reading it.
    const legacyProvider = provider === 'openai' ? 'openai' : provider === 'anthropic' ? 'anthropic' : 'custom'
    overrides.api = { provider: legacyProvider, apiKey, apiUrl, model }
  }

  if (Object.keys(overrides).length > 0) {
    saveConfig(overrides)
    console.log(
      `[EnvConfig] applied overrides: ${Object.keys(overrides).join(', ')}` +
        `${overrides.aiSources ? ` (LLM provider=${env('HALO_AI_PROVIDER') || 'anthropic'})` : ''}`,
    )
  }
}
