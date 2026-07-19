/**
 * Field-level encryption and masking for sensitive HaloConfig values.
 *
 * Two independent responsibilities:
 *   1. At-rest encryption — controlled by `credentialAtRestSafe`. When the
 *      flag is off (open-source default) every function is identity/no-op.
 *   2. Output masking — always active regardless of the flag. Replaces
 *      sensitive values with a sentinel before they leave the process
 *      boundary (IPC / HTTP).
 *
 * The sensitive-field roster is explicit rather than heuristic so that
 * every masked/encrypted field is auditable at code-review time.
 */

import { encodeForStorage, decodeFromStorage, needsKeyMigration } from './crypto-envelope'

// ============================================================================
// Mask sentinel — the value returned to clients in place of real secrets.
// On the write path, if the client sends MASK_SENTINEL back unchanged,
// the original value is preserved (see `unmaskSentinels`).
// ============================================================================

export const MASK_SENTINEL = '***'

// ============================================================================
// Sensitive field visitor
//
// The visitor walks a config object and calls `fn(parent, key)` for every
// leaf that is considered sensitive. Fields are listed explicitly; dynamic
// maps (mcpServers.*.env, imChannels.instances[*].config) use a name-
// pattern heuristic as a secondary gate.
// ============================================================================

const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i

type Visitor = (parent: Record<string, unknown>, key: string) => void

function visitSensitiveFields(config: Record<string, unknown>, fn: Visitor): void {
  // Legacy api.apiKey
  const api = config.api as Record<string, unknown> | undefined
  if (api && typeof api.apiKey === 'string') fn(api, 'apiKey')

  // AI Sources v2
  const aiSources = config.aiSources as Record<string, unknown> | undefined
  if (aiSources && Array.isArray(aiSources.sources)) {
    for (const source of aiSources.sources as Record<string, unknown>[]) {
      if (typeof source.apiKey === 'string') fn(source, 'apiKey')
      if (typeof source.accessToken === 'string') fn(source, 'accessToken')
      if (typeof source.refreshToken === 'string') fn(source, 'refreshToken')
      const oauth = source.oauth as Record<string, unknown> | undefined
      if (oauth) {
        if (typeof oauth.accessToken === 'string') fn(oauth, 'accessToken')
        if (typeof oauth.refreshToken === 'string') fn(oauth, 'refreshToken')
      }
    }
  }

  // remoteAccess.password — already envelope-encrypted via remote.service,
  // but included in the MASKING roster so GET /api/config never leaks the
  // plaintext PIN. Encryption is skipped (see encryptConfigFields).

  // MCP servers: env values matching the pattern + auth-like headers
  const mcpServers = config.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (mcpServers) {
    for (const server of Object.values(mcpServers)) {
      const env = server.env as Record<string, string> | undefined
      if (env) {
        for (const k of Object.keys(env)) {
          if (SENSITIVE_KEY_PATTERN.test(k)) fn(env, k)
        }
      }
      const headers = server.headers as Record<string, string> | undefined
      if (headers) {
        for (const k of Object.keys(headers)) {
          if (/^(authorization|x-api-key|x-auth-token)$/i.test(k)) fn(headers, k)
        }
      }
    }
  }

  // Notification channels
  const nc = config.notificationChannels as Record<string, Record<string, unknown>> | undefined
  if (nc) {
    if (nc.email && typeof (nc.email as Record<string, unknown>).password === 'string') fn(nc.email as Record<string, unknown>, 'password')
    if (nc.wecom && typeof (nc.wecom as Record<string, unknown>).secret === 'string') fn(nc.wecom as Record<string, unknown>, 'secret')
    if (nc.dingtalk) {
      const dt = nc.dingtalk as Record<string, unknown>
      if (typeof dt.appKey === 'string') fn(dt, 'appKey')
      if (typeof dt.appSecret === 'string') fn(dt, 'appSecret')
    }
    if (nc.feishu && typeof (nc.feishu as Record<string, unknown>).appSecret === 'string') fn(nc.feishu as Record<string, unknown>, 'appSecret')
    if (nc.webhook && typeof (nc.webhook as Record<string, unknown>).secret === 'string') fn(nc.webhook as Record<string, unknown>, 'secret')
  }

  // Legacy wecomBot
  const wecomBot = config.wecomBot as Record<string, unknown> | undefined
  if (wecomBot && typeof wecomBot.secret === 'string') fn(wecomBot, 'secret')

  // IM channels instances — each instance config may carry brand-specific secrets
  const imChannels = config.imChannels as Record<string, unknown> | undefined
  if (imChannels && Array.isArray((imChannels as Record<string, unknown>).instances)) {
    for (const inst of (imChannels as Record<string, unknown>).instances as Record<string, unknown>[]) {
      const cfg = inst.config as Record<string, unknown> | undefined
      if (cfg) {
        for (const k of Object.keys(cfg)) {
          if (SENSITIVE_KEY_PATTERN.test(k)) fn(cfg, k)
        }
      }
    }
  }
}

