/**
 * Keeps a conversation's full streaming detail (messages, thoughts, tool events)
 * flowing to this client while the calling view is mounted — desktop and remote
 * alike. Without a holder, main delivers only status events for a conversation
 * (see shared/agent-event-visibility). Every view that renders a chat-store
 * session's live detail calls this for the conversation it shows; retention
 * follows the id when it changes and is released on unmount. Reference-counted,
 * so several views may hold one conversation. A null id holds nothing.
 */

import { useEffect } from 'react'
import { retainConversationDetail } from '../api/conversation-visibility'

export function useConversationDetail(conversationId: string | null | undefined): void {
  useEffect(() => (conversationId ? retainConversationDetail(conversationId) : undefined), [conversationId])
}
