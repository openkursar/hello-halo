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
 *   - prompt-context projection (roster + topology + source).
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
function makeSession() {
  const spaceByApp = new Map<string, string>([
    [LEAD_APP, SPACE],
    [RESEARCHER_APP, SPACE],
    [TESTER_APP, SPACE],
  ])
  const active = new Set<string>()
  const cleared: Array<{ appId: string; teamId: string }> = []
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
    closeTeamSession: vi.fn(async (appId, teamId, _epochId) => {
      cleared.push({ appId, teamId })
    }),
    getMemberSpaceId: (appId) => spaceByApp.get(appId) ?? null,
  }
  return { deps, pendings, cleared, active }
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

  function build(session: OrchestrationSessionDeps, turnTimeoutMs?: number) {
    bus = createMessageBus({
      store,
      hooks: {
        wakeTarget: (p) => orchestration.wakeTarget(p),
        isBusy: (k) => orchestration.isBusy(k),
      },
    })
    const orchestration = createOrchestration({ store, bus, session, turnTimeoutMs })
    return orchestration
  }

  // ===========================================================================
  // Epoch lifecycle
  // ===========================================================================

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
          envelope: { id: 'e1', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, toAppId: LEAD_APP, body: 'hi', wait: false, correlationId: 'c1', createdAt: Date.now() },
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
          envelope: { id: 'e1', teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, toAppId: LEAD_APP, body: 'hi', wait: false, correlationId: 'c1', createdAt: Date.now() },
          trigger: { teamId: TEAM_ID, epochId: epoch.id, correlationId: 'c1', fromAppId: null, wait: false, kind: 'run_start' },
        })
        pendings[0].resolve('done')

        await vi.advanceTimersByTimeAsync(6_000)

        // Run epochs nudge the lead on quiescence → a second wake occurs.
        expect(deps.sendAppChatMessage.mock.calls.length).toBeGreaterThanOrEqual(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ===========================================================================
  // Reversible seal — a hibernated epoch wakes on re-engagement
  // ===========================================================================

  describe('reactivateEpoch', () => {
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

      orch.reactivateEpoch(TEAM_ID, epoch.id)

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

      orch.reactivateEpoch(TEAM_ID, epoch.id)
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

      orch.reactivateEpoch(TEAM_ID, epoch.id)

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
      orch.reactivateEpoch(TEAM_ID, epoch.id)
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

    it('a HUMAN 1:1 send arrives verbatim — no impersonated teammate header', async () => {
      seedTeam(store, { collabMode: 'free' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      build(deps)

      // The service attributes the send to the lead for bus accounting but marks
      // it human-originated; the member must receive the person's words as-is.
      const sent = bus.send({
        teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher',
        message: '最近什么时候团建？', wait: true, humanOrigin: true,
      })
      await flush()
      const req = (deps.sendAppChatMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(req.message).toBe('最近什么时候团建？')
      expect(req.message).not.toContain('[Team message from')
      pendings[0].resolve('下周五')
      await flush()
      await expect(sent).resolves.toMatchObject({ status: 'ok', message: '下周五' })
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
  // Escalation routing
  // ===========================================================================

  describe('escalation routing', () => {
    it("escalationRouting='lead' delivers a member escalation to the lead's mailbox", async () => {
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

      // A new wake should target the LEAD's session carrying the escalation.
      const leadWake = pendings.find((p) => p.conversationId === buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id))
      expect(leadWake).toBeTruthy()
    })

    it("escalationRouting='user' does NOT re-route the escalation to the lead", async () => {
      seedTeam(store, { collabMode: 'free', escalationRouting: 'user' })
      const epoch = makeEpoch(store)
      const { deps, pendings } = makeSession()
      const orch = build(deps)

      await bus.send({ teamId: TEAM_ID, epochId: epoch.id, fromAppId: LEAD_APP, to: 'researcher', message: 'go', wait: false })
      const corr = pendings[0].teamContext.correlationId
      orch.captureReport(corr, { kind: 'escalation', content: 'need a decision' })
      pendings[0].resolve()
      await flush()

      const leadWake = pendings.find((p) => p.conversationId === buildTeamSessionKey(LEAD_APP, TEAM_ID, epoch.id))
      expect(leadWake).toBeUndefined()
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
      const ok = orch.resumeFromEscalation({ teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, response: 'skip it' })
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

    it('resumeFromEscalation returns false when the epoch is gone (no solo fallback)', () => {
      seedTeam(store, { escalationRouting: 'user' })
      const { deps } = makeSession()
      const orch = build(deps)
      const ok = orch.resumeFromEscalation({ teamId: TEAM_ID, epochId: 'missing', appId: RESEARCHER_APP, response: 'x' })
      expect(ok).toBe(false)
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
    it('projects roster with topology contactability and the message source', () => {
      seedTeam(store, { collabMode: 'structured' })
      const epoch = makeEpoch(store)
      const { deps } = makeSession()
      const orch = build(deps)

      // A turn on the researcher started by the lead, expecting a reply.
      const ctx = orch.buildPromptContext(
        { teamId: TEAM_ID, epochId: epoch.id, correlationId: 'c', fromAppId: LEAD_APP, wait: true },
        RESEARCHER_APP
      )!
      expect(ctx.selfMemberName).toBe('researcher')
      expect(ctx.collabMode).toBe('structured')
      expect(ctx.source.fromMemberName).toBe('lead')
      expect(ctx.source.expectsReply).toBe(true)
      // researcher has no outgoing edges → nobody contactable in structured mode.
      expect(ctx.roster.every((m) => m.contactable === false)).toBe(true)

      // The lead, by contrast, may contact researcher + tester.
      const leadCtx = orch.buildPromptContext(
        { teamId: TEAM_ID, epochId: epoch.id, correlationId: 'c', fromAppId: null, wait: false },
        LEAD_APP
      )!
      const contactable = leadCtx.roster.filter((m) => m.contactable).map((m) => m.memberName).sort()
      expect(contactable).toEqual(['researcher', 'tester'])
      expect(leadCtx.source.fromMemberName).toBeNull()
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
