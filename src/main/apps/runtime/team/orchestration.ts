/**
 * Epoch lifecycle, delivery hooks, and turn completion routing.
 *
 * Completion is authoritative from the turn's agent-loop ending, not from
 * the member calling report. A captured report only enriches the outcome.
 */

import { randomUUID } from 'crypto'
import { broadcastToAll } from '../../../http/websocket'
import { sendToRenderer } from '../../../foundation/window.service'
import { Semaphore } from '../concurrency'
import { oneLineExcerpt } from '../text-truncate'
import {
  buildTeamSessionKey,
  isRemoteMember,
  TEAM_EVENTS,
  TEAM_DEFAULT_TURN_TIMEOUT_MS,
  TEAM_DEFAULT_MAX_CONCURRENT_TURNS,
} from '../../../../shared/apps/team-types'
import type {
  TeamEpoch,
  TeamTriggerContext,
  TeamRunTrigger,
  TeamEnvelope,
  EpochEndReason,
  EpochOutcome,
  TeamMemberRuntimeStatus,
  RosterBusyEntry,
} from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'
import { deriveConversationLabel, deriveConversationTitle } from '../../team/epoch-label'
import { isNativeConversationChatKey } from '../../../../shared/apps/im-keys'
import type {
  MessageBus,
  TurnCompletion,
  CircuitBreachEvent,
  BusyDisposition,
  WakeDisposition,
} from './message-bus'
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
  }): Promise<{
    finalMessage: string | null
    /**
     * Set by the location-aware (federation) impl when the wake never reached the
     * owner (offline/unreachable) or no completion signal came back. The local
     * impl never sets it (a local turn always runs). Kept OUT of the turn-outcome
     * type so "not delivered" is never confused with an empty reply.
     */
    undelivered?: { reason: string }
  }>
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
  ensureConversationEpoch(teamId: string, chatKey: string, title?: string): TeamEpoch
  /** Rename a conversation epoch (office-shared: the change is captured + replicated). */
  renameConversationEpoch(teamId: string, epochId: string, title: string | null): void
  /**
   * Auto-name a native conversation from its first user message (parity with the
   * space chat's first-message title). No-op unless the epoch is a still-untitled
   * NATIVE conversation and the turn is the lead's (the front desk the user talks
   * to). The derived title is captured + replicated like any rename, so every
   * node's session list stops showing "New session".
   */
  maybeAutoNameConversation(teamId: string, epochId: string, fromHuman: boolean, message: string): void
  /**
   * A turn is entering this epoch (user/IM/teammate). Stamps its activity so a
   * list of work can be ordered by when it last moved, and — reversible seal —
   * wakes it if hibernated: clears the end stamp and, for run epochs, restores
   * team.currentEpochId + status=running. The wake is what lets a team keep
   * coordinating (and the lead keep receiving member replies) after an auto-seal.
   */
  noteEpochTurn(teamId: string, epochId: string): void
  sealEpoch(teamId: string, endReason: EpochEndReason, summary?: string | null): Promise<void>
  /** Seal a single conversation epoch (e.g. an IM chat cleared by the user). */
  sealConversationEpoch(teamId: string, epochId: string, endReason?: EpochEndReason, summary?: string | null): Promise<void>
  /** Deferred: seal runs after the lead's current turn ends. */
  requestSeal(teamId: string, epochId: string, summary: string): void

  wakeForCheck(params: {
    teamId: string
    epochId: string
    appId: string
    body: string
    onBusy: BusyDisposition
  }): Promise<WakeDisposition>

  captureReport(correlationId: string, outcome: TurnCompletion): void
  /**
   * The team layers of a member's system prompt. Keyed by (team, member) only:
   * nothing about the current turn may enter it (see TeamPromptContext).
   */
  buildPromptContext(teamId: string, selfAppId: string): TeamPromptContext | null
  getMemberStatus(appId: string): TeamMemberRuntimeStatus
  /**
   * Everything a member is serving right now for one team (open run and/or
   * conversations), each with a human label resolved on this side (P0-2).
   */
  getMemberBusy(appId: string, teamId: string): RosterBusyEntry[]
  /**
   * Announce that a member's live status may have moved, for a turn this
   * orchestration did not run. Status is DERIVED from the session ledger, so a
   * turn started outside the bus (a 1:1 chat, an IM-backed turn) flips it with
   * nothing to tell viewers. Re-derived when the pulse lands, so announce AFTER
   * the ledger write being reported, never before.
   */
  noteMemberStatusChanged(teamId: string): void
  /**
   * Re-derive whether a member owned by THIS machine still owes its own person
   * an answer, and share the result with the office. Idempotent and safe to call
   * on any turn end: the truth is the persisted escalation, not the code path
   * the turn happened to take.
   */
  reconcileAwaitingDecision(appId: string): void
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
    /**
     * The question this answers. A member may have several open at once and the
     * person answers them in any order, so without it an answer binds to the
     * wrong one.
     */
    question?: string
  }): boolean
}

