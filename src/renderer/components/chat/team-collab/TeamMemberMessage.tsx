/**
 * TeamMemberMessage — a team member's report (or a collaboration status
 * notice) received while a reply was being written: the reply's work, not a
 * turn it started. Anywhere else a team's messages read as the received line
 * (ReplyOpeners).
 *
 * Collapsed to one line by default; the model always received the full body
 * regardless of this UI state.
 *
 * `inProcess` draws it as a line of that reply's work, shaped like the
 * operations around it.
 */

import { useState } from 'react'
import { Users } from 'lucide-react'
import type { Message } from '../../../types'
import { getCurrentLanguage, useTranslation } from '../../../i18n'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { readTeamProvenance } from './message-source'
import { clipSubject, PROCESS_CUE, PROCESS_DETAIL, PROCESS_LINE } from '../process-line'

interface TeamMemberMessageProps {
  message: Message
  inProcess?: boolean
}

export function TeamMemberMessage({ message, inProcess = false }: TeamMemberMessageProps) {
  const { t } = useTranslation()
  const provenance = readTeamProvenance(message)
  const [isExpanded, setIsExpanded] = useState(false)

  if (!provenance) return null

  const summary = message.metadata?.summary || (message.content.split('\n').find(line => line.trim()) ?? '')

  if (inProcess) {
    // A notice the runtime wrote for the coordinating AI is named for what it is, not by its opening words.
    const notice = !provenance.fromMemberName
    const subject = notice ? message.metadata?.summary : summary
    return (
      <div className="min-w-0" data-message-id={message.id}>
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
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">{clipSubject(subject).text}</span>
          </> : (
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">{notice ? t('Team progress') : provenance.fromMemberName}</span>
          )}
          <span aria-hidden="true" className={PROCESS_CUE}>{isExpanded ? t('Collapse') : t('View')}</span>
        </button>
        {isExpanded && (
          <div className={PROCESS_DETAIL}>
            <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-foreground/[0.88]">
              {message.content}
            </div>
            <div className="mt-1 flex min-h-6 flex-wrap items-center gap-x-1 text-[11px] text-faint-foreground">
              <span>{t('Sent by a team member, not by you')}</span>
              <span>·</span>
              <button
                type="button"
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

  const time = new Date(message.timestamp).toLocaleTimeString(getCurrentLanguage(), {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const label = provenance.fromMemberName || t('Team update')
  return (
    <div className="w-full min-w-0" data-message-id={message.id}>
      <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
        <span className="min-w-0 truncate font-medium text-muted-foreground">{label}</span>
        <span className="shrink-0 text-[11px] text-faint-foreground">· {time}</span>
      </div>
      {!isExpanded ? (
        <button
          onClick={() => setIsExpanded(true)}
          aria-expanded={false}
          className="mt-0.5 block w-full min-w-0 truncate text-left text-[13px] leading-5 text-muted-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="inline-block max-w-[calc(100%-4rem)] truncate align-bottom">{summary}</span>{' '}
          <span className="text-xs text-primary">{t('Expand')}</span>
        </button>
      ) : (
        <div className="pb-2">
          <div className="text-[13px] leading-[1.7] text-foreground/[0.88] whitespace-pre-wrap break-words">
            {message.content}{' '}
            <button
              onClick={() => setIsExpanded(false)}
              aria-expanded={true}
              className="text-xs text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {t('Collapse')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
