/**
 * QueuedMessagesPanel - Shows user messages queued for mid-turn injection.
 *
 * Displayed below StreamingBubble while agent generation is active.
 * Each entry represents a message sent by the user during a running turn;
 * agent:input-arrived replaces it with the accepted input annotation.
 */

import { useTranslation } from '../../i18n'
import type { QueuedMessage } from '../../types'
import { MessageImages } from './ImageAttachmentPreview'

interface QueuedMessagesPanelProps {
  messages: QueuedMessage[]
}

export function QueuedMessagesPanel({ messages }: QueuedMessagesPanelProps) {
  const { t } = useTranslation()

  if (messages.length === 0) return null

  return (
    // The same quiet surface as the reply boxes above it.
    <div className="mt-2 rounded-lg border border-border-soft bg-card px-3.5 py-2">
      <div className="flex items-center gap-1.5 mb-1 text-xs text-faint-foreground select-none">
        <span>{t('Queued')}</span>
      </div>
      <div className="space-y-0.5">
        {messages.map((msg, i) => (
          <div key={i} className="flex items-start gap-1.5 text-xs text-subtle-foreground">
            <span className="mt-px shrink-0 select-none">↳</span>
            <div className="min-w-0 flex-1 flex flex-wrap items-center gap-1.5 [&_.h-7]:h-6 [&_.text-foreground]:text-inherit [&_.text-muted-foreground]:text-inherit">
              {!!msg.images?.length && <MessageImages images={msg.images} presentation="chips" />}
              {(msg.summary || !msg.images?.length) && (
                <span className="break-words">{msg.summary || t('References')}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
