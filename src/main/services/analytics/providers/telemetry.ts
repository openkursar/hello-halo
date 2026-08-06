/**
 * Analytics Provider - Self-Hosted Telemetry
 *
 * Privacy-safe batched reporting to an internal telemetry endpoint.
 *
 * Protocol:
 *   POST {endpoint}/v1/events
 *   Authorization: Bearer {apiKey}
 *   Content-Type: application/json
 *   body: { sent_at, context, events[] }
 *
 * Batching strategy:
 *   - Events accumulate in an in-memory queue. All events (IPC-received from
 *     the renderer and main-native ones like `app.installed`, `app.run.*`,
 *     `installed_apps.snapshot`) funnel through the same `track()` entry, so
 *     this queue is the single aggregation point.
 *   - Flushed when any of:
 *       (a) queue length reaches MAX_QUEUE_SIZE (100) — hard cap, flushed
 *           immediately and the debounce timer is cancelled.
 *       (b) DEBOUNCE_FLUSH_MS (5s) of quiet since the last track() — the
 *           timer is reset on every event, so a burst ships together once
 *           the burst ends.
 *       (c) destroy() is called (shutdown) — cancels timer, drains best-effort.
 *   - Per flush: payload is reset before the HTTP call. On failure the
 *     already-shipped batch is NOT re-queued — we prefer losing a batch
 *     over duplicating or holding memory indefinitely.
 *
 * Privacy (three-layer sanitize, applied in order):
 *   1. `BLOCKED_KEYS` — global hard blocklist of content / token / secret /
 *      path keys. Always drops, regardless of any other rule. Last line of
 *      defence against accidental additions.
 *   2. `EVENT_WHITELIST` — per-event-name allowlist of property keys.
 *      When a name is present here, only the listed keys survive. When
 *      absent, every key not in BLOCKED_KEYS is kept.
 *   3. `SENSITIVE_KEYS` gate — keys that are user-authored or
 *      user-identifiable (spec.name, space name, model name,
 *      mcp/skill/im bot names, token counts, error codes). Dropped UNLESS
 *      the product variant explicitly opted-in via
 *      `product.json.telemetry.allowedSensitiveFields`. Open-source
 *      builds omit the product field entirely, so the gate drops every
 *      sensitive field — in addition to the empty-endpoint
 *      provider-disabled safety net.
 *
 * Disabled when endpoint or apiKey is empty. When disabled the provider
 * never starts its timer and `track()` is a no-op — safe to use in
 * open-source builds where no credentials are injected.
 */

import { BaseProvider, BaseProviderOptions } from './base'
import type { AnalyticsEvent, UserContext } from '../types'

/** Hard cap on in-memory queue length. Reaching this triggers an immediate flush. */
const MAX_QUEUE_SIZE = 100

/**
 * Debounce window since the last `track()` call before auto-flushing.
 *
 * Resetting the timer on every event means a burst (e.g. startup snapshot,
 * app install + multiple run events) ships as one batch once the burst
 * settles, instead of trickling out on a fixed cadence.
 */
const DEBOUNCE_FLUSH_MS = 5_000

/** Budget for the final flush during destroy(). */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000

/**
 * Property keys that must NEVER be forwarded to the telemetry backend.
 * Enforced on every event regardless of whitelist outcome.
 */
const BLOCKED_KEYS = new Set<string>([
  'content',
  'body',
  'text',
  'message',
  'messages',
  'prompt',
  'systemPrompt',
  'system_prompt',
  'path',
  'filePath',
  'file_path',
  'fullPath',
  'absolutePath',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'secret',
  'password',
])

/**
 * Property keys that are user-authored or user-identifiable and therefore
 * SENSITIVE in the privacy sense. These are gated by the product-variant
 * `allowedSensitiveFields` whitelist:
 *
 * - Open-source / public build: product.json omits the telemetry block →
 *   `allowedSensitiveFields` is empty → every SENSITIVE_KEY is dropped at
 *   sanitize time (in addition to the empty-endpoint provider-disabled
 *   safety net).
 * - Enterprise / internal build: product.json explicitly opts-in per key,
 *   typically allowing the full set so internal dashboards can show
 *   readable spec names, model usage, token consumption, etc.
 *
 * Distinct from `BLOCKED_KEYS` (which is absolute and applies to leak
 * vectors like message content or secrets, never permitted anywhere).
 */
const SENSITIVE_KEYS = new Set<string>([
  'specId',        // spec.name — user-authored readable name
  'spaceName',     // user-authored space name
  'modelName',     // custom model identifier (may contain provider URL / internal name)
  'sourceName',    // custom AI source display name
  'mcpId',         // user-attached MCP server name
  'skillId',       // user-attached skill name
  'imBotName',     // user-named IM bot
  'inputTokens',   // model token consumption (per call)
  'outputTokens',
  'errorCode',     // privacy-safe but still leaks workflow shape
])

