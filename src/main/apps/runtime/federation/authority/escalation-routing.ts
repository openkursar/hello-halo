/**
 * Cross-person "decision authority" routing. Locally, "escalate to the user"
 * points at the single human behind the machine; once an office spans multiple
 * people, "the user" splits, so an escalation must resolve to a specific
 * person's owner node:
 *   - member-level  → the OWNER of whoever dispatched the task (who assigned
 *     the work decides).
 *   - lead/office-level → the OFFICE OWNER (creator/host), the earliest-joined
 *     node in the office.
 *
 * Pure resolution: no side effects, no transport. Callers render the resolved
 * owner as the escalation target, showing only the owner's name — never node or
 * host terms.
 */

import type { TeamStore } from '../../../team/types'
import type { FederationStore } from '../../../federation/types'
import { SELF_NODE_ID } from '../../../../../shared/apps/team-types'

export type EscalationKind = 'member' | 'lead' | 'office'

export type EscalationRoutedTo = 'task-originator-owner' | 'office-owner'

export interface EscalationTarget {
  /** The owner node to route the decision to; null when it cannot be resolved. */
  ownerNodeId: string | null
  /** Human-readable owner name for owner-attributed user text; null if unknown. */
  displayName: string | null
  routedTo: EscalationRoutedTo
}

export interface ResolveEscalationParams {
  kind: EscalationKind
  teamId: string
  /** The app that dispatched the task being escalated (required for 'member'). */
  taskOriginatorAppId?: string
  store: TeamStore
  federationStore: FederationStore
}

/**
 * The office owner = the earliest-joined node in the office (creator/host).
 * federationStore.listNodesByOffice returns nodes ordered by joined_at ASC.
 */
function resolveOfficeOwner(
  teamId: string,
  federationStore: FederationStore,
): { ownerNodeId: string | null; displayName: string | null } {
  const nodes = federationStore.listNodesByOffice(teamId)
  const owner = nodes[0] ?? null
  return {
    ownerNodeId: owner?.nodeId ?? null,
    displayName: owner?.displayName ?? null,
  }
}

export function resolveEscalationTarget(params: ResolveEscalationParams): EscalationTarget {
  const { kind, teamId, taskOriginatorAppId, store, federationStore } = params

  if (kind === 'member') {
    const originator =
      taskOriginatorAppId != null
        ? store.listMembersByTeam(teamId).find((m) => m.appId === taskOriginatorAppId) ?? null
        : null
    const ownerNodeId = originator?.ownerNodeId ?? null

    // A locally-owned originator (SELF sentinel) routes to this node; surface no
    // remote node id and let the caller attribute it to the local user.
    if (ownerNodeId == null || ownerNodeId === SELF_NODE_ID) {
      return {
        ownerNodeId: ownerNodeId === SELF_NODE_ID ? SELF_NODE_ID : null,
        displayName: null,
        routedTo: 'task-originator-owner',
      }
    }

    return {
      ownerNodeId,
      displayName: federationStore.getNode(teamId, ownerNodeId)?.displayName ?? null,
      routedTo: 'task-originator-owner',
    }
  }

  const owner = resolveOfficeOwner(teamId, federationStore)
  return { ...owner, routedTo: 'office-owner' }
}
