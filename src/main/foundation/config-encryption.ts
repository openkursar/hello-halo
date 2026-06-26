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

import {
  encodeForStorage,
  tryDecodeFromStorage,
  needsKeyMigration,
} from './crypto-envelope'

// ============================================================================
// Mask sentinel — the value returned to clients in place of real secrets.
// On the write path, if the client sends MASK_SENTINEL back unchanged,
// the original value is preserved (see `unmaskSentinels`).
// ============================================================================

export const MASK_SENTINEL = '***'

// All written ciphertext carries this prefix (gmcred:v1: / gmcred:v2:). Used to
// skip re-encrypting an already-encoded value on the write path.
const CIPHERTEXT_PREFIX = 'gmcred:'

// Walks a config object, calling `fn(parent, key, path, label)` for every leaf
// considered sensitive. Fields are listed explicitly; dynamic maps fall back to
// a name-pattern gate. `path` is the failed-decode map key and MUST key array
// items by stable `id`, not index: the decrypt pass reads on-disk order while
// the write guard reads the client-submitted array (reorderable), so an
// index-based key could restore one source's ciphertext into another's slot.

const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i

type Visitor = (parent: Record<string, unknown>, key: string, path: string, label: string) => void

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// Stable path segment for an array item: its `id` when present (order-
// independent), else the index as a last resort for id-less legacy entries.
function idSegment(item: Record<string, unknown>, index: number): string {
  const id = asStr(item.id)
  return id ? `id=${id}` : `${index}`
}

