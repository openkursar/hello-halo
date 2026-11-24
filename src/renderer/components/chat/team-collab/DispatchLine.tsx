/**
 * The line under a reply that handed work on: "Lead · Sent a message to X ›". It is
 * the counterpart of the openers line — what the reply sent rather than what
 * started it — styled the same, and expands to the messages in full.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { CollabQuotes } from './CollabQuotes'
import type { OpenerReveal } from './ReplyOpeners'

export interface DispatchItem {
  id: string
  to: string
  at: number
  content: string
  onOpen?: () => void
}

export function DispatchLine({ senderName, items, footer, reveal }: { senderName?: string; items: readonly DispatchItem[]; footer: ReactNode; reveal?: OpenerReveal }) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(!!reveal)
  useEffect(() => {
    if (reveal) setIsExpanded(true)
  }, [reveal])
  const members = [...new Set(items.map(item => item.to))]
  const label = members.length === 1
    ? t('Sent a message to {{member}}', { member: members[0] })
    : t('Sent messages to {{member}} and {{count}} others', { member: members[0], count: members.length - 1 })

  // Spaced as a row of its own: mb-7 matches the room a reply keeps for its hover actions.
  return (
    <div className="mt-8 mb-7">
      <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
        {senderName && <span className="shrink-0 text-sm font-semibold text-foreground">{senderName}</span>}
        {senderName && <span className="shrink-0 text-faint-foreground">·</span>}
        <button
          onClick={() => setIsExpanded(v => !v)}
          aria-expanded={isExpanded}
          className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-foreground"
        >
          <span className="truncate">{label}</span>
          <ChevronRight size={12} className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </button>
      </div>
      {isExpanded && (
        <CollabQuotes
          quotes={items.map(item => ({ key: item.id, messageId: item.id, label: t('To {{member}}', { member: item.to }), onOpen: item.onOpen, at: item.at, content: item.content }))}
          footer={footer}
        />
      )}
    </div>
  )
}
