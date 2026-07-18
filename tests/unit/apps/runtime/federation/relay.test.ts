/**
 * Unit tests for apps/runtime/federation -- cross-node activity stream relay (D4).
 *
 * RelayCapture and StreamReplay both ride the REAL services/agent event hub
 * (onAgentEvent / emitAgentEvent) — capture subscribes to it, replay re-fires
 * into it — so the tests exercise the genuine seam, not a stub. Ownership and
 * office resolution are injected fakes so a test controls who owns what without
 * a real TeamStore.
 *
 * Proven:
 *   - capture is owner-only + team-only (private chat + other-node sessions are
 *     never captured: the privacy boundary AND the INV-NO-LOOP guard);
 *   - monotonic per-sessionKey streamSeq + correct milestone/incremental kind;
 *   - batching: N events in the window → one batch; >64 flushes early;
 *   - replay re-fires once per new seq with the right channel/conversationId/
 *     payload; re-applying a batch is idempotent (dedup);
 *   - INV-NO-LOOP: a replayed (non-owned) session's re-fired events are not
 *     re-captured;
 *   - two-node relay: owner B captures → relaySink → host A applies → A emits the
 *     agent events locally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  onAgentEvent,
  emitAgentEvent,
  type AgentEvent,
} from '../../../../../src/main/services/agent/events'
import {
  createRelayCapture,
  createStreamReplay,
} from '../../../../../src/main/apps/runtime/federation/relay'
import type {
  StreamFramesFrame,
} from '../../../../../src/main/apps/runtime/federation/types'
import { buildTeamSessionKey, getAppChatConversationId } from '../../../../../src/shared/apps/im-keys'

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { createFederation } from '../../../../../src/main/apps/runtime/federation/index'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
} from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-1'
const TEAM = 'office-1'
const EPOCH = 'epoch-1'
const SELF_APP = 'app-self'
const OTHER_APP = 'app-other'

const SELF_SESSION = buildTeamSessionKey(SELF_APP, TEAM, EPOCH)
const OTHER_SESSION = buildTeamSessionKey(OTHER_APP, TEAM, EPOCH)
const PRIVATE_SESSION = getAppChatConversationId(SELF_APP) // "app-chat:{appId}" — not a team key

/** Collect every agent event fired on the real hub during a test. */
function tapEvents(): { events: AgentEvent[]; dispose: () => void } {
  const events: AgentEvent[] = []
  const sub = onAgentEvent((e) => events.push(e))
  return { events, dispose: () => sub.dispose() }
}