function visitSensitiveFields(config: Record<string, unknown>, fn: Visitor): void {
  // Legacy api.apiKey
  const api = config.api as Record<string, unknown> | undefined
  if (api && typeof api.apiKey === 'string') fn(api, 'apiKey', 'api.apiKey', 'API key')

  // AI Sources v2
  const aiSources = config.aiSources as Record<string, unknown> | undefined
  if (aiSources && Array.isArray(aiSources.sources)) {
    const sources = aiSources.sources as Record<string, unknown>[]
    sources.forEach((source, i) => {
      const name = asStr(source.name) || asStr(source.id) || `#${i}`
      const base = `aiSources.sources[${idSegment(source, i)}]`
      if (typeof source.apiKey === 'string') fn(source, 'apiKey', `${base}.apiKey`, `AI source "${name}" API key`)
      if (typeof source.accessToken === 'string') fn(source, 'accessToken', `${base}.accessToken`, `AI source "${name}" access token`)
      if (typeof source.refreshToken === 'string') fn(source, 'refreshToken', `${base}.refreshToken`, `AI source "${name}" refresh token`)
      const oauth = source.oauth as Record<string, unknown> | undefined
      if (oauth) {
        if (typeof oauth.accessToken === 'string') fn(oauth, 'accessToken', `${base}.oauth.accessToken`, `AI source "${name}" access token`)
        if (typeof oauth.refreshToken === 'string') fn(oauth, 'refreshToken', `${base}.oauth.refreshToken`, `AI source "${name}" refresh token`)
      }
    })
  }

  // remoteAccess.password — already envelope-encrypted via remote.service,
  // but included in the MASKING roster so GET /api/config never leaks the
  // plaintext PIN. Encryption is skipped (see encryptConfigFields).

  // MCP servers: env values matching the pattern + auth-like headers
  const mcpServers = config.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (mcpServers) {
    for (const [serverName, server] of Object.entries(mcpServers)) {
      const env = server.env as Record<string, string> | undefined
      if (env) {
        for (const k of Object.keys(env)) {
          if (SENSITIVE_KEY_PATTERN.test(k)) fn(env, k, `mcpServers.${serverName}.env.${k}`, `MCP server "${serverName}" ${k}`)
        }
      }
      const headers = server.headers as Record<string, string> | undefined
      if (headers) {
        for (const k of Object.keys(headers)) {
          if (/^(authorization|x-api-key|x-auth-token)$/i.test(k)) fn(headers, k, `mcpServers.${serverName}.headers.${k}`, `MCP server "${serverName}" ${k}`)
        }
      }
    }
  }

  // Notification channels
  const nc = config.notificationChannels as Record<string, Record<string, unknown>> | undefined
  if (nc) {
    if (nc.email && typeof (nc.email as Record<string, unknown>).password === 'string') fn(nc.email as Record<string, unknown>, 'password', 'notificationChannels.email.password', 'Email password')
    if (nc.wecom && typeof (nc.wecom as Record<string, unknown>).secret === 'string') fn(nc.wecom as Record<string, unknown>, 'secret', 'notificationChannels.wecom.secret', 'WeCom secret')
    if (nc.dingtalk) {
      const dt = nc.dingtalk as Record<string, unknown>
      if (typeof dt.appKey === 'string') fn(dt, 'appKey', 'notificationChannels.dingtalk.appKey', 'DingTalk app key')
      if (typeof dt.appSecret === 'string') fn(dt, 'appSecret', 'notificationChannels.dingtalk.appSecret', 'DingTalk app secret')
    }
    if (nc.feishu && typeof (nc.feishu as Record<string, unknown>).appSecret === 'string') fn(nc.feishu as Record<string, unknown>, 'appSecret', 'notificationChannels.feishu.appSecret', 'Feishu app secret')
    if (nc.webhook && typeof (nc.webhook as Record<string, unknown>).secret === 'string') fn(nc.webhook as Record<string, unknown>, 'secret', 'notificationChannels.webhook.secret', 'Webhook secret')
  }

  // Legacy wecomBot
  const wecomBot = config.wecomBot as Record<string, unknown> | undefined
  if (wecomBot && typeof wecomBot.secret === 'string') fn(wecomBot, 'secret', 'wecomBot.secret', 'WeCom Bot secret')

  // IM channels instances — each instance config may carry brand-specific secrets
  const imChannels = config.imChannels as Record<string, unknown> | undefined
  if (imChannels && Array.isArray((imChannels as Record<string, unknown>).instances)) {
    const instances = (imChannels as Record<string, unknown>).instances as Record<string, unknown>[]
    instances.forEach((inst, i) => {
      const cfg = inst.config as Record<string, unknown> | undefined
      if (!cfg) return
      const label = asStr(inst.type) || asStr(inst.id) || `#${i}`
      const base = `imChannels.instances[${idSegment(inst, i)}]`
      for (const k of Object.keys(cfg)) {
        if (SENSITIVE_KEY_PATTERN.test(k)) fn(cfg, k, `${base}.config.${k}`, `IM channel "${label}" ${k}`)
      }
    })
  }
}

// ============================================================================
// At-rest encryption (gated by credentialAtRestSafe via encodeForStorage)
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
    // Already encoded (any gmcred:* version) — don't double-encrypt on re-save.
    if (val.startsWith(CIPHERTEXT_PREFIX)) return
    parent[key] = encodeForStorage(val)
  })
}

/** A sensitive field that could not be decoded from disk. */
export interface CredentialDecodeFailure {
  /** Stable field path (matches the write-time guard). */
  path: string
  /** Human-friendly description for user-facing alerts. */
  label: string
  /** The original on-disk ciphertext, preserved for non-destructive re-save. */
  ciphertext: string
}

/**
 * Decrypt sensitive fields in-place after loading from disk, returning the ones
 * that could not be decoded. A failed field is set to '' in memory (consumers
 * never see raw ciphertext) but its ciphertext is returned, never overwritten,
 * so applyFailedDecodeGuard can keep it on disk for the user to recover.
 */
export function decryptConfigFields(config: Record<string, unknown>): CredentialDecodeFailure[] {
  const failures: CredentialDecodeFailure[] = []
  visitSensitiveFields(config, (parent, key, path, label) => {
    const val = parent[key]
    if (typeof val !== 'string' || !val) return
    const outcome = tryDecodeFromStorage(val)
    if (outcome.ok) {
      parent[key] = outcome.value
    } else {
      parent[key] = ''
      failures.push({ path, label, ciphertext: val })
    }
  })
  return failures
}

