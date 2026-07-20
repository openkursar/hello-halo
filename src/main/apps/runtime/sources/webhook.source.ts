/**
 * apps/runtime/sources -- WebhookSource
 *
 * Event source adapter that registers a `POST /{*hookPath}` route on the
 * webhook ingress router (http/server `getWebhookIngressRouter()`, mounted
 * at /hooks) to receive inbound webhook events.
 *
 * Integration approach:
 * - Accepts the ingress Router in the constructor (kept injectable for
 *   testability; null disables mounting).
 * - Incoming POST requests are converted to AutomationEvent with:
 *   - type: "webhook.received"
 *   - source: "webhook"
 *   - payload: { path, body, headers, query, method, ip }
 * - dedupKey: from request body's `dedupKey` field if present, or
 *   `"wh:{path}:{body-hash}"` for idempotency against retries.
 *
 * Security:
 * - The ingress router is mounted ahead of the Halo auth middleware because
 *   external services (GitHub, Stripe, etc.) need to POST without an
 *   auth token.
 * - Per-hook HMAC signature verification is performed when a secret is
 *   configured for the hook path. Secrets are resolved via a callback
 *   function injected at construction time. Verification requires the raw
 *   body bytes captured by the ingress JSON parser (`verify` option); only
 *   JSON payloads are supported.
 * - Supports standard signature headers:
 *   - `x-hub-signature-256`: GitHub-style (sha256=<hex>)
 *   - `x-signature-256`: Generic HMAC-SHA256 (<hex>)
 *   - `x-webhook-signature`: Alternative header (<hex>)
 * - Request body is limited to 256KB (enforced by the ingress JSON parser;
 *   MAX_BODY_BYTES is a defense-in-depth cross-check for other mounts).
 *
 * Lifecycle:
 * - The ingress router lives for the whole process (http/server re-attaches
 *   it to every new Express app), so routes registered here survive HTTP
 *   server restarts and can be registered before the server ever starts.
 * - start(): registers the route (once per instance -- Express does not
 *   support runtime route removal)
 * - stop(): marks the source as inactive; the mounted handler defers via
 *   next() so it cannot shadow a replacement instance mounted later
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type { Router, Request, Response, NextFunction } from 'express'
import type { EventSourceAdapter, AutomationEventInput } from '../event-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback to resolve the HMAC secret for a given webhook path.
 *
 * Returns the secret string if the path has a configured secret,
 * or null/undefined if no verification is required for that path.
 *
 * The implementation typically looks up installed Apps' webhook
 * subscription configs (WebhookSourceConfig.secret) where
 * WebhookSourceConfig.path matches the incoming hookPath.
 */
export type WebhookSecretResolver = (hookPath: string) => string | null | undefined

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024 // 256KB -- keep in sync with http/server WEBHOOK_INGRESS_BODY_LIMIT

/**
 * Ordered list of headers to check for HMAC signatures.
 * Each entry has the header name and an optional prefix that the
 * signature value uses (e.g., GitHub sends "sha256=<hex>").
 */
const SIGNATURE_HEADERS: Array<{ header: string; prefix: string }> = [
  { header: 'x-hub-signature-256', prefix: 'sha256=' },    // GitHub
  { header: 'x-signature-256', prefix: '' },                // Generic
  { header: 'x-webhook-signature', prefix: '' },            // Alternative
]

// ---------------------------------------------------------------------------
// Source Implementation
// ---------------------------------------------------------------------------

export class WebhookSource implements EventSourceAdapter {
  readonly id = 'webhook'
  readonly type = 'webhook' as const

  private emitFn: ((event: AutomationEventInput) => void) | null = null
  private router: Router | null
  private mounted = false
  private active = false
  private secretResolver: WebhookSecretResolver | null

  /**
   * @param router - The webhook ingress router (mounted at /hooks by
   *   http/server) to register the route on. If null, the source will not
   *   mount any routes (useful for testing or when the HTTP server is not
   *   available).
   * @param secretResolver - Optional callback to resolve HMAC secrets
   *   for incoming webhook paths. If null, no signature verification
   *   is performed (all webhooks are accepted).
   */
  constructor(router: Router | null, secretResolver?: WebhookSecretResolver | null) {
    this.router = router
    this.secretResolver = secretResolver ?? null
  }

  start(emit: (event: AutomationEventInput) => void): void {
    this.emitFn = emit
    this.active = true

    if (!this.router) {
      console.log('[WebhookSource] Started (no ingress router -- dry run mode)')
      return
    }

    // Express cannot remove routes at runtime, so mount only once per
    // instance even across stop()/start() cycles to avoid duplicate handlers.
    if (!this.mounted) {
      this.mountRoute(this.router)
      this.mounted = true
    }
    console.log('[WebhookSource] Started -- POST route active on webhook ingress router')
  }

  stop(): void {
    this.emitFn = null
    this.active = false
    // Express does not support runtime route removal. The mounted handler
    // checks `this.active` and passes the request on when stopped, so a
    // replacement WebhookSource mounted later on the same persistent ingress
    // router is not shadowed by this stale handler.
    console.log('[WebhookSource] Stopped')
  }

  // -------------------------------------------------------------------------
  // Route Handler
  // -------------------------------------------------------------------------

