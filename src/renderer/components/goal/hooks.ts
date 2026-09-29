import { useEffect, useState } from 'react'
import { useChatStore } from '../../stores/chat.store'
import { formatTimeAgo } from '../../utils/format-time'
import { useTranslation } from '../../i18n'

/** Whether a turn is running in the conversation. */
export function useConversationRunning(conversationId: string): boolean {
  return useChatStore((s) => s.sessions.get(conversationId)?.isGenerating ?? false)
}

/** "4m ago" for an ISO timestamp, kept fresh while mounted. */
export function useTimeAgo(iso: string | undefined): string {
  const { t } = useTranslation()
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  if (!iso) return ''
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '' : formatTimeAgo(time, t)
}
