import { useState } from 'react'
import type { TeamConversation, TeamDetail, TeamPendingEscalation } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { useTeamStore } from '../../../stores/team.store'
import { formatTimeAgo } from '../../../utils/format-time'
import { openTeamConversation } from '../../../utils/team-conversation-navigation'
import { EscalationCard } from '../../apps/EscalationCard'
import { toneSurface } from '../workbench/task-brief'
import { PILL_ON_TINT, PILL_PRIMARY, PILL_SECONDARY, StateIcon } from './task-ui'

/** Pending decisions plus the one being answered, which stays after it leaves the list so its receipt can be read. */
export function useHeldDecisions(pending: readonly TeamPendingEscalation[]) {
  const [answering, setAnswering] = useState<TeamPendingEscalation | null>(null)
  const decisions = answering && !pending.some(item => item.entryId === answering.entryId) ? [answering, ...pending] : [...pending]
  return { decisions, answeringId: answering?.entryId ?? null, setAnswering }
}

export type HeldDecisions = ReturnType<typeof useHeldDecisions>

/** A question a member is waiting on, answered in place. */
export function DecisionCard({ detail, decision, task, taskSpaceId, open, onOpen, onOpenTask, flat = false }: {
  detail: TeamDetail
  decision: TeamPendingEscalation
  task?: TeamConversation
  taskSpaceId: string | null
  open: boolean
  onOpen: (open: boolean) => void
  onOpenTask?: (epochId: string) => void
  /** Tint only, for a stack where a border on every card would be noise. */
  flat?: boolean
}) {
  const { t } = useTranslation()
  const reply = () => {
    if (!taskSpaceId) return
    openTeamConversation(taskSpaceId, { teamId: detail.team.id, epochId: decision.epochId ?? null, teamName: detail.team.name, label: task?.label, appId: decision.appId, entryId: decision.entryId, decision: true })
  }
  const meta = [decision.memberName, onOpenTask ? task?.label : null, decision.entry?.ts ? t('Asked {{time}}', { time: formatTimeAgo(decision.entry.ts, t) }) : null].filter(Boolean).join(' · ')
  return <div className={`rounded-[15px] ${flat ? '' : 'border'} ${toneSurface('attention')} p-3.5`}>
    <p className="flex items-start gap-2 text-[14.5px] leading-6"><StateIcon state="waiting_user" className="mt-[3px]" /><span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">{decision.question}</span></p>
    <p className="mt-0.5 truncate pl-[26px] text-[12.5px] text-faint-foreground">{meta}</p>
    {open && decision.entry && <div className="mt-3 pl-[26px]"><EscalationCard entry={decision.entry} appId={decision.appId} onResolved={() => {
      void useTeamStore.getState().loadDetail(detail.team.id)
      void useTeamStore.getState().loadConversations(detail.team.id)
    }} /></div>}
    <div className="mt-3 flex flex-wrap gap-2 pl-[26px]">
      {decision.entry
        ? <button onClick={() => onOpen(!open)} aria-expanded={open} className={open ? PILL_SECONDARY : PILL_PRIMARY}>{open ? t('Collapse') : t('Reply')}</button>
        : <button onClick={reply} disabled={!taskSpaceId} className={`${PILL_PRIMARY} disabled:opacity-50`}>{t('Go to reply')}<span aria-hidden="true">↗</span></button>}
      {task && onOpenTask && <button onClick={() => onOpenTask(task.epochId)} className={PILL_ON_TINT}>{t('View task')}</button>}
    </div>
  </div>
}
