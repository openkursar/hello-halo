import { api } from '../../../api'
import type { Thought } from '../../../types'

type ExecutionSnapshot = { isActive: boolean; thoughts: Thought[] }
export type ExecutionState = { snapshot: ExecutionSnapshot | null; failed: boolean; now: number; requestedAt: number }
type Observer = (state: ExecutionState) => void
const sessions = new Map<string, { observers: Set<Observer>; state: ExecutionState; stop: () => void }>()

/** Chat and the inspector observe one polling loop for the same execution. */
export function observeExecution(appId: string, conversationId: string, observer: Observer) {
  const key = `${appId}:${conversationId}`
  let session = sessions.get(key)
  if (!session) {
    const observers = new Set<Observer>()
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    session = { observers, state: { snapshot: null, failed: false, now: Date.now(), requestedAt: -Infinity }, stop: () => { disposed = true; clearTimeout(timer) } }
    sessions.set(key, session)
    const current = session
    const refresh = async () => {
      const requestedAt = Date.now()
      try {
        const result = await api.appChatSessionState(appId, conversationId)
        if (disposed) return
        if (!result.success || !result.data) throw new Error(String(result.error ?? 'Execution state unavailable'))
        current.state = { snapshot: result.data as ExecutionSnapshot, failed: false, now: Date.now(), requestedAt }
      } catch (error) {
        if (disposed) return
        if (!current.state.failed) console.warn('[TaskExecution] State unavailable', { appId, conversationId, error })
        current.state = { ...current.state, failed: true, now: Date.now() }
      } finally {
        if (!disposed) {
          for (const listener of observers) listener(current.state)
          timer = setTimeout(refresh, current.state.snapshot?.isActive ? 3000 : 15000)
        }
      }
    }
    void refresh()
  }
  const current = session
  current.observers.add(observer)
  observer(current.state)
  return () => {
    current.observers.delete(observer)
    if (!current.observers.size) { current.stop(); sessions.delete(key) }
  }
}
