/**
 * Invite governance policy (pure decisions). The office creator sets the invite
 * policy: whether members may re-invite, and whether admitting a newcomer
 * requires approval. Two invariants drive this module:
 *   - Default is approval-free: a newcomer who already consented joins straight
 *     away ('admit').
 *   - The invite right is not bound to the creator being online: if approval is
 *     required, admission is queued ('await-approval') even while the creator is
 *     offline — never auto-admitted to unblock, never silently dropped.
 *
 * Policy only: this module never signs or issues credential bytes. That happens
 * in the http/auth layer once a decision resolves to 'admit'.
 */

import type { OfficeScope } from '../../../federation/types'

export type AdmissionDecision = 'admit' | 'await-approval'

export interface InvitePolicy {
  /** When true, a newcomer is queued for human approval before admission. */
  requireApproval: boolean
  /** When true, non-creator members may mint their own invites. */
  allowMemberReinvite?: boolean
}

export interface AdmissionRequest {
  policy: InvitePolicy
  /**
   * Whether the office creator is currently reachable. Deliberately does NOT
   * gate the decision — surfaced so callers/tests can assert the invariant that
   * approval is queued regardless of creator presence.
   */
  isCreatorOnline: boolean
}

/**
 * Resolve whether a consented newcomer is admitted immediately or queued for
 * approval. Approval-required always yields 'await-approval' (queued), including
 * when the creator is offline — the queue is drained when an approver acts.
 */
export function evaluateAdmission(request: AdmissionRequest): AdmissionDecision {
  return request.policy.requireApproval ? 'await-approval' : 'admit'
}

/**
 * This is the per-member re-invite right from the permission overlay; the
 * office-wide allowMemberReinvite policy is a separate, additional gate the
 * Lead applies.
 */
export function canMintInvite(scope: OfficeScope): boolean {
  return scope.canReinvite
}
