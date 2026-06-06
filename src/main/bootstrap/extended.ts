/**
 * Extended Services - Deferred Loading
 *
 * These services are loaded AFTER the window is visible.
 * They use lazy initialization - actual initialization happens on first use.
 *
 * GUIDELINES:
 *   - DEFAULT location for all new features
 *   - Services here do NOT block startup
 *   - Use lazy initialization pattern for heavy modules
 *
 * CURRENT SERVICES:
 *   - Background: Process keep-alive, system tray, daemon browser (automation infra)
 *   - Onboarding: First-time user guide (only needed once)
 *   - Remote: Remote access feature (optional)
 *   - Browser: Embedded browser for Content Canvas (V2 feature)
 *   - AIBrowser: AI browser automation tools (self-initializing via MCP server)
 *   - Overlay: Floating UI elements (optional)
 *   - Search: Global search (optional)
 *   - Performance: Developer monitoring tools (dev only)
 *   - GitBash: Windows Git Bash setup (Windows optional)
 *   - Platform: Store, Scheduler, Memory (automation infrastructure)
 *   - Apps: AppManager, AppRuntime (automation App lifecycle + event routing)
 */

import { registerOnboardingHandlers } from '../ipc/onboarding'
import { registerRemoteHandlers } from '../ipc/remote'
import { registerSecurityHandlers } from '../ipc/security'
import { enableRemoteAccess } from '../services/remote.service'
import { getConfig } from '../foundation/config.service'
import { registerBrowserHandlers } from '../ipc/browser'
import { cleanupAIBrowser } from '../services/ai-browser'
import { registerOverlayHandlers, cleanupOverlayHandlers } from '../ipc/overlay'
import { initializeSearchHandlers, cleanupSearchHandlers } from '../ipc/search'
import { registerPerfHandlers } from '../ipc/perf'
import { registerGitBashHandlers, initializeGitBashOnStartup } from '../ipc/git-bash'
import { cleanupAllCaches } from '../services/artifact-cache.service'
import { flushSpaceActivity } from '../services/space.service'
import { disposeSearchContext } from '../services/web-search'
import { markExtendedServicesReady } from './state'
import { getMainWindow, sendToRenderer } from '../foundation/window.service'
import { initializeHealthSystem, setSessionCleanupFn } from '../services/health'
import { closeAllV2Sessions } from '../services/agent/session-manager'
import { registerHealthHandlers } from '../ipc/health'
import { initBackground, shutdownBackground, getBackgroundService, setDaemonStealthInjector } from '../platform/background'
import { injectStealthScripts } from '../services/stealth'
import { initStore, shutdownStore } from '../platform/store'
import type { DatabaseManager } from '../platform/store'
import { initScheduler, shutdownScheduler } from '../platform/scheduler'
import { initMemory } from '../platform/memory'
import { setMemorySdk } from '../platform/memory/sdk'
import { tool as sdkTool, createSdkMcpServer as sdkCreateMcpServer } from '../services/agent/resolved-sdk'
import { initAppManager, shutdownAppManager } from '../apps/manager'
import { initAppRuntime, shutdownAppRuntime } from '../apps/runtime'
import { installAppsSubscribers } from '../services/analytics/subscribers/apps.subscriber'
import { runStartupSnapshot } from '../services/analytics/snapshot'
import { analytics } from '../services/analytics/analytics.service'
import { registerAppHandlers } from '../ipc/app'
import { registerAnalyticsHandlers } from '../ipc/analytics'
import { registerNotificationChannelHandlers } from '../ipc/notification-channels'
import { registerWecomBotHandlers } from '../ipc/wecom-bot'
import { registerImChannelHandlers } from '../ipc/im-channels'
import { registerImSessionHandlers } from '../ipc/im-sessions'
import { registerStoreHandlers } from '../ipc/store'
import { registerCliConfigHandlers } from '../ipc/cli-config'
import { registerModelCapabilitiesHandlers } from '../ipc/model-capabilities'
import { registerWeixinIlinkHandlers } from '../ipc/weixin-ilink'
import { initRegistryService, shutdownRegistryService } from '../store'
import { cleanupImChannelTempFiles } from '../apps/runtime/im-channels'
import { registerIdleTask, startIdleDrain } from './idle-queue'
import { seedDefaultAppIfNeeded } from '../apps/manager/seed'
import { loadBuiltinApps } from '../apps/manager/builtin-loader'

