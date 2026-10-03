/**
 * Federation traffic bounds, asserted on an office of REAL managers in-process
 * (see traffic-cluster.ts). The bound under test (a joiner receives what it owns,
 * what it shows, and a digest of the rest — never more as the office grows) and
 * the per-kind budgets are the ones the real-process `test:team -- scale` suite
 * checks at release time; here they run in seconds on every change.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildTrafficCluster,
  kindGrowth,
  planeGrowth,
  type Received,
  type TrafficCluster,
} from './traffic-cluster'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'

const KB = 1024
/** A churn round (a replicated board row + a run-state change): ≈ 0.9 KB measured at host+30; budget with headroom. */
const CONTROL_KB_PER_ROUND = 1.5
/** A digest entry (session feed key + seq) is ≈ 200 B; each feed growth is announced at most once per peer. */
const DIGEST_KB_PER_MESSAGE = 0.25
/** Time-driven presence traffic, not part of a round's cost. */
const PRESENCE_KINDS = new Set(['heartbeat', 'presence-update'])

function sumBytes(growth: Record<string, { bytes: number }>, pick: (kind: string) => boolean): number {
  return Object.entries(growth).reduce((n, [kind, t]) => (pick(kind) ? n + t.bytes : n), 0)
}

function describeGrowth(growth: Record<string, { frames: number; bytes: number }>): string {
  return Object.entries(growth)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([k, t]) => `${k}:${t.frames}/${(t.bytes / KB).toFixed(1)}KB`)
    .join(' ')
}

