/**
 * The balancing policy (see DESIGN.md for the rules this implements).
 *
 * One instance holds what has been learned about members and accounts — who is
 * resting and why, who is stuck to which conversation — and hands each logical
 * request a run: the members to try, in order, within a budget.
 */

import { resolveBalancerConfig } from './config'
import { judgeFailure } from './failure-verdict'
import { StickySessions } from './sticky-sessions'
import type {
  Attempt,
  Balancer,
  BalancerConfig,
  BalancerOptions,
  BalancerSnapshot,
  FailureEvidence,
  FailureVerdict,
  GroupShape,
  MemberHealth,
  MemberRef,
  RequestRun,
  RestInfo,
  RestReason,
  RunSummary,
} from './types'

interface Lease {
  holder: number | null
  until: number
}

/** Evidence about one account × model. */
interface MemberState {
  readonly key: string
  readonly sourceId: string
  failures: number
  transientTimes: number[]
  shapeFailures: number
  rest: RestInfo | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lease: Lease
  touchedAt: number
}

/** Evidence about an account as a whole: it covers every model of the account. */
interface AccountState {
  readonly sourceId: string
  rest: RestInfo | null
  lease: Lease
  touchedAt: number
}

type Holder = MemberState | AccountState

interface AttemptRecord {
  id: number
  startedAt: number
  held: Holder[]
  outcome: 'open' | 'served' | 'failed' | 'abandoned'
  rest: RestInfo | null
  invalidated: 'source-reset' | 'rest-cleared' | null
}

function sourceOf(memberKey: string): string {
  const at = memberKey.indexOf('\u0000')
  return at === -1 ? memberKey : memberKey.slice(0, at)
}

function active(rest: RestInfo | null, now: number): rest is RestInfo {
  return rest !== null && now < rest.until
}