export interface OrchestrationDeps {
  store: TeamStore
  bus: MessageBus
  session: OrchestrationSessionDeps
  turnTimeoutMs?: number
  /**
   * Cap on team member turns running at once on this machine (across every
   * team/epoch) — the same resource-contention concern the automation
   * runtime bounds via its own semaphore (`apps/runtime/service.ts`), but
   * team turns bypass that gate entirely, so without this a burst of
   * deliveries can start unbounded concurrent agent turns. Defaults to
   * `TEAM_DEFAULT_MAX_CONCURRENT_TURNS`.
   */
  maxConcurrentTurns?: number
  /**
   * Observer fired AFTER a run epoch is sealed (manual pause, quiescence
   * auto-seal, circuit breach). Additive only — it does not alter seal semantics;
   * it lets the federation egress propagate the rested run-state to joiners so a
   * remote roster steps back to idle (and member pulses clear) promptly, even on
   * an auto-seal that does not go through the service-level pauseTeam. Absent →
   * no propagation. Never thrown into the seal path.
   */
  onRunStateChanged?: (teamId: string) => void
  /**
   * Observer fired when a member's live status flips (turn start/end, escalation
   * raised/resolved). Bootstrap wires it to the federation roster refresh so
   * VIEWERS see the pulse start AND stop in step — without it a joiner's board
   * froze on the last projected status (e.g. a lead spinning forever after its
   * final turn) until some unrelated write refreshed the roster. Coalescing is
   * the subscriber's job. Never thrown into the turn path.
   */
  onMemberStatusChanged?: (teamId: string) => void
  /**
   * A member's owner-authored profile changed and has to reach the rest of the
   * office — the same channel a duty edit rides. Used here for "waiting on its
   * owner": the question can only be answered on this machine, so unless the
   * fact travels, every other machine reads the member as idle and the office
   * looks stopped instead of blocked on a person. Absent → single-machine team,
   * nothing to publish.
   */
  onMemberProfileChanged?: (teamId: string, appId: string) => void
  /**
   * Replication capture for epoch lifecycle writes (open / seal / reopen /
   * rename / outcome). Fired AFTER the authoritative local store write with the
   * fresh full row, so the federation layer can sequence + replicate it exactly
   * like a blackboard write — this is what makes conversations office-shared
   * (P0-1). Absent → no replication (single-machine team). Never thrown into
   * the lifecycle path.
   */
  onEpochMutation?: (epoch: TeamEpoch) => void
  /**
   * Whether a member has a PERSISTED unanswered escalation in this team (the
   * activity-store truth that survives a seal and a restart, P0-5). In-memory
   * waiters cover the live window; this covers everything else. Absent → only
   * the in-memory waiters are consulted.
   */
  hasPendingEscalation?: (appId: string, teamId: string) => boolean
  /**
   * Human name of an IM chatKey (IM session registry lookup), used when
   * labeling a conversation a member is busy with. Absent → raw chat id.
   */
  describeChatKey?: (teamId: string, chatKey: string) => string | null
  /**
   * What the member being woken has missed since it last looked at the board,
   * or null when there is nothing to say. Rendered into the turn's INPUT (see
   * `withDigest`) — never into the Entry, which must stay byte-stable. Late-bound
   * by the runtime factory. Absent → turns carry no digest.
   */
  renderDigest?: (teamId: string, epochId: string, viewerAppId: string) => string | null
  /**
   * A run or conversation was archived. Periodic checks are scoped to the thing
   * they were set inside, so they end with it. Late-bound by the runtime factory
   * (checks are constructed after orchestration). Never thrown into the seal path.
   */
  onEpochArchived?: (teamId: string, epochId: string, endReason: EpochEndReason) => void
}

// Long tasks (coding, multi-step research) routinely exceed 30 minutes; the
// default is raised to bound a single turn generously while still catching a
// genuinely stuck session. Configurable per-deployment via `deps.turnTimeoutMs`
// (wired from `agent.teamTurnTimeoutMs`) for workloads that need more.
const DEFAULT_TURN_TIMEOUT_MS = TEAM_DEFAULT_TURN_TIMEOUT_MS

