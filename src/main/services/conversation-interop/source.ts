/**
 * Cross-Conversation Interop — conversation sources.
 *
 * Everything this module does to a conversation — list it, read it, ask
 * whether it is mid-turn, hand it a message, learn that its turn ended, leave
 * a note in it — goes through a `ConversationSource`. A source is the one place
 * that knows where a kind of conversation lives and how its turns run; the
 * module's own rules (reply matching, circuit breaker, queueing, paging,
 * reference resolution) are written once, against this interface.
 *
 * The built-in source covers the space's own conversations (`chat-source.ts`).
 * Conversations owned by a higher tier — a digital human's chats live in
 * `apps/runtime` — reach the module by registering a source here at bootstrap:
 * this module declares the slot and never imports upward.
 *
 * Conversation ids are unique across sources (a uuid versus an `app-chat:` key),
 * which is what lets every id-only question (busy, turn end, delivery routing)
 * find its source without a space or a source name.
 */

import { Emitter, toDisposable, type Event, type IDisposable } from '../../platform/event'
import type { TranscriptProvenanceMetadata, TranscriptSource } from '../../../shared/types/transcript'
import type { TranscriptLine } from './types'

const LOG_TAG = '[ConversationInterop]'

/** What a source knows about one of its conversations. */
export interface SourceConversation {
  /** The id every tool argument and result uses. Unique across sources. */
  id: string
  title: string
  updatedAt: string
  messageCount: number
  /**
   * Why another conversation's AI may not take part in this one right now, e.g.
   * "this digital human has conversation collaboration turned off". Absent means
   * it may. A source only reports this; `admission.ts` is what acts on it, and
   * only for AI-driven access — a user's own features (search) read the
   * conversation regardless.
   */
  unavailable?: string
}

/** What a delivery leaves behind, versus what the recipient's model reads. */
export interface DispatchedMessage {
  /** Exactly what the recipient's model reads as this turn's input. */
  turnInput: string
  /** What the recipient's transcript keeps for the message. */
  record: { content: string; source: TranscriptSource; metadata: TranscriptProvenanceMetadata }
}

export interface DispatchOutcome {
  /**
   * The persisted id of the recorded message, when the source can name it.
   * Absent is honest: some transcripts assign ids only once read back.
   */
  messageId?: string
}

export interface ConversationSource {
  /** Stable name, unique per registered source. Also the replacement key. */
  readonly kind: string
  /**
   * Extra qualifier a list line carries so a reader can tell this source's
   * conversations apart (e.g. "digital human"). Absent for the space's own.
   */
  readonly label?: string
  /**
   * Whether another conversation may read this source's transcripts / write
   * into them. A source that is not readable is invisible to listing, reading
   * and reference resolution; one that is not writable refuses deliveries.
   */
  readonly capabilities: { readonly readable: boolean; readonly writable: boolean }
  /** Model-facing reason a send to this source is refused when it is not writable. */
  readonly whyNotWritable?: string

  /** Syntactic: does this id belong to this source. Must not do I/O. */
  owns(conversationId: string): boolean
  /**
   * Every conversation the source owns in a space, including ones another
   * conversation's AI may not take part in (those carry `unavailable`). No order
   * is assumed.
   */
  list(spaceId: string): SourceConversation[]
  /** Null when the conversation does not exist in the space. */
  getMeta(spaceId: string, conversationId: string): SourceConversation | null
  /**
   * The short handle a `[#Title](conv:<ref>)` reference carries. Collisions
   * between conversations are legal and resolved by the ambiguity flow.
   */
  shortRef(conversationId: string): string
  /** The clean transcript, oldest first — never the thinking/tool stream. Null when not found. */
  readTranscript(spaceId: string, conversationId: string): TranscriptLine[] | null

  /** A turn is running or about to (a dispatched message not yet picked up counts). */
  isBusy(conversationId: string): boolean
  /**
   * Whether the engine still has ANY live session for the conversation, busy or
   * idle. Used to tell a turn genuinely still starting from a reservation left
   * behind by one that died before reporting anything.
   */
  hasLiveSession(conversationId: string): boolean
  /**
   * Start a turn on the conversation with `message.turnInput` and record
   * `message.record` in its transcript. Resolves once the engine has been
   * handed the message — NOT when the turn finishes. Rejects when the turn
   * could not be started.
   */
  dispatch(spaceId: string, conversationId: string, message: DispatchedMessage): Promise<DispatchOutcome>
  /**
   * Fires for every turn ending on one of this source's conversations —
   * success, failure, or abort — after `isBusy` can already read false.
   */
  onTurnEnd(listener: (conversationId: string) => void): IDisposable
  /** Leave a system notice in the conversation (e.g. a rate-limit pause). Best effort. */
  writeNotice(spaceId: string, conversationId: string, content: string): void
}

// ============================================
// Registry
// ============================================

const sources = new Map<string, ConversationSource>()

type SourceChange = { type: 'registered' | 'unregistered'; source: ConversationSource }
const changes = new Emitter<SourceChange>()

/**
 * Register a source. Registering a kind that already exists replaces it (the
 * previous one is announced as unregistered first), so a re-initialised upper
 * tier never leaves two sources answering for the same conversations.
 *
 * Order relative to `initConversationInterop` does not matter: sources
 * registered later are wired into turn-end handling as they arrive.
 */
export function registerConversationSource(source: ConversationSource): IDisposable {
  const previous = sources.get(source.kind)
  if (previous) changes.fire({ type: 'unregistered', source: previous })
  sources.set(source.kind, source)
  console.log(`${LOG_TAG} source registered: ${source.kind} (readable=${source.capabilities.readable}, writable=${source.capabilities.writable})`)
  changes.fire({ type: 'registered', source })

  return toDisposable(() => {
    if (sources.get(source.kind) !== source) return
    sources.delete(source.kind)
    console.log(`${LOG_TAG} source unregistered: ${source.kind}`)
    changes.fire({ type: 'unregistered', source })
  })
}

export function getConversationSources(): ConversationSource[] {
  return [...sources.values()]
}

/** The source that owns `conversationId`, if any is registered for it. */
export function sourceOfConversation(conversationId: string): ConversationSource | null {
  for (const source of sources.values()) {
    if (source.owns(conversationId)) return source
  }
  return null
}

/** Sources whose transcripts other conversations may see. */
export function getReadableSources(): ConversationSource[] {
  return getConversationSources().filter((s) => s.capabilities.readable)
}

/**
 * `source.list` for callers merging several sources: one source failing must
 * not take the others' conversations with it, so its failure is logged and it
 * contributes nothing.
 */
export function listSourceConversations(source: ConversationSource, spaceId: string): SourceConversation[] {
  try {
    return source.list(spaceId)
  } catch (err) {
    console.error(`${LOG_TAG} source ${source.kind} failed to list space ${spaceId}:`, err)
    return []
  }
}

export const onDidChangeConversationSources: Event<SourceChange> = changes.event
