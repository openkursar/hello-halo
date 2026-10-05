import { useLayoutEffect } from 'react'
import { useChatStore } from '../stores/chat.store'

/** Selection survives leaving the chat; visibility belongs to its mounted view. */
export function useVisibleConversation(conversationId: string | null): void {
  useLayoutEffect(() => {
    useChatStore.getState().setVisibleConversation(conversationId)
    const onForeground = () => useChatStore.getState().readActiveCompletion()
    window.addEventListener('focus', onForeground)
    document.addEventListener('visibilitychange', onForeground)
    return () => {
      window.removeEventListener('focus', onForeground)
      document.removeEventListener('visibilitychange', onForeground)
      useChatStore.getState().setVisibleConversation(null)
    }
  }, [conversationId])
}
