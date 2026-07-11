/**
 * apps/runtime/federation -- Injected dependency contracts
 *
 * The coordinator depends on the persistence contract from apps/federation and
 * a structural credential shape — NOT on http/auth. Credential verification is
 * passed in by the Lead's wiring (which lives in the transport tier), so this
 * module imports nothing from http/* and the dependency direction stays
 * downward-only.
 */

import type { FederationStore, OfficeScope } from '../../federation'

export type { FederationStore }

/**
 * The minimal shape the coordinator reads off a verified office credential.
 * Structurally compatible with http/auth's OfficeCredential so the real verifier
 * can be injected without this module importing the transport tier. The scope is
 * the per-invite permission overlay the join handler persists onto each brought
 * member row, so the member row is the single source the authority's scope gate
 * reads — a narrowly-invited guest does not fall back to the open default.
 */
export interface OfficeCredentialLike {
  officeId: string
  scope: OfficeScope
}
