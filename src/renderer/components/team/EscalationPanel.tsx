/**
 * EscalationPanel — Team escalation / decision panel.
 *
 * A team escalation is the SAME object as the member app's escalation — there
 * is no separate team-side escalation store.
 * This panel therefore frames the member + team context and then delegates the
 * actual question / choices / response UI to the shared EscalationCard, which
 * resolves the one underlying escalation object (so responding once updates both
 * the member panel and the team view).
 */

import { useEffect, useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { RosterMember } from '../../../shared/apps/team-types'
import { useAppsStore } from '../../stores/apps.store'
import { EscalationCard } from '../apps/EscalationCard'
import { useTranslation } from '../../i18n'

interface EscalationPanelProps {
  member: RosterMember
  teamName: string
}

export function EscalationPanel({ member, teamName }: EscalationPanelProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const activityEntries = useAppsStore(s => s.activityEntries)
  const loadActivity = useAppsStore(s => s.loadActivity)

  const app = useMemo(() => apps.find(a => a.id === member.appId), [apps, member.appId])

  // The escalation object lives in the member app's activity feed. Load it so
  // we can render the same unresolved entry the member detail page would.
  useEffect(() => {
    loadActivity(member.appId)
  }, [member.appId, loadActivity])

  const escalationEntry = useMemo(() => {
    const entries = activityEntries[member.appId] ?? []
    // Prefer the explicitly-flagged pending escalation; else the newest
    // unresolved escalation entry.
    if (app?.pendingEscalationId) {
      const flagged = entries.find(e => e.id === app.pendingEscalationId)
      if (flagged) return flagged
    }
    return entries.find(e => e.type === 'escalation' && !e.userResponse)
  }, [activityEntries, member.appId, app?.pendingEscalationId])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        <p className="text-sm text-foreground">
          {t('{{member}} (from {{team}}) needs your decision:', {
            member: member.memberName,
            team: teamName,
          })}
        </p>
      </div>

      {escalationEntry ? (
        <EscalationCard entry={escalationEntry} appId={member.appId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('Loading the pending decision…')}
        </p>
      )}
    </div>
  )
}
