/**
 * App Management IPC Handlers
 *
 * Exposes the AppManager and AppRuntime services to the renderer process.
 * All handlers lazily resolve the singleton instances at call time, so they
 * can be registered before the async platform init completes.
 *
 * Channels:
 *   app:install            Install an App into a space
 *   app:uninstall          Uninstall an App (soft-delete)
 *   app:reinstall          Reinstall a previously uninstalled App
 *   app:delete             Permanently delete an uninstalled App
 *   app:list               List all installed Apps (optionally filtered)
 *   app:get                Get a single installed App by ID
 *   app:pause              Pause an active App
 *   app:resume             Resume a paused App
 *   app:trigger            Manually trigger a run
 *   app:get-state          Get real-time automation state
 *   app:get-activity       Get activity log entries for an App
 *   app:get-runs           Get run history for an App, with each run's last activity summary
 *   app:get-run-stats      Get aggregate outcome/token/duration stats over an App's recent runs
 *   app:get-overview       Batched card-wall first paint: state + latest summary + recent runs per App
 *   app:respond-escalation Respond to a pending user escalation
 *   app:update-config      Update App user configuration
 *   app:update-frequency   Update subscription frequency override
 *   app:update-spec        Update App spec (JSON Merge Patch)
 *   app:chat-send          Send a chat message to an App's AI agent
 *   app:chat-stop          Stop an active app chat generation
 *   app:chat-status        Get app chat status (generating + conversationId)
 *   app:chat-messages      Load persisted chat messages for an app
 *   app:chat-session-state Get session state for recovery after refresh
 *   app:chat-restart       Restart an app's chat agent (reload prompt/config)
 *   app:im-chat-messages   Load persisted IM session chat messages
 *   app:im-chat-clear      Clear an IM session's chat history (wipes history)
 *   app:im-chat-stop       Stop an IM session's active generation (keeps history)
 *   app:export-spec        Export an app's spec as a YAML string
 *   app:import-spec        Install an app from a YAML spec string
 *   app:open-skill-folder  Reveal a skill's on-disk directory in the OS file manager
 *   app:get-data-path      Get an app's data/memory directory path
 *   app:open-data-folder   Reveal an automation app's data/memory directory in the OS file manager
 */

import { shell } from 'electron'
import { existsSync } from 'fs'
import { getAppManager } from '../apps/manager'
import { AppAlreadyInstalledError, McpCommandBlockedError } from '../apps/manager/errors'
import { MCP_COMMAND_BLOCKED_MESSAGE } from '../services/security-policy'
import { getSkillDir } from '../apps/manager/skill-sync'
import { deriveSkillCommandName } from '../apps/spec/skill-identity'
import { listAvailableSkills } from '../apps/skill-discovery'
import {
  getAppRuntime,
  getAppSpaceChangePreview,
  getAppCapabilityInventory,
  listPeopleDirectory,
  getStudioSummary,
  moveAppDefaultSpace,
  readAppRunMessages,
  sendAppChatMessage,
  stopAppChat,
  stopAppChatConversation,
  isAppChatGenerating,
  isAppChatConversationGenerating,
  loadAppChatMessages,
  loadImChatMessages,
  loadChatMessagesForConversation,
  getAppChatSessionState,
  getAppChatConversationId,
  clearAppChat,
  clearImSession,
  stopImSession,
  restartAppChat,
  createNativeChatSession,
  forkNativeChatSession,
  deleteNativeChatSession,
} from '../apps/runtime'
import type { AppSpec } from '../apps/spec'
import type { AppListFilter, UninstallOptions, UpgradeStrategy } from '../apps/manager'
import type { ActivityQueryOptions, RunQueryOptions, EscalationResponse, AppChatRequest } from '../apps/runtime'
import { getSpace } from '../services/space.service'
import { broadcastToAll } from '../http/websocket'
import * as appController from '../controllers/app.controller'
import { analytics } from '../services/analytics/analytics.service'
import { appRpc } from '../../shared/rpc/contracts/app.contract'
import { registerRawRpcHandlers } from './rpc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the AppManager singleton or return an error response.
 * The manager initializes asynchronously; callers should handle not-ready state.
 */
function requireManager() {
  const manager = getAppManager()
  if (!manager) {
    return { success: false as const, error: 'App Manager is not yet initialized. Please try again shortly.' }
  }
  return { success: true as const, manager }
}

