/**
 * useMemberView — the single source of a team member's rendered state.
 *
 * Both office skins (plain cards and cartoon workstations) derive their look
 * from this one hook, so status logic, "busy elsewhere" resolution, and the
 * summary line never fork between presentations.
 */

import { awaitsOurDecision, checksForMember } from '../../../../shared/apps/team-types'
import type { RosterMember } from '../../../../shared/apps/team-types'
import { useMemberPresence, useTeamStore, type MemberPresence } from '../../../stores/team.store'
import { useTranslation } from '../../../i18n'

export interface MemberView {
  member: RosterMember
  presence: MemberPresence
  isLead: boolean
  /** Owner's machine is not reachable right now (away/offline). */
  isUnreachable: boolean
  /** Actively working on something, and reachable. */
  isWorking: boolean
  /** Needs THIS reader (error, or a decision on its own digital human), and reachable. */
  isAlert: boolean
  /**
   * A decision is waiting on the teammate who owns this member. A fact to state,
   * never a call to action: only that person's Halo can answer it.
   */
  waitsOnOwner: boolean
  /** One-line status/role summary shown under the name. */
  summary: string
  /**
   * How many periodic checks are standing over this member. Not an activity —
   * a standing arrangement someone made about it, which is exactly what a
   * person scanning the floor wants to spot at a glance.
   */
  checkCount: number
}

export function useMemberView(
  member: RosterMember,
  teamId: string,
  focusedEpochId?: string | null,
): MemberView {
  const { t } = useTranslation()
  const presence = useMemberPresence(teamId, member.appId)
  const checkCount = useTeamStore(
    s => checksForMember(s.detail?.checks ?? [], member.appId, focusedEpochId).length
  )

  const isLead = member.isLead
  const isUnreachable = presence.reachability !== 'online'
  const isWorking = member.status === 'working' && !isUnreachable
  // "Waiting for a decision" is addressed to one person — the member's owner. On
  // anyone else's floor it is news, not an alert, so it must not borrow the amber
  // that means "you have something to do here".
  const waitsOnOwner = member.status === 'waiting_user' && !awaitsOurDecision(member)
  const isAlert = (member.status === 'error' || awaitsOurDecision(member)) && !isUnreachable

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

  // "Waiting on X" is the badge's sentence (both skins render it from
  // `waitsOnOwner`), so the summary must not say it a second time on the same
  // card — it falls back to the role, as it does at rest.
  const summary =
    member.status === 'working'
      ? elsewhereLabel || member.currentTaskTitle || ''
      : member.status === 'error'
        ? member.currentTaskTitle || ''
        : member.role || ''

  return { member, presence, isLead, isUnreachable, isWorking, isAlert, waitsOnOwner, summary, checkCount }
}
