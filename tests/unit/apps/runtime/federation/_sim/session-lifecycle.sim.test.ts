/**
 * What a joiner learns about sessions it does not show, over an office of real
 * managers (traffic-cluster.ts): a turn's lifecycle still reaches it (so a
 * "running" indicator can never go stale), and a restart that the authority never
 * saw as an absence still leaves it able to find every transcript.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildTrafficCluster, type SimNode, type TrafficCluster } from './traffic-cluster'
import type { FederationMessage, StreamFramesFrame } from '../../../../../../src/main/apps/runtime/federation/types'
import { REPLICA_RELEASE_GRACE_MS } from '../../../../../../src/main/apps/runtime/federation/session-feed'

type Digest = Extract<FederationMessage, { kind: 'feed-digest' }>

function streamsTo(c: TrafficCluster, node: string, sessionKey: string): StreamFramesFrame[] {
  return (c.captured.get(node) ?? []).filter(
    (f): f is StreamFramesFrame => f.kind === 'stream-frames' && f.sessionKey === sessionKey
  )
}

describe('session lifecycle for joiners that do not show the session', () => {
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

  it('a turn’s start and completion reach a joiner that stopped showing the session; its detail does not', () => {
    cluster = buildTrafficCluster(3)
    const c = cluster
    const viewer = c.joiners[0]
    const session = c.sessionKey('app-j2')
    c.watch(viewer, [session])
    c.advance(1_000)
    // The panel closes mid-turn and stays closed past the stream grace period.
    c.watch(viewer, [])
    c.advance(120_000)
    c.capture.add(viewer.id)
    c.speak('app-j2', 'the reply', { deltas: 5, turn: true })
    c.advance(1_000)
    const channels = streamsTo(c, viewer.id, session).flatMap((s) => s.frames.map((f) => f.channel))
    expect(channels).toEqual(['agent:turn-start', 'agent:complete'])
  })

  it('a joiner that never showed the session also learns when its turns start and end', () => {
    cluster = buildTrafficCluster(3)
    const c = cluster
    const bystander = c.joiners[0]
    const session = c.sessionKey('app-host')
    c.advance(1_000)
    c.capture.add(bystander.id)
    c.speak('app-host', 'hello', { deltas: 3, turn: true })
    c.advance(1_000)
    const channels = streamsTo(c, bystander.id, session).flatMap((s) => s.frames.map((f) => f.channel))
    expect(channels).toEqual(['agent:turn-start', 'agent:complete'])
  })
})

describe('feed discovery across a quick restart', () => {
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

  it('a re-join the authority never saw as an absence gets the full feed list at once', () => {
    cluster = buildTrafficCluster(2)
    const c = cluster
    const [speaker, restarted] = c.joiners
    c.speak(speaker.appId, 'said once, then quiet')
    c.advance(20_000)
    // Restart inside the offline-confirmation window: the authority sees only a new join-request.
    c.capture.add(restarted.id)
    restarted.manager.reenrollWithAuthority('office-traffic')
    c.advance(100)
    const announced = (c.captured.get(restarted.id) ?? [])
      .filter((f): f is Digest => f.kind === 'feed-digest')
      .flatMap((d) => d.feeds.map(([key]) => key))
    expect(announced.some((key) => key.includes(c.sessionKey(speaker.appId)))).toBe(true)
  })
})

describe('transcript copies follow the sessions shown now', () => {
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

  function entriesTo(c: TrafficCluster, node: string, appId: string): number {
    return (c.captured.get(node) ?? []).filter(
      (f) => f.kind === 'feed-entries' && (f as { feedKey: string }).feedKey.includes(c.sessionKey(appId))
    ).length
  }

  it('a session no longer shown stops arriving after the grace period; the one shown now keeps arriving', () => {
    cluster = buildTrafficCluster(3)
    const c = cluster
    const viewer = c.joiners[0]
    c.capture.add(viewer.id)
    c.watch(viewer, [c.sessionKey('app-j2')])
    c.speak('app-j2', 'first')
    c.advance(10_000)
    expect(entriesTo(c, viewer.id, 'app-j2'), 'precondition — the shown session is copied').toBeGreaterThan(0)

    // The viewer moves to another session.
    c.watch(viewer, [c.sessionKey('app-j3')])
    c.advance(REPLICA_RELEASE_GRACE_MS + 10_000)
    c.captured.set(viewer.id, [])
    for (let r = 0; r < 3; r++) {
      c.speak('app-j2', `j2 round ${r}`)
      c.speak('app-j3', `j3 round ${r}`)
      c.advance(10_000)
    }
    expect(entriesTo(c, viewer.id, 'app-j2'), 'released session').toBe(0)
    expect(entriesTo(c, viewer.id, 'app-j3'), 'session shown now').toBeGreaterThan(0)
  })

  it('a panel closed and reopened within the grace period keeps its subscription', () => {
    cluster = buildTrafficCluster(2)
    const c = cluster
    const viewer = c.joiners[0]
    c.watch(viewer, [c.sessionKey('app-j2')])
    c.speak('app-j2', 'first')
    c.advance(10_000)
    c.capture.add(viewer.id)
    c.capture.add(c.host.id)
    c.watch(viewer, [])
    c.advance(REPLICA_RELEASE_GRACE_MS / 2)
    c.watch(viewer, [c.sessionKey('app-j2')])
    c.advance(REPLICA_RELEASE_GRACE_MS)
    c.speak('app-j2', 'second')
    c.advance(10_000)
    expect(entriesTo(c, viewer.id, 'app-j2')).toBeGreaterThan(0)
    const unsubscribes = (c.captured.get(c.host.id) ?? []).filter((f) => f.kind === 'feed-unsubscribe')
    expect(unsubscribes).toEqual([])
  })
})

describe('an elected authority applies the same stream rule as the first host', () => {
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

  it('after the host dies: the viewer gets the whole batch, a non-viewer only status events, the producer nothing back', () => {
    cluster = buildTrafficCluster(4)
    const c = cluster
    c.advance(5_000)
    c.kill(c.host)
    const winner = c.electAfterHostLoss()
    const [producer, viewer, bystander] = c.joiners.filter((j) => j !== winner)
    // The viewer declares its panel to the new authority (subscriptions are soft state).
    c.watch(viewer, [c.sessionKey(producer.appId)])
    for (const n of [producer, viewer, bystander]) c.capture.add(n.id)
    c.speak(producer.appId, 'after the election', { deltas: 3, turn: true })
    c.advance(1_000)

    const session = c.sessionKey(producer.appId)
    const channels = (node: string) => streamsTo(c, node, session).flatMap((s) => s.frames.map((f) => f.channel))
    expect(channels(viewer.id)).toEqual([
      'agent:turn-start', 'agent:thought-delta', 'agent:thought-delta', 'agent:thought-delta', 'agent:message', 'agent:complete',
    ])
    expect(channels(bystander.id)).toEqual(['agent:turn-start', 'agent:complete'])
    expect(channels(producer.id)).toEqual([])
  })
})

describe('a live batch never returns to its producer, and only an owner streams a member', () => {
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

  /**
   * `producer` streams a turn of `appId`'s session (its own member, or a forgery):
   * over its own link, or — `dialedInto` — on a session it dialed into that node.
   */
  function streamAs(c: TrafficCluster, producer: SimNode, appId: string, dialedInto?: SimNode): void {
    const batch = {
      kind: 'stream-frames' as const, officeId: 'office-traffic', sessionKey: c.sessionKey(appId), baseSeq: 900, originRun: 'forge-or-own',
      frames: [
        { seq: 900, kind: 'milestone' as const, channel: 'agent:turn-start', spaceId: 's', payload: {} },
        { seq: 901, kind: 'milestone' as const, channel: 'agent:complete', spaceId: 's', payload: {} },
      ],
    }
    if (dialedInto) dialedInto.manager.handleHostInbound({ clientId: producer.id, officeId: 'office-traffic', frame: batch })
    else producer.manager.relaySink('office-traffic', batch)
  }

  const paths = [
    { name: 'first host, LAN', elected: false, dialedIn: false },
    { name: 'elected authority, over its election legs', elected: true, dialedIn: false },
    { name: 'elected authority, on a session a survivor dialed in', elected: true, dialedIn: true },
  ]
  for (const path of paths) {
    it(`${path.name}: the producer gets nothing back; a forged batch reaches no one`, () => {
      cluster = buildTrafficCluster(4)
      const c = cluster
      c.advance(5_000)
      let survivors = c.joiners
      let winner: SimNode | undefined
      if (path.elected) {
        c.kill(c.host)
        winner = c.electAfterHostLoss()
        survivors = c.joiners.filter((j) => j !== winner)
      }
      const via = path.dialedIn ? winner : undefined
      const [producer, viewer, bystander] = survivors
      c.watch(viewer, [c.sessionKey(producer.appId), c.sessionKey(bystander.appId)])
      for (const n of [producer, viewer, bystander]) c.capture.add(n.id)

      streamAs(c, producer, producer.appId, via)
      c.advance(1_000)
      const own = c.sessionKey(producer.appId)
      expect(streamsTo(c, producer.id, own), 'no echo to the producer').toEqual([])
      expect(streamsTo(c, viewer.id, own).length, 'precondition — the viewer gets it').toBeGreaterThan(0)
      expect(streamsTo(c, bystander.id, own).length, 'precondition — a non-viewer gets its status').toBeGreaterThan(0)

      // The producer streams a member it does not own.
      streamAs(c, producer, bystander.appId, via)
      c.advance(1_000)
      const forged = c.sessionKey(bystander.appId)
      for (const n of [viewer, bystander]) expect(streamsTo(c, n.id, forged), `forged batch reached ${n.id}`).toEqual([])
    })
  }
})
