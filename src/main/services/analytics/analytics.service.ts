/**
 * Analytics Service - Core Service
 *
 * Core service for analytics module, responsible for:
 * 1. Managing multiple providers (Baidu Analytics, GA4, self-hosted Telemetry)
 * 2. Unified event tracking interface
 * 3. User ID management + optional externalUserId resolution
 * 4. Lifecycle event handling (install, launch, update)
 * 5. Snapshot watermark persistence (for the startup replay module)
 */

import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { v4 as uuidv4 } from 'uuid'
import type {
  AnalyticsEvent,
  AnalyticsEventName,
  AnalyticsProvider,
  UserContext,
  AnalyticsConfig
} from './types'
import { AnalyticsEvents } from './types'
import { createGAProvider } from './providers/ga'
import { createBaiduProvider } from './providers/baidu'
import { createTelemetryProvider } from './providers/telemetry'
import { getConfig, saveConfig } from '../../foundation/config.service'
import { getIdentitySource, getTelemetryConfig } from '../../foundation/product-config'
import { getCurrentSource } from '../../../shared/types'
import { deriveErrorCode } from './error-code'

/**
 * Build-time injected analytics credentials
 * These are defined in electron.vite.config.ts and loaded from .env.local
 * In open-source builds without .env.local, these will be empty strings
 */
declare const __HALO_GA_MEASUREMENT_ID__: string
declare const __HALO_GA_API_SECRET__: string
declare const __HALO_BAIDU_SITE_ID__: string
declare const __HALO_TELEMETRY_ENDPOINT__: string
declare const __HALO_TELEMETRY_API_KEY__: string

/**
 * Provider configuration (injected at build time)
 * When credentials are empty, the provider will be disabled
 */
const PROVIDER_CONFIG = {
  baidu: {
    siteId: __HALO_BAIDU_SITE_ID__
  },
  ga: {
    measurementId: __HALO_GA_MEASUREMENT_ID__,
    apiSecret: __HALO_GA_API_SECRET__
  },
  telemetry: {
    endpoint: __HALO_TELEMETRY_ENDPOINT__,
    apiKey: __HALO_TELEMETRY_API_KEY__
  }
}

/**
 * Analytics Service class (singleton)
 */
class AnalyticsService {
  private static instance: AnalyticsService | null = null

  private providers: AnalyticsProvider[] = []
  private userContext: UserContext | null = null
  private config: AnalyticsConfig | null = null
  private _initialized = false
  /**
   * Cached external ID resolution. The cache key is (sourceId, path) so that
   * a runtime change to `product.json.identitySource` (e.g. uid → email)
   * invalidates the cache on the next refresh instead of returning stale data.
   */
  private resolvedExternalId: { sourceId: string; path: string; uid: string } | null = null

  /**
   * Resolves once `init()` has completed — whether it enabled providers or
   * opted out (dev mode, empty credentials). Consumers that only need to
   * know "has init been attempted" can `await whenSettled()` instead of
   * polling `initialized`. Reset on `destroy()` so subsequent re-inits of
   * the singleton (mainly used by tests) get a fresh gate.
   */
  private settledResolver: (() => void) | null = null
  private settledPromise: Promise<void> = new Promise<void>(resolve => {
    this.settledResolver = resolve
  })

