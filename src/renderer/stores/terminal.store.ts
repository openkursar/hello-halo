/**
 * Terminal Store — renderer mirror of the main-process terminal sessions.
 *
 * The main process owns the pty sessions (single source of truth). This store
 * reflects their metadata and AI-activity state from `terminal:lifecycle`
 * events, driving the activity chip and viewer chrome. Live pty output
 * (`terminal:data`) is consumed directly by the TerminalViewer's xterm
 * instance, not buffered here.
 */

import { create } from 'zustand'
import { api } from '../api'
import { canvasLifecycle } from '../services/canvas-lifecycle'
import { useNotificationStore } from './notification.store'
import i18n from '../i18n'

export interface TerminalInfo {
  id: string
  title: string
  shell: string
  cwd: string
  cols: number
  rows: number
  owner: 'ai' | 'user'
  /** True once the AI has operated this session via any terminal_* tool. */
  aiTouched: boolean
  state: 'running' | 'exited'
  exitCode: number | null
  lastActivityAt: number
  createdAt: number
  /** Owning space id — drives per-space scoping of the live-sessions tray. */
  spaceId?: string
}

interface TerminalLifecycleEvent {
  sessionId: string
  type: 'created' | 'exited' | 'title' | 'ai-activity' | 'touched'
  info?: TerminalInfo
  aiWriting?: boolean
}

interface TerminalState {
  /** sessionId -> info */
  sessions: Map<string, TerminalInfo>
  /** sessionIds the AI is currently writing to (border highlight + chip) */
  aiWriting: Set<string>

  refresh: () => Promise<void>
  applyLifecycle: (e: TerminalLifecycleEvent) => void
  openInCanvas: (sessionId: string, title?: string) => void
  /** User-initiated creation. The 'created' lifecycle event reconciles state (SSOT). */
  createSession: (spaceId: string) => Promise<TerminalInfo | null>
  /** User-initiated stop. The 'exited' lifecycle event reconciles state (SSOT). */
  killSession: (sessionId: string) => Promise<void>

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
    }

    set({ sessions, aiWriting })
  },

  openInCanvas: (sessionId, title) => {
    void canvasLifecycle.openTerminal(sessionId, title)
  },

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

  killSession: async (sessionId) => {
    try {
      const res = await api.killTerminal(sessionId)
      if (!res.success) {
        // A missing session is the outcome the user asked for (it's already
        // gone) — treat it as success, not a failure. Also reached from the
        // bulk close path (disposeOnBulkClose), which is documented silent.
        if (res.error === 'No such terminal session') return
        console.error('[Terminal Store] killSession failed:', res.error)
        useNotificationStore.getState().show({
          id: 'terminal-kill-error',
          title: i18n.t('Failed to stop terminal session'),
          body: res.error || undefined,
          variant: 'error',
        })
      }
    } catch (err) {
      console.error('[Terminal Store] killSession error:', err)
      useNotificationStore.getState().show({
        id: 'terminal-kill-error',
        title: i18n.t('Failed to stop terminal session'),
        body: err instanceof Error ? err.message : undefined,
        variant: 'error',
      })
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
