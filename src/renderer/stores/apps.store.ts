/**
 * Apps Store
 *
 * Manages all data for the Apps system:
 * - Installed app list
 * - Per-app real-time state (AutomationAppState)
 * - Per-app activity entries
 *
 * Real-time event handlers are called from App.tsx event listeners
 * (same pattern as agent events).
 */

import { create } from 'zustand'
import { mergeActivityEntries, isPendingDecision } from '../utils/people-model'
import { useMemo } from 'react'
import { api } from '../api'
import i18n from '../i18n'
import { useNotificationStore } from './notification.store'
import { BUILTIN_MCP_SERVER_IDS } from '../../shared/apps/builtin-mcp'
import type {
  InstalledApp,
  AppStatus,
  AutomationAppState,
  AppOverviewEntry,
  ActivityEntry,
  ActivityQueryOptions,
  EscalationAnswerPayload,
} from '../../shared/apps/app-types'
import type { AppSpec } from '../../shared/apps/spec-types'
import type { ScheduleValue, TaskItem, TaskItemStatus } from '../types'

// ============================================
// Typed error for App install/import failures
// ============================================

/**
 * Thrown by installApp / importApp when the backend returns a structured
 * failure. The `code` mirrors the backend's `AppErrorCode` (controller
 * level) — UI can dispatch on it to render localized messages without
 * regex-matching the error text.
 *
 * Known codes today:
 *  - 'ALREADY_INSTALLED'  — same-name app exists in the target scope
 *  - 'VALIDATION_FAILED'  — spec schema validation failed
 *  - 'INVALID_YAML'       — YAML parse error
 *  - 'NOT_INITIALIZED'    — manager not ready yet
 *
 * `code` is undefined for unknown / unexpected failures; UI should fall
 * back to displaying `.message`.
 */
export class AppApiError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'AppApiError'
    this.code = code
  }
}

// ============================================
// State Interface
// ============================================

interface AppsState {
  // ── Data ─────────────────────────────────
  apps: InstalledApp[]
  /** Real-time runtime state per app. Keyed by appId. */
  appStates: Record<string, AutomationAppState>
  /** Activity feed per app. Entries are newest-first. Keyed by appId. */
  activityEntries: Record<string, ActivityEntry[]>
  /** Tracks whether we've loaded more pages per app */
  activityHasMore: Record<string, boolean>
  pendingEntries: Record<string, ActivityEntry[]>
  pendingHasMore: Record<string, boolean>
  pendingCursor: Record<string, { ts: number; id: string }>
  activityCursor: Record<string, { ts: number; id: string }>
  activityErrors: Record<string, boolean>
  summariesError: boolean
  hasFullList: boolean
  /**
   * Card-wall batch data per automation app (latest output summary + recent
   * run statuses). Populated by `loadOverview`; `appStates` above stays the
   * single source for `AutomationAppState` itself (also filled by this call).
   */
  overview: Record<string, AppOverviewEntry>
  isLoading: boolean
  error: string | null

  /**
   * Derived: automation apps that belong in the task panel (running, queued,
   * waiting on the user, errored, or needing re-login). Pre-computed by the
   * fingerprint-gated subscriber below, not recalculated on every store
   * update — see chat.store's `_pulseItems` for the same pattern.
   */
  _automationTaskItems: TaskItem[]

  // ── App List Management ───────────────────
  loadApps: (spaceId?: string) => Promise<void>
  refreshApp: (appId: string) => Promise<void>

  /**
   * Cold-start loader for the task panel: loads every installed app plus
   * the runtime state of each automation app, so running/waiting/errored
   * digital humans are visible immediately after launch instead of only
   * after the user opens the Apps page (which is what previously triggered
   * `loadApps`/`loadAppState`). Also prefetches activity for apps awaiting
   * the user so their escalation question is available right away.
   * Fire-and-forget; call during extended startup, not the essential path.
   */
  loadAutomationTaskState: () => Promise<void>

  /**
   * Batched card-wall first paint: one `app:get-overview` call fills
   * `appStates` and `overview` for every automation app (optionally scoped to
   * one space), then prefetches activity for any app awaiting the user so its
   * escalation question is available without a second round trip.
   */
  loadOverview: (spaceId?: string) => Promise<void>

