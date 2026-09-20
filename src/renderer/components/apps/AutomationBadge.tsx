import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppStore } from '../../stores/app.store'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'

export function AutomationBadge() {
  const { t } = useTranslation()
  const states = useAppsStore(state => state.appStates)
  const teams = useTeamStore(state => state.teams)
  const pending = Object.values(states).reduce((sum, state) => sum + (state.pendingDecisionCount ?? 0), 0)
  const needsAttention = pending > 0 || teams.some(team => team.hasWaitingUser)
  const running = Object.values(states).filter(state => state.status === 'running').length
  const workingTeams = teams.filter(team => team.status === 'running').length
  if (!needsAttention && !running && !workingTeams) return null
  return <button onClick={() => {
    useAppsPageStore.getState().setCurrentTab(needsAttention ? 'inbox' : 'my-digital-humans')
    useAppsPageStore.getState().clearSelection()
    useAppStore.getState().setView('apps')
  }} className={`flex min-h-10 w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs ${needsAttention ? 'bg-halo-warning/5 text-halo-warning hover:bg-halo-warning/10' : 'text-muted-foreground hover:bg-secondary'}`}>
    <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${needsAttention ? 'bg-halo-warning' : 'bg-halo-success'}`} />
    <span className="min-w-0 flex-1">{needsAttention ? pending ? t('{{count}} requests need your answer', { count: pending }) : t('Requests need your answer') : [running ? t('{{count}} independent executions running', { count: running }) : '', workingTeams ? t('{{count}} teams working', { count: workingTeams }) : ''].filter(Boolean).join(' · ')}</span>
  </button>
}
