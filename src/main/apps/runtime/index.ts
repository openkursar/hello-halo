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
import { getAppManager, type AppManagerService } from '../manager'
import { previewAppSpaceChange, changeAppDefaultSpace, retainAppEnvironments } from './space-change'
import { readSessionMessages } from './session-store'
import { RunProcessClearedError } from './errors'
import { buildAppCapabilityInventory } from './capability-inventory'
import { buildPeopleDirectory } from './people-directory'
import { getTeamStore } from '../team'
import type { SchedulerService } from '../../platform/scheduler'
import type { MemoryService } from '../../platform/memory'
import type { BackgroundService } from '../../platform/background'
import { join } from 'path'
import { getSpace } from '../../services/space.service'
import { getWebhookIngressRouter } from '../../http/server'
import * as watcherHost from '../../services/watcher-host.service'
import { ActivityStore } from './store'
import { createAppRuntimeService } from './service'
import { MIGRATION_NAMESPACE, migrations } from './migrations'
import { createEventRouter, type EventRouter } from './event-router'
import { FileWatcherSource } from './sources/file-watcher.source'
import { WebhookSource, type WebhookSecretResolver } from './sources/webhook.source'
import { ImChannelManager, WecomBotProvider, WeixinIlinkBotProvider, FeishuBotProvider, setActiveImChannelManager } from './im-channels'
import { ImSessionRegistry, setImSessionRegistry } from './im-session-registry'
import { PendingRelayStore, setPendingRelayStore, getPendingRelayStore } from './pending-relays'
import { createConversationReminders, setConversationReminders } from './reminders'
import { deliverReminder } from './reminders/delivery'
import { restoreLegacyDefaultChats } from './legacy-default-chats'
import { dispatchInboundMessage, clearSupplementBuffersForInstance, releaseSupplementsWhenIdle } from './dispatch-inbound'
import { clearAllImPermissionContexts } from './im-permission-registry'
import { clearAllImStreamHandles } from './im-stream-registry'
import { destroyAllChatBrowserContexts } from './app-chat-browser'
import { getConfig, getHaloDir } from '../../foundation/config.service'
import { onMcpAppsChange } from '../manager/service'
import { createHaloAppsMcpServer, createSpaceTeamMcpServer, TEAM_TOOLSET_GUIDE } from '../conversation-mcp'
import { TEAM_MCP_SERVER_NAME } from '../../../shared/apps/team-types'
import { registerAppBridge } from '../../services/app-bridge'
import { registerToolset } from '../../services/agent/toolsets/registry'
import { handleMcpAppsChange } from '../../services/agent/session-manager'
import { handleMcpAppsChangeForStatus } from '../../services/agent/mcp-probe'
import type { AppRuntimeService } from './types'
import { initSessionBudget, disposeSessionBudget } from './session-budget'
import { releaseSpaceWatcher, retainSpaceWatcher } from '../../services/watcher-host.service'

// Re-export types for consumers
export type {
  AppRuntimeService,
  AppRunResult,
  AppOverviewEntry,
  AppRunStartInfo,
  AutomationAppState,
  AutomationRun,
  AutomationRunWithSummary,
  ExecutionEnvironment,
  ActivitySource,
  EscalationContinuation,
  ActivityEntry,
  ActivityEntryContent,
  ActivityEntryType,
  ActivityQueryOptions,
  PendingDecisionQuery,
  RunQueryOptions,
  RunStats,
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
  RunProcessClearedError,
} from './errors'

// Re-export concurrency for testing
export { Semaphore } from './concurrency'
export { createPersonContextTool } from './person-context-tool'

// Re-export app chat functions
export {
  sendAppChatMessage,
  stopAppChat,
  stopAppChatConversation,
  isAppChatGenerating,
  isAppChatConversationGenerating,
  loadAppChatMessages,
  loadImChatMessages,
  loadChatMessagesForConversation,
  loadChatTranscriptForConversation,
  loadChatMessageThoughts,
  getAppChatSessionState,
  getAppChatConversationId,
  buildImSessionKey,
  clearAppChat,
  clearImSession,
  stopImSession,
  restartAppChat,
  createNativeChatSession,
  forkNativeChatSession,
  deleteNativeChatSession,
  isNativeChatGone,
  renameChatSession,
} from './app-chat'
export type { AppChatRequest, NativeSessionResult } from './app-chat'
export { injectIntoAppChatWhenLive } from './app-chat-live-turn'
export { createDigitalHumanConversationSource } from './conversation-source'
export { createRunConversationSource } from './run-conversation-source'

// Re-export inbound dispatch
export { dispatchInboundMessage } from './dispatch-inbound'

// Re-export intentional-stop marker (called by IPC/HTTP stop handlers, read by app-chat.ts)
export { markIntentionalStop } from './intentional-stop'

// Resident engine-session budget (team epoch seal releases member sessions)
export { releaseTeamEpochSessions } from './session-budget'

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