// ============================================================================
// At-rest encryption (gated by credentialAtRestSafe via envelope.ts)
// ============================================================================

/**
 * Encrypt sensitive fields in-place before JSON serialization to disk.
 * Call on a deep clone — the in-memory config must stay plaintext.
 *
 * Skips `remoteAccess.password` because that field is already envelope-
 * encrypted by remote.service.ts before it reaches saveConfig.
 */
export function encryptConfigFields(config: Record<string, unknown>): void {
  visitSensitiveFields(config, (parent, key) => {
    const val = parent[key]
    if (typeof val !== 'string' || !val) return
    // Already encoded — don't double-encrypt on re-save.
    if (val.startsWith('gmcred:v1:')) return
    parent[key] = encodeForStorage(val)
  })
}

/**
 * Decrypt sensitive fields in-place after loading from disk. The in-
 * memory config holds plaintext after this call.
 */
export function decryptConfigFields(config: Record<string, unknown>): void {
  visitSensitiveFields(config, (parent, key) => {
    const val = parent[key]
    if (typeof val !== 'string' || !val) return
    parent[key] = decodeFromStorage(val)
  })
}

/**
 * True when any sensitive field is not yet stored under the master key
 * (plaintext or legacy-seed ciphertext). Operates on the raw, still-encoded
 * config — must run before decryptConfigFields.
 */
export function configHasUnmigratedCredentials(config: Record<string, unknown>): boolean {
  let found = false
  visitSensitiveFields(config, (parent, key) => {
    const val = parent[key]
    if (typeof val === 'string' && needsKeyMigration(val)) found = true
  })
  return found
}

// ============================================================================
// Output masking (always active — not gated by credentialAtRestSafe)
// ============================================================================

/**
 * Return a deep clone of config with every sensitive field replaced by
 * {@link MASK_SENTINEL}. Safe to hand to IPC / HTTP callers.
 */
export function maskConfigFields(config: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>

  // Mask credential fields
  visitSensitiveFields(clone, (parent, key) => {
    if (typeof parent[key] === 'string' && parent[key]) {
      parent[key] = MASK_SENTINEL
    }
  })

  // Also mask remoteAccess.password (not in visitSensitiveFields encryption
  // roster, but must not leak via API).
  const ra = clone.remoteAccess as Record<string, unknown> | undefined
  if (ra && typeof ra.password === 'string' && ra.password) {
    ra.password = MASK_SENTINEL
  }

  return clone
}

/**
 * Before persisting an update submitted by a client, replace any
 * {@link MASK_SENTINEL} values with the matching value from `existing`.
 * Walks both trees in parallel by structure (array index, object key) so
 * multi-source configs don't cross-contaminate secrets.
 *
 * Operates on `incoming` in-place; `existing` is read-only.
 */
