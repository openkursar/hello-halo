/**
 * Conversation cache policy.
 *
 * Bounded by count and by estimated size, least-recently-cached-first — but
 * never at the expense of anything the user is looking at or a turn that is
 * still running: evicting those would blank the page, or drop the place a
 * finishing turn writes into. One cached conversation can weigh megabytes
 * (inline base64 images, v1 inline thoughts), so a count alone bounds nothing.
 *
 * Thoughts loaded on demand live in their message and count toward a separate
 * budget; past it, the thoughts loaded longest ago (least recently cached
 * conversation first) are dropped back to "not loaded" — they are re-read
 * from disk when their panel is opened again. A panel expanded on screen is
 * never dropped (`open-thoughts.ts`).
 */
import { CONVERSATION_CACHE_BYTES, CONVERSATION_CACHE_SIZE, LOADED_THOUGHTS_BYTES } from '../internal'
import type { ChatState, Conversation, Message, Thought } from '../internal'
import { selectActiveConversationId } from '../active'
import { isThoughtsPanelOpen } from '../open-thoughts'

type CacheInput = Pick<ChatState, 'conversationCache' | 'spaceStates' | 'sessions' | 'currentSpaceId'>

function pinnedIds(state: CacheInput, incomingId: string): Set<string> {
  const pinned = new Set<string>([incomingId])
  const active = selectActiveConversationId(state)
  if (active) pinned.add(active)
  const spaceState = state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId) : undefined
  if (spaceState?.currentConversationId) pinned.add(spaceState.currentConversationId)
  // A space's selected digital human is what it shows on return, and unlike a
  // regular conversation nothing re-reads it when the space is entered again.
  for (const [, other] of state.spaceStates) {
    if (other.selectedAppChat) pinned.add(other.selectedAppChat.conversationId)
  }
  for (const [id, session] of state.sessions) if (session.isGenerating) pinned.add(id)
  return pinned
}

// ── Size estimates (UTF-16: two bytes per character) ──

const thoughtsBytesMemo = new WeakMap<Thought[], number>()
const conversationBytesMemo = new WeakMap<Conversation, number>()

export function estimateThoughtsBytes(thoughts: Thought[]): number {
  const memo = thoughtsBytesMemo.get(thoughts)
  if (memo !== undefined) return memo
  let chars = 0
  for (const thought of thoughts) {
    chars += thought.content?.length ?? 0
    chars += thought.toolOutput?.length ?? 0
    chars += thought.toolResult?.output?.length ?? 0
    if (thought.toolInput) chars += JSON.stringify(thought.toolInput).length
  }
  const bytes = chars * 2
  thoughtsBytesMemo.set(thoughts, bytes)
  return bytes
}

function estimateMessageBytes(message: Message): number {
  let chars = message.content?.length ?? 0
  if (message.images) for (const image of message.images) chars += image.data?.length ?? 0
  let bytes = chars * 2
  if (Array.isArray(message.thoughts)) bytes += estimateThoughtsBytes(message.thoughts)
  return bytes
}

/** Estimated heap held by a cached conversation; computed once per object. */
export function estimateConversationBytes(conversation: Conversation): number {
  const memo = conversationBytesMemo.get(conversation)
  if (memo !== undefined) return memo
  let bytes = 0
  for (const message of conversation.messages) bytes += estimateMessageBytes(message)
  conversationBytesMemo.set(conversation, bytes)
  return bytes
}

function totalBytes(cache: Map<string, Conversation>): number {
  let bytes = 0
  for (const conversation of cache.values()) bytes += estimateConversationBytes(conversation)
  return bytes
}

/** The cache with `conversation` inserted as the most recent entry. */
export function cacheConversation(state: CacheInput, conversation: Conversation): Map<string, Conversation> {
  const next = new Map(state.conversationCache)
  next.delete(conversation.id)
  next.set(conversation.id, conversation)
  let bytes = totalBytes(next)
  if (next.size <= CONVERSATION_CACHE_SIZE && bytes <= CONVERSATION_CACHE_BYTES) return next

  const pinned = pinnedIds(state, conversation.id)
  for (const [id, cached] of next) {
    if (next.size <= CONVERSATION_CACHE_SIZE && bytes <= CONVERSATION_CACHE_BYTES) break
    if (pinned.has(id)) continue
    next.delete(id)
    bytes -= estimateConversationBytes(cached)
  }
  return next
}

