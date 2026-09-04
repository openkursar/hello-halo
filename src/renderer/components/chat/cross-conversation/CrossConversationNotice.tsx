/**
 * CrossConversationNotice — a system line written into the SENDING conversation
 * when its outbound deliveries were cut off (circuit breaker cooldown).
 *
 * The wording comes from the backend as plain content: the user is told directly
 * rather than through the model, so nothing here reinterprets it.
 * Quiet, centered, non-interactive — same register as CompactNotice.
 */

import { CircleSlash } from 'lucide-react'
import type { Message } from '../../../types'

interface CrossConversationNoticeProps {
  message: Message
}

export function CrossConversationNotice({ message }: CrossConversationNoticeProps) {
  return (
    <div className="flex justify-center my-3" data-message-id={message.id}>
      <div className="inline-flex max-w-[85%] items-center gap-2 px-4 py-2
        bg-secondary/50 rounded-full text-xs text-muted-foreground">
        <CircleSlash size={12} className="shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 break-words">{message.content}</span>
      </div>
    </div>
  )
}