/**
 * Per-event-name property whitelist.
 *
 * When a name is present in this map, only the listed keys survive.
 * When absent, the event keeps the caller-provided keys minus anything in
 * BLOCKED_KEYS (used for renderer-driven generic events where the key set
 * is harder to enumerate, e.g. `action.*`).
 */
const EVENT_WHITELIST: Record<string, readonly string[]> = {
  // Session / navigation
  'session.start':  ['view', 'platform', 'startedAt'],
  'session.end':    ['view', 'platform', 'durationMs'],
  'page.view':      ['view', 'from'],

  // Store funnel (identifiers only — slug/type, never user content)
  'store.view':                ['tab', 'ref'],
  'store.detail.view':         ['appId', 'appType', 'installedState', 'source'],
  'store.card.click':          ['appId', 'appType', 'source'],
  'store.search':              ['resultCount', 'tabScope'],
  'store.category.filter':     ['cat', 'appType'],
  'store.install.click':       ['appId', 'appType', 'source'],
  'store.install.done':        ['appId', 'appType', 'source'],
  'store.empty_state':         ['scene'],
  'store.update.overwrite':    ['appId', 'toVersion'],
  'store.update.keep_current': ['appId', 'toVersion'],
  'store.featured.view':       ['count'],
  'store.publish.open':        ['appType', 'entry'],
  'store.publish.submit':      ['appType', 'result', 'entry', 'isUpdate'],
  'store.mine.view':           [],
  'store.unpublish':           ['appId'],

  // Chat message counts (identifiers only — never content)
  'message.sent':     ['source', 'appId', 'specId', 'channel', 'instanceId', 'conversationId', 'spaceId', 'hasImages',
                       'modelProvider', 'modelName', 'engine', 'replyDurationMs'],
  'message.received': ['source', 'appId', 'specId', 'channel', 'instanceId', 'conversationId', 'spaceId'],

  // Digital human lifecycle
  'app.installed':      ['appId', 'specId', 'version', 'type', 'installSource', 'durationMs'],
  'app.uninstalled':    ['appId', 'specId', 'type'],
  'app.run.started':    ['appId', 'specId', 'runId', 'trigger'],
  'app.run.completed':  ['appId', 'specId', 'runId', 'trigger', 'status', 'durationMs'],
  'app.run.failed':     ['appId', 'specId', 'runId', 'trigger', 'status', 'durationMs', 'errorCode'],
  'app.run.replay':     ['appId', 'specId', 'runId', 'trigger', 'status', 'durationMs', 'errorCode', 'startedAt', 'finishedAt'],

  // Startup snapshot
  'installed_apps.snapshot': ['apps', 'count'],

  // Model + tool observability
  'llm.invocation':       ['source', 'appId', 'conversationId', 'engine', 'modelProvider', 'modelName',
                           'durationMs', 'status', 'errorCode', 'inputTokens', 'outputTokens'],
  'tool.usage_summary':   ['source', 'appId', 'runId', 'conversationId', 'toolCalls',
                           'totalCalls', 'totalErrors', 'durationMs'],
  'error.surface':        ['area', 'errorCode'],
}

export interface TelemetryProviderConfig extends BaseProviderOptions {
  endpoint: string
  apiKey: string
  /**
   * Subset of SENSITIVE_KEYS that the current build is permitted to forward.
   * Sourced from `product.json.telemetry.allowedSensitiveFields`. Empty
   * (or unset) → every SENSITIVE_KEY is dropped at sanitize time.
   */
  allowedSensitiveFields?: readonly string[]
}

interface QueuedEvent extends AnalyticsEvent {
  timestamp: number
}

interface TelemetryPayload {
  sent_at: number
  context: UserContext
  events: QueuedEvent[]
}

export class TelemetryProvider extends BaseProvider {
  readonly name = 'Telemetry'

  private endpoint: string
  private apiKey: string
  private queue: QueuedEvent[] = []
  /** Debounce timer — reset on every `track()` call, cleared on flush/destroy. */
  private flushTimer: NodeJS.Timeout | null = null
  /** Captured per track() call; used when a scheduled flush fires without a fresh track. */
  private lastContext: UserContext | null = null
  /** Per-build SENSITIVE_KEYS allowlist. Empty Set = drop every sensitive key. */
  private allowedSensitiveFields: Set<string>

  constructor(config: TelemetryProviderConfig) {
    super(config)
    // Normalize trailing slashes so `${endpoint}/v1/events` is always well-formed.
    this.endpoint = (config.endpoint || '').replace(/\/+$/, '')
    this.apiKey = config.apiKey || ''
    this.allowedSensitiveFields = new Set(config.allowedSensitiveFields ?? [])
  }

  async init(userId: string): Promise<void> {
    await super.init(userId)

    if (!this.endpoint || !this.apiKey) {
      this._initialized = false
      this.log('disabled (no endpoint or apiKey)')
      return
    }

    // No background timer is started here. Flushes are scheduled on-demand
    // from `track()` via a debounce window, and cleared on flush/destroy —
    // when the queue is idle, no timers exist at all.
    this.log(`ready (endpoint=${this.endpoint})`)
  }