// Digital-human memory as its owner sees it from settings (called by IPC/HTTP)
export { getDigitalHumanMemoryStatus, consolidateDigitalHumanMemoryNow } from './memory-control'

// Reminders a digital human set in its conversations, as its page lists them (called by IPC/HTTP)
export { listAppReminders, cancelAppReminder } from './reminders/view'

// Re-export IM session invalidation (called by IPC reload handler)
export { invalidateImSessions } from '../../services/agent/session-manager'

// Re-export ImChannelManager for IPC/HTTP access
export { ImChannelManager } from './im-channels'

// ============================================
// Module State
// ============================================

let runtimeService: AppRuntimeService | null = null
let memoryServiceRef: MemoryService | null = null
let eventRouterInstance: EventRouter | null = null
let imChannelManagerInstance: ImChannelManager | null = null
let stopReleasingSupplements: (() => void) | null = null
let imSessionRegistryInstance: ImSessionRegistry | null = null
let activityStoreRef: ActivityStore | null = null

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

  // Resident engine sessions are budgeted from here for every chat entry.
  initSessionBudget()
  // Team collaboration is an opt-in toolset, not an always-on server: its tool
  // surface (and usage guide) enters a space conversation only when the user
  // flips the switch, the same shape as ai-browser / ai-terminal. Registered
  // from the apps tier because the team service lives here; the registry is a
  // downward import.
  registerToolset({
    id: TEAM_MCP_SERVER_NAME,
    displayName: 'Team Collaboration',
    summary: 'Assemble a team of AI members to work in parallel, coordinate them, and delegate to saved teams.',
    usageGuide: TEAM_TOOLSET_GUIDE,
    isAvailable: () => true,
    createServer: (scope) =>
      createSpaceTeamMcpServer({
        spaceId: scope.spaceId,
        conversationId: scope.conversationId,
        workDir: scope.workDir,
      }),
  })
  // Keep the shared MCP status cache honest: probe on enable/install/update,
  // drop stale entries on pause/uninstall.
  onMcpAppsChange(handleMcpAppsChangeForStatus)

  // Get the app-level database
  const appDb = deps.db.getAppDatabase()

  // Run migrations
  deps.db.runMigrations(appDb, MIGRATION_NAMESPACE, migrations)

  // Create the activity store
  const store = new ActivityStore(appDb)
  activityStoreRef = store

  // ── Create and wire EventRouter ──────────────────────────────────────
  const eventRouter = createEventRouter()
  eventRouterInstance = eventRouter

  // FileWatcherSource: bridges watcher-host fs events into the event router.
  // Uses addFsEventsHandler() (multi-subscriber) so artifact-cache is not displaced.
  const fileWatcherSource = new FileWatcherSource(watcherHost)
  eventRouter.registerSource(fileWatcherSource)

  // WebhookSource: registers its POST route on the webhook ingress router
  // (mounted at /hooks by http/server ahead of auth middleware) to receive
  // inbound webhooks from external services (GitHub, Stripe, etc.). The
  // router is a process-lifetime singleton, so this works even though the
  // HTTP server starts after initAppRuntime and may be restarted later.
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
  const webhookSource = new WebhookSource(getWebhookIngressRouter(), webhookSecretResolver)
  eventRouter.registerSource(webhookSource)

  // ── IM Session Registry ─────────────────────────────────────────────
  // The registry lists every digital-human session (IM, HTTP, local and
  // default chats). Its files live in this instance's data dir, so a dev
  // build or a HALO_DATA_DIR node never shares them with another install.
  const haloDir = getHaloDir()
  const registry = new ImSessionRegistry(join(haloDir, 'im-sessions.json'))
  setImSessionRegistry(registry)
  imSessionRegistryInstance = registry

  const automationApps = deps.appManager.listApps({ type: 'automation' })
  for (const app of automationApps) {
    if (app.status === 'uninstalled' || store.getSessionEnvironment(`environment-backfill:${app.id}`)) continue
    try {
      retainAppEnvironments(deps.appManager, store, app)
    } catch (error) {
      console.warn('[Runtime] Legacy environment backfill blocked; original storage must be restored', { appId: app.id, error })
    }
  }
  restoreLegacyDefaultChats(automationApps, store, registry)

  // ── Pending Relay Spool ─────────────────────────────────────────────
  // Records notify_bot pushes against their target sessions so the target's
  // AI regains awareness of them on its next inbound message.
  setPendingRelayStore(new PendingRelayStore(join(haloDir, 'im-pending-relays.json')))

  // ── Conversation reminders ──────────────────────────────────────────
  // Their handler is registered here, before bootstrap starts the scheduler,
  // and what a previous run left behind is swept while nothing can fire.
  const reminders = createConversationReminders({
    scheduler: deps.scheduler,
    deliver: deliverReminder,
    appExists: (appId) => {
      const app = deps.appManager.getApp(appId)
      return !!app && app.status !== 'uninstalled'
    },
  })
  reminders.registerHandler()
  reminders.sweep()
  setConversationReminders(reminders)
  deps.appManager.onAppUninstalled((app) => {
    reminders.removeForApp(app.id)
  })

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
  imChannelManager.registerProvider(new FeishuBotProvider())
  // Future: imChannelManager.registerProvider(new DingTalkBotProvider())

  // Clean up supplement buffers when an instance is torn down
  imChannelManager.setOnInstanceStop((instanceId) => {
    clearSupplementBuffersForInstance(instanceId)
  })
  // ...and release them once their chat is free again, however it got there.
  stopReleasingSupplements?.()
  stopReleasingSupplements = releaseSupplementsWhenIdle()

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
    fileWatch: {
      retain: (spaceId: string, holder: string) => {
        const space = getSpace(spaceId)
        if (!space) {
          console.warn(`[Runtime] File subscription on missing space ${spaceId} (${holder}); not watching`)
          return
        }
        retainSpaceWatcher(spaceId, space.workingDir || space.path, holder)
      },
      release: releaseSpaceWatcher,
    },
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
 * Get the ActivityStore instance captured during init.
 * Used by app-chat.ts to provide report_to_user in team turns.
 */