/** Thoughts that were read on demand and can be read again (v1 inline thoughts cannot). */
function isReloadable(message: Message): boolean {
  return !!message.thoughtsSummary && Array.isArray(message.thoughts)
}

/**
 * The cache with `thoughts` loaded into one message, keeping all on-demand
 * thoughts within budget. The message just loaded is never dropped; the
 * conversation on screen is trimmed last, farthest from that message first.
 */
export function cacheLoadedThoughts(
  state: CacheInput,
  conversationId: string,
  messageId: string,
  thoughts: Thought[],
): Map<string, Conversation> {
  const conversation = state.conversationCache.get(conversationId)
  if (!conversation) return state.conversationCache
  const next = new Map(state.conversationCache)
  next.set(conversationId, {
    ...conversation,
    messages: conversation.messages.map(m => m.id === messageId ? { ...m, thoughts } : m),
  })

  const candidates: Array<{ conversationId: string; messageId: string; bytes: number; rank: number }> = []
  let bytes = 0
  const onScreen = new Set([conversationId, selectActiveConversationId(state)])
  let age = 0
  for (const [id, cached] of next) {
    const anchor = id === conversationId ? cached.messages.findIndex(m => m.id === messageId) : cached.messages.length
    cached.messages.forEach((message, index) => {
      if (!isReloadable(message)) return
      const size = estimateThoughtsBytes(message.thoughts as Thought[])
      bytes += size
      if (id === conversationId && message.id === messageId) return
      if (isThoughtsPanelOpen(message.id)) return
      // Other conversations by cache age first, then the ones on screen by distance.
      const rank = onScreen.has(id) ? Number.MAX_SAFE_INTEGER - Math.abs(index - anchor) : age
      candidates.push({ conversationId: id, messageId: message.id, bytes: size, rank })
    })
    age++
  }
  if (bytes <= LOADED_THOUGHTS_BYTES) return next

  candidates.sort((a, b) => a.rank - b.rank)
  const drop = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    if (bytes <= LOADED_THOUGHTS_BYTES) break
    bytes -= candidate.bytes
    const ids = drop.get(candidate.conversationId) ?? new Set<string>()
    ids.add(candidate.messageId)
    drop.set(candidate.conversationId, ids)
  }
  for (const [id, ids] of drop) {
    const cached = next.get(id)!
    next.set(id, { ...cached, messages: cached.messages.map(m => ids.has(m.id) ? { ...m, thoughts: null } : m) })
  }
  return next
}

const NO_THOUGHTS: Thought[] = []

/**
 * What the store keeps under critical memory pressure: the conversations it
 * must not evict (on screen, current pointers, selected digital humans,
 * running turns), with on-demand thoughts only for the one on screen; and
 * the finished turns' step lists only for the conversation on screen.
 * Everything dropped is re-read from disk when shown again.
 */
export function shedBackgroundDetail(state: CacheInput): Pick<ChatState, 'conversationCache' | 'sessions'> {
  const active = selectActiveConversationId(state)
  const keep = pinnedIds(state, active ?? '')
  const conversationCache = new Map<string, Conversation>()
  for (const [id, conversation] of state.conversationCache) {
    if (!keep.has(id)) continue
    const shed = id !== active && conversation.messages.some(isReloadable)
    conversationCache.set(id, shed
      ? { ...conversation, messages: conversation.messages.map(m => isReloadable(m) ? { ...m, thoughts: null } : m) }
      : conversation)
  }
  const sessions = new Map(state.sessions)
  for (const [id, session] of state.sessions) {
    if (id !== active && !session.isGenerating && session.thoughts.length > 0) {
      sessions.set(id, { ...session, thoughts: NO_THOUGHTS })
    }
  }
  return { conversationCache, sessions }
}
