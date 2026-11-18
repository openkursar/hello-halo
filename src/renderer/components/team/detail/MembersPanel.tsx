import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import type { RosterMember, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { MEMBER_FACT_TONE, MemberFace, memberFact, memberOwner } from './member-ui'
import { PanelBar } from './PanelBar'
import { memberPriority, memberState, type MemberStateKey } from './status'
import { SectionHeading } from './task-ui'

/** Everyone on the team, those needing attention first; opening one drills into it. */
export function MembersPanel({ detail, docked, onOpenMember, onClose }: {
  detail: TeamDetail
  docked: boolean
  onOpenMember: (appId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const sorted = useMemo(() => detail.roster
    .map(member => ({ member, state: memberState(detail, member) }))
    .sort((a, b) => memberPriority(a.state) - memberPriority(b.state) || Number(b.member.isLead) - Number(a.member.isLead)), [detail])
  const online = sorted.filter(item => item.state !== 'offline')
  const offline = sorted.filter(item => item.state === 'offline')
  const card = ({ member, state }: { member: RosterMember; state: MemberStateKey }) =>
    <MemberCard key={member.appId} detail={detail} member={member} state={state} onOpen={() => onOpenMember(member.appId)} />

  return <div className="flex h-full min-h-0 flex-col">
    <PanelBar docked={docked} onBack={onClose} onClose={onClose} />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-7 px-5 pb-10 pt-3 sm:px-6">
        <section>
          <h2 className="mb-3 flex items-baseline gap-2 text-[18px] font-semibold leading-7">{t('Members')}<span className="text-[13px] font-normal tabular-nums text-faint-foreground">{detail.roster.length}</span></h2>
          {online.length
            ? <div className="space-y-2">{online.map(card)}</div>
            : !offline.length && <p className="py-6 text-center text-[13px] text-faint-foreground">{t('No members yet')}</p>}
        </section>
        {offline.length > 0 && <section><SectionHeading title={t('Offline')} count={offline.length} /><div className="space-y-2">{offline.map(card)}</div></section>}
      </div>
    </div>
  </div>
}

function MemberCard({ detail, member, state, onOpen }: {
  detail: TeamDetail; member: RosterMember; state: MemberStateKey; onOpen: () => void
}) {
  const { t } = useTranslation()
  const fact = memberFact(detail, member, state, t)
  const owner = memberOwner(member, t)
  return <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-2xl border border-border-soft px-3.5 py-3 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <MemberFace name={member.memberName} state={state} size={40} />
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-foreground">{member.memberName}</span>
        {member.isLead && <span className="shrink-0 rounded-full bg-secondary px-1.5 py-px text-[11px] text-subtle-foreground">{t('Lead')}</span>}
      </span>
      {(member.role || owner) && <span className="mt-px block truncate text-xs text-faint-foreground">{[member.role, owner].filter(Boolean).join(' · ')}</span>}
      <span title={fact} className={`mt-1 block truncate text-[12.5px] ${MEMBER_FACT_TONE[state]}`}>{fact}</span>
    </span>
    <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-faint-foreground" />
  </button>
}
