/**
 * AutomationBadge
 *
 * Compact status banner shown at the top of ConversationList when
 * automation apps are active or need attention.
 *
 * - Shows nothing when no automation apps are installed
 * - "● N apps running" when apps are active
 * - "⚠ <App name> needs your input" when an escalation is pending
 *   (click → jump directly to that app's Activity Thread)
 */

import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppStore } from '../../stores/app.store'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'

export function AutomationBadge() {
  const { t } = useTranslation()
  const { setView } = useAppStore()
  const { apps } = useAppsStore()
  const { setInitialAppId, setCurrentTab } = useAppsPageStore()
  const teams = useTeamStore(s => s.teams)
  const selectTeam = useTeamStore(s => s.selectTeam)

  // Teams awaiting a decision / actively running (for the status line + sort).
  // Only `hasWaitingUser` — a joined office's status mirrors its host, so it can
  // announce a decision that belongs to whoever owns the blocked member.
  const waitingTeam = teams.find(tm => tm.hasWaitingUser)
  const runningTeam = teams.find(tm => tm.status === 'running')

  // Only show for automation-type apps
  const automationApps = apps.filter(a => a.spec.type === 'automation')
  if (automationApps.length === 0 && !waitingTeam && !runningTeam) return null

  const jumpToTeam = (teamId: string) => {
    selectTeam(teamId)
    setCurrentTab('team')
    setView('apps')
  }

  // Highest priority: a team awaiting the user's decision.
  if (waitingTeam) {
    return (
      <button
        onClick={() => jumpToTeam(waitingTeam.id)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left bg-orange-400/10 hover:bg-orange-400/20 border-b border-orange-400/20 transition-colors"
      >
        <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" />
        <span className="text-xs text-orange-300 truncate flex-1 min-w-0">
          {t('{{name}} needs your decision', { name: waitingTeam.name })}
        </span>
      </button>
    )
  }

  // Priority: escalation waiting
  const waitingApp = automationApps.find(a => a.status === 'waiting_user')
  if (waitingApp) {
    const handleClick = () => {
      setInitialAppId(waitingApp.id)
      setView('apps')
    }
    return (
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-2 px-3 py-2 text-left bg-orange-400/10 hover:bg-orange-400/20 border-b border-orange-400/20 transition-colors"
      >
        <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" />
        <span className="text-xs text-orange-300 truncate flex-1 min-w-0">
          {waitingApp.spec.name} — {t('needs your input')}
        </span>
      </button>
    )
  }

  // Secondary: running / active apps count, optionally with a running team.
  const runningApps = automationApps.filter(a => a.status === 'active' || a.status === 'error')
  if (runningApps.length === 0 && !runningTeam) return null

  const appsLabel = runningApps.length === 0
    ? null
    : runningApps.length === 1
      ? t('{{name}} running', { name: runningApps[0].spec.name })
      : t('{{count}} apps running', { count: runningApps.length })

  const teamLabel = runningTeam ? t('{{name}} running', { name: runningTeam.name }) : null
  const statusText = [appsLabel, teamLabel].filter(Boolean).join(' · ')

  const handleClick = () => {
    if (runningTeam) {
      jumpToTeam(runningTeam.id)
      return
    }
    setView('apps')
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/50 border-b border-border transition-colors"
    >
      <span className="w-2 h-2 rounded-full bg-green-500/70 flex-shrink-0" />
      <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
        {statusText}
      </span>
    </button>
  )
}
