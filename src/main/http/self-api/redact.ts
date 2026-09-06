/**
 * Response sanitization for the self-API loopback listener only — the
 * public listener is untouched, its clients (e.g. the mobile settings UI)
 * still need real values.
 *
 * `GET /api/apps` and friends return installed-app records whose
 * `userConfig` / `spec.mcp_server.env` / `spec.mcp_server.headers` carry
 * plaintext credentials (no field type in the app spec schema exists for
 * "secret"). Excluding every such endpoint from the manual would gut the
 * digital-human group's entry point, so instead every JSON response on this
 * listener is redacted before it leaves the process.
 *
 * Values are replaced, keys are never removed: a missing key reads to the
 * agent as "this does not exist", which is the exact failure the whole
 * self-API design exists to avoid. A redacted key still tells it "this
 * field exists, this path just cannot read it".
 */

import type { NextFunction, Request, Response } from 'express'

const REDACTED = '[redacted]'

/** Fields whose *shape* is safe to show but whose leaf values never are. */
const RECORD_KEYS = new Set(['userconfig', 'env', 'headers'])

/** Exact key names (case-insensitive) that are always secret-shaped. */
const SCALAR_EXACT_KEYS = new Set([
  'token',
  'password',
  'passphrase',
  'secret',
  'credential',
  'credentials',
  'cookie',
  'authorization',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'clientsecret',
  'webhookurl',
  'webhooksecret',
  // Long-lived identity paired 1:1 with a `secret` for WeCom bot subscribe auth
  // (wecom-bot-scan-auth.ts) — the module's own log redaction already treats
  // it as sensitive alongside `secret`; the HTTP layer's key list had not caught up.
  'botid',
])

/**
 * Substring match for keys that don't have one fixed spelling
 * (e.g. `githubApiKey`, `slackBotToken`). Deliberately excludes bare
 * "token" — it would catch `tokenCount` / `tokensUsed`, usage figures the
 * agent actually needs, not a credential.
 */
const SUBSTRING_KEYS = ['secret', 'password', 'passphrase', 'privatekey', 'apikey', 'accesstoken', 'authtoken', 'bottoken', 'webhooksecret']

function isRecordKey(key: string): boolean {
  return RECORD_KEYS.has(key.toLowerCase())
}

function isScalarSecretKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SCALAR_EXACT_KEYS.has(lower) || SUBSTRING_KEYS.some((needle) => lower.includes(needle))
}

/** Keeps the object and every key; every leaf value becomes `[redacted]`. */
function redactLeaves(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(() => REDACTED)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) out[key] = REDACTED
    return out
  }
  return REDACTED
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isRecordKey(key)) {
      out[key] = redactLeaves(child)
    } else if (isScalarSecretKey(key) && child !== null && child !== undefined) {
      out[key] = REDACTED
    } else {
      out[key] = redactValue(child)
    }
  }
  return out
}

/**
 * Mounted before the route handlers so it wraps `res.json` before any of
 * them call it. Fail-closed: if redaction itself throws, the original body
 * must never go out — respond 500 instead. Never logs the body being
 * redacted, redacted or not.
 */
export function redactResponses(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res)
  res.json = (body: unknown) => {
    try {
      return originalJson(redactValue(body))
    } catch {
      res.status(500)
      return originalJson({ success: false, error: 'Internal error while preparing response' })
    }
  }
  next()
}
