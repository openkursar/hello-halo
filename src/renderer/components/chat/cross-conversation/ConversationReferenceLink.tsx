/**
 * A conversation reference inside rendered Markdown, opening that conversation.
 *
 * No `href`: the reference is not a URL anything else could follow, so a
 * middle-click or "open in new window" has nothing to hand to the system.
 */

import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from '../../../i18n'
import { openConversationReference } from './open-conversation-reference'

interface ConversationReferenceLinkProps {
  shortId: string
  className?: string
  children?: ReactNode
}

export function ConversationReferenceLink({ shortId, className, children }: ConversationReferenceLinkProps) {
  const { t } = useTranslation()
  const open = () => { void openConversationReference(shortId) }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    open()
  }

  return (
    <a role="link" tabIndex={0} title={t('Open conversation')} className={`cursor-pointer ${className ?? ''}`} onClick={open} onKeyDown={onKeyDown}>
      {children}
    </a>
  )
}