// Module-level reference to db for cleanup
let platformDb: DatabaseManager | null = null

/**
 * Initialize platform (store, scheduler, memory) and apps
 * (manager, runtime) modules. Runs asynchronously after extended services
 * are registered, so it does not block startup or the UI.
 *
 * Initialization order (per architecture §8B):
 *   Phase 0: initStore()
 *   Phase 1 (parallel): initScheduler, initMemory
 *   Phase 2: initAppManager
 *   Phase 3: initAppRuntime  (creates EventRouter, wires sources, starts everything)
 *
 * scheduler.start() is called after all sources are registered,
 * ensuring no events are missed. The EventRouter is started internally
 * by initAppRuntime().
 */
async function initPlatformAndApps(): Promise<void> {
  console.log('[Bootstrap] Platform+Apps initialization starting...')
  const t0 = performance.now()

  // ── Pre-init: Background cleanup (non-blocking) ─────────────────────────
  // Remove stale IM channel media temp files from previous sessions (>24h old).
  cleanupImChannelTempFiles()

  // ── Phase 0: Store ──────────────────────────────────────────────────────
  // Note: SDK is initialized earlier in index.ts (before essential services)
  const db = await initStore()
  platformDb = db

  // ── Phase 1: Platform services (parallel) ───────────────────────────────
  const [scheduler, memory] = await Promise.all([
    initScheduler({ db }),
    initMemory(),
  ])

  // Inject the resolved agent-SDK MCP primitives into the memory tier, so
  // platform/memory builds its MCP server without importing the services
  // tier. The SDK is already initialized (see index.ts) and these refs are
  // only invoked later, when a session's memory MCP server is built.
  setMemorySdk({ tool: sdkTool, createSdkMcpServer: sdkCreateMcpServer })

  // Get the background service singleton (already initialized by initBackground())
  const background = getBackgroundService()
  if (!background) {
    throw new Error('[Bootstrap] BackgroundService not available -- initBackground() must be called first')
  }

  // ── Phase 2: App Manager ─────────────────────────────────────────────────
  const appManager = await initAppManager({ db })

  // ── Phase 2.5: Migrate legacy config.mcpServers → DB ────────────────────
  // One-time migration: config.json mcpServers (dead storage from Issue #74)
  // are imported into the App Manager DB where getDbMcpServers() can read them.
  try {
    const { migrateConfigMcpToDb } = await import('../ipc/cli-config')
    await migrateConfigMcpToDb()
  } catch (err) {
    console.warn('[Bootstrap] Failed to run config.mcpServers migration:', err)
  }

  // ── Phase 3: App Runtime ─────────────────────────────────────────────────
  // initAppRuntime creates the EventRouter internally, wires source adapters
  // (FileWatcherSource, WebhookSource), activates Apps, and starts the router.
  const runtime = await initAppRuntime({ db, appManager, scheduler, memory, background })

  // ── Phase 3.5: Analytics subscribers ────────────────────────────────────
  // Wire lifecycle events (install/uninstall/run) into the analytics pipeline.
  // Must come after both appManager and runtime are ready.
  installAppsSubscribers(appManager, runtime)

  // ── Phase 4: Registry Service (App Store) ─────────────────────────────
  initRegistryService({ db })

  // ── Start timer loops AFTER all wiring is complete ──────────────────────
  // This ensures no events fire before subscriptions are registered.
  scheduler.start()

  // ── Tier 3: Idle tasks ─────────────────────────────────────────────────
  // Non-critical tasks that run after all essential infrastructure is ready.
  // Failures are logged as warnings and never affect core functionality.
  //
  // Order matters here: the built-in loader installs bundled digital humans
  // declared in product.json's `builtinApps` list. The default-app seed then
  // checks whether any automation app exists (or any built-in is bundled) to
  // decide if the "Halo 助手" placeholder should be created. Running the loader
  // first ensures the seed makes its decision against the post-loader state.
  registerIdleTask('load-builtin-apps', () => loadBuiltinApps(appManager))
  registerIdleTask('seed-default-app', () => seedDefaultAppIfNeeded(appManager))
  registerIdleTask('startup-snapshot', () => runStartupSnapshot(appManager, runtime))
  startIdleDrain()

  const dt = performance.now() - t0
  console.log(`[Bootstrap] Platform+Apps initialized in ${dt.toFixed(1)}ms`)
}

