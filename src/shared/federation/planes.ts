/**
 * The outbound planes of federation traffic, in drain priority, with each
 * plane's queue bound. One source for every queue that carries federation
 * frames: the joiner client and the host's gateway attachment import it, and
 * the Go gateway's `internal/wire/planes_gen.go` is generated from the same
 * JSON (`node scripts/gen-gateway-planes.mjs`).
 *
 * A full plane drops its own oldest frame; `capBytes` (0 = none) also bounds a
 * plane by size. Overflow in one plane never evicts another plane's frames.
 */

import planes from './planes.json'

export type FederationPlane = 'control' | 'stream' | 'feed' | 'artifact'

export interface FederationPlaneSpec {
  name: FederationPlane
  capFrames: number
  capBytes: number
}

export const FEDERATION_PLANES: readonly FederationPlaneSpec[] = planes as FederationPlaneSpec[]

/** Drain order: highest priority first. */
export const FEDERATION_PLANE_ORDER: readonly FederationPlane[] = FEDERATION_PLANES.map((p) => p.name)

export function federationPlaneSpec(name: FederationPlane): FederationPlaneSpec {
  return FEDERATION_PLANES.find((p) => p.name === name)!
}
