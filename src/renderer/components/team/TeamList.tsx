import { Plus, LogIn, AlertTriangle, ArrowUpRight, Users } from 'lucide-react'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { AutomationAvatar } from '../apps/AutomationAvatar'

export function TeamList({ onNewTeam, onJoinOffice }: { onNewTeam: () => void; onJoinOffice: () => void }) {
  const { t } = useTranslation()
  const teams = useTeamStore(s => s.teams)
  const loading = useTeamStore(s => s.isLoadingList)
  const error = useTeamStore(s => s.error)
  const select = useTeamStore(s => s.selectTeam)
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-xl font-medium">{t('Teams')}</h1><p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">{t('A shared workspace for your digital humans to get things done.')}</p></div>
        <button onClick={onJoinOffice} className="flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><LogIn size={16} aria-hidden="true" />{t('Join a team')}</button>
      </div>
      {error && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm"><AlertTriangle size={16} className="shrink-0 text-destructive" /><span className="min-w-0 flex-1 break-words text-destructive">{error}</span><button disabled={loading} className="rounded-lg px-3 py-1.5 text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" onClick={() => void useTeamStore.getState().loadTeams()}>{loading ? t('Loading…') : t('Retry')}</button></div>}
      {loading && !teams.length ? <div role="status" aria-label={t('Loading teams')} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <div key={index} aria-hidden="true" className="min-h-48 rounded-xl border border-border bg-card p-5 motion-safe:animate-pulse"><div className="h-5 w-2/3 rounded bg-secondary" /><div className="my-5 flex gap-2"><div className="h-8 w-8 rounded-full bg-secondary" /><div className="h-8 w-8 rounded-full bg-secondary" /><div className="h-8 w-8 rounded-full bg-secondary" /></div><div className="h-3 w-1/2 rounded bg-secondary" /></div>)}</div> : <>
        {!teams.length && !error && <div className="mb-6 rounded-2xl border border-border bg-secondary/20 px-5 py-8 text-center sm:py-10"><span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-background text-primary"><Users size={23} /></span><h2 className="text-base font-medium">{t('Bring your digital humans together')}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t('Create a team to work on tasks together, or join an existing team.')}</p></div>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map(team => {
            const members = team.localMembers.slice(0, 5)
            const remaining = Math.max(0, team.memberCount - members.length)
            const working = team.status === 'running'
            const attention = team.status === 'waiting_user' || team.hasWaitingUser || team.status === 'error'
            return <button key={team.id} onClick={() => select(team.id)} className="group flex min-h-48 min-w-0 flex-col rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/40 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span className="flex w-full items-start justify-between gap-3"><h2 className="min-w-0 truncate text-base font-medium" title={team.name}>{team.name}</h2><ArrowUpRight size={17} className="mt-0.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" aria-hidden="true" /></span>
              <span className="my-5 flex h-8 items-center -space-x-2">{members.map(member => <span key={member.appId} title={member.memberName} className="rounded-full border-2 border-card"><AutomationAvatar name={member.memberName} size={28} /></span>)}
                {!members.length && <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-card bg-secondary text-muted-foreground"><Users size={16} /></span>}
                {remaining > 0 && <span className="relative flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-card bg-secondary px-1.5 text-[10px] tabular-nums text-muted-foreground">+{remaining}</span>}
              </span>
              <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground"><span>{t('{{count}} members', { count: team.memberCount })}</span><span className="flex items-center gap-1.5"><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${attention ? 'bg-halo-warning' : working ? 'bg-halo-success' : 'bg-muted-foreground/40'}`} />{team.status === 'error' ? t('Needs attention') : team.status === 'waiting_user' ? t('Waiting for decision') : working ? t('Working') : t('Ready')}</span></span>
              {team.hasWaitingUser && <span className="mt-4 flex w-full items-center gap-2 border-t border-border pt-3 text-xs font-medium text-halo-warning"><AlertTriangle size={14} className="shrink-0" aria-hidden="true" />{t('{{count}} decisions waiting for you', { count: team.waitingCount ?? 1 })}</span>}
            </button>
          })}
          <button onClick={onNewTeam} className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border text-sm text-primary transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/5"><Plus size={20} aria-hidden="true" /></span>{t('New team')}</button>
        </div>
      </>}
    </div>
  </div>
}