/**
 * Initialize extended services after window is visible
 *
 * Window reference is managed by window.service.ts, no need to pass here.
 *
 * These services are loaded asynchronously and do not block the UI.
 * Heavy modules use lazy initialization - they only fully initialize
 * when their features are first accessed.
 */
export function initializeExtendedServices(): void {
  const start = performance.now()
  console.log('[Bootstrap] Extended services starting...')

  console.log(`[Startup] proxy env_http=${process.env.HTTP_PROXY || ''} env_https=${process.env.HTTPS_PROXY || ''} env_no_proxy=${process.env.NO_PROXY || ''} app_proxy=${getConfig().network?.proxy || ''}`)

  // Get main window for services that still need it directly
  const mainWindow = getMainWindow()

  // === EXTENDED SERVICES ===
  // These services are loaded after the window is visible.
  // New features should be added here by default.

  // Onboarding: First-time user guide, only needed once
  registerOnboardingHandlers()

  // Remote: Remote access feature, optional functionality
  registerRemoteHandlers()

  // Security: expose renderer-safe security policy flags so the UI can
  // gate features (e.g. Tunnel section visibility under tunnelSafe).
  registerSecurityHandlers()

  // Auto-restore so paired devices keep working without manual re-enable.
  // CF tunnel is intentionally not restored — its Quick Tunnel URL changes per
  // run, which would break any previously shared link.
  //
  // Errors are caught here (rather than letting the idle task crash) so a
  // corrupted credential at rest cannot block other extended bootstrap
  // tasks. enableRemoteAccess has already disabled the persisted flag and
  // pushed a status update, so the UI will reflect the failure when the
  // settings page is opened.
  registerIdleTask('restore-remote-access', async () => {
    const cfg = getConfig()
    if (!cfg.remoteAccess.enabled) return
    try {
      await enableRemoteAccess(cfg.remoteAccess.port)
    } catch (err) {
      console.warn(
        '[Bootstrap] Remote access auto-restore failed:',
        (err as Error).message,
      )
    }
  })

  // Browser: Embedded BrowserView for Content Canvas
  // Note: BrowserView is created lazily when Canvas is opened
  registerBrowserHandlers(mainWindow)

  // AI Browser: No startup registration needed.
  // Initialization is self-contained in createAIBrowserMcpServer() (called on
  // demand by send-message, app-chat, and execute). See ai-browser/DESIGN.md.

  // Overlay: Floating UI elements (chat capsule, etc.)
  // Already implements lazy initialization internally
  registerOverlayHandlers(mainWindow)

  // Search: Global search functionality
  initializeSearchHandlers()

  // Performance: Developer monitoring tools (only if window is available)
  if (mainWindow) {
    registerPerfHandlers(mainWindow)
  }

  // GitBash: Windows Git Bash detection and setup
  registerGitBashHandlers()

  // Health: System health monitoring and recovery
  // Register IPC handlers for health queries from renderer
  registerHealthHandlers()

  // Background: Process keep-alive, system tray, daemon browser
  // Provides infrastructure for automation Apps to keep the process alive
  // and access a shared hidden BrowserWindow with stealth injection
  const backgroundService = initBackground()
  backgroundService.initTray()

  // Wire browser-domain stealth injection into the platform daemon browser
  // without the platform tier importing services (keeps platform → services
  // direction clean). Best-effort: the daemon window runs without it if unset.
  setDaemonStealthInjector(injectStealthScripts)

  // Analytics: fire-and-forget IPC channel for renderer telemetry
  registerAnalyticsHandlers()

  // App management IPC handlers (app:install, app:list, etc.)
  registerAppHandlers()

  // Notification channel IPC handlers (notify-channels:test, etc.)
  registerNotificationChannelHandlers()

  // WeCom Bot IPC handlers — legacy compat, delegates to ImChannelManager
  registerWecomBotHandlers()

  // IM Channel IPC handlers (multi-instance: im-channels:status, im-channels:reconnect, etc.)
  registerImChannelHandlers()

  // IM Session IPC handlers (im-sessions:list, im-sessions:set-proactive)
  registerImSessionHandlers()

  // Store: IPC handlers for App Store registry operations
  registerStoreHandlers()

  // CLI Config: IPC handlers for Claude CLI config dir + migration
  registerCliConfigHandlers()

  // Model Capabilities: IPC handlers for model capability lookups (preset + user overrides)
  registerModelCapabilitiesHandlers()

  // WeChat iLink Bot: QR code login + token management IPC handlers
  registerWeixinIlinkHandlers()

  // Windows-specific: Initialize Git Bash in background
  if (process.platform === 'win32') {
    initializeGitBashOnStartup()
      .then((status) => {
        console.log('[Bootstrap] Git Bash status:', status)
      })
      .catch((err) => {
        console.error('[Bootstrap] Git Bash initialization failed:', err)
      })
  }

  // Initialize health system asynchronously (non-blocking)
  // This runs startup checks and starts fallback polling
  setSessionCleanupFn(closeAllV2Sessions)
  initializeHealthSystem()
    .then(() => {
      console.log('[Bootstrap] Health system initialized')
    })
    .catch((err) => {
      console.error('[Bootstrap] Health system initialization failed:', err)
    })

  // Platform + Apps: Store, Scheduler, Memory, AppManager, AppRuntime
  // Runs fully asynchronously -- does not block the UI or extended-ready event.
  initPlatformAndApps().catch((err) => {
    console.error('[Bootstrap] Platform+Apps initialization failed:', err)
  })

  const duration = performance.now() - start
  console.log(`[Bootstrap] Extended services registered in ${duration.toFixed(1)}ms`)

  // Mark state as ready (for Pull-based queries from renderer)
  // This enables renderer to query status on HMR reload or error recovery
  markExtendedServicesReady()

  // Notify renderer that extended services are ready (Push-based)
  // This allows renderer to safely call extended service APIs
  sendToRenderer('bootstrap:extended-ready', {
    timestamp: Date.now(),
    duration: duration
  })
  console.log('[Bootstrap] Sent bootstrap:extended-ready to renderer')
}

