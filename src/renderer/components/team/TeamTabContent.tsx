/**
 * TeamTabContent — the full team tab body (left list + right view).
 *
 * Self-contained: loads the team list on mount, owns the create dialog, and
 * mirrors AppsPage's two-column desktop layout / push-navigation mobile layout
 * Selection lives in team.store so it survives tab switches.
 */

import { useEffect, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTeamStore } from '../../stores/team.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTranslation } from '../../i18n'
import { TeamList } from './TeamList'
import { TeamView } from './TeamView'
import { TeamEmptyState } from './TeamEmptyState'
import { TeamCreateDialog } from './TeamCreateDialog'
import { TeamJoinDialog } from './TeamJoinDialog'

export function TeamTabContent() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const currentSpace = useSpaceStore(s => s.currentSpace)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const owningSpaceId = currentSpace?.id ?? haloSpace?.id ?? null

  const teams = useTeamStore(s => s.teams)
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

  // One-click join: an invite staged by a halo:// deep link opens the join
  // dialog pre-filled the moment this tab is visible.
  useEffect(() => {
    if (pendingInviteLink) setShowJoin(true)
  }, [pendingInviteLink])

  const openCreate = () => setShowCreate(true)
  const openJoin = () => setShowJoin(true)

  const rightPane = detail
    ? <TeamView detail={detail} />
    : <TeamEmptyState hasTeams={teams.length > 0} onNewTeam={openCreate} onJoinOffice={openJoin} />

  return (
    <>
      {!isMobile ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex w-60 flex-shrink-0 flex-col overflow-hidden border-r border-border">
            <TeamList onNewTeam={openCreate} onJoinOffice={openJoin} />
          </div>
          <div className="flex flex-1 flex-col overflow-hidden">{rightPane}</div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          {currentTeamId ? (
            <>
              <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <button
                  onClick={() => selectTeam(null)}
                  className="flex items-center gap-1 text-sm text-primary"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t('Teams')}
                </button>
              </div>
              <div className="flex flex-1 flex-col overflow-hidden">{rightPane}</div>
            </>
          ) : (
            <TeamList onNewTeam={openCreate} onJoinOffice={openJoin} />
          )}
        </div>
      )}

      {showCreate && owningSpaceId && (
        <TeamCreateDialog
          owningSpaceId={owningSpaceId}
          onClose={() => setShowCreate(false)}
          onCreateMemberInline={() => { setShowCreate(false); setShowInstallDialog(true) }}
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
