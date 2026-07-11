/**
 * apps/runtime/federation -- Public API + module-level accessor
 *
 * Sibling of runtime/team and runtime/im-channels: owns the office JOIN
 * handshake + PRESENCE runtime, reads/writes only through TeamStore +
 * FederationStore + the link, and never touches the team coordination kernel.
 *
 * Assembly constructs a coordinator over a provided link, then publishes it via
 * setActiveFederation — mirroring setActiveTeamRuntime / setActiveImChannelManager
 * so any consumer resolves the active federation without a circular import.
 */

import { createFederationCoordinator } from './coordinator'
import type { FederationCoordinator, FederationCoordinatorDeps } from './coordinator'
import type { FederationLink } from './link'

const LOG_TAG = '[Federation]'

export interface Federation {
  coordinator: FederationCoordinator
  link: FederationLink
}

/** Deps to assemble a federation over an already-constructed link. */
export type CreateFederationDeps = FederationCoordinatorDeps

export function createFederation(deps: CreateFederationDeps): Federation {
  const coordinator = createFederationCoordinator(deps)
  console.log(`${LOG_TAG} assembled office=${deps.context.officeId} self=${deps.context.selfNodeId}`)
  return { coordinator, link: deps.link }
}

// ── Module-level accessor ──
//
// Superseded by the FederationManager accessor (getFederationManager): a node
// can host/join multiple offices, so a single "active federation" no longer
// captures the topology. Kept for back-compat with consumers/tests that hold
// one coordinator; new code should resolve the manager.

let _activeFederation: Federation | null = null

export function setActiveFederation(federation: Federation | null): void {
  _activeFederation = federation
}

export function getActiveFederation(): Federation | null {
  return _activeFederation
}

// ── Re-exports ──

export { createFederationCoordinator } from './coordinator'
export type {
  FederationCoordinator,
  FederationCoordinatorDeps,
  NodeBoundMember,
} from './coordinator'
export {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_SUSPECT_AFTER_MS,
  PRESENCE_CONFIRMED_OFFLINE_MS,
  PRESENCE_RECOVERY_HEARTBEATS,
} from './presence-constants'
export { LanMeshLink } from './lan-mesh-provider'
export type { WsSender } from './lan-mesh-provider'
export {
  InMemoryFederationLink,
  InMemoryFederationHub,
  type FederationLink,
} from './link'
export { WsFederationClient } from './ws-federation-client'
export type {
  WsFederationClientDeps,
  WsFederationClientState,
} from './ws-federation-client'
export {
  createFederationManager,
  setFederationManager,
  getFederationManager,
} from './manager'
export type {
  FederationManager,
  FederationManagerDeps,
  JoinOfficeParams,
} from './manager'
export type { OfficeCredentialLike } from './deps'
export type {
  NodeId,
  OfficeContext,
  JoinMember,
  JoinRequest,
  JoinGrant,
  JoinReject,
  PresenceUpdate,
  Heartbeat,
  SerializedWakeRequest,
  WakeFrame,
  TurnCompleteFrame,
  FederationMessage,
  NodePresence,
  PresenceSnapshot,
  RosterMemberSnap,
  RosterSnapshot,
  RosterFrame,
} from './types'
export { makeLocationAwareSessionDeps, withOwnerResolvedSpace } from './session-deps'
export type { LocationAwareSessionDepsConfig } from './session-deps'
export { createRelayCapture, createStreamReplay } from './relay'
// ── M2 authority/replication composition (re-exported for bootstrap wiring) ──
export { createOfficeAuthority } from './authority/office-authority'
export type { OfficeAuthority, OfficeAuthorityDeps } from './authority/office-authority'
export { createLocationAwareBlackboard } from './authority/location-aware-blackboard'
export type { OutboundBlackboardWrite } from './authority/location-aware-blackboard'
export type { OwnerStatus } from './authority/reconcile'
export type { MemberWriteRecord } from './authority/replication'
export type { ArtifactRef } from './protocol-m2'
export type {
  RelayCapture,
  RelayCaptureDeps,
  StreamReplay,
  StreamReplayDeps,
} from './relay'
export { classifyChannel } from './types'
export type { StreamFrame, StreamFramesFrame } from './types'