  async track(event: AnalyticsEvent, context: UserContext): Promise<void> {
    if (!this._initialized) return

    const sanitized = this.sanitizeProperties(event.name, event.properties)

    const queued: QueuedEvent = {
      name: event.name,
      properties: sanitized,
      timestamp: event.timestamp ?? Date.now(),
    }

    this.lastContext = context
    this.queue.push(queued)

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // Size-triggered flush — drain the queue immediately without blocking
      // the caller on the network round-trip. Cancel any pending debounce
      // since it would otherwise fire against an empty queue.
      this.cancelDebouncedFlush()
      void this.flushNow()
      return
    }

    // Debounce — each new event pushes the flush further out, so a burst
    // ships together once the burst ends.
    this.scheduleDebouncedFlush()
  }

  /**
   * (Re)arm the debounce timer. Safe to call repeatedly — each call clears
   * the previous timer so the wait window always counts from the latest
   * `track()`.
   */
  private scheduleDebouncedFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      // Fire-and-forget — errors are swallowed inside flushNow.
      void this.flushNow()
    }, DEBOUNCE_FLUSH_MS)
    // Don't keep the event loop alive just for the telemetry timer.
    if (typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref()
    }
  }

  /** Clear any pending debounce. Idempotent. */
  private cancelDebouncedFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  /**
   * Immediately drain the queue to the endpoint.
   *
   * Safe to call while another flush is in flight — we snapshot the queue
   * synchronously before the await, so concurrent callers each ship a
   * distinct batch and never double-send the same events.
   */
  private async flushNow(): Promise<void> {
    if (!this._initialized) return
    if (this.queue.length === 0) return
    if (!this.lastContext) return

    const batch = this.queue
    this.queue = []
    const context = this.lastContext

    const payload: TelemetryPayload = {
      sent_at: Date.now(),
      context,
      events: batch,
    }

    await this.safeTrack(async () => {
      const response = await this.fetchWithRetry(`${this.endpoint}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        this.log(`flushed ${batch.length} event(s)`)
      } else {
        const errorText = await response.text().catch(() => '')
        this.log(`flush failed (${response.status}): ${errorText.slice(0, 200)}`)
      }
    })
  }

  /**
   * Stop the flush timer and drain the queue best-effort.
   *
   * Called from the shutdown path. Bounded by SHUTDOWN_FLUSH_TIMEOUT_MS so
   * the process doesn't hang on an unreachable endpoint.
   */
  async destroy(): Promise<void> {
    this.cancelDebouncedFlush()

    if (!this._initialized || this.queue.length === 0) return

    await Promise.race([
      this.flushNow(),
      new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
    ])
  }

  /**
   * Three-layer sanitize. Order matters:
   *   1. BLOCKED_KEYS always wins (absolute leak vectors: content, secrets, paths).
   *   2. Per-event whitelist filters to the known structural keys.
   *   3. SENSITIVE_KEYS gate drops user-authored / user-identifiable keys
   *      unless the product variant opted in.
   *
   * Result is undefined when every key was dropped, so the queued event
   * doesn't waste bytes on an empty object.
   */
  private sanitizeProperties(
    eventName: string,
    props: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (!props) return undefined

    const whitelist = EVENT_WHITELIST[eventName]
    const out: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(props)) {
      if (value === undefined) continue
      // 1. Absolute blocklist — always drops.
      if (BLOCKED_KEYS.has(key)) continue
      // 2. Per-event whitelist — when present, only listed keys survive.
      if (whitelist && !whitelist.includes(key)) continue
      // 3. SENSITIVE_KEYS gate — drop unless the build opted in.
      if (SENSITIVE_KEYS.has(key) && !this.allowedSensitiveFields.has(key)) continue
      out[key] = value
    }

    return Object.keys(out).length > 0 ? out : undefined
  }

  /** Expose queue length for tests. */
  get queueLength(): number {
    return this.queue.length
  }
}

/**
 * Create a TelemetryProvider instance. Returns a provider whose
 * `initialized` will flip to false inside `init()` when credentials are
 * empty — callers can use either `provider.initialized` after init or just
 * let `track()` be a no-op.
 *
 * `allowedSensitiveFields` is sourced from
 * `product.json.telemetry.allowedSensitiveFields`; omit (or pass empty)
 * for open-source builds where every SENSITIVE_KEY must be dropped.
 */
export function createTelemetryProvider(
  endpoint: string,
  apiKey: string,
  allowedSensitiveFields: readonly string[] = []
): TelemetryProvider {
  return new TelemetryProvider({
    endpoint,
    apiKey,
    allowedSensitiveFields,
    debug: process.env.NODE_ENV === 'development',
  })
}