describe('RelayCapture (owner-only + team-only)', () => {
  it('captures a SELF-owned team session with monotonic seq + correct kind', () => {
    const sinkCalls: Array<{ officeId: string; batch: StreamFramesFrame }> = []
    const capture = createRelayCapture({
      isOwnTeamSession: (id) => id === SELF_SESSION,
      resolveOffice: () => OFFICE,
      sink: (officeId, batch) => sinkCalls.push({ officeId, batch }),
    })
    const sub = capture.start()

    emitAgentEvent('agent:tool-call', 'space-1', SELF_SESSION, { id: 't1' })
    emitAgentEvent('agent:thought-delta', 'space-1', SELF_SESSION, { d: 'thinking' })
    emitAgentEvent('agent:message', 'space-1', SELF_SESSION, { text: 'hi' })

    capture.flushAll()
    sub.dispose()

    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0].officeId).toBe(OFFICE)
    const { batch } = sinkCalls[0]
    expect(batch.sessionKey).toBe(SELF_SESSION)
    expect(batch.baseSeq).toBe(1)
    expect(batch.frames.map((f) => f.seq)).toEqual([1, 2, 3]) // monotonic
    expect(batch.frames.map((f) => f.kind)).toEqual([
      'milestone', // tool-call
      'incremental', // thought-delta
      'milestone', // message
    ])
    expect(batch.frames[0]).toMatchObject({ channel: 'agent:tool-call', spaceId: 'space-1', payload: { id: 't1' } })
  })

  it('does NOT capture a team session owned by another node', () => {
    const sink = vi.fn()
    const capture = createRelayCapture({
      isOwnTeamSession: (id) => id === SELF_SESSION, // OTHER_SESSION not owned
      resolveOffice: () => OFFICE,
      sink,
    })
    const sub = capture.start()
    emitAgentEvent('agent:message', 'space-1', OTHER_SESSION, { text: 'remote' })
    capture.flushAll()
    sub.dispose()
    expect(sink).not.toHaveBeenCalled()
  })

  it('does NOT capture a private (non-team) conversation', () => {
    const sink = vi.fn()
    const capture = createRelayCapture({
      // The real ownership predicate: team-session-only. A private chat key is
      // never a team key, so isOwnTeamSession is false → privacy preserved.
      isOwnTeamSession: (id) => id === SELF_SESSION,
      resolveOffice: () => OFFICE,
      sink,
    })
    const sub = capture.start()
    emitAgentEvent('agent:message', 'space-1', PRIVATE_SESSION, { text: 'secret' })
    capture.flushAll()
    sub.dispose()
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('RelayCapture batching', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces N events in the window into one batch on timer flush', () => {
    const sinkCalls: StreamFramesFrame[] = []
    const capture = createRelayCapture({
      isOwnTeamSession: (id) => id === SELF_SESSION,
      resolveOffice: () => OFFICE,
      sink: (_office, batch) => sinkCalls.push(batch),
    })
    const sub = capture.start()

    for (let i = 0; i < 10; i++) {
      emitAgentEvent('agent:thought-delta', 'space-1', SELF_SESSION, { i })
    }
    expect(sinkCalls).toHaveLength(0) // not flushed yet (within window)

    vi.advanceTimersByTime(50) // window fires
    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0].frames).toHaveLength(10)

    sub.dispose()
  })

  it('flushes early once the frame count exceeds 64', () => {
    const sinkCalls: StreamFramesFrame[] = []
    const capture = createRelayCapture({
      isOwnTeamSession: (id) => id === SELF_SESSION,
      resolveOffice: () => OFFICE,
      sink: (_office, batch) => sinkCalls.push(batch),
    })
    const sub = capture.start()

    for (let i = 0; i < 64; i++) {
      emitAgentEvent('agent:thought-delta', 'space-1', SELF_SESSION, { i })
    }
    // 64th frame hits BATCH_MAX_FRAMES → flush without waiting for the timer.
    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0].frames).toHaveLength(64)

    sub.dispose()
  })
})