  // ── App Lifecycle ─────────────────────────
  installApp: (spaceId: string | null, spec: AppSpec, userConfig?: Record<string, unknown>) => Promise<string | null>
  uninstallApp: (appId: string) => Promise<boolean>
  reinstallApp: (appId: string) => Promise<boolean>
  deleteApp: (appId: string) => Promise<boolean>
  pauseApp: (appId: string) => Promise<boolean>
  resumeApp: (appId: string) => Promise<boolean>
  triggerApp: (appId: string) => Promise<boolean>

  // ── State Queries ─────────────────────────
  loadAppState: (appId: string) => Promise<void>
  loadAllStates: () => Promise<void>
  loadPending: (appId: string) => Promise<void>
  loadMorePending: (appId: string) => Promise<void>

  // ── Activity Feed ─────────────────────────
  loadActivity: (appId: string, options?: ActivityQueryOptions) => Promise<void>
  loadMoreActivity: (appId: string) => Promise<void>

  // ── Escalation ───────────────────────────
  respondToEscalation: (appId: string, escalationId: string, response: EscalationAnswerPayload) => Promise<boolean>

  // ── Continue ─────────────────────────────
  continueApp: (appId: string, runId: string) => Promise<boolean>

  // ── Agent Restart ────────────────────────
  /**
   * Restart an app's chat agent: closes its CC subprocesses so the next
   * message loads the latest system prompt and config. Conversation history
   * is preserved. Returns true on success.
   */
  restartAppAgent: (appId: string) => Promise<boolean>

  // ── Config Updates ────────────────────────
  updateAppConfig: (appId: string, config: Record<string, unknown>) => Promise<boolean>
  updateAppOverrides: (appId: string, overrides: Record<string, unknown>) => Promise<boolean>
  updateAppSpec: (appId: string, specPatch: Record<string, unknown>) => Promise<boolean>

  // ── Space Management ────────────────────
  /**
   * Move an app to a different space (or to/from global scope).
   * Returns true on success. Updates spaceId optimistically, then refreshes.
   */
  moveAppToSpace: (appId: string, newSpaceId: string | null) => Promise<boolean>

  // ── Import / Export ─────────────────────────
  exportApp: (appId: string) => Promise<boolean>
  importApp: (spaceId: string, yamlContent: string) => Promise<string | null>

  // ── Permissions ─────────────────────────────
  grantPermission: (appId: string, permission: string) => Promise<boolean>
  revokePermission: (appId: string, permission: string) => Promise<boolean>

  // ── Real-time Event Handlers ──────────────
  /** Called by App.tsx when app:status_changed arrives */
  handleStatusChanged: (appId: string, state: AutomationAppState) => void
  /** Called by App.tsx when app:list_changed arrives */
  handleListChanged: () => void
  /** Called by App.tsx when app:activity_entry:new arrives */
  handleNewActivityEntry: (appId: string, entry: ActivityEntry) => void
  /** Called by App.tsx when app:escalation:new arrives */
  handleNewEscalation: (appId: string, entryId: string, question: string, choices: string[]) => void
}

// ============================================
// Store Implementation
// ============================================

const PAGE_SIZE = 30
let activityRevision = 0
const activityEvents = new Map<string, { revision: number; entry: ActivityEntry }>()
function eventsAfter(appId: string, revision: number): ActivityEntry[] {
  return [...activityEvents.values()].filter(event => event.revision > revision && event.entry.appId === appId).map(event => event.entry)
}

/**
 * One user action can install several Apps (an App plus its bundled skills, an
 * office provisioning its lead), so the events arrive in a burst. Collapse them
 * into a single refetch.
 */
const LIST_RELOAD_DELAY_MS = 200
let listReloadTimer: ReturnType<typeof setTimeout> | null = null