/**
 * Restore preserved ciphertext for fields that failed to decode this session,
 * so persisting the in-memory '' can never wipe a recoverable credential. Runs
 * on the to-write clone after encryptConfigFields. Skips fields the user
 * re-entered (non-empty), letting the new value replace the orphaned ciphertext.
 */
export function applyFailedDecodeGuard(
  config: Record<string, unknown>,
  failed: Map<string, string>,
): void {
  if (failed.size === 0) return
  visitSensitiveFields(config, (parent, key, path) => {
    const ciphertext = failed.get(path)
    if (ciphertext === undefined) return
    const val = parent[key]
    if (typeof val === 'string' && val) return // user re-entered — keep it
    parent[key] = ciphertext
  })
}

/**
 * True when any sensitive field is not yet stored under the v2 static key
 * (plaintext or legacy ciphertext we can still decode). Operates on the raw,
 * still-encoded config — must run before decryptConfigFields.
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
 *
 * Array-backed sections (aiSources.sources, imChannels.instances) are matched
 * by stable `id`, not array index, so reordering or removing an entry can never
 * cross-wire one source's secret onto another.
 *
 * Operates on `incoming` in-place; `existing` is read-only.
 */
export function unmaskSentinels(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
): void {
  // Legacy api
  restore(incoming.api, existing.api, 'apiKey')

  // AI Sources v2 — matched by id
  const iSrc = (incoming.aiSources as Record<string, unknown>)?.sources as Record<string, unknown>[] | undefined
  const eSrc = (existing.aiSources as Record<string, unknown>)?.sources as Record<string, unknown>[] | undefined
  if (Array.isArray(iSrc) && Array.isArray(eSrc)) {
    const byId = indexById(eSrc)
    for (const inc of iSrc) {
      const ext = matchById(inc, byId)
      if (!ext) continue
      restore(inc, ext, 'apiKey')
      restore(inc, ext, 'accessToken')
      restore(inc, ext, 'refreshToken')
      restore((inc as Record<string, unknown>)?.oauth, (ext as Record<string, unknown>)?.oauth, 'accessToken')
      restore((inc as Record<string, unknown>)?.oauth, (ext as Record<string, unknown>)?.oauth, 'refreshToken')
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

  // IM channels instances — matched by id
  const iIm = (incoming.imChannels as Record<string, unknown>)?.instances as Record<string, unknown>[] | undefined
  const eIm = (existing.imChannels as Record<string, unknown>)?.instances as Record<string, unknown>[] | undefined
  if (Array.isArray(iIm) && Array.isArray(eIm)) {
    const byId = indexById(eIm)
    for (const inc of iIm) {
      const ext = matchById(inc, byId)
      if (!ext) continue
      restoreMap((inc as Record<string, unknown>)?.config, (ext as Record<string, unknown>)?.config)
    }
  }
}

function indexById(list: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const item of list) {
    if (item && typeof item.id === 'string') map.set(item.id, item)
  }
  return map
}

function matchById(
  incoming: unknown,
  byId: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const inc = incoming as Record<string, unknown> | undefined
  if (!inc || typeof inc.id !== 'string') return undefined
  return byId.get(inc.id)
}

function restore(incoming: unknown, existing: unknown, key: string): void {
  const inc = incoming as Record<string, unknown> | undefined
  const ext = existing as Record<string, unknown> | undefined
  if (!inc || !ext) return
  if (inc[key] === MASK_SENTINEL && typeof ext[key] === 'string') {
    inc[key] = ext[key]
  }
}

function restoreMap(incoming: unknown, existing: unknown): void {
  const inc = incoming as Record<string, unknown> | undefined
  const ext = existing as Record<string, unknown> | undefined
  if (!inc || !ext) return
  for (const k of Object.keys(inc)) {
    if (inc[k] === MASK_SENTINEL && typeof ext[k] === 'string') {
      inc[k] = ext[k]
    }
  }
}
