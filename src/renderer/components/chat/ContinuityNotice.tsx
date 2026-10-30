/**
 * The line written where the engine could not restore its own record of the
 * earlier turns and the reply after it continued from this conversation's
 * transcript instead. Shown in Halo only; IM parties never receive it.
 */

import { History } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { Message } from '../../types'

export function isContinuityNotice(message: Message): boolean {
  return message.role === 'system' && message.source === 'continuity-notice'
}

export function ContinuityNotice({ message }: { message: Message }) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-center my-3" data-message-id={message.id}>
      <div className="inline-flex max-w-[85%] items-center gap-2 px-4 py-2
        bg-secondary/50 rounded-full text-xs text-muted-foreground">
        <History size={12} className="shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 break-words">
          {t('Some earlier details could not be restored exactly; the conversation continues from its record.')}
        </span>
      </div>
    </div>
  )
}