  /** Throttling state for dropped-event warnings. */
  private droppedEventCount = 0
  private lastDroppedWarnTs = 0
  private static readonly DROP_WARN_INTERVAL_MS = 30_000

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): AnalyticsService {
    if (!AnalyticsService.instance) {
      AnalyticsService.instance = new AnalyticsService()
    }
    return AnalyticsService.instance
  }

  /**
   * Whether the service is initialized
   */
  get initialized(): boolean {
    return this._initialized
  }

  /**
   * Initialize Analytics service
   * Should be called after app.whenReady()
   */
  async init(): Promise<void> {
    // Skip analytics in development mode
    if (is.dev) {
      console.log('[Analytics] Skipping in development mode')
      this.markSettled()
      return
    }

    if (this._initialized) {
      console.log('[Analytics] Already initialized')
      this.markSettled()
      return
    }

    console.log('[Analytics] Initializing...')

    try {
      // Load or create config
      this.config = this.loadOrCreateConfig()

      // Build user context
      this.userContext = this.buildUserContext()

      // Initialize providers
      await this.initProviders()

      this._initialized = true
      console.log('[Analytics] Initialized successfully')

      // Handle lifecycle events
      await this.handleLifecycleEvents()
    } finally {
      // Always unblock `whenSettled()` callers — the startup snapshot and
      // any other consumers should not hang indefinitely if a provider
      // init throws unexpectedly.
      this.markSettled()
    }
  }

  /**
   * Resolve the settled-gate exactly once. Idempotent.
   */
  private markSettled(): void {
    if (this.settledResolver) {
      this.settledResolver()
      this.settledResolver = null
    }
  }

  /**
   * Returns a promise that resolves once `init()` has completed (successfully
   * or skipped). Use this from consumers that start concurrently with init —
   * e.g. the startup snapshot — to avoid a race where their first `track()`
   * is silently dropped because the service is not yet initialized.
   *
   * An optional timeout guards against a never-initialized service (e.g. a
   * bootstrap path that forgets to call init). Returns `true` if settled
   * within the timeout, `false` otherwise.
   */
  async whenSettled(timeoutMs = 10_000): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      if (timer.unref) timer.unref()
    })
    const result = await Promise.race([
      this.settledPromise.then(() => true as const),
      timeoutPromise,
    ])
    if (timer) clearTimeout(timer)
    return result
  }

  /**
   * Track an event
   * @param eventName Event name (use AnalyticsEvents constants)
   * @param properties Event properties (optional)
   */
  async track(
    eventName: AnalyticsEventName | string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    if (!this._initialized || !this.userContext) {
      // Renderer fires many events early in startup, before `init()` has
      // finished — spamming a warn per event is unhelpful. Log the first
      // drop and then throttle to one warning per DROP_WARN_INTERVAL_MS,
      // so a persistent bug (e.g. init never called) is still visible.
      this.logDroppedEvent(eventName)
      return
    }

    // Refresh externalUserId lazily on each call so user login/logout between
    // events updates the telemetry identity without a service restart.
    this.refreshExternalUserId()

    const event: AnalyticsEvent = {
      name: eventName,
      properties,
      timestamp: Date.now()
    }

    // Track to all providers in parallel (isolated from each other)
    await Promise.allSettled(
      this.providers.map(provider =>
        provider.track(event, this.userContext!)
      )
    )
  }

  /**
   * Track a coarse-grained error surface event.
   *
   * Centralized helper for IPC / service catch paths to emit `error.surface`
   * with a consistent (area, errorCode) shape. The full error message is
   * never forwarded — only the derived first-token code (capped at 48
   * chars), and even that only when the build's `allowedSensitiveFields`
   * permits `errorCode`.
   *
   * Internally try/catch'd: a telemetry helper called from an error path
   * must NEVER re-throw — that would mask the original error and risk
   * unbounded recursion if a downstream catch also calls back here.
   */
  trackErrorSurface(area: string, error: unknown): void {
    try {
      const errorCode = deriveErrorCode(error)
      // Fire-and-forget: track() already swallows provider errors. The void
      // is explicit so a future linter rule about unawaited promises is happy.
      void this.track(AnalyticsEvents.ERROR_SURFACE, {
        area,
        errorCode,
      })
    } catch (err) {
      // Last-resort guard. Telemetry helper must not re-throw.
      console.warn('[Analytics] trackErrorSurface failed:', err)
    }
  }

  /**
   * Record a dropped event and emit a throttled warning so a persistent
   * misconfiguration (e.g. `init()` never called) is observable without
   * spamming the console during the normal startup race window.
   */
  private logDroppedEvent(eventName: string): void {
    this.droppedEventCount += 1
    const now = Date.now()
    if (now - this.lastDroppedWarnTs >= AnalyticsService.DROP_WARN_INTERVAL_MS) {
      console.warn(
        `[Analytics] Dropped ${this.droppedEventCount} event(s) before init (most recent: ${eventName})`
      )
      this.lastDroppedWarnTs = now
      this.droppedEventCount = 0
    }
  }

  /**
   * Shut down all providers. Called during app cleanup.
   *
   * Providers with buffered state (TelemetryProvider) flush their queue here.
   * Errors from a single provider never block others.
   */
  async destroy(): Promise<void> {
    if (!this._initialized) return

    await Promise.allSettled(
      this.providers.map(async provider => {
        if (typeof provider.destroy === 'function') {
          try {
            await provider.destroy()
          } catch (error) {
            console.warn(`[Analytics] ${provider.name} destroy failed:`, error)
          }
        }
      })
    )

    this._initialized = false
    console.log('[Analytics] Destroyed')
  }

  /**
   * Load or create Analytics config
   */
  private loadOrCreateConfig(): AnalyticsConfig {
    const config = getConfig()
    const currentVersion = app.getVersion()

    // Create new config if not exists
    if (!config.analytics) {
      const newAnalyticsConfig: AnalyticsConfig = {
        userId: uuidv4(),
        lastVersion: currentVersion
      }

      // Save to config file
      saveConfig({ analytics: newAnalyticsConfig })

      console.log('[Analytics] Created new config with userId:', newAnalyticsConfig.userId.slice(0, 8) + '...')
      return newAnalyticsConfig
    }

    return config.analytics
  }

  /**
   * Build user context
   */
  private buildUserContext(): UserContext {
    return {
      userId: this.config!.userId,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron
    }
  }

  /**
   * Populate `userContext.externalUserId` from the current AI source when
   * `product.json.identitySource` is configured.
   *
   * Idempotent: if the active source ID hasn't changed since the last call,
   * we reuse the cached resolution and avoid re-reading config.
   */
  private refreshExternalUserId(): void {
    if (!this.userContext) return

    const path = getIdentitySource()
    if (!path) {
      this.userContext.externalUserId = undefined
      return
    }

    try {
      const aiSources = getConfig().aiSources
      if (!aiSources || aiSources.version !== 2) {
        this.userContext.externalUserId = undefined
        return
      }

      const source = getCurrentSource(aiSources)
      if (!source) {
        this.userContext.externalUserId = undefined
        return
      }

      // Fast path: same source + same path as last time → reuse cached uid.
      if (
        this.resolvedExternalId &&
        this.resolvedExternalId.sourceId === source.id &&
        this.resolvedExternalId.path === path
      ) {
        this.userContext.externalUserId = this.resolvedExternalId.uid
        return
      }

      const uid = this.resolveDotPath(source as unknown as Record<string, unknown>, path)
      if (typeof uid === 'string' && uid.length > 0) {
        this.resolvedExternalId = { sourceId: source.id, path, uid }
        this.userContext.externalUserId = uid
      } else {
        this.resolvedExternalId = null
        this.userContext.externalUserId = undefined
      }
    } catch (err) {
      // Never let identity resolution break tracking.
      console.warn('[Analytics] externalUserId resolution failed:', err)
      this.userContext.externalUserId = undefined
    }
  }

  /**
   * Walk a dot-separated path through a plain object.
   * Returns undefined for any missing segment or non-object intermediate.
   */
  private resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.')
    let current: unknown = obj
    for (const part of parts) {
      if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part]
      } else {
        return undefined
      }
    }
    return current
  }

  /**
   * Initialize all providers
   */
  private async initProviders(): Promise<void> {
    const userId = this.config!.userId

    // Create and initialize providers
    // Each provider is isolated - one failing won't affect others

    // Baidu Analytics provider (for China)
    try {
      const baiduProvider = createBaiduProvider(PROVIDER_CONFIG.baidu.siteId)
      await baiduProvider.init(userId)
      if (baiduProvider.initialized) {
        this.providers.push(baiduProvider)
      }
    } catch (error) {
      console.warn('[Analytics] Baidu provider init failed:', error)
    }

    // GA4 provider (for international)
    try {
      const gaProvider = createGAProvider(
        PROVIDER_CONFIG.ga.measurementId,
        PROVIDER_CONFIG.ga.apiSecret
      )
      await gaProvider.init(userId)
      if (gaProvider.initialized) {
        this.providers.push(gaProvider)
      }
    } catch (error) {
      console.warn('[Analytics] GA4 provider init failed:', error)
    }

    // Self-hosted Telemetry provider (enterprise/internal builds)
    // SENSITIVE_KEYS allowlist comes from product.json — open-source builds
    // omit the telemetry block entirely, so this is an empty array there
    // and the provider drops every sensitive key at sanitize time.
    try {
      const allowedSensitiveFields = getTelemetryConfig()?.allowedSensitiveFields ?? []
      const telemetryProvider = createTelemetryProvider(
        PROVIDER_CONFIG.telemetry.endpoint,
        PROVIDER_CONFIG.telemetry.apiKey,
        allowedSensitiveFields
      )
      await telemetryProvider.init(userId)
      if (telemetryProvider.initialized) {
        this.providers.push(telemetryProvider)
      }
    } catch (error) {
      console.warn('[Analytics] Telemetry provider init failed:', error)
    }

    console.log(`[Analytics] ${this.providers.length} provider(s) active:`,
      this.providers.map(p => p.name).join(', ') || 'none'
    )
  }

  /**
   * Handle lifecycle events
   */
  private async handleLifecycleEvents(): Promise<void> {
    const config = getConfig()
    const currentVersion = app.getVersion()
    const lastVersion = this.config!.lastVersion

    // Detect first install
    if (config.isFirstLaunch) {
      await this.track(AnalyticsEvents.APP_INSTALL)
    }
    // Detect version update
    else if (lastVersion && lastVersion !== currentVersion) {
      await this.track(AnalyticsEvents.APP_UPDATE, {
        from_version: lastVersion,
        to_version: currentVersion
      })
    }

    // Track app launch
    await this.track(AnalyticsEvents.APP_LAUNCH)

    // Update lastVersion
    if (lastVersion !== currentVersion) {
      this.persistConfig({ lastVersion: currentVersion })
    }
  }

  /**
   * Get user ID (for future account binding)
   */
  getUserId(): string | null {
    return this.config?.userId || null
  }

  /**
   * Get Baidu Analytics site ID (for renderer process SDK initialization)
   */
  getBaiduSiteId(): string {
    return PROVIDER_CONFIG.baidu.siteId
  }

  /**
   * Snapshot watermark getter.
   *
   * Returns the pair of `(lastSnapshotRunId, lastSnapshotTs)` that the
   * startup snapshot module persisted on the previous launch. Either field
   * may be undefined when this is the first snapshot.
   */
  getSnapshotState(): { lastSnapshotRunId?: string; lastSnapshotTs?: number } {
    if (!this.config) return {}
    return {
      lastSnapshotRunId: this.config.lastSnapshotRunId,
      lastSnapshotTs: this.config.lastSnapshotTs,
    }
  }

  /**
   * Snapshot watermark setter — persists to config.json.
   *
   * Called by the startup snapshot module after a successful replay so the
   * next launch only ships new automation runs to telemetry.
   */
  setSnapshotState(state: { runId?: string; ts?: number }): void {
    if (!this.config) return
    this.persistConfig({
      lastSnapshotRunId: state.runId ?? this.config.lastSnapshotRunId,
      lastSnapshotTs: state.ts ?? this.config.lastSnapshotTs,
    })
  }

  /**
   * Merge a partial update into the in-memory config and persist it.
   * Centralized to avoid drift between the in-memory `this.config` and
   * the serialized `config.analytics` block.
   */
  private persistConfig(update: Partial<AnalyticsConfig>): void {
    if (!this.config) return
    this.config = { ...this.config, ...update }
    saveConfig({ analytics: this.config })
  }
}

// Export singleton
export const analytics = AnalyticsService.getInstance()

// Export init method (called from main/index.ts)
export async function initAnalytics(): Promise<void> {
  await analytics.init()
}

// Export convenience method
export async function trackEvent(
  eventName: AnalyticsEventName | string,
  properties?: Record<string, unknown>
): Promise<void> {
  await analytics.track(eventName, properties)
}
