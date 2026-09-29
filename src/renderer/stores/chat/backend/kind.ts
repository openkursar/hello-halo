/**
 * Which kind of conversation an id names.
 *
 * The one place the chat store reads the shape of a conversation id. Every
 * other store module asks `conversationKind` (or goes through `backendFor`) —
 * a second copy of these prefix checks is how the two chat surfaces drifted
 * apart before.
 *
 * - `space`: a conversation stored by the space (`conversation.service`).
 * - `digital-human`: a chat with a digital human the user opens on the main
 *   board — the digital human's default session or one of its local sessions.
 *   Read through the digital-human transcript reader.
 * - `virtual`: any other digital-human session key (IM chat, HTTP, team
 *   member). Their live turn is tracked here, but the transcript belongs to
 *   the surface that shows it (IM view, team view), never the chat cache.
 */
import { isAppChatKey, nativeChatAppId } from '../../../../shared/apps/im-keys'

export type ConversationKind = 'space' | 'digital-human' | 'virtual'

/** The digital human a chat-board conversation belongs to; null for other kinds. */
export function digitalHumanAppId(conversationId: string): string | null {
  return nativeChatAppId(conversationId)
}

export function conversationKind(conversationId: string): ConversationKind {
  if (digitalHumanAppId(conversationId)) return 'digital-human'
  return isAppChatKey(conversationId) ? 'virtual' : 'space'
}