/**
 * A busy team flips member status many times a second, and each viewer-side
 * refresh refetches the open team's detail — so the UI push is coalesced to one
 * per window per team (mirrors the federation roster plane's own floor).
 */
const STATUS_PUSH_COALESCE_MS = 750

/**
 * How much of the original question rides back with its answer: enough to tell
 * two open questions apart, not enough to crowd out the turn input. The member
 * still holds the full text in its own session.
 */
const QUOTED_QUESTION_LIMIT = 300

export function createOrchestration(deps: OrchestrationDeps): Orchestration {
  const { store, bus, session } = deps
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const onRunStateChanged = deps.onRunStateChanged
  // Gates the actual agent-loop dispatch (not wakeTarget's own return, which
  // must keep resolving as soon as the turn is accepted — see wakeTarget doc).
  // A turn queued behind this fills its slot the instant one frees up. Mirrors
  // the automation runtime's own semaphore (apps/runtime/service.ts): same
  // class of resource contention, same proven bound, applied to team turns.
  const turnSemaphore = new Semaphore(deps.maxConcurrentTurns ?? TEAM_DEFAULT_MAX_CONCURRENT_TURNS)

  // Per-team coalescing timers for the viewer-side status push.
  const statusPushTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function scheduleStatusPush(teamId: string): void {
    if (statusPushTimers.has(teamId)) return
    const timer = setTimeout(() => {
      statusPushTimers.delete(teamId)
      // Fires after the turn that scheduled it — by then the store may be gone
      // (shutdown, team dissolved). A missed pulse is not worth an unhandled throw.
      try {
        emitTeamUpdated(teamId)
      } catch (err) {
        console.error(`${LOG_TAG} coalesced status push failed:`, err)
      }
    }, STATUS_PUSH_COALESCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    statusPushTimers.set(teamId, timer)
  }

  function notifyMemberStatusChanged(teamId: string): void {
    // The viewer's own machine needs this too: the federation observer below
    // projects the roster to OTHER nodes and is a no-op for a team that is not
    // hosted, so without this push a local team's board never learns that a
    // member went working — the reason conversation turns looked frozen while a
    // run looked alive (a run additionally flips team.status, which the UI polls).
    scheduleStatusPush(teamId)
    try {
      deps.onMemberStatusChanged?.(teamId)
    } catch (err) {
      console.error(`${LOG_TAG} onMemberStatusChanged observer failed:`, err)
    }
  }

  /**
   * Capture an epoch lifecycle write for replication: re-read the fresh row and
   * hand it to the observer (P0-1). Observer-only — a replication fault never
   * corrupts the authoritative local write.
   */
  function publishEpoch(epochId: string): void {
    if (!deps.onEpochMutation) return
    const epoch = store.getEpochById(epochId)
    if (!epoch) return
    try {
      deps.onEpochMutation(epoch)
    } catch (err) {
      console.error(`${LOG_TAG} onEpochMutation observer failed:`, err)
    }
  }

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
      await sealEpochById(event.teamId, event.epochId, 'error', `Circuit breaker: ${event.reason}`)
    } catch (err) {
      console.error(`${LOG_TAG} sealEpoch after breach failed:`, err)
    }
  }

  // ── Delivery hooks ──────────────────────────────────────────────────────────

  function isBusy(sessionKey: string): boolean {
    return session.isSessionActive(sessionKey)
  }

  /**
   * Runs the agent-loop call once a concurrency slot is free; queues otherwise.
   * `abandoned` is polled right after acquiring the slot so a turn that already
   * timed out out while queued does not go on to start the real call on a
   * session the timeout handler may already be tearing down (the double-
   * execution risk timeouts guard against — see wakeTarget below).
   */
  async function runGatedTurn(
    request: Parameters<OrchestrationSessionDeps['sendAppChatMessage']>[0],
    abandoned: () => boolean
  ): ReturnType<OrchestrationSessionDeps['sendAppChatMessage']> {
    await turnSemaphore.acquire()
    try {
      if (abandoned()) return { finalMessage: null, undelivered: { reason: 'Timed out waiting for a concurrency slot' } }
      return await session.sendAppChatMessage(request)
    } finally {
      turnSemaphore.release()
    }
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
        `corr=${trigger.correlationId} kind=${trigger.kind ?? 'n/a'}`
    )

    capturedEscalations.delete(trigger.correlationId)

    let timedOut = false
    const turnPromise = withTimeout(
      runGatedTurn(
        {
          appId,
          spaceId,
          message: renderEnvelope(envelope, trigger),
          conversationId: sessionKey,
          teamContext: trigger,
        },
        () => timedOut
      ),
      turnTimeoutMs
    )
    // The member just went working → push the pulse to viewers.
    notifyMemberStatusChanged(teamId)

    // Detached: not awaited so the bus stays non-blocking.
    void turnPromise
      .then(
        (res): TurnCompletion =>
          capturedEscalations.get(trigger.correlationId) ??
          // A wake that never reached the owner (or whose completion never returned)
          // is NOT a result — surface it as 'undelivered' so the sender learns the
          // truth instead of reading an empty finalMessage as a real reply.
          (res.undelivered
            ? { kind: 'undelivered', reason: res.undelivered.reason }
            : {
                kind: 'result',
                content: res.finalMessage ?? '',
                ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
              }),
        async (err): Promise<TurnCompletion> => {
          if (err instanceof TurnTimeoutError) {
            timedOut = true
            // Actually tear down the still-running turn instead of merely
            // abandoning the promise — otherwise the member's session stays
            // occupied by the timed-out generation while the sender may
            // re-dispatch, risking two turns executing on the same session.
            try {
              await session.closeTeamSession(appId, teamId, epochId)
            } catch (closeErr) {
              console.error(`${LOG_TAG} closeTeamSession after timeout failed:`, closeErr)
            }
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
        // The turn ended → clear the viewer-side pulse (working → idle/alert).
        notifyMemberStatusChanged(teamId)
        if (outcome.kind === 'escalation') {
          markEscalationToUser(teamId, epochId, appId)
        }
        bus.completeTurn({ sessionKey, trigger, outcome })

        const seal = pendingSeals.get(epochId)
        if (seal) {
          const t = store.getTeamById(seal.teamId)
          if (t && t.leadAppId === appId) {
            pendingSeals.delete(epochId)
            void sealEpochById(seal.teamId, epochId, 'completed', seal.summary).catch((err) =>
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
        await sealEpochById(teamId, epochId, 'completed', 'Auto-sealed: all tasks completed, lead did not finalize.')
      } catch (err) {
        console.error(`${LOG_TAG} quiescence auto-seal failed:`, err)
      }
    }
  }

  /**
   * Start a member's turn for a due periodic check. What a busy target means is
   * the caller's to decide, because only it knows whether another round is
   * coming: a recurring check skips (stacking missed rounds on a member that is
   * already working is how a check turns into a pile-up), a one-shot queues.
   */
  async function wakeForCheck(params: {
    teamId: string
    epochId: string
    appId: string
    body: string
    onBusy: BusyDisposition
  }): Promise<WakeDisposition> {
    return wakeSelf({ ...params, kind: 'periodic_check' })
  }

  /**
   * Start a turn the runtime itself asked for, addressed to the member from
   * itself: there is no sender to reply to, and the body is already whatever the
   * member needs to read. Routed through the bus so it shares the busy gate with
   * teammate messages — two turns on one session key destroy each other.
   */
  async function wakeSelf(params: {
    teamId: string
    epochId: string
    appId: string
    body: string
    kind: TeamTriggerContext['kind']
    onBusy: BusyDisposition
  }): Promise<WakeDisposition> {
    const { teamId, epochId, appId, body, kind, onBusy } = params
    const correlationId = randomUUID()
    return bus.deliverRuntimeWake({
      envelope: {
        id: randomUUID(),
        teamId,
        epochId,
        fromAppId: appId,
        toAppId: appId,
        body,
        correlationId,
        createdAt: Date.now(),
      },
      trigger: { teamId, epochId, correlationId, fromAppId: null, wait: false, kind },
      onBusy,
    })
  }

  async function nudgeLead(teamId: string, epochId: string): Promise<void> {
    const team = store.getTeamById(teamId)
    if (!team?.leadAppId) return

    try {
      await wakeSelf({
        teamId,
        epochId,
        appId: team.leadAppId,
        kind: 'run_start',
        onBusy: 'buffer',
        body:
          '[System] All tasks are in a terminal state and all members are idle. ' +
          'The run appears complete. If the goal is achieved, you MUST call ' +
          '`team_complete("<summary>")` now to finalize this run. ' +
          'If you do not, the system will auto-seal the run.',
      })
    } catch (err) {
      console.error(`${LOG_TAG} nudgeLead failed:`, err)
    }
  }

  /**
   * Append what this member missed while it was not running.
   *
   * This is the only point at which a member is told anything without having to
   * ask for it: the board does not push, and `team_read_board` costs a whole
   * model round-trip that the member has to remember to spend. The turn input is
   * read by construction, so riding it is both cheaper and reliable.
   *
   * It belongs in the message and NOT in the Entry — the Entry is frozen into the
   * session's reuse fingerprint, so per-turn text there would rebuild the
   * subprocess every turn (see team-prompt.ts).
   */
  function withDigest(body: string, envelope: TeamEnvelope): string {
    const digest = deps.renderDigest?.(envelope.teamId, envelope.epochId, envelope.toAppId)
    return digest ? `${body}\n\n${digest}` : body
  }

  /**
   * The turn's INPUT — not the system prompt. Everything that varies per turn
   * (who sent this) is rendered here, because the team Entry is frozen into the
   * session's reuse fingerprint and must stay byte-identical across a member's
   * consecutive turns.
   *
   * No header may promise that the turn's last words go anywhere: answering a
   * teammate is an explicit `team_send`, never an implicit hand-back.
   */
  function renderEnvelope(envelope: TeamEnvelope, trigger: TeamTriggerContext): string {
    // A periodic check arrives with its own header (who set it, the original
    // words, which round this is) already rendered by the checks module.
    if (trigger.kind === 'periodic_check') return withDigest(envelope.body, envelope)
    // A person's 1:1 message arrives verbatim — no teammate header, and no team
    // bookkeeping either: talking to your own digital human is not coordinating a
    // team, and the appended lines would both derail the reply and read as noise
    // in a transcript that person opens. Local app-chat sends the raw text; match it.
    if (trigger.kind === 'human_message') return envelope.body
    const fromName = trigger.fromAppId ? memberName(envelope.teamId, trigger.fromAppId) : null
    if (!fromName) return withDigest(`[Team run signal]\n\n${envelope.body}`, envelope)
    return withDigest(`[Team message from ${fromName}]\n\n${envelope.body}`, envelope)
  }

  /**
   * Record — and share with the office — that this member is (or is no longer)
   * waiting on its owner. Only the owning machine writes it: everywhere else the
   * row is a replica, and a second writer would fight the owner over a fact only
   * the owner can observe. Idempotent, so a repeated wake publishes nothing;
   * returns whether anything actually moved.
   */
  function publishAwaitingDecision(teamId: string, appId: string, awaiting: boolean): boolean {
    const member = store.getMember(teamId, appId)
    if (!member || isRemoteMember(member)) return false
    if (!!member.awaitingDecision === awaiting) return false
    store.updateMemberFields(teamId, appId, { awaitingDecision: awaiting })
    try {
      deps.onMemberProfileChanged?.(teamId, appId)
    } catch (err) {
      console.error(`${LOG_TAG} publishing awaiting-decision failed:`, err)
    }
    return true
  }

  /**
   * Recompute from the record whether this member still owes its own person an
   * answer, on the machine that owns it, and tell the office either way.
   *
   * The mark cannot be written only where an escalation is raised — that happens
   * inside `wakeTarget`'s completion, and most turns never pass through it: a
   * member woken by a teammate on another machine, an IM-backed team turn, a
   * person chatting a member 1:1. Each of those left a member that was blocked
   * on a human reading as idle everywhere, including on the one screen that
   * could have answered it. So the fact is DERIVED here from the persisted
   * escalation (which already outlives a seal and a restart) and a caller only
   * has to say "this member may have moved".
   *
   * Idempotent: nothing is written, published or announced when the answer is
   * unchanged, so it is safe on every turn end.
   */
  function reconcileAwaitingDecision(appId: string): void {
    // With no persisted record there is nothing to reconcile AGAINST, and
    // clearing a mark out of ignorance is worse than leaving it alone.
    if (!deps.hasPendingEscalation) return
    for (const member of store.listMembersByAppId(appId)) {
      if (isRemoteMember(member)) continue
      const awaiting = deps.hasPendingEscalation(appId, member.teamId)
      if (!publishAwaitingDecision(member.teamId, appId, awaiting)) continue
      console.log(
        `${LOG_TAG} awaiting-decision reconciled: team=${member.teamId} app=${appId} awaiting=${awaiting}`
      )
      emitTeamUpdated(member.teamId)
      notifyMemberStatusChanged(member.teamId)
    }
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
    publishAwaitingDecision(teamId, appId, true)
    emitTeamUpdated(teamId)
    // waiting_user is a member-status flip too → push it to viewers.
    notifyMemberStatusChanged(teamId)
  }

  // Wakes the escalating member via the team channel, which reactivates a sealed
  // epoch automatically. Where the outcome goes from there is the member's call:
  // the turn ending notifies nobody, so it must `team_send` whoever is waiting.
  function resumeFromEscalation(params: {
    teamId: string
    epochId: string
    appId: string
    taskId?: string
    response: string
    question?: string
  }): boolean {
    const { teamId, epochId, appId, taskId, response, question } = params
    const team = store.getTeamById(teamId)
    const epoch = store.getEpochById(epochId)
    if (!team || !epoch) return false

    // Clear the awaiting marker and bring a run epoch's team status back to
    // running (noteEpochTurn only restores status when the epoch was sealed).
    // Drop the epoch key once its last waiter is gone so resolved escalations
    // don't accumulate empty sets that getMemberStatus would keep scanning.
    const waiters = escalationWaiters.get(epochId)
    if (waiters) {
      waiters.delete(appId)
      if (waiters.size === 0) escalationWaiters.delete(epochId)
    }
    if (epoch.lifecycle === 'run' && team.status === 'waiting_user') {
      store.updateTeamStatus(teamId, 'running')
    }
    publishAwaitingDecision(teamId, appId, false)
    emitTeamUpdated(teamId)
    notifyMemberStatusChanged(teamId)

    const isLeadSelf = team.leadAppId === appId
    // Attributed to the lead so the member reads it as coming from its team,
    // not from nowhere.
    const fromAppId = isLeadSelf ? null : team.leadAppId ?? null
    const correlationId = randomUUID()
    // Written for two readers: the member, which needs the question to bind the
    // answer, and the person, for whom this is the member's visible transcript.
    const asked = question?.trim()
      ? `You asked: "${oneLineExcerpt(question, QUOTED_QUESTION_LIMIT)}"\n\n`
      : ''
    const body =
      '[The user answered your question]\n\n' +
      asked +
      `Their answer: ${response}\n\n` +
      'Continue from here. If a teammate is waiting on the outcome, send it to ' +
      'them with `team_send` — ending your turn does not notify anyone.'
    const envelope: TeamEnvelope = {
      id: randomUUID(),
      teamId,
      epochId,
      fromAppId: fromAppId ?? appId,
      toAppId: appId,
      body,
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
    // Buffered rather than dispatched when the member is mid-turn: losing this
    // wake would leave the digital human waiting on an answer it already got,
    // with nothing left to wake it again.
    void bus.deliverRuntimeWake({ envelope, trigger, onBusy: 'buffer' }).catch((err) => {
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
    publishEpoch(epoch.id)
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

  function ensureConversationEpoch(teamId: string, chatKey: string, title?: string): TeamEpoch {
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
      title: title?.trim() || null,
    }
    store.insertEpoch(epoch, 'event')
    // Conversation epochs intentionally do NOT set team.currentEpochId or
    // status='running'. currentEpochId is the single-RUN reentrancy/UI pointer;
    // conversation epochs are per-chat (many open at once) and must not occupy it
    // — otherwise chats would collide and scheduled runs would be blocked.
    publishEpoch(epoch.id)
    emitTeamUpdated(teamId)
    console.log(`${LOG_TAG} ensureConversationEpoch: team=${teamId} chat=${chatKey} epoch=${epoch.id} (new)`)
    return epoch
  }

  function renameConversationEpoch(teamId: string, epochId: string, title: string | null): void {
    const epoch = store.getEpochById(epochId)
    if (!epoch || epoch.teamId !== teamId) return
    store.renameEpoch(epochId, title?.trim() || null)
    publishEpoch(epochId)
    emitTeamUpdated(teamId)
    console.log(`${LOG_TAG} renameConversationEpoch: team=${teamId} epoch=${epochId}`)
  }

  function maybeAutoNameConversation(teamId: string, epochId: string, fromHuman: boolean, message: string): void {
    const epoch = store.getEpochById(epochId)
    // Only a still-untitled NATIVE conversation gets auto-named. Member/IM chats
    // already derive their label (member name / chat name); runs use a summary.
    if (
      !epoch ||
      epoch.teamId !== teamId ||
      epoch.lifecycle !== 'conversation' ||
      epoch.title ||
      !epoch.chatKey ||
      !isNativeConversationChatKey(epoch.chatKey)
    ) {
      return
    }
    // A conversation is named after what the PERSON said. Which member received
    // it is irrelevant — the user picks who to talk to, so keying on the lead
    // named threads started with anyone else after the first teammate envelope
    // reached the lead, i.e. "[Team message from …]".
    if (!fromHuman) return
    const title = deriveConversationTitle(message)
    if (!title) return
    store.renameEpoch(epochId, title)
    publishEpoch(epochId)
    emitTeamUpdated(teamId)
    console.log(`${LOG_TAG} auto-named conversation: team=${teamId} epoch=${epochId} title="${title}"`)
  }

  /**
   * Archive one epoch: stamp its end, tear down member team sessions (keeping
   * JSONL/sessionId for history), reset the bus, and clear quiescence timers.
   * Does NOT touch team.currentEpochId/status — callers decide that.
   */
  /**
   * Business outcome of a sealed run (P0-4): failure beats everything, a still-
   * waiting decision beats deliverables, deliverables beat "nothing to do".
   */
  function classifyRunOutcome(teamId: string, epochId: string, endReason: EpochEndReason): EpochOutcome {
    if (endReason === 'error' || endReason === 'timeout') return 'failed'
    const waiting =
      (escalationWaiters.get(epochId)?.size ?? 0) > 0 ||
      store.listMembersByTeam(teamId).some((m) => deps.hasPendingEscalation?.(m.appId, teamId))
    if (waiting) return 'escalation'
    const produced =
      store.listTasksByEpoch(teamId, epochId).some((t) => t.resultRef) ||
      store.listFindingsByEpoch(teamId, epochId).some((f) => f.ref)
    return produced ? 'output' : 'no_action'
  }

  async function archiveEpoch(
    teamId: string,
    epochId: string,
    endReason: EpochEndReason,
    summary: string | null
  ): Promise<void> {
    const epoch = store.getEpochById(epochId)
    const outcome =
      epoch?.lifecycle === 'run' ? classifyRunOutcome(teamId, epochId, endReason) : null
    store.endEpoch(epochId, Date.now(), endReason, summary, outcome)
    publishEpoch(epochId)

    for (const member of store.listMembersByTeam(teamId)) {
      try {
        await session.closeTeamSession(member.appId, teamId, epochId)
      } catch (err) {
        console.error(`${LOG_TAG} closeTeamSession failed for app=${member.appId}:`, err)
      }
    }

    bus.resetEpoch(epochId)

    try {
      deps.onEpochArchived?.(teamId, epochId, endReason)
    } catch (err) {
      console.error(`${LOG_TAG} onEpochArchived observer failed:`, err)
    }

    quiescenceNudgeCount.delete(epochId)
    // Escalation waiters deliberately SURVIVE the seal (P0-5): a decision the
    // user has not made yet keeps the member marked waiting_user (and the
    // attention chain alive) until it is answered — resumeFromEscalation clears
    // the marker and reactivates the epoch. The persisted activity entry is the
    // cross-restart truth; this set is only the live-window mirror.
    const qTimer = quiescenceTimers.get(epochId)
    if (qTimer) {
      clearTimeout(qTimer)
      quiescenceTimers.delete(epochId)
    }
  }

  function noteEpochTurn(teamId: string, epochId: string): void {
    const epoch = store.getEpochById(epochId)
    if (!epoch) return
    store.touchEpoch(epochId, Date.now())
    if (epoch.endedAt === null) return // already open — nothing to wake
    store.reopenEpoch(epochId)
    // Run epochs own the single-run pointer + team status; conversation epochs
    // never did, so leave those untouched.
    if (epoch.lifecycle === 'run') {
      store.updateTeamCurrentEpoch(teamId, epochId)
      store.updateTeamStatus(teamId, 'running')
    }
    publishEpoch(epochId)
    emitTeamUpdated(teamId)
    console.log(`${LOG_TAG} noteEpochTurn woke a sealed epoch: team=${teamId} epoch=${epochId} lifecycle=${epoch.lifecycle}`)
  }

  /**
   * Seal an EXACT epoch by id — the single implementation every seal path
   * funnels through, so a request scoped to one epoch (team_complete inside a
   * conversation, a deferred seal, a breach on a specific epoch) can never be
   * satisfied by archiving a different one. Only touches team.currentEpochId/
   * status when the sealed epoch IS the team's current run pointer; a
   * conversation epoch (or a run epoch that already stopped being current)
   * leaves that pointer untouched.
   */
  async function sealEpochById(
    teamId: string,
    epochId: string,
    endReason: EpochEndReason,
    summary: string | null
  ): Promise<void> {
    const epoch = store.getEpochById(epochId)
    if (!epoch || epoch.endedAt !== null) return

    console.log(`${LOG_TAG} sealEpochById: team=${teamId} epoch=${epochId} reason=${endReason}`)
    await archiveEpoch(teamId, epochId, endReason, summary)

    const team = store.getTeamById(teamId)
    if (team && team.currentEpochId === epochId) {
      store.updateTeamStatus(teamId, 'idle')
      store.updateTeamCurrentEpoch(teamId, null)
      emitTeamUpdated(teamId)
      // Propagate the rested run-state to joiners. The service-level pauseTeam
      // fires this too, but quiescence/breach auto-seal funnels only through
      // here — without this an auto-ended run leaves a joiner's members
      // spinning until the next throttled roster refresh. Observer-only;
      // never blocks or breaks the seal.
      notifyRunStateChanged(teamId)
    }
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
      notifyRunStateChanged(teamId)
      return
    }
    await sealEpochById(teamId, epoch.id, endReason, summary ?? null)
  }

  function notifyRunStateChanged(teamId: string): void {
    if (!onRunStateChanged) return
    try {
      onRunStateChanged(teamId)
    } catch (err) {
      console.error(`${LOG_TAG} onRunStateChanged observer failed:`, err)
    }
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
    await sealEpochById(teamId, epochId, endReason, summary ?? null)
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

  function buildPromptContext(teamId: string, selfAppId: string): TeamPromptContext | null {
    const team = store.getTeamById(teamId)
    if (!team) return null
    const members = store.listMembersByTeam(teamId)
    const self = members.find((m) => m.appId === selfAppId)
    if (!self) return null

    const roster = members
      .filter((m) => m.appId !== selfAppId)
      .map((m) => {
        const remote = isRemoteMember(m)
        return {
          memberName: m.memberName,
          role: m.role,
          duty: m.duty ?? null,
          isLead: m.isLead,
          contactable:
            team.collabMode === 'free' || store.isEdgeAllowed(teamId, selfAppId, m.appId),
          owner: remote ? m.ownerDisplayName ?? 'a teammate' : null,
          sameMachine: !remote,
        }
      })

    return {
      teamName: team.name,
      goal: team.goal,
      collabMode: team.collabMode,
      escalationRouting: team.escalationRouting,
      selfMemberName: self.memberName,
      selfRole: self.role,
      selfDuty: self.duty ?? null,
      selfIsLead: self.isLead,
      roster,
    }
  }

  // ── Live member status ─────────────────────────────────────────────────────

  function getMemberStatus(appId: string): TeamMemberRuntimeStatus {
    const memberships = store.listMembersByAppId(appId)
    for (const m of memberships) {
      // Awaiting a user decision takes precedence over working/idle — and it
      // SURVIVES a run seal (P0-5): the persisted activity entry is the truth,
      // the in-memory waiter set the live-window mirror (covers sealed epochs).
      // The owner's own record first: it is the only machine that can see the
      // question, and this is what the authority projects to everyone else.
      if (m.awaitingDecision) return 'waiting_user'
      if (deps.hasPendingEscalation?.(appId, m.teamId)) return 'waiting_user'
      for (const [epochId, waiters] of escalationWaiters) {
        if (waiters.has(appId) && store.getEpochById(epochId)?.teamId === m.teamId) {
          return 'waiting_user'
        }
      }
      // A member working ANY open epoch — a run OR a conversation — is lit
      // (P0-2). Previously only the run epoch counted, so a member serving an
      // IM chat looked idle on the board.
      for (const epoch of store.listOpenEpochs(m.teamId)) {
        if (session.isSessionActive(buildTeamSessionKey(appId, m.teamId, epoch.id))) {
          return 'working'
        }
      }
    }
    return 'idle'
  }

  /** Every open epoch this member is actively serving, with a human label (P0-2). */
  function getMemberBusy(appId: string, teamId: string): RosterBusyEntry[] {
    const out: RosterBusyEntry[] = []
    for (const epoch of store.listOpenEpochs(teamId)) {
      if (!session.isSessionActive(buildTeamSessionKey(appId, teamId, epoch.id))) continue
      out.push({
        epochId: epoch.id,
        kind: epoch.lifecycle,
        // Proper-noun labels only; category fallbacks (e.g. "Run") stay in the
        // renderer where translation lives.
        label:
          epoch.lifecycle === 'conversation'
            ? deriveConversationLabel(store, epoch, deps.describeChatKey)
            : '',
      })
    }
    return out
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  function memberName(teamId: string, appId: string): string {
    return store.getMember(teamId, appId)?.memberName ?? appId
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
    wakeForCheck,
    isBusy,
    startEpoch,
    ensureConversationEpoch,
    renameConversationEpoch,
    maybeAutoNameConversation,
    noteEpochTurn,
    sealEpoch,
    sealConversationEpoch,
    requestSeal,
    captureReport,
    buildPromptContext,
    getMemberStatus,
    getMemberBusy,
    noteMemberStatusChanged: notifyMemberStatusChanged,
    reconcileAwaitingDecision,
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
 * Rejects with TurnTimeoutError after `ms` if `promise` has not settled.
 * The caller (wakeTarget) is responsible for tearing down the underlying
 * turn on timeout — this wrapper only stops waiting for it.
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
