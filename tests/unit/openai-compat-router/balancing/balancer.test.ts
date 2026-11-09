import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBalancer, DEFAULT_BALANCER_CONFIG } from '../../../../src/main/openai-compat-router/balancing'
import type {
  Balancer,
  BalancerConfig,
  FailureEvidence,
  GroupShape,
  MemberRef,
  RequestRun,
} from '../../../../src/main/openai-compat-router/balancing'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const ref = (sourceId: string, modelId = 'm'): MemberRef => ({ key: `${sourceId}\u0000${modelId}`, sourceId, modelId })
const A = ref('a')
const B = ref('b')
const C = ref('c')
const D = ref('d')

const shape = (members: MemberRef[], strategy: GroupShape['strategy'] = 'priority', id = 'g'): GroupShape => ({ id, strategy, members })
const http = (status: number, body = '', headers: Record<string, string> = {}): FailureEvidence => ({ kind: 'http', status, headers, body })
const SERVER_ERROR = http(500)
const RATE_LIMITED = http(429)
const QUOTA = http(402)
const BAD_REQUEST = http(400, 'messages: text content blocks must be non-empty')

let now: number
let balancer: Balancer
const create = (config?: Partial<BalancerConfig>) => createBalancer({ now: () => now, config })

beforeEach(() => {
  now = 1_700_000_000_000
  balancer = create()
})

/** Hand out every attempt a run will give, failing each with the same evidence. */
function failAll(run: RequestRun, evidence: FailureEvidence): string[] {
  const tried: string[] = []
  for (let attempt = run.next(); attempt; attempt = run.next()) {
    tried.push(attempt.member.sourceId)
    run.failed(attempt, evidence)
  }
  return tried
}

/** One request that is answered by the first member that is offered. */
function serve(group: GroupShape, sessionKey: string | null = null): string {
  const run = balancer.start(group, sessionKey)
  const attempt = run.next()!
  run.succeeded(attempt)
  run.finish()
  return attempt.member.sourceId
}

/** One request whose first `failures` members fail with `evidence`, then the next one answers. */
function serveAfter(group: GroupShape, sessionKey: string | null, evidence: FailureEvidence, failures: number): string {
  const run = balancer.start(group, sessionKey)
  for (let i = 0; i < failures; i++) run.failed(run.next()!, evidence)
  const attempt = run.next()!
  run.succeeded(attempt)
  run.finish()
  return attempt.member.sourceId
}

const stateOf = (group: GroupShape, member: MemberRef) => balancer.health(group).find(item => item.member.key === member.key)!

describe('order of attempts', () => {
  it('follows the group order', () => {
    expect(failAll(balancer.start(shape([A, B, C]), null), SERVER_ERROR)).toEqual(['a', 'b', 'c'])
  })

  it('offers a sticky member first, and says so', () => {
    const group = shape([A, B, C])
    expect(serveAfter(group, 's1', SERVER_ERROR, 1)).toBe('b')
    const run = balancer.start(group, 's1')
    const first = run.next()!
    expect(first.member.sourceId).toBe('b')
    expect(first.sticky).toBe(true)
    expect(run.next()!.member.sourceId).toBe('a')
  })

  it('does not stick a session that was never served', () => {
    const group = shape([A, B])
    const run = balancer.start(group, 's1')
    run.failed(run.next()!, SERVER_ERROR)
    run.finish()
    expect(balancer.currentMember('g', 's1')).toBeNull()
  })

  it('keeps sessions apart', () => {
    const group = shape([A, B])
    serveAfter(group, 's1', SERVER_ERROR, 1)
    expect(balancer.start(group, 's2').next()!.member.sourceId).toBe('a')
    expect(balancer.start(group, null).next()!.member.sourceId).toBe('a')
  })

  it('lets a session whose member rests go elsewhere and keeps the entry when nothing is served', () => {
    const group = shape([A, B, C])
    serveAfter(group, 's1', SERVER_ERROR, 1) // sticks to b
    const other = balancer.start(group, 's2')
    other.failed(other.next()!, RATE_LIMITED) // a rests
    other.failed(other.next()!, RATE_LIMITED) // b rests
    other.finish()
    const run = balancer.start(group, 's1')
    const attempt = run.next()!
    expect(attempt.member.sourceId).toBe('c')
    expect(attempt.sticky).toBe(false)
    run.failed(attempt, SERVER_ERROR)
    run.finish()
    expect(balancer.currentMember('g', 's1')?.sourceId).toBe('b')
  })

  it('moves a session to the member that actually served it', () => {
    const group = shape([A, B, C])
    serveAfter(group, 's1', SERVER_ERROR, 1) // b
    const run = balancer.start(group, 's1')
    run.failed(run.next()!, SERVER_ERROR) // b fails once more (no rest yet)
    const attempt = run.next()!
    run.succeeded(attempt)
    expect(attempt.member.sourceId).toBe('a')
    expect(balancer.currentMember('g', 's1')?.sourceId).toBe('a')
  })

  it('does not move a session when a better member recovers, but starts new sessions on it', () => {
    const group = shape([A, B])
    const probe = balancer.start(group, 'other')
    probe.failed(probe.next()!, RATE_LIMITED) // a rests 30s
    probe.succeeded(probe.next()!) // b answers
    expect(serve(group, 's1')).toBe('b')
    now += 31 * SECOND
    // a is back: the conversation stays, a new one returns to it.
    expect(balancer.start(group, 's1').next()!.member.sourceId).toBe('b')
    const fresh = balancer.start(group, 's2').next()!
    expect(fresh.member.sourceId).toBe('a')
    expect(fresh.probe).toBe(true)
  })

  it('ignores a sticky entry for a member that left the group', () => {
    serve(shape([A, B]), 's1')
    expect(balancer.start(shape([B, C]), 's1').next()!.member.sourceId).toBe('b')
    expect(balancer.start(shape([C, D]), 's1').next()!.member.sourceId).toBe('c')
  })

  it('forgets a session unused for the time-to-live', () => {
    const group = shape([A, B])
    serveAfter(group, 's1', SERVER_ERROR, 1)
    now += DEFAULT_BALANCER_CONFIG.stickyTtlMs + 1
    expect(balancer.currentMember('g', 's1')).toBeNull()
    expect(balancer.start(group, 's1').next()!.member.sourceId).toBe('a')
  })

  it('starts a spread group\'s new sessions on the least loaded member, ties by order', () => {
    const group = shape([A, B, C], 'spread')
    expect(serve(group, 's1')).toBe('a')
    expect(serve(group, 's2')).toBe('b')
    expect(serve(group, 's3')).toBe('c')
    expect(serve(group, 's4')).toBe('a')
    expect(serve(group, 's5')).toBe('b')
  })

  it('keeps a spread session where it is, and avoids resting members', () => {
    const group = shape([A, B], 'spread')
    serve(group, 's1') // a
    serve(group, 's2') // b
    expect(balancer.start(group, 's1').next()!.member.sourceId).toBe('a')
    const run = balancer.start(group, 'x')
    run.failed(run.next()!, RATE_LIMITED) // a rests
    expect(serve(group, 's3')).toBe('b')
  })

  it('does not spread a priority group', () => {
    const group = shape([A, B])
    serve(group, 's1')
    expect(serve(group, 's2')).toBe('a')
  })

  it('is deterministic', () => {
    const run = () => {
      const local = createBalancer({ now: () => now })
      const group = shape([A, B, C], 'spread')
      const order: string[] = []
      for (const session of ['s1', 's2', 's3', 's4']) {
        const r = local.start(group, session)
        const attempt = r.next()!
        r.succeeded(attempt)
        order.push(attempt.member.sourceId)
      }
      return order
    }
    expect(run()).toEqual(run())
  })
})