describe('StreamReplay (re-fire + dedup + INV-NO-LOOP)', () => {
  it('re-fires once per new seq with the right channel/conversationId/payload', () => {
    const tap = tapEvents()
    const replay = createStreamReplay()

    const batch: StreamFramesFrame = {
      kind: 'stream-frames',
      officeId: OFFICE,
      sessionKey: OTHER_SESSION,
      baseSeq: 1,
      frames: [
        { seq: 1, kind: 'milestone', channel: 'agent:tool-call', spaceId: 's', payload: { id: 't1' } },
        { seq: 2, kind: 'incremental', channel: 'agent:thought-delta', spaceId: 's', payload: { d: 'x' } },
      ],
    }
    replay.apply(batch)
    tap.dispose()

    expect(tap.events).toHaveLength(2)
    expect(tap.events[0]).toMatchObject({
      channel: 'agent:tool-call',
      spaceId: 's',
      conversationId: OTHER_SESSION,
      data: { id: 't1' },
    })
    expect(tap.events[1].channel).toBe('agent:thought-delta')
  })

  it('is idempotent: re-applying the same batch replays each frame only once', () => {
    const tap = tapEvents()
    const replay = createStreamReplay()
    const batch: StreamFramesFrame = {
      kind: 'stream-frames',
      officeId: OFFICE,
      sessionKey: OTHER_SESSION,
      baseSeq: 1,
      frames: [
        { seq: 1, kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { a: 1 } },
        { seq: 2, kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { a: 2 } },
      ],
    }
    replay.apply(batch)
    replay.apply(batch) // duplicate delivery
    tap.dispose()

    expect(tap.events).toHaveLength(2) // not 4 — dedup by (sessionKey, seq)
  })

  it('owner restart (new originRun) resets the watermark: post-restart frames replay instead of being dropped', () => {
    const tap = tapEvents()
    const replay = createStreamReplay()
    const mk = (seq: number, originRun: string): StreamFramesFrame => ({
      kind: 'stream-frames',
      officeId: OFFICE,
      sessionKey: OTHER_SESSION,
      baseSeq: seq,
      frames: [{ seq, kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { seq } }],
      originRun,
    })

    // First producer run climbs to seq 5.
    replay.apply(mk(5, 'run-1'))
    expect(tap.events).toHaveLength(1)

    // Same run, lower seq → still a duplicate (watermark holds within a run).
    replay.apply(mk(3, 'run-1'))
    expect(tap.events).toHaveLength(1)

    // Producer restarts: NEW run, seq restarts at 1. Must replay, not drop —
    // this was the silent "viewer freezes after the owner restarts" bug.
    replay.apply(mk(1, 'run-2'))
    tap.dispose()
    expect(tap.events).toHaveLength(2)
    expect(tap.events[1].data).toEqual({ seq: 1 })
  })

  it('INV-NO-LOOP: replayed frames for a NON-owned session are not re-captured', () => {
    const sink = vi.fn()
    // Capture owns SELF_SESSION only; the replayed batch is for OTHER_SESSION.
    const capture = createRelayCapture({
      isOwnTeamSession: (id) => id === SELF_SESSION,
      resolveOffice: () => OFFICE,
      sink,
    })
    const sub = capture.start()

    const replay = createStreamReplay()
    replay.apply({
      kind: 'stream-frames',
      officeId: OFFICE,
      sessionKey: OTHER_SESSION,
      baseSeq: 1,
      frames: [
        { seq: 1, kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { x: 1 } },
      ],
    })

    capture.flushAll()
    sub.dispose()
    // The re-fire went through the global emitter, but capture rejects it
    // (not owned) → no relay loop.
    expect(sink).not.toHaveBeenCalled()
  })

  it('INV-NO-LOOP (owner echo): a replayed frame for an OWNED session is NOT re-captured', () => {
    // The host fan-out echoes a producer's own batch back to it (broadcast to all
    // office clients, incl. the producer). If the producing/owner node re-captured
    // its own replayed frames, it would relay them again — an unbounded A→B→A
    // amplification loop. The owner-only filter does NOT stop this (the session IS
    // owned here). The relayed=true tag must.
    const sink = vi.fn()
    const capture = createRelayCapture({
      isOwnTeamSession: (id) => id === SELF_SESSION, // owner owns this very session
      resolveOffice: () => OFFICE,
      sink,
    })
    const sub = capture.start()

    const replay = createStreamReplay()
    // The echoed batch is for the OWNED session — the dangerous case.
    replay.apply({
      kind: 'stream-frames',
      officeId: OFFICE,
      sessionKey: SELF_SESSION,
      baseSeq: 1,
      frames: [
        { seq: 1, kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { x: 1 } },
        { seq: 2, kind: 'incremental', channel: 'agent:thought-delta', spaceId: 's', payload: { d: 'y' } },
      ],
    })

    capture.flushAll()
    sub.dispose()
    expect(sink).not.toHaveBeenCalled()
  })

  it('a genuine local (non-relayed) event on an owned session IS still captured', () => {
    // Guard against over-filtering: the relayed-tag rejection must not suppress a
    // real local turn's events.
    const sink = vi.fn()
    const capture = createRelayCapture({
      isOwnTeamSession: (id) => id === SELF_SESSION,
      resolveOffice: () => OFFICE,
      sink,
    })
    const sub = capture.start()
    // A local turn fires WITHOUT the relayed flag.
    emitAgentEvent('agent:message', 'space-1', SELF_SESSION, { text: 'local work' })
    capture.flushAll()
    sub.dispose()
    expect(sink).toHaveBeenCalledTimes(1)
  })
})

// ── Two-node relay: owner B → host A applies → A emits locally ──

const NODE_A = 'node-a-host'
const NODE_B = 'node-b-owner'
const B_CLIENT_ID = 'ws-client-b'
const VALID_TOKEN = 'valid-token'

