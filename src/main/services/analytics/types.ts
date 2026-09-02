/**
 * Analytics Module - Type Definitions
 */

import type { HostIdentity } from '../../foundation/host-identity'

/**
 * Predefined analytics events.
 *
 * Two categories live here:
 *   1. Legacy lifecycle events (app_install, app_launch, app_update) that the
 *      Baidu/GA providers emit. Do not rename without coordinating with the
 *      analytics dashboards.
 *   2. Telemetry events (session.*, page.view, message.*, app.*, store.*) used
 *      by the self-hosted telemetry provider. These are dotted names by
 *      convention — snake_case here would read as a legacy GA/Baidu event.
 */
export const AnalyticsEvents = {
  // ── Legacy lifecycle events (GA / Baidu) ──────────────────────────
  APP_INSTALL: 'app_install',     // First install (first launch)
  APP_LAUNCH: 'app_launch',       // App launch
  APP_UPDATE: 'app_update',       // Version update

  // ── Telemetry: renderer session ───────────────────────────────────
  SESSION_START: 'session.start', // Renderer session begins
  SESSION_END: 'session.end',     // Renderer session ends (beforeunload)
  PAGE_VIEW: 'page.view',         // Renderer top-level view navigation

  // ── Telemetry: chat messages (count-only, no content) ─────────────
  // `direction` separates a turn entering Halo from a reply leaving it;
  // `source` (agent | app-chat | im | im-reply) separates the entry point.
  MESSAGE_SENT: 'message.sent',
  MESSAGE_RECEIVED: 'message.received',

  // ── Telemetry: digital humans (automation apps) ───────────────────
  APP_INSTALLED: 'app.installed',
  APP_UNINSTALLED: 'app.uninstalled',
  APP_RUN_STARTED: 'app.run.started',
  APP_RUN_COMPLETED: 'app.run.completed',
  APP_RUN_FAILED: 'app.run.failed',
  APP_RUN_REPLAY: 'app.run.replay',           // Startup catch-up batch
  INSTALLED_APPS_SNAPSHOT: 'installed_apps.snapshot', // Startup full snapshot

  // ── Telemetry: store ──────────────────────────────────────────────
  // The rest of the store funnel is renderer-emitted (see ipc/analytics.ts);
  // this one is main-emitted because only the installer knows an install landed.
  STORE_INSTALL_DONE: 'store.install.done',

  // ── Telemetry: digital-human creation funnel (renderer-emitted) ───
  APPS_CREATE_OPEN: 'apps.create.open',
  APPS_CREATE_SUBMIT: 'apps.create.submit',

  // ── Telemetry: IM channel setup funnel ────────────────────────────
  // Brand-agnostic: every provider reports under the same two names and
  // distinguishes itself with `channel`.
  IM_BIND_QR_REQUEST: 'im.bind.qr_request',
  IM_BIND_RESULT: 'im.bind.result',

  // ── Telemetry: settings ───────────────────────────────────────────
  SETTINGS_SOURCE_SWITCH: 'settings.source_switch',
  SETTINGS_MODEL_SWITCH: 'settings.model_switch',

  // ── Telemetry: model + tool observability ─────────────────────────
  LLM_INVOCATION: 'llm.invocation',           // Each model call (per turn)
  TOOL_USAGE_SUMMARY: 'tool.usage_summary',   // Aggregated tool stats per agent-complete
  MCP_CONNECT: 'mcp.connect',                 // Per-server connection test verdict
  ERROR_SURFACE: 'error.surface',             // Coarse error map (area + errorCode)
} as const

export type AnalyticsEventName = typeof AnalyticsEvents[keyof typeof AnalyticsEvents]

/**
 * Events a non-main-process caller (renderer, remote/Capacitor HTTP client)
 * is allowed to report. Enforced identically at both entry points —
 * `ipc/analytics.ts` (`analytics:report`) and the `/api/analytics/report`
 * HTTP route — so a client cannot report an event through one transport
 * that is blocked on the other, and `store.install.done` (main-emitted only,
 * since only the installer knows an install actually landed) stays out of
 * reach of both.
 */
