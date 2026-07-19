/**
 * useMemberView — the single source of a team member's rendered state.
 *
 * Both office skins (plain cards and cartoon workstations) derive their look
 * from this one hook, so status logic, "busy elsewhere" resolution, and the
 * summary line never fork between presentations.
 */

import type { RosterMember } from '../../../../shared/apps/team-types'
import { useMemberPresence, type MemberPresence } from '../../../stores/team.store'
import { useTranslation } from '../../../i18n'

export interface MemberView {
  member: RosterMember
  presence: MemberPresence
  isLead: boolean
  /** Owner's machine is not reachable right now (away/offline). */
  isUnreachable: boolean
  /** Actively working on something, and reachable. */
  isWorking: boolean
  /** Needs the user (error or waiting_user), and reachable. */
  isAlert: boolean
  /** One-line status/role summary shown under the name. */
  summary: string
}

export function useMemberView(
  member: RosterMember,
  teamId: string,
  focusedEpochId?: string | null,
): MemberView {
  const { t } = useTranslation()
  const presence = useMemberPresence(teamId, member.appId)

  const isLead = member.isLead
  const isUnreachable = presence.reachability !== 'online'
  const isWorking = member.status === 'working' && !isUnreachable
  const isAlert = (member.status === 'error' || member.status === 'waiting_user') && !isUnreachable

  // "Busy elsewhere" (§6.3/§8.3): working, but on an event OTHER than the one the
  // floor is focused on — name what it IS (a conversation by its label, or the
  // team run) instead of a blank/stale title.
  const busy = member.busy ?? []
  const onFocused = focusedEpochId ? busy.some(b => b.epochId === focusedEpochId) : busy.length > 0
  const elsewhereEntry = isWorking && !onFocused ? busy.find(b => b.epochId !== focusedEpochId) : undefined
  const elsewhereLabel = elsewhereEntry
    ? elsewhereEntry.kind === 'conversation'
      ? (elsewhereEntry.label
          ? t('Busy with "{{name}}"', { name: elsewhereEntry.label })
          : t('Busy with another conversation'))
      : t('Busy with the team run')
    : ''

  const summary =
    member.status === 'working'
      ? elsewhereLabel || member.currentTaskTitle || ''
      : member.status === 'error'
        ? member.currentTaskTitle || ''
        : member.role || ''

  return { member, presence, isLead, isUnreachable, isWorking, isAlert, summary }
}
