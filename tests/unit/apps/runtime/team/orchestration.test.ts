/**
 * Unit tests for runtime/team orchestration (epoch lifecycle + delivery hooks).
 *
 * Covers:
 *   - completion detection: the four turn exits (clean stream end → result from
 *     the final message, captured escalation → escalation, session throw → error,
 *     timeout → timeout) mapped onto TurnCompletion and fed to the bus.
 *   - epoch start: row created, team status/current_epoch set, lead woken once.
 *   - epoch seal: epoch archived (tasks/findings retained), member team sessions
 *     cleared, bus epoch reset, team normalized to idle.
 *   - circuit breach → escalate-to-user + seal.
 *   - prompt-context projection (roster + topology) and its per-turn stability.
 *   - runtime-originated wakes (escalation resume, periodic check) sharing the
 *     bus's busy gate instead of racing a turn already on the session key.
 *
 * The bus is REAL (so completeTurn/onBreach behavior is exercised end-to-end);
 * the session layer is a mock OrchestrationSessionDeps driven by the test. The
 * event emitters are mocked so orchestration runs without Electron.
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
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { MessageBus, TurnCompletion } from '../../../../../src/main/apps/runtime/team/message-bus'
import { createOrchestration } from '../../../../../src/main/apps/runtime/team/orchestration'
import type { OrchestrationSessionDeps } from '../../../../../src/main/apps/runtime/team/orchestration'
import { buildTeamEntry } from '../../../../../src/main/apps/runtime/team/team-prompt'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/team-types'
import type { Team, TeamMember, TeamEpoch, TeamEdge } from '../../../../../src/main/apps/team/types'

// ============================================
// Fixtures
// ============================================

const TEAM_ID = 'team-1'
const LEAD_APP = 'app-lead'
const RESEARCHER_APP = 'app-researcher'
const TESTER_APP = 'app-tester'
const SPACE = 'space-a'

function seedTeam(
  store: TeamStore,
  opts?: { collabMode?: Team['collabMode']; escalationRouting?: Team['escalationRouting']; epochId?: string | null }
): void {
  const now = Date.now()
  const collabMode = opts?.collabMode ?? 'structured'
  const team: Team = {
    id: TEAM_ID,
    name: 'Research Team',
    owningSpaceId: SPACE,
    goal: 'Build a competitor brief',
    leadAppId: LEAD_APP,
    memberSourcing: 'manual',
    collabMode,
    escalationRouting: opts?.escalationRouting ?? 'user',
    status: 'idle',
    currentEpochId: opts?.epochId ?? null,
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
  if (collabMode === 'structured') {
    const edges: TeamEdge[] = [
      { teamId: TEAM_ID, fromAppId: LEAD_APP, toAppId: RESEARCHER_APP, sync: false },
      { teamId: TEAM_ID, fromAppId: LEAD_APP, toAppId: TESTER_APP, sync: false },
    ]
    store.replaceEdgesForTeam(TEAM_ID, edges)
  }
}

/**
 * A controllable mock session layer. Each sendAppChatMessage returns a Promise
 * the test resolves/rejects manually, so it can drive the four turn exits.
 */
function makeSession(options: { acceptMidTurn?: boolean } = {}) {
  const spaceByApp = new Map<string, string>([
    [LEAD_APP, SPACE],
    [RESEARCHER_APP, SPACE],
    [TESTER_APP, SPACE],
  ])
  const active = new Set<string>()
  const cleared: Array<{ appId: string; teamId: string }> = []
  // What was handed to a turn already running, in the form the member reads it.
  const injected: Array<{ sessionKey: string; message: string }> = []
  type Pending = {
    resolve: (finalMessage?: string | null) => void
    reject: (e: unknown) => void
    conversationId: string
    teamContext: any
  }
  const pendings: Pending[] = []

  const deps: OrchestrationSessionDeps = {
    sendAppChatMessage: vi.fn((req) => {
      active.add(req.conversationId)
      return new Promise<{ finalMessage: string | null }>((resolve, reject) => {
        pendings.push({
          conversationId: req.conversationId,
          teamContext: req.teamContext,
          resolve: (finalMessage: string | null = null) => {
            active.delete(req.conversationId)
            resolve({ finalMessage })
          },
          reject: (e) => {
            active.delete(req.conversationId)
            reject(e)
          },
        })
      })
    }),
    isSessionActive: (key) => active.has(key),
    // Off unless a test asks for it: without a live session there is nothing to
    // hand a message to, which is also how a remote member answers — so the
    // default keeps every other test on the mailbox path it was written for.
    injectIntoSession: (sessionKey, message) => {
      if (!options.acceptMidTurn || !active.has(sessionKey)) return false
      injected.push({ sessionKey, message })
      return true
    },
    closeTeamSession: vi.fn(async (appId, teamId, _epochId) => {
      cleared.push({ appId, teamId })
    }),
    getMemberSpaceId: (appId) => spaceByApp.get(appId) ?? null,
  }
  return { deps, pendings, cleared, active, injected }
}

// ============================================
// Setup
// ============================================