describe('attempt budget', () => {
  it('allows three attempts and says the budget ended the run', () => {
    const run = balancer.start(shape([A, B, C, D]), null)
    expect(failAll(run, SERVER_ERROR)).toEqual(['a', 'b', 'c'])
    expect(run.finish().budgetSpent).toBe(true)
  })

  it('honors a different budget', () => {
    const local = create({ maxAttempts: 2 })
    expect(failAll(local.start(shape([A, B, C]), null), SERVER_ERROR)).toEqual(['a', 'b'])
  })

  it('never offers a member twice', () => {
    const run = balancer.start(shape([A]), null)
    expect(failAll(run, SERVER_ERROR)).toEqual(['a'])
    const summary = run.finish()
    expect(summary.budgetSpent).toBe(false)
    expect(summary.nothingToTry).toBe(false)
  })

  it('numbers attempts from one', () => {
    const run = balancer.start(shape([A, B]), null)
    expect(run.next()!.index).toBe(1)
    expect(run.next()!.index).toBe(2)
  })

  it('does not offer anything after the run is finished', () => {
    const run = balancer.start(shape([A, B]), null)
    run.finish()
    expect(run.next()).toBeNull()
    expect(run.hasNext()).toBe(false)
  })
})

describe('hasNext', () => {
  it('has no effect and agrees with next', () => {
    const run = balancer.start(shape([A, B]), null)
    expect(run.hasNext()).toBe(true)
    expect(run.hasNext()).toBe(true)
    run.failed(run.next()!, SERVER_ERROR)
    expect(run.hasNext()).toBe(true)
    run.failed(run.next()!, SERVER_ERROR)
    expect(run.hasNext()).toBe(false)
    expect(run.next()).toBeNull()
  })

  it('does not take the probe lease it reports', () => {
    const group = shape([A, B])
    const resting = balancer.start(group, null)
    resting.failed(resting.next()!, RATE_LIMITED)
    now += 31 * SECOND
    const peeking = balancer.start(group, null)
    expect(peeking.hasNext()).toBe(true)
    const other = balancer.start(group, null)
    expect(other.next()!.member.sourceId).toBe('a') // still free for another request
    // the peek's answer can be stale: the lease went to someone else
    const mine = peeking.next()!
    expect(mine.member.sourceId).toBe('b')
  })

  it('reports false when only resting members are left', () => {
    const group = shape([A])
    const first = balancer.start(group, null)
    first.failed(first.next()!, RATE_LIMITED)
    expect(balancer.start(group, null).hasNext()).toBe(false)
  })

  it('does not record the forced probe it reports', () => {
    const group = shape([A])
    const first = balancer.start(group, null)
    first.failed(first.next()!, QUOTA)
    now += 61 * SECOND
    const run = balancer.start(group, null)
    expect(run.hasNext()).toBe(true)
    expect(run.hasNext()).toBe(true)
    expect(run.next()!.probe).toBe(true)
  })
})

