/**
 * Permission-overlay enforcement (server-side authority). Pure decision
 * functions over a member's stored OfficeScope (team_members.scope_json). The
 * overlay is an optional, mostly-enterprise tightening layer; the default is
 * fully open (DEFAULT_OFFICE_SCOPE) so a P2P office behaves exactly like a
 * local team unless a member was invited with a narrower scope.
 *
 * These decisions MUST be made on the authority side from persisted scope, not
 * in the UI, so a member cannot widen its own reach by editing the client. The
 * Lead wires each predicate at its enforcement point (team-tool admission,
 * blackboard-write admission, board read projection).
 */

import type { TeamStore, TeamMember } from '../../../team/types'
import type { OfficeScope } from '../../../federation/types'
import { DEFAULT_OFFICE_SCOPE } from '../../../federation/types'
import type { BlackboardSnapshot } from '../../../../../shared/apps/team-types'

export interface ScopeGate {
  /** Resolve a member's effective scope; null/invalid scope_json → default-open. */
  parseScope(member: TeamMember): OfficeScope
  /** False when target is contactable lead-only and the sender is not the lead. */
  canContact(teamId: string, fromAppId: string, toAppId: string): boolean
  /** False for read-only spectators (cannot be assigned a task). */
  canBeAssigned(teamId: string, appId: string): boolean
  /**
   * Whether a member may post tasks/findings as coordination.
   *
   * Fail-CLOSED for write admission: an empty/unknown appId is NOT a known
   * member, so it gets NO default-open fallback — it is denied. Only a known
   * member whose scope is not read-only may write. This is the security-sensitive
   * decision; reads (filterBoard/canContact) keep their public default-open
   * fallback, writes do not.
   */
  canCoordinationWrite(teamId: string, appId: string): boolean
  /** Project a board snapshot down to what this member may see. */
  filterBoard(teamId: string, appId: string, snapshot: BlackboardSnapshot): BlackboardSnapshot
  /** Whether this member may mint further invites. */
  canReinvite(teamId: string, appId: string): boolean
}

/**
 * Parse a raw scope_json string into an OfficeScope, falling back to fully-open
 * on null/empty/malformed input so a missing overlay never accidentally denies.
 */
export function parseOfficeScope(scopeJson: string | null | undefined): OfficeScope {
  if (!scopeJson) return DEFAULT_OFFICE_SCOPE
  try {
    const raw = JSON.parse(scopeJson) as Partial<OfficeScope>
    if (!raw || typeof raw !== 'object') return DEFAULT_OFFICE_SCOPE
    return {
      visibility:
        raw.visibility === 'assigned' || raw.visibility === 'readonly'
          ? raw.visibility
          : DEFAULT_OFFICE_SCOPE.visibility,
      contactable:
        raw.contactable === 'lead-only' ? 'lead-only' : DEFAULT_OFFICE_SCOPE.contactable,
      discoverable:
        typeof raw.discoverable === 'boolean'
          ? raw.discoverable
          : DEFAULT_OFFICE_SCOPE.discoverable,
      canReinvite:
        typeof raw.canReinvite === 'boolean'
          ? raw.canReinvite
          : DEFAULT_OFFICE_SCOPE.canReinvite,
    }
  } catch {
    return DEFAULT_OFFICE_SCOPE
  }
}

export function createScopeGate({ store }: { store: TeamStore }): ScopeGate {
  const memberOf = (teamId: string, appId: string): TeamMember | null =>
    store.listMembersByTeam(teamId).find((m) => m.appId === appId) ?? null

  const scopeOf = (teamId: string, appId: string): OfficeScope => {
    const member = memberOf(teamId, appId)
    return member ? parseOfficeScope(member.scopeJson) : DEFAULT_OFFICE_SCOPE
  }

  const parseScope = (member: TeamMember): OfficeScope => parseOfficeScope(member.scopeJson)

  const canContact = (teamId: string, fromAppId: string, toAppId: string): boolean => {
    const target = scopeOf(teamId, toAppId)
    if (target.contactable !== 'lead-only') return true
    // Lead-only target: only the office lead may reach it.
    const leadAppId = store.getTeamById(teamId)?.leadAppId ?? null
    return fromAppId === leadAppId
  }

  const canBeAssigned = (teamId: string, appId: string): boolean =>
    scopeOf(teamId, appId).visibility !== 'readonly'

  // Mirrors canBeAssigned (a member that cannot hold a task cannot post
  // tasks/findings). Fail-closed per the interface doc above; a refused write
  // surfaces as SCOPE_DENIED upstream.
  const canCoordinationWrite = (teamId: string, appId: string): boolean => {
    if (!appId) return false
    const member = memberOf(teamId, appId)
    if (!member) return false
    return parseOfficeScope(member.scopeJson).visibility !== 'readonly'
  }

  const filterBoard = (
    teamId: string,
    appId: string,
    snapshot: BlackboardSnapshot,
  ): BlackboardSnapshot => {
    const scope = scopeOf(teamId, appId)

    const tasks =
      scope.visibility === 'assigned'
        ? snapshot.tasks.filter((t) => t.assigneeAppId === appId)
        : snapshot.tasks

    // discoverable=false hides the full findings list; a member still sees its
    // own findings. 'readonly' visibility keeps tasks visible (read-only is a
    // UI/coordination-write concern, enforced by canCoordinationWrite, not a
    // board-read redaction).
    const findings = scope.discoverable
      ? snapshot.findings
      : snapshot.findings.filter((f) => f.authorAppId === appId)

    // The record of who did what is redacted on the same rule as findings: an
    // undiscoverable member sees only the acts it was party to. Without this a
    // narrowed member would learn the whole office's traffic from the feed it
    // could not learn from the board.
    const activities = scope.discoverable
      ? snapshot.activities
      : snapshot.activities.filter((a) => a.actorAppId === appId || a.targetAppId === appId)

    return { tasks, findings, roster: snapshot.roster, checks: snapshot.checks, activities }
  }

  const canReinvite = (teamId: string, appId: string): boolean =>
    scopeOf(teamId, appId).canReinvite

  return {
    parseScope,
    canContact,
    canBeAssigned,
    canCoordinationWrite,
    filterBoard,
    canReinvite,
  }
}
