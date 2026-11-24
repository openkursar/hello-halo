/**
 * TeamMemberMessage — a team member's report (or a collaboration status
 * notice) received while a reply was being written: the reply's work, not a
 * turn it started. Anywhere else a team's messages read as the received line
 * (ReplyOpeners).
 *
 * Drawn as a source line like CrossConversationMessage: quiet at rest, the
 * body and the way into the team view one click away. The model always
 * received the full body regardless of this UI state.
 */

import { useState } from 'react'
import { ExternalLink, Users } from 'lucide-react'
import type { Message } from '../../../types'
import { getCurrentLanguage, useTranslation } from '../../../i18n'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { formatRunStart } from '../../../utils/format-time'
import { readTeamProvenance } from './message-source'
import { clipSubject, PROCESS_CUE, PROCESS_DETAIL, PROCESS_LINE, PROCESS_TIME } from '../process-line'

interface TeamMemberMessageProps {
  message: Message
  inProcess?: boolean
}

export function TeamMemberMessage({ message, inProcess = false }: TeamMemberMessageProps) {
  const { t } = useTranslation()
  const provenance = readTeamProvenance(message)
  const [isExpanded, setIsExpanded] = useState(false)

  if (!provenance) return null

  const sentAt = new Date(message.timestamp).getTime()
  // A notice the runtime wrote for the coordinating AI is named for what it is, not by its opening words.
  const notice = !provenance.fromMemberName
  const subject = notice
    ? message.metadata?.summary
    : message.metadata?.summary || (message.content.split('\n').find(line => line.trim()) ?? '')

  return (
    <div className={inProcess ? 'min-w-0' : 'w-[85%] min-w-0'} data-message-id={message.id}>
      <button
        type="button"
        onClick={() => setIsExpanded(v => !v)}
        aria-expanded={isExpanded}
        title={notice ? provenance.teamName : t('{{member}} · {{team}}', { member: provenance.fromMemberName, team: provenance.teamName })}
        className={PROCESS_LINE}
      >
        <Users size={14} aria-hidden="true" className="shrink-0" />
        {subject ? <>
          <span className="max-w-[40%] shrink-0 truncate">{notice ? t('Team progress') : provenance.fromMemberName}</span>
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{inProcess ? clipSubject(subject).text : subject}</span>
        </> : (
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{notice ? t('Team progress') : provenance.fromMemberName}</span>
        )}
        <span aria-hidden="true" className={PROCESS_CUE}>{isExpanded ? t('Collapse') : t('View')}</span>
        {Number.isFinite(sentAt) && (
          <time dateTime={new Date(sentAt).toISOString()} className={PROCESS_TIME}>{formatRunStart(sentAt, Date.now(), getCurrentLanguage())}</time>
        )}
      </button>
      {isExpanded && (
        <div className={PROCESS_DETAIL}>
          <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-foreground/[0.88]">
            {message.content}
          </div>
          <div className="mt-1 flex min-h-6 flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-muted-foreground/80 [overflow-wrap:anywhere]">
            <span>{t('From team')}</span>
            <button
              type="button"
              title={t('Open team view')}
              onClick={() => void canvasLifecycle.openTeam(provenance.teamId, provenance.teamName)}
              className="inline-flex items-center gap-0.5 text-primary hover:underline"
            >
              {provenance.teamName}
              <ExternalLink size={9} aria-hidden="true" />
            </button>
            <span>·</span>
            <span>{t('sent by a team member, not by you')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
