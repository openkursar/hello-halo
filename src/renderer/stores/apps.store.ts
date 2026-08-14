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
import { api } from '../api'
import { useNotificationStore } from './notification.store'
import type {
  InstalledApp,
  AppStatus,
  AutomationAppState,
  ActivityEntry,
  ActivityQueryOptions,
} from '../../shared/apps/app-types'
import type { AppSpec } from '../../shared/apps/spec-types'
import type { ScheduleValue } from '../types'

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
  isLoading: boolean
  error: string | null

  // ── App List Management ───────────────────
  loadApps: (spaceId?: string) => Promise<void>
  refreshApp: (appId: string) => Promise<void>

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

  // ── Activity Feed ─────────────────────────
  loadActivity: (appId: string, options?: ActivityQueryOptions) => Promise<void>
  loadMoreActivity: (appId: string) => Promise<void>

  // ── Escalation ───────────────────────────
  respondToEscalation: (appId: string, escalationId: string, response: { choice?: string; text?: string }) => Promise<boolean>

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
  updateAppFrequency: (appId: string, subscriptionId: string, frequency: string) => Promise<boolean>
  updateAppOverrides: (appId: string, overrides: Record<string, unknown>) => Promise<boolean>
  updateAppSpec: (appId: string, specPatch: Record<string, unknown>) => Promise<boolean>
  updateAppSchedule: (appId: string, subscriptionId: string, value: ScheduleValue) => Promise<boolean>

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
  isLoading: false,
  error: null,

  // ── App List Management ───────────────────

  loadApps: async (spaceId) => {
    set({ isLoading: true, error: null })
    try {
      const res = await api.appList(spaceId ? { spaceId } : undefined)
      if (res.success && res.data) {
        set({ apps: res.data as InstalledApp[] })
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
          apps: state.apps.map(a => a.id === appId ? updated : a),
        }))
      }
    } catch (err) {
      console.error('[AppsStore] refreshApp error:', err)
    }
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
      const res = await api.appTrigger(appId)
      if (!res.success && res.error) {
        // Surface backend rejections (e.g. per-app concurrency limit) as a toast
        // so the user sees clear feedback rather than a silent no-op.
        useNotificationStore.getState().show({
          title: res.error,
          variant: 'warning',
          duration: 4000,
        })
      }
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

  // ── Activity Feed ─────────────────────────

  loadActivity: async (appId, options) => {
    try {
      const res = await api.appGetActivity(appId, { limit: PAGE_SIZE, ...options })
      if (res.success && res.data) {
        const entries = res.data as ActivityEntry[]
        set(state => ({
          activityEntries: { ...state.activityEntries, [appId]: entries },
          activityHasMore: { ...state.activityHasMore, [appId]: entries.length === PAGE_SIZE },
        }))
      }
    } catch (err) {
      console.error('[AppsStore] loadActivity error:', err)
    }
  },

  loadMoreActivity: async (appId) => {
    const existing = get().activityEntries[appId] ?? []
    if (!get().activityHasMore[appId]) return

    try {
      // Use the oldest entry's ts as the cursor (before = entries older than this)
      const oldest = existing[existing.length - 1]
      const res = await api.appGetActivity(appId, {
        limit: PAGE_SIZE,
        since: oldest?.ts,
      })
      if (res.success && res.data) {
        const newEntries = res.data as ActivityEntry[]
        set(state => ({
          activityEntries: {
            ...state.activityEntries,
            [appId]: [...(state.activityEntries[appId] ?? []), ...newEntries],
          },
          activityHasMore: {
            ...state.activityHasMore,
            [appId]: newEntries.length === PAGE_SIZE,
          },
        }))
      }
    } catch (err) {
      console.error('[AppsStore] loadMoreActivity error:', err)
    }
  },

  // ── Escalation ───────────────────────────

  respondToEscalation: async (appId, escalationId, response) => {
    try {
      const res = await api.appRespondEscalation(appId, escalationId, response)
      if (res.success) {
        // Update the local entry to reflect the user's response
        const userResponse = { ts: Date.now(), ...response }
        set(state => {
          const entries = state.activityEntries[appId] ?? []
          const updated = entries.map(e =>
            e.id === escalationId ? { ...e, userResponse } : e
          )
          return {
            activityEntries: { ...state.activityEntries, [appId]: updated },
            // Clear waiting_user status optimistically
            apps: state.apps.map(a =>
              a.id === appId
                ? { ...a, status: 'active' as AppStatus, pendingEscalationId: undefined }
                : a
            ),
          }
        })
        return true
      }
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
      }
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

  updateAppFrequency: async (appId, subscriptionId, frequency) => {
    try {
      const res = await api.appUpdateFrequency(appId, subscriptionId, frequency)
      if (res.success) {
        await get().refreshApp(appId)
        return true
      }
      return false
    } catch (err) {
      console.error('[AppsStore] updateAppFrequency error:', err)
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

  updateAppSchedule: async (appId, subscriptionId, value) => {
    if (value.type === 'every') {
      return get().updateAppFrequency(appId, subscriptionId, value.every)
    }
    // cron: update via spec merge patch
    const app = get().apps.find(a => a.id === appId)
    if (!app || app.spec.type !== 'automation') return false
    const subs = app.spec.subscriptions ?? []
    const newSubs = subs.map((s, i) => {
      const sid = s.id ?? String(i)
      if (sid === subscriptionId) {
        return { ...s, source: { type: 'schedule' as const, config: { cron: value.cron } } }
      }
      return s
    })
    return get().updateAppSpec(appId, { subscriptions: newSubs })
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
        // Trigger browser file download
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
      void get().loadApps()
    }, LIST_RELOAD_DELAY_MS)
  },

  handleNewActivityEntry: (appId, entry) => {
    set(state => {
      const existing = state.activityEntries[appId] ?? []
      // Prepend (newest first); avoid duplicates by id
      if (existing.some(e => e.id === entry.id)) return {}
      return {
        activityEntries: {
          ...state.activityEntries,
          [appId]: [entry, ...existing],
        },
      }
    })
  },

  handleNewEscalation: (appId, entryId, _question, _choices) => {
    // The activity entry is already added via handleNewActivityEntry.
    // Here we just update the app status to waiting_user.
    set(state => ({
      apps: state.apps.map(a =>
        a.id === appId
          ? { ...a, status: 'waiting_user' as AppStatus, pendingEscalationId: entryId }
          : a
      ),
    }))
  },
}))