  private mountRoute(router: Router): void {
    // Express 5 (path-to-regexp v8) wildcard syntax. The legacy `:hookPath(*)`
    // form throws at registration time on Express 5, which silently disabled
    // this source (the error was only logged by EventRouter).
    router.post('/{*hookPath}', (req: Request, res: Response, next: NextFunction) => {
      this.handleWebhook(req, res, next)
    })
  }

  private handleWebhook(req: Request, res: Response, next: NextFunction): void {
    // Inactive (stopped) sources defer to whatever is mounted after them --
    // either a newer WebhookSource instance or the ingress 404 terminal.
    if (!this.active || !this.emitFn) {
      next()
      return
    }

    // Check body size (Express json middleware already parsed, check original)
    const contentLength = parseInt(req.headers['content-length'] || '0', 10)
    if (contentLength > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Payload too large' })
      return
    }

    // Extract hook path (everything after /hooks/).
    // Express 5 wildcard params are arrays of path segments.
    const rawParam = (req.params as Record<string, unknown>).hookPath
    const hookPath = Array.isArray(rawParam)
      ? rawParam.join('/')
      : typeof rawParam === 'string' ? rawParam : ''

    // ── HMAC signature verification ──────────────────────────
    if (this.secretResolver) {
      const secret = this.secretResolver(hookPath)
      if (secret) {
        const rawBody = getRawBody(req)
        if (!rawBody) {
          // Cannot verify without raw body -- reject
          console.warn(`[WebhookSource] Rejecting ${hookPath}: raw body not available for HMAC verification`)
          res.status(400).json({ error: 'Cannot verify signature: raw body unavailable' })
          return
        }

        if (!verifySignature(rawBody, secret, req.headers)) {
          console.warn(`[WebhookSource] Rejecting ${hookPath}: HMAC signature verification failed`)
          res.status(401).json({ error: 'Invalid webhook signature' })
          return
        }
      }
    }

    // Build payload
    const body = typeof req.body === 'object' && req.body !== null
      ? req.body as Record<string, unknown>
      : {}

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value
      } else if (Array.isArray(value) && value.length > 0) {
        headers[key.toLowerCase()] = value.join(', ')
      }
    }

    // Determine dedupKey
    let dedupKey: string | undefined
    if (typeof body.dedupKey === 'string' && body.dedupKey.trim()) {
      dedupKey = `wh:${body.dedupKey.trim()}`
    } else {
      // Generate hash from path + body for idempotency
      const bodyStr = JSON.stringify(body)
      const hash = createHash('sha256').update(bodyStr).digest('hex').slice(0, 16)
      dedupKey = `wh:${hookPath}:${hash}`
    }

    // Emit event
    this.emitFn({
      type: 'webhook.received',
      source: this.id,
      payload: {
        path: hookPath,
        body,
        headers,
        query: req.query as Record<string, unknown>,
        method: req.method,
        ip: req.ip || req.socket?.remoteAddress || 'unknown'
      },
      dedupKey
    })

    // Respond immediately (webhook callers expect fast acknowledgment)
    res.status(200).json({ ok: true, received: true })
  }
}

// ---------------------------------------------------------------------------
// HMAC Verification Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve the raw request body for HMAC computation.
 *
 * Express's json middleware can be configured to keep the raw body via
 * `verify` option. If available, we use that. Otherwise we re-serialize
 * the parsed body (less ideal but functional for JSON payloads).
 */
function getRawBody(req: Request): Buffer | null {
  // Check for raw body stored by Express json middleware's `verify` callback
  const rawBody = (req as any).rawBody
  if (Buffer.isBuffer(rawBody)) {
    return rawBody
  }
  if (typeof rawBody === 'string') {
    return Buffer.from(rawBody, 'utf-8')
  }

  // Fallback: re-serialize the parsed JSON body
  if (req.body !== undefined && req.body !== null) {
    try {
      return Buffer.from(JSON.stringify(req.body), 'utf-8')
    } catch {
      return null
    }
  }

  return null
}

/**
 * Verify an HMAC-SHA256 signature from webhook request headers.
 *
 * Checks multiple well-known signature headers in priority order.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param rawBody - The raw request body bytes
 * @param secret - The shared secret for HMAC computation
 * @param headers - The request headers (lowercased keys)
 * @returns true if a valid signature is found, false otherwise
 */
function verifySignature(
  rawBody: Buffer,
  secret: string,
  headers: Record<string, string | string[] | undefined>
): boolean {
  const expectedHmac = createHmac('sha256', secret).update(rawBody).digest('hex')

  for (const { header, prefix } of SIGNATURE_HEADERS) {
    const headerValue = headers[header]
    if (!headerValue || typeof headerValue !== 'string') continue

    // Strip the prefix (e.g., "sha256=" for GitHub)
    const signature = prefix && headerValue.startsWith(prefix)
      ? headerValue.slice(prefix.length)
      : headerValue

    // Validate hex format
    if (!/^[0-9a-f]{64}$/i.test(signature)) continue

    // Timing-safe comparison
    try {
      const sigBuffer = Buffer.from(signature, 'hex')
      const expectedBuffer = Buffer.from(expectedHmac, 'hex')
      if (sigBuffer.length === expectedBuffer.length && timingSafeEqual(sigBuffer, expectedBuffer)) {
        return true
      }
    } catch {
      // Buffer creation failed (invalid hex), try next header
      continue
    }
  }

  return false
}
