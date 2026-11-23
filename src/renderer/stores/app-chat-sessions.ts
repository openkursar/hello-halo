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
import { buildLocalSessionKey, getAppChatConversationId } from '../../shared/apps/im-keys'
import type { ImSessionRecord } from '../../shared/types/im-channel'

/** Fallback cadence for updates missed while the window was in the background. */
const POLL_INTERVAL_MS = 15_000

let records: ImSessionRecord[] = []
let recordsKey = '[]'
let loading = true
let readSucceeded = false
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
      readSucceeded = true
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

/**
 * The records for a decision that would act on "none", or null while no read
 * has succeeded: until then an empty list means unknown. Reads now if none has.
 */
export async function knownAppChatSessions(): Promise<ImSessionRecord[] | null> {
  if (!readSucceeded) await refresh()
  return readSucceeded ? records : null
}

/**
 * One of the owner's own Halo chats with a digital human, as the conversation
 * lists show them: every local session, and the default session once it holds
 * a conversation (it is registered on its first send and emptied by clearing).
 */
export function isHaloChatRecord(record: ImSessionRecord): boolean {
  if (record.source === 'local') return true
  return record.source === 'native' && ((record.messageCount ?? 0) > 0 || !!record.lastMessage)
}

/** The conversation id of a digital human's most recently active Halo chat, or null when it has none. */
export function latestHaloChatId(sessions: readonly ImSessionRecord[], appId: string): string | null {
  let latest: ImSessionRecord | undefined
  for (const record of sessions) {
    if (record.appId !== appId || !isHaloChatRecord(record)) continue
    if (!latest || record.lastActiveAt > latest.lastActiveAt) latest = record
  }
  if (!latest) return null
  return latest.source === 'native' ? getAppChatConversationId(appId) : buildLocalSessionKey(appId, latest.chatId)
}
