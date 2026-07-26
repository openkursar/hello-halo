/**
 * apps/runtime -- Public API
 *
 * App execution engine: activate, execute, report, escalate.
 *
 * This is the core glue layer that connects all platform modules
 * (scheduler, memory, background) with the Agent service to provide
 * autonomous App execution capabilities.
 *
 * The event routing layer (source adapters, filter engine, dedup cache)
 * is owned internally by the runtime module. The platform layer provides
 * only generic Emitter<T> for service-to-service communication.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initAppRuntime, shutdownAppRuntime } from '../apps/runtime'
 *
 *   const runtime = await initAppRuntime({
 *     db, appManager, scheduler, memory, background
 *   })
 *
 *   // At shutdown:
 *   await shutdownAppRuntime()
 *
 * Usage in IPC handlers:
 *
 *   import type { AppRuntimeService } from '../apps/runtime'
 *
 *   function handleManualTrigger(runtime: AppRuntimeService, appId: string) {
 *     return runtime.triggerManually(appId)
 *   }
 */

import type { DatabaseManager } from '../../platform/store'
import type { AppManagerService } from '../manager'
import type { SchedulerService } from '../../platform/scheduler'
import type { MemoryService } from '../../platform/memory'
import type { BackgroundService } from '../../platform/background'
import { join } from 'path'
import { homedir } from 'os'
import { getSpace } from '../../services/space.service'
import { getExpressApp } from '../../http/server'
import * as watcherHost from '../../services/watcher-host.service'
import { ActivityStore } from './store'
import { createAppRuntimeService } from './service'
import { MIGRATION_NAMESPACE, migrations } from './migrations'
import { createEventRouter, type EventRouter } from './event-router'
import { FileWatcherSource } from './sources/file-watcher.source'
import { WebhookSource, type WebhookSecretResolver } from './sources/webhook.source'
import { ImChannelManager, WecomBotProvider, WeixinIlinkBotProvider, setActiveImChannelManager } from './im-channels'
import { ImSessionRegistry, setImSessionRegistry } from './im-session-registry'
import { dispatchInboundMessage, clearSupplementBuffersForInstance } from './dispatch-inbound'
import { clearAllImPermissionContexts } from './im-permission-registry'
import { clearAllImStreamHandles } from './im-stream-registry'
import { getConfig } from '../../foundation/config.service'
import { getDataFolderName } from '../../foundation/product-config'
import { getAppManager } from '../manager'
import { onMcpAppsChange } from '../manager/service'
import { createHaloAppsMcpServer } from '../conversation-mcp'
import { registerAppBridge } from '../../services/app-bridge'
import { handleMcpAppsChange } from '../../services/agent/session-manager'
import type { AppRuntimeService } from './types'

// Re-export types for consumers
export type {
  AppRuntimeService,
  AppRunResult,
  AutomationAppState,
  AutomationRun,
  ActivityEntry,
  ActivityEntryContent,
  ActivityEntryType,
  ActivityQueryOptions,
  EscalationResponse,
  TriggerContext,
  TriggerType,
  RunStatus,
  ActivationState,
  AppRuntimeDeps,
} from './types'

// Re-export error types
export {
  AppNotRunnableError,
  ConcurrencyLimitError,
  EscalationNotFoundError,
  RunExecutionError,
} from './errors'

// Re-export concurrency for testing
export { Semaphore } from './concurrency'

// Re-export app chat functions
export {
  sendAppChatMessage,
  stopAppChat,
  isAppChatGenerating,
  loadAppChatMessages,
  loadImChatMessages,
  getAppChatSessionState,
  getAppChatConversationId,
  buildImSessionKey,
  cleanupAppChatBrowserContext,
  clearAppChat,
  clearImSession,
  stopImSession,
  restartAppChat,
} from './app-chat'
export type { AppChatRequest } from './app-chat'

// Re-export inbound dispatch
export { dispatchInboundMessage } from './dispatch-inbound'

// Re-export IM permission registry
export {
  setImPermissionContext,
  getImPermissionContext,
  clearImPermissionContext,
  clearAllImPermissionContexts,
} from './im-permission-registry'
export type { ImPermissionContext } from './im-permission-registry'

// Re-export IM stream registry
export {
  setImStreamHandle,
  getImStreamHandle,
  clearImStreamHandle,
  clearAllImStreamHandles,
} from './im-stream-registry'

// Re-export IM session registry accessor
export { getImSessionRegistry } from './im-session-registry'
export { ImSessionRegistry } from './im-session-registry'

// Re-export IM session invalidation (called by IPC reload handler)
export { invalidateImSessions } from '../../services/agent/session-manager'

// Re-export ImChannelManager for IPC/HTTP access
export { ImChannelManager } from './im-channels'

// ============================================
// Module State
// ============================================

