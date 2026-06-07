/**
 * Epoch lifecycle, delivery hooks, and turn completion routing.
 *
 * Completion is authoritative from the turn's agent-loop ending, not from
 * the member calling report. A captured report only enriches the outcome.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import {
  buildTeamSessionKey,
  TEAM_EVENTS,
} from '../../../../shared/apps/team-types'
import type {
  TeamEpoch,
  TeamTriggerContext,
  TeamRunTrigger,
  TeamEnvelope,
  EpochEndReason,
  TeamMemberRuntimeStatus,
} from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'
import type { MessageBus, TurnCompletion, CircuitBreachEvent } from './message-bus'
import type { TeamPromptContext } from './team-prompt'

const LOG_TAG = '[TeamOrch]'

// ── Injected session-layer dependencies ─────────────────────────────────────

/** Injected so the module is testable without Electron / app-chat. */
export interface OrchestrationSessionDeps {
  /** Resolves when the turn's agent-loop ends; rejects on session error. */
  sendAppChatMessage(request: {
    appId: string
    spaceId: string
    message: string
    conversationId: string
    teamContext: TeamTriggerContext
  }): Promise<{ finalMessage: string | null }>
  isSessionActive(sessionKey: string): boolean
  /**
   * Tear down the live V2 process but preserve the JSONL transcript + saved
   * sessionId so the run stays a retrievable, resumable history record.
   */
  closeTeamSession(appId: string, teamId: string, epochId: string): Promise<void>
  getMemberSpaceId(appId: string): string | null
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface Orchestration {
  wakeTarget(params: {
    sessionKey: string
    appId: string
    teamId: string
    epochId: string
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
  }): Promise<void>
  isBusy(sessionKey: string): boolean

  startEpoch(teamId: string, trigger?: TeamRunTrigger): Promise<TeamEpoch>
  /**
   * Return the open 'conversation' epoch for a (team, chat), or create one. Used
   * by message-driven entries (IM): each chat gets its own long-lived epoch so
   * contexts stay independent (1:1 → per person; group → per group). Each inbound
   * message resumes the lead's session within that epoch instead of starting a
   * fresh run. Does NOT wake the lead — the caller supplies the turn input, and
   * conversation epochs do not occupy team.currentEpochId.
   */
  ensureConversationEpoch(teamId: string, chatKey: string): TeamEpoch
  /**
   * Reversible seal: wake a hibernated (sealed) epoch when someone engages it
   * again (user/IM/teammate). Clears the end stamp and, for run epochs, restores
   * team.currentEpochId + status=running. No-op if the epoch is already open.
   * This is what lets a team keep coordinating — and the lead keep receiving
   * member replies — after a run was auto-sealed.
   */
  reactivateEpoch(teamId: string, epochId: string): void
  sealEpoch(teamId: string, endReason: EpochEndReason, summary?: string | null): Promise<void>
  /** Seal a single conversation epoch (e.g. an IM chat cleared by the user). */
  sealConversationEpoch(teamId: string, epochId: string, endReason?: EpochEndReason, summary?: string | null): Promise<void>
  /** Deferred: seal runs after the lead's current turn ends. */
  requestSeal(teamId: string, epochId: string, summary: string): void

  captureReport(correlationId: string, outcome: TurnCompletion): void
  buildPromptContext(trigger: TeamTriggerContext, selfAppId: string): TeamPromptContext | null
  getMemberStatus(appId: string): TeamMemberRuntimeStatus
  /**
   * Resume a team turn after the user answered a member's escalation. Returns
   * false when the team/epoch is gone (caller must NOT fall back to a solo run).
   */
  resumeFromEscalation(params: {
    teamId: string
    epochId: string
    appId: string
    taskId?: string
    response: string
  }): boolean
}

export interface OrchestrationDeps {
  store: TeamStore
  bus: MessageBus
  session: OrchestrationSessionDeps
  turnTimeoutMs?: number
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000

export function createOrchestration(deps: OrchestrationDeps): Orchestration {
  const { store, bus, session } = deps
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS

  // Only escalations are captured out-of-band; normal results come from onReply.
  const capturedEscalations = new Map<string, TurnCompletion>()

  // Deferred seal: applied after the lead's turn ends, never mid-turn.
  const pendingSeals = new Map<string, { teamId: string; summary: string }>()

  // Auto-seal when all tasks are terminal and all members idle but the lead
  // did not call team_complete. First nudge re-wakes the lead; second auto-seals.
  const quiescenceNudgeCount = new Map<string, number>()
  const quiescenceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const QUIESCENCE_DELAY_MS = 5_000

  // epochId → appIds awaiting a user decision. Cleared on response or seal.
  const escalationWaiters = new Map<string, Set<string>>()

  bus.onBreach((event: CircuitBreachEvent) => {
    void handleBreach(event)
  })

  async function handleBreach(event: CircuitBreachEvent): Promise<void> {
    console.warn(`${LOG_TAG} Circuit breach: team=${event.teamId} reason=${event.reason}; sealing`)
    escalateToUserSystem(
      event.teamId,
      `The team run was stopped automatically: ${describeBreach(event.reason)}.`
    )
    try {
      await sealEpoch(event.teamId, 'error', `Circuit breaker: ${event.reason}`)
    } catch (err) {
      console.error(`${LOG_TAG} sealEpoch after breach failed:`, err)
    }
  }

  // ── Delivery hooks ──────────────────────────────────────────────────────────

  function isBusy(sessionKey: string): boolean {
    return session.isSessionActive(sessionKey)
  }

  /**
   * Resolves when the turn is accepted/started (non-blocking for the lead).
   * Turn outcome is detected separately and fed back via bus.completeTurn.
   */
  async function wakeTarget(params: {
    sessionKey: string
    appId: string
    teamId: string
    epochId: string
    envelope: TeamEnvelope
    trigger: TeamTriggerContext
  }): Promise<void> {
    const { sessionKey, appId, teamId, epochId, envelope, trigger } = params
    const spaceId = session.getMemberSpaceId(appId)
    if (!spaceId) {
      console.error(`${LOG_TAG} wakeTarget: no space for app=${appId}; reporting error completion`)
      bus.completeTurn({ sessionKey, trigger, outcome: { kind: 'error', message: 'Member has no space' } })
      return
    }

    console.log(
      `${LOG_TAG} wakeTarget: team=${teamId} epoch=${epochId} app=${appId} ` +
        `corr=${trigger.correlationId} wait=${trigger.wait}`
    )

    capturedEscalations.delete(trigger.correlationId)

    const turnPromise = withTimeout(
      session.sendAppChatMessage({
        appId,
        spaceId,
        message: renderEnvelope(envelope, trigger),
        conversationId: sessionKey,
        teamContext: trigger,
      }),
      turnTimeoutMs
    )

    // Detached: not awaited so the bus stays non-blocking.
    void turnPromise
      .then(
        (res): TurnCompletion =>
          capturedEscalations.get(trigger.correlationId) ?? {
            kind: 'result',
            content: res.finalMessage ?? '',
            ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
          },
        (err): TurnCompletion => {
          if (err instanceof TurnTimeoutError) {
            return capturedEscalations.get(trigger.correlationId) ?? { kind: 'timeout' }
          }
          return (
            capturedEscalations.get(trigger.correlationId) ?? {
              kind: 'error',
              message: err instanceof Error ? err.message : String(err),
            }
          )
        }
      )
      .then((outcome) => {
        capturedEscalations.delete(trigger.correlationId)
        if (outcome.kind === 'escalation') {
          routeEscalation(teamId, epochId, appId, outcome.content)
        }
        bus.completeTurn({ sessionKey, trigger, outcome })

        const seal = pendingSeals.get(epochId)
        if (seal) {
          const t = store.getTeamById(seal.teamId)
          if (t && t.leadAppId === appId) {
            pendingSeals.delete(epochId)
            void sealEpoch(seal.teamId, 'completed', seal.summary).catch((err) =>
              console.error(`${LOG_TAG} deferred sealEpoch failed:`, err)
            )
          }
        } else {
          scheduleQuiescenceCheck(teamId, epochId)
        }
      })
  }

  // ── Quiescence detection ────────────────────────────────────────────────────

  function scheduleQuiescenceCheck(teamId: string, epochId: string): void {
    const existing = quiescenceTimers.get(epochId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      quiescenceTimers.delete(epochId)
      void checkQuiescence(teamId, epochId)
    }, QUIESCENCE_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    quiescenceTimers.set(epochId, timer)
  }

  async function checkQuiescence(teamId: string, epochId: string): Promise<void> {
    const team = store.getTeamById(teamId)
    if (!team || team.currentEpochId !== epochId || team.status !== 'running') return
    if (pendingSeals.has(epochId)) return

    // Conversation epochs (e.g. an IM-backed team) never auto-seal: going quiet
    // after a reply is the normal "waiting for the next message" state, not run
    // completion. They end only on explicit close (/clear, dissolve, team_complete).
    const epoch = store.getEpochById(epochId)
    if (epoch?.lifecycle === 'conversation') return

    const tasks = store.listTasksByEpoch(teamId, epochId)
    const terminalStatuses = new Set(['done', 'rejected'])
    if (tasks.length > 0 && !tasks.every((t) => terminalStatuses.has(t.status))) return

    const members = store.listMembersByTeam(teamId)
    for (const m of members) {
      const key = buildTeamSessionKey(m.appId, teamId, epochId)
      if (session.isSessionActive(key)) return
    }

    if (bus.hasBufferedMessages(epochId)) return

    const nudges = quiescenceNudgeCount.get(epochId) ?? 0

    if (nudges === 0) {
      quiescenceNudgeCount.set(epochId, 1)
      console.log(`${LOG_TAG} quiescence detected: team=${teamId} epoch=${epochId}; nudging lead`)
      await nudgeLead(teamId, epochId)
    } else {
      console.log(
        `${LOG_TAG} quiescence persists after nudge: team=${teamId} epoch=${epochId}; auto-sealing`
      )
      quiescenceNudgeCount.delete(epochId)
      try {
        await sealEpoch(teamId, 'completed', 'Auto-sealed: all tasks completed, lead did not finalize.')
      } catch (err) {
        console.error(`${LOG_TAG} quiescence auto-seal failed:`, err)
      }
    }
  }

  async function nudgeLead(teamId: string, epochId: string): Promise<void> {
    const team = store.getTeamById(teamId)
    if (!team?.leadAppId) return

    const trigger: TeamTriggerContext = {
      teamId,
      epochId,
      correlationId: randomUUID(),
      fromAppId: null,
      wait: false,
      kind: 'run_start',
    }
    const nudgeEnvelope: TeamEnvelope = {
      id: randomUUID(),
      teamId,
      epochId,
      fromAppId: team.leadAppId,
      toAppId: team.leadAppId,
      body:
        '[System] All tasks are in a terminal state and all members are idle. ' +
        'The run appears complete. If the goal is achieved, you MUST call ' +
        '`team_complete("<summary>")` now to finalize this run. ' +
        'If you do not, the system will auto-seal the run.',
      wait: false,
      correlationId: trigger.correlationId,
      createdAt: Date.now(),
    }
    const sessionKey = buildTeamSessionKey(team.leadAppId, teamId, epochId)

    try {
      await wakeTarget({
        sessionKey,
        appId: team.leadAppId,
        teamId,
        epochId,
        envelope: nudgeEnvelope,
        trigger,
      })
    } catch (err) {
      console.error(`${LOG_TAG} nudgeLead failed:`, err)
    }
  }

  function renderEnvelope(envelope: TeamEnvelope, trigger: TeamTriggerContext): string {
    if (trigger.kind === 'completion') {
      const who = memberName(envelope.teamId, envelope.fromAppId)
      const task = envelope.taskRef ? ` · task ${envelope.taskRef}` : ''
      return `[Result from ${who}${task}]\n\n${envelope.body}`
    }
    const fromName = trigger.fromAppId ? memberName(envelope.teamId, trigger.fromAppId) : null
    const header = fromName
      ? `[Team message from ${fromName}${trigger.wait ? ' — awaiting your reply' : ''}]`
      : '[Team run signal]'
    return `${header}\n\n${envelope.body}`
  }

  // ── Escalation routing ──────────────────────────────────────────────────────

  /**
   * Under 'lead' routing a member's escalation goes to the lead first (report-tool
   * suppressed the user-facing entry). Otherwise it is user-bound: report-tool
   * already created the entry, so here we only mark the team view 'waiting_user'.
   */
  function routeEscalation(teamId: string, epochId: string, fromAppId: string, content: string): void {
    const team = store.getTeamById(teamId)
    if (!team) return

    const isLead = team.leadAppId === fromAppId
    if (team.escalationRouting === 'lead' && !isLead && team.leadAppId) {
      const leadMember = store.listMembersByTeam(teamId).find((m) => m.appId === team.leadAppId)
      if (!leadMember) return
      const fromName = memberName(teamId, fromAppId)
      void bus
        .send({
          teamId,
          epochId,
          fromAppId,
          to: leadMember.memberName,
          message: `[Escalation from ${fromName}] ${content}`,
          wait: false,
        })
        .catch((err) => {
          console.error(`${LOG_TAG} Failed to route escalation to lead:`, err)
        })
      return
    }

    markEscalationToUser(teamId, epochId, fromAppId)
  }

  /**
   * Mark a member as awaiting a user decision. Only run epochs flip team status;
   * conversation epochs (IM) never own team.currentEpochId/status.
   */
  function markEscalationToUser(teamId: string, epochId: string, appId: string): void {
    let set = escalationWaiters.get(epochId)
    if (!set) {
      set = new Set<string>()
      escalationWaiters.set(epochId, set)
    }
    set.add(appId)

    const team = store.getTeamById(teamId)
    const epoch = store.getEpochById(epochId)
    if (team && epoch?.lifecycle === 'run' && team.status === 'running') {
      store.updateTeamStatus(teamId, 'waiting_user')
    }
    console.log(`${LOG_TAG} escalation awaiting user: team=${teamId} epoch=${epochId} app=${appId}`)
    emitTeamUpdated(teamId)
  }

  // Wakes the escalating member via the team channel, which reactivates a sealed
  // epoch automatically. The member's completion then routes back to the lead.
  function resumeFromEscalation(params: {
    teamId: string
    epochId: string
    appId: string
    taskId?: string
    response: string
  }): boolean {
    const { teamId, epochId, appId, taskId, response } = params
    const team = store.getTeamById(teamId)
    const epoch = store.getEpochById(epochId)
    if (!team || !epoch) return false

    // Clear the awaiting marker and bring a run epoch's team status back to
    // running (reactivateEpoch only restores status when the epoch was sealed).
    escalationWaiters.get(epochId)?.delete(appId)
    if (epoch.lifecycle === 'run' && team.status === 'waiting_user') {
      store.updateTeamStatus(teamId, 'running')
    }
    emitTeamUpdated(teamId)

    const isLeadSelf = team.leadAppId === appId
    // A member's completion should wake the lead to reconcile; the lead's own
    // resumed turn is terminal (it drives the next round itself).
    const fromAppId = isLeadSelf ? null : team.leadAppId ?? null
    const correlationId = randomUUID()
    const body =
      '[The user answered your escalation]\n\n' +
      `${response}\n\n` +
      'Continue from here. When you are done, state your result as your final message.'
    const envelope: TeamEnvelope = {
      id: randomUUID(),
      teamId,
      epochId,
      fromAppId: fromAppId ?? appId,
      toAppId: appId,
      body,
      wait: false,
      correlationId,
      taskRef: taskId,
      createdAt: Date.now(),
    }
    const trigger: TeamTriggerContext = {
      teamId,
      epochId,
      correlationId,
      fromAppId,
      wait: false,
      taskId,
      kind: 'message',
    }
    ;(trigger as TeamTriggerContext & { forwardDepth?: number }).forwardDepth = 1

    console.log(`${LOG_TAG} resumeFromEscalation: team=${teamId} epoch=${epochId} app=${appId} lead=${isLeadSelf}`)
    void wakeTarget({
      sessionKey: buildTeamSessionKey(appId, teamId, epochId),
      appId,
      teamId,
      epochId,
      envelope,
      trigger,
    }).catch((err) => {
      console.error(`${LOG_TAG} resumeFromEscalation wake failed:`, err)
    })
    return true
  }

  // ── Epoch lifecycle ─────────────────────────────────────────────────────────

  const RECENT_RUNS_WINDOW = 3

  /** Compact digest of prior runs for cross-epoch continuity. */
  function buildRecentRunsDigest(teamId: string, excludeEpochId: string): string | null {
    const prior = store
      .listEpochsByTeam(teamId)
      .filter((e) => e.id !== excludeEpochId)
      .slice(0, RECENT_RUNS_WINDOW)
    if (prior.length === 0) return null

    const lines = prior.map((e) => {
      const tasks = store.listTasksByEpoch(teamId, e.id)
      const done = tasks.filter((tk) => tk.status === 'done').length
      const when = new Date(e.startedAt).toISOString().slice(0, 16).replace('T', ' ')
      const status = e.endedAt ? (e.endReason ?? 'ended') : 'running'
      const summary = e.summary ? ` — ${e.summary}` : ''
      return `- ${when} (${status}, ${done}/${tasks.length} tasks)${summary}`
    })
    return [
      'Recent runs of this team (newest first; open a member\u2019s history for full transcripts):',
      ...lines,
    ].join('\n')
  }

  async function startEpoch(teamId: string, runTrigger: TeamRunTrigger = { type: 'manual' }): Promise<TeamEpoch> {
    const team = store.getTeamById(teamId)
    if (!team) throw new Error(`Team not found: ${teamId}`)
    if (!team.leadAppId) throw new Error(`Team has no lead provisioned: ${teamId}`)
    if (team.currentEpochId) {
      throw new Error(`Team ${teamId} already has a running epoch (${team.currentEpochId})`)
    }

    const epoch: TeamEpoch = {
      id: randomUUID(),
      teamId,
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      summary: null,
      lifecycle: 'run',
    }
    store.insertEpoch(epoch, runTrigger.type)
    store.updateTeamCurrentEpoch(teamId, epoch.id)
    store.updateTeamStatus(teamId, 'running')
    emitTeamUpdated(teamId)

    console.log(`${LOG_TAG} startEpoch: team=${teamId} epoch=${epoch.id} lead=${team.leadAppId}`)

    const trigger: TeamTriggerContext = {
      teamId,
      epochId: epoch.id,
      correlationId: randomUUID(),
      fromAppId: null,
      wait: false,
      kind: 'run_start',
    }
    const digest = buildRecentRunsDigest(teamId, epoch.id)
    const startBody = 'The team run has started. Read the goal and the board, then decompose and dispatch the work.'
    const startEnvelope: TeamEnvelope = {
      id: randomUUID(),
      teamId,
      epochId: epoch.id,
      fromAppId: team.leadAppId,
      toAppId: team.leadAppId,
      body: digest ? `${digest}\n\n${startBody}` : startBody,
      wait: false,
      correlationId: trigger.correlationId,
      createdAt: Date.now(),
    }
    const sessionKey = buildTeamSessionKey(team.leadAppId, teamId, epoch.id)
    void wakeTarget({
      sessionKey,
      appId: team.leadAppId,
      teamId,
      epochId: epoch.id,
      envelope: startEnvelope,
      trigger,
    }).catch((err) => {
      console.error(`${LOG_TAG} startEpoch lead wake failed:`, err)
    })

    return epoch
  }

  function ensureConversationEpoch(teamId: string, chatKey: string): TeamEpoch {
    const team = store.getTeamById(teamId)
    if (!team) throw new Error(`Team not found: ${teamId}`)
    if (!team.leadAppId) throw new Error(`Team has no lead provisioned: ${teamId}`)

    // One long-lived epoch PER CHAT, so each IM chat keeps its own context
    // (1:1 → per person; group → per group). Reuse the open one if present.
    const existing = store.getOpenConversationEpoch(teamId, chatKey)
    if (existing) return existing

    const epoch: TeamEpoch = {
      id: randomUUID(),
      teamId,
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      summary: null,
      lifecycle: 'conversation',
      chatKey,
    }
    store.insertEpoch(epoch, 'event')
    // Conversation epochs intentionally do NOT set team.currentEpochId or
    // status='running'. currentEpochId is the single-RUN reentrancy/UI pointer;
    // conversation epochs are per-chat (many open at once) and must not occupy it
    // — otherwise chats would collide and scheduled runs would be blocked.
    console.log(`${LOG_TAG} ensureConversationEpoch: team=${teamId} chat=${chatKey} epoch=${epoch.id} (new)`)
    return epoch
  }

  /**
   * Archive one epoch: stamp its end, tear down member team sessions (keeping
   * JSONL/sessionId for history), reset the bus, and clear quiescence timers.
   * Does NOT touch team.currentEpochId/status — callers decide that.
   */
  async function archiveEpoch(
    teamId: string,
    epochId: string,
    endReason: EpochEndReason,
    summary: string | null
  ): Promise<void> {
    store.endEpoch(epochId, Date.now(), endReason, summary)

    for (const member of store.listMembersByTeam(teamId)) {
      try {
        await session.closeTeamSession(member.appId, teamId, epochId)
      } catch (err) {
        console.error(`${LOG_TAG} closeTeamSession failed for app=${member.appId}:`, err)
      }
    }

    bus.resetEpoch(epochId)

    quiescenceNudgeCount.delete(epochId)
    escalationWaiters.delete(epochId)
    const qTimer = quiescenceTimers.get(epochId)
    if (qTimer) {
      clearTimeout(qTimer)
      quiescenceTimers.delete(epochId)
    }
  }

  function reactivateEpoch(teamId: string, epochId: string): void {
    const epoch = store.getEpochById(epochId)
    if (!epoch || epoch.endedAt === null) return // already open (or gone) — nothing to do
    store.reopenEpoch(epochId)
    // Run epochs own the single-run pointer + team status; conversation epochs
    // never did, so leave those untouched.
    if (epoch.lifecycle === 'run') {
      store.updateTeamCurrentEpoch(teamId, epochId)
      store.updateTeamStatus(teamId, 'running')
    }
    emitTeamUpdated(teamId)
    console.log(`${LOG_TAG} reactivateEpoch: team=${teamId} epoch=${epochId} lifecycle=${epoch.lifecycle}`)
  }

  async function sealEpoch(
    teamId: string,
    endReason: EpochEndReason,
    summary?: string | null
  ): Promise<void> {
    const team = store.getTeamById(teamId)
    if (!team) {
      console.warn(`${LOG_TAG} sealEpoch: team not found ${teamId}`)
      return
    }
    const epoch = store.getCurrentEpochForTeam(teamId)
    if (!epoch) {
      console.warn(`${LOG_TAG} sealEpoch: no open run epoch for team ${teamId}`)
      store.updateTeamStatus(teamId, 'idle')
      store.updateTeamCurrentEpoch(teamId, null)
      emitTeamUpdated(teamId)
      return
    }

    console.log(`${LOG_TAG} sealEpoch: team=${teamId} epoch=${epoch.id} reason=${endReason}`)

    await archiveEpoch(teamId, epoch.id, endReason, summary ?? null)

    store.updateTeamStatus(teamId, 'idle')
    store.updateTeamCurrentEpoch(teamId, null)
    emitTeamUpdated(teamId)
  }

  /**
   * Seal a single conversation epoch (e.g. an IM chat cleared by the user). Does
   * not affect team.currentEpochId/status — conversation epochs never owned it.
   */
  async function sealConversationEpoch(
    teamId: string,
    epochId: string,
    endReason: EpochEndReason = 'stopped',
    summary?: string | null
  ): Promise<void> {
    const epoch = store.getEpochById(epochId)
    if (!epoch || epoch.endedAt !== null) return
    console.log(`${LOG_TAG} sealConversationEpoch: team=${teamId} epoch=${epochId} reason=${endReason}`)
    await archiveEpoch(teamId, epochId, endReason, summary ?? null)
  }

  // ── Report sink ───────────────────────────────────────────────────────────

  function captureReport(correlationId: string, outcome: TurnCompletion): void {
    capturedEscalations.set(correlationId, outcome)
  }

  function requestSeal(teamId: string, epochId: string, summary: string): void {
    console.log(`${LOG_TAG} requestSeal queued: team=${teamId} epoch=${epochId}`)
    pendingSeals.set(epochId, { teamId, summary })
  }

  // ── Prompt context ──────────────────────────────────────────────────────────

  function buildPromptContext(
    trigger: TeamTriggerContext,
    selfAppId: string
  ): TeamPromptContext | null {
    const team = store.getTeamById(trigger.teamId)
    if (!team) return null
    const members = store.listMembersByTeam(trigger.teamId)
    const self = members.find((m) => m.appId === selfAppId)
    if (!self) return null

    const roster = members
      .filter((m) => m.appId !== selfAppId)
      .map((m) => ({
        memberName: m.memberName,
        role: m.role,
        isLead: m.isLead,
        contactable:
          team.collabMode === 'free' || store.isEdgeAllowed(trigger.teamId, selfAppId, m.appId),
      }))

    return {
      teamName: team.name,
      goal: team.goal,
      collabMode: team.collabMode,
      escalationRouting: team.escalationRouting,
      selfMemberName: self.memberName,
      selfRole: self.role,
      selfIsLead: self.isLead,
      roster,
      source: {
        fromMemberName: trigger.fromAppId ? memberName(trigger.teamId, trigger.fromAppId) : null,
        expectsReply: trigger.wait,
      },
    }
  }

  // ── Live member status ─────────────────────────────────────────────────────

  function getMemberStatus(appId: string): TeamMemberRuntimeStatus {
    const memberships = store.listMembersByAppId(appId)
    for (const m of memberships) {
      const epochId = store.getTeamById(m.teamId)?.currentEpochId
      if (!epochId) continue
      // Awaiting a user decision takes precedence over working/idle.
      if (escalationWaiters.get(epochId)?.has(appId)) return 'waiting_user'
      const key = buildTeamSessionKey(appId, m.teamId, epochId)
      if (session.isSessionActive(key)) return 'working'
    }
    return 'idle'
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  function memberName(teamId: string, appId: string): string {
    return store.listMembersByTeam(teamId).find((m) => m.appId === appId)?.memberName ?? appId
  }

  function emitTeamUpdated(teamId: string): void {
    const team = store.getTeamById(teamId)
    const payload = team ? { teamId, team } : { teamId, removed: true }
    broadcastToAll(TEAM_EVENTS.updated, payload)
    sendToRenderer(TEAM_EVENTS.updated, payload)
  }

  function escalateToUserSystem(teamId: string, message: string): void {
    const epoch = store.getCurrentEpochForTeam(teamId)
    const payload = {
      teamId,
      epochId: epoch?.id ?? null,
      system: true,
      message,
    }
    broadcastToAll('app:escalation:new', { teamId, system: true, question: message })
    sendToRenderer('app:escalation:new', { teamId, system: true, question: message })
    broadcastToAll(TEAM_EVENTS.updated, { teamId, ...(store.getTeamById(teamId) ? { team: store.getTeamById(teamId)! } : {}) })
    console.warn(`${LOG_TAG} escalateToUser: team=${teamId} ${message}`, payload)
  }

  return {
    wakeTarget,
    isBusy,
    startEpoch,
    ensureConversationEpoch,
    reactivateEpoch,
    sealEpoch,
    sealConversationEpoch,
    requestSeal,
    captureReport,
    buildPromptContext,
    getMemberStatus,
    resumeFromEscalation,
  }
}

// ── Timeout wrapper ─────────────────────────────────────────────────────────

class TurnTimeoutError extends Error {
  constructor() {
    super('Team turn timed out')
    this.name = 'TurnTimeoutError'
  }
}

/**
 * The underlying turn continues after timeout but its outcome is no longer
 * awaited; the session layer tears it down on the next seal/clear.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TurnTimeoutError()), ms)
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

function describeBreach(reason: CircuitBreachEvent['reason']): string {
  switch (reason) {
    case 'maxMessages':
      return 'it reached the message limit for one run'
    case 'maxForwardDepth':
      return 'a message-forwarding loop was detected'
    case 'maxDurationMs':
      return 'it exceeded the maximum run duration'
    default:
      return 'a safety limit was reached'
  }
}