export function getActivityStore(): ActivityStore | null {
  return activityStoreRef
}

function spaceChangeDependencies() {
  const manager = getAppManager()
  if (!manager || !activityStoreRef || !runtimeService) throw new Error('App services are not initialized')
  return { manager, store: activityStoreRef, runtime: runtimeService }
}

export function getStudioSummary(language?: string) {
  const manager = getAppManager()
  if (!manager) throw new Error('App manager is not initialized')
  // Must exclude exactly what the directory listing excludes, or the summary
  // counts disagree with the rows underneath them.
  const ephemeral = getTeamStore()?.listDirectoryMemberships()
    .filter(member => member.ephemeral)
    .map(member => member.appId) ?? []
  return manager.getStudioSummary(language, ephemeral)
}

export function listPeopleDirectory(query: import('../../../shared/apps/people-directory').PeopleDirectoryQuery = {}) {
  const deps = spaceChangeDependencies()
  return buildPeopleDirectory(deps.manager, deps.store, deps.runtime, getTeamStore()?.listDirectoryMemberships() ?? [], query)
}

export function getAppCapabilityInventory() {
  const manager = getAppManager()
  if (!manager || !activityStoreRef) throw new Error('App services are not initialized')
  return buildAppCapabilityInventory(manager, activityStoreRef)
}

export function getAppSpaceChangePreview(appId: string, newSpaceId: string) {
  return previewAppSpaceChange(spaceChangeDependencies(), appId, newSpaceId)
}

export async function moveAppDefaultSpace(appId: string, newSpaceId: string): Promise<void> {
  await changeAppDefaultSpace(spaceChangeDependencies(), appId, newSpaceId)
}

export function readAppRunMessages(appId: string, runId: string) {
  const run = activityStoreRef?.getRun(runId)
  if (!run || run.appId !== appId) throw new Error('Execution is unavailable for this digital human')
  if (run.transcriptClearedAt) throw new RunProcessClearedError(runId)
  const spacePath = run.environment?.spacePath
  if (!spacePath) throw new Error('The original execution environment is unavailable')
  return readSessionMessages(spacePath, appId, runId)
}

/**
 * Get the ImChannelManager instance for external use
 * (e.g., status queries, reconnect, config reload from IPC/HTTP).
 */
export function getImChannelManager(): ImChannelManager | null {
  return imChannelManagerInstance
}

/**
 * Get the EventRouter instance created during init.
 * Used by the team trigger scheduler to route 'webhook' | 'file' | 'wecom'
 * team triggers through the same multi-subscriber path the app runtime uses.
 * Returns null if the App Runtime is not yet initialized.
 */
export function getEventRouter(): EventRouter | null {
  return eventRouterInstance
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

  disposeSessionBudget()

  if (runtimeService) {
    await runtimeService.deactivateAll()
    runtimeService = null
    memoryServiceRef = null
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
  stopReleasingSupplements?.()
  stopReleasingSupplements = null

  imSessionRegistryInstance = null
  activityStoreRef = null
  setImSessionRegistry(null as any)

  // Flush synchronously: a relay recorded seconds before exit must survive,
  // since its target may not send another message for weeks.
  getPendingRelayStore()?.flush()
  setPendingRelayStore(null)
  setConversationReminders(null)

  // Clear all IM permission contexts (in-memory only, no persistence needed)
  clearAllImPermissionContexts()

  // Drop any in-flight IM stream handles so a post-shutdown stopImSession
  // call cannot reach a disposed WecomStreamSession.
  clearAllImStreamHandles()

  // Close every digital-human chat's browser pages (resident ones outlive turns).
  destroyAllChatBrowserContexts('shutdown')

  console.log('[Runtime] App Runtime shutdown complete')
}
