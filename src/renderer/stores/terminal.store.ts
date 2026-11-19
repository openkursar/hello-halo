/**
 * Terminal Store — renderer mirror of the main-process terminal sessions.
 *
 * The main process owns the pty sessions (single source of truth). This store
 * reflects their metadata and whether the AI is operating them from
 * `terminal:lifecycle` events, driving the AI's canvas tabs and their marks.
 * Live pty output (`terminal:data`) is consumed directly by the
 * TerminalViewer's xterm instance, not buffered here.
 *
 * Only main decides what remains: the live events carry removals, and a
 * client that joins or reconnects reconciles with the current registry.
 */

import { create } from 'zustand'
import { api } from '../api'
import { canvasLifecycle } from '../services/canvas-lifecycle'
import { useNotificationStore } from './notification.store'
import i18n from '../i18n'
import { TERMINAL_NOT_FOUND } from '../../shared/types/terminal'
import type { TerminalInfo, TerminalLifecycleEvent, TerminalSnapshotEntry } from '../../shared/types/terminal'
import { followLiveSnapshot } from './live-snapshot'

export type { TerminalInfo }

interface TerminalState {
  /** sessionId -> info */
  sessions: Map<string, TerminalInfo>
  /** Sessions the AI is operating (held a while after its last call, by main). */
  operating: Set<string>
  /** sessionId -> the conversation whose AI last operated it. */
  operators: Map<string, string>

  applySnapshot: (entries: readonly TerminalSnapshotEntry[], changed: ReadonlySet<string>) => void
  applyLifecycle: (e: TerminalLifecycleEvent) => void
  /** Resolves once the tab exists, so callers can report a reveal that failed. */
  openInCanvas: (sessionId: string, title?: string) => Promise<string>
  /** User-initiated creation. The 'created' lifecycle event reconciles state (SSOT). */
  createSession: (spaceId: string) => Promise<TerminalInfo | null>
  /**
   * Stop a terminal session; resolves whether it is gone (already gone counts).
   * The 'exited' lifecycle event reconciles state (SSOT).
   *
   * Teardown paths (closing many tabs, a removed space) pass `silent` — the
   * session is already going away, so an error toast there interrupts an
   * action the user never connected to this session.
   */
  killSession: (sessionId: string, opts?: { silent?: boolean }) => Promise<boolean>

  /** Running sessions, most-recently-active first. */
  runningSessions: () => TerminalInfo[]
}

const sessionChange = (id: string) => `session:${id}`
const activityChange = (id: string) => `activity:${id}`

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: new Map(),
  operating: new Set(),
  operators: new Map(),

  applySnapshot: (entries, changed) => {
    const previous = get()
    const sessions = new Map<string, TerminalInfo>()
    const operating = new Set<string>()
    const operators = new Map<string, string>()
    for (const { operating: active, conversationId, ...info } of entries) {
      if (!changed.has(sessionChange(info.id))) sessions.set(info.id, info)
      if (info.state !== 'running' || changed.has(activityChange(info.id))) continue
      if (active) operating.add(info.id)
      if (conversationId) operators.set(info.id, conversationId)
    }
    for (const [id, info] of previous.sessions) {
      if (changed.has(sessionChange(id))) sessions.set(id, info)
      if (changed.has(activityChange(id))) {
        if (previous.operating.has(id)) operating.add(id)
        const operator = previous.operators.get(id)
        if (operator) operators.set(id, operator)
      }
    }
    for (const id of operating) if (sessions.get(id)?.state !== 'running') operating.delete(id)
    for (const id of operators.keys()) if (sessions.get(id)?.state !== 'running') operators.delete(id)
    set({ sessions, operating, operators })
  },

  applyLifecycle: (e) => {
    const state = get()
    let { sessions, operating, operators } = state
    const putSession = (info: TerminalInfo) => {
      sessions = new Map(sessions)
      sessions.set(e.sessionId, info)
    }
    const stopOperating = () => {
      if (operating.has(e.sessionId)) {
        operating = new Set(operating)
        operating.delete(e.sessionId)
      }
      if (operators.has(e.sessionId)) {
        operators = new Map(operators)
        operators.delete(e.sessionId)
      }
    }

    switch (e.type) {
      case 'created':
        if (e.info) putSession(e.info)
        break
      case 'exited':
        if (e.info) putSession(e.info)
        stopOperating()
        break
      case 'title':
        if (e.info) putSession(e.info)
        break
      case 'ai-activity':
        if (e.info && !sessions.has(e.sessionId)) putSession(e.info)
        if (e.operating !== undefined && e.operating !== operating.has(e.sessionId)) {
          operating = new Set(operating)
          if (e.operating) operating.add(e.sessionId)
          else operating.delete(e.sessionId)
        }
        if (e.conversationId && operators.get(e.sessionId) !== e.conversationId) {
          operators = new Map(operators)
          operators.set(e.sessionId, e.conversationId)
        }
        break
      case 'touched':
        if (e.info) putSession(e.info)
        break
      case 'removed':
        if (sessions.has(e.sessionId)) {
          sessions = new Map(sessions)
          sessions.delete(e.sessionId)
        }
        stopOperating()
        break
    }

    if (sessions !== state.sessions || operating !== state.operating || operators !== state.operators) {
      set({ sessions, operating, operators })
    }
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
      if (res.success) return true
      // Already gone is the outcome the user asked for.
      if (res.code === TERMINAL_NOT_FOUND) return true
      console.error('[Terminal Store] killSession failed:', res.error)
      report(res.error || undefined)
    } catch (err) {
      console.error('[Terminal Store] killSession error:', err)
      report(err instanceof Error ? err.message : undefined)
    }
    return false
  },

  runningSessions: () =>
    [...get().sessions.values()]
      .filter(s => s.state === 'running')
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt),
}))

/**
 * Wire terminal lifecycle events into the store. Called once from App.tsx.
 * Data events are handled by TerminalViewer directly (per-session xterm).
 */
export function initTerminalStoreListeners(): () => void {
  let snapshot: ReturnType<typeof followLiveSnapshot<TerminalSnapshotEntry[], string>> | undefined
  const unsubscribe = api.onTerminalLifecycle((data: unknown) => {
    const event = data as TerminalLifecycleEvent
    const state = useTerminalStore.getState()
    if (event.type !== 'ai-activity' || !state.sessions.has(event.sessionId)) snapshot?.changed(sessionChange(event.sessionId))
    if (event.type === 'ai-activity' || event.type === 'exited' || event.type === 'removed') snapshot?.changed(activityChange(event.sessionId))
    state.applyLifecycle(event)
  })
  snapshot = followLiveSnapshot(async () => {
    const result = await api.listTerminals()
    if (!result.success || !Array.isArray(result.data)) throw new Error(result.error ?? 'Terminal list unavailable')
    return result.data
  }, useTerminalStore.getState().applySnapshot, 'Terminal Store')
  return () => {
    unsubscribe()
    snapshot?.dispose()
  }
}
