/**
 * Public contract of the balancing policy.
 *
 * The balancer decides which member of a group a request tries, in what order,
 * and what a failure means for the member's future. It performs no I/O and
 * reads time only through an injected clock, so every rule is testable with a
 * fake one. The router owns sending requests; the balancer owns judgment.
 */

import type { AIGroupStrategy } from '../../../shared/types/ai-sources'

/** One routable target: an account × model. `key` is `groupMemberKey(member)`. */
export interface MemberRef {
  key: string
  sourceId: string
  modelId: string
}

/** A group as the policy sees it at request time. Members are in priority order. */
export interface GroupShape {
  id: string
  strategy: AIGroupStrategy
  members: readonly MemberRef[]
}

/**
 * What a failed attempt left behind. Third parties report failures in
 * inconsistent ways, so the policy never needs a failure to be recognized: it
 * acts on whatever evidence exists and treats the rest as plain failure.
 */
export type FailureEvidence =
  | { kind: 'http'; status: number; headers: Readonly<Record<string, string>>; body: string }
  | { kind: 'network'; message: string }
  | { kind: 'timeout'; phase: 'headers' | 'first-content' }
  /** A 200 reply with nothing in it. */
  | { kind: 'empty' }
  /** An error event before any content of an otherwise open stream. */
  | { kind: 'stream-error'; errorType?: string; message: string }
  /** The account could not supply a credential: removed, signed out, token unusable. */
  | { kind: 'credential'; message: string }

export type RestReason = 'quota' | 'auth' | 'rate' | 'unavailable' | 'transient'

/** What a rest covers: one model, or every model of the account. */
export type RestScope = 'member' | 'account'

export interface RestInfo {
  reason: RestReason
  scope: RestScope
  /** Epoch ms when the rest began. */
  since: number
  /** Epoch ms after which the member may be tried again. */
  until: number
  /** True when `until` came from the provider (a retry-after or a reset time), not from a guess. */
  announced: boolean
  /** Consecutive failed attempts that led here; drives the backoff. */
  failures: number
}

export interface FailureVerdict {
  /** The rest this failure started, if any. */
  rest: RestInfo | null
  /**
   * `request` when the failure looks like the request's own fault (a rejected
   * shape or size): nothing is held against the member unless another member
   * answers the same request.
   */
  blame: 'member' | 'request'
}

/** One try the run hands out. */
export interface Attempt {
  readonly member: MemberRef
  /** 1-based position within the run. */
  readonly index: number
  /** The member was resting and is being tried to find out whether it is back. */
  readonly probe: boolean
  /** The member is the one this session was already on. */
  readonly sticky: boolean
}

export interface RunSummary {
  attempted: Array<{ member: MemberRef; outcome: 'served' | 'failed' | 'abandoned'; rest: RestInfo | null }>
  /** Members left out because they rest, with the rest that kept them out. */
  resting: Array<{ member: MemberRef; rest: RestInfo }>
  /** True when no member could be tried at all. */
  nothingToTry: boolean
  /** The earliest time a resting member is expected back; null when none rests. */
  retryAt: number | null
  /** True when the attempt budget, not a lack of members, ended the run. */
  budgetSpent: boolean
}

/** The attempts one logical model request may make. */
export interface RequestRun {
  /** The next member to try, or null when the budget or the members are used up. */
  next(): Attempt | null
  /**
   * Whether `next()` would hand out an attempt right now. It has no effect: no
   * probe lease is taken and nothing advances, so the answer can be stale by the
   * time `next()` runs if another request takes the lease in between.
   */
  hasNext(): boolean
  /** The reply was committed to the caller: health recovers and the session sticks to this member. */
  succeeded(attempt: Attempt): void
  /** The attempt produced nothing the caller received. */
  failed(attempt: Attempt, evidence: FailureEvidence): FailureVerdict
  /** The attempt ended with no verdict on the member (the caller went away, or the run stopped). */
  abandoned(attempt: Attempt): void
  /** Settle the run and release pending evidence. Idempotent; the caller must also call this in finally. */
  finish(): RunSummary
}

export interface MemberHealth {
  member: MemberRef
  state: 'ready' | 'resting' | 'half-open'
  rest: RestInfo | null
  /** Consecutive failures counted against the member. */
  failures: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
}

export interface BalancerConfig {
  /** Most attempts one logical request makes, the first included. */
  maxAttempts: number
  /** Failures within `transientWindowMs` that put a member to rest when nothing says why it failed. */
  transientFailuresBeforeRest: number
  transientWindowMs: number
  transientRestInitialMs: number
  transientRestMaxMs: number
  rateRestInitialMs: number
  rateRestMaxMs: number
  /** Bounds on a rest the provider announced. */
  announcedRestMinMs: number
  announcedRestMaxMs: number
  quotaRestInitialMs: number
  quotaRestMaxMs: number
  authRestInitialMs: number
  authRestMaxMs: number
  unavailableRestInitialMs: number
  unavailableRestMaxMs: number
  /** Settled request-shape failures in a row that put a member to rest. */
  shapeFailuresBeforeRest: number
  shapeRestMs: number
  /** How long one probe may hold a member before another request may try it. */
  probeLeaseMs: number
  /** While no member is ready, the soonest-to-return one is tried at least this often even if its rest has not ended. */
  forcedProbeIntervalMs: number
  /** Sessions remembered per balancer, and how long an unused one is kept. */
  stickyMaxSessions: number
  stickyTtlMs: number
  /** Members remembered with health evidence. */
  healthMaxEntries: number
  /** Evidence about a member or account that has had no rest and no failure this long is forgotten. */
  idleForgetMs: number
}

export interface BalancerOptions {
  now?: () => number
  config?: Partial<BalancerConfig>
}

/** A serializable copy of what the balancer has learned; sessions are not part of it. */
export interface BalancerSnapshot {
  version: 1
  members: Array<{
    key: string
    failures: number
    rest: RestInfo | null
    lastSuccessAt: number | null
    lastFailureAt: number | null
  }>
  accounts: Array<{ sourceId: string; rest: RestInfo }>
}

export interface Balancer {
  /** Begin one logical request against a group. `sessionKey` names the conversation, when known. */
  start(group: GroupShape, sessionKey: string | null): RequestRun
  /** The members' current health, in the group's order. */
  health(group: GroupShape): MemberHealth[]
  /** The member a session is stuck to, or null. */
  currentMember(groupId: string, sessionKey: string): MemberRef | null
  /** End rests now ("retry now"); returns how many members or accounts were released. */
  clearRest(filter?: { sourceId?: string; memberKey?: string }): number
  /** Forget what was learned about an account: it was edited, so old evidence is stale. */
  resetSource(sourceId: string): void
  /** Forget a group's sessions. */
  forgetGroup(groupId: string): void
  snapshot(): BalancerSnapshot
  restore(snapshot: BalancerSnapshot): void
}
