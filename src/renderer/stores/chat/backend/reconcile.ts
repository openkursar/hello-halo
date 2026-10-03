/**
 * Merging a freshly read transcript into what the view already shows.
 *
 * A read replaces nothing wholesale: rows that did not change keep their
 * object (so memoized rows skip rendering), a message the user just sent keeps
 * the identity of its optimistic bubble when the persisted twin arrives, and
 * older history the reader already paged in stays in place. Pure functions —
 * the store decides when to call them.
 */
import type { Message } from '../../../types'

/** Ids of messages shown before the transcript reader has confirmed them. */
const PENDING_ID_PREFIX = 'pending-'

let pendingSeq = 0

export function createPendingUserMessage(content: string, images: Message['images']): Message {
  const id = `${PENDING_ID_PREFIX}${Date.now()}-${++pendingSeq}`
  return {
    id,
    clientKey: id,
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    ...(images && images.length > 0 ? { images } : {}),
  }
}

export function isPendingMessage(message: Message): boolean {
  return message.id.startsWith(PENDING_ID_PREFIX)
}

function sameMessage(a: Message, b: Message): boolean {
  return a.role === b.role
    && a.source === b.source
    && a.content === b.content
    && a.timestamp === b.timestamp
    && a.error === b.error
    && a.thoughtsSummary?.count === b.thoughtsSummary?.count
    && (a.images?.length ?? 0) === (b.images?.length ?? 0)
    && JSON.stringify(a.tokenUsage) === JSON.stringify(b.tokenUsage)
    && JSON.stringify(a.metadata) === JSON.stringify(b.metadata)
}

/** The thoughts the view already loaded survive a re-read that lists them as unloaded. */
function withLoadedThoughts(prior: Message, fresh: Message): Message {
  if (fresh.thoughts === null && Array.isArray(prior.thoughts)
    && prior.thoughtsSummary?.count === fresh.thoughtsSummary?.count) {
    return { ...fresh, thoughts: prior.thoughts }
  }
  return fresh
}

function samePendingContent(pending: Message, persisted: Message): boolean {
  return pending.content.trim() === persisted.content.trim()
    && (pending.images?.length ?? 0) === (persisted.images?.length ?? 0)
}

export interface ReconcileResult {
  messages: Message[]
  /** Older messages the view already held before the fresh window were kept. */
  keptOlder: boolean
}

/**
 * @param dropUnconfirmed Discard pending messages the fresh read does not
 *   contain. True once a turn finished (the read is then authoritative and a
 *   leftover would show the message twice); false while a turn is running, when
 *   the message may simply not have been written yet.
 */
export function reconcileTranscript(
  cached: readonly Message[],
  fresh: readonly Message[],
  { dropUnconfirmed }: { dropUnconfirmed: boolean }
): ReconcileResult {
  const cachedById = new Map<string, Message>()
  for (const message of cached) if (!isPendingMessage(message)) cachedById.set(message.id, message)
  const pending = cached.filter(isPendingMessage)
  const claimed = new Set<string>()

  const merged = fresh.map((incoming): Message => {
    const prior = cachedById.get(incoming.id)
    if (prior) {
      if (sameMessage(prior, incoming)) return withLoadedThoughts(prior, prior)
      const next = withLoadedThoughts(prior, incoming)
      return prior.clientKey ? { ...next, clientKey: prior.clientKey } : next
    }
    if (incoming.role === 'user' && !incoming.source) {
      const twin = pending.find(p => !claimed.has(p.id) && samePendingContent(p, incoming))
      if (twin) {
        claimed.add(twin.id)
        return { ...incoming, clientKey: twin.clientKey ?? twin.id }
      }
    }
    return incoming
  })

  const anchor = fresh.length > 0 ? cached.findIndex(m => m.id === fresh[0].id) : -1
  const older = anchor > 0 ? cached.slice(0, anchor).filter(m => !isPendingMessage(m)) : []
  const unconfirmed = dropUnconfirmed ? [] : pending.filter(p => !claimed.has(p.id))

  return { messages: [...older, ...merged, ...unconfirmed], keptOlder: older.length > 0 }
}

/** Put an older page in front of the loaded messages; ids already loaded are skipped. */
export function prependOlder(cached: readonly Message[], older: readonly Message[]): Message[] {
  const loaded = new Set(cached.map(m => m.id))
  return [...older.filter(m => !loaded.has(m.id)), ...cached]
}

/**
 * Where a re-read after a finished turn may start: the last message the user
 * sent (an injection is not one). Everything before it belongs to finished
 * turns and no longer changes; the turn's own messages — its user message,
 * the reply placeholder filled in at the end, injections — come after it.
 */
export function rereadAnchor(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user' && !message.source && !isPendingMessage(message)) return message.id
  }
  return undefined
}

/**
 * The full transcript for a read that returned messages from `fromId` on:
 * the held messages before `fromId`, then the read. Null when `fromId` is no
 * longer among the held messages (the conversation changed underneath).
 */
export function joinFromAnchor(held: readonly Message[], fromRead: readonly Message[], fromId: string): Message[] | null {
  const persisted = held.filter(m => !isPendingMessage(m))
  const at = persisted.findIndex(m => m.id === fromId)
  return at < 0 ? null : [...persisted.slice(0, at), ...fromRead]
}
