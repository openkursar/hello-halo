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
import type { ChatBackend } from './types'

export function backendFor(conversationId: string): ChatBackend {
  switch (conversationKind(conversationId)) {
    case 'digital-human': return digitalHumanBackend
    case 'virtual': return virtualBackend
    case 'space': return spaceBackend
  }
}

export { conversationKind, digitalHumanAppId } from './kind'
export type { ConversationKind } from './kind'
export { digitalHumanSpaceId, deleteAppChatSession } from './digital-human'
export type { ChatBackend, ConversationRef, SendRequest, BackendContext } from './types'
