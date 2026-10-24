/**
 * The session registry's records (digital-human chats, IM chats, ...), shared by
 * every list that shows digital-human conversations.
 *
 * One poll and one `im-session:updated` subscription for the whole renderer,
 * running while at least one consumer needs fresh data. Listeners are told when
 * the records actually changed, and once when the first read finishes, so a
 * poll that finds nothing new re-renders nothing.
 */

import { api } from '../api'
import type { ImSessionRecord } from '../../shared/types/im-channel'

/** Fallback cadence for updates missed while the window was in the background. */
const POLL_INTERVAL_MS = 15_000

let records: ImSessionRecord[] = []
let recordsKey = '[]'
let loading = true
const listeners = new Set<() => void>()
let consumers = 0
let pollTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeUpdates: (() => void) | undefined
let inFlight: Promise<void> | null = null

function refresh(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    let changed = false
    try {
      const res = await api.imSessionsList()
      if (!res.success || !Array.isArray(res.data)) {
        console.warn('[AppChatSessions] Session list unavailable:', res.error)
        return
      }
      const nextKey = JSON.stringify(res.data)
      if (nextKey === recordsKey) return
      records = res.data as ImSessionRecord[]
      recordsKey = nextKey
      changed = true
    } catch (err) {
      console.error('[AppChatSessions] Failed to list sessions:', err)
    } finally {
      inFlight = null
      if (loading) {
        loading = false
        changed = true
      }
      if (changed) listeners.forEach(listener => listener())
    }
  })()
  return inFlight
}

/** Keep the records fresh; returns the release. */
export function acquireAppChatSessions(): () => void {
  consumers++
  if (consumers === 1) {
    void refresh()
    pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    unsubscribeUpdates = api.onImSessionUpdated?.(() => void refresh())
  }
  let released = false
  return () => {
    if (released) return
    released = true
    consumers--
    if (consumers > 0) return
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    unsubscribeUpdates?.()
    unsubscribeUpdates = undefined
  }
}

export function subscribeAppChatSessions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getAppChatSessions(): ImSessionRecord[] {
  return records
}

/**
 * True until the first read finishes, whether it succeeded or not: until then
 * no records means "not known yet" rather than "none".
 */
export function isAppChatSessionsLoading(): boolean {
  return loading
}

/** Fetch the records now, for a one-off lookup that cannot wait for the next poll. */
export async function loadAppChatSessions(): Promise<ImSessionRecord[]> {
  await refresh()
  return records
}