describe('TeamOrchestration', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let bus: MessageBus

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

  function build(
    session: OrchestrationSessionDeps,
    turnTimeoutMs?: number,
    maxConcurrentTurns?: number,
    renderDigest?: (teamId: string, epochId: string, viewerAppId: string) => string | null
  ) {
    bus = createMessageBus({
      store,
      hooks: {
        wakeTarget: (p) => orchestration.wakeTarget(p),
        isBusy: (k) => orchestration.isBusy(k),
        deliverMidTurn: (p) => orchestration.deliverMidTurn(p),
      },
    })
    const orchestration = createOrchestration({
      store, bus, session, turnTimeoutMs, maxConcurrentTurns,
      hasPendingEscalation: () => false,
      ...(renderDigest ? { renderDigest } : {}),
    })
    return orchestration
  }

  // ===========================================================================
  // Epoch lifecycle
  // ===========================================================================

  it('reuses a sealed conversation task when the same reception or direct channel returns', () => {
    seedTeam(store)
    const { deps } = makeSession()
    const orch = build(deps)
    const first = orch.ensureConversationEpoch(TEAM_ID, 'direct:researcher', 'Long-lived task')
    store.endEpoch(first.id, Date.now(), 'stopped', null)
    const returned = orch.ensureConversationEpoch(TEAM_ID, 'direct:researcher')
    expect(returned.id).toBe(first.id)
    expect(returned.workItem!.title).toBe('Long-lived task')
    expect(store.listEpochsByTeam(TEAM_ID)).toHaveLength(1)
  })

  it.each(['sealed', 'completed'] as const)('drops a buffered ending notice after its task is %s without preventing human resume', async state => {
    seedTeam(store)
    const { deps, active, pendings } = makeSession()
    const orch = build(deps)
    const epoch = orch.ensureConversationEpoch(TEAM_ID, 'native:buffered-report')
    const sessionKey = buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id)
    active.add(sessionKey)
    await bus.deliverRuntimeWake({
      envelope: { id: 'ending-notice', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP,
        toAppId: LEAD_APP, body: 'Researcher stopped', correlationId: 'ending-correlation', createdAt: Date.now() },
      trigger: { teamId: TEAM_ID, epochId: epoch.id, fromAppId: null, correlationId: 'ending-correlation', wait: false, kind: 'member_stopped' },
      onBusy: 'buffer',
    })
    expect(pendings).toHaveLength(0)
    if (state === 'sealed') store.endEpoch(epoch.id, Date.now(), 'completed', null)
    else store.updateWorkItem(epoch.id, { status: 'completed' })
    active.delete(sessionKey)
    bus.drainMailbox(sessionKey)
    await flush()
    expect(pendings).toHaveLength(0)
    if (state === 'sealed') expect(store.getEpochById(epoch.id)?.endedAt).not.toBeNull()
    else expect(store.getEpochById(epoch.id)?.workItem?.status).toBe('completed')
    orch.noteEpochTurn(TEAM_ID, epoch.id)
    await bus.deliverRuntimeWake({
      envelope: { id: 'human-resume', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP,
        toAppId: LEAD_APP, body: 'Continue please', correlationId: 'human-correlation', createdAt: Date.now() },
      trigger: { teamId: TEAM_ID, epochId: epoch.id, fromAppId: null, correlationId: 'human-correlation', wait: false, kind: 'human_message' },
      onBusy: 'buffer',
    })
    await flush()
    expect(pendings).toHaveLength(1)
    pendings[0].resolve('Continued')
    await flush()
  })

  describe('startEpoch', () => {
    it('creates an epoch row, sets team running + current_epoch, and wakes the lead once', async () => {
      seedTeam(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      const epoch = await orch.startEpoch(TEAM_ID)

      const team = store.getTeamById(TEAM_ID)!
      expect(team.status).toBe('running')
      expect(team.currentEpochId).toBe(epoch.id)
      expect(store.getCurrentEpochForTeam(TEAM_ID)?.id).toBe(epoch.id)

      // Exactly one wake — the lead's team session.
      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)
      expect(pendings).toHaveLength(1)
      expect(pendings[0].conversationId).toBe(buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id))
      expect(pendings[0].teamContext.fromAppId).toBeNull()
    })

    it('rejects starting a second epoch while one is open', async () => {
      seedTeam(store, { epochId: 'existing-epoch' })
      const { deps } = makeSession()
      const orch = build(deps)
      await expect(orch.startEpoch(TEAM_ID)).rejects.toThrow(/already has a running epoch/)
    })
  })

  describe('sealEpoch', () => {
    it('archives the epoch, retains tasks/findings, clears member sessions, and idles the team', async () => {
      seedTeam(store)
      const { deps, cleared } = makeSession()
      const orch = build(deps)
      const epoch = await orch.startEpoch(TEAM_ID)

      // Write a task + finding during the epoch (history must survive seal).
      store.insertTask({
        id: 't1', teamId: TEAM_ID, epochId: epoch.id, title: 'T1', assigneeAppId: RESEARCHER_APP,
        status: 'done', resultRef: 'out.md', note: null, parentId: null, createdByAppId: LEAD_APP,
        createdAt: Date.now(), updatedAt: Date.now(),
      })
      store.insertFinding({
        id: 'f1', teamId: TEAM_ID, epochId: epoch.id, authorAppId: RESEARCHER_APP,
        body: 'note', ref: null, createdAt: Date.now(),
      })

      await orch.sealEpoch(TEAM_ID, 'completed', 'all done')

      const sealed = store.getEpochById(epoch.id)!
      expect(sealed.endedAt).not.toBeNull()
      expect(sealed.endReason).toBe('completed')
      expect(sealed.summary).toBe('all done')

      // Tasks/findings retained for history.
      expect(store.listTasksByEpoch(TEAM_ID, epoch.id)).toHaveLength(1)
      expect(store.listFindingsByEpoch(TEAM_ID, epoch.id)).toHaveLength(1)

      // Every member's team session cleared.
      expect(cleared.map((c) => c.appId).sort()).toEqual([LEAD_APP, RESEARCHER_APP, TESTER_APP].sort())

      // Team normalized.
      const team = store.getTeamById(TEAM_ID)!
      expect(team.status).toBe('idle')
      expect(team.currentEpochId).toBeNull()
    })

    it('fires onRunStateChanged after seal so joiners learn the run rested (BUG 4)', async () => {
      // Auto-seal ends a run without going through pauseTeam; the observer must
      // still fire so joiner members learn the run rested.
      seedTeam(store)
      const { deps } = makeSession()
      const onRunStateChanged = vi.fn<[string], void>()
      bus = createMessageBus({
        store,
        hooks: { wakeTarget: (p) => orch.wakeTarget(p), isBusy: (k) => orch.isBusy(k) },
      })
      const orch = createOrchestration({ store, bus, session: deps, onRunStateChanged })
      const epoch = await orch.startEpoch(TEAM_ID)

      await orch.sealEpoch(TEAM_ID, 'completed', 'done')

      expect(store.getEpochById(epoch.id)?.endedAt).not.toBeNull()
      expect(onRunStateChanged).toHaveBeenCalledWith(TEAM_ID)
    })
  })

  // ===========================================================================
  // team_complete deferred seal
  // ===========================================================================

  describe('requestSeal (team_complete)', () => {
    it('completes a direct lead conversation without touching another task', async () => {
      seedTeam(store)
      const { deps, cleared } = makeSession()
      const orch = build(deps)
      const epoch = orch.ensureConversationEpoch(TEAM_ID, 'native:direct')
      const other = orch.ensureConversationEpoch(TEAM_ID, 'native:other')
      orch.requestSeal(TEAM_ID, epoch.id, 'direct work complete')
      orch.noteMemberTurnEnded({ teamId: TEAM_ID, epochId: epoch.id, appId: LEAD_APP })
      expect(cleared).toHaveLength(0)
      await new Promise<void>(resolve => setImmediate(resolve))
      await flush()
      expect(store.getEpochById(epoch.id)?.workItem?.status).toBe('completed')
      expect(store.getEpochById(epoch.id)?.endReason).toBe('completed')
      expect(store.getEpochById(other.id)?.endedAt).toBeNull()
      expect(store.getEpochById(other.id)?.workItem?.status).toBe('open')
      expect(cleared).toHaveLength(3)
    })

    it('does not consume the lead completion when a different member ends', async () => {
      seedTeam(store)
      const { deps, cleared } = makeSession()
      const orch = build(deps)
      const epoch = orch.ensureConversationEpoch(TEAM_ID, 'native:direct')
      orch.requestSeal(TEAM_ID, epoch.id, 'all done')
      orch.noteMemberTurnEnded({ teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(store.getEpochById(epoch.id)?.workItem?.status).toBe('open')
      expect(cleared).toHaveLength(0)
    })

    it('lets the bus completion consume its seal before the direct fallback', async () => {
      seedTeam(store)
      const { deps, pendings, cleared } = makeSession()
      const orch = build(deps)
      const epoch = await orch.startEpoch(TEAM_ID)
      const leadPending = pendings.find(p => p.conversationId === buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id))!
      const completeTurn = vi.spyOn(bus, 'completeTurn')
      orch.requestSeal(TEAM_ID, epoch.id, 'bus work complete')
      orch.noteMemberTurnEnded({ teamId: TEAM_ID, epochId: epoch.id, appId: LEAD_APP })
      leadPending.resolve('done')
      await new Promise<void>(resolve => setImmediate(resolve))
      await flush()
      expect(completeTurn).toHaveBeenCalledWith(expect.objectContaining({ sealPending: true }))
      expect(cleared).toHaveLength(3)
      expect(store.getEpochById(epoch.id)?.workItem?.status).toBe('completed')
    })

    it('waits for a deferred bus session result before sealing and discarding multiple queued messages', async () => {
      seedTeam(store, { collabMode: 'free' })
      const { deps, pendings, cleared } = makeSession()
      const orch = build(deps)
      const epoch = orch.ensureConversationEpoch(TEAM_ID, 'native:deferred')
      const receipt = bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: RESEARCHER_APP, to: 'lead', message: 'start', wait: true })
      await flush()
      const sessionKey = buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id)
      for (const message of ['queued one', 'queued two']) {
        await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: TESTER_APP, to: 'lead', message, wait: false })
      }
      orch.requestSeal(TEAM_ID, epoch.id, 'done')
      orch.noteMemberTurnEnded({ teamId: TEAM_ID, epochId: epoch.id, appId: LEAD_APP })
      // A session may notify its observer before asynchronous finalization resolves its caller.
      await new Promise<void>(resolve => setImmediate(resolve))
      await flush()
      expect(store.getEpochById(epoch.id)?.endedAt).toBeNull()
      expect(cleared).toHaveLength(0)
      expect(bus.isSessionOccupied(sessionKey)).toBe(true)
      pendings[0].resolve('final result')
      await expect(receipt).resolves.toMatchObject({ message: 'final result', status: 'ok' })
      await flush()
      expect(pendings).toHaveLength(1)
      expect(bus.hasBufferedMessages(epoch.id)).toBe(false)
      expect(store.getEpochById(epoch.id)?.endReason).toBe('completed')
    })

    it('discards every queued wake for an explicitly completed task', async () => {
      seedTeam(store, { collabMode: 'free' })
      const { deps, active, pendings } = makeSession()
      const orch = build(deps)
      const epoch = orch.ensureConversationEpoch(TEAM_ID, 'native:closed')
      const sessionKey = buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id)
      active.add(sessionKey)
      for (const message of ['queued one', 'queued two', 'queued three']) {
        await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: TESTER_APP, to: 'lead', message, wait: false })
      }
      store.updateWorkItem(epoch.id, { status: 'completed' })
      active.delete(sessionKey)
      bus.drainMailbox(sessionKey)
      await flush()
      expect(pendings).toHaveLength(0)
      expect(bus.hasBufferedMessages(epoch.id)).toBe(false)
      expect(bus.isSessionOccupied(sessionKey)).toBe(false)
      expect(store.getEpochById(epoch.id)?.workItem?.status).toBe('completed')
    })

    it('seals a direct conversation before its queued mailbox can start another turn', async () => {
      seedTeam(store)
      const { deps, active, pendings } = makeSession()
      const orch = build(deps)
      const epoch = orch.ensureConversationEpoch(TEAM_ID, 'native:direct')
      const sessionKey = buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id)
      active.add(sessionKey)
      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: RESEARCHER_APP, to: 'lead', message: 'queued report', wait: false })
      orch.requestSeal(TEAM_ID, epoch.id, 'done')
      orch.noteMemberTurnEnded({ teamId: TEAM_ID, epochId: epoch.id, appId: LEAD_APP })
      active.delete(sessionKey)
      setImmediate(() => bus.drainMailbox(sessionKey))
      await new Promise<void>(resolve => setImmediate(resolve))
      await flush()
      expect(pendings).toHaveLength(0)
      expect(store.getEpochById(epoch.id)?.endedAt).not.toBeNull()
      expect(bus.hasBufferedMessages(epoch.id)).toBe(false)
    })

    it('defers the seal until the lead turn ends, then seals as completed', async () => {
      seedTeam(store, { collabMode: 'free' })
      const { deps, pendings, cleared } = makeSession()
      const orch = build(deps)
      const epoch = await orch.startEpoch(TEAM_ID)

      // Lead turn is in flight. Lead calls team_complete → requestSeal. The seal
      // must NOT happen yet (it would abort the in-flight lead turn).
      orch.requestSeal(TEAM_ID, epoch.id, 'all done')
      expect(store.getTeamById(TEAM_ID)!.currentEpochId).toBe(epoch.id)
      expect(cleared).toHaveLength(0)

      // Lead turn ends → the deferred seal fires.
      const leadPending = pendings.find(
        (p) => p.conversationId === buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id)
      )!
      leadPending.resolve('winner declared')
      await flush()

      const team = store.getTeamById(TEAM_ID)!
      expect(team.status).toBe('idle')
      expect(team.currentEpochId).toBeNull()
      expect(store.getEpochById(epoch.id)?.endReason).toBe('completed')
      expect(store.getEpochById(epoch.id)?.summary).toBe('all done')
      expect(cleared.length).toBeGreaterThan(0)
    })
  })

  // ===========================================================================
  // Conversation epoch (IM-backed, long-lived) — never auto-sealed
  // ===========================================================================

  describe('ensureConversationEpoch', () => {
    const CHAT_A = 'wecom:chat-a'
    const CHAT_B = 'wecom:chat-b'

    it('creates a per-chat conversation epoch WITHOUT occupying currentEpochId', () => {
      seedTeam(store)
      const { deps } = makeSession()
      const orch = build(deps)

      const epoch = orch.ensureConversationEpoch(TEAM_ID, CHAT_A)

      expect(epoch.lifecycle).toBe('conversation')
      expect(epoch.chatKey).toBe(CHAT_A)
      // Conversation epochs do NOT take the single-run pointer, so scheduled runs
      // and other chats are never blocked.
      const team = store.getTeamById(TEAM_ID)!
      expect(team.currentEpochId).toBeNull()
      expect(team.status).toBe('idle')
      // No lead wake — the caller (dispatch) supplies the turn input.
      expect(deps.sendAppChatMessage).not.toHaveBeenCalled()
    })

    it('reuses the open epoch for the SAME chat', () => {
      seedTeam(store)
      const { deps } = makeSession()
      const orch = build(deps)

      const first = orch.ensureConversationEpoch(TEAM_ID, CHAT_A)
      const second = orch.ensureConversationEpoch(TEAM_ID, CHAT_A)
      expect(second.id).toBe(first.id)
      expect(store.listEpochsByTeam(TEAM_ID)).toHaveLength(1)
    })

    it('isolates DIFFERENT chats into independent epochs', () => {
      seedTeam(store)
      const { deps } = makeSession()
      const orch = build(deps)

      const a = orch.ensureConversationEpoch(TEAM_ID, CHAT_A)
      const b = orch.ensureConversationEpoch(TEAM_ID, CHAT_B)
      expect(b.id).not.toBe(a.id)
      expect(store.listEpochsByTeam(TEAM_ID)).toHaveLength(2)
      // And each is independently retrievable by its chat key.
      expect(store.getOpenConversationEpoch(TEAM_ID, CHAT_A)?.id).toBe(a.id)
      expect(store.getOpenConversationEpoch(TEAM_ID, CHAT_B)?.id).toBe(b.id)
    })

    it('sealConversationEpoch closes one chat without touching others', async () => {
      seedTeam(store)
      const { deps } = makeSession()
      const orch = build(deps)
      const a = orch.ensureConversationEpoch(TEAM_ID, CHAT_A)
      const b = orch.ensureConversationEpoch(TEAM_ID, CHAT_B)

      await orch.sealConversationEpoch(TEAM_ID, a.id)

      expect(store.getEpochById(a.id)?.endedAt).not.toBeNull()
      expect(store.getOpenConversationEpoch(TEAM_ID, CHAT_A)).toBeNull()
      // Chat B is untouched.
      expect(store.getEpochById(b.id)?.endedAt).toBeNull()
      expect(store.getOpenConversationEpoch(TEAM_ID, CHAT_B)?.id).toBe(b.id)
    })

    it('does NOT auto-seal on quiescence (stays open for the next message)', async () => {
      vi.useFakeTimers()
      try {
        seedTeam(store)
        const { deps, pendings } = makeSession()
        const orch = build(deps)
        const epoch = orch.ensureConversationEpoch(TEAM_ID, CHAT_A)

        // Drive one lead turn to completion → schedules a quiescence check.
        await orch.wakeTarget({
          sessionKey: buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id),
          appId: LEAD_APP,
          teamId: TEAM_ID,
          epochId: epoch.id,
          envelope: { id: 'e1', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, toAppId: LEAD_APP, body: 'hi', correlationId: 'c1', createdAt: Date.now() },
          trigger: { teamId: TEAM_ID, epochId: epoch.id, correlationId: 'c1', fromAppId: null, wait: false, kind: 'run_start' },
        })
        pendings[0].resolve('replied; awaiting next message')

        // Past two quiescence windows (nudge + would-be auto-seal).
        await vi.advanceTimersByTimeAsync(12_000)

        // Conversation epochs are never auto-sealed — only the initial wake
        // happened, and the epoch is still open.
        expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)
        expect(store.getEpochById(epoch.id)?.endedAt).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('a run epoch under the same idle conditions DOES nudge (quiescence active)', async () => {
      vi.useFakeTimers()
      try {
        seedTeam(store)
        const { deps, pendings } = makeSession()
        const orch = build(deps)
        const epoch = makeEpoch(store) // lifecycle 'run'

        await orch.wakeTarget({
          sessionKey: buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id),
          appId: LEAD_APP,
          teamId: TEAM_ID,
          epochId: epoch.id,
          envelope: { id: 'e1', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, toAppId: LEAD_APP, body: 'hi', correlationId: 'c1', createdAt: Date.now() },
          trigger: { teamId: TEAM_ID, epochId: epoch.id, correlationId: 'c1', fromAppId: null, wait: false, kind: 'run_start' },
        })
        pendings[0].resolve('done')

        await vi.advanceTimersByTimeAsync(6_000)

        // Run epochs nudge the lead on quiescence → a second wake occurs.
        expect((deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // Reversible seal — a hibernated epoch wakes on re-engagement
  // ===========================================================================

  describe('noteEpochTurn', () => {
    it('wakes a sealed RUN epoch: clears end stamp, restores currentEpochId + running', async () => {
      seedTeam(store)
      const { deps } = makeSession()
      const orch = build(deps)
      const epoch = await orch.startEpoch(TEAM_ID)
      await orch.sealEpoch(TEAM_ID, 'completed', 'done')

      // Sealed: archived + team idle.
      expect(store.getEpochById(epoch.id)?.endedAt).not.toBeNull()
      expect(store.getTeamById(TEAM_ID)?.currentEpochId).toBeNull()
      expect(store.getTeamById(TEAM_ID)?.status).toBe('idle')

      orch.noteEpochTurn(TEAM_ID, epoch.id)

      // Woken: open again, pointer + status restored, summary kept as last snapshot.
      const woken = store.getEpochById(epoch.id)!
      expect(woken.endedAt).toBeNull()
      expect(woken.endReason).toBeNull()
      expect(woken.summary).toBe('done')
      expect(store.getTeamById(TEAM_ID)?.currentEpochId).toBe(epoch.id)
      expect(store.getTeamById(TEAM_ID)?.status).toBe('running')
    })

    it('is a no-op for an already-open epoch', async () => {
      seedTeam(store)
      const { deps } = makeSession()
      const orch = build(deps)
      const epoch = await orch.startEpoch(TEAM_ID)

      orch.noteEpochTurn(TEAM_ID, epoch.id)
      expect(store.getEpochById(epoch.id)?.endedAt).toBeNull()
      expect(store.getTeamById(TEAM_ID)?.currentEpochId).toBe(epoch.id)
    })

    it('wakes a sealed CONVERSATION epoch without taking currentEpochId', async () => {
      seedTeam(store)
      const { deps } = makeSession()
      const orch = build(deps)
      const epoch = orch.ensureConversationEpoch(TEAM_ID, 'wecom:chat-a')
      await orch.sealConversationEpoch(TEAM_ID, epoch.id)
      expect(store.getEpochById(epoch.id)?.endedAt).not.toBeNull()

      orch.noteEpochTurn(TEAM_ID, epoch.id)

      expect(store.getEpochById(epoch.id)?.endedAt).toBeNull()
      // Conversation epochs never occupy the single-run pointer.
      expect(store.getTeamById(TEAM_ID)?.currentEpochId).toBeNull()
    })

    it('after reactivation, a member completion routes back (not dropped)', async () => {
      seedTeam(store, { collabMode: 'free' })
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const epoch = await orch.startEpoch(TEAM_ID)
      await orch.sealEpoch(TEAM_ID, 'completed', 'first run done')

      // Re-engage: wake the epoch, then the lead delegates wait=true to a member.
      orch.noteEpochTurn(TEAM_ID, epoch.id)
      const pending = bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'still there?', wait: true })
      await flush()
      const memberWake = pendings.find((p) => p.conversationId === buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      expect(memberWake).toBeTruthy()
      memberWake!.resolve('yep, still here')

      const result = await pending
      expect(result).toEqual({ from: 'researcher', message: 'yep, still here', status: 'ok' })
    })
  })

  // ===========================================================================
  // Completion detection — the four turn exits
  // ===========================================================================

  describe('inbound message rendering', () => {
    it('a teammate send arrives under a "[Team message from …]" header', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      const req = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(req.message).toBe('[Team message from lead]\n\ngo')
      pendings[0].resolve('done')
      await flush()
    })

    it('the board digest rides along without touching the message itself', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      build(deps, undefined, undefined, () => '---\nBoard — recorded since you last looked:\n- lead shared "brief.md"')

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'HELLO-FROM-ALICE', wait: false })
      const req = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
      // The instruction the teammate must act on stays intact and stays FIRST;
      // the digest is an appendix, never a replacement.
      expect(req.message).toContain('[Team message from lead]\n\nHELLO-FROM-ALICE')
      expect(req.message).toContain('Board — recorded since you last looked')
      expect(req.message.indexOf('HELLO-FROM-ALICE')).toBeLessThan(req.message.indexOf('Board —'))
      pendings[0].resolve('done')
      await flush()
    })

    it('a person talking to their own digital human gets no team bookkeeping', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      build(deps, undefined, undefined, () => '---\nBoard — recorded since you last looked:\n- lead shared "brief.md"')

      const sent = bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: null, to: 'researcher',
        message: 'how is it going?', wait: true,
      })
      await flush()
      const req = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(req.message).toBe('how is it going?')
      pendings[0].resolve('fine')
      await sent
    })

    it('a HUMAN 1:1 send arrives verbatim — no impersonated teammate header', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      build(deps)

      // A person has no member identity, so the send carries none; the member
      // must receive the person's words as-is, framed as nobody's teammate.
      const sent = bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: null, to: 'researcher',
        message: '最近什么时候团建？', wait: true,
      })
      await flush()
      const req = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(req.message).toBe('最近什么时候团建？')
      expect(req.message).not.toContain('[Team message from')
      expect(req.teamContext).toMatchObject({ fromAppId: null, kind: 'human_message' })
      pendings[0].resolve('下周五')
      await flush()
      await expect(sent).resolves.toMatchObject({ status: 'ok', message: '下周五' })
    })

    it('states how long a message waited, once it has waited long enough to matter', async () => {
      // A message drained from the mailbox was written against a situation that
      // has since moved on. Read without its age it looks exactly like a fresh
      // instruction, which is how a member ends up acting on an order its sender
      // has already replaced.
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      build(deps)

      const researcherSession = buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id)
      // Occupy the researcher with a turn nothing can be handed into, so the
      // next message takes the mailbox.
      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'first', wait: false })
      await flush()

      const realNow = Date.now
      try {
        await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'stale order', wait: false })
        // The message sat in the mailbox for twenty minutes before its turn came.
        Date.now = () => realNow() + 20 * 60_000
        pendings[0].resolve('done')
        await flush()
        bus.drainMailbox(researcherSession)
        await flush()
      } finally {
        Date.now = realNow
      }

      const drained = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0].message as string)
        .find((m) => m.includes('stale order'))
      expect(drained).toBe('[Team message from lead — sent 20 minutes ago]\n\nstale order')
    })
  })

  // ===========================================================================
  // Mid-turn delivery — what the member actually reads
  // ===========================================================================

  describe('mid-turn delivery', () => {
    it('hands a teammate message to the running turn, marked as having arrived mid-work', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings, injected } = makeSession({ acceptMidTurn: true })
      build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'do T1', wait: false })
      await flush()
      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)

      const second = await bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher',
        message: 'stop, the plan changed', wait: false,
      })

      expect('messageId' in second && second.delivery).toBe('mid_turn')
      // No second turn was started, and nothing was left queued.
      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)
      expect(bus.hasBufferedMessages(epoch.id)).toBe(false)

      expect(injected).toHaveLength(1)
      expect(injected[0].sessionKey).toBe(buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      // Who sent it, what they are to this team, and — the point of the whole
      // path — that it landed beside work already in progress.
      expect(injected[0].message).toBe(
        '[Arrived while you were working — from lead (lead)]\n\nstop, the plan changed'
      )

      pendings[0].resolve('done')
      await flush()
    })

    it('names a non-lead sender as a teammate', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings, injected } = makeSession({ acceptMidTurn: true })
      build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'do T1', wait: false })
      await flush()
      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: TESTER_APP, to: 'researcher', message: 'my data is ready', wait: false })

      expect(injected[0].message).toBe(
        '[Arrived while you were working — from tester (teammate)]\n\nmy data is ready'
      )
      pendings[0].resolve('done')
      await flush()
    })

    it('carries no board digest — that belongs at the start of a turn, not inside one', async () => {
      // The digest answers "what changed since you last looked". Mid-turn it is
      // a page of unrelated context dropped into live reasoning, and reading it
      // here would advance the member's watermark past facts it may never see.
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings, injected } = makeSession({ acceptMidTurn: true })
      const digest = vi.fn(() => '---\nBoard — recorded since you last looked:\n- lead shared "brief.md"')
      build(deps, undefined, undefined, digest)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'do T1', wait: false })
      await flush()
      const digestCallsAfterWake = digest.mock.calls.length

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'also this', wait: false })

      expect(injected[0].message).not.toContain('Board —')
      // Not merely omitted from the text: never asked for, so no watermark moved.
      expect(digest.mock.calls.length).toBe(digestCallsAfterWake)
      pendings[0].resolve('done')
      await flush()
    })

    it("keeps a person's words verbatim, exactly as typing into the same chat does", async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings, injected } = makeSession({ acceptMidTurn: true })
      build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'do T1', wait: false })
      await flush()

      const sent = bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: null, to: 'researcher',
        message: 'hold on a second', wait: true,
      })

      expect(injected[0].message).toBe('hold on a second')
      // Delivered, but it started no turn — so the receipt says exactly that
      // rather than waiting for a completion that answers something else.
      await expect(sent).resolves.toMatchObject({ status: 'mid_turn' })
      pendings[0].resolve('done')
      await flush()
    })

    it('falls back to the mailbox when there is no live session to hand it to', async () => {
      // How a member owned by ANOTHER machine answers: its turn runs there, so
      // nothing here can reach into it. The message must not be lost for it.
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings, injected } = makeSession({ acceptMidTurn: false })
      build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'do T1', wait: false })
      await flush()

      const second = await bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'and this', wait: false,
      })

      expect(injected).toHaveLength(0)
      expect('messageId' in second && second.delivery).toBe('queued')
      expect(bus.hasBufferedMessages(epoch.id)).toBe(true)
      pendings[0].resolve('done')
      await flush()
    })

    it('the turn it joined still completes normally, against its own trigger', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession({ acceptMidTurn: true })
      build(deps)
      const completeTurn = spyCompleteTurn(bus)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'do T1', wait: false })
      await flush()
      const firstTrigger = pendings[0].teamContext

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'and this', wait: false })
      pendings[0].resolve('done')
      await flush()

      // Exactly one completion, carrying the trigger of the turn that ran — the
      // mid-turn message started nothing and completes nothing.
      expect(completeTurn).toHaveBeenCalledTimes(1)
      expect(completeTurn.mock.calls[0][0].trigger.correlationId).toBe(firstTrigger.correlationId)
    })
  })

  describe('completion detection', () => {
    it('clean stream end → result completion carrying the final message + taskId', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const completeTurn = spyCompleteTurn(bus)

      // Lead sends async to researcher (with a task ref) → researcher turn starts.
      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false, taskRef: 'task-x' })
      // Researcher's turn ends with a final message (the RESULT — no report needed).
      pendings[0].resolve('T1 done: competitors.md')
      await flush()

      const outcome = lastOutcome(completeTurn, buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      expect(outcome).toMatchObject({ kind: 'result', content: 'T1 done: competitors.md', taskId: 'task-x' })
    })

    it('captured escalation → escalation completion (report only carries escalation)', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const completeTurn = spyCompleteTurn(bus)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      // The member escalates during its turn (report-tool captures escalation only).
      const corr = pendings[0].teamContext.correlationId
      orch.captureReport(corr, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve('ignored final text')
      await flush()

      const outcome = lastOutcome(completeTurn, buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      expect(outcome).toMatchObject({ kind: 'escalation', content: 'need a decision' })
    })

    it('session throw → error completion', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const completeTurn = spyCompleteTurn(bus)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      pendings[0].reject(new Error('session blew up'))
      await flush()

      const outcome = lastOutcome(completeTurn, buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      expect(outcome?.kind).toBe('error')
      expect((outcome as any).message).toContain('session blew up')
    })

    it('timeout → timeout completion', async () => {
      vi.useFakeTimers()
      try {
        seedTeam(store, { collabMode: 'free' })
        const epoch = makeEpoch(store)
        const { deps } = makeSession()
        const orch = build(deps, 1000)
        const completeTurn = spyCompleteTurn(bus)

        // Never resolve the pending turn → the timeout wrapper trips.
        await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
        await vi.advanceTimersByTimeAsync(1001)

        const outcome = lastOutcome(completeTurn, buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
        expect(outcome?.kind).toBe('timeout')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // Concurrency gate (B-10): bounds turns running at once on this machine.
  // ===========================================================================

  describe('concurrency gate', () => {
    it('queues a turn past the cap and dispatches it once a slot frees', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps, undefined, 1)

      // Two turns started back to back; the cap of 1 means only the first
      // actually reaches the session layer — the second stays queued.
      const wake = (appId: string, corr: string) =>
        orch.wakeTarget({
          sessionKey: buildTeamSessionKey(appId, TEAM_ID, epoch.id),
          appId,
          teamId: TEAM_ID,
          epochId: epoch.id,
          envelope: { id: corr, teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, toAppId: appId, body: 'go', correlationId: corr, createdAt: Date.now() },
          trigger: { teamId: TEAM_ID, epochId: epoch.id, correlationId: corr, fromAppId: LEAD_APP, wait: false, kind: 'message' },
        })

      await wake(RESEARCHER_APP, 'c1')
      await wake(TESTER_APP, 'c2')
      await flush()

      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)
      expect(pendings).toHaveLength(1)
      expect(pendings[0].conversationId).toBe(buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))

      // Freeing the first slot lets the queued second turn dispatch.
      pendings[0].resolve('done')
      await flush()

      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(2)
      expect(pendings.some((p) => p.conversationId === buildTeamSessionKey(TESTER_APP, TEAM_ID, epoch.id))).toBe(true)
    })

    it('rechecks task closure after waiting for a global concurrency slot', async () => {
      seedTeam(store, { collabMode: 'free' })
      const { deps, pendings } = makeSession()
      const orch = build(deps, undefined, 1)
      const first = orch.ensureConversationEpoch(TEAM_ID, 'native:holding-slot')
      const second = orch.ensureConversationEpoch(TEAM_ID, 'native:waiting-slot')
      await bus.send({ teamId: TEAM_ID, epochId: first.id, fromAppId: LEAD_APP, to: 'researcher', message: 'work', wait: false })
      await bus.send({ teamId: TEAM_ID, epochId: second.id, fromAppId: LEAD_APP, to: 'tester', message: 'work', wait: false })
      await flush()
      expect(pendings).toHaveLength(1)
      store.updateWorkItem(second.id, { status: 'completed' })
      pendings[0].resolve('done')
      await flush()
      expect(pendings).toHaveLength(1)
      expect(bus.isSessionOccupied(buildTeamSessionKey(TESTER_APP, TEAM_ID, second.id))).toBe(false)
      expect(store.getEpochById(second.id)?.workItem?.status).toBe('completed')
    })

    it('a turn that times out while still queued never reaches the session layer', async () => {
      vi.useFakeTimers()
      try {
        seedTeam(store, { collabMode: 'free' })
        const epoch = makeEpoch(store)
        const { deps, pendings } = makeSession()
        // Cap of 1, held by the first (never-resolving) turn; the second times
        // out at 1000ms while still waiting for a slot.
        const orch = build(deps, 1000, 1)
        const completeTurn = spyCompleteTurn(bus)

        await orch.wakeTarget({
          sessionKey: buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id),
          appId: RESEARCHER_APP,
          teamId: TEAM_ID,
          epochId: epoch.id,
          envelope: { id: 'c1', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, toAppId: RESEARCHER_APP, body: 'go', correlationId: 'c1', createdAt: Date.now() },
          trigger: { teamId: TEAM_ID, epochId: epoch.id, correlationId: 'c1', fromAppId: LEAD_APP, wait: false, kind: 'message' },
        })
        await orch.wakeTarget({
          sessionKey: buildTeamSessionKey(TESTER_APP, TEAM_ID, epoch.id),
          appId: TESTER_APP,
          teamId: TEAM_ID,
          epochId: epoch.id,
          envelope: { id: 'c2', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, toAppId: TESTER_APP, body: 'go', correlationId: 'c2', createdAt: Date.now() },
          trigger: { teamId: TEAM_ID, epochId: epoch.id, correlationId: 'c2', fromAppId: LEAD_APP, wait: false, kind: 'message' },
        })

        expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(1001)

        const outcome = lastOutcome(completeTurn, buildTeamSessionKey(TESTER_APP, TEAM_ID, epoch.id))
        expect(outcome?.kind).toBe('timeout')
        // Still queued behind the held slot — never actually dispatched.
        expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // Escalation routing
  // ===========================================================================

  describe('escalation routing', () => {
    it("escalationRouting='lead' never re-routes the question — it only shapes the prompt", async () => {
      // The preference tells a member to try its lead first; it must not take a
      // question the member addressed to a person and hand it to the lead. That
      // left both of them answering while the member had stopped waiting.
      seedTeam(store, { collabMode: 'free', escalationRouting: 'lead' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      // Lead dispatches to researcher.
      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      // Researcher escalates.
      const corr = pendings[0].teamContext.correlationId
      orch.captureReport(corr, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve()
      await flush()

      const leadWake = pendings.find((p) => p.conversationId === buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id))
      expect(leadWake).toBeUndefined()
      // …and the person is the one shown as owing an answer, on every board.
      expect(orch.getMemberStatus(RESEARCHER_APP)).toBe('waiting_user')
    })

    it("escalationRouting='user' flips the team to waiting_user and marks the member", async () => {
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      const corr = pendings[0].teamContext.correlationId
      orch.captureReport(corr, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve()
      await flush()

      // The team surfaces the pending decision; the escalating member reads as waiting_user.
      expect(store.getTeamById(TEAM_ID)!.status).toBe('waiting_user')
      expect(orch.getMemberStatus(RESEARCHER_APP)).toBe('waiting_user')
    })

    it('resumeFromEscalation clears waiting, wakes the member, and routes completion to the lead', async () => {
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      const corr = pendings[0].teamContext.correlationId
      orch.captureReport(corr, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve()
      await flush()
      expect(store.getTeamById(TEAM_ID)!.status).toBe('waiting_user')

      const before = pendings.length
      const ok = await orch.resumeFromEscalation({ teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, response: 'skip it' })
      expect(ok).toBe(true)
      await flush()

      // Team back to running; the member is woken again with the decision, and its
      // completion is addressed to the lead so coordination resumes.
      expect(store.getTeamById(TEAM_ID)!.status).toBe('running')
      const resumeWake = pendings.slice(before).find((p) => p.conversationId === buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      expect(resumeWake).toBeTruthy()
      expect(resumeWake!.teamContext.fromAppId).toBe(LEAD_APP)
      expect(orch.getMemberStatus(RESEARCHER_APP)).toBe('working')
    })

    it('restores the escalating turn\u2019s external origin on the resume wake', async () => {
      // The sticky origin map does not survive a restart; the resume trigger is
      // rebuilt from the persisted escalation record, so the flag must travel
      // through resumeFromEscalation or the resumed turn runs permissive.
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      orch.captureReport(pendings[0].teamContext.correlationId, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve()
      await flush()

      const before = pendings.length
      const ok = await orch.resumeFromEscalation({
        teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, response: 'skip it', external: true,
      })
      expect(ok).toBe(true)
      await flush()

      const resumeWake = pendings.slice(before).find((p) => p.conversationId === buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      expect(resumeWake).toBeTruthy()
      expect(resumeWake!.teamContext.external).toBe(true)
    })

    it('leaves a local escalation\u2019s resume wake unstamped', async () => {
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      orch.captureReport(pendings[0].teamContext.correlationId, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve()
      await flush()

      const before = pendings.length
      expect(await orch.resumeFromEscalation({
        teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, response: 'skip it',
      })).toBe(true)
      await flush()

      const resumeWake = pendings.slice(before).find((p) => p.conversationId === buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))
      expect(resumeWake!.teamContext.external).toBeUndefined()
    })

    it('the resume wake quotes the question it answers', async () => {
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      orch.captureReport(pendings[0].teamContext.correlationId, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve()
      await flush()

      orch.resumeFromEscalation({
        teamId: TEAM_ID,
        epochId: epoch.id,
        appId: RESEARCHER_APP,
        response: 'use the staging account',
        question: 'Which test account\n\nshould I use?',
      })
      await flush()

      // A member can owe several answers at once and they return in whatever
      // order the person works through them: unquoted, an answer binds to the
      // wrong question.
      const calls = (deps.sendAppChatMessage as any).mock.calls
      const body = calls[calls.length - 1][0].message as string
      expect(body).toContain('You asked: "Which test account should I use?"')
      expect(body).toContain('use the staging account')
    })

    it('a turn ending with a seal pending starts nothing new from the mailbox', async () => {
      // The bug this pins: `completeTurn`'s last act is draining the mailbox,
      // and the caller learns three statements later that this epoch is about
      // to be sealed. The drained envelope therefore started a turn that the
      // seal — arriving a millisecond behind it — tore down while it was still
      // building its session. What that produced was worse than either outcome
      // on its own: a turn that reached no model (0 tokens), a message neither
      // delivered nor cleanly dropped, and a sealed epoch woken back to life by
      // its own doomed turn, so a finished run read as still running forever.
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      // The lead is mid-turn; a teammate's message queues behind it.
      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: RESEARCHER_APP, to: 'lead', message: 'first', wait: false })
      await flush()
      const dispatchesBefore = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls.length

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: TESTER_APP, to: 'lead', message: 'queued behind it', wait: false })
      expect(bus.hasBufferedMessages(epoch.id)).toBe(true)

      // The lead calls team_complete during that turn, so the seal is deferred
      // to its end — the exact ordering that produced the defect.
      orch.requestSeal(TEAM_ID, epoch.id, 'done')
      pendings[pendings.length - 1].resolve('wrapping up')
      await flush()

      // Nothing new was started on a session that is being torn down.
      expect((deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(dispatchesBefore)
      // And the envelope was not left stranded either: the seal discards it,
      // counted rather than silent (`resetEpoch`).
      expect(bus.hasBufferedMessages(epoch.id)).toBe(false)
      expect(store.getEpochById(epoch.id)?.endedAt).not.toBeNull()
    })

    it('a turn ending with NO seal pending still drains the mailbox', async () => {
      // The guard must key on this epoch ending, not on "a turn ended" — or the
      // fix would silently strand every queued message behind every turn.
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: RESEARCHER_APP, to: 'lead', message: 'first', wait: false })
      await flush()
      const dispatchesBefore = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls.length

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: TESTER_APP, to: 'lead', message: 'queued behind it', wait: false })
      pendings[pendings.length - 1].resolve('done')
      await flush()

      expect((deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(dispatchesBefore + 1)
    })

    it('resumeFromEscalation returns false when the epoch is gone (no solo fallback)', async () => {
      seedTeam(store, { escalationRouting: 'user' })
      const { deps } = makeSession()
      const orch = build(deps)
      const ok = await orch.resumeFromEscalation({ teamId: TEAM_ID, epochId: 'missing', appId: RESEARCHER_APP, response: 'x' })
      expect(ok).toBe(false)
    })
  })

  // ===========================================================================
  // Member status pulse (turns the bus did not run)
  // ===========================================================================

  describe('noteMemberStatusChanged', () => {
    it('announces every edge to the federation egress and one coalesced push to viewers', () => {
      seedTeam(store)
      const { deps } = makeSession()
      const observed: string[] = []
      bus = createMessageBus({
        store,
        hooks: { wakeTarget: (p) => orch.wakeTarget(p), isBusy: (k) => orch.isBusy(k) },
      })
      const orch = createOrchestration({
        store,
        bus,
        session: deps,
        onMemberStatusChanged: (teamId) => observed.push(teamId),
      })
      sendToRenderer.mockClear()
      broadcastToAll.mockClear()

      vi.useFakeTimers()
      try {
        // A member's status is derived, never stored, so a turn run outside the
        // bus (a person's 1:1 chat, an IM turn) reaches viewers only through this
        // seam. Both its edges land inside one coalescing window.
        orch.noteMemberStatusChanged(TEAM_ID)
        orch.noteMemberStatusChanged(TEAM_ID)

        // The federation egress needs every edge (it throttles on its own side).
        expect(observed).toEqual([TEAM_ID, TEAM_ID])
        // The viewer push is coalesced, so a chatty team cannot storm the UI.
        expect(sendToRenderer).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1000)
        const pushed = sendToRenderer.mock.calls.filter(([channel]) => channel === 'team:updated')
        expect(pushed).toHaveLength(1)
        expect(pushed[0][1]).toMatchObject({ teamId: TEAM_ID })
        expect(broadcastToAll.mock.calls.filter(([channel]) => channel === 'team:updated')).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // Circuit breach → escalate + seal
  // ===========================================================================

  describe('circuit breach', () => {
    it('on breach, escalates to the user and seals the epoch', async () => {
      seedTeam(store, { collabMode: 'free' })
      const { deps, pendings, cleared } = makeSession()
      // Tight message cap so the second send trips the breaker.
      bus = createMessageBus({
        store,
        hooks: { wakeTarget: (p) => orch.wakeTarget(p), isBusy: (k) => orch.isBusy(k) },
        circuitOverrides: { maxMessages: 1 },
      })
      const orch = createOrchestration({ store, bus, session: deps })
      const epoch = await orch.startEpoch(TEAM_ID)
      // The lead-start wake consumed one message slot? No — startEpoch wakes via
      // wakeTarget directly (not bus.send), so the counter is still 0. Drive two
      // real sends to trip the cap.
      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: '1', wait: false })
      await expect(
        bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: '2', wait: false })
      ).rejects.toThrow()
      await flush()

      // Breach handler escalated to the user (broadcast) and sealed the epoch.
      expect(broadcastToAll).toHaveBeenCalledWith('app:escalation:new', expect.objectContaining({ teamId: TEAM_ID, system: true }))
      const team = store.getTeamById(TEAM_ID)!
      expect(team.status).toBe('idle')
      expect(team.currentEpochId).toBeNull()
      expect(store.getEpochById(epoch.id)?.endReason).toBe('error')
      expect(cleared.length).toBeGreaterThan(0)
      void pendings
    })
  })

  // ===========================================================================
  // Prompt context projection
  // ===========================================================================

  describe('buildPromptContext', () => {
    it('projects roster with topology contactability, per member', () => {
      seedTeam(store, { collabMode: 'structured' })
      const { deps } = makeSession()
      const orch = build(deps)

      const ctx = orch.buildPromptContext(TEAM_ID, RESEARCHER_APP)!
      expect(ctx.selfMemberName).toBe('researcher')
      expect(ctx.collabMode).toBe('structured')
      // researcher has no outgoing edges → nobody contactable in structured mode.
      expect(ctx.roster.every((m) => m.contactable === false)).toBe(true)

      // The lead, by contrast, may contact researcher + tester.
      const leadCtx = orch.buildPromptContext(TEAM_ID, LEAD_APP)!
      const contactable = leadCtx.roster.filter((m) => m.contactable).map((m) => m.memberName).sort()
      expect(contactable).toEqual(['researcher', 'tester'])
    })
  })

  describe('getObservableStatus', () => {
    it('reports an office as running while a member serves a turn outside a run', async () => {
      // The reported symptom: a conversation turn is not a run, so the stored
      // status stayed idle while that member's avatar was visibly working.
      seedTeam(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const epoch = orch.ensureConversationEpoch(TEAM_ID, 'direct:researcher', 'Side chat')

      expect(store.getTeamById(TEAM_ID)!.status).toBe('idle')
      expect(orch.getObservableStatus(TEAM_ID)).toBe('idle')

      const receipt = bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP,
        to: 'researcher', message: 'take a look', wait: false,
      })
      await flush()
      expect(bus.isSessionOccupied(buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epoch.id))).toBe(true)
      expect(orch.getObservableStatus(TEAM_ID)).toBe('running')
      // Still stored as idle — the office never started a run of its own.
      expect(store.getTeamById(TEAM_ID)!.status).toBe('idle')

      pendings[0].resolve('done')
      await receipt
      await flush()
      expect(orch.getObservableStatus(TEAM_ID)).toBe('idle')
    })

    it('never overrides a stored status that says more than idle', () => {
      seedTeam(store)
      store.updateTeamStatus(TEAM_ID, 'waiting_user')
      const { deps } = makeSession()
      const orch = build(deps)
      // A decision owed is something a live read cannot see, so it must win.
      expect(orch.getObservableStatus(TEAM_ID)).toBe('waiting_user')
    })
  })

  // ===========================================================================
  // System prompt stability. The team Entry is frozen into the agent session's
  // reuse fingerprint: a per-turn difference rebuilds the CC subprocess every
  // turn, aborting whichever turn is still streaming.
  // ===========================================================================

  describe('team Entry stability across turns', () => {
    it('is byte-identical for consecutive turns with different senders', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const researcherEntry = () => buildTeamEntry(orch.buildPromptContext(TEAM_ID, RESEARCHER_APP)!)

      // Turn 1: the lead sends.
      await bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go',
      })
      await flush()
      const firstEntry = researcherEntry()
      const firstMessage = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].message
      pendings[0].resolve('done')
      await flush()

      // Turn 2: a periodic check — a different sender (none at all). A one-shot
      // check queues rather than skipping, which is what a check set for a
      // specific moment needs; the recurring kind passes 'skip'.
      await orch.wakeForCheck({
        teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, body: '[Periodic check] look', onBusy: 'buffer',
      })
      await flush()

      expect(researcherEntry()).toBe(firstEntry)
      // Who started the turn did not disappear — it moved into the turn input.
      expect(firstEntry).not.toContain('This turn was started by')
      expect(firstMessage).toContain('[Team message from lead]')
      expect(firstMessage).toContain('go')
      // No header may promise that ending the turn delivers anything: replying is
      // an explicit team_send, and a header saying otherwise teaches members to
      // sign off AT a colleague instead of answering them.
      expect(firstMessage).not.toContain('awaiting your reply')
      expect(firstMessage).not.toContain('automatically delivered')
    })
  })

  // ===========================================================================
  // Runtime-originated wakes share the bus's busy gate. Starting a second turn
  // on a session key that already has one tears down the live subprocess.
  // ===========================================================================

  describe('runtime wakes vs a busy session', () => {
    /** Put the researcher mid-turn and return its session key. */
    async function startResearcherTurn(epochId: string): Promise<string> {
      await bus.send({
        teamId: TEAM_ID, epochId, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false,
      })
      await flush()
      return buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, epochId)
    }

    it('defers a durable answer without putting it in a transient mailbox, then acknowledges its own turn', async () => {
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings, injected } = makeSession({ acceptMidTurn: true })
      const orch = build(deps)
      await startResearcherTurn(epoch.id)
      const onDeferred = vi.fn()
      const onStarted = vi.fn()
      const onSettled = vi.fn()
      const params = { teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, response: 'go ahead',
        continuationId: 'saved-answer', onDeferred, onStarted, onSettled }
      expect(await orch.resumeFromEscalation(params)).toBe(true)
      expect(onDeferred).toHaveBeenCalledTimes(1)
      expect(onStarted).not.toHaveBeenCalled()
      expect(injected).toHaveLength(0)
      expect(bus.hasBufferedMessages(epoch.id)).toBe(false)
      pendings[0].resolve('done')
      await flush()
      await orch.resumeFromEscalation(params)
      await flush()
      expect(onStarted).toHaveBeenCalledTimes(1)
      await orch.resumeFromEscalation(params)
      const answerTurn = pendings.find(p => p.teamContext.correlationId === 'decision:saved-answer')!
      expect(answerTurn).toBeTruthy()
      answerTurn.resolve('continued')
      await flush()
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled).toHaveBeenCalledWith(undefined)
    })

    it('buffers an escalation resume and delivers it when the current turn ends', async () => {
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const researcherKey = await startResearcherTurn(epoch.id)
      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)

      const ok = await orch.resumeFromEscalation({
        teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, response: 'go ahead',
      })
      await flush()

      // Accepted, but NOT started concurrently on the occupied session.
      expect(ok).toBe(true)
      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)

      // The occupying turn ends → the buffered resume is delivered.
      pendings[0].resolve('done')
      await flush()

      const resumed = pendings.slice(1).find((p) => p.conversationId === researcherKey)
      expect(resumed).toBeTruthy()
      const resumedMessage = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls
        .find((c) => c[0].conversationId === researcherKey && c[0].message.includes('answered your question'))
      expect(resumedMessage).toBeTruthy()
    })

    it('drops a due periodic check on a busy member when the caller says skip', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const researcherKey = await startResearcherTurn(epoch.id)

      await orch.wakeForCheck({
        teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, body: '[Periodic check] look',
        onBusy: 'skip',
      })
      await flush()
      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)

      // Dropped, not queued: the turn ending must not release a stale round.
      pendings[0].resolve('done')
      await flush()
      expect(pendings.slice(1).some((p) => p.conversationId === researcherKey)).toBe(false)
    })

    it('queues a due periodic check on a busy member when the caller says queue', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)
      const researcherKey = await startResearcherTurn(epoch.id)

      // What a one-shot needs: there is no next round, so a busy moment must
      // not be the end of it.
      await orch.wakeForCheck({
        teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, body: '[Periodic check] look',
        onBusy: 'buffer',
      })
      await flush()
      expect(deps.sendAppChatMessage).toHaveBeenCalledTimes(1)

      pendings[0].resolve('done')
      await flush()
      expect(pendings.slice(1).some((p) => p.conversationId === researcherKey)).toBe(true)
    })
  })
})

