import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Check, MessageCircle, Users } from 'lucide-react'
import type { RosterMember, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { AutomationAvatar } from '../../apps/AutomationAvatar'

export function MemberRail({ detail, selectedAppId, selectableAppIds = [], onMember, onTask }: {
  detail: TeamDetail; selectedAppId?: string | null; selectableAppIds?: string[]
  onMember: (member: RosterMember) => void; onTask: (id: string, memberId?: string, decisionId?: string) => void
}) {
  const { t } = useTranslation()
  const tooltipId = useId()
  const [hover, setHover] = useState<{ member: RosterMember; left: number; top: number } | null>(null)
  const show = (element: HTMLElement, member: RosterMember) => {
    const bounds = element.getBoundingClientRect()
    setHover({ member, left: Math.max(8, Math.min(window.innerWidth - 248, bounds.left - 248)), top: Math.max(8, Math.min(window.innerHeight - 280, bounds.top)) })
  }
  const statusLabel = (member: RosterMember) => member.presence === 'offline' ? t('Offline')
    : member.status === 'waiting_user' ? t('Waiting for decision')
      : member.status === 'error' ? t('Needs attention')
        : member.status === 'working' ? t('Working') : t('On standby')
  const statusColor = (member: RosterMember) => member.presence === 'offline' ? 'bg-muted-foreground/40'
    : member.status === 'waiting_user' || member.status === 'error' ? 'bg-halo-warning'
      : member.status === 'working' ? 'bg-halo-success' : 'bg-muted-foreground/60'
  const groups = [
    { key: 'busy', label: t('Working'), members: detail.roster.filter(m => m.presence !== 'offline' && m.status === 'working') },
    { key: 'ready', label: t('On standby'), members: detail.roster.filter(m => m.presence !== 'offline' && m.status !== 'working') },
    { key: 'offline', label: t('Offline'), members: detail.roster.filter(m => m.presence === 'offline') },
  ]
  return <aside onScroll={() => setHover(null)} onKeyDown={event => { if (event.key === 'Escape') setHover(null) }} aria-label={t('Members')} className="h-full overflow-y-auto p-3">
    <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-medium">{t('Members')}</h2><span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{detail.roster.length}</span></div>
    {!detail.roster.length && <div className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground"><Users size={20} className="mx-auto mb-2 opacity-50" />{t('No members yet')}</div>}
    {groups.filter(group => group.members.length > 0).map(group => <section key={group.key} className="mb-5">
      <h3 className="mb-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground"><span>{group.label}</span><span className="tabular-nums">{group.members.length}</span></h3>
      <div className="space-y-1.5">{group.members.map(member => {
        const requests = (detail.pendingEscalations ?? []).filter(entry => entry.appId === member.appId && entry.epochId)
        const selectable = selectableAppIds.includes(member.appId)
        const selected = selectable && selectedAppId === member.appId
        return <div key={member.appId} className={`min-w-0 rounded-xl border transition-colors ${selected ? 'border-primary/25 bg-primary/5' : 'border-transparent hover:bg-secondary/60'}`}>
          <button onClick={() => { setHover(null); onMember(member) }} onMouseEnter={event => show(event.currentTarget, member)} onMouseLeave={() => setHover(null)} onFocus={event => show(event.currentTarget, member)} onBlur={() => setHover(null)} aria-pressed={selectable ? selected : undefined} aria-describedby={hover?.member.appId === member.appId ? tooltipId : undefined} className="flex min-h-12 w-full items-center gap-2 rounded-lg p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={selectable ? t('Switch to {{name}}', { name: member.memberName }) : t('View {{name}}', { name: member.memberName })}>
            <span className="relative shrink-0"><AutomationAvatar name={member.memberName} size={30} /><span aria-hidden="true" className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background ${statusColor(member)}`} /></span>
            <span className="min-w-0 flex-1"><span className="flex items-center gap-1 text-xs font-medium"><span className="truncate">{member.memberName}</span></span>
              <span className={`mt-0.5 block truncate text-[11px] ${member.presence !== 'offline' && (member.status === 'waiting_user' || member.status === 'error') ? 'text-halo-warning' : 'text-muted-foreground'}`}>{statusLabel(member)}</span>
            </span>
            {selected && <Check size={12} className="shrink-0 text-primary" aria-hidden="true" />}
          </button>
          {requests.length > 0 && <details className="mx-2 mb-2 text-[11px] text-halo-warning" open={requests.length === 1}><summary className="cursor-pointer py-1">{t('{{count}} decisions need your answer', { count: requests.length })}</summary><div className="max-h-40 overflow-y-auto">{requests.map(entry => <button key={entry.entryId} onClick={() => { setHover(null); onTask(entry.epochId!, member.appId, entry.entryId) }} className="flex min-h-8 w-full items-center gap-1 rounded px-1 text-left hover:bg-halo-warning/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><ArrowUpRight size={12} className="shrink-0" /><span className="truncate">{entry.question}</span></button>)}</div></details>}
          {(member.busy ?? []).length > 0 && <div className="mx-2 mb-2 space-y-1 border-t border-border/60 pt-1.5">{member.busy!.map(busy => <button key={busy.epochId} onClick={() => { setHover(null); onTask(busy.epochId, member.appId) }} title={busy.label} aria-label={t('Open task: {{name}}', { name: busy.label })} className="flex min-h-7 w-full items-center gap-1 rounded px-1 text-left text-[11px] text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><ArrowUpRight size={11} className="shrink-0" aria-hidden="true" /><span className="truncate">{t('Task')}: {busy.label}</span></button>)}</div>}
        </div>
      })}</div>
    </section>)}
    {hover && createPortal(<div id={tooltipId} role="tooltip" style={{ left: hover.left, top: hover.top }} className="pointer-events-none fixed z-[100] max-h-[calc(100vh-16px)] w-60 overflow-hidden rounded-xl border border-border bg-popover p-3 text-xs shadow-lg">
      <div className="flex items-center gap-2.5"><AutomationAvatar name={hover.member.memberName} size={34} /><div className="min-w-0"><p className="break-words font-medium">{hover.member.memberName}</p><p className="mt-1 text-[11px] text-muted-foreground">{statusLabel(hover.member)}</p></div></div>
      <p className="mt-3 break-words text-muted-foreground">{hover.member.owner || t('My digital human')} · {detail.team.name}</p>
      {(hover.member.duty || hover.member.role) && <p className="mt-2 line-clamp-3 leading-5">{hover.member.duty || hover.member.role}</p>}
      {(hover.member.busy ?? []).slice(0, 2).map(busy => <p key={busy.epochId} className="mt-2 truncate text-muted-foreground">{busy.label}</p>)}
      <p className="mt-3 flex items-center gap-1.5 border-t border-border pt-2.5 text-primary">{selectableAppIds.includes(hover.member.appId) ? <><MessageCircle size={13} />{t('Switch digital human in this task')}</> : <><Users size={13} />{t('View member details')}</>}</p>
    </div>, document.body)}
  </aside>
}
