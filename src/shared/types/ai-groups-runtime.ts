/**
 * What clients are told about load-balancing groups while they run: which
 * model serves a conversation, and which models are resting. Both come from
 * the router's own reports, never from stored configuration.
 */

import type { RestReasonName } from '../ai-groups'

/** A model of a group in the words a person uses for it. */
export interface GroupRouteMember {
  key: string
  sourceId: string
  modelId: string
  label: { account: string; model: string }
}

export interface GroupRouteInfo {
  groupId: string
  /** The conversation as its engine names it; the halo engine uses the conversation id. */
  sessionKey: string
  state: 'serving' | 'switching' | 'exhausted'
  /** The model serving, or being tried while `state` is `switching`. Absent when exhausted. */
  member?: GroupRouteMember
  /** While switching: the model that was left and why. */
  previous?: { member: GroupRouteMember; reason: string }
  /** Epoch ms of the last change. */
  at: number
}

export interface GroupMemberHealth {
  sourceId: string
  modelId: string
  state: 'ready' | 'resting' | 'half-open'
  /** Why a resting model rests. */
  reason?: RestReasonName
  /** Epoch ms the rest is expected to end; absent unless resting. */
  until?: number
}

export interface GroupHealth {
  groupId: string
  members: GroupMemberHealth[]
}

/** Push channel carrying a `GroupRouteInfo`. */
export const GROUP_ROUTE_EVENT = 'ai-sources:group-route'