let runtimeService: AppRuntimeService | null = null
let memoryServiceRef: MemoryService | null = null
let activityStoreRef: ActivityStore | null = null
let eventRouterInstance: EventRouter | null = null
let imChannelManagerInstance: ImChannelManager | null = null
let imSessionRegistryInstance: ImSessionRegistry | null = null

// ============================================
// Initialization
// ============================================

/** Dependencies required to initialize the App Runtime */
interface InitAppRuntimeDeps {
  /** DatabaseManager from platform/store */
  db: DatabaseManager
  /** App Manager service */
  appManager: AppManagerService
  /** Scheduler service */
  scheduler: SchedulerService
  /** Memory service */
  memory: MemoryService
  /** Background service */
  background: BackgroundService
}

/**
 * Normalize a webhook path for matching.
 * Strips leading/trailing slashes and lowercases for consistent comparison.
 */
function normalizeWebhookPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '').toLowerCase()
}

/**
 * Initialize the App Runtime module.
 *
 * 1. Gets the app-level database from DatabaseManager
 * 2. Runs schema migrations (automation_runs + activity_entries)
 * 3. Creates the EventRouter with source adapters
 * 4. Creates ImChannelManager and applies IM channel instance configs
 * 5. Creates the ActivityStore and AppRuntimeService
 * 6. Starts the EventRouter (after all subscriptions are wired)
 * 7. Activates all Apps with status='active'
 * 8. Returns the AppRuntimeService interface
 *
 * Must be called after all Phase 1 + Phase 2 modules are initialized:
 * - platform/store (Phase 0)
 * - apps/spec (Phase 0)
 * - platform/scheduler (Phase 1)
 * - platform/memory (Phase 1)
 * - platform/background (Phase 1)
 * - apps/manager (Phase 2)
 *
 * @param deps - Injected dependencies
 * @returns Initialized AppRuntimeService
 */
export async function initAppRuntime(
  deps: InitAppRuntimeDeps
): Promise<AppRuntimeService> {
  const start = performance.now()
  console.log('[Runtime] Initializing App Runtime...')

  // Invert the services→apps dependency: the agent engine and space service
  // reach app data through `services/app-bridge` (their own tier); the Apps
  // layer registers the concrete implementations here, before any session is
  // created. The agent's session-invalidation handler is likewise wired to
  // the MCP-apps-change event from this side.
  registerAppBridge({ getAppManager, createHaloAppsMcpServer, onMcpAppsChange })
  onMcpAppsChange(handleMcpAppsChange)

  // Get the app-level database
  const appDb = deps.db.getAppDatabase()

  // Run migrations
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  // Create the activity store
  const store = new ActivityStore(appDb)

  // ── Create and wire EventRouter ──────────────────────────────────────
  const eventRouter = createEventRouter()
  eventRouterInstance = eventRouter

  // FileWatcherSource: bridges watcher-host fs events into the event router.
  // Uses addFsEventsHandler() (multi-subscriber) so artifact-cache is not displaced.
  const fileWatcherSource = new FileWatcherSource(watcherHost)
  eventRouter.registerSource(fileWatcherSource)

  // WebhookSource: mounts POST /hooks/* on the Express server to receive
  // inbound webhooks from external services (GitHub, Stripe, etc.).
  // The secret resolver looks up HMAC secrets from installed Apps' webhook
  // subscription configs for per-hook signature verification.
  const webhookSecretResolver: WebhookSecretResolver = (hookPath: string) => {
    const apps = deps.appManager.listApps({ status: 'active', type: 'automation' })
    for (const app of apps) {
      if (app.spec.type !== 'automation') continue
      for (const sub of app.spec.subscriptions ?? []) {
        if (sub.source.type !== 'webhook') continue
        const config = sub.source.config
        // Match if the subscription's configured path matches the incoming hook path
        if (config.path && normalizeWebhookPath(config.path) === normalizeWebhookPath(hookPath)) {
          if (config.secret) return config.secret
        }
      }
    }
    return null
  }
  const webhookSource = new WebhookSource(getExpressApp(), webhookSecretResolver)
  eventRouter.registerSource(webhookSource)

  // ── IM Session Registry ─────────────────────────────────────────────
  // The registry tracks all known IM sessions across digital humans.
  const registryPath = join(homedir(), `.${getDataFolderName()}`, 'im-sessions.json')
  const registry = new ImSessionRegistry(registryPath)
  setImSessionRegistry(registry)
  imSessionRegistryInstance = registry

  // ── IM Channel Manager (multi-instance) ─────────────────────────────
  // Manages all IM channel instances (WeCom Bot, Feishu Bot, DingTalk Bot, etc.)
  // Each instance is a separate connection bound to a specific digital human.
  const imChannelManager = new ImChannelManager()
  imChannelManagerInstance = imChannelManager

  // Expose via module-level accessor so dispatch-inbound.ts can resolve
  // fileCapability without a circular import (dispatch-inbound ← index ← dispatch-inbound).
  setActiveImChannelManager(imChannelManager)

  // Register built-in providers
  imChannelManager.registerProvider(new WecomBotProvider())
  imChannelManager.registerProvider(new WeixinIlinkBotProvider())
  // Future: imChannelManager.registerProvider(new FeishuBotProvider())
  // Future: imChannelManager.registerProvider(new DingTalkBotProvider())

  // Clean up supplement buffers when an instance is torn down
  imChannelManager.setOnInstanceStop((instanceId) => {
    clearSupplementBuffersForInstance(instanceId)
  })

  // Apply IM channel instance configs from config.json
  const config = getConfig()
  const instances = config.imChannels?.instances ?? []
  imChannelManager.applyConfig(instances, (instanceId, appId, msg, reply) => {
    // This callback is invoked by each instance when it receives an inbound message.
    // The instanceId and appId are pre-resolved from the instance's config binding.
    dispatchInboundMessage(msg, reply, appId, instanceId)
  })

  // ── Create the runtime service ─────────────────────────────────────────
  const service = createAppRuntimeService({
    store,
    appManager: deps.appManager,
    scheduler: deps.scheduler,
    eventRouter,
    memory: deps.memory,
    background: deps.background,
    getSpacePath: (spaceId: string): string | null => {
      const space = getSpace(spaceId)
      return space?.path ?? null
    },
    imSessionRegistry: registry,
    getChannelAdapter: (channel: string) => {
      // For backward compatibility, look up by instance ID first (new path)
      // then fall back to channel type scan (for legacy sessions without instanceId)
      const instance = imChannelManager.getInstance(channel)
      if (instance) return { channel: instance.providerType, pushToChat: instance.pushToChat.bind(instance), isConnected: instance.isConnected.bind(instance) }
      // Fallback: find any connected instance of the given channel type
      for (const status of imChannelManager.getAllStatuses()) {
        if (status.type === channel && status.connected) {
          const inst = imChannelManager.getInstance(status.id)
          if (inst) return { channel: inst.providerType, pushToChat: inst.pushToChat.bind(inst), isConnected: inst.isConnected.bind(inst) }
        }
      }
      return null
    },
  })

  // Activate all active automation Apps (registers event subscriptions)
  await service.activateAll()

  // Start the event router AFTER all subscriptions are registered
  // to ensure no events are missed.
  eventRouter.start()

  runtimeService = service
  memoryServiceRef = deps.memory
  activityStoreRef = store

  const duration = performance.now() - start
  console.log(`[Runtime] App Runtime initialized in ${duration.toFixed(1)}ms`)

  return service
}