describe('what a failure means', () => {
  const verdictOf = (evidence: FailureEvidence, group = shape([A, B])) => {
    const run = balancer.start(group, null)
    return run.failed(run.next()!, evidence)
  }

  it.each([
    ['402', QUOTA, 'quota', 'account', 30 * MINUTE],
    ['a 429 that names a quota', http(429, 'You exceeded your current quota'), 'quota', 'account', 30 * MINUTE],
    ['a 400 that names a credit balance', http(400, 'Your credit balance is too low'), 'quota', 'account', 30 * MINUTE],
    ['a 429', RATE_LIMITED, 'rate', 'member', 30 * SECOND],
    ['a 529', http(529), 'rate', 'member', 30 * SECOND],
    ['a 401', http(401), 'auth', 'account', 5 * MINUTE],
    ['a 403', http(403, 'forbidden'), 'auth', 'member', 5 * MINUTE],
    ['an unusable credential', { kind: 'credential', message: 'signed out' } as const, 'auth', 'account', 5 * MINUTE],
    ['a 404', http(404), 'unavailable', 'member', 30 * MINUTE],
  ] as const)('puts a member to rest after %s', (_label, evidence, reason, scope, duration) => {
    const verdict = verdictOf(evidence)
    expect(verdict.blame).toBe('member')
    expect(verdict.rest).toEqual({ reason, scope, since: now, until: now + duration, announced: false, failures: 1 })
  })

  it.each([
    ['a 500', SERVER_ERROR],
    ['a 503', http(503)],
    ['a dropped connection', { kind: 'network', message: 'reset' } as const],
    ['an empty reply', { kind: 'empty' } as const],
    ['a timeout', { kind: 'timeout', phase: 'headers' } as const],
  ])('rests nothing for the first failure that is %s', (_label, evidence) => {
    expect(verdictOf(evidence).rest).toBeNull()
  })

  it('rests a member after the third unexplained failure within the window, then backs off', () => {
    const group = shape([A])
    const fail = () => {
      const run = balancer.start(group, null)
      return run.failed(run.next()!, SERVER_ERROR)
    }
    expect(fail().rest).toBeNull()
    now += 10 * SECOND
    expect(fail().rest).toBeNull()
    now += 10 * SECOND
    const rest = fail().rest!
    expect(rest).toMatchObject({ reason: 'transient', scope: 'member', until: now + 30 * SECOND, failures: 1 })
  })

  it('does not add up failures that are further apart than the window', () => {
    const group = shape([A])
    const fail = () => {
      const run = balancer.start(group, null)
      return run.failed(run.next()!, SERVER_ERROR)
    }
    fail()
    now += 3 * MINUTE
    fail()
    now += 3 * MINUTE
    expect(fail().rest).toBeNull()
  })

  it('uses the time the provider announced, bounded', () => {
    const announced = (headers: Record<string, string>) => {
      const local = create()
      const run = local.start(shape([A, B]), null)
      return run.failed(run.next()!, http(429, '', headers)).rest!
    }
    expect(announced({ 'retry-after': '120' })).toMatchObject({ until: now + 120 * SECOND, announced: true })
    expect(announced({ 'retry-after-ms': '200' })).toMatchObject({ until: now + 1 * SECOND, announced: true })
    expect(announced({ 'retry-after': String(30 * 24 * 3600) })).toMatchObject({ until: now + 24 * HOUR, announced: true })
    expect(announced({ 'x-ratelimit-reset-requests': '6m0s' })).toMatchObject({ until: now + 6 * MINUTE })
  })

  it('falls back to its own backoff when the announcement is unusable', () => {
    const run = balancer.start(shape([A, B]), null)
    expect(run.failed(run.next()!, http(429, '', { 'retry-after': 'soon' })).rest)
      .toMatchObject({ until: now + 30 * SECOND, announced: false })
  })

  it.each([
    ['the provider announced', http(429, '', { 'retry-after': '90' })],
    ['it did not', RATE_LIMITED],
  ])('knows the member is resting afterwards when %s', (_label, evidence) => {
    const group = shape([A, B])
    verdictOf(evidence, group)
    expect(stateOf(group, A).state).toBe('resting')
    expect(stateOf(group, B).state).toBe('ready')
    expect(balancer.start(group, null).next()!.member.sourceId).toBe('b')
  })

  it('lets an account rest cover its other models', () => {
    const a1 = ref('a', 'm1')
    const a2 = ref('a', 'm2')
    const group = shape([a1, a2, B])
    const run = balancer.start(group, null)
    run.failed(run.next()!, QUOTA)
    expect(stateOf(group, a1).state).toBe('resting')
    expect(stateOf(group, a2).state).toBe('resting')
    expect(stateOf(group, B).state).toBe('ready')
    expect(balancer.start(group, null).next()!.member.key).toBe(B.key)
  })

  it('keeps a member-scope rest to the one model', () => {
    const a1 = ref('a', 'm1')
    const a2 = ref('a', 'm2')
    const group = shape([a1, a2])
    const run = balancer.start(group, null)
    run.failed(run.next()!, RATE_LIMITED)
    expect(stateOf(group, a2).state).toBe('ready')
  })

  it('doubles the rest with each failed probe, up to the cap', () => {
    const group = shape([A])
    const durations: number[] = []
    for (let round = 0; round < 7; round++) {
      const run = balancer.start(group, null)
      const attempt = run.next()!
      const rest = run.failed(attempt, RATE_LIMITED).rest!
      durations.push(rest.until - rest.since)
      now = rest.until + 1
    }
    expect(durations).toEqual([30, 60, 120, 240, 300, 300, 300].map(seconds => seconds * SECOND))
  })

  it('starts the backoff over when the reason changes', () => {
    const group = shape([A])
    let run = balancer.start(group, null)
    let rest = run.failed(run.next()!, RATE_LIMITED).rest!
    now = rest.until + 1
    run = balancer.start(group, null)
    rest = run.failed(run.next()!, http(404)).rest!
    expect(rest).toMatchObject({ reason: 'unavailable', failures: 1, until: now + 30 * MINUTE })
  })

  it('grows a quota rest from 30 minutes to a day', () => {
    const group = shape([A])
    const hours: number[] = []
    for (let round = 0; round < 8; round++) {
      const run = balancer.start(group, null)
      const rest = run.failed(run.next()!, QUOTA).rest!
      hours.push((rest.until - rest.since) / HOUR)
      now = rest.until + 1
    }
    expect(hours).toEqual([0.5, 1, 2, 4, 8, 16, 24, 24])
  })

  it('does not let concurrent failures compound the backoff', () => {
    const group = shape([A, B])
    const first = balancer.start(group, null)
    const second = balancer.start(group, null)
    const third = balancer.start(group, null)
    const attempts = [first.next()!, second.next()!, third.next()!]
    now += 10
    const rest = first.failed(attempts[0], RATE_LIMITED).rest!
    now += 10
    expect(second.failed(attempts[1], RATE_LIMITED).rest).toBe(rest)
    expect(third.failed(attempts[2], RATE_LIMITED).rest!.failures).toBe(1)
    expect(stateOf(group, A).rest).toMatchObject({ failures: 1, until: rest.until })
  })

  it('does not let a probe that fails shorten a rest that is still running', () => {
    const group = shape([A])
    const first = balancer.start(group, null)
    const rest = first.failed(first.next()!, http(429, '', { 'retry-after': '3600' })).rest!
    now += 61 * SECOND // forced probe
    const probe = balancer.start(group, null)
    const attempt = probe.next()!
    expect(attempt.probe).toBe(true)
    const again = probe.failed(attempt, RATE_LIMITED).rest!
    expect(again.until).toBe(rest.until)
  })

  it('counts consecutive failures in the member\'s health and clears them on success', () => {
    const group = shape([A])
    for (let i = 0; i < 2; i++) {
      const run = balancer.start(group, null)
      run.failed(run.next()!, SERVER_ERROR)
    }
    expect(stateOf(group, A)).toMatchObject({ failures: 2, state: 'ready', lastFailureAt: now })
    serve(group)
    expect(stateOf(group, A)).toMatchObject({ failures: 0, lastSuccessAt: now })
  })
})

