/**
 * The sender line of a reply that teammates' deliveries started: "Halo ·
 * Received a report from X ›". The deliveries are the reply's cause, as a
 * user's message is, so they are drawn on it rather than as cards of their own;
 * expanding shows them in full.
 */

import { useEffect, useState } from 'react'
import { ChevronRight, Users } from 'lucide-react'
import type { Message } from '../../../types'
import { useTranslation } from '../../../i18n'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { formatTimeAgo } from '../../../utils/format-time'
import { readTeamProvenance } from './message-source'

/** A request to show one of the openers, e.g. from a search jump; a new object per request. */
export interface OpenerReveal {
  messageId: string
}

interface ReplyOpenersProps {
  senderName?: string
  openers: readonly Message[]
  reveal?: OpenerReveal
}

export function ReplyOpeners({ senderName, openers, reveal }: ReplyOpenersProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(!!reveal)
  useEffect(() => {
    if (reveal) setIsExpanded(true)
  }, [reveal])
  const team = readTeamProvenance(openers[0])
  const members = [...new Set(openers.map(message => readTeamProvenance(message)?.fromMemberName).filter(Boolean))] as string[]

  const label = members.length === 0
    ? t('Received a team update')
    : members.length === 1
      ? t('Received a report from {{member}}', { member: members[0] })
      : t('Received reports from {{member}} and {{count}} more', { member: members[0], count: members.length - 1 })

  return (
    <div className="mb-2">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {senderName && <span className="shrink-0 font-medium">{senderName}</span>}
        {senderName && <span className="shrink-0 text-faint-foreground">·</span>}
        <button
          onClick={() => setIsExpanded(v => !v)}
          aria-expanded={isExpanded}
          className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-foreground"
        >
          <Users size={12} className="shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronRight size={12} className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </button>
      </div>
      {isExpanded && (
        <div className="-mx-3 mt-1.5 mb-2 rounded-lg bg-card/50 px-3 py-2.5 animate-slide-down">
          <div className="space-y-3">
            {openers.map(message => (
              <div key={message.clientKey ?? message.id} data-message-id={message.id}>
                <div className="mb-0.5 flex items-center gap-1.5 text-xs">
                  <span className="font-medium text-muted-foreground">
                    {readTeamProvenance(message)?.fromMemberName || t('Team update')}
                  </span>
                  <span className="text-faint-foreground">{formatTimeAgo(new Date(message.timestamp).getTime(), t)}</span>
                </div>
                <div className="text-[13px] leading-[1.7] text-foreground/[0.88] whitespace-pre-wrap break-words">
                  {message.content}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-dashed border-border-faint pt-1.5 text-[10px] text-muted-foreground/80">
            <span>{t('Sent by a team member, not by you')}</span>
            {team && (
              <>
                <span>·</span>
                <button
                  onClick={() => void canvasLifecycle.openTeam(team.teamId, team.teamName)}
                  className="text-primary hover:underline"
                >
                  {t('Open team view')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