export function unmaskSentinels(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): void {
  // Legacy api
  restore(incoming.api, existing.api, 'apiKey')

  // AI Sources v2 — matched by array index (client sends full array)
  const iSrc = (incoming.aiSources as Record<string, unknown>)?.sources as Record<string, unknown>[] | undefined
  const eSrc = (existing.aiSources as Record<string, unknown>)?.sources as Record<string, unknown>[] | undefined
  if (iSrc && eSrc) {
    for (let i = 0; i < iSrc.length; i++) {
      if (!eSrc[i]) continue
      restore(iSrc[i], eSrc[i], 'apiKey')
      restore(iSrc[i], eSrc[i], 'accessToken')
      restore(iSrc[i], eSrc[i], 'refreshToken')
      restore(iSrc[i]?.oauth, eSrc[i]?.oauth, 'accessToken')
      restore(iSrc[i]?.oauth, eSrc[i]?.oauth, 'refreshToken')
    }
  }

  // Remote access
  restore(incoming.remoteAccess, existing.remoteAccess, 'password')

  // MCP servers (keyed by name)
  const iMcp = incoming.mcpServers as Record<string, Record<string, unknown>> | undefined
  const eMcp = existing.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (iMcp && eMcp) {
    for (const name of Object.keys(iMcp)) {
      if (!eMcp[name]) continue
      restoreMap(iMcp[name]?.env, eMcp[name]?.env)
      restoreMap(iMcp[name]?.headers, eMcp[name]?.headers)
    }
  }

  // Notification channels
  const iNc = incoming.notificationChannels as Record<string, Record<string, unknown>> | undefined
  const eNc = existing.notificationChannels as Record<string, Record<string, unknown>> | undefined
  if (iNc && eNc) {
    restore(iNc.email, eNc.email, 'password')
    restore(iNc.wecom, eNc.wecom, 'secret')
    restore(iNc.dingtalk, eNc.dingtalk, 'appKey')
    restore(iNc.dingtalk, eNc.dingtalk, 'appSecret')
    restore(iNc.feishu, eNc.feishu, 'appSecret')
    restore(iNc.webhook, eNc.webhook, 'secret')
  }

  // Legacy wecomBot
  restore(incoming.wecomBot, existing.wecomBot, 'secret')

  // IM channels instances — matched by instance ID. The frontend
  // (MessageChannelsSection.saveInstances) always sends the full instances
  // array, and unchanged instances carry the '***' mask sentinel from
  // getConfig(). Index-based matching would cross-contaminate or skip secrets
  // whenever the array is reordered, appended, or partially updated.
  const iIm = (incoming.imChannels as Record<string, unknown>)?.instances as Record<string, unknown>[] | undefined
  const eIm = (existing.imChannels as Record<string, unknown>)?.instances as Record<string, unknown>[] | undefined
  if (iIm && eIm) {
    const existingById = new Map<string, Record<string, unknown>>()
    for (const e of eIm) {
      if (e && typeof e.id === 'string') existingById.set(e.id, e)
    }
    for (const inc of iIm) {
      const id = inc?.id
      const ext = typeof id === 'string' ? existingById.get(id) : undefined
      restoreMap(inc?.config, ext?.config)
    }
  }
}

function restore(incoming: unknown, existing: unknown, key: string): void {
  const inc = incoming as Record<string, unknown> | undefined
  if (!inc || inc[key] !== MASK_SENTINEL) return
  const ext = existing as Record<string, unknown> | undefined
  // Persisting the literal '***' is never correct: it means "unchanged" and
  // the consumer has no real value to use. When the existing value is absent
  // or itself the corrupted sentinel, fall back to '' so the field carries an
  // honest empty state (and a previously-corrupted value self-heals on save).
  if (ext && typeof ext[key] === 'string' && ext[key] !== MASK_SENTINEL) {
    inc[key] = ext[key]
  } else {
    inc[key] = ''
  }
}

function restoreMap(incoming: unknown, existing: unknown): void {
  const inc = incoming as Record<string, unknown> | undefined
  if (!inc) return
  const ext = (existing as Record<string, unknown> | undefined) ?? {}
  for (const k of Object.keys(inc)) {
    if (inc[k] !== MASK_SENTINEL) continue
    if (typeof ext[k] === 'string' && ext[k] !== MASK_SENTINEL) {
      inc[k] = ext[k]
    } else {
      // No real value to restore — do not persist the sentinel (see restore).
      inc[k] = ''
    }
  }
}