describe('two-node relay (in-process)', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let teamStore: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    federationStore = new FederationStore(db)
    teamStore = new TeamStore(db)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it("relays B's member stream to host A, which emits the agent events locally", async () => {
    const verify = (token: string) =>
      token === VALID_TOKEN ? ({ officeId: OFFICE } as OfficeCredentialLike) : null

    // B's joiner link: outbound send simulates B's WS client → A.handleHostInbound.
    const bLink = new LanMeshLink((_to, frame) => {
      hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame })
    })

    const hostManager = createFederationManager({
      hostSend: (clientId, frame) => {
        if (clientId !== B_CLIENT_ID) return false
        bLink.deliver(NODE_A, frame) // host → joiner
        return true
      },
      hostListOfficeClients: () => [B_CLIENT_ID],
      federationStore,
      teamStore,
      verifyCredential: verify,
      getLocalNodeId: () => NODE_A,
    })
    hostManager.hostOffice(OFFICE)

    // B joins so A persists B's member (owner = NODE_B).
    const bFed = createFederation({
      context: { officeId: OFFICE, selfNodeId: NODE_B },
      link: bLink,
      federationStore,
      teamStore,
      verifyCredential: () => null,
    })
    bFed.coordinator.start()
    const joinReq: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: NODE_B,
      identityId: 'identity-b',
      displayName: 'Node B',
      credentialToken: VALID_TOKEN,
      bringMembers: [{ appId: OTHER_APP, memberName: 'b-analyst', role: 'Analyst', spaceId: 'space-b' }],
    }
    bFed.coordinator.requestJoin(joinReq)

    // B's RelayCapture owns the member's team session. Its sink HOLDS the batch
    // (the relay hop is async across the network in production). We deliver it to
    // A only AFTER disposing B's capture — in a single process the two nodes
    // share one global emitter, so leaving B's capture live during A's re-fire
    // would re-capture (an artifact of in-process testing, not production where
    // capture/replay live on different machines). Disposing first keeps the test
    // faithful to the owner-only isolation INV-NO-LOOP guarantees in production.
    const held: StreamFramesFrame[] = []
    const bCapture = createRelayCapture({
      isOwnTeamSession: (id) => id === OTHER_SESSION,
      resolveOffice: () => OFFICE,
      sink: (_officeId, batch) => held.push(batch),
    })
    const bSub = bCapture.start()

    emitAgentEvent('agent:tool-call', 'space-b', OTHER_SESSION, { id: 'tool-1' })
    emitAgentEvent('agent:message', 'space-b', OTHER_SESSION, { text: 'result' })
    bCapture.flushAll() // flush B's batch → held
    bSub.dispose() // B's capture stops listening before the relay reaches A

    expect(held).toHaveLength(1)
    expect(held[0].frames).toHaveLength(2)

    const tap = tapEvents()
    bLink.broadcast(held[0] as unknown as FederationMessage) // joiner → host A
    tap.dispose()

    // A's onStreamFrames → streamReplay.apply → emitAgentEvent: A re-fired both
    // relayed frames locally (the renderer zero-change path). This proves B's
    // member's stream appears on A.
    const relayed = tap.events.filter((e) => e.conversationId === OTHER_SESSION)
    expect(relayed.map((e) => e.channel)).toEqual(['agent:tool-call', 'agent:message'])
    expect(relayed[0]).toMatchObject({ data: { id: 'tool-1' }, spaceId: 'space-b' })
    expect(relayed[1]).toMatchObject({ data: { text: 'result' } })

    hostManager.stopAll()
  })

  it('host re-broadcast EXCLUDES the producing client (no echo back to producer)', () => {
    const C_CLIENT_ID = 'ws-client-c'
    const fannedTo: string[] = []
    const hostManager = createFederationManager({
      hostSend: (clientId, frame) => {
        if (frame.kind === 'stream-frames') fannedTo.push(clientId)
        return true
      },
      hostListOfficeClients: () => [B_CLIENT_ID, C_CLIENT_ID],
      federationStore,
      teamStore,
      verifyCredential: (token) =>
        token === VALID_TOKEN ? ({ officeId: OFFICE } as OfficeCredentialLike) : null,
      getLocalNodeId: () => NODE_A,
    })
    hostManager.hostOffice(OFFICE)

    // A stream batch arrives on B's client (B is the producer).
    const batch: StreamFramesFrame = {
      kind: 'stream-frames',
      officeId: OFFICE,
      sessionKey: OTHER_SESSION,
      baseSeq: 1,
      frames: [{ seq: 1, kind: 'milestone', channel: 'agent:message', spaceId: 's', payload: { x: 1 } }],
    }
    hostManager.handleHostInbound({
      clientId: B_CLIENT_ID,
      officeId: OFFICE,
      frame: batch as unknown as FederationMessage,
    })

    // The viewer C receives it; the producer B does NOT (loop prevention layer 1).
    expect(fannedTo).toContain(C_CLIENT_ID)
    expect(fannedTo).not.toContain(B_CLIENT_ID)

    hostManager.stopAll()
  })
})