export function createBalancer(options: BalancerOptions = {}): Balancer {
  const clock = options.now ?? Date.now
  const config: BalancerConfig = resolveBalancerConfig(options.config)
  const members = new Map<string, MemberState>()
  const accounts = new Map<string, AccountState>()
  const sessions = new StickySessions(config.stickyMaxSessions, config.stickyTtlMs)
  const forcedProbeAt = new Map<string, number>()
  // Only open attempts and provisional rejections need invalidation; finish releases either.
  const pending = new Map<AttemptRecord, MemberRef>()
  let nextAttemptId = 1

  const freshLease = (): Lease => ({ holder: null, until: 0 })

  function invalidate(sourceId: string | undefined, reason: NonNullable<AttemptRecord['invalidated']>): void {
    for (const [record, member] of pending) {
      if (sourceId !== undefined && member.sourceId !== sourceId) continue
      record.invalidated = reason
      pending.delete(record)
    }
  }

  function memberState(ref: MemberRef, now: number): MemberState {
    let state = members.get(ref.key)
    if (!state) {
      state = {
        key: ref.key, sourceId: ref.sourceId, failures: 0, transientTimes: [], shapeFailures: 0,
        rest: null, lastSuccessAt: null, lastFailureAt: null, lease: freshLease(), touchedAt: now,
      }
      members.set(ref.key, state)
      pruneMembers(now)
    }
    state.touchedAt = now
    return state
  }

  function accountState(sourceId: string, now: number): AccountState {
    let state = accounts.get(sourceId)
    if (!state) {
      state = { sourceId, rest: null, lease: freshLease(), touchedAt: now }
      accounts.set(sourceId, state)
      pruneAccounts()
    }
    state.touchedAt = now
    return state
  }

  /** Over capacity: drop members with nothing to remember first, then the longest quiet. */
  function pruneMembers(now: number): void {
    if (members.size <= config.healthMaxEntries) return
    const ranked = [...members.values()].sort((a, b) => {
      const aKeep = a.rest !== null || a.failures > 0 ? 1 : 0
      const bKeep = b.rest !== null || b.failures > 0 ? 1 : 0
      if (aKeep !== bKeep) return aKeep - bKeep
      return (a.lastFailureAt ?? a.touchedAt) - (b.lastFailureAt ?? b.touchedAt)
    })
    for (const state of ranked) {
      if (members.size <= config.healthMaxEntries) break
      if (state.lease.holder !== null && now < state.lease.until) continue
      members.delete(state.key)
    }
  }

  function pruneAccounts(): void {
    if (accounts.size <= config.healthMaxEntries) return
    const ranked = [...accounts.values()].sort((a, b) => a.touchedAt - b.touchedAt)
    for (const state of ranked) {
      if (accounts.size <= config.healthMaxEntries) break
      accounts.delete(state.sourceId)
    }
  }

  /** Forget what has gone stale: a rest nobody revisited, and failures long past. */
  function refresh(state: MemberState | undefined, now: number): void {
    if (!state) return
    if (state.rest && now - state.rest.until > config.idleForgetMs) state.rest = null
    if (!state.rest && state.lastFailureAt !== null && now - state.lastFailureAt > config.idleForgetMs) {
      state.failures = 0
      state.shapeFailures = 0
      state.transientTimes = []
    }
  }

  function refreshAccount(state: AccountState | undefined, now: number): void {
    if (state?.rest && now - state.rest.until > config.idleForgetMs) state.rest = null
  }

  interface View {
    state: MemberHealth['state']
    rest: RestInfo | null
  }

  function view(ref: MemberRef, now: number): View {
    const own = members.get(ref.key)
    const account = accounts.get(ref.sourceId)
    refresh(own, now)
    refreshAccount(account, now)
    const rests = [own?.rest ?? null, account?.rest ?? null].filter((rest): rest is RestInfo => rest !== null)
    if (rests.length === 0) return { state: 'ready', rest: null }
    const latest = (list: RestInfo[]) => list.reduce((a, b) => (b.until > a.until ? b : a))
    const holding = rests.filter(rest => now < rest.until)
    if (holding.length > 0) return { state: 'resting', rest: latest(holding) }
    return { state: 'half-open', rest: latest(rests) }
  }

  /** The holders whose rest a probe of this member would test; they need one probe at a time. */
  function probeHolders(ref: MemberRef): Holder[] {
    const holders: Holder[] = []
    const own = members.get(ref.key)
    const account = accounts.get(ref.sourceId)
    if (own?.rest) holders.push(own)
    if (account?.rest) holders.push(account)
    return holders
  }

  const leaseFree = (holder: Holder, now: number) => holder.lease.holder === null || now >= holder.lease.until

  function release(held: Holder[], id: number): void {
    for (const holder of held) {
      if (holder.lease.holder === id) holder.lease = freshLease()
    }
  }

  function restFor(reason: RestReason, failures: number): number {
    const table: Record<RestReason, [number, number]> = {
      quota: [config.quotaRestInitialMs, config.quotaRestMaxMs],
      auth: [config.authRestInitialMs, config.authRestMaxMs],
      rate: [config.rateRestInitialMs, config.rateRestMaxMs],
      unavailable: [config.unavailableRestInitialMs, config.unavailableRestMaxMs],
      transient: [config.transientRestInitialMs, config.transientRestMaxMs],
    }
    const [initial, max] = table[reason]
    return Math.min(initial * 2 ** (failures - 1), max)
  }

  function putToRest(
    holder: MemberState | AccountState,
    reason: RestReason,
    scope: RestInfo['scope'],
    announcedUntil: number | null,
    now: number
  ): RestInfo {
    const previous = holder.rest
    const failures = previous && previous.reason === reason ? previous.failures + 1 : 1
    const announced = announcedUntil !== null
    const duration = announced
      ? Math.min(Math.max(announcedUntil - now, config.announcedRestMinMs), config.announcedRestMaxMs)
      : restFor(reason, failures)
    let until = now + duration
    // A probe that failed early must not shorten a rest that is still running.
    if (active(previous, now)) until = Math.max(until, previous.until)
    const rest: RestInfo = { reason, scope, since: now, until, announced, failures }
    holder.rest = rest
    return rest
  }

  function clearMemberEvidence(state: MemberState): void {
    state.rest = null
    state.failures = 0
    state.transientTimes = []
    state.shapeFailures = 0
  }

  class Run implements RequestRun {
    private readonly order: MemberRef[]
    private readonly stickyKey: string | null
    private readonly tried = new Set<string>()
    private readonly records = new Map<Attempt, AttemptRecord>()
    private readonly provisional = new Map<Attempt, AttemptRecord>()
    private cursor = 0
    private handed = 0
    private summary: RunSummary | null = null

    constructor(private readonly group: GroupShape, private readonly sessionKey: string | null) {
      const now = clock()
      this.stickyKey = sessionKey ? sessions.get(group.id, sessionKey, now) : null
      this.order = this.buildOrder(now)
    }

    private buildOrder(now: number): MemberRef[] {
      const { group } = this
      const eligible = group.members.filter(member => view(member, now).state !== 'resting')
      const sticky = this.stickyKey ? eligible.find(member => member.key === this.stickyKey) : undefined
      if (sticky) return [sticky, ...eligible.filter(member => member !== sticky)]
      if (group.strategy === 'spread' && eligible.length > 1) {
        const load = sessions.loadOf(group.id, now)
        let first = eligible[0]
        for (const member of eligible) {
          if ((load.get(member.key) ?? 0) < (load.get(first.key) ?? 0)) first = member
        }
        return [first, ...eligible.filter(member => member !== first)]
      }
      return eligible
    }

    /** The next member that can be tried now, without taking anything. */
    private peek(now: number): { member: MemberRef; probe: boolean; forced: boolean; position: number } | null {
      for (let position = this.cursor; position < this.order.length; position++) {
        const member = this.order[position]
        if (this.tried.has(member.key) || view(member, now).state === 'resting') continue
        const holders = probeHolders(member)
        if (holders.some(holder => !leaseFree(holder, now))) continue
        return { member, probe: holders.length > 0, forced: false, position }
      }

      // Nothing ready. If every member rests, the soonest to return is tried now and then
      // so a wrong guess about a long rest cannot lock the group out.
      if (this.handed > 0) return null
      const pending = this.group.members.filter(member => !this.tried.has(member.key))
      if (pending.length === 0 || pending.some(member => view(member, now).state !== 'resting')) return null
      if (now - (forcedProbeAt.get(this.group.id) ?? -Infinity) < config.forcedProbeIntervalMs) return null
      const [soonest] = pending
        .map(member => ({ member, rest: view(member, now).rest }))
        .sort((a, b) => (a.rest?.until ?? Infinity) - (b.rest?.until ?? Infinity))
      if (!soonest?.rest || now - soonest.rest.since < config.forcedProbeIntervalMs) return null
      if (!probeHolders(soonest.member).every(holder => leaseFree(holder, now))) return null
      return { member: soonest.member, probe: true, forced: true, position: -1 }
    }

    hasNext(): boolean {
      if (this.summary || this.handed >= config.maxAttempts) return false
      return this.peek(clock()) !== null
    }

    next(): Attempt | null {
      if (this.summary || this.handed >= config.maxAttempts) return null
      const now = clock()
      const found = this.peek(now)
      if (!found) return null

      if (found.position >= 0) this.cursor = found.position + 1
      if (found.forced) forcedProbeAt.set(this.group.id, now)
      this.tried.add(found.member.key)

      const id = nextAttemptId++
      const held = probeHolders(found.member)
      for (const holder of held) holder.lease = { holder: id, until: now + config.probeLeaseMs }
      const attempt: Attempt = {
        member: found.member,
        index: ++this.handed,
        probe: found.probe,
        sticky: found.member.key === this.stickyKey,
      }
      const record: AttemptRecord = { id, startedAt: now, held, outcome: 'open', rest: null, invalidated: null }
      this.records.set(attempt, record)
      pending.set(record, attempt.member)
      return attempt
    }

    private dropStale(attempt: Attempt, record: AttemptRecord, outcome: 'success' | 'failure' | 'shape-failure'): boolean {
      if (!record.invalidated) return false
      console.warn(`[Router] group_outcome_stale group=${this.group.id} attempt=${attempt.index} source=${attempt.member.sourceId} model=${attempt.member.modelId} outcome=${outcome} reason=${record.invalidated}: ignored obsolete balancing evidence`)
      return true
    }

    succeeded(attempt: Attempt): void {
      const record = this.records.get(attempt)
      if (!record || record.outcome !== 'open') return
      const now = clock()
      record.outcome = 'served'
      release(record.held, record.id)
      pending.delete(record)

      // Another member answered the same request, so the request was sound:
      // earlier rejections of its shape count against the members that made them.
      for (const [rejected, rejection] of this.provisional) {
        pending.delete(rejection)
        if (this.dropStale(rejected, rejection, 'shape-failure')) continue
        const state = memberState(rejected.member, now)
        state.shapeFailures += 1
        if (state.shapeFailures >= config.shapeFailuresBeforeRest) {
          state.shapeFailures = 0
          putToRest(state, 'unavailable', 'member', now + config.shapeRestMs, now)
        }
      }
      this.provisional.clear()
      if (this.dropStale(attempt, record, 'success')) return

      const state = members.get(attempt.member.key)
      if (state) {
        state.lastSuccessAt = now
        state.shapeFailures = 0
        if (!state.rest || record.startedAt >= state.rest.since) {
          const restored = state.rest !== null
          clearMemberEvidence(state)
          if (!restored && state.lastFailureAt === null) members.delete(state.key)
        }
      }
      const account = accounts.get(attempt.member.sourceId)
      if (account?.rest && record.startedAt >= account.rest.since) {
        account.rest = null
        accounts.delete(account.sourceId)
      }
      if (this.sessionKey) sessions.set(this.group.id, this.sessionKey, attempt.member.key, now)
    }

    failed(attempt: Attempt, evidence: FailureEvidence): FailureVerdict {
      const record = this.records.get(attempt)
      if (!record || record.outcome !== 'open') return { rest: record?.rest ?? null, blame: 'member' }
      const now = clock()
      record.outcome = 'failed'
      release(record.held, record.id)
      pending.delete(record)
      if (this.dropStale(attempt, record, 'failure')) return { rest: null, blame: 'member' }

      const judgment = judgeFailure(evidence, now)
      if (judgment.blame === 'request') {
        this.provisional.set(attempt, record)
        pending.set(record, attempt.member)
        return { rest: null, blame: 'request' }
      }

      const state = memberState(attempt.member, now)
      state.lastFailureAt = now
      state.failures += 1
      const target: MemberState | AccountState = judgment.scope === 'account'
        ? accountState(attempt.member.sourceId, now)
        : state

      // Evidence gathered before the rest began is what the rest already reflects.
      if (active(target.rest, now) && record.startedAt < target.rest.since) {
        record.rest = target.rest
        return { rest: target.rest, blame: 'member' }
      }

      if (!judgment.immediate) {
        state.transientTimes = state.transientTimes.filter(at => now - at < config.transientWindowMs)
        state.transientTimes.push(now)
        const probeFailure = state.rest !== null
        if (!probeFailure && state.transientTimes.length < config.transientFailuresBeforeRest) {
          return { rest: null, blame: 'member' }
        }
      }

      const rest = putToRest(target, judgment.reason, judgment.scope, judgment.announcedUntil, now)
      record.rest = rest
      return { rest, blame: 'member' }
    }

    abandoned(attempt: Attempt): void {
      const record = this.records.get(attempt)
      if (!record || record.outcome !== 'open') return
      record.outcome = 'abandoned'
      release(record.held, record.id)
      pending.delete(record)
    }

    finish(): RunSummary {
      if (this.summary) return this.summary
      const now = clock()
      for (const record of this.records.values()) {
        pending.delete(record)
        if (record.outcome === 'open') {
          record.outcome = 'abandoned'
          release(record.held, record.id)
        }
      }
      this.provisional.clear()
      const attempted: RunSummary['attempted'] = []
      for (const [attempt, record] of this.records) {
        attempted.push({
          member: attempt.member,
          outcome: record.outcome === 'open' ? 'abandoned' : record.outcome,
          rest: record.rest,
        })
      }
      const resting: RunSummary['resting'] = []
      let untriedReady = false
      for (const member of this.group.members) {
        if (this.tried.has(member.key)) continue
        const state = view(member, now)
        if (state.state === 'resting' && state.rest) resting.push({ member, rest: state.rest })
        else untriedReady = true
      }
      this.summary = {
        attempted,
        resting,
        nothingToTry: this.handed === 0,
        retryAt: resting.length > 0 ? Math.min(...resting.map(item => item.rest.until)) : null,
        budgetSpent: this.handed >= config.maxAttempts && untriedReady,
      }
      return this.summary
    }
  }

  return {
    start(group, sessionKey) {
      return new Run(group, sessionKey)
    },

    health(group) {
      const now = clock()
      return group.members.map((member): MemberHealth => {
        const current = view(member, now)
        const state = members.get(member.key)
        return {
          member,
          state: current.state,
          rest: current.rest,
          failures: state?.failures ?? 0,
          lastSuccessAt: state?.lastSuccessAt ?? null,
          lastFailureAt: state?.lastFailureAt ?? null,
        }
      })
    },

    currentMember(groupId, sessionKey) {
      const key = sessions.get(groupId, sessionKey, clock())
      return key ? { key, sourceId: sourceOf(key), modelId: key.slice(sourceOf(key).length + 1) } : null
    },

    clearRest(filter) {
      // A member retry also clears its account rest, so sibling attempts are stale too.
      invalidate(filter?.memberKey ? sourceOf(filter.memberKey) : filter?.sourceId || undefined, 'rest-cleared')
      let released = 0
      const releaseAccount = (sourceId: string) => {
        const account = accounts.get(sourceId)
        if (account?.rest) {
          released += 1
          accounts.delete(sourceId)
        }
      }
      if (filter?.memberKey) {
        const state = members.get(filter.memberKey)
        if (state?.rest) released += 1
        if (state) members.delete(filter.memberKey)
        releaseAccount(sourceOf(filter.memberKey))
      } else if (filter?.sourceId) {
        releaseAccount(filter.sourceId)
        for (const state of [...members.values()]) {
          if (state.sourceId !== filter.sourceId) continue
          if (state.rest) released += 1
          members.delete(state.key)
        }
      } else {
        for (const state of members.values()) if (state.rest) released += 1
        for (const state of accounts.values()) if (state.rest) released += 1
        members.clear()
        accounts.clear()
      }
      return released
    },

    resetSource(sourceId) {
      invalidate(sourceId, 'source-reset')
      accounts.delete(sourceId)
      for (const state of [...members.values()]) {
        if (state.sourceId === sourceId) members.delete(state.key)
      }
      sessions.forgetAccount(sourceId)
    },

    forgetGroup(groupId) {
      sessions.forgetGroup(groupId)
      forcedProbeAt.delete(groupId)
    },

    snapshot(): BalancerSnapshot {
      return {
        version: 1,
        members: [...members.values()].map(state => ({
          key: state.key,
          failures: state.failures,
          rest: state.rest,
          lastSuccessAt: state.lastSuccessAt,
          lastFailureAt: state.lastFailureAt,
        })),
        accounts: [...accounts.values()].flatMap(state => (state.rest ? [{ sourceId: state.sourceId, rest: state.rest }] : [])),
      }
    },

    restore(snapshot) {
      const now = clock()
      members.clear()
      accounts.clear()
      if (snapshot?.version !== 1) return
      // A rest that ends further ahead than any provider can announce came from a clock that has since moved back.
      const plausible = (rest: RestInfo | null): RestInfo | null =>
        rest && rest.until - now <= config.announcedRestMaxMs ? rest : null
      for (const entry of snapshot.members.slice(0, config.healthMaxEntries)) {
        members.set(entry.key, {
          key: entry.key,
          sourceId: sourceOf(entry.key),
          failures: entry.failures,
          transientTimes: [],
          shapeFailures: 0,
          rest: plausible(entry.rest),
          lastSuccessAt: entry.lastSuccessAt,
          lastFailureAt: entry.lastFailureAt,
          lease: freshLease(),
          touchedAt: now,
        })
      }
      for (const entry of snapshot.accounts.slice(0, config.healthMaxEntries)) {
        const rest = plausible(entry.rest)
        if (rest) accounts.set(entry.sourceId, { sourceId: entry.sourceId, rest, lease: freshLease(), touchedAt: now })
      }
    },
  }
}
