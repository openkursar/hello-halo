/**
 * Unit tests for runtime/team message-bus (coordination kernel)
 *
 * Covers the §5 reply mechanics and §13 circuit breaker against a real
 * in-memory TeamStore and a MOCK TeamDeliveryHooks:
 *   - member resolution + unknown member rejection
 *   - topology reject (structured) vs allow (free)
 *   - a send returns a messageId and NOTHING is delivered back when the turn ends
 *   - the completion receipt (a person's 1:1 chat, not a teammate) + its timeout
 *   - busy → buffer → drain on turn completion, for local and relayed turns alike
 *   - circuit breaker breach (message count + forward depth)
 *
 * The event emitters (http/websocket, foundation/window.service) are mocked so
 * the bus can run without Electron and so emissions can be asserted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import {
  createMessageBus,
  TopologyError,
  UnknownMemberError,
  CircuitBreakerError,
} from '../../../../../src/main/apps/runtime/team/message-bus'
import type {
  TeamDeliveryHooks,
  TurnCompletion,
} from '../../../../../src/main/apps/runtime/team/message-bus'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/team-types'
import type { Team, TeamMember, TeamEpoch, TeamEdge } from '../../../../../src/main/apps/team/types'

// ============================================
// Fixtures
// ============================================

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const LEAD_APP = 'app-lead'
const RESEARCHER_APP = 'app-researcher'
const TESTER_APP = 'app-tester'

function seedTeam(store: TeamStore, collabMode: Team['collabMode']): void {
  const now = Date.now()
  const team: Team = {
    id: TEAM_ID,
    name: 'Research Team',
    owningSpaceId: 'space-a',
    goal: 'Build a competitor brief',
    leadAppId: LEAD_APP,
    memberSourcing: 'manual',
    collabMode,
    escalationRouting: 'user',
    status: 'running',
    currentEpochId: EPOCH_ID,
    createdAt: now,
    updatedAt: now,
  }
  store.insertTeam(team)

  const members: TeamMember[] = [
    { teamId: TEAM_ID, appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: RESEARCHER_APP, memberName: 'researcher', role: 'Research', isLead: false, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: TESTER_APP, memberName: 'tester', role: 'QA', isLead: false, aiProvisioned: false, addedAt: now },
  ]
  for (const m of members) store.addMember(m)

  const epoch: TeamEpoch = { id: EPOCH_ID, teamId: TEAM_ID, startedAt: now, endedAt: null, endReason: null, summary: null, lifecycle: 'run' }
  store.insertEpoch(epoch)

  if (collabMode === 'structured') {
    // lead → researcher, lead → tester (but NOT researcher → tester).
    const edges: TeamEdge[] = [
      { teamId: TEAM_ID, fromAppId: LEAD_APP, toAppId: RESEARCHER_APP, sync: false },
      { teamId: TEAM_ID, fromAppId: LEAD_APP, toAppId: TESTER_APP, sync: false },
    ]
    store.replaceEdgesForTeam(TEAM_ID, edges)
  }
}

/** A mock hooks implementation that records wakes and lets the test drive busyness. */
function makeHooks() {
  const wakes: Array<{ sessionKey: string; appId: string; envelope: any; trigger: any }> = []
  const busy = new Set<string>()
  // Members whose owner is unreachable (empty by default → everything reachable, so
  // existing tests are unaffected by the wait=false reachability gate).
  const unreachable = new Set<string>()
  const hooks: TeamDeliveryHooks = {
    wakeTarget: vi.fn(async (params) => {
      wakes.push({
        sessionKey: params.sessionKey,
        appId: params.appId,
        envelope: params.envelope,
        trigger: params.trigger,
      })
    }),
    isBusy: (sessionKey: string) => busy.has(sessionKey),
    checkReachable: (appId: string) => !unreachable.has(appId),
  }
  return { hooks, wakes, busy, unreachable }
}

// ============================================
// Setup
// ============================================

