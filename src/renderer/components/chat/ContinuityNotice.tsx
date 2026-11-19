/**
 * A one-line notice about how this conversation continues: the engine could not
 * restore its own record of earlier turns, connection accounts changed, or the
 * conversation's workspace was deleted or could not be found. Shown in Halo
 * only; IM parties never receive it.
 */

import { History } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { Message } from '../../types'
import { WORKSPACE_NOTICE_TEXT } from '../../../shared/transcript'

export function isContinuityNotice(message: Message): boolean {
  return message.role === 'system' && (message.source === 'continuity-notice'
    || message.source === 'environment-notice' || message.source === 'workspace-notice')
}

export function ContinuityNotice({ message }: { message: Message }) {
  const { t } = useTranslation()
  const text = message.source === 'environment-notice'
    ? t('Connections changed. This conversation will continue with the accounts currently available in this workspace.')
    : message.source === 'workspace-notice'
      ? message.content === WORKSPACE_NOTICE_TEXT.deleted
        ? t('The workspace this conversation was in was deleted. It continues in the digital human\u2019s current workspace with its memory and history.')
        : t('The previous workspace is unavailable. This conversation continues in the digital human\u2019s current workspace; messages and memory at the old location may be unavailable.')
      : t('Some earlier details could not be restored exactly; the conversation continues from its record.')
  return (
    <div className="flex justify-center my-3" data-message-id={message.id}>
      <div className="inline-flex max-w-[85%] items-center gap-2 px-4 py-2
        bg-secondary/50 rounded-full text-xs text-muted-foreground">
        <History size={12} className="shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 break-words">{text}</span>
      </div>
    </div>
  )
}