export const useAppsStore = create<AppsState>((set, get) => ({
  apps: [],
  appStates: {},
  activityEntries: {},
  activityHasMore: {},
  pendingEntries: {},
  pendingHasMore: {},
  pendingCursor: {},
  activityCursor: {},
  activityErrors: {},
  summariesError: false,
  hasFullList: false,
  overview: {},
  isLoading: false,
  error: null,
  _automationTaskItems: [],

  // ── App List Management ───────────────────

  loadApps: async (spaceId) => {
    set({ isLoading: true, error: null })
    try {
      const res = await api.appList(spaceId ? { spaceId } : undefined)
      if (res.success && res.data) {
        set({ hasFullList: !spaceId, apps: res.data as InstalledApp[] })
      } else {
        set({ error: (res.error as string) || 'Failed to load apps' })
      }
    } catch (err) {
      set({ error: 'Failed to load apps' })
      console.error('[AppsStore] loadApps error:', err)
    } finally {
      set({ isLoading: false })
    }
  },

  refreshApp: async (appId) => {
    try {
      const res = await api.appGet(appId)
      if (res.success && res.data) {
        const updated = res.data as InstalledApp
        set(state => ({
          apps: state.apps.some(a => a.id === appId) ? state.apps.map(a => a.id === appId ? updated : a) : [...state.apps, updated],
        }))
      } else console.warn('[AppsStore] Person detail unavailable', { appId, error: res.error })
    } catch (err) {
      console.error('[AppsStore] refreshApp error:', err)
    }
  },

  loadAutomationTaskState: async () => {
    // `enterApp()` fires as soon as bootstrap:extended-ready arrives, which
    // is sent synchronously and does not wait for initPlatformAndApps() (the
    // async chain that brings up the App Manager) to finish — so the first
    // loadApps() call here routinely loses this race and comes back with the
    // NOT_INITIALIZED error, apps left empty. Retry with backoff instead of
    // giving up after one attempt, which would silently defeat the whole
    // point of this cold-start loader.
    for (let attempt = 0; attempt < 5; attempt++) {
      await get().loadApps()
      if (!get().error) break
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }

    await get().loadOverview()
  },

  // ── App Lifecycle ─────────────────────────

  installApp: async (spaceId, spec, userConfig) => {
    const res = await api.appInstall({ spaceId, spec, userConfig })
    if (res.success && (res.data as { appId?: string })?.appId) {
      const appId = (res.data as { appId: string }).appId
      // Reload to get the full InstalledApp record
      await get().loadApps()
      return appId
    }
    throw new AppApiError(res.error || 'Installation failed', res.code)
  },

  uninstallApp: async (appId) => {
    try {
      const res = await api.appUninstall(appId)
      if (res.success) {
        // Optimistic: set status to 'uninstalled' and record timestamp
        set(state => ({
          apps: state.apps.map(a =>
            a.id === appId
              ? { ...a, status: 'uninstalled' as AppStatus, uninstalledAt: Date.now() }
              : a
          ),
        }))
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] uninstallApp error:', err)
      return false
    }
  },

  reinstallApp: async (appId) => {
    try {
      const res = await api.appReinstall(appId)
      if (res.success) {
        // Optimistic: set status back to 'active' and clear uninstalledAt
        set(state => ({
          apps: state.apps.map(a =>
            a.id === appId
              ? { ...a, status: 'active' as AppStatus, uninstalledAt: undefined }
              : a
          ),
        }))
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] reinstallApp error:', err)
      return false
    }
  },

  deleteApp: async (appId) => {
    try {
      const res = await api.appDelete(appId)
      if (res.success) {
        // Remove from local list (permanent delete)
        set(state => ({ apps: state.apps.filter(a => a.id !== appId) }))
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] deleteApp error:', err)
      return false
    }
  },

  pauseApp: async (appId) => {
    try {
      const res = await api.appPause(appId)
      if (res.success) {
        // Optimistic update
        set(state => ({
          apps: state.apps.map(a =>
            a.id === appId ? { ...a, status: 'paused' as AppStatus } : a
          ),
        }))
        await get().loadAppState(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] pauseApp error:', err)
      return false
    }
  },

  resumeApp: async (appId) => {
    try {
      const res = await api.appResume(appId)
      if (res.success) {
        // Optimistic update
        set(state => ({
          apps: state.apps.map(a =>
            a.id === appId ? { ...a, status: 'active' as AppStatus } : a
          ),
        }))
        await get().loadAppState(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] resumeApp error:', err)
      return false
    }
  },

  triggerApp: async (appId) => {
    try {
      const res = await api.appStartRun(appId)
      if (!res.success && res.error) {
        // Surface backend rejections (e.g. per-app concurrency limit) as a toast
        // so the user sees clear feedback rather than a silent no-op.
        useNotificationStore.getState().show({
          title: res.error,
          variant: 'warning',
          duration: 4000,
        })
      }
      if (res.success) await get().loadAppState(appId)
      return res.success
    } catch (err) {
      console.error('[AppsStore] triggerApp error:', err)
      return false
    }
  },

  // ── State Queries ─────────────────────────

  loadAppState: async (appId) => {
    try {
      const res = await api.appGetState(appId)
      if (res.success && res.data) {
        set(state => ({
          appStates: { ...state.appStates, [appId]: res.data as AutomationAppState },
        }))
      }
    } catch (err) {
      console.error('[AppsStore] loadAppState error:', err)
    }
  },

  loadAllStates: async () => {
    try {
      const result = await api.appGetAllStates()
      if (!result.success) throw new Error(result.error ?? 'State query rejected')
      set({ appStates: result.data as Record<string, AutomationAppState>, summariesError: false })
    } catch (error) { set({ summariesError: true }); console.warn('[AppsStore] Directory execution summaries unavailable', { error }) }
  },

  loadPending: async (appId) => {
    const revision = activityRevision
    try {
      const result = await api.appGetPendingEntries(appId, { limit: 100 })
      if (!result.success) throw new Error(result.error ?? 'Pending requests query rejected')
      const page = result.data as ActivityEntry[]
      const last = page[page.length - 1]
      set(state => ({
        pendingEntries: { ...state.pendingEntries, [appId]: mergeActivityEntries(page, eventsAfter(appId, revision)).filter(isPendingDecision).reverse() },
        pendingHasMore: { ...state.pendingHasMore, [appId]: page.length === 100 },
        pendingCursor: last ? { ...state.pendingCursor, [appId]: { ts: last.ts, id: last.id } } : state.pendingCursor,
      }))
    } catch (error) {
      console.warn('[AppsStore] Pending requests unavailable', { appId, error })
      set(state => ({ activityErrors: { ...state.activityErrors, [appId]: true } }))
    }
  },

  loadMorePending: async (appId) => {
    const cursor = get().pendingCursor[appId]
    if (!cursor || !get().pendingHasMore[appId]) return
    const revision = activityRevision
    try {
      const result = await api.appGetPendingEntries(appId, { limit: 100, afterTs: cursor.ts, afterId: cursor.id })
      if (!result.success) throw new Error(result.error ?? 'Pending page rejected')
      const page = result.data as ActivityEntry[]
      const last = page[page.length - 1]
      set(state => ({
        pendingEntries: { ...state.pendingEntries, [appId]: mergeActivityEntries(state.pendingEntries[appId] ?? [], [...page, ...eventsAfter(appId, revision)]).filter(isPendingDecision).reverse() },
        pendingHasMore: { ...state.pendingHasMore, [appId]: page.length === 100 },
        pendingCursor: last ? { ...state.pendingCursor, [appId]: { ts: last.ts, id: last.id } } : state.pendingCursor,
      }))
    } catch (error) {
      console.warn('[AppsStore] Pending request page unavailable', { appId, error })
      set(state => ({ activityErrors: { ...state.activityErrors, [appId]: true } }))
    }
  },

  loadOverview: async (spaceId) => {
    try {
      const res = await api.appGetOverview(spaceId)
      if (!res.success || !res.data) return
      const entries = res.data as AppOverviewEntry[]

      set(state => {
        const appStates = { ...state.appStates }
        const overview = { ...state.overview }
        for (const entry of entries) {
          appStates[entry.appId] = entry.state
          overview[entry.appId] = entry
        }
        return { appStates, overview }
      })

      // Escalation question text lives on the activity entry, not the status
      // event — prefetch it so a waiting_user app doesn't render with a blank
      // subtitle until the user opens it.
      const waitingAppIds = entries
        .filter(e => e.state.status === 'waiting_user')
        .map(e => e.appId)
      await Promise.all(waitingAppIds.map(appId => get().loadActivity(appId, { limit: 10 })))
    } catch (err) {
      console.error('[AppsStore] loadOverview error:', err)
    }
  },

  // ── Activity Feed ─────────────────────────

  loadActivity: async (appId, options) => {
    const revision = activityRevision
    set(state => ({ activityErrors: { ...state.activityErrors, [appId]: false } }))
    try {
      const res = await api.appGetActivity(appId, { limit: PAGE_SIZE, ...options })
      if (res.success && res.data) {
        const page = res.data as ActivityEntry[]
        const last = page[page.length - 1]
        const entries = mergeActivityEntries(page, eventsAfter(appId, revision))
        set(state => ({
          activityEntries: { ...state.activityEntries, [appId]: mergeActivityEntries(state.activityEntries[appId] ?? [], entries) },
          activityHasMore: { ...state.activityHasMore, [appId]: (res.data as ActivityEntry[]).length === PAGE_SIZE },
          activityCursor: last ? { ...state.activityCursor, [appId]: { ts: last.ts, id: last.id } } : state.activityCursor,
        }))
      } else { throw new Error(res.error ?? 'Activity request rejected') }
    } catch (err) {
      set(state => ({ activityErrors: { ...state.activityErrors, [appId]: true } }))
      console.error('[AppsStore] loadActivity error:', err)
    }
  },

  loadMoreActivity: async (appId) => {
    const cursor = get().activityCursor[appId]
    if (!get().activityHasMore[appId] || !cursor) return
    const revision = activityRevision

    try {
      const res = await api.appGetActivity(appId, {
        limit: PAGE_SIZE,
        since: cursor.ts,
        beforeId: cursor.id,
      })
      if (res.success && res.data) {
        const page = res.data as ActivityEntry[]
        const last = page[page.length - 1]
        const newEntries = mergeActivityEntries(page, eventsAfter(appId, revision))
        set(state => ({
          activityEntries: {
            ...state.activityEntries,
            [appId]: mergeActivityEntries(state.activityEntries[appId] ?? [], newEntries),
          },
          activityCursor: last ? { ...state.activityCursor, [appId]: { ts: last.ts, id: last.id } } : state.activityCursor,
          activityHasMore: {
            ...state.activityHasMore,
            [appId]: page.length === PAGE_SIZE,
          },
        }))
      } else { throw new Error(res.error ?? 'Activity page rejected') }
    } catch (err) {
      set(state => ({ activityErrors: { ...state.activityErrors, [appId]: true } }))
      console.error('[AppsStore] loadMoreActivity error:', err)
    }
  },

  // ── Escalation ───────────────────────────

  respondToEscalation: async (appId, escalationId, response) => {
    try {
      const res = await api.appRespondEscalation(appId, escalationId, response)
      if (res.success) {
        if (res.data && typeof res.data === 'object' && 'id' in res.data) get().handleNewActivityEntry(appId, res.data as ActivityEntry)
        await Promise.all([get().loadPending(appId), get().loadAppState(appId)])
        return true
      }
      await Promise.all([get().loadActivity(appId), get().loadPending(appId)])
      console.warn('[AppsStore] Escalation answer rejected', { appId, escalationId, error: res.error })
      return false
    } catch (err) {
      console.error('[AppsStore] respondToEscalation error:', err)
      return false
    }
  },

  // ── Continue ─────────────────────────────

  continueApp: async (appId, runId) => {
    try {
      const res = await api.appContinueRun(appId, runId)
      if (res.success) {
        get().loadAppState(appId)
      } else console.warn('[AppsStore] Continue request rejected', { appId, runId, error: res.error })
      return !!res.success
    } catch (err) {
      console.error('[AppsStore] continueApp error:', err)
      return false
    }
  },

  // ── Agent Restart ────────────────────────

  restartAppAgent: async (appId) => {
    try {
      const res = await api.appChatRestart(appId)
      if (!res.success && res.error) {
        useNotificationStore.getState().show({
          title: res.error,
          variant: 'warning',
          duration: 4000,
        })
      }
      return !!res.success
    } catch (err) {
      console.error('[AppsStore] restartAppAgent error:', err)
      return false
    }
  },

  // ── Config Updates ────────────────────────

  updateAppConfig: async (appId, config) => {
    try {
      const res = await api.appUpdateConfig(appId, config)
      if (res.success) {
        await get().refreshApp(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] updateAppConfig error:', err)
      return false
    }
  },

  updateAppOverrides: async (appId, overrides) => {
    try {
      const res = await api.appUpdateOverrides(appId, overrides)
      if (res.success) {
        await get().refreshApp(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] updateAppOverrides error:', err)
      return false
    }
  },

  updateAppSpec: async (appId, specPatch) => {
    try {
      const res = await api.appUpdateSpec(appId, specPatch)
      if (res.success) {
        await get().refreshApp(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] updateAppSpec error:', err)
      return false
    }
  },

  // ── Space Management ─────────────────

  moveAppToSpace: async (appId, newSpaceId) => {
    try {
      const res = await api.appMoveSpace(appId, newSpaceId)
      if (res.success) {
        // Optimistic update: reflect the new spaceId immediately
        set(state => ({
          apps: state.apps.map(a =>
            a.id === appId ? { ...a, spaceId: newSpaceId } : a
          ),
        }))
        // Authoritative refresh: get the full record from the backend
        await get().refreshApp(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] moveAppToSpace error:', err)
      return false
    }
  },

  // ── Import / Export ─────────────────────────

  exportApp: async (appId) => {
    try {
      const res = await api.appExportSpec(appId)
      if (res.success && res.data) {
        const { yaml, filename } = res.data as { yaml: string; filename: string }
        const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] exportApp error:', err)
      return false
    }
  },

  importApp: async (spaceId, yamlContent) => {
    // Errors are surfaced to the caller via AppApiError so the UI can
    // render a friendly, localized message (e.g. for ALREADY_INSTALLED).
    // Previously this swallowed failures into a generic null, which left
    // users with no indication of why the import was rejected.
    const res = await api.appImportSpec({ spaceId, yamlContent })
    if (res.success && (res.data as { appId?: string })?.appId) {
      const appId = (res.data as { appId: string }).appId
      await get().loadApps()
      return appId
    }
    throw new AppApiError(res.error || 'Import failed', res.code)
  },

  grantPermission: async (appId, permission) => {
    try {
      const res = await api.appGrantPermission(appId, permission)
      if (res.success) {
        await get().refreshApp(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] grantPermission error:', err)
      return false
    }
  },

  revokePermission: async (appId, permission) => {
    try {
      const res = await api.appRevokePermission(appId, permission)
      if (res.success) {
        await get().refreshApp(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] revokePermission error:', err)
      return false
    }
  },

  // ── Real-time Event Handlers ──────────────

  handleStatusChanged: (appId, state) => {
    set(s => {
      // Map AutomationAppState.status -> AppStatus for InstalledApp
      let appStatus: AppStatus
      switch (state.status) {
        case 'running':
        case 'queued':
        case 'idle':
          appStatus = 'active'
          break
        case 'paused':
          appStatus = 'paused'
          break
        case 'waiting_user':
          appStatus = 'waiting_user'
          break
        case 'needs_login':
          appStatus = 'needs_login'
          break
        case 'error':
          appStatus = 'error'
          break
        default:
          appStatus = 'active'
      }

      return {
        appStates: { ...s.appStates, [appId]: state },
        apps: s.apps.map(a =>
          a.id === appId ? { ...a, status: appStatus } : a
        ),
      }
    })
  },

  handleListChanged: () => {
    if (listReloadTimer) clearTimeout(listReloadTimer)
    listReloadTimer = setTimeout(() => {
      listReloadTimer = null
      if (get().hasFullList) void get().loadApps()
      else for (const app of get().apps) void get().refreshApp(app.id)
    }, LIST_RELOAD_DELAY_MS)
  },

  handleNewActivityEntry: (appId, entry) => {
    activityEvents.set(entry.id, { revision: ++activityRevision, entry })
    if (activityEvents.size > 2000) activityEvents.delete(activityEvents.keys().next().value!)
    set(state => {
      const existing = state.activityEntries[appId] ?? []
      const pending = state.pendingEntries[appId] ?? []
      const isPending = isPendingDecision(entry)
      return {
        activityEntries: { ...state.activityEntries, [appId]: mergeActivityEntries(existing, [entry]) },
        pendingEntries: { ...state.pendingEntries, [appId]: [...pending.filter(item => item.id !== entry.id), ...(isPending ? [entry] : [])].sort((a, b) => a.ts - b.ts) },
      }
    })
    if (entry.type === 'escalation') void get().loadAppState(appId)
  },

  handleNewEscalation: (appId, _entryId, _question, _choices) => {
    void get().loadPending(appId)
    void get().loadAppState(appId)
    // Lifecycle state remains authoritative even while requests are pending.
  },
}))

// ==========================================
// Derived Automation Task Items — recalculates only when a field that
// affects task-panel membership changes (mirrors chat.store's fingerprint-
// gated `_pulseItems`). `appStates`/`activityEntries` also receive
// high-frequency, task-irrelevant writes (activity feed pagination, etc.),
// so a plain selector would recompute the merged list far more than needed.
// ==========================================

const AUTOMATION_TASK_STATUSES: Record<AutomationAppState['status'], TaskItemStatus | null> = {
  running: 'running',
  queued: 'running',
  waiting_user: 'waiting',
  needs_login: 'waiting',
  error: 'error',
  idle: null,
  paused: null,
}

function _computeAutomationTaskItems(state: AppsState): TaskItem[] {
  const items: TaskItem[] = []

  for (const app of state.apps) {
    if (app.spec.type !== 'automation' || app.status === 'uninstalled') continue

    const runtime = state.appStates[app.id]
    const status = runtime ? AUTOMATION_TASK_STATUSES[runtime.status] : null
    if (!status || !runtime) continue

    let detail: string
    switch (runtime.status) {
      case 'needs_login':
        detail = i18n.t('Login expired, needs to sign in again')
        break
      case 'waiting_user': {
        const entry = app.pendingEscalationId
          ? state.activityEntries[app.id]?.find(e => e.id === app.pendingEscalationId)
          : undefined
        detail = entry?.content.question || i18n.t('Waiting for your input')
        break
      }
      case 'error':
        detail = runtime.lastError || i18n.t('Repeated failures, paused')
        break
      case 'queued':
        detail = i18n.t('Queued')
        break
      default:
        detail = i18n.t('Running')
    }

    items.push({
      key: `app:${app.id}`,
      source: 'automation',
      status,
      title: app.spec.name,
      detail,
      spaceId: app.spaceId,
      // Sentinel: task.store resolves this to a display name (or the
      // "Global" label for spaceId === null) — see task.store.ts.
      spaceName: app.spaceId ?? '',
      updatedAt: runtime.lastRunAtMs ?? app.installedAt,
      startedAt: runtime.runningAtMs,
      appId: app.id,
      appName: app.spec.name,
      escalationId: app.pendingEscalationId,
      runId: runtime.runningRunId,
    })
  }

  return items
}

function _extractAutomationTaskFingerprint(state: AppsState): string {
  const parts: string[] = []
  for (const app of state.apps) {
    if (app.spec.type !== 'automation' || app.status === 'uninstalled') continue
    const runtime = state.appStates[app.id]
    if (!runtime || !AUTOMATION_TASK_STATUSES[runtime.status]) continue

    let questionPart = ''
    if (runtime.status === 'waiting_user' && app.pendingEscalationId) {
      const entry = state.activityEntries[app.id]?.find(e => e.id === app.pendingEscalationId)
      questionPart = entry?.content.question ?? ''
    }
    parts.push(`${app.id}:${runtime.status}:${runtime.runningAtMs ?? ''}:${runtime.lastError ?? ''}:${questionPart}`)
  }
  parts.sort()
  // Prefix with the total app count so install/uninstall of an app with no
  // task-relevant status still invalidates the fingerprint.
  return `${state.apps.length}|${parts.join('|')}`
}

let _prevAutomationTaskFingerprint = ''

useAppsStore.subscribe((state) => {
  const fingerprint = _extractAutomationTaskFingerprint(state)
  if (fingerprint === _prevAutomationTaskFingerprint) return
  _prevAutomationTaskFingerprint = fingerprint
  useAppsStore.setState({ _automationTaskItems: _computeAutomationTaskItems(state) })
})

/** Selector: automation apps that belong in the task panel (pre-computed, see above). */
export function useAutomationTaskItems(): TaskItem[] {
  return useAppsStore(state => state._automationTaskItems)
}

// ============================================
// MCP Dependents (reverse lookup)
// ============================================

/** A digital human that declares a dependency on a given MCP server. */
export interface McpDependent {
  appId: string
  name: string
  /** Per-app switch (requires.mcps[].enabled). Absent flag means enabled. */
  enabled: boolean
}

/**
 * Reverse index: MCP specId -> digital humans that declare it in
 * `requires.mcps`. There is no stored reverse index — this derives it from
 * the already-loaded `apps` array on every render where it's used, which is
 * cheap (installed-app counts are small) and avoids a second source of truth.
 * Built-in capability ids (ai-browser, web-search, ...) are excluded; they
 * are injected automatically and never read as an installable MCP dependency.
 */
export function useMcpDependents(): Record<string, McpDependent[]> {
  const apps = useAppsStore(state => state.apps)
  return useMemo(() => {
    const result: Record<string, McpDependent[]> = {}
    for (const app of apps) {
      if (app.spec.type !== 'automation' || app.status === 'uninstalled') continue
      const deps = app.spec.requires?.mcps
      if (!deps) continue
      for (const dep of deps) {
        if (BUILTIN_MCP_SERVER_IDS.has(dep.id)) continue
        const list = result[dep.id] ?? (result[dep.id] = [])
        list.push({ appId: app.id, name: app.spec.name, enabled: dep.enabled !== false })
      }
    }
    return result
  }, [apps])
}
