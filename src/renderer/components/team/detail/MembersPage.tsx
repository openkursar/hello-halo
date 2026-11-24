import { useMemo } from 'react'
import type { RosterMember, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { openPersonModelSettings } from '../../../utils/people-navigation'
import type { FailureCause } from '../workbench/progress'
import { failureCauseText } from '../workbench/progress-labels'
import { MEMBER_FACT_TONE, MemberFace, memberFact, memberOwner } from './member-ui'
import { memberPriority, memberState, settingsFailure, type MemberStateKey } from './status'
import { PILL_ON_TINT, SectionHeading } from './task-ui'

/** Everyone on the team, those needing attention first; opening one shows its details beside the list. */
export function MembersPage({ detail, tasks, selectedId, onOpenMember }: {
  detail: TeamDetail
  tasks: readonly TeamConversation[]
  selectedId: string | null
  onOpenMember: (appId: string) => void
}) {
  const { t } = useTranslation()
  // A member whose model stopped a task is usually idle again by now, so the task says what its status no longer does.
  const stopped = useMemo(() => {
    const causes = new Map<string, FailureCause>()
    for (const task of tasks) {
      const hit = settingsFailure(detail, task)
      if (hit) causes.set(hit.member.appId, hit.cause)
    }
    return causes
  }, [detail, tasks])
  const sorted = useMemo(() => detail.roster
    .map(member => ({ member, state: memberState(detail, member) }))
    .sort((a, b) => Number(stopped.has(b.member.appId)) - Number(stopped.has(a.member.appId))
      || memberPriority(a.state) - memberPriority(b.state) || Number(b.member.isLead) - Number(a.member.isLead)), [detail, stopped])
  const online = sorted.filter(item => item.state !== 'offline')
  const offline = sorted.filter(item => item.state === 'offline')
  const row = ({ member, state }: { member: RosterMember; state: MemberStateKey }) =>
    <MemberRow key={member.appId} detail={detail} member={member} state={state} stopped={stopped.get(member.appId)} selected={member.appId === selectedId} onOpen={() => onOpenMember(member.appId)} />

  if (!sorted.length) return <p className="py-6 text-center text-[13px] text-faint-foreground">{t('No members yet')}</p>
  return <div className="space-y-7">
    {online.length > 0 && <div className="space-y-1">{online.map(row)}</div>}
    {offline.length > 0 && <section><SectionHeading title={t('Offline')} count={offline.length} />{offline.map(row)}</section>}
  </div>
}

function MemberRow({ detail, member, state, stopped, selected, onOpen }: {
  detail: TeamDetail; member: RosterMember; state: MemberStateKey; stopped?: FailureCause; selected: boolean; onOpen: () => void
}) {
  const { t } = useTranslation()
  const fact = stopped ? failureCauseText(stopped, t) : memberFact(detail, member, state, t)
  // A role that only repeats the name says nothing.
  const role = member.role?.trim() && member.role.trim() !== member.memberName.trim() ? member.role.trim() : null
  const about = [role, memberOwner(member, t)].filter(Boolean).join(' · ')
  return <div className={`-mx-3 flex w-[calc(100%+24px)] items-center rounded-[10px] transition-colors ${selected ? 'bg-secondary' : stopped ? 'bg-halo-error/[0.05]' : 'hover:bg-secondary/60'}`}>
    <button onClick={onOpen} aria-current={selected ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-[10px] px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <MemberFace name={member.memberName} state={state} size={36} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium text-foreground">{member.memberName}</span>
          {member.isLead && <span className="shrink-0 rounded-full bg-secondary px-1.5 py-px text-[11px] text-subtle-foreground">{t('Lead')}</span>}
          {about && <span className="truncate text-xs text-faint-foreground">{about}</span>}
        </span>
        <span title={fact} className={`mt-px block truncate text-xs ${stopped ? 'text-destructive' : MEMBER_FACT_TONE[state]}`}>{fact}</span>
      </span>
    </button>
    {stopped && <button onClick={() => openPersonModelSettings(member.appId)} className={`mr-3 shrink-0 ${PILL_ON_TINT}`}>{t('Change model')}</button>}
  </div>
}
