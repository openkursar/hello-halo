import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import type { TabState } from '../../../services/canvas-lifecycle'
import { canvasLifecycle } from '../../../services/canvas-lifecycle'
import { useTeamStore } from '../../../stores/team.store'
import { TeamView } from '../../team/TeamView'
import { useTranslation } from '../../../i18n'

export function TeamViewer({ tab }: { tab: TabState }) {
  const { t } = useTranslation()
  const teamId = tab.teamId
  const currentTeamId = useTeamStore(state => state.currentTeamId)
  const detail = useTeamStore(state => state.currentTeamId === teamId ? state.detail : null)
  const loading = useTeamStore(state => state.isLoadingDetail)
  const error = useTeamStore(state => state.error)

  useEffect(() => {
    if (teamId && currentTeamId !== teamId) useTeamStore.getState().selectTeam(teamId)
  }, [teamId, currentTeamId])

  if (!teamId) return <p className="p-6 text-sm text-destructive">{t('This team could not be opened.')}</p>
  if (detail) return <TeamView key={detail.team.id} detail={detail} onBack={() => canvasLifecycle.closeTab(tab.id)} />
  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" aria-label={t('Loading team')} /></div>
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p role="alert" className="text-sm text-destructive">{error || t('Could not open this team.')}</p>
      <button className="text-sm text-primary" onClick={() => useTeamStore.getState().loadDetail(teamId)}>{t('Retry')}</button>
    </div>
  )
}
