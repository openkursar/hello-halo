/**
 * The sender line of a reply that teammates' deliveries started: "Halo ·
 * Received a message from X ›". The deliveries are the reply's cause, as a
 * user's message is, so they are drawn on it rather than as cards of their own;
 * expanding shows them in full.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import type { Message } from '../../../types'
import { useTranslation } from '../../../i18n'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { readTeamProvenance } from './message-source'
import { CollabQuotes } from './CollabQuotes'

/** A request to show one of the openers, e.g. from a search jump; a new object per request. */
export interface OpenerReveal {
  messageId: string
}

/** One delivery as the sender line lists it, whatever record it came from. */
export interface OpenerItem {
  id: string
  key?: string
  /** Null for system-authored notices. */
  from: string | null
  at: number
  content: string
  onOpen?: () => void
}

interface OpenersLineProps {
  senderName?: string
  items: readonly OpenerItem[]
  /** Closes the expanded panel: where to find the delivery elsewhere. */
  footer: ReactNode
  reveal?: OpenerReveal
}

export function OpenersLine({ senderName, items, footer, reveal }: OpenersLineProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(!!reveal)
  useEffect(() => {
    if (reveal) setIsExpanded(true)
  }, [reveal])
  const members = [...new Set(items.map(item => item.from).filter(Boolean))] as string[]

  const label = members.length === 0
    ? t('Received a team update')
    : members.length === 1
      ? t('Received a message from {{member}}', { member: members[0] })
      : t('Received messages from {{member}} and {{count}} more', { member: members[0], count: members.length - 1 })

  return (
    <div className="mb-2">
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
          quotes={items.map(item => ({ key: item.key ?? item.id, messageId: item.id, label: item.from || t('Team update'), onOpen: item.onOpen, at: item.at, content: item.content }))}
          footer={footer}
        />
      )}
    </div>
  )
}

interface ReplyOpenersProps {
  senderName?: string
  openers: readonly Message[]
  reveal?: OpenerReveal
}

export function ReplyOpeners({ senderName, openers, reveal }: ReplyOpenersProps) {
  const { t } = useTranslation()
  const team = readTeamProvenance(openers[0])
  const items = openers.map(message => ({
    id: message.id,
    key: message.clientKey ?? message.id,
    from: readTeamProvenance(message)?.fromMemberName ?? null,
    at: new Date(message.timestamp).getTime(),
    content: message.content,
  }))
  const footer = (
    <>
      <span className="text-faint-foreground">{t('Sent by a team member, not by you')}</span>
      {team && (
        <button
          onClick={() => void canvasLifecycle.openTeam(team.teamId, team.teamName)}
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          {t('Open team view')}
          <ArrowUpRight size={11} aria-hidden="true" />
        </button>
      )}
    </>
  )
  return <OpenersLine senderName={senderName} items={items} footer={footer} reveal={reveal} />
}
