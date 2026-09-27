/**
 * Terminal Store — renderer mirror of the main-process terminal sessions.
 *
 * The main process owns the pty sessions (single source of truth). This store
 * reflects their metadata and AI-activity state from `terminal:lifecycle`
 * events, driving the activity chip and viewer chrome. Live pty output
 * (`terminal:data`) is consumed directly by the TerminalViewer's xterm
 * instance, not buffered here.
 *
 * Removal is an event, never a guess: entries leave this map only on a
 * `removed` lifecycle event. The main process's registry is the bound, and it
 * is not reproducible here — see `TerminalContext.dropSession`.
 */

import { create } from 'zustand'
import { api } from '../api'
import { canvasLifecycle } from '../services/canvas-lifecycle'
import { useNotificationStore } from './notification.store'
import i18n from '../i18n'
import { TERMINAL_NOT_FOUND } from '../../shared/types/terminal'
import type { TerminalInfo, TerminalLifecycleEvent } from '../../shared/types/terminal'

export type { TerminalInfo }

interface TerminalState {
  /** sessionId -> info */
  sessions: Map<string, TerminalInfo>
  /** sessionIds the AI is currently writing to (border highlight + chip) */
  aiWriting: Set<string>

  refresh: () => Promise<void>
  applyLifecycle: (e: TerminalLifecycleEvent) => void
  /** Resolves once the tab exists, so callers can report a reveal that failed. */
  openInCanvas: (sessionId: string, title?: string) => Promise<string>
  /** User-initiated creation. The 'created' lifecycle event reconciles state (SSOT). */
  createSession: (spaceId: string) => Promise<TerminalInfo | null>
  /**
   * Stop a terminal session. The 'exited' lifecycle event reconciles state (SSOT).
   *
   * Teardown paths (space switch, closeAll) pass `silent` — the session is
   * already going away, so an error toast there interrupts a navigation the
   * user never connected to this session.
   */
  killSession: (sessionId: string, opts?: { silent?: boolean }) => Promise<void>

  /** Running sessions, most-recently-active first (for chip + lists). */
  runningSessions: () => TerminalInfo[]
  /** Whether the AI has any active terminal work (drives the chip). */
  hasAiActivity: () => boolean
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: new Map(),
  aiWriting: new Set(),

  refresh: async () => {
    try {
      const res = await api.listTerminals()
      if (res.success && Array.isArray(res.data)) {
        const next = new Map<string, TerminalInfo>()
        for (const info of res.data as TerminalInfo[]) next.set(info.id, info)
        set({ sessions: next })
      }
    } catch (err) {
      console.error('[Terminal Store] refresh failed:', err)
    }
  },

  applyLifecycle: (e) => {
    const sessions = new Map(get().sessions)
    const aiWriting = new Set(get().aiWriting)

    switch (e.type) {
      case 'created':
        if (e.info) sessions.set(e.sessionId, e.info)
        break
      case 'exited':
        if (e.info) sessions.set(e.sessionId, e.info)
        aiWriting.delete(e.sessionId)
        break
      case 'title':
        if (e.info) {
          sessions.set(e.sessionId, e.info)
          canvasLifecycle.setTerminalTitle(e.sessionId, e.info.title)
        }
        break
      case 'ai-activity':
        if (e.info) sessions.set(e.sessionId, e.info)
        if (e.aiWriting) aiWriting.add(e.sessionId)
        else aiWriting.delete(e.sessionId)
        break
      case 'touched':
        // A user-opened session became AI-operated: refresh its info so the
        // close policy and tray membership see the new aiTouched flag.
        if (e.info) sessions.set(e.sessionId, e.info)
        break
      case 'removed':
        // The main process forgot the session. Without this the map would keep
        // an entry for every terminal the app has ever run.
        sessions.delete(e.sessionId)
        aiWriting.delete(e.sessionId)
        break
    }

    set({ sessions, aiWriting })
  },

  openInCanvas: (sessionId, title) => canvasLifecycle.openTerminal(sessionId, title),

  createSession: async (spaceId) => {
    try {
      const res = await api.createTerminal({ spaceId })
      if (res.success && res.data) return res.data as TerminalInfo
      console.error('[Terminal Store] createSession failed:', res.error)
      return null
    } catch (err) {
      console.error('[Terminal Store] createSession error:', err)
      return null
    }
  },

  killSession: async (sessionId, opts) => {
    const report = (detail?: string) => {
      if (opts?.silent) return
      useNotificationStore.getState().show({
        id: 'terminal-kill-error',
        title: i18n.t('Failed to stop terminal session'),
        body: detail,
        variant: 'error',
        duration: 6000,
      })
    }
    try {
      const res = await api.killTerminal(sessionId)
      if (res.success) return
      // Already gone is the outcome the user asked for.
      if (res.code === TERMINAL_NOT_FOUND) return
      console.error('[Terminal Store] killSession failed:', res.error)
      report(res.error || undefined)
    } catch (err) {
      console.error('[Terminal Store] killSession error:', err)
      report(err instanceof Error ? err.message : undefined)
    }
  },

  runningSessions: () =>
    [...get().sessions.values()]
      .filter(s => s.state === 'running')
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt),

  hasAiActivity: () => {
    const { sessions, aiWriting } = get()
    if (aiWriting.size > 0) return true
    // Any AI-owned running session counts as ongoing AI terminal work.
    for (const s of sessions.values()) {
      if (s.owner === 'ai' && s.state === 'running') return true
    }
    return false
  }
}))

/**
 * Wire terminal lifecycle events into the store. Called once from App.tsx.
 * Data events are handled by TerminalViewer directly (per-session xterm).
 */
export function initTerminalStoreListeners(): () => void {
  void useTerminalStore.getState().refresh()
  return api.onTerminalLifecycle((data: unknown) => {
    useTerminalStore.getState().applyLifecycle(data as TerminalLifecycleEvent)
  })
}
