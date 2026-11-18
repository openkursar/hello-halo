import { useMemo, useState } from 'react'
import type { RosterMember, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { openTeamConversation } from '../../../utils/team-conversation-navigation'
import { TeamMemberSettings } from '../TeamMemberSettings'
import { MEMBER_FACT_TONE, MemberFace, memberFact, memberOwner } from './member-ui'
import { PanelBar } from './PanelBar'
import { memberState, memberTasks } from './status'
import { PANEL_ACTION, SectionHeading, TaskRow } from './task-ui'

const TASK_LIMIT = 5

/** One member: who it is, what it is doing, the tasks it has a hand in, and its place in the team. */
export function MemberPanel({ detail, member, tasks, taskSpaceId, docked, owned, onOpenTask, onOpenProfile, onBack, onClose }: {
  detail: TeamDetail
  member: RosterMember
  tasks: readonly TeamConversation[]
  taskSpaceId: string | null
  docked: boolean
  owned: boolean
  onOpenTask: (epochId: string) => void
  onOpenProfile: () => void
  onBack: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [allTasks, setAllTasks] = useState(false)
  const state = memberState(detail, member)
  const fact = memberFact(detail, member, state, t)
  const owner = memberOwner(member, t)
  const related = useMemo(() => memberTasks(detail, tasks, member), [detail, tasks, member])
  const shown = allTasks ? related : related.slice(0, TASK_LIMIT)
  const settings = detail.members.find(entry => entry.appId === member.appId)
  const chat = () => {
    if (taskSpaceId) openTeamConversation(taskSpaceId, { teamId: detail.team.id, epochId: null, teamName: detail.team.name, appId: member.appId })
  }

  return <div className="flex h-full min-h-0 flex-col">
    <PanelBar docked={docked} backTo={t('Members')} onBack={onBack} onClose={onClose}>
      {owned && <button onClick={chat} disabled={!taskSpaceId} className={PANEL_ACTION}>{t('Chat with {{name}}', { name: member.memberName })}<span aria-hidden="true">↗</span></button>}
    </PanelBar>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-7 px-5 pb-10 pt-3 sm:px-6">
        <header className="flex items-center gap-3.5">
          <MemberFace name={member.memberName} state={state} size={56} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-[18px] font-semibold leading-7">{member.memberName}</h2>
              {member.isLead && <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-subtle-foreground">{t('Lead')}</span>}
            </div>
            {(member.role || owner) && <p className="truncate text-[13px] text-faint-foreground">{[member.role, owner].filter(Boolean).join(' · ')}</p>}
            <p title={fact} className={`mt-0.5 line-clamp-2 break-words text-[13px] ${MEMBER_FACT_TONE[state]}`}>{fact}</p>
          </div>
        </header>

        <section>
          <SectionHeading title={t('Tasks it is in')} count={related.length} />
          {related.length
            ? <>
              {shown.map(task => <TaskRow key={task.epochId} detail={detail} task={task} onOpen={() => onOpenTask(task.epochId)} />)}
              {related.length > TASK_LIMIT && <button onClick={() => setAllTasks(value => !value)} className="mt-1 text-[12.5px] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {allTasks ? t('Show less') : t('Show {{count}} more', { count: related.length - TASK_LIMIT })}
              </button>}
            </>
            : <p className="py-2 text-[13px] text-faint-foreground">{t('Not part of any task yet.')}</p>}
        </section>

        {settings
          ? <TeamMemberSettings key={member.appId} detail={detail} member={settings} onBack={onBack} embedded />
          : member.duty?.trim() && <section>
            <SectionHeading title={t('Duty in this team')} />
            <p className="whitespace-pre-wrap break-words rounded-xl bg-secondary/50 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">{member.duty}</p>
          </section>}

        {owned && <button onClick={onOpenProfile} className="inline-flex items-center gap-1 text-[13px] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {t('Open digital human settings')}<span aria-hidden="true">↗</span>
        </button>}
      </div>
    </div>
  </div>
}
