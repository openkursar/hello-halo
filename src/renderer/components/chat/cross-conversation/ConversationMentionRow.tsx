/**
 * ConversationMentionRow — content of one conversation candidate inside the
 * composer's @ menu. The row button (selection, hover, keyboard focus) belongs
 * to the menu itself; only what is conversation-specific lives here.
 */

import { Bot, MessageSquare } from 'lucide-react'
import { TaskStatusDot } from '../../pulse'
import { useTranslation } from '../../../i18n'
import { formatTimeAgo } from '../../../utils/format-time'
import type { ConversationMentionCandidate } from './useConversationMentionCandidates'

interface ConversationMentionRowProps {
  candidate: ConversationMentionCandidate
}

export function ConversationMentionRow({ candidate }: ConversationMentionRowProps) {
  const { t } = useTranslation()
  const time = formatTimeAgo(new Date(candidate.updatedAt).getTime(), t)

  const dim = candidate.unavailable ? 'opacity-50' : ''

  return (
    <>
      <span className={`shrink-0 w-7 h-7 rounded-lg bg-muted/60 flex items-center justify-center ${dim}`}>
        {candidate.digitalHuman
          ? <Bot size={14} className="text-muted-foreground" aria-label={t('Digital human')} />
          : <MessageSquare size={14} className="text-muted-foreground" />}
      </span>

      <span className={`flex-1 min-w-0 flex flex-col gap-0.5 ${dim}`}>
        <span className="text-[13px] text-foreground truncate">{candidate.title}</span>
        <span className="text-[11px] text-muted-foreground/60 truncate">
          {candidate.summary ? `${candidate.summary} · ${time}` : time}
        </span>
      </span>

      {candidate.unavailable ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{t('Collab not enabled')}</span>
      ) : candidate.status === 'idle' ? (
        <span
          className="shrink-0 w-1.5 h-1.5 rounded-full bg-muted-foreground/40"
          aria-label={t('idle')}
        />
      ) : (
        <TaskStatusDot status={candidate.status} className="shrink-0" />
      )}
    </>
  )
}
