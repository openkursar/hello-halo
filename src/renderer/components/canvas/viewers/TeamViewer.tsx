import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import type { TabState } from '../../../services/canvas-lifecycle'
import { useCanvasActions } from '../../../hooks/useCanvasLifecycle'
import { TeamViewContext, useTeamStore } from '../../../stores/team.store'
import { TeamView } from '../../team/TeamView'
import { useTranslation } from '../../../i18n'

export function TeamViewer({ tab }: { tab: TabState }) {
  const { t } = useTranslation()
  const { closeTab } = useCanvasActions()
  const teamId = tab.teamId
  // Its own view of the tab's team: never moves the Teams page selection.
  useEffect(() => (teamId ? useTeamStore.getState().retainTeamView(teamId) : undefined), [teamId])
  const detail = useTeamStore(state => (teamId ? state.views[teamId]?.detail ?? null : null))
  const loading = useTeamStore(state => (teamId ? state.views[teamId]?.isLoadingDetail ?? true : false))
  const error = useTeamStore(state => (teamId ? state.views[teamId]?.error ?? null : null))

  if (!teamId) return <p className="p-6 text-sm text-destructive">{t('This team could not be opened.')}</p>
  if (detail) {
    return (
      <TeamViewContext.Provider value={teamId}>
        <TeamView key={detail.team.id} detail={detail} onBack={() => closeTab(tab.id)} />
      </TeamViewContext.Provider>
    )
  }
  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" aria-label={t('Loading team')} /></div>
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p role="alert" className="text-sm text-destructive">{error || t('Could not open this team.')}</p>
      <button className="text-sm text-primary" onClick={() => useTeamStore.getState().loadDetail(teamId)}>{t('Retry')}</button>
    </div>
  )
}
