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

type HistoryRow = Message & { seq?: number }

const REMOTE_ROW_ID = 'remote-seq-'
/** Wide enough for any seq, so these ids compare as text in seq order. */
const SEQ_WIDTH = String(Number.MAX_SAFE_INTEGER).length

/**
 * Rows of a member on another computer come as its owner serialized them, with
 * `seq` but no `id`. Every team surface keys and matches messages by id, so such
 * a row takes one derived from its seq: the same on every read, and never an id
 * the owner itself assigns. These rows carry no `timestamp` either, so lists
 * order them by comparing ids as text, hence the padding.
 */
function withRowId(row: HistoryRow): HistoryRow {
  return row.id ? row : { ...row, id: `${REMOTE_ROW_ID}${String(row.seq).padStart(SEQ_WIDTH, '0')}` }
}

const seqOf = (message: Message) => (message as HistoryRow).seq
const textKey = (message: Message) => `${message.role}\u0000${message.content}`

/**
 * A remote row taking the place of what the screen showed for the same record.
 * Its owner's copy carries no client key and no input outcome, so it keeps the
 * screen's: the key the live overlay and a stop find the record by, and what a
 * stop made of it. A local member's stored copy carries both and is used as is.
 */
function keepScreenState(stored: Message, shown: Message, clientKey = shown.clientKey): Message {
  if (!stored.id.startsWith(REMOTE_ROW_ID)) return stored
  const outcome = stored.metadata?.inputOutcome ?? shown.metadata?.inputOutcome
  if (clientKey === stored.clientKey && outcome === stored.metadata?.inputOutcome) return stored
  return {
    ...stored,
    ...(clientKey ? { clientKey } : {}),
    ...(outcome ? { metadata: { ...stored.metadata, inputOutcome: outcome } } : {}),
  }
}

/**
 * What a session shows after a tail read: rows on screen are replaced by their
 * stored copy (matched by seq) and new rows are appended. A record shown before
 * it was stored — a sender's bubble, an announced arrival — gives way to its
 * stored copy, matched by role and content.
 */
export function mergeTeamSessionHistory(shown: readonly Message[], batch: readonly Message[]): Message[] {
  const bySeq = new Map<number, Message>()
  for (const message of batch) {
    const seq = seqOf(message)
    if (seq !== undefined) bySeq.set(seq, message)
  }
  const appendSeqs = new Set(bySeq.keys())
  const replaced = shown.map((message) => {
    const seq = seqOf(message)
    if (seq === undefined || !bySeq.has(seq)) return message
    appendSeqs.delete(seq)
    return keepScreenState(bySeq.get(seq)!, message)
  })
  const unstored = replaced.filter(message => seqOf(message) === undefined)
  const fresh = batch
    .filter((message) => { const seq = seqOf(message); return seq !== undefined && appendSeqs.has(seq) })
    .map((message) => {
      const at = message.id.startsWith(REMOTE_ROW_ID) ? unstored.findIndex(record => textKey(record) === textKey(message)) : -1
      if (at < 0) return message
      const [record] = unstored.splice(at, 1)
      return keepScreenState(message, record, record.clientKey ?? record.id)
    })
  const superseded = new Set(fresh.map(textKey))
  return [...replaced.filter(message => seqOf(message) !== undefined || !superseded.has(textKey(message))), ...fresh]
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
      const batch = ((result.data ?? []) as HistoryRow[]).map(withRowId)
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
