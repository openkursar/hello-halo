/**
 * TeamMemberMessage — a team member's report (or a collaboration status
 * notice) delivered into the coordinating space conversation.
 *
 * Mirrors CrossConversationMessage's separation rules: left aligned, muted
 * fill, small type — three independent signals that this is not the user
 * speaking. Collapsed to one line by default; the model always received the
 * full body regardless of this UI state.
 *
 * `inProcess` draws one received while a reply was being written, as a row of
 * that reply's process timeline (which supplies the icon and the spacing): the
 * reply's work, not a turn it started.
 */

import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronRight, Users } from 'lucide-react'
import type { Message } from '../../../types'
import { useTranslation } from '../../../i18n'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { formatTimeAgo } from '../../../utils/format-time'
import { readTeamProvenance } from './message-source'

/** Same "still unhandled" auto-expand window CrossConversationMessage uses. */
const FRESH_DELIVERY_MS = 5_000

/**
 * Where a team message sits in a run of consecutive ones from the same team.
 * Each stays its own transcript row; the first draws the box's top and the team
 * header, the last its bottom.
 */
export type TeamRunPosition = 'single' | 'first' | 'middle' | 'last'

const RUN_SHAPE: Record<TeamRunPosition, string> = {
  single: 'rounded-lg border pt-2.5 pb-2',
  first: 'rounded-t-lg border-x border-t pt-2.5',
  middle: 'border-x',
  last: 'rounded-b-lg border-x border-b pb-2',
}

interface TeamMemberMessageProps {
  message: Message
  inProcess?: boolean
  runPosition?: TeamRunPosition
}

export function TeamMemberMessage({ message, inProcess = false, runPosition = 'single' }: TeamMemberMessageProps) {
  const { t } = useTranslation()
  const provenance = readTeamProvenance(message)

  const [isFresh, setIsFresh] = useState(
    () => !inProcess && Date.now() - new Date(message.timestamp).getTime() < FRESH_DELIVERY_MS
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

  const time = formatTimeAgo(new Date(message.timestamp).getTime(), t)
  const summary = message.metadata?.summary || (message.content.split('\n').find(line => line.trim()) ?? '')

  if (inProcess) {
    const label = provenance.fromMemberName
      ? t('{{member}} · {{team}}', { member: provenance.fromMemberName, team: provenance.teamName })
      : t('Team update · {{team}}', { team: provenance.teamName })
    return (
      <div className="w-full min-w-0" data-message-id={message.id}>
        <button
          onClick={() => setIsExpanded(v => !v)}
          aria-expanded={isExpanded}
          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/25"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-muted-foreground/60 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
          <span className="max-w-[55%] truncate text-xs font-medium text-muted-foreground">{label}</span>
          <span className="text-xs text-muted-foreground truncate min-w-0">{summary}</span>
          <span className="hidden sm:inline shrink-0 text-muted-foreground/40 text-[10px]">·</span>
          <span className="hidden sm:inline shrink-0 text-[10px] text-muted-foreground/55">{time}</span>
        </button>
        {isExpanded && (
          <div className="px-2.5 pb-2">
            <div className="text-[13px] leading-[1.7] text-foreground/[0.88] whitespace-pre-wrap break-words">
              {message.content}
            </div>
            <div className="mt-2 pt-1.5 border-t border-dashed border-border-faint
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
    )
  }

  // Drawn like the team panel: a run of one team's messages shares one box and one
  // team header, each message a member row. Only a message that just arrived lights its dot.
  const startsRun = runPosition === 'single' || runPosition === 'first'
  return (
    <div
      className={`border-border-faint bg-muted/30 px-1.5 ${RUN_SHAPE[runPosition]} ${startsRun ? 'animate-fade-in' : ''}`}
      data-message-id={message.id}
    >
      {startsRun && (
        <div className="flex items-center gap-2 px-1.5 pb-1 text-xs text-muted-foreground">
          <Users className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium truncate">{t('Team')}: {provenance.teamName}</span>
          <button
            onClick={() => void canvasLifecycle.openTeam(provenance.teamId, provenance.teamName)}
            className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            {t('Open team view')}
            <ArrowUpRight size={11} />
          </button>
        </div>
      )}
      <button
        onClick={() => setIsExpanded(v => !v)}
        aria-expanded={isExpanded}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-secondary/60"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 transition-colors ${isFresh ? 'bg-primary' : 'bg-muted-foreground/50'}`} />
        <span className="shrink-0 max-w-[120px] truncate text-sm font-medium text-foreground">
          {provenance.fromMemberName || t('Team update')}
        </span>
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
        <span className="hidden sm:inline shrink-0 text-[10px] text-muted-foreground/60">{time}</span>
        <ChevronRight
          size={12}
          className={`shrink-0 text-muted-foreground/60 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
        />
      </button>
      {isExpanded && (
        <div className="pl-[1.375rem] pr-1.5 pb-2 animate-slide-down">
          <div className="text-[13px] leading-[1.7] text-foreground/[0.88] whitespace-pre-wrap break-words">
            {message.content}
          </div>
          <div className="mt-2 pt-1.5 border-t border-dashed border-border-faint text-[10px] text-muted-foreground/80">
            {t('Sent by a team member, not by you')}
          </div>
        </div>
      )}
    </div>
  )
}
