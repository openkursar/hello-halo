import { api } from '../../api'
import type { Message } from '../../types'

type HistoryResult = Awaited<ReturnType<typeof api.teamChatMessages>>
type HistorySource = { readers: number; messages: Message[] | null; cursor: number; dirty: boolean; pending?: Promise<HistoryResult> }
const sources = new Map<string, HistorySource>()
/**
 * Transcripts whose last reader left, newest last. Kept so returning to a member
 * repaints from what was last on screen instead of blanking to a spinner — and
 * so the refetch that follows is an incremental tail pull rather than a full
 * re-read. Bounded by count: a transcript carries every tool result of a run, so
 * this is a small convenience cache, never a store.
 */
const retired = new Map<string, HistorySource>()
const RETIRED_LIMIT = 5
const keyFor = (appId: string, spaceId: string, teamId: string, epochId: string) => JSON.stringify([appId, spaceId, teamId, epochId])
function sourceFor(key: string) {
  let source = sources.get(key)
  if (!source) {
    source = retired.get(key) ?? { readers: 0, messages: null, cursor: 0, dirty: false }
    retired.delete(key)
    sources.set(key, source)
  }
  return source
}

/** Move a reader-less source to the bounded keep-warm set, evicting the oldest. */
function retire(key: string, source: HistorySource) {
  if (source.readers > 0 || sources.get(key) !== source) return
  sources.delete(key)
  if (!source.messages) return
  retired.set(key, source)
  for (const oldest of retired.keys()) {
    if (retired.size <= RETIRED_LIMIT) break
    retired.delete(oldest)
  }
}

/** A transcript is observed by at least one team surface until the release runs. */
export function retainTeamSessionHistory(appId: string, spaceId: string, teamId: string, epochId: string) {
  const key = keyFor(appId, spaceId, teamId, epochId)
  const source = sourceFor(key)
  source.readers++
  return () => {
    source.readers--
    retire(key, source)
  }
}

/**
 * The transcript last shown for this session, if still held — the first paint a
 * surface can render synchronously while its refetch is in flight.
 */
export function peekTeamSessionHistory(appId: string, spaceId: string, teamId: string, epochId: string): Message[] | null {
  const key = keyFor(appId, spaceId, teamId, epochId)
  return (sources.get(key) ?? retired.get(key))?.messages ?? null
}

/** Chat, reports and the inspector share one incremental transcript source. */
export function loadTeamSessionHistory(...args: Parameters<typeof api.teamChatMessages>) {
  const [appId, spaceId, teamId, epochId] = args
  const key = keyFor(appId, spaceId, teamId, epochId)
  const source = sourceFor(key)
  if (source.pending) return source.pending
  const request = Promise.resolve().then(async () => {
    let result: HistoryResult
    do {
      source.dirty = false
      const since = source.messages && source.cursor > 1 ? source.cursor - 1 : undefined
      result = await api.teamChatMessages(appId, spaceId, teamId, epochId, since)
      if (!result.success) return result
      const batch = (result.data ?? []) as Message[]
      const seqOf = (message: Message) => (message as Message & { seq?: number }).seq
      if (since !== undefined && source.messages) {
        const rows = new Map(source.messages.map(message => [seqOf(message) ?? message.id, message]))
        for (const message of batch) rows.set(seqOf(message) ?? message.id, message)
        source.messages = [...rows.values()]
      } else source.messages = batch
      source.cursor = source.messages.reduce((max, message) => Math.max(max, seqOf(message) ?? 0), 0)
    } while (source.dirty && source.readers > 0)
    return { ...result, data: source.messages }
  })
  source.pending = request
  const release = () => {
    if (source.pending === request) source.pending = undefined
    retire(key, source)
  }
  void request.then(release, release)
  return request
}

export function matchesTeamHistory(event: { teamId?: string; epochId?: string; appId?: string }, teamId: string, epochId: string, appId?: string) {
  return event.teamId === teamId && event.epochId === epochId && (!appId || event.appId === appId)
}

export function invalidateTeamSessionHistory(appId: string, spaceId: string, teamId: string, epochId: string) {
  const source = sources.get(keyFor(appId, spaceId, teamId, epochId))
  if (source) source.dirty = true
}