describe('MessageBus', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  // ===========================================================================
  // Addressing / topology
  // ===========================================================================

  describe('addressing & topology', () => {
    it('resolves a member name to its appId', () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })
      expect(bus.resolveMemberAppId(TEAM_ID, 'researcher')).toBe(RESEARCHER_APP)
    })

    it('throws UnknownMemberError for an unknown member', async () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })
      await expect(
        bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'ghost', message: 'hi' })
      ).rejects.toBeInstanceOf(UnknownMemberError)
    })

    it('free mode allows any member to contact any member', () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })
      expect(() => bus.assertCanContact(TEAM_ID, RESEARCHER_APP, TESTER_APP, 'free')).not.toThrow()
    })

    it('structured mode rejects a contact with no edge', () => {
      seedTeam(store, 'structured')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })
      // researcher → tester has no edge.
      expect(() => bus.assertCanContact(TEAM_ID, RESEARCHER_APP, TESTER_APP, 'structured')).toThrow(
        TopologyError
      )
    })

    it('structured mode allows a contact along an edge', () => {
      seedTeam(store, 'structured')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })
      expect(() => bus.assertCanContact(TEAM_ID, LEAD_APP, RESEARCHER_APP, 'structured')).not.toThrow()
    })

    it('structured mode lets a member ANSWER along the reverse edge', () => {
      // The default topology is a one-way star (lead → member), and a reply is
      // itself a team_send: a strict edge check leaves a structured team able to
      // receive orders but never to answer them.
      seedTeam(store, 'structured')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })
      expect(() => bus.assertCanContact(TEAM_ID, RESEARCHER_APP, LEAD_APP, 'structured')).not.toThrow()
      expect(() => bus.assertCanContact(TEAM_ID, RESEARCHER_APP, TESTER_APP, 'structured')).toThrow(
        TopologyError
      )
    })
  })

  // ===========================================================================
  // wait=false (async)
  // ===========================================================================

  describe('send wait=false', () => {
    it('returns a messageId and wakes the target', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const result = await bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: LEAD_APP,
        to: 'researcher',
        message: 'Do T1',
        wait: false,
      })

      expect(result).toHaveProperty('messageId')
      expect(wakes).toHaveLength(1)
      expect(wakes[0].appId).toBe(RESEARCHER_APP)
      expect(wakes[0].envelope.body).toBe('Do T1')
      expect(wakes[0].trigger.fromAppId).toBe(LEAD_APP)
      expect(wakes[0].trigger.wait).toBe(false)
      // team:message emitted on both transports.
      expect(broadcastToAll).toHaveBeenCalledWith('team:message', expect.objectContaining({ fromMemberName: 'lead', toMemberName: 'researcher' }))
      expect(sendToRenderer).toHaveBeenCalledWith('team:message', expect.any(Object))
    })

    it('does NOT deliver the finished turn back to the sender — a reply is an explicit team_send', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'Do T1' })
      const targetWake = wakes[0]

      bus.completeTurn({
        sessionKey: targetWake.sessionKey,
        trigger: targetWake.trigger,
        outcome: { kind: 'result', content: 'T1 done: competitors.md' },
      })

      // The closing line went to whoever is watching the member's own chat.
      // Forwarding it as the lead's answer makes two members relay each other's
      // sign-offs forever.
      expect(wakes).toHaveLength(1)
    })

    it('a teammate reply reaches the sender only when the member actually sends one', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'Do T1' })
      const targetWake = wakes[0]

      await bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: RESEARCHER_APP,
        to: 'lead',
        message: 'T1 done: competitors.md',
      })
      bus.completeTurn({
        sessionKey: targetWake.sessionKey,
        trigger: targetWake.trigger,
        outcome: { kind: 'result', content: 'sent it over' },
      })

      expect(wakes).toHaveLength(2)
      expect(wakes[1].appId).toBe(LEAD_APP)
      expect(wakes[1].envelope.body).toBe('T1 done: competitors.md')
      expect(wakes[1].trigger.fromAppId).toBe(RESEARCHER_APP)
      expect(wakes[1].trigger.kind).toBe('message')
    })

    it('wait=false to an UNREACHABLE remote member returns undelivered NOW (no false "sent", no delivery attempt)', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes, unreachable } = makeHooks()
      unreachable.add(RESEARCHER_APP) // researcher's owner is offline
      const bus = createMessageBus({ store, hooks })

      const result = await bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: LEAD_APP,
        to: 'researcher',
        message: 'Do T1',
        wait: false,
      })

      // Reported as not-delivered immediately (not a false "sent"), and NOT attempted.
      expect('messageId' in result && result.delivery).toBe('undelivered')
      expect(wakes).toHaveLength(0)
    })

    it('wait=false to a REACHABLE member proceeds normally (no undelivered flag)', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks() // all reachable by default
      const bus = createMessageBus({ store, hooks })

      const result = await bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: LEAD_APP,
        to: 'researcher',
        message: 'Do T1',
        wait: false,
      })

      expect('messageId' in result && result.delivery).toBeUndefined()
      expect(wakes).toHaveLength(1)
    })

    it('does NOT re-wake the sender for an escalation outcome (routed by session layer)', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'Do T1', wait: false })
      const targetWake = wakes[0]

      bus.completeTurn({
        sessionKey: targetWake.sessionKey,
        trigger: targetWake.trigger,
        outcome: { kind: 'escalation', content: 'need a decision' },
      })

      expect(wakes).toHaveLength(1)
    })
  })

  // ===========================================================================
  // wait=true (sync)
  // ===========================================================================

  describe('send wait=true', () => {
    it('resolves with the final-message content when the target turn completes', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const pending = bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: TESTER_APP,
        to: 'lead',
        message: 'data source 403, skip or wait?',
        wait: true,
      })

      // Let the microtask deliver + register the waiter.
      await Promise.resolve()
      const wake = wakes[0]
      expect(wake.trigger.wait).toBe(true)

      bus.completeTurn({
        sessionKey: wake.sessionKey,
        trigger: wake.trigger,
        outcome: { kind: 'result', content: 'skip today' },
      })

      const result = await pending
      expect(result).toEqual({ from: 'lead', message: 'skip today', status: 'ok' })
    })

    it('resolves with status=timeout when the wait timer fires before completion', async () => {
      vi.useFakeTimers()
      try {
        seedTeam(store, 'free')
        const { hooks } = makeHooks()
        const bus = createMessageBus({ store, hooks, syncWaitTimeoutMs: 1000 })

        const pending = bus.send({
          teamId: TEAM_ID,
          epochId: EPOCH_ID,
          fromAppId: TESTER_APP,
          to: 'lead',
          message: 'blocked?',
          wait: true,
        })
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(1001)

        const result = await pending
        expect(result.status).toBe('timeout')
        expect(result.from).toBe('lead')
      } finally {
        vi.useRealTimers()
      }
    })

    it('maps an error outcome to an ok reply describing the failure', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const pending = bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: TESTER_APP, to: 'lead', message: 'q', wait: true })
      await Promise.resolve()
      bus.completeTurn({ sessionKey: wakes[0].sessionKey, trigger: wakes[0].trigger, outcome: { kind: 'error', message: 'boom' } })

      const result = await pending
      expect(result.status).toBe('ok')
      expect(result.message).toMatch(/failed/i)
    })

    it('maps an undelivered outcome to status=undelivered (not a fake ok reply)', async () => {
      // The wake never reached the owner: the sender must get a NON-ok status so it
      // reassigns, never mistaking the empty message for a real reply (S6/MB-1).
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const pending = bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: TESTER_APP, to: 'lead', message: 'q', wait: true })
      await Promise.resolve()
      bus.completeTurn({
        sessionKey: wakes[0].sessionKey,
        trigger: wakes[0].trigger,
        outcome: { kind: 'undelivered', reason: 'owner-unreachable' },
      })

      const result = await pending
      expect(result.status).toBe('undelivered')
      expect(result.message).toMatch(/not delivered/i)
    })

    it('resolves for a conversation epoch even though it does not occupy currentEpochId', async () => {
      // Conversation epochs (IM) deliberately leave team.currentEpochId null.
      // completeTurn must key on the epoch's open state, not currentEpochId,
      // otherwise every member reply to the lead would be dropped.
      seedTeam(store, 'free')
      store.updateTeamCurrentEpoch(TEAM_ID, null)
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const pending = bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: TESTER_APP, to: 'lead', message: 'q', wait: true })
      await Promise.resolve()
      bus.completeTurn({
        sessionKey: wakes[0].sessionKey,
        trigger: wakes[0].trigger,
        outcome: { kind: 'result', content: 'all good' },
      })

      const result = await pending
      expect(result).toEqual({ from: 'lead', message: 'all good', status: 'ok' })
    })
  })

  describe('completeTurn epoch-currency guard', () => {
    it('drops a wait=false completion for a SEALED epoch (no sender wake)', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      await Promise.resolve()
      const memberWake = wakes.find((w) => w.appId === RESEARCHER_APP)!
      const wakesBefore = wakes.length

      // Seal the epoch, then deliver the member's completion: it must be dropped
      // (a late turn must not reignite a finished run).
      store.endEpoch(EPOCH_ID, Date.now(), 'completed', null)
      bus.completeTurn({
        sessionKey: memberWake.sessionKey,
        trigger: memberWake.trigger,
        outcome: { kind: 'result', content: 'late result' },
      })
      await Promise.resolve()

      // No new wake of the original sender (lead) was scheduled.
      expect(wakes.length).toBe(wakesBefore)
    })
  })

  // ===========================================================================
  // Busy → buffer → drain
  // ===========================================================================

  describe('mailbox buffering', () => {
    it('buffers when the target is busy and drains on turn completion', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes, busy } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const researcherSession = buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, EPOCH_ID)
      busy.add(researcherSession) // researcher is mid-turn

      const result = await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'queued', wait: false })
      expect(result).toHaveProperty('messageId')
      // No wake yet — it was buffered.
      expect(wakes).toHaveLength(0)

      // Researcher's turn ends → drain delivers the buffered envelope.
      busy.delete(researcherSession)
      bus.completeTurn({
        sessionKey: researcherSession,
        trigger: { teamId: TEAM_ID, epochId: EPOCH_ID, correlationId: 'c0', fromAppId: null, wait: false },
        outcome: { kind: 'result', content: '' },
      })

      expect(wakes).toHaveLength(1)
      expect(wakes[0].envelope.body).toBe('queued')
      expect(wakes[0].appId).toBe(RESEARCHER_APP)
    })

    it('caps the per-session mailbox, shedding the OLDEST when the bound is exceeded (M-4)', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes, busy } = makeHooks()
      // Raise the circuit ceiling so this test exercises the mailbox bound, not
      // the message-count breaker (the two are independent guards).
      const bus = createMessageBus({ store, hooks, circuitOverrides: { maxMessages: 1000 } })

      const researcherSession = buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, EPOCH_ID)
      busy.add(researcherSession) // researcher stays mid-turn the whole time

      // Buffer more than the cap (128). The first two must be shed as oldest.
      const total = 130
      for (let i = 0; i < total; i++) {
        await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: `msg-${i}`, wait: false })
      }
      expect(wakes).toHaveLength(0) // all buffered, none woken while busy

      // Drain one: the oldest SURVIVOR is msg-2 (msg-0 and msg-1 were shed).
      busy.delete(researcherSession)
      bus.completeTurn({
        sessionKey: researcherSession,
        trigger: { teamId: TEAM_ID, epochId: EPOCH_ID, correlationId: 'c0', fromAppId: null, wait: false },
        outcome: { kind: 'result', content: '' },
      })
      expect(wakes[0].envelope.body).toBe('msg-2')
    })
  })

  // ===========================================================================
  // Circuit breaker
  // ===========================================================================

  describe('circuit breaker', () => {
    it('trips on max message count and fires onBreach', async () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks, circuitOverrides: { maxMessages: 2 } })
      const breaches: string[] = []
      bus.onBreach((e) => breaches.push(e.reason))

      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: '1', wait: false })
      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: '2', wait: false })

      await expect(
        bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: '3', wait: false })
      ).rejects.toBeInstanceOf(CircuitBreakerError)

      expect(breaches).toContain('maxMessages')
      expect(bus.getEpochStats(EPOCH_ID).breached).toBe(true)
    })

    it('trips on max forward depth', async () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks, circuitOverrides: { maxForwardDepth: 3 } })

      await expect(
        bus.send({
          teamId: TEAM_ID,
          epochId: EPOCH_ID,
          fromAppId: LEAD_APP,
          to: 'researcher',
          message: 'deep',
          wait: false,
          forwardDepth: 4,
        })
      ).rejects.toBeInstanceOf(CircuitBreakerError)
    })

    it('resetEpoch clears the counters', async () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks, circuitOverrides: { maxMessages: 5 } })
      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'x', wait: false })
      expect(bus.getEpochStats(EPOCH_ID).messageCount).toBe(1)
      bus.resetEpoch(EPOCH_ID)
      expect(bus.getEpochStats(EPOCH_ID).messageCount).toBe(0)
    })
  })

  // ============================================
  // Mailbox liveness + wake atomicity
  // ============================================

  describe('mailbox liveness and wake atomicity', () => {
    const LEAD_KEY = buildTeamSessionKey(LEAD_APP, TEAM_ID, EPOCH_ID)

    it('drainMailbox delivers mail stranded behind a NON-bus turn (human 1:1 chat)', async () => {
      // The stranding scenario: the lead is busy with a HUMAN 1:1 chat on its
      // team session (a turn the bus never sees), teammates' completions
      // buffer against it, and the human turn's end never passes through
      // completeTurn. The session layer's turn-end hook calls drainMailbox —
      // that is the sole liveness path for this mail.
      seedTeam(store, 'free')
      const { hooks, wakes, busy } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      busy.add(LEAD_KEY) // human turn occupies the lead's team session
      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: RESEARCHER_APP, to: 'lead', message: 'done 1', wait: false })
      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: TESTER_APP, to: 'lead', message: 'done 2', wait: false })
      expect(wakes).toHaveLength(0)
      expect(bus.hasBufferedMessages(EPOCH_ID)).toBe(true)

      // The human turn ends: no completeTurn fires (it never went through the
      // bus) — only the session layer's drain nudge.
      busy.delete(LEAD_KEY)
      bus.drainMailbox(LEAD_KEY)
      expect(wakes).toHaveLength(1)
      expect(wakes[0].envelope.body).toBe('done 1')

      // One envelope per turn: the second drains when the first turn completes.
      // (completeTurn also re-wakes the original SENDER with a completion — an
      // unrelated, pre-existing behaviour — so assert on the lead's wakes only.)
      bus.completeTurn({ sessionKey: LEAD_KEY, trigger: wakes[0].trigger, outcome: { kind: 'result', content: 'ok' } })
      const leadWakes = wakes.filter((w) => w.sessionKey === LEAD_KEY)
      expect(leadWakes).toHaveLength(2)
      expect(leadWakes[1].envelope.body).toBe('done 2')
    })

    it('two deliveries inside the wake-dispatch window run ONE turn (second buffers)', async () => {
      // The busy probe only turns true once the session layer registers the
      // turn — asynchronously after wakeTarget. Two sends in that window used
      // to race two concurrent turns onto one session key.
      seedTeam(store, 'free')
      const { hooks, wakes, busy } = makeHooks()
      // wakeTarget resolves immediately (dispatch accepted) but the session
      // never registers as busy — the exact race window, held open.
      void busy
      const bus = createMessageBus({ store, hooks })

      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: RESEARCHER_APP, to: 'lead', message: 'first', wait: false })
      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: TESTER_APP, to: 'lead', message: 'second', wait: false })

      // Exactly one turn dispatched; the second delivery buffered behind the
      // in-flight reservation instead of double-waking the session.
      expect(wakes).toHaveLength(1)
      expect(wakes[0].envelope.body).toBe('first')
      expect(bus.hasBufferedMessages(EPOCH_ID)).toBe(true)

      // The reserved turn completes → the buffered one dispatches (sender
      // completion wakes are filtered out; see the stranded-mail test).
      bus.completeTurn({ sessionKey: LEAD_KEY, trigger: wakes[0].trigger, outcome: { kind: 'result', content: 'ok' } })
      const leadWakes = wakes.filter((w) => w.sessionKey === LEAD_KEY)
      expect(leadWakes).toHaveLength(2)
      expect(leadWakes[1].envelope.body).toBe('second')
    })

    it('a failed wake dispatch releases the reservation (no fake-busy deadlock)', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })
      ;(hooks.wakeTarget as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn failed'))

      await expect(
        bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: RESEARCHER_APP, to: 'lead', message: 'lost', wait: false })
      ).rejects.toThrow('spawn failed')

      // The key must not stay reserved: the next delivery dispatches normally.
      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: RESEARCHER_APP, to: 'lead', message: 'retry', wait: false })
      expect(wakes).toHaveLength(1)
      expect(wakes[0].envelope.body).toBe('retry')
    })

    it('the buffered-mail recheck backstop drains without any turn-end signal', async () => {
      // Covers the race where the target goes idle between the busy probe and
      // the buffer push: no turn end will ever fire for that mail.
      vi.useFakeTimers()
      try {
        seedTeam(store, 'free')
        const { hooks, wakes, busy } = makeHooks()
        const bus = createMessageBus({ store, hooks })

        busy.add(LEAD_KEY)
        await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: RESEARCHER_APP, to: 'lead', message: 'raced', wait: false })
        expect(wakes).toHaveLength(0)

        busy.delete(LEAD_KEY) // went idle with no drain signal
        await vi.advanceTimersByTimeAsync(3100)
        expect(wakes).toHaveLength(1)
        expect(wakes[0].envelope.body).toBe('raced')
      } finally {
        vi.useRealTimers()
      }
    })

    it('the recheck keeps re-arming while the target stays busy', async () => {
      // A turn can hang for minutes: a single recheck spent on a still-busy
      // target strands the mail until that turn ends.
      vi.useFakeTimers()
      try {
        seedTeam(store, 'free')
        const { hooks, wakes, busy } = makeHooks()
        const bus = createMessageBus({ store, hooks })

        busy.add(LEAD_KEY)
        await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: RESEARCHER_APP, to: 'lead', message: 'held', wait: false })

        await vi.advanceTimersByTimeAsync(10_000) // several rechecks, all busy
        expect(wakes).toHaveLength(0)

        busy.delete(LEAD_KEY)
        await vi.advanceTimersByTimeAsync(3100)
        expect(wakes).toHaveLength(1)
        expect(wakes[0].envelope.body).toBe('held')

        // Drained mailbox → no timer left running.
        await vi.advanceTimersByTimeAsync(10_000)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // Relayed turns (a federation wake landing on the member's OWNER).
  //
  // The owner is the only node that can know whether the member is already
  // mid-turn. Without the gate a relayed wake runs into a session a local
  // delivery already owns: two turns share one SDK message iterator, whoever
  // reads the single `result` first finishes with the other's answer, and the
  // loser waits forever.
  // ===========================================================================

  describe('runRelayedTurn — the owner-side gate', () => {
    const RESEARCHER_KEY = buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, EPOCH_ID)

    function deferred<T>() {
      let resolve!: (v: T) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    it('runs immediately on an idle session', async () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const out = await bus.runRelayedTurn({
        sessionKey: RESEARCHER_KEY,
        run: async () => 'ran',
      })
      expect(out).toBe('ran')
    })

    it('waits for the turn in progress instead of starting a second one', async () => {
      seedTeam(store, 'free')
      const { hooks, busy } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      // A local turn is live on this session — a person chatting with the member.
      busy.add(RESEARCHER_KEY)
      let started = false
      const relayed = bus.runRelayedTurn({
        sessionKey: RESEARCHER_KEY,
        run: async () => {
          started = true
          return 'ran'
        },
      })
      await Promise.resolve()
      expect(started).toBe(false)

      busy.delete(RESEARCHER_KEY)
      bus.drainMailbox(RESEARCHER_KEY)
      await expect(relayed).resolves.toBe('ran')
      expect(started).toBe(true)
    })

    it('holds the slot while it runs, so a local delivery queues behind it', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const gate = deferred<string>()
      const relayed = bus.runRelayedTurn({ sessionKey: RESEARCHER_KEY, run: () => gate.promise })
      await Promise.resolve()

      const sent = await bus.send({
        teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'Do T1',
      })
      expect(wakes).toHaveLength(0)
      expect('messageId' in sent && sent.delivery).toBe('queued')

      gate.resolve('ran')
      await relayed
      await Promise.resolve()
      expect(wakes).toHaveLength(1)
      expect(wakes[0].envelope.body).toBe('Do T1')
    })

    it('releases the slot when the turn throws', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      await expect(
        bus.runRelayedTurn({
          sessionKey: RESEARCHER_KEY,
          run: async () => {
            throw new Error('boom')
          },
        })
      ).rejects.toThrow('boom')

      await bus.send({
        teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'Do T1',
      })
      expect(wakes).toHaveLength(1)
    })

    it('serialises several relayed turns rather than overlapping them', async () => {
      seedTeam(store, 'free')
      const { hooks } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      const order: string[] = []
      const first = deferred<void>()
      const second = deferred<void>()

      const a = bus.runRelayedTurn({
        sessionKey: RESEARCHER_KEY,
        run: async () => {
          order.push('a:start')
          await first.promise
          order.push('a:end')
        },
      })
      const b = bus.runRelayedTurn({
        sessionKey: RESEARCHER_KEY,
        run: async () => {
          order.push('b:start')
          await second.promise
          order.push('b:end')
        },
      })

      await Promise.resolve()
      expect(order).toEqual(['a:start'])

      first.resolve()
      await a
      await Promise.resolve()
      expect(order).toEqual(['a:start', 'a:end', 'b:start'])

      second.resolve()
      await b
      expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    })

    it('fails a still-queued relayed turn when the epoch is reset, instead of stranding its caller', async () => {
      seedTeam(store, 'free')
      const { hooks, busy } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      busy.add(RESEARCHER_KEY)
      const relayed = bus.runRelayedTurn({ sessionKey: RESEARCHER_KEY, run: async () => 'ran' })
      await Promise.resolve()

      // The caller is on another node holding a completion waiter — failing it
      // now beats an hours-long backstop.
      bus.resetEpoch(EPOCH_ID)
      await expect(relayed).rejects.toThrow(/run was stopped/)
    })
  })
})
