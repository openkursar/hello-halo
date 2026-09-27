/**
 * TeamMemberMessage — a team member's report (or a collaboration status
 * notice) delivered into the coordinating space conversation.
 *
 * Mirrors CrossConversationMessage's separation rules: left aligned, muted
 * fill, small type — three independent signals that this is not the user
 * speaking. Collapsed to one line by default; the model always received the
 * full body regardless of this UI state.
 */

import { useEffect, useState } from 'react'
import { ChevronRight, Users } from 'lucide-react'
import type { Message } from '../../../types'
import { useTranslation } from '../../../i18n'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { formatTimeAgo } from '../../../utils/format-time'
import { readTeamProvenance } from './message-source'

/** Same "still unhandled" auto-expand window CrossConversationMessage uses. */
const FRESH_DELIVERY_MS = 5_000

interface TeamMemberMessageProps {
  message: Message
}

export function TeamMemberMessage({ message }: TeamMemberMessageProps) {
  const { t } = useTranslation()
  const provenance = readTeamProvenance(message)

  const [isFresh, setIsFresh] = useState(
    () => Date.now() - new Date(message.timestamp).getTime() < FRESH_DELIVERY_MS
  )
  const [isExpanded, setIsExpanded] = useState(isFresh)

  useEffect(() => {
    if (!isFresh) return
    const timer = setTimeout(() => {
      setIsFresh(false)
      setIsExpanded(false)
    }, FRESH_DELIVERY_MS)
    return () => clearTimeout(timer)
  }, [isFresh])

  if (!provenance) return null

  const label = provenance.fromMemberName
    ? t('{{member}} · {{team}}', { member: provenance.fromMemberName, team: provenance.teamName })
    : t('Team update · {{team}}', { team: provenance.teamName })
  const time = formatTimeAgo(new Date(message.timestamp).getTime(), t)

  return (
    <div className="flex justify-start animate-fade-in" data-message-id={message.id}>
      <div className="max-w-[85%] min-w-0 rounded-xl bg-muted/15 border border-border/60 overflow-hidden">
        <button
          onClick={() => setIsExpanded(v => !v)}
          className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors
            hover:bg-muted/25 ${isFresh ? 'border-b border-primary/35' : ''}`}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-muted-foreground/60 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
          <span
            className={`shrink-0 w-4 h-4 rounded-[5px] flex items-center justify-center
              ${isFresh ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary'}`}
          >
            <Users size={9} />
          </span>
          <span className="shrink-0 text-xs font-semibold text-primary/90">{label}</span>
          <span className="text-xs text-muted-foreground truncate min-w-0">
            {message.content.split('\n').find(line => line.trim()) ?? ''}
          </span>
          <span className="shrink-0 text-muted-foreground/40 text-[10px]">·</span>
          <span className="shrink-0 text-[10px] text-muted-foreground/55">{time}</span>
        </button>

        {isExpanded && (
          <div className="px-2.5 pb-2 animate-slide-down">
            <div className="text-[13px] leading-[1.7] text-foreground/[0.88] whitespace-pre-wrap break-words">
              {message.content}
            </div>
            <div className="mt-2 pt-1.5 border-t border-dashed border-border/50
              flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px] text-muted-foreground/80">
              <span>{t('Sent by a team member, not by you')}</span>
              <span>·</span>
              <button
                onClick={() => void canvasLifecycle.openTeam(provenance.teamId, provenance.teamName)}
                className="text-primary hover:underline"
              >
                {t('Open team view')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
