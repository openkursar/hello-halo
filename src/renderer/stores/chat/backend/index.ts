/**
 * Chat backends — the chat store's dispatch point.
 *
 * `backendFor` is the only place that turns a conversation id into a decision
 * about *where the conversation lives*. Store actions call it and speak the
 * `ChatBackend` verbs; nothing above this folder reads the shape of an
 * id to pick a code path.
 */
import { conversationKind } from './kind'
import { spaceBackend } from './space'
import { digitalHumanBackend } from './digital-human'
import { virtualBackend } from './virtual'
import type { ChatBackend, BackendContext, ConversationRef, OpenOptions } from './types'

export function backendFor(conversationId: string): ChatBackend {
  switch (conversationKind(conversationId)) {
    case 'digital-human': return digitalHumanBackend
    case 'virtual': return virtualBackend
    case 'space': return spaceBackend
  }
}

const opening = new Map<string, Promise<void>>()

/**
 * Open a conversation — read it in if uncached, pick up a running turn, warm its
 * session unless asked not to — once at a time: selecting a conversation and the page reading in the
 * uncached one on screen ask together, and a second open would repeat the
 * session probe and the warm-up, not just the read.
 */
export function openOnce(ctx: BackendContext, ref: ConversationRef, options?: OpenOptions): Promise<void> {
  const existing = opening.get(ref.conversationId)
  if (existing) return existing
  const run = backendFor(ref.conversationId)
    .open(ctx, ref, options)
    .finally(() => opening.delete(ref.conversationId))
  opening.set(ref.conversationId, run)
  return run
}

export { conversationKind, digitalHumanAppId } from './kind'
export type { ConversationKind } from './kind'
export { digitalHumanSpaceId, deleteAppChatSession } from './digital-human'
export type { ChatBackend, ConversationRef, SendRequest, BackendContext, OpenOptions } from './types'