// ============================================
// Helpers
// ============================================

/** Insert a running epoch directly (for tests that don't exercise startEpoch). */
function makeEpoch(store: TeamStore): TeamEpoch {
  const epoch: TeamEpoch = { id: 'epoch-1', teamId: TEAM_ID, startedAt: Date.now(), endedAt: null, endReason: null, summary: null, lifecycle: 'run' }
  store.insertEpoch(epoch)
  store.updateTeamCurrentEpoch(TEAM_ID, epoch.id)
  store.updateTeamStatus(TEAM_ID, 'running')
  return epoch
}

/** Spy on bus.completeTurn to capture the outcome it receives. */
function spyCompleteTurn(bus: MessageBus) {
  return vi.spyOn(bus, 'completeTurn')
}

function lastOutcome(spy: ReturnType<typeof spyCompleteTurn>, sessionKey: string): TurnCompletion | undefined {
  for (let i = spy.mock.calls.length - 1; i >= 0; i--) {
    const arg = spy.mock.calls[i][0]
    if (arg.sessionKey === sessionKey) return arg.outcome
  }
  return undefined
}

/**
 * Flush the detached completion chain (orchestration routes the outcome via a
 * void promise chain inside wakeTarget). A real macrotask tick plus several
 * microtask yields covers the withTimeout + .then().then() depth.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