describe('a request the members reject', () => {
  it('blames nobody when every member rejects it', () => {
    const group = shape([A, B])
    for (let round = 0; round < 5; round++) {
      const run = balancer.start(group, null)
      expect(failAll(run, BAD_REQUEST)).toEqual(['a', 'b'])
      run.finish()
    }
    expect(stateOf(group, A)).toMatchObject({ state: 'ready', failures: 0 })
    expect(stateOf(group, B)).toMatchObject({ state: 'ready', failures: 0 })
  })

  it('reports the failure as the request\'s', () => {
    const run = balancer.start(shape([A, B]), null)
    expect(run.failed(run.next()!, BAD_REQUEST)).toEqual({ rest: null, blame: 'request' })
  })

  it('counts a rejection against the member that made it once another member answers, and rests it at the threshold', () => {
    const group = shape([A, B])
    for (let round = 1; round <= 2; round++) {
      expect(serveAfter(group, null, BAD_REQUEST, 1)).toBe('b')
      expect(stateOf(group, A).state).toBe('ready')
    }
    expect(serveAfter(group, null, BAD_REQUEST, 1)).toBe('b')
    expect(stateOf(group, A)).toMatchObject({ state: 'resting', rest: { reason: 'unavailable', scope: 'member', until: now + 5 * MINUTE } })
  })

  it('resets the count when the member answers', () => {
    const group = shape([A, B])
    serveAfter(group, null, BAD_REQUEST, 1)
    serveAfter(group, null, BAD_REQUEST, 1)
    expect(serve(group)).toBe('a')
    serveAfter(group, null, BAD_REQUEST, 1)
    expect(stateOf(group, A).state).toBe('ready')
  })

  it('does not count a rejection when the run ends without an answer', () => {
    const group = shape([A, B])
    for (let round = 0; round < 4; round++) {
      const run = balancer.start(group, null)
      run.failed(run.next()!, BAD_REQUEST)
      run.finish()
    }
    expect(stateOf(group, A).state).toBe('ready')
  })
})

describe('probing a member that has rested', () => {
  const resting = (group: GroupShape) => {
    const run = balancer.start(group, null)
    return run.failed(run.next()!, RATE_LIMITED).rest!
  }

  it('is half-open once its rest ends, and its next attempt is a probe', () => {
    const group = shape([A, B])
    const rest = resting(group)
    now = rest.until
    expect(stateOf(group, A).state).toBe('half-open')
    const attempt = balancer.start(group, null).next()!
    expect(attempt.member.sourceId).toBe('a')
    expect(attempt.probe).toBe(true)
  })

  it('lets one request probe at a time', () => {
    const group = shape([A, B])
    now = resting(group).until
    const first = balancer.start(group, null)
    const second = balancer.start(group, null)
    expect(first.next()!.member.sourceId).toBe('a')
    expect(second.next()!.member.sourceId).toBe('b')
  })

  it('frees the member when the probe fails, succeeds or is abandoned', () => {
    const group = shape([A, B])
    now = resting(group).until
    const abandoned = balancer.start(group, null)
    abandoned.abandoned(abandoned.next()!)
    const next = balancer.start(group, null)
    const attempt = next.next()!
    expect(attempt.member.sourceId).toBe('a')
    next.succeeded(attempt)
    expect(stateOf(group, A)).toMatchObject({ state: 'ready', failures: 0 })
    expect(balancer.start(group, null).next()!.probe).toBe(false)
  })

  it('lets another request probe once a lease expires', () => {
    const group = shape([A, B])
    now = resting(group).until
    const stuck = balancer.start(group, null)
    stuck.next()
    expect(balancer.start(group, null).next()!.member.sourceId).toBe('b')
    now += DEFAULT_BALANCER_CONFIG.probeLeaseMs
    expect(balancer.start(group, null).next()!.member.sourceId).toBe('a')
  })

  it('releases everything a run still holds when it is finished', () => {
    const group = shape([A, B])
    now = resting(group).until
    const run = balancer.start(group, null)
    run.next()
    run.finish()
    expect(balancer.start(group, null).next()!.member.sourceId).toBe('a')
  })

  it('probes the whole account once, whichever of its models asks', () => {
    const a1 = ref('a', 'm1')
    const a2 = ref('a', 'm2')
    const group = shape([a1, a2, B])
    const run = balancer.start(group, null)
    const rest = run.failed(run.next()!, QUOTA).rest!
    now = rest.until
    const first = balancer.start(group, null)
    const probe = first.next()!
    expect(probe.member.key).toBe(a1.key)
    expect(balancer.start(group, null).next()!.member.key).toBe(B.key)
    first.succeeded(probe)
    expect(stateOf(group, a2).state).toBe('ready')
  })

  it('does not clear a rest because a request that began before it succeeded', () => {
    const group = shape([A, B])
    const early = balancer.start(group, null)
    const attempt = early.next()!
    now += 10
    const failing = balancer.start(group, null)
    failing.failed(failing.next()!, RATE_LIMITED)
    now += 10
    early.succeeded(attempt)
    expect(stateOf(group, A).state).toBe('resting')
  })
})

