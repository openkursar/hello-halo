import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { TabState } from '../../../services/canvas-lifecycle'
import { useCanvasActions } from '../../../hooks/useCanvasLifecycle'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { TeamViewContext, useTeamStore } from '../../../stores/team.store'
import { TeamTaskProgress } from '../../team/TeamTaskProgress'
import { useTranslation } from '../../../i18n'

export function TeamTaskViewer({ tab }: { tab: TabState }) {
  const { t } = useTranslation()
  const { consumeReveal, setOpen, openFile } = useCanvasActions()
  const isMobile = useIsMobile()
  const tabId = useRef(tab.id)
  tabId.current = tab.id
  const target = tab.teamTask
  const teamId = target?.teamId
  useEffect(() => (teamId ? useTeamStore.getState().retainTeamView(teamId) : undefined), [teamId])
  const detail = useTeamStore(state => (teamId ? state.views[teamId]?.detail ?? null : null))
  const loading = useTeamStore(state => (teamId ? state.views[teamId]?.isLoadingDetail ?? true : false))
  const error = useTeamStore(state => (teamId ? state.views[teamId]?.error ?? null : null))

  if (!target || !teamId) return <p className="p-6 text-sm text-destructive">{t('This team could not be opened.')}</p>
  if (detail) {
    return (
      <TeamViewContext.Provider value={teamId}>
        <TeamTaskProgress key={`${teamId}:${target.epochId}`} spaceId={target.spaceId} epochId={target.epochId} teamDetail={detail} memory={tab.view.teamTask ??= {}} reveal={tab.reveal}
          onRevealHandled={seq => consumeReveal(tabId.current, seq)}
          // On mobile the canvas covers the conversation, so leaving for it closes the canvas.
          onLeave={isMobile ? () => setOpen(false) : undefined} openFile={openFile} />
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