export const RENDERER_ALLOWED_EVENTS = new Set<string>([
  AnalyticsEvents.SESSION_START,
  AnalyticsEvents.SESSION_END,
  AnalyticsEvents.PAGE_VIEW,
  AnalyticsEvents.MESSAGE_SENT,
  AnalyticsEvents.MESSAGE_RECEIVED,
  'store.view',
  'store.detail.view',
  'store.card.click',
  'store.search',
  'store.category.filter',
  'store.install.click',
  'store.empty_state',
  'store.update.overwrite',
  'store.update.keep_current',
  'store.featured.view',
  'store.publish.open',
  'store.publish.submit',
  'store.mine.view',
  'store.unpublish',
  AnalyticsEvents.APPS_CREATE_OPEN,
  AnalyticsEvents.APPS_CREATE_SUBMIT,
])

/**
 * Analytics event structure
 */
export interface AnalyticsEvent {
  /** Event name */
  name: string
  /** Event properties (optional) */
  properties?: Record<string, unknown>
  /** Event timestamp */
  timestamp?: number
}

/**
 * User context information
 * Basic info sent with every event
 */
export interface UserContext {
  /** User unique ID (UUID, persisted) */
  userId: string
  /**
   * Externally-meaningful user ID resolved from `product.json.identitySource`,
   * typically an enterprise SSO UID. Set lazily; present only when the active
   * AI source exposes the field. Stable across sessions for the same user.
   */
  externalUserId?: string
  /** App version */
  appVersion: string
  /** Operating system platform */
  platform: NodeJS.Platform
  /** System architecture */
  arch: string
  /** Electron version */
  electronVersion: string
  /**
   * Local OS/network environment snapshot, only present when
   * `product.json.telemetry.collectHostIdentity` is enabled. Refreshed on a
   * TTL by `AnalyticsService.refreshHostIdentity()` — see
   * `foundation/host-identity.ts` for what it contains and why it is never
   * filtered by the telemetry sanitize pass.
   */
  hostIdentity?: HostIdentity
}

/**
 * Analytics config (stored in config.json).
 *
 * `lastSnapshotRunId` / `lastSnapshotTs` are the watermark pair used by the
 * startup snapshot module to replay only new `automation_runs` to the
 * telemetry backend. Both are optional — absent means "first snapshot".
 */
export interface AnalyticsConfig {
  /** User unique ID (generated on first launch) */
  userId: string
  /** Last launched version (for detecting updates) */
  lastVersion: string
  /** Last automation_runs runId forwarded to telemetry (watermark, exclusive) */
  lastSnapshotRunId?: string
  /** Last automation_runs finishedAt forwarded to telemetry (watermark, exclusive) */
  lastSnapshotTs?: number
}

/**
 * Provider config
 */
export interface ProviderConfig {
  baidu: {
    siteId: string
  }
  ga: {
    measurementId: string
    apiSecret: string
  }
  telemetry: {
    endpoint: string
    apiKey: string
  }
}

/**
 * Analytics Provider interface
 * All analytics platforms (Baidu, GA, Telemetry, ...) must implement this interface
 */
export interface AnalyticsProvider {
  /** Provider name (for logging) */
  readonly name: string

  /** Whether initialized */
  readonly initialized: boolean

  /**
   * Initialize provider
   * @param userId User ID
   */
  init(userId: string): Promise<void>

  /**
   * Track event
   * @param event Event info
   * @param context User context
   */
  track(event: AnalyticsEvent, context: UserContext): Promise<void>

  /**
   * Optional teardown hook. Providers that buffer events (e.g. the telemetry
   * batching queue) use this to flush and release resources at shutdown.
   * Called with a short total budget — implementations must be best-effort.
   */
  destroy?(): Promise<void>
}