describe('when no member is ready', () => {
  it('has nothing to try, and says when the first member returns', () => {
    const group = shape([A, B])
    const run = balancer.start(group, null)
    run.failed(run.next()!, http(429, '', { 'retry-after': '600' }))
    run.failed(run.next()!, http(429, '', { 'retry-after': '300' }))
    run.finish()

    const next = balancer.start(group, null)
    expect(next.next()).toBeNull()
    const summary = next.finish()
    expect(summary.nothingToTry).toBe(true)
    expect(summary.retryAt).toBe(now + 300 * SECOND)
    expect(summary.resting.map(item => item.member.sourceId)).toEqual(['a', 'b'])
  })

  it('tries the soonest-returning member once its rest has aged, and then no more than once a minute', () => {
    const group = shape([A, B])
    const run = balancer.start(group, null)
    run.failed(run.next()!, http(402, '', { 'retry-after': '7200' }))
    run.failed(run.next()!, http(402, '', { 'retry-after': '3600' }))
    run.finish()

    now += 30 * SECOND
    expect(balancer.start(group, null).next()).toBeNull()
    now += 31 * SECOND
    const probing = balancer.start(group, null)
    const attempt = probing.next()!
    expect(attempt).toMatchObject({ probe: true })
    expect(attempt.member.sourceId).toBe('b')
    probing.failed(attempt, QUOTA)
    expect(balancer.start(group, null).next()).toBeNull()
    now += 61 * SECOND
    expect(balancer.start(group, null).next()!.probe).toBe(true)
  })

  it('lets a forced probe that succeeds bring the member back', () => {
    const group = shape([A])
    const first = balancer.start(group, null)
    first.failed(first.next()!, http(402, '', { 'retry-after': '7200' }))
    now += 61 * SECOND
    const run = balancer.start(group, null)
    run.succeeded(run.next()!)
    expect(stateOf(group, A).state).toBe('ready')
  })

  it('does not force a second probe while the first is still in flight', () => {
    const group = shape([A])
    const first = balancer.start(group, null)
    first.failed(first.next()!, http(402, '', { 'retry-after': '7200' }))
    now += 61 * SECOND
    const holding = balancer.start(group, null)
    holding.next()
    now += 61 * SECOND
    expect(balancer.start(group, null).next()).toBeNull()
  })

  it('does not force a probe in a run that has already tried something', () => {
    const group = shape([A, B])
    const setup = balancer.start(group, null)
    setup.failed(setup.next()!, RATE_LIMITED)
    now += 5 * SECOND
    const run = balancer.start(group, null)
    run.failed(run.next()!, QUOTA)
    now += 120 * SECOND
    expect(run.next()).toBeNull()
  })

  it('reports no return time when nothing rests', () => {
    const run = balancer.start(shape([A]), null)
    failAll(run, SERVER_ERROR)
    expect(run.finish()).toMatchObject({ retryAt: null, resting: [] })
  })
})

describe('summary of a run', () => {
  it('describes each attempt and what it led to', () => {
    const group = shape([A, B, C])
    const run = balancer.start(group, 's')
    const first = run.next()!
    run.failed(first, RATE_LIMITED)
    const second = run.next()!
    run.succeeded(second)
    const summary = run.finish()
    expect(summary.attempted).toEqual([
      { member: A, outcome: 'failed', rest: expect.objectContaining({ reason: 'rate' }) },
      { member: B, outcome: 'served', rest: null },
    ])
    expect(summary.nothingToTry).toBe(false)
    expect(summary.budgetSpent).toBe(false)
  })

  it('treats an attempt nobody reported as abandoned', () => {
    const run = balancer.start(shape([A, B]), null)
    run.next()
    expect(run.finish().attempted).toEqual([{ member: A, outcome: 'abandoned', rest: null }])
  })

  it('ignores a second report on the same attempt', () => {
    const run = balancer.start(shape([A, B]), null)
    const attempt = run.next()!
    run.succeeded(attempt)
    expect(run.failed(attempt, RATE_LIMITED).rest).toBeNull()
    run.abandoned(attempt)
    expect(stateOf(shape([A, B]), A).state).toBe('ready')
    expect(run.finish().attempted[0].outcome).toBe('served')
  })

  it('is the same every time it is asked', () => {
    const run = balancer.start(shape([A]), null)
    run.next()
    expect(run.finish()).toBe(run.finish())
  })
})