/**
 * Get the current runtime service instance.
 * Returns null if not yet initialized.
 */
export function getAppRuntime(): AppRuntimeService | null {
  return runtimeService
}

/**
 * Get the memory service instance captured during init.
 * Used by app-chat.ts to build app-specific memory tools.
 */
export function getAppMemoryService(): MemoryService | null {
  return memoryServiceRef
}

/**
 * Get the activity store instance captured during init.
 * Used by app-chat.ts to provide report_to_user in chat mode.
 */
export function getActivityStore(): ActivityStore | null {
  return activityStoreRef
}

/**
 * Get the ImChannelManager instance for external use
 * (e.g., status queries, reconnect, config reload from IPC/HTTP).
 */
export function getImChannelManager(): ImChannelManager | null {
  return imChannelManagerInstance
}

/**
 * Shutdown the App Runtime module.
 *
 * 1. Deactivates all Apps (removes scheduler jobs + event subscriptions)
 * 2. Stops the event router and all source adapters
 * 3. Stops all IM channel instances
 * 4. Clears the module state
 */
export async function shutdownAppRuntime(): Promise<void> {
  console.log('[Runtime] Shutting down App Runtime...')

  if (runtimeService) {
    await runtimeService.deactivateAll()
    runtimeService = null
    memoryServiceRef = null
    activityStoreRef = null
  }

  if (eventRouterInstance) {
    eventRouterInstance.stop()
    eventRouterInstance = null
  }

  if (imChannelManagerInstance) {
    imChannelManagerInstance.stopAll()
    imChannelManagerInstance = null
    setActiveImChannelManager(null)
  }

  imSessionRegistryInstance = null
  setImSessionRegistry(null as any)

  // Clear all IM permission contexts (in-memory only, no persistence needed)
  clearAllImPermissionContexts()

  // Drop any in-flight IM stream handles so a post-shutdown stopImSession
  // call cannot reach a disposed WecomStreamSession.
  clearAllImStreamHandles()

  console.log('[Runtime] App Runtime shutdown complete')
}
