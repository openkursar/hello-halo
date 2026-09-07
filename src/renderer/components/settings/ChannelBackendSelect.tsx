/**
 * Backend picker for an IM channel instance — which digital human answers this
 * bot. Two kinds of target: a standalone digital human, or one member of a team
 * (that member fronts the chat and can pull in its teammates).
 *
 * Shared by every provider's instance card so the two kinds stay one control.
 */

import { Bot } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TeamListItem } from '../../../shared/apps/team-types'

/** A team as this picker needs it: its name and the members it can offer. */
export type ChannelBackendTeam = Pick<TeamListItem, 'id' | 'name' | 'localMembers'>

/** A digital human as this picker needs it. */
export interface ChannelBackendApp {
  id: string
  spec: { name: string }
}

/** The instance fields this control owns. */
export interface ChannelBackendValue {
  appId: string
  teamId?: string
}

interface CommonProps {
  value: ChannelBackendValue
  automationApps: ChannelBackendApp[]
  /** Teams with at least one member on this machine are offerable. */
  teams: ChannelBackendTeam[]
}

/**
 * Encode a target as a `<select>` option value. A team binding with no member
 * (an old config bound to a team that had no lead) still encodes — it is a
 * binding that cannot be served, not an empty one, and the control says so
 * rather than showing the "nothing selected" placeholder.
 */
function encodeTarget(value: ChannelBackendValue): string {
  if (value.teamId) return `team:${value.teamId}:${value.appId}`
  return value.appId ? `app:${value.appId}` : ''
}

/** Ids are uuids, so the first ':' after the prefix is always the separator. */
function decodeTarget(raw: string): ChannelBackendValue {
  if (raw.startsWith('team:')) {
    const rest = raw.slice('team:'.length)
    const sep = rest.indexOf(':')
    if (sep > 0) return { teamId: rest.slice(0, sep), appId: rest.slice(sep + 1) }
  }
  if (raw.startsWith('app:')) return { appId: raw.slice('app:'.length), teamId: undefined }
  return { appId: '', teamId: undefined }
}

/** Teams that can actually back a channel from this machine. */
function offerableTeams(teams: ChannelBackendTeam[]): ChannelBackendTeam[] {
  return teams.filter((tm) => tm.localMembers.length > 0)
}

/**
 * Name of the currently bound target, for the collapsed instance header. A
 * binding whose target no longer exists (member removed, app uninstalled) says
 * so rather than rendering blank.
 */
export function ChannelBackendName({ value, automationApps, teams }: CommonProps) {
  const { t } = useTranslation()

  if (value.teamId) {
    const team = teams.find((tm) => tm.id === value.teamId)
    const member = team?.localMembers.find((m) => m.appId === value.appId)
    if (!team || !member) return <>{t('Binding unavailable')}</>
    return <>{t('{{member}} · Team {{team}}', { member: member.memberName, team: team.name })}</>
  }

  if (!value.appId) return <>{t('Not bound')}</>
  const app = automationApps.find((a) => a.id === value.appId)
  return <>{app ? app.spec.name : t('Binding unavailable')}</>
}

interface ChannelBackendSelectProps extends CommonProps {
  onChange: (value: ChannelBackendValue) => void
}

export function ChannelBackendSelect({
  value,
  automationApps,
  teams,
  onChange,
}: ChannelBackendSelectProps) {
  const { t } = useTranslation()

  const selectable = offerableTeams(teams)
  const selected = encodeTarget(value)
  const boundTeam = value.teamId ? selectable.find((tm) => tm.id === value.teamId) : undefined
  const boundMember = boundTeam?.localMembers.find((m) => m.appId === value.appId)
  // A binding can outlive its target (member removed, app uninstalled). Carry it
  // as a disabled option so the control shows what is bound instead of falling
  // back to the placeholder, which reads as "nothing is bound".
  const danglingBinding = selected !== '' && (
    value.teamId ? !boundMember : !automationApps.some((a) => a.id === value.appId)
  )

  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground">
        {t('Backend')} <span className="text-red-400">*</span>
      </label>
      <div className="relative">
        <Bot className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <select
          value={selected}
          onChange={(e) => onChange(decodeTarget(e.target.value))}
          className="w-full bg-muted border border-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none cursor-pointer"
        >
          <option value="">{t('Select a digital human or team member')}</option>
          {danglingBinding && (
            <option value={selected} disabled>
              {t('Binding unavailable')}
            </option>
          )}
          {automationApps.length > 0 && (
            <optgroup label={t('Digital Humans')}>
              {automationApps.map((app) => (
                <option key={app.id} value={`app:${app.id}`}>
                  {app.spec.name}
                </option>
              ))}
            </optgroup>
          )}
          {selectable.map((tm) => (
            <optgroup key={tm.id} label={t('Team: {{name}}', { name: tm.name })}>
              {tm.localMembers.map((m) => (
                <option key={m.appId} value={`team:${tm.id}:${m.appId}`}>
                  {m.isLead ? t('{{name}} (lead)', { name: m.memberName }) : m.memberName}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        {boundTeam && boundMember
          ? t('{{member}} answers this Bot as part of {{team}}, and can bring in teammates', {
              member: boundMember.memberName,
              team: boundTeam.name,
            })
          : t('All messages from this Bot will be handled by this digital human')}
      </p>
    </div>
  )
}
