/**
 * What happened to a group's requests, reported once per attempt (never per
 * streamed chunk) to whoever subscribes. Facts carry no credentials.
 */

import { Emitter, type Event } from '../../platform/event'
import type { MemberRef } from '../balancing'

export interface GroupRouteMember extends MemberRef {
  label: { account: string; model: string }
}

export interface GroupRouteFact {
  groupId: string
  /** The conversation the request belongs to, as the engine names it; null when it names none. */
  sessionKey: string | null
  /**
   * `trying`: an attempt is starting. `served`: a member's reply reached the
   * caller. `exhausted`: no member could answer.
   */
  phase: 'trying' | 'served' | 'exhausted'
  member?: GroupRouteMember
  /** 1-based attempt number within the request; present for `trying` and `served`. */
  attempt?: number
  /** For a later attempt: the member that was left and why. */
  previous?: { member: GroupRouteMember; reason: string }
  /** Epoch ms. */
  at: number
}

const emitter = new Emitter<GroupRouteFact>()

export const onGroupRouteFact: Event<GroupRouteFact> = emitter.event

export function emitGroupRouteFact(fact: GroupRouteFact): void {
  emitter.fire(fact)
}
