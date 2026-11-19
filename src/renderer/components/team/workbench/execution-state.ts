import { api } from '../../../api'
import type { Thought } from '../../../types'

type ExecutionSnapshot = { isActive: boolean; thoughts: Thought[] }
export type ExecutionState = { snapshot: ExecutionSnapshot | null; failed: boolean; now: number; requestedAt: number }
type Observer = (state: ExecutionState) => void
const polls = new Map<string, { observers: Set<Observer>; state: ExecutionState; stop: () => void }>()

/** What a session-state read answers; `thoughtsDelta` marks an answer holding only the changed thoughts. */
export type SessionStateRead = ExecutionSnapshot & { thoughtsRevision?: string; thoughtsDelta?: { total: number; at: number[] } }

/**
 * The turn's thoughts after a read: the answer itself, or the held thoughts
 * with the changed ones put in their places. Null when the answer does not fit
 * what is held (the next read then asks for everything).
 */
export function thoughtsAfterRead(held: Thought[], read: SessionStateRead): Thought[] | null {
  const delta = read.thoughtsDelta
  if (!delta) return read.thoughts
  if (delta.at.length !== read.thoughts.length || delta.total < held.length) return null
  if (delta.at.length === 0 && delta.total === held.length) return held
  const thoughts = held.slice(0, delta.total)
  for (let index = 0; index < delta.at.length; index++) {
    const at = delta.at[index]
    if (!Number.isInteger(at) || at < 0 || at >= delta.total) return null
    thoughts[at] = read.thoughts[index]
  }
  for (let index = 0; index < delta.total; index++) if (!thoughts[index]) return null
  return thoughts
}

/**
 * Chat and the inspector observe one polling loop for the same execution.
 * After the first read the loop asks only for the thoughts changed since the
 * previous one, so a long turn is not transferred again every few seconds.
 */
export function observeExecution(appId: string, conversationId: string, observer: Observer) {
  const key = `${appId}:${conversationId}`
  let session = polls.get(key)
  if (!session) {
    const observers = new Set<Observer>()
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let revision = ''
    session = { observers, state: { snapshot: null, failed: false, now: Date.now(), requestedAt: -Infinity }, stop: () => { disposed = true; clearTimeout(timer) } }
    polls.set(key, session)
    const current = session
    const refresh = async () => {
      const requestedAt = Date.now()
      try {
        for (;;) {
          const result = await api.appChatSessionState(appId, conversationId, revision)
          if (disposed) return
          if (!result.success || !result.data) throw new Error(String(result.error ?? 'Execution state unavailable'))
          const read = result.data as SessionStateRead
          const thoughts = thoughtsAfterRead(current.state.snapshot?.thoughts ?? [], read)
          if (thoughts) {
            revision = read.thoughtsRevision ?? ''
            current.state = { snapshot: { isActive: read.isActive, thoughts }, failed: false, now: Date.now(), requestedAt }
            break
          }
          if (!revision) throw new Error('Execution state does not fit')
          console.warn('[TaskExecution] Execution update did not fit the held state; reading it whole', { appId, conversationId })
          revision = ''
        }
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
    if (!current.observers.size) { current.stop(); polls.delete(key) }
  }
}