describe('federation traffic bounds (in-process office of real managers)', () => {
  let cluster: TrafficCluster | null = null
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    cluster?.dispose()
    cluster = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('run-state churn without a membership change: no full roster, per-round control cost bounded', () => {
    cluster = buildTrafficCluster(30)
    const c = cluster
    c.advance(5_000)
    const before = c.snapshot()
    const ROUNDS = 10
    for (let r = 0; r < ROUNDS; r++) {
      c.runtimeStatus.set('app-host', r % 2 === 0 ? 'working' : 'idle')
      c.recordMessage('app-host', 'app-j1')
      // Rounds span more than a minute, so a periodic full-roster resend would show.
      c.advance(10_000)
    }
    c.advance(30_000)
    const after = c.snapshot()
    for (const j of c.joiners) {
      const growth = kindGrowth(before.get(j.id)!, after.get(j.id)!)
      const context = `${j.id}: ${describeGrowth(growth)}`
      expect(growth['blackboard-replicate']?.frames, `precondition — every board row reached ${context}`).toBe(ROUNDS)
      expect(growth['member-status']?.frames ?? 0, `precondition — run state reached ${context}`).toBeGreaterThan(0)
      expect(growth['roster']?.frames ?? 0, `no full roster without a membership change — ${context}`).toBe(0)
      const perRound = sumBytes(growth, (k) => !k.includes('.') && !PRESENCE_KINDS.has(k))
      expect(perRound, `control per round ≤ ${CONTROL_KB_PER_ROUND} KB — ${context}`).toBeLessThanOrEqual(ROUNDS * CONTROL_KB_PER_ROUND * KB)
    }
  })

  it('a joiner that shows nothing copies no one’s transcript and gets no stream; a viewer gets exactly its session', () => {
    cluster = buildTrafficCluster(30)
    const c = cluster
    const viewer = c.joiners[0]
    const shown = 'app-j2'
    c.watch(viewer, [c.sessionKey(shown)])
    c.advance(5_000)
    const before = c.snapshot()
    const ROUNDS = 3
    let messages = 0
    for (let r = 0; r < ROUNDS; r++) {
      // The host's member talks to everyone and the board records it: the shape
      // that once put the busiest transcript on every node.
      c.speak('app-host', `host round ${r}`)
      messages += 1
      for (const j of c.joiners) {
        c.recordMessage('app-host', j.appId)
        c.speak(j.appId, `${j.appId} round ${r}`)
        messages += 1
      }
      c.advance(5_000)
    }
    c.advance(60_000)
    const after = c.snapshot()

    const hostGrowth = kindGrowth(before.get(c.host.id)!, after.get(c.host.id)!)
    expect(hostGrowth['feed.feed-entries']?.frames ?? 0, 'precondition — the authority mirrors every transcript').toBeGreaterThanOrEqual(c.joiners.length)

    for (const j of c.joiners) {
      const growth = kindGrowth(before.get(j.id)!, after.get(j.id)!)
      const context = `${j.id}: ${describeGrowth(growth)}`
      const digestBytes = growth['feed.feed-digest']?.bytes ?? 0
      expect(digestBytes, `digest ≤ ${DIGEST_KB_PER_MESSAGE} KB/message — ${context}`).toBeLessThanOrEqual(messages * DIGEST_KB_PER_MESSAGE * KB)
      if (j === viewer) {
        expect(growth['stream.stream-frames']?.frames ?? 0, `the viewer gets the shown session's stream — ${context}`).toBeGreaterThan(0)
        expect(growth['feed.feed-entries']?.frames ?? 0, `the viewer copies the shown transcript — ${context}`).toBeGreaterThan(0)
        continue
      }
      expect(growth['stream.stream-frames']?.frames ?? 0, `no stream to a non-viewer — ${context}`).toBe(0)
      expect(growth['feed.feed-entries']?.frames ?? 0, `no foreign transcript copied — ${context}`).toBe(0)
    }
  })

  it('a backed-up viewer receives stream batches reduced to their milestones', () => {
    cluster = buildTrafficCluster(3)
    const c = cluster
    const viewer = c.joiners[0]
    c.watch(viewer, [c.sessionKey('app-j2')])
    c.advance(1_000)
    c.slow.add(viewer.id)
    c.capture.add(viewer.id)
    c.speak('app-j2', 'the reply', { deltas: 10 })
    c.advance(1_000)
    const streams = (c.captured.get(viewer.id) ?? []).filter(
      (f): f is Extract<FederationMessage, { kind: 'stream-frames' }> => f.kind === 'stream-frames'
    )
    const channels = streams.flatMap((s) => s.frames.map((f) => f.channel))
    expect(channels).toContain('agent:message')
    expect(channels.filter((ch) => ch.endsWith('-delta'))).toEqual([])
  })

  it('per-joiner traffic for the same work does not grow with the office', () => {
    const measure = (joinerCount: number): number => {
      const c = buildTrafficCluster(joinerCount)
      try {
        c.advance(5_000)
        const before = c.snapshot()
        for (let r = 0; r < 5; r++) {
          c.runtimeStatus.set('app-host', r % 2 === 0 ? 'working' : 'idle')
          for (const speaker of ['app-host', 'app-j1', 'app-j2']) c.speak(speaker, `round ${r}`)
          c.recordMessage('app-host', 'app-j1')
          c.advance(10_000)
        }
        c.advance(30_000)
        const after = c.snapshot()
        // The same roles in both offices: a joiner that neither speaks nor shows anything.
        const quiet = c.joiners.slice(3)
        const total = (id: string) => {
          const b = before.get(id) as Received
          const a = after.get(id) as Received
          return ['control', 'stream', 'feed', 'artifact'].reduce((n, p) => n + planeGrowth(b, a, p).bytes, 0)
        }
        return quiet.reduce((n, j) => n + total(j.id), 0) / quiet.length
      } finally {
        c.dispose()
      }
    }
    const small = measure(10)
    const large = measure(100)
    expect(small).toBeGreaterThan(0)
    expect(large, `per-joiner bytes: ${Math.round(small)} B at 11 nodes vs ${Math.round(large)} B at 101 nodes`).toBeLessThanOrEqual(small * 1.1)
  })
})
