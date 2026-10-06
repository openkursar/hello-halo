/**
 * The line above a message the digital human sent to a chat on its own — a
 * `notify_bot` message, a run's result, a question for the owner — so it does
 * not read as the answer to the message before it.
 */

import { Send } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { Message } from '../../types'
import type { ChatPushVia } from '../../../shared/types/transcript'

export function isPushedMessage(message: Message): boolean {
  return message.role === 'assistant' && message.source === 'push'
}

export function PushedMessageLabel({ via }: { via?: ChatPushVia }) {
  const { t } = useTranslation()
  const text = via === 'result'
    ? t('Sent proactively · result of a run')
    : via === 'question'
      ? t('Sent proactively · question for the owner')
      : t('Sent proactively')
  return (
    <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
      <Send className="h-3 w-3" />
      <span>{text}</span>
    </div>
  )
}
