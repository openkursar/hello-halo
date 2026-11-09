/**
 * The router's one balancer, and the few controls the rest of the app needs.
 *
 * What the balancer has learned about a member (that it is out of quota, that
 * it is flaky) is shared by every conversation and every group that uses it, so
 * there is one instance per process.
 */

import { createBalancer, type Balancer, type GroupShape, type MemberHealth } from '../balancing'

let balancer: Balancer | null = null

export function getGroupBalancer(): Balancer {
  balancer ??= createBalancer()
  return balancer
}

/** Swap the balancer, or drop it so the next request builds a fresh one. */
export function replaceGroupBalancer(next: Balancer | null): void {
  balancer = next
}

export function getGroupHealth(group: GroupShape): MemberHealth[] {
  return getGroupBalancer().health(group)
}

/** "Retry now": end the rests of one member, one account, or all. Returns how many were released. */
export function clearGroupRest(filter?: { sourceId?: string; memberKey?: string }): number {
  return getGroupBalancer().clearRest(filter)
}

/** An account was edited or signed in again, so what was learned about it is stale. */
export function resetGroupSource(sourceId: string): void {
  getGroupBalancer().resetSource(sourceId)
}

/** The model a conversation is on in a group, or null. */
export function getGroupSessionMember(groupId: string, sessionKey: string) {
  return getGroupBalancer().currentMember(groupId, sessionKey)
}

export function forgetGroup(groupId: string): void {
  getGroupBalancer().forgetGroup(groupId)
}
