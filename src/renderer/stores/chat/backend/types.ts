/**
 * What a chat backend does for the chat store.
 *
 * A conversation lives in one of two stores (space conversations, digital-human
 * sessions) but the page over it is one. The store's actions therefore never
 * talk to a store directly: they resolve the id to a backend (`backendFor`) and
 * call the same verbs on it. The verbs are exactly what differs between the two
 * — where a transcript is read from, where a message is sent, what "clear"
 * means — and nothing else.
 */
import type { ChatGet, ChatSet, ImageAttachment, Thought } from '../internal'
import type { SendMessageOptions } from '../internal'

export interface BackendContext {
  set: ChatSet
  get: ChatGet
}

export interface ConversationRef {
  spaceId: string
  conversationId: string
}

export interface SendRequest {
  content: string
  images?: ImageAttachment[]
  thinkingEnabled?: boolean
  options?: SendMessageOptions
}

export interface ChatBackend {
  /**
   * Make the conversation ready to show: read it into the cache if it is not
   * there, and pick up a turn that is already running. Never blocks the caller
   * on a cached conversation.
   */
  open(ctx: BackendContext, ref: ConversationRef): Promise<void>

  /** Re-read after events may have been missed (reconnect); keeps what the view shows in place. */
  refresh(ctx: BackendContext, ref: ConversationRef): Promise<void>

  /** Resolves false when the message was refused before it was recorded. */
  send(ctx: BackendContext, conversationId: string, request: SendRequest): Promise<boolean>

  stop(ctx: BackendContext, conversationId: string): Promise<void>

  /** Add a message to the turn that is running. */
  inject(ctx: BackendContext, conversationId: string, message: string): Promise<void>

  /** Turn ended: replace the streamed turn with its persisted form in one commit. */
  settleTurn(ctx: BackendContext, ref: ConversationRef, turnId: number): Promise<void>

  loadThoughts(ctx: BackendContext, ref: ConversationRef, messageId: string): Promise<Thought[]>

  /** Read the next older page into the conversation; no-op when everything is loaded. */
  loadEarlier(ctx: BackendContext, ref: ConversationRef): Promise<void>

  /**
   * Make sure a message is among the loaded ones (a search result, however old).
   * A conversation that is read whole always has it.
   */
  loadThrough(ctx: BackendContext, ref: ConversationRef, messageId: string): Promise<void>

  /**
   * Empty the conversation's history in place. Only where the conversation
   * outlives its history (a digital human's default session); a space
   * conversation is deleted instead.
   */
  clear?(ctx: BackendContext, ref: ConversationRef): Promise<boolean>
}
