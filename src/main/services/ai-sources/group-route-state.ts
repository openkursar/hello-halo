/**
 * The latest word per conversation on which model of a group serves it, kept from
 * the router's per-attempt reports. Only what a person would notice is passed on
 * (a switch, a model that began serving, nothing left to try), so a long
 * tool-heavy turn is silent.
 */

import { Emitter, type Event } from '../../platform/event'
import type { GroupRouteFact } from '../../openai-compat-router'
import type { GroupRouteInfo } from '../../../shared/types/ai-groups-runtime'

/** Conversations remembered; the oldest are forgotten first. */
const MAX_SESSIONS = 512

export class GroupRouteState {
  private readonly latest = new Map<string, GroupRouteInfo>()
  private readonly changed = new Emitter<GroupRouteInfo>()
  readonly onChange: Event<GroupRouteInfo> = this.changed.event

  /** Apply one router fact. */
  record(fact: GroupRouteFact): void {
    if (!fact.sessionKey) return
    const before = this.latest.get(fact.sessionKey)

    let next: GroupRouteInfo | null = null
    if (fact.phase === 'trying') {
      // The first attempt is the ordinary case; only leaving a model is worth showing.
      if ((fact.attempt ?? 1) > 1 && fact.member) {
        next = { groupId: fact.groupId, sessionKey: fact.sessionKey, state: 'switching', member: fact.member, previous: fact.previous, at: fact.at }
      }
    } else if (fact.phase === 'served' && fact.member) {
      const unchanged = before?.state === 'serving' && before.groupId === fact.groupId && before.member?.key === fact.member.key
      next = { groupId: fact.groupId, sessionKey: fact.sessionKey, state: 'serving', member: fact.member, at: fact.at }
      if (unchanged) {
        this.remember(next)
        return
      }
    } else if (fact.phase === 'exhausted') {
      next = { groupId: fact.groupId, sessionKey: fact.sessionKey, state: 'exhausted', at: fact.at }
    }
    if (!next) return

    this.remember(next)
    this.changed.fire(next)
  }

  /** The latest word for each given conversation, for those the router has served or tried. */
  get(sessionKeys: readonly string[]): GroupRouteInfo[] {
    const found: GroupRouteInfo[] = []
    for (const key of sessionKeys) {
      const info = this.latest.get(key)
      if (info) found.push(info)
    }
    return found
  }

  private remember(info: GroupRouteInfo): void {
    this.latest.delete(info.sessionKey)
    this.latest.set(info.sessionKey, info)
    if (this.latest.size > MAX_SESSIONS) {
      const oldest = this.latest.keys().next().value
      if (oldest !== undefined) this.latest.delete(oldest)
    }
  }
}
