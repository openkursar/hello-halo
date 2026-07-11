/**
 * Unit tests for runtime/team message-bus (coordination kernel)
 *
 * Covers the §5 reply mechanics and §13 circuit breaker against a real
 * in-memory TeamStore and a MOCK TeamDeliveryHooks:
 *   - member resolution + unknown member rejection
 *   - topology reject (structured) vs allow (free)
 *   - wait=true resolve on result (final message) + timeout
 *   - wait=false returns messageId + completion re-wakes the original sender
 *   - busy → buffer → drain on turn completion
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
  }
  return { hooks, wakes, busy }
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

    it('on completion, re-wakes the ORIGINAL sender with a completion envelope', async () => {
      seedTeam(store, 'free')
      const { hooks, wakes } = makeHooks()
      const bus = createMessageBus({ store, hooks })

      await bus.send({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: LEAD_APP, to: 'researcher', message: 'Do T1', wait: false })
      const targetWake = wakes[0]

      bus.completeTurn({
        sessionKey: targetWake.sessionKey,
        trigger: targetWake.trigger,
        outcome: { kind: 'result', content: 'T1 done: competitors.md' },
      })

      // A second wake goes back to the lead (the original sender).
      expect(wakes).toHaveLength(2)
      const completionWake = wakes[1]
      expect(completionWake.appId).toBe(LEAD_APP)
      expect(completionWake.envelope.body).toContain('T1 done')
      expect(completionWake.envelope.fromAppId).toBe(RESEARCHER_APP)
      // RC3: the completion carries the finisher identity via kind='completion'.
      expect(completionWake.trigger.kind).toBe('completion')
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
})