describe('lifecycle', () => {
  const restBoth = (group: GroupShape) => {
    const run = balancer.start(group, null)
    run.failed(run.next()!, RATE_LIMITED)
    run.failed(run.next()!, RATE_LIMITED)
    run.finish()
  }

  it('ends one member\'s rest and counts what it released', () => {
    const group = shape([A, B])
    restBoth(group)
    expect(balancer.clearRest({ memberKey: A.key })).toBe(1)
    expect(stateOf(group, A)).toMatchObject({ state: 'ready', failures: 0 })
    expect(stateOf(group, B).state).toBe('resting')
  })

  it('ends the account rest that would still keep a member out', () => {
    const group = shape([ref('a', 'm1'), ref('a', 'm2')])
    const run = balancer.start(group, null)
    run.failed(run.next()!, QUOTA)
    expect(balancer.clearRest({ memberKey: ref('a', 'm2').key })).toBe(1)
    expect(stateOf(group, ref('a', 'm1')).state).toBe('ready')
  })

  it('ends every rest of an account, its models included', () => {
    const a1 = ref('a', 'm1')
    const a2 = ref('a', 'm2')
    const group = shape([a1, a2, B])
    const one = balancer.start(group, null)
    one.failed(one.next()!, RATE_LIMITED)
    const two = balancer.start(group, null)
    two.failed(two.next()!, RATE_LIMITED)
    expect(stateOf(group, a1).state).toBe('resting')
    expect(stateOf(group, a2).state).toBe('resting')
    expect(balancer.clearRest({ sourceId: 'a' })).toBe(2)
    expect(balancer.health(group).every(item => item.state === 'ready')).toBe(true)
  })

  it('ends every rest when given no filter, and releases nothing when nothing rests', () => {
    const group = shape([A, B])
    restBoth(group)
    expect(balancer.clearRest()).toBe(2)
    expect(balancer.clearRest()).toBe(0)
    expect(balancer.clearRest({ memberKey: 'missing' })).toBe(0)
  })

  it('forgets an account that was edited, with its sessions', () => {
    const group = shape([A, B])
    serveAfter(group, 's1', SERVER_ERROR, 1)
    const run = balancer.start(group, 'x')
    run.failed(run.next()!, RATE_LIMITED)
    run.failed(run.next()!, QUOTA)
    balancer.resetSource('b')
    expect(balancer.currentMember('g', 's1')).toBeNull()
    expect(stateOf(group, B)).toMatchObject({ state: 'ready', failures: 0 })
    expect(stateOf(group, A).state).toBe('resting')
  })

  it('forgets a group\'s sessions', () => {
    const group = shape([A, B])
    serveAfter(group, 's1', SERVER_ERROR, 1)
    serveAfter(shape([A, B], 'priority', 'other'), 's1', SERVER_ERROR, 1)
    balancer.forgetGroup('g')
    expect(balancer.currentMember('g', 's1')).toBeNull()
    expect(balancer.currentMember('other', 's1')?.sourceId).toBe('b')
  })

  it('names the member a session is stuck to', () => {
    serveAfter(shape([A, B]), 's1', SERVER_ERROR, 1)
    expect(balancer.currentMember('g', 's1')).toEqual(B)
  })

  it('carries health and rests through a snapshot, but not sessions', () => {
    const group = shape([A, B])
    serveAfter(group, 's1', SERVER_ERROR, 1)
    const run = balancer.start(group, null)
    const rest = run.failed(run.next()!, RATE_LIMITED).rest!
    const accountRun = balancer.start(shape([C]), null)
    accountRun.failed(accountRun.next()!, QUOTA)

    const copy = create()
    copy.restore(JSON.parse(JSON.stringify(balancer.snapshot())))
    expect(copy.health(group).find(item => item.member.key === A.key)).toMatchObject({ state: 'resting', rest })
    expect(copy.health(shape([C]))[0].state).toBe('resting')
    expect(copy.currentMember('g', 's1')).toBeNull()
  })

  it('drops a rest recorded under a clock that has since moved back', () => {
    const run = balancer.start(shape([A]), null)
    run.failed(run.next()!, http(429, '', { 'retry-after': '3600' }))
    const snapshot = balancer.snapshot()
    now -= 3 * 24 * HOUR
    const copy = create()
    copy.restore(snapshot)
    expect(copy.health(shape([A]))[0].state).toBe('ready')
  })

  it('ignores a snapshot it does not know', () => {
    balancer.restore({ version: 2 } as never)
    expect(balancer.snapshot().members).toEqual([])
  })
})