/**
 * Cleanup extended services on app shutdown
 *
 * Called during window-all-closed to properly release resources.
 */
export async function cleanupExtendedServices(): Promise<void> {
  // Space: Flush any throttled activity timestamps to disk before teardown
  flushSpaceActivity()

  // Store: Shutdown registry service (before app manager)
  shutdownRegistryService()

  // Apps: Shutdown runtime first (deactivates all apps, stops event router, cancels runs).
  // This is intentionally ahead of `analytics.destroy()` so that any final
  // `RunFinishedEvent`s fired during deactivation are still delivered to the
  // analytics pipeline and buffered by the telemetry provider.
  await shutdownAppRuntime().catch(err => console.error('[Bootstrap] AppRuntime shutdown error:', err))
  await shutdownAppManager().catch(err => console.error('[Bootstrap] AppManager shutdown error:', err))

  // Analytics: Flush pending events (including anything buffered from the
  // runtime shutdown above). The provider applies its own bounded flush
  // timeout so we never hang here.
  await analytics.destroy().catch(err => console.error('[Bootstrap] Analytics shutdown error:', err))

  // Platform: Shutdown scheduler (stop timers)
  await shutdownScheduler().catch(err => console.error('[Bootstrap] Scheduler shutdown error:', err))

  // Platform: Close database connections
  if (platformDb) {
    await shutdownStore(platformDb).catch(err => console.error('[Bootstrap] Store shutdown error:', err))
    platformDb = null
  }

  // Background: Shutdown daemon browser, clear keep-alive, destroy tray
  shutdownBackground()

  // AI Browser: Cleanup global singleton context (scoped contexts are cleaned
  // up by their owners: app-chat.ts / execute.ts)
  cleanupAIBrowser()

  // Web Search: Dispose search context (cleanup any in-flight BrowserViews)
  await disposeSearchContext().catch(err => console.error('[Bootstrap] WebSearch shutdown error:', err))

  // Overlay: Cleanup overlay BrowserView
  cleanupOverlayHandlers()

  // Search: Cancel any ongoing searches
  cleanupSearchHandlers()

  // Artifact Cache: Close file watchers and clear caches
  await cleanupAllCaches()

  console.log('[Bootstrap] Extended services cleaned up')
}
