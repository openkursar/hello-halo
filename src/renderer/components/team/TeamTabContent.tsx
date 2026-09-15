/**
 * TeamTabContent — the full team tab body (left list + right view).
 *
 * Self-contained: loads the team list on mount, owns the create dialog, and
 * mirrors AppsPage's two-column desktop layout / push-navigation mobile layout
 * Selection lives in team.store so it survives tab switches.
 */

import { useEffect, useState } from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { useTeamStore } from '../../stores/team.store'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { TeamList } from './TeamList'
import { TeamView } from './TeamView'
import { TeamCreateDialog } from './TeamCreateDialog'
import { TeamJoinDialog } from './TeamJoinDialog'

export function TeamTabContent() {
  const { t } = useTranslation()

  const error = useTeamStore(s => s.error)
  const loading = useTeamStore(s => s.isLoadingDetail)
  const currentTeamId = useTeamStore(s => s.currentTeamId)
  const detail = useTeamStore(s => s.detail)
  const loadTeams = useTeamStore(s => s.loadTeams)
  const selectTeam = useTeamStore(s => s.selectTeam)
  const pendingInviteLink = useTeamStore(s => s.pendingInviteLink)
  const setPendingInviteLink = useTeamStore(s => s.setPendingInviteLink)

  const setShowInstallDialog = useAppsPageStore(s => s.setShowInstallDialog)
  const loadApps = useAppsStore(s => s.loadApps)

  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)

  useEffect(() => {
    void loadTeams()
    // Member pickers need the full app list (across spaces) available.
    void loadApps()
  }, [loadTeams, loadApps])

  useEffect(() => api.onAppEscalationResolved(data => {
    const event = data as { appId?: string; entryId?: string }
    const state = useTeamStore.getState()
    if (!event.appId || !state.detail?.pendingEscalations?.some(entry => entry.appId === event.appId && entry.entryId === event.entryId)) return
    const team = useTeamStore.getState().currentTeamId
    if (team) {
      void useTeamStore.getState().loadDetail(team)
      void useTeamStore.getState().loadConversations(team)
    }
    void useTeamStore.getState().loadTeams()
  }), [])

  // One-click join: an invite staged by a halo:// deep link opens the join
  // dialog pre-filled the moment this tab is visible.
  useEffect(() => {
    if (pendingInviteLink) setShowJoin(true)
  }, [pendingInviteLink])

  const openCreate = () => setShowCreate(true)
  const openJoin = () => setShowJoin(true)


  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {currentTeamId ? detail ? <TeamView key={detail.team.id} detail={detail} /> : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          {loading ? <Loader2 className="animate-spin text-muted-foreground" /> : <>
            <p role="alert" className="text-sm text-destructive">{error || t('Could not open this team.')}</p>
            <button onClick={() => void useTeamStore.getState().loadDetail(currentTeamId)} className="text-sm text-primary">{t('Retry')}</button>
          </>}
          <button onClick={() => selectTeam(null)} className="flex items-center gap-1 text-sm text-primary"><ChevronLeft size={16} />{t('Teams')}</button>
        </div> : <TeamList onNewTeam={openCreate} onJoinOffice={openJoin} />}
      </div>

      {showCreate && (
        <TeamCreateDialog
          onClose={() => setShowCreate(false)}
        />
      )}

      {showJoin && (
        <TeamJoinDialog
          initialLink={pendingInviteLink ?? undefined}
          onClose={() => {
            setShowJoin(false)
            // A staged deep-link invite is one-shot: closing the dialog (joined
            // or dismissed) consumes it so it never re-opens later.
            if (pendingInviteLink) setPendingInviteLink(null)
          }}
          onCreateDigitalHuman={() => setShowInstallDialog(true)}
        />
      )}
    </>
  )
}