describe('outcomes after recovery controls', () => {
  const controls = [
    { name: 'resetSource', reason: 'source-reset', clear: () => balancer.resetSource(A.sourceId) },
    { name: 'clearRest(member)', reason: 'rest-cleared', clear: () => balancer.clearRest({ memberKey: A.key }) },
    { name: 'clearRest(source)', reason: 'rest-cleared', clear: () => balancer.clearRest({ sourceId: A.sourceId }) },
    { name: 'clearRest(all)', reason: 'rest-cleared', clear: () => balancer.clearRest() },
  ]

  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  describe.each(controls)('$name', ({ clear, reason }) => {
    it.each([401, 402])('ignores a late %i after clearing even without existing health', status => {
      const group = shape([A, B])
      const early = balancer.start(group, 's')
      const attempt = early.next()!
      clear()
      clear()
      expect(early.failed(attempt, http(status))).toEqual({ rest: null, blame: 'member' })
      expect(stateOf(group, A)).toMatchObject({ state: 'ready', failures: 0, lastFailureAt: null })
      expect(balancer.snapshot()).toEqual({ version: 1, members: [], accounts: [] })
      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`outcome=failure reason=${reason}`))
      early.failed(attempt, http(status))
      early.succeeded(attempt)
      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(early.finish().attempted[0]).toMatchObject({ outcome: 'failed', rest: null })
      expect(serve(group, 'new')).toBe('a')
    })

    it.each([401, 402])('keeps newer success intact when an earlier %i arrives', status => {
      const group = shape([A, B])
      const early = balancer.start(group, 's')
      const attempt = early.next()!
      const resting = balancer.start(group, null)
      resting.failed(resting.next()!, RATE_LIMITED)
      resting.finish()
      clear()
      expect(serve(group, 's')).toBe('a')
      const health = balancer.health(group)
      early.failed(attempt, http(status))
      early.finish()
      expect(balancer.health(group)).toEqual(health)
      expect(balancer.currentMember(group.id, 's')).toEqual(A)
      expect(console.warn).toHaveBeenCalledTimes(1)
    })

    it('keeps a newer rest and sticky choice when an earlier success arrives at the same clock time', () => {
      const group = shape([A, B])
      const early = balancer.start(group, 's')
      const attempt = early.next()!
      clear()
      const newer = balancer.start(group, 's')
      const rest = newer.failed(newer.next()!, QUOTA).rest
      newer.succeeded(newer.next()!)
      newer.finish()
      const health = balancer.health(group)
      early.succeeded(attempt)
      early.succeeded(attempt)
      expect(early.finish().attempted[0]).toMatchObject({ outcome: 'served', rest: null })
      expect(balancer.health(group)).toEqual(health)
      expect(stateOf(group, A).rest).toBe(rest)
      expect(balancer.currentMember(group.id, 's')).toEqual(B)
      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`outcome=success reason=${reason}`))
    })

    it('does not restore a sticky entry from an invalidated success', () => {
      const group = shape([A, B])
      const early = balancer.start(group, 's')
      const attempt = early.next()!
      clear()
      early.succeeded(attempt)
      early.finish()
      expect(balancer.currentMember(group.id, 's')).toBeNull()
      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(serve(group, 's')).toBe('a')
      expect(balancer.currentMember(group.id, 's')).toEqual(A)
    })

    it('does not turn an earlier provisional rejection into new shape evidence', () => {
      balancer = create({ shapeFailuresBeforeRest: 2 })
      const group = shape([A, B])
      const earlier = balancer.start(group, 's')
      earlier.failed(earlier.next()!, BAD_REQUEST)
      clear()
      expect(serveAfter(group, null, BAD_REQUEST, 1)).toBe('b')
      earlier.succeeded(earlier.next()!)
      earlier.finish()
      expect(stateOf(group, A).state).toBe('ready')
      expect(balancer.currentMember(group.id, 's')).toEqual(B)
      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`outcome=shape-failure reason=${reason}`))
      expect(serveAfter(group, null, BAD_REQUEST, 1)).toBe('b')
      expect(stateOf(group, A)).toMatchObject({ state: 'resting', rest: { reason: 'unavailable' } })
    })

    it('drops a rejection reported only after clearing instead of retaining provisional evidence', () => {
      balancer = create({ shapeFailuresBeforeRest: 1 })
      const group = shape([A, B])
      const early = balancer.start(group, null)
      const attempt = early.next()!
      clear()
      early.failed(attempt, BAD_REQUEST)
      early.succeeded(early.next()!)
      early.finish()
      expect(stateOf(group, A).state).toBe('ready')
      expect(console.warn).toHaveBeenCalledTimes(1)
    })

    it('uses fresh evidence for an attempt handed out after clearing within an existing run', () => {
      const run = balancer.start(shape([B, A]), 's')
      const first = run.next()!
      run.abandoned(first)
      clear()
      const fresh = run.next()!
      expect(fresh.member).toEqual(A)
      expect(run.failed(fresh, http(401)).rest).toMatchObject({ reason: 'auth', scope: 'account' })
      run.finish()
      expect(console.warn).not.toHaveBeenCalled()
    })

    it('does not release a newer probe when an invalidated probe finishes', () => {
      const group = shape([A])
      const initial = balancer.start(group, null)
      now = initial.failed(initial.next()!, QUOTA).rest!.until
      initial.finish()
      const early = balancer.start(group, null)
      const oldProbe = early.next()!
      expect(oldProbe.probe).toBe(true)
      clear()
      const failing = balancer.start(group, null)
      now = failing.failed(failing.next()!, QUOTA).rest!.until
      failing.finish()
      const newer = balancer.start(group, null)
      const newProbe = newer.next()!
      early.succeeded(oldProbe)
      early.finish()
      const waiting = balancer.start(group, null)
      expect(waiting.next()).toBeNull()
      waiting.finish()
      newer.succeeded(newProbe)
      newer.finish()
      expect(stateOf(group, A).state).toBe('ready')
      expect(console.warn).toHaveBeenCalledTimes(1)
    })
  })

  it.each(controls.slice(0, 3))('leaves other accounts and their provisional rejections valid after $name', ({ clear }) => {
    balancer = create({ shapeFailuresBeforeRest: 1 })
    const unaffected = balancer.start(shape([B]), 'unaffected')
    const attempt = unaffected.next()!
    const rejected = balancer.start(shape([C, D]), null)
    rejected.failed(rejected.next()!, BAD_REQUEST)
    clear()
    unaffected.failed(attempt, QUOTA)
    unaffected.finish()
    rejected.succeeded(rejected.next()!)
    rejected.finish()
    expect(stateOf(shape([B, C, D]), B).rest).toMatchObject({ reason: 'quota', scope: 'account' })
    expect(stateOf(shape([B, C, D]), C).rest).toMatchObject({ reason: 'unavailable', scope: 'member' })
    expect(console.warn).not.toHaveBeenCalled()
  })

  it.each(controls.slice(0, 3))('keeps other accounts\' in-flight successes valid after $name', ({ clear }) => {
    const unaffected = balancer.start(shape([B]), 'unaffected')
    const attempt = unaffected.next()!
    clear()
    unaffected.succeeded(attempt)
    unaffected.finish()
    expect(balancer.currentMember('g', 'unaffected')).toEqual(B)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it.each([401, 402])('invalidates sibling %i attempts when retrying one member clears their account rest', status => {
    const sibling = ref(A.sourceId, 'other-model')
    const early = balancer.start(shape([sibling]), 's')
    const attempt = early.next()!
    const resting = balancer.start(shape([A]), null)
    resting.failed(resting.next()!, QUOTA)
    resting.finish()
    expect(balancer.clearRest({ memberKey: A.key })).toBe(1)
    early.failed(attempt, http(status))
    early.finish()
    expect(balancer.health(shape([A, sibling])).every(item => item.state === 'ready')).toBe(true)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(serve(shape([sibling]), 's')).toBe('a')
  })

  it('does not let an in-flight success restore the sticky entry removed by an account edit', () => {
    const group = shape([A, B])
    serve(group, 's')
    const early = balancer.start(group, 's')
    const attempt = early.next()!
    expect(attempt.sticky).toBe(true)
    balancer.resetSource(A.sourceId)
    expect(balancer.currentMember(group.id, 's')).toBeNull()
    early.succeeded(attempt)
    early.finish()
    expect(balancer.currentMember(group.id, 's')).toBeNull()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('keeps invalidation effective across health eviction and unrelated account edits', () => {
    balancer = create({ healthMaxEntries: 1 })
    const early = balancer.start(shape([A]), null)
    const attempt = early.next()!
    balancer.resetSource(A.sourceId)
    for (let i = 0; i < 10; i++) {
      const member = ref(`other-${i}`)
      const run = balancer.start(shape([member]), null)
      run.failed(run.next()!, QUOTA)
      run.finish()
      balancer.resetSource(member.sourceId)
    }
    expect(serve(shape([A]), 'new')).toBe('a')
    early.failed(attempt, QUOTA)
    early.finish()
    expect(stateOf(shape([A]), A)).toMatchObject({ state: 'ready', failures: 0 })
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('does not log the body, headers or session key when dropping stale evidence', () => {
    const run = balancer.start(shape([A]), 'private-session')
    const attempt = run.next()!
    balancer.resetSource(A.sourceId)
    run.failed(attempt, http(401, 'private-body', { authorization: 'private-header' }))
    run.finish()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[Router] group_outcome_stale group=g attempt=1 source=a model=m outcome=failure reason=source-reset: ignored obsolete balancing evidence'
    )
  })

  it('invalidates every account when all rests are cleared', () => {
    const first = balancer.start(shape([A]), 'one')
    const second = balancer.start(shape([B]), 'two')
    const a = first.next()!
    const b = second.next()!
    balancer.clearRest()
    first.failed(a, http(401))
    second.succeeded(b)
    first.finish()
    second.finish()
    expect(balancer.health(shape([A, B])).every(item => item.state === 'ready')).toBe(true)
    expect(balancer.currentMember('g', 'two')).toBeNull()
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it.each(['success', 'failure', 'abandon', 'finish', 'provisional-success', 'provisional-finish'] as const)(
    'releases invalidation tracking on %s', outcome => {
      const group = shape([A, B])
      const run = balancer.start(group, null)
      const attempt = run.next()!
      if (outcome === 'success') run.succeeded(attempt)
      else if (outcome === 'failure') run.failed(attempt, SERVER_ERROR)
      else if (outcome === 'abandon') run.abandoned(attempt)
      else if (outcome.startsWith('provisional')) {
        run.failed(attempt, BAD_REQUEST)
        if (outcome === 'provisional-success') run.succeeded(run.next()!)
        else run.finish()
      } else run.finish()

      // Settled records remain in the summary but must no longer be held by invalidation.
      const records = (run as unknown as { records: Map<unknown, { invalidated: string | null }> }).records
      balancer.resetSource(A.sourceId)
      balancer.clearRest()
      expect([...records.values()].every(record => record.invalidated === null)).toBe(true)
      run.finish()
      expect(console.warn).not.toHaveBeenCalled()
    }
  )
})

describe('memory', () => {
  it('keeps the members that rest when it must forget some', () => {
    const local = create({ healthMaxEntries: 3 })
    const resting = ref('rests')
    const run = local.start(shape([resting]), null)
    run.failed(run.next()!, RATE_LIMITED)
    for (let i = 0; i < 6; i++) {
      now += 1
      const member = ref(`flaky-${i}`)
      const flaky = local.start(shape([member]), null)
      flaky.failed(flaky.next()!, SERVER_ERROR)
    }
    const snapshot = local.snapshot()
    expect(snapshot.members.length).toBeLessThanOrEqual(3)
    expect(snapshot.members.some(entry => entry.key === resting.key && entry.rest)).toBe(true)
  })

  it('forgets a half-open member nobody has tried for a day', () => {
    const group = shape([A, B])
    const run = balancer.start(group, null)
    const rest = run.failed(run.next()!, RATE_LIMITED).rest!
    now = rest.until + DEFAULT_BALANCER_CONFIG.idleForgetMs + 1
    expect(stateOf(group, A)).toMatchObject({ state: 'ready', rest: null })
  })

  it('bounds the sessions it remembers', () => {
    const local = create({ stickyMaxSessions: 3 })
    const group = shape([A, B])
    for (let i = 0; i < 5; i++) {
      const run = local.start(group, `s${i}`)
      run.succeeded(run.next()!)
    }
    expect(local.currentMember('g', 's0')).toBeNull()
    expect(local.currentMember('g', 's1')).toBeNull()
    expect(local.currentMember('g', 's4')?.sourceId).toBe('a')
  })
})