/**
 * Resolve the AppRuntime singleton or return an error response.
 */
function requireRuntime() {
  const runtime = getAppRuntime()
  if (!runtime) {
    return { success: false as const, error: 'App Runtime is not yet initialized. Please try again shortly.' }
  }
  return { success: true as const, runtime }
}

// ---------------------------------------------------------------------------
// Handler Registration
// ---------------------------------------------------------------------------

async function appOperation(name: string, operation: () => unknown | Promise<unknown>) {
  try {
    return await operation()
  } catch (error) {
    console.error(`[AppIPC] ${name} failed:`, error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerAppHandlers(): void {
  registerRawRpcHandlers(appRpc, {
    appStartRun: (appId: string) => appOperation('start-run', async () => {
      const r = requireRuntime()
      return r.success ? { success: true, data: await r.runtime.startManually(appId) } : r
    }),
    appGetStudioSummary: (language?: string) => appOperation('studio-summary', () => ({ success: true, data: getStudioSummary(language) })),
    appListPeople: (query?: import('../../shared/apps/people-directory').PeopleDirectoryQuery) => appOperation('list-people', () => ({ success: true, data: listPeopleDirectory(query) })),
    appGetAllStates: () => appOperation('get-all-states', () => {
      const r = requireRuntime()
      return r.success ? { success: true, data: r.runtime.getAllAppStates() } : r
    }),
    appGetPendingInbox: (options?: import('../../shared/apps/app-types').PendingDecisionQuery) => appOperation('get-pending-inbox', () => {
      const r = requireRuntime()
      return r.success ? { success: true, data: r.runtime.getPendingInbox(options) } : r
    }),
    appGetActivityEntry: (input: { appId: string; entryId: string }) => appOperation('get-activity-entry', () => {
      const r = requireRuntime()
      return r.success ? { success: true, data: r.runtime.getActivityEntry(input.appId, input.entryId) } : r
    }),
    appGetPendingEntries: (input: { appId: string; options?: import('../../shared/apps/app-types').PendingDecisionQuery }) => appOperation('get-pending-entries', () => {
      const r = requireRuntime()
      return r.success ? { success: true, data: r.runtime.getPendingEntries(input.appId, input.options) } : r
    }),
    appGetCapabilityInventory: () => appOperation('get-capability-inventory', () => {
      const r = requireManager()
      return r.success ? { success: true, data: getAppCapabilityInventory() } : r
    }),
    appPreviewSpaceChange: (input: { appId: string; newSpaceId: string }) => appOperation('preview-space-change', () => ({
      success: true, data: getAppSpaceChangePreview(input.appId, input.newSpaceId),
    })),
    appRetryEscalationContinuation: (input: { appId: string; entryId: string }) => appOperation('retry-escalation-continuation', async () => {
      const r = requireRuntime()
      if (!r.success) return r
      await r.runtime.retryEscalationContinuation(input.appId, input.entryId)
      return { success: true }
    }),
    appConfirmEscalationDeadline: (input: { appId: string; entryId: string; deadlineAt: number | null }) => appOperation('confirm-escalation-deadline', async () => {
      const r = requireRuntime()
      if (!r.success) return r
      await r.runtime.confirmEscalationDeadline(input.appId, input.entryId, input.deadlineAt)
      return { success: true }
    }),
    appCloseRun: (input: { appId: string; runId: string }) => appOperation('close-run', async () => {
      const r = requireRuntime()
      if (!r.success) return r
      await r.runtime.closeRun(input.appId, input.runId)
      return { success: true }
    }),
    appStopRun: (input: { appId: string; runId: string }) => appOperation('stop-run', async () => {
      const r = requireRuntime()
      if (!r.success) return r
      await r.runtime.stopRun(input.appId, input.runId)
      return { success: true }
    }),
    // ── app:install ──────────────────────────────────────────────────────────
    appInstall: async (input: { spaceId: string | null; spec: AppSpec; userConfig?: Record<string, unknown> }) => {
      // Shared install + activate orchestration lives in the controller.
      const result = await appController.installApp(input.spaceId, input.spec, input.userConfig)
      if (result.success) {
        console.log(`[AppIPC] app:install: appId=${result.data.appId}, space=${input.spaceId}`)
      } else {
        console.error('[AppIPC] app:install error:', result.error)
        analytics.trackErrorSurface('app-install', new Error(result.error))
      }
      return result
    },

    // ── app:uninstall ────────────────────────────────────────────────────────
    appUninstall: async (input: { appId: string; options?: UninstallOptions }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        // Deactivate in runtime first (removes scheduler jobs + event subs)
        const runtime = getAppRuntime()
        if (runtime) {
          await runtime.deactivate(input.appId).catch(err => {
            console.warn(`[AppIPC] app:uninstall -- runtime deactivate failed (non-fatal): ${err}`)
          })
        }

        await r.manager.uninstall(input.appId, input.options)
        console.log(`[AppIPC] app:uninstall: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:uninstall error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:reinstall ──────────────────────────────────────────────────────
    appReinstall: async (input: { appId: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        r.manager.reinstall(input.appId)

        // Re-activate in runtime
        const runtime = getAppRuntime()
        let activationWarning: string | undefined
        if (runtime) {
          try {
            await runtime.activate(input.appId)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.warn(`[AppIPC] app:reinstall -- runtime activate failed: ${errMsg}`)
            activationWarning = errMsg
          }
        }

        console.log(`[AppIPC] app:reinstall: appId=${input.appId}`)
        return { success: true, data: { activationWarning } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:reinstall error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:delete ─────────────────────────────────────────────────────────
    // NOTE: external callers (renderer, HTTP) must NOT be able to bypass the
    // built-in protection guard. We deliberately do NOT forward any options
    // from the input — `deleteApp` is invoked with no second argument, so
    // `BuiltinAppProtectedError` will fire as designed for built-in apps.
    appDelete: async (input: { appId: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        await r.manager.deleteApp(input.appId)
        broadcastToAll('app:deleted', { appId: input.appId })
        console.log(`[AppIPC] app:delete: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:delete error:', err.message)
        // Preserve `errorName` (e.g. "BuiltinAppProtectedError") so the
        // renderer can route the error by discriminator instead of parsing
        // the message string. Lets the UI provide a localized prompt for
        // protected built-ins ("This app is bundled with Halo and can't be
        // permanently deleted; uninstall to disable instead.") rather than
        // surfacing the raw English error text.
        return { success: false, error: err.message, errorName: err.name }
      }
    },

    // ── app:list ─────────────────────────────────────────────────────────────
    appList: async (filter?: AppListFilter) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        const apps = r.manager.listApps(filter)
        return { success: true, data: apps }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:list error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get ──────────────────────────────────────────────────────────────
    appGet: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        const app = r.manager.getApp(appId)
        return { success: true, data: app }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:pause ────────────────────────────────────────────────────────────
    appPause: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.pause(appId)

        // Deactivate in runtime (stops scheduler + event subscriptions)
        const runtime = getAppRuntime()
        if (runtime) {
          await runtime.deactivate(appId).catch(err => {
            console.warn(`[AppIPC] app:pause -- runtime deactivate failed (non-fatal): ${err}`)
          })
        }

        console.log(`[AppIPC] app:pause: appId=${appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:pause error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:resume ───────────────────────────────────────────────────────────
    appResume: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.resume(appId)

        // Re-activate in runtime
        const runtime = getAppRuntime()
        let activationWarning: string | undefined
        if (runtime) {
          try {
            await runtime.activate(appId)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.warn(`[AppIPC] app:resume -- runtime activate failed: ${errMsg}`)
            activationWarning = errMsg
          }
        }

        console.log(`[AppIPC] app:resume: appId=${appId}`)
        return { success: true, data: { activationWarning } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:resume error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:trigger ──────────────────────────────────────────────────────────
    appTrigger: async (appId: string) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const result = await r.runtime.triggerManually(appId)
        console.log(`[AppIPC] app:trigger: appId=${appId}, outcome=${result.outcome}`)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:trigger error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get-state ────────────────────────────────────────────────────────
    appGetState: async (appId: string) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const state = r.runtime.getAppState(appId)
        return { success: true, data: state }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-state error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get-activity ─────────────────────────────────────────────────────
    appGetActivity: async (input: { appId: string; options?: ActivityQueryOptions }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const entries = r.runtime.getActivityEntries(input.appId, input.options)
        return { success: true, data: entries }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-activity error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get-runs ─────────────────────────────────────────────────────────
    appGetRuns: async (input: { appId: string; options?: RunQueryOptions }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const runs = r.runtime.getRunsForAppWithSummary(input.appId, input.options)
        return { success: true, data: runs }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-runs error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get-run-stats ────────────────────────────────────────────────────
    appGetRunStats: async (input: { appId: string; window?: number }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const stats = r.runtime.getRunStats(input.appId, input.window)
        return { success: true, data: stats }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-run-stats error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get-overview ─────────────────────────────────────────────────────
    appGetOverview: async (input?: { spaceId?: string }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const overview = r.runtime.getOverview(input?.spaceId)
        return { success: true, data: overview }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-overview error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:respond-escalation ───────────────────────────────────────────────
    appRespondEscalation: async (input: { appId: string; escalationId: string; response: EscalationResponse }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        const entry = await r.runtime.respondToEscalation(input.appId, input.escalationId, input.response)
        console.log(`[AppIPC] app:respond-escalation: appId=${input.appId}, escalationId=${input.escalationId}`)
        return { success: true, data: entry }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:respond-escalation error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:continue-run ─────────────────────────────────────────────────────
    appContinueRun: async (input: { appId: string; runId: string }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        await r.runtime.continueFailedRun(input.appId, input.runId)
        console.log(`[AppIPC] app:continue-run: appId=${input.appId}, runId=${input.runId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:continue-run error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:inject-run ───────────────────────────────────────────────────────
    appInjectRun: async (input: { appId: string; runId: string; text: string }) => {
      try {
        const r = requireRuntime()
        if (!r.success) return r
        await r.runtime.injectIntoRun(input.appId, input.runId, input.text)
        console.log(`[AppIPC] app:inject-run: appId=${input.appId}, runId=${input.runId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:inject-run error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:update-config ────────────────────────────────────────────────────
    appUpdateConfig: async (input: { appId: string; config: Record<string, unknown> }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateConfig(input.appId, input.config)
        console.log(`[AppIPC] app:update-config: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:update-config error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:update-frequency ─────────────────────────────────────────────────
    appUpdateFrequency: async (input: { appId: string; subscriptionId: string; frequency: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateFrequency(input.appId, input.subscriptionId, input.frequency)
        console.log(`[AppIPC] app:update-frequency: appId=${input.appId}, sub=${input.subscriptionId}`)

        // Hot-sync scheduler job so the new frequency takes effect immediately
        // without interrupting any running execution
        const runtime = getAppRuntime()
        if (runtime) {
          runtime.syncAppSubscriptions(input.appId)
        }

        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:update-frequency error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:update-overrides ────────────────────────────────────────────────
    appUpdateOverrides: async (input: { appId: string; overrides: Record<string, unknown> }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateOverrides(input.appId, input.overrides)
        console.log(`[AppIPC] app:update-overrides: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:update-overrides error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:update-spec ──────────────────────────────────────────────────────
    appUpdateSpec: async (input: { appId: string; specPatch: Record<string, unknown> }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.updateSpec(input.appId, input.specPatch)

        // Hot-sync subscriptions if subscriptions changed.
        // Uses syncAppSubscriptions() instead of deactivate/activate to avoid
        // aborting any currently running execution for this app.
        if (input.specPatch.subscriptions) {
          const runtime = getAppRuntime()
          if (runtime) {
            runtime.syncAppSubscriptions(input.appId)
          }
        }

        console.log(`[AppIPC] app:update-spec: appId=${input.appId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        if (error instanceof McpCommandBlockedError) {
          console.warn(`[AppIPC] app:update-spec blocked by policy: command='${error.command}' appId=${input.appId}`)
          return { success: false, error: MCP_COMMAND_BLOCKED_MESSAGE, code: 'MCP_COMMAND_BLOCKED' }
        }
        console.error('[AppIPC] app:update-spec error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:grant-permission ──────────────────────────────────────────────────
    appGrantPermission: async (input: { appId: string; permission: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.grantPermission(input.appId, input.permission)
        console.log(`[AppIPC] app:grant-permission: appId=${input.appId}, permission=${input.permission}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:grant-permission error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:set-upgrade-strategy ────────────────────────────────────────────
    appSetUpgradeStrategy: async (input: { appId: string; strategy: UpgradeStrategy }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.setUpgradeStrategy(input.appId, input.strategy)
        console.log(`[AppIPC] app:set-upgrade-strategy: appId=${input.appId}, strategy=${input.strategy}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:set-upgrade-strategy error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:revoke-permission ─────────────────────────────────────────────────
    appRevokePermission: async (input: { appId: string; permission: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        r.manager.revokePermission(input.appId, input.permission)
        console.log(`[AppIPC] app:revoke-permission: appId=${input.appId}, permission=${input.permission}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:revoke-permission error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get-session ──────────────────────────────────────────────────────
    appGetSession: async (input: { appId: string; runId: string }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(input.appId)
        if (!app) {
          return { success: false, error: `App not found: ${input.appId}` }
        }

        const messages = readAppRunMessages(input.appId, input.runId)
        return { success: true, data: messages }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-session error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:chat-send ─────────────────────────────────────────────────────
    appChatSend: async (request: AppChatRequest) => {
      try {
        // Fire-and-forget: streaming events are pushed to renderer via agent:* channels.
        // We don't await the full completion here because the renderer listens for
        // real-time events (agent:message, agent:thought, etc.) keyed by conversationId.
        sendAppChatMessage(request).catch((error: unknown) => {
          const err = error as Error
          console.error(`[AppIPC] app:chat-send background error:`, err.message)
        })
        // Echo back the session actually addressed: the caller's explicit
        // conversationId (native local / IM / HTTP session) or the app's
        // native default when none was supplied.
        const conversationId = request.conversationId ?? getAppChatConversationId(request.appId)
        console.log(`[AppIPC] app:chat-send: appId=${request.appId} conversationId=${conversationId}`)
        return {
          success: true,
          data: { conversationId }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-send error:', err.message)
        analytics.trackErrorSurface('app-chat-send', err)
        return { success: false, error: err.message }
      }
    },

    // ── app:chat-stop ──────────────────────────────────────────────────────
    // Optional conversationId stops just that session (so sibling sessions keep
    // generating); absent, it stops all of the app's chat sessions.
    appChatStop: async (appId: string, conversationId?: string) => {
      try {
        if (conversationId) {
          await stopAppChatConversation(conversationId)
        } else {
          await stopAppChat(appId)
        }
        console.log(`[AppIPC] app:chat-stop: appId=${appId} conversationId=${conversationId ?? '(all)'}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-stop error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:chat-status ────────────────────────────────────────────────────
    // Optional conversationId narrows the check to one native/local/IM session;
    // absent, it reports whether ANY session for the app is generating.
    appChatStatus: async (appId: string, conversationId?: string) => {
      try {
        const isGenerating = conversationId
          ? isAppChatConversationGenerating(conversationId)
          : isAppChatGenerating(appId)
        return {
          success: true,
          data: {
            isGenerating,
            conversationId: conversationId ?? getAppChatConversationId(appId),
          }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-status error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:chat-messages ──────────────────────────────────────────────────
    // Optional conversationId loads a specific native/local session's history;
    // absent, it loads the app's native default session.
    appChatMessages: async (input: { appId: string; spaceId: string; conversationId?: string }) => {
      try {
        const space = getSpace(input.spaceId)
        if (!space?.path) {
          return { success: true, data: [] }
        }
        const messages = input.conversationId
          ? loadChatMessagesForConversation(space.path, input.appId, input.conversationId)
          : loadAppChatMessages(space.path, input.appId)
        return { success: true, data: messages }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-messages error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:chat-session-state ─────────────────────────────────────────────
    appChatSessionState: async (appId: string, conversationId?: string) => {
      try {
        const state = getAppChatSessionState(appId, conversationId)
        return { success: true, data: state }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-session-state error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:chat-clear ────────────────────────────────────────────────────
    // Optional conversationId clears a specific native/local session; absent,
    // it clears the app's native default session.
    appChatClear: async (input: { appId: string; spaceId: string; conversationId?: string }) => {
      try {
        await clearAppChat(input.appId, input.spaceId, input.conversationId)
        console.log(`[AppIPC] app:chat-clear: appId=${input.appId} conversationId=${input.conversationId ?? '(default)'}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-clear error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:chat-restart ─────────────────────────────────────────────────
    // Closes all Claude Code subprocesses for an app's chat sessions (native
    // + every IM channel session) so the next message loads the latest system
    // prompt and config. Conversation history is preserved via saved sessionId.
    appChatRestart: async (appId: string) => {
      try {
        // Manual restart: the user clicked "Restart agent" (its banner warns work
        // in progress is stopped), so interrupt any in-flight turn.
        const result = await restartAppChat(appId, { interruptActive: true })
        console.log(`[AppIPC] app:chat-restart: appId=${appId}, closed=${result.sessionsClosed}`)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:chat-restart error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:im-chat-messages ────────────────────────────────────────────
    appImChatMessages: async (input: { appId: string; spaceId: string; channel: string; chatType: 'direct' | 'group'; chatId: string }) => {
      try {
        const space = getSpace(input.spaceId)
        if (!space?.path) {
          console.warn('[AppIPC] IM history unavailable: missing space', { appId: input.appId, spaceId: input.spaceId })
          return { success: false, error: 'The conversation storage is unavailable.' }
        }
        const messages = loadImChatMessages(space.path, input.appId, input.channel, input.chatType, input.chatId)
        return { success: true, data: messages }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:im-chat-messages error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:im-chat-clear ────────────────────────────────────────────────
    appImChatClear: async (input: { appId: string; spaceId: string; channel: string; chatType: 'direct' | 'group'; chatId: string }) => {
      try {
        await clearImSession(input.appId, input.spaceId, input.channel, input.chatType, input.chatId)
        console.log(`[AppIPC] app:im-chat-clear: appId=${input.appId} channel=${input.channel} chatId=${input.chatId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:im-chat-clear error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:im-chat-stop ────────────────────────────────────────────────
    // Aborts the current generation for a single IM session while preserving
    // V2 session and JSONL history. Contrast with appImChatClear which wipes
    // history and tears down the V2 session.
    appImChatStop: async (input: { appId: string; channel: string; chatType: 'direct' | 'group'; chatId: string }) => {
      try {
        const result = await stopImSession(input.appId, input.channel, input.chatType, input.chatId)
        console.log(
          `[AppIPC] app:im-chat-stop: appId=${input.appId} channel=${input.channel} ` +
          `chatId=${input.chatId} stopped=${result.stopped}`
        )
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:im-chat-stop error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:session-create ───────────────────────────────────────────────
    // Create a fresh native client-side chat session for a digital human.
    appSessionCreate: async (input: { appId: string }) => {
      try {
        const result = createNativeChatSession(input.appId)
        console.log(`[AppIPC] app:session-create: appId=${input.appId} conversationId=${result.conversationId}`)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:session-create error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:session-fork ─────────────────────────────────────────────────
    // Fork an existing session (IM/http/local) into a new native local session
    // that continues in the client with full prior context. Callers gate this
    // on the engine's sessionFork capability.
    appSessionFork: async (input: { appId: string; spaceId: string; sourceConversationId: string }) => {
      try {
        const result = forkNativeChatSession(input.appId, input.spaceId, input.sourceConversationId)
        console.log(`[AppIPC] app:session-fork: appId=${input.appId} from=${input.sourceConversationId} to=${result.conversationId}`)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:session-fork error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:session-delete ───────────────────────────────────────────────
    // Delete a native local session (only 'local'-source keys are accepted).
    appSessionDelete: async (input: { appId: string; spaceId: string; conversationId: string }) => {
      try {
        await deleteNativeChatSession(input.appId, input.spaceId, input.conversationId)
        console.log(`[AppIPC] app:session-delete: appId=${input.appId} conversationId=${input.conversationId}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:session-delete error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:export-spec ────────────────────────────────────────────────────
    appExportSpec: async (appId: string) => {
      try {
        const result = appController.exportSpec(appId)
        if (result.success) {
          console.log(`[AppIPC] app:export-spec: appId=${appId}`)
        }
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:export-spec error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:import-spec ────────────────────────────────────────────────────
    appImportSpec: async (input: { spaceId: string | null; yamlContent: string; userConfig?: Record<string, unknown> }) => {
      try {
        const result = await appController.importSpec(input)
        if (result.success) {
          console.log(`[AppIPC] app:import-spec: appId=${(result.data as any)?.appId}, space=${input.spaceId}`)
        }
        return result
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:import-spec error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:open-skill-folder ──────────────────────────────────────────────
    appOpenSkillFolder: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(appId)
        if (!app || app.spec.type !== 'skill') {
          return { success: false, error: 'Not a skill app' }
        }

        const skillDir = getSkillDir(app, (spaceId) => {
          const space = getSpace(spaceId)
          return space?.path ?? null
        })

        if (!skillDir) {
          return { success: false, error: 'Could not resolve skill directory' }
        }

        if (!existsSync(skillDir)) {
          return { success: false, error: 'Skill directory does not exist on filesystem' }
        }

        shell.showItemInFolder(skillDir)
        console.log(`[AppIPC] app:open-skill-folder: appId=${appId}, dir=${skillDir}`)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:open-skill-folder error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:derive-skill-command-name ──────────────────────────────────────
    // Lets the skill form preview the identifier install will actually assign,
    // without shipping the romanization dictionary to the renderer.
    appDeriveSkillCommandName: async (name: string) => {
      const trimmed = name?.trim()
      if (!trimmed) return { success: true, data: '' }
      return { success: true, data: deriveSkillCommandName(trimmed) }
    },

    // ── app:list-available-skills ──────────────────────────────────────────
    appListAvailableSkills: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(appId)
        if (!app || !app.spaceId) {
          return { success: false, error: 'App not found or has no space' }
        }

        const skills = listAvailableSkills(app.spaceId)
        return { success: true, data: skills }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:list-available-skills error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:list-available-skills-for-space ─────────────────────────────────
    // Same disk-scan as above, keyed directly by spaceId — for surfaces (the
    // space resource rail) that have a space, not a digital human, in hand.
    appListAvailableSkillsForSpace: async (spaceId: string) => {
      try {
        return { success: true, data: listAvailableSkills(spaceId) }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:list-available-skills-for-space error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:list-effective-mcp-apps ──────────────────────────────────────────
    // Space-scoped ∪ global MCP apps (space overrides global), for read-only
    // display in the space resource rail — not the "declared dependencies of
    // one digital human" list AppMcpDepsSection shows.
    appListEffectiveMcpApps: async (spaceId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r
        return { success: true, data: r.manager.listEffectiveMcpApps(spaceId) }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:list-effective-mcp-apps error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:get-data-path ──────────────────────────────────────────────────
    appGetDataPath: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(appId)
        if (!app) {
          return { success: false, error: 'App not found' }
        }

        const workDir = r.manager.getAppWorkDir(appId)
        return { success: true, data: { path: workDir } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:get-data-path error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:open-data-folder ────────────────────────────────────────────────
    appOpenDataFolder: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(appId)
        if (!app) {
          return { success: false, error: 'App not found' }
        }

        const workDir = r.manager.getAppWorkDir(appId)
        if (!existsSync(workDir)) {
          return { success: false, error: 'App data directory does not exist on filesystem' }
        }

        shell.openPath(workDir)
        console.log(`[AppIPC] app:open-data-folder: appId=${appId}, dir=${workDir}`)
        return { success: true, data: { path: workDir } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:open-data-folder error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:clear-memory ────────────────────────────────────────────────────
    appClearMemory: async (appId: string) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(appId)
        if (!app) {
          return { success: false, error: 'App not found' }
        }

        const filesRemoved = r.manager.clearAppMemory(appId)
        console.log(`[AppIPC] app:clear-memory: appId=${appId}, filesRemoved=${filesRemoved}`)
        return { success: true, data: { filesRemoved } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:clear-memory error:', err.message)
        return { success: false, error: err.message }
      }
    },

    // ── app:move-space ─────────────────────────────────────────────────────
    appMoveSpace: async (input: { appId: string; newSpaceId: string | null }) => {
      try {
        const r = requireManager()
        if (!r.success) return r

        const app = r.manager.getApp(input.appId)
        if (!app) {
          return { success: false, error: `App not found: ${input.appId}` }
        }

        if (app.spec.type === 'automation') {
          if (!input.newSpaceId) throw new Error('Digital humans require a work space')
          await moveAppDefaultSpace(input.appId, input.newSpaceId)
        } else {
          await r.manager.moveToSpace(input.appId, input.newSpaceId)
        }

        console.log(
          `[AppIPC] app:move-space: appId=${input.appId}, newSpaceId=${input.newSpaceId ?? 'global'}`
        )
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[AppIPC] app:move-space error:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[AppIPC] App management handlers registered (42 channels)')
}
