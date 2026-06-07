/**
 * TeamList — left rail of the team tab.
 *
 * Lists teams with a status dot + member count, sorted (in the store) as
 * waiting-for-decision first, then running, then most recent. A "+ New office"
 * button at the bottom opens the create dialog.
 */

import { Plus } from 'lucide-react'
import type { TeamListItem, TeamStatus } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'

interface TeamListProps {
  onNewTeam: () => void
}

function statusDotClass(status: TeamStatus, hasWaitingUser: boolean): string {
  if (hasWaitingUser || status === 'waiting_user') return 'bg-amber-500'
  switch (status) {
    case 'running': return 'bg-green-500'
    case 'error': return 'bg-red-500'
    case 'idle':
    default: return 'bg-muted-foreground/40'
  }
}

export function TeamList({ onNewTeam }: TeamListProps) {
  const { t } = useTranslation()
  const teams = useTeamStore(s => s.teams)
  const currentTeamId = useTeamStore(s => s.currentTeamId)
  const selectTeam = useTeamStore(s => s.selectTeam)
  const isLoadingList = useTeamStore(s => s.isLoadingList)

  const statusLabel = (status: TeamStatus, hasWaitingUser: boolean): string => {
    if (hasWaitingUser || status === 'waiting_user') return t('Waiting for decision')
    switch (status) {
      case 'running': return t('Running')
      case 'error': return t('Error')
      default: return t('Idle')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2">
        {teams.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground/70">
            {isLoadingList ? t('Loading…') : t('No teams yet.')}
          </p>
        ) : (
          <ul className="space-y-1">
            {teams.map((team: TeamListItem) => {
              const active = team.id === currentTeamId
              return (
                <li key={team.id}>
                  <button
                    onClick={() => selectTeam(team.id)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${active ? 'bg-secondary' : 'hover:bg-secondary/50'}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${statusDotClass(team.status, team.hasWaitingUser)}`} />
                      <span className="truncate text-sm font-medium text-foreground">{team.name}</span>
                    </span>
                    <span className="pl-4 text-xs text-muted-foreground">
                      {t('{{count}} members', { count: team.memberCount })} · {statusLabel(team.status, team.hasWaitingUser)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border p-2">
        <button
          onClick={onNewTeam}
          className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-primary transition-colors hover:bg-secondary/50"
        >
          <Plus className="h-4 w-4" />
          {t('New office')}
        </button>
      </div>
    </div>
  )
}
