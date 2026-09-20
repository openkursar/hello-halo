import { ArrowUpRight, Users } from 'lucide-react'
import { useTeamStore } from '../../stores/team.store'
import { openPersonTeam } from '../../utils/people-navigation'
import { useTranslation } from '../../i18n'

export function PersonTeams({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const teams = useTeamStore(state => state.teams)
  const error = useTeamStore(state => state.error)
  const loading = useTeamStore(state => state.isLoadingList)
  const memberships = teams.filter(team => team.localMembers.some(member => member.appId === appId))
  return <div className="mx-auto w-full max-w-5xl p-4 sm:p-8">
    <h2 className="text-lg font-medium">{t('Participating teams')}</h2><p className="mb-6 mt-2 text-sm text-muted-foreground">{t('One digital human, distinct tasks and conversations in each team.')}</p>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{t('Could not load team memberships.')} <button onClick={() => void useTeamStore.getState().loadTeams()} className="underline">{t('Retry')}</button></p>}
    {loading && !teams.length ? <p role="status">{t('Loading…')}</p> : !memberships.length && !error ? <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground"><Users className="mx-auto mb-3" /><p>{t('This digital human has not joined a team.')}</p></div> : <div className="grid gap-4 sm:grid-cols-2">{memberships.map(team => <button key={team.id} onClick={() => openPersonTeam({ teamId: team.id, appId }, appId)} className="min-w-0 rounded-xl border border-border p-5 text-left hover:border-primary/40"><div className="flex items-center gap-3"><Users size={20} className="text-muted-foreground" /><h3 className="min-w-0 flex-1 truncate font-medium">{team.name}</h3><ArrowUpRight size={16} /></div><p className="mt-3 text-sm text-muted-foreground">{team.localMembers.find(member => member.appId === appId)?.isLead ? t('Team coordinator') : t('Team member')}</p><p className="mt-3 text-xs text-muted-foreground">{t('{{count}} members', { count: team.memberCount })}</p></button>)}</div>}
  </div>
}
