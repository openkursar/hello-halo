/**
 * QueuedMessagesPanel - Shows user messages queued for mid-turn injection.
 *
 * Displayed below StreamingBubble while agent generation is active.
 * Each entry represents a message sent by the user during a running turn;
 * the CC subprocess will deliver it at the next tool round boundary.
 *
 * Disappears automatically when agent:complete clears queuedMessages.
 */

import { useTranslation } from '../../i18n'

interface QueuedMessagesPanelProps {
  messages: string[]
}

export function QueuedMessagesPanel({ messages }: QueuedMessagesPanelProps) {
  const { t } = useTranslation()

  if (messages.length === 0) return null

  return (
    <div className="mt-2 rounded-lg border border-border/20 bg-muted/15 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1 text-[10px] text-muted-foreground/50 select-none uppercase tracking-wide">
        <span>{t('Queued')}</span>
      </div>
      <div className="space-y-0.5">
        {messages.map((msg, i) => (
          <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground/60">
            <span className="mt-px shrink-0 select-none">↳</span>
            {/* A message of cards that name nothing (an untitled conversation's passage) */}
            <span className="break-words min-w-0">{msg || t('References')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
