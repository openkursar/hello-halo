/**
 * Team runtime public API + module-level accessor.
 * Session deps use dynamic import by default to keep the static graph acyclic
 * (app-chat imports the accessor from here).
 */

import { createMessageBus } from './message-bus'
import { createBlackboard } from './blackboard'
import { createOrchestration } from './orchestration'
import { createTeamChecks } from './checks'
import { createBoardDigest } from './board-digest'
import { createBoardArchive } from './board-archive'
import { createTurnReport } from './turn-report'
import type { MemberTurnFate } from './turn-report'
import type { TeamChecks } from './checks'
import type { BoardDigest } from './board-digest'
import type { BoardArchive } from './board-archive'
import type { Orchestration, OrchestrationSessionDeps } from './orchestration'
import type { MessageBus, TurnCompletion, CircuitLimits } from './message-bus'
import type { Blackboard, BlackboardWriteRecord } from './blackboard'
import type { TeamPromptContext } from './team-prompt'
import type { ReadTeamArtifact } from './artifact-read'
import type { TeamStore } from '../../team'
import type {
  TeamEpoch,
  EpochEndReason,
  TeamRunTrigger,
  TeamMemberRuntimeStatus,
  RosterBusyEntry,
  TeamCheck,
  TeamDelegatedPolicy,
  TeamTriggerContext,
} from '../../../../shared/apps/team-types'
import { buildTeamSessionKey, TEAM_DEFAULT_TURN_TIMEOUT_MS } from '../../../../shared/apps/team-types'
import type { SchedulerService } from '../../../platform/scheduler'
import { parseTeamSessionKey, parseTeamChatKey } from '../../../../shared/apps/im-keys'
import type { ImSessionContext } from '../im-channels/im-prompt'
import { resolveImFileSend } from '../im-channels/file-send-resolve'
import type { FileSendFn } from '../im-channels/file-send-mcp'
import type { ImChannelInstance } from '../../../../shared/types/im-channel'
import { isAppChatConversationGenerating, injectIntoAppChat } from '../app-chat-live-turn'
import { getAppManager } from '../../manager'
import { getSpaceDir } from '../../../services/space.service'

const LOG_TAG = '[TeamRuntime]'

/**
 * Everything that makes a turn an IM-fronted turn: how to frame it, what it may
 * do in that chat, and where its reply goes.
 */
interface ImRoute {
  instance: Pick<ImChannelInstance, 'pushToChat'>
  chatId: string
  chatType: 'direct' | 'group'
  imSession: ImSessionContext
  /** Undefined for a text-only channel — the same answer dispatch-inbound gets. */
  imFileSend: FileSendFn | undefined
}

/**
 * If `conversationId` is the session of the member that FRONTS a team-backed IM
 * chat, resolve how to frame + push that turn's reply to that chat. Returns null
 * for every other member's turns, non-conversation epochs, or when the IM
 * instance is gone — those turns stay internal (no IM side effects).
 *
 * The front desk is whoever the IM instance binds, so the instance config is the
 * authority here — not the team's lead. Reading it also keeps a woken reply from
 * escaping to a chat whose binding has since been re-pointed elsewhere.
 *
 * The route resolves the chat's file-send capability for the same reason it
 * resolves the framing: this turn shares a session with the inbound turns of
 * that chat, and a session is rebuilt whenever its tool set changes. Resolving
 * one and not the other made every woken turn rebuild its session mid-start,
 * which killed the turn instead of merely disabling a tool.
 *
 * @param spaceDir - The member's working directory, bounding what may be sent.
 */
async function resolveImRoute(
  store: TeamStore,
  appId: string,
  conversationId: string,
  spaceDir: string
): Promise<ImRoute | null> {
  const parsed = parseTeamSessionKey(conversationId)
  if (!parsed) return null
  const epoch = store.getEpochById(parsed.epochId)
  if (!epoch || epoch.lifecycle !== 'conversation' || !epoch.chatKey) return null
  const target = parseTeamChatKey(epoch.chatKey)
  if (!target) return null

  const { getActiveImChannelManager } = await import('../im-channels')
  const channels = getActiveImChannelManager()
  const cfg = channels?.getInstanceConfig(target.instanceId)
  if (!cfg || cfg.teamId !== parsed.teamId || cfg.appId !== appId) return null
  const instance = channels?.getInstance(target.instanceId)
  if (!instance) return null

  // Display name for the bridge framing: prefer the registered IM session name.
  let displayName = target.chatId
  try {
    const { getImSessionRegistry } = await import('../im-session-registry')
    const sess = getImSessionRegistry()?.findSession(appId, instance.providerType, target.chatId)
    displayName = sess?.customName || sess?.displayName || target.chatId
  } catch {
    /* registry optional — fall back to chatId */
  }

  return {
    instance,
    chatId: target.chatId,
    chatType: target.chatType,
    imSession: {
      channel: instance.providerType,
      chatType: target.chatType,
      displayName,
      sessionId: `${target.instanceId}:${target.chatId}`,
    },
    imFileSend: resolveImFileSend({
      instanceId: target.instanceId,
      chatId: target.chatId,
      chatType: target.chatType,
      spaceDir,
    }),
  }
}

export interface TeamRuntime {
  bus: MessageBus
  blackboard: Blackboard
  /** Periodic checks: set/stop/inspect the standing instructions in this office. */
  checks: TeamChecks
  /** What a member missed, rendered into its turn input and its board reads. */
  digest: BoardDigest
  /** The full record behind a bounded board read, exported when one is truncated. */
  archive: BoardArchive
  /**
   * What a TEAMMATE may make this member do, as its owner set it. Null =
   * unrestricted. Read by the chat entry point when a turn was started by
   * someone other than the owner; never shown to teammates.
   */
  getDelegatedPolicy(teamId: string, appId: string): TeamDelegatedPolicy | null
  /** Location-transparent read of a published team artifact (see {@link ReadTeamArtifact}). */
  readArtifact?: ReadTeamArtifact
  /**
   * A member's live runtime status (idle/working/waiting_user/error) on this node,
   * derived from its active team sessions. Read-only projection consumed by the
   * federation roster egress so a joiner animates the working pulse in step with
   * the host; never mutates orchestration state.
   */
  getMemberStatus(appId: string): TeamMemberRuntimeStatus
  /** Live busy assignments (open run/conversations being served) with human labels. */
  getMemberBusy(appId: string, teamId: string): RosterBusyEntry[]
  /**
   * Announce that a member's live status may have moved, for a turn the team
   * orchestration did not run itself (a 1:1 chat, an IM-backed turn). Status is
   * derived from the session ledger, so a missed announcement latches 'working'
   * until the next re-baseline — which only a HOSTED office gets. Read-through:
   * announce AFTER the ledger write, never before.
   */
  noteMemberStatusChanged(teamId: string): void
  /**
   * A member's team-channel turn began on this machine. Opens the window its
   * acts are counted in, so the turn-end report can tell "filed nothing" apart
   * from "was not watched" (see `turn-report.ts`).
   */
  noteMemberTurnStarted(params: { appId: string; teamId: string; epochId: string }): void
  /**
   * …and ended, however it ended — normally, on an error, or killed by hand.
   * This is what tells the lead a teammate stopped when the teammate itself did
   * not say so; without it the run goes quiet and nothing looks. Called from the
   * one point every team turn converges on, so it covers the paths the team
   * orchestration never sees (a person's chat, a relayed turn, an IM-backed one).
   */
  noteMemberTurnEnded(params: {
    appId: string
    teamId: string
    epochId: string
    fate: MemberTurnFate
    correlationId?: string
    triggerKind?: TeamTriggerContext['kind']
  }): void
  /**
   * Re-derive whether a member owned by this machine still owes its own person
   * an answer, and share the result with the office. Only the owner can see the
   * question, and only some turn paths route an escalation — so the fact is
   * recomputed from the persisted record wherever a turn ends (and at startup)
   * rather than written where the escalation happened to be raised. Idempotent:
   * an unchanged answer writes, publishes and announces nothing.
   */
  reconcileAwaitingDecision(appId: string): void
  startEpoch(teamId: string, trigger?: TeamRunTrigger): Promise<TeamEpoch>
  /** Get/create a per-chat long-lived 'conversation' epoch (message-driven entries, e.g. IM). */
  ensureConversationEpoch(teamId: string, chatKey: string, title?: string): TeamEpoch
  /** Rename a conversation epoch (captured + replicated office-wide). */
  renameConversationEpoch(teamId: string, epochId: string, title: string | null): void
  /** Auto-name an untitled native conversation from the person's first message. */
  maybeAutoNameConversation(teamId: string, epochId: string, fromHuman: boolean, message: string): void
  /** A turn is entering this epoch: stamp its activity, and wake it if hibernated. */
  noteEpochTurn(teamId: string, epochId: string): void
  sealEpoch(teamId: string, endReason: EpochEndReason, summary?: string | null): Promise<void>
  /** Seal a single conversation epoch (e.g. an IM chat cleared by the user). */
  sealConversationEpoch(teamId: string, epochId: string, endReason?: EpochEndReason, summary?: string | null): Promise<void>
  requestSeal(teamId: string, epochId: string, summary: string): void
  captureReport(correlationId: string, outcome: TurnCompletion): void
  /** The team layers of a member's system prompt — stable per (team, member). */
  buildPromptContext(teamId: string, selfAppId: string): TeamPromptContext | null
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
    /** Several may be open at once; without it an answer binds to the wrong one. */
    question?: string
  }): boolean
}

export interface CreateTeamRuntimeDeps {
  store: TeamStore
  session?: OrchestrationSessionDeps
  circuitOverrides?: Partial<CircuitLimits>
  syncWaitTimeoutMs?: number
  turnTimeoutMs?: number
  /** Cap on team member turns running at once on this machine. Passed through to orchestration. */
  maxConcurrentTurns?: number
  /**
   * Replication capture: fired after each authoritative local blackboard write
   * so the federation layer can sequence and replicate it to hot-standbys.
   * Notification-only; absent → no replication.
   */
  onBlackboardWrite?: (record: BlackboardWriteRecord) => void
  /**
   * Location-aware blackboard decorator: wraps the kernel blackboard so writes
   * for a JOINED (shadow) office are routed to the authority as `blackboard-write`
   * frames instead of being authored locally (single-writer). Absent → the kernel
   * blackboard is used directly (the authority's own writes).
   */
  wrapBlackboard?: (base: Blackboard) => Blackboard
  /**
   * Observer fired after a run epoch is sealed (manual / quiescence auto-seal /
   * breach). Bootstrap wires it to the federation roster egress so a joiner's
   * run-state rests promptly even when the seal does not go through the
   * service-level pauseTeam. Additive only — does not change seal semantics.
   */
  onRunStateChanged?: (teamId: string) => void
  /**
   * Status overlay consulted when the local session ledger reports a member
   * idle. Bootstrap wires it to the federation manager's remote-busy view, so a
   * member whose turn is in flight on a REMOTE owner still pulses 'working' on
   * boards and roster projections. Absent → local sessions are the only source.
   */
  getMemberStatusOverlay?: (appId: string) => TeamMemberRuntimeStatus | null
  /**
   * Observer fired when a member's live status flips (turn start/end, escalation
   * raised/resolved). Bootstrap wires it to the federation roster refresh so
   * viewers see pulses start AND stop in step. Absent → no propagation.
   */
  onMemberStatusChanged?: (teamId: string) => void
  /** A member's owner-authored profile changed → share it with the office. */
  onMemberProfileChanged?: (teamId: string, appId: string) => void
  /**
   * Immediate reachability of a member's owner at send time (bootstrap wires it to
   * the federation manager). Drives the async send's honest "not delivered" gate.
   * Absent → all members treated as reachable (non-federated runtime).
   */
  checkMemberReachable?: (appId: string, teamId: string) => boolean
  /**
   * Location-transparent published-artifact reader (bootstrap wires it to the
   * space service + federation manager). Powers the `team_read_artifact` tool.
   * Absent → the tool reports the capability is unavailable.
   */
  readArtifact?: ReadTeamArtifact
  /**
   * Epoch lifecycle replication capture (open/seal/reopen/rename/outcome).
   * Bootstrap wires it to the federation authority write log so conversations
   * and run history converge office-wide (P0-1). Absent → no replication.
   */
  onEpochMutation?: (epoch: TeamEpoch) => void
  /**
   * Persisted unanswered-escalation check (activity store), so waiting_user
   * survives a run seal and a restart (P0-5). Absent → in-memory only.
   */
  hasPendingEscalation?: (appId: string, teamId: string) => boolean
  /** Human name for an IM chatKey (IM session registry). Absent → raw chat id. */
  describeChatKey?: (teamId: string, chatKey: string) => string | null
  /**
   * The platform scheduler that rings periodic checks for locally-owned members.
   * Absent → checks are still recorded and shared, but nothing wakes (test runtimes).
   */
  scheduler?: SchedulerService | null
  /**
   * Share a periodic-check change office-wide (bootstrap routes it onto the
   * federation replication plane). Absent → single-machine team.
   */
  publishCheck?: (change: { op: 'upsert' | 'delete'; check: TeamCheck }) => void
  /** A team's periodic checks changed → refresh any open board. */
  onChecksChanged?: (teamId: string) => void
  /**
   * The turn-end report's busy probe. See `TurnReportDeps.isLeadGenerating`
   * for what it must be and why. Required, not optional: `createTeamRuntime`
   * has exactly one production caller (`bootstrap/extended.ts`) and no test
   * caller at all, so an optional field with a silent fallback here is
   * precisely what let this dependency go unwired — and unnoticed — before.
   * A caller that forgets to pass it now gets a type error, not a silently
   * dead busy-gate.
   */
  isLeadGenerating: (sessionKey: string) => boolean
}

export function createTeamRuntime(deps: CreateTeamRuntimeDeps): TeamRuntime {
  const { store } = deps
  const session = deps.session ?? createDefaultSessionDeps(store)

  // Late-bound: bus is created first, orchestration hooks are forwarded once wired.
  let orchestration: Orchestration | null = null
  // Checks are built last (they wake through orchestration) but orchestration
  // must end their epoch's checks on seal — the same forward-shim trick.
  let checks: TeamChecks | null = null
  // The bus records every message it carries, but the board it records onto is
  // built after it (the board's roster projection reads orchestration state).
  // Same forward shim: acts before the board exists are dropped, and none can —
  // no message can be sent before the runtime finishes constructing.
  let board: Blackboard | null = null

  const digest = createBoardDigest({ store })
  const archive = createBoardArchive({ store })
  // Printouts are regenerated on demand, so anything left from an earlier run is
  // dead weight — cleared here rather than on a timer nobody would own.
  archive.sweep()

  const bus = createMessageBus({
    store,
    recordActivity: (input) => board?.postActivity(input),
    hooks: {
      wakeTarget: (params) => {
        if (!orchestration) throw new Error('Team orchestration not initialized')
        return orchestration.wakeTarget(params)
      },
      isBusy: (sessionKey) => (orchestration ? orchestration.isBusy(sessionKey) : false),
      deliverMidTurn: (params) => (orchestration ? orchestration.deliverMidTurn(params) : false),
      ...(deps.checkMemberReachable ? { checkReachable: deps.checkMemberReachable } : {}),
    },
    circuitOverrides: deps.circuitOverrides,
    syncWaitTimeoutMs: deps.syncWaitTimeoutMs,
    // The slot is held for the WHOLE turn, including the wait for a concurrency
    // slot — both of which the turn timeout already bounds. One timeout of grace
    // on top keeps the reclaim clear of a turn that is legitimately finishing.
    reservationTtlMs: (deps.turnTimeoutMs ?? TEAM_DEFAULT_TURN_TIMEOUT_MS) * 2,
  })

  // No forward shim needed here (unlike the bus's own `hooks.isBusy` above):
  // `isLeadGenerating` does not depend on `orchestration`, so it is available
  // before that is constructed.
  const turnReport = createTurnReport({ store, bus, isLeadGenerating: deps.isLeadGenerating })

  orchestration = createOrchestration({
    store,
    bus,
    session,
    turnTimeoutMs: deps.turnTimeoutMs,
    maxConcurrentTurns: deps.maxConcurrentTurns,
    onRunStateChanged: deps.onRunStateChanged,
    onMemberStatusChanged: deps.onMemberStatusChanged,
    onMemberProfileChanged: deps.onMemberProfileChanged,
    onEpochMutation: deps.onEpochMutation,
    hasPendingEscalation: deps.hasPendingEscalation,
    describeChatKey: deps.describeChatKey,
    renderDigest: (teamId, epochId, viewerAppId) => digest.render({ teamId, epochId, viewerAppId }),
    noteTurnEnded: (input) => turnReport.noteTurnEnded(input),
    // A 'stopped' epoch (pause) is reopenable — noteEpochTurn wakes it back up
    // on the next message — so its periodic checks must survive the seal.
    // Every other end reason (completed/timeout/error) really is final.
    onEpochArchived: (teamId, epochId, endReason) => {
      if (endReason !== 'stopped') checks?.clearEpoch(teamId, epochId)
      digest.clearEpoch(epochId)
      archive.clearEpoch(epochId)
      turnReport.clearEpoch(epochId)
    },
  })

  checks = createTeamChecks({
    store,
    scheduler: deps.scheduler ?? null,
    wake: (params) => orchestration!.wakeForCheck(params),
    // The gate's answer, not the session probe: a round waking a member whose
    // slot is already reserved is refused one layer down anyway, and counting it
    // as "target was free" put a round in the log that never ran.
    isBusy: (teamId, epochId, appId) =>
      orchestration!.isSessionOccupied(buildTeamSessionKey(appId, teamId, epochId)),
    ...(deps.publishCheck ? { publish: deps.publishCheck } : {}),
    ...(deps.onChecksChanged ? { onChanged: deps.onChecksChanged } : {}),
    ...(deps.checkMemberReachable ? { isReachable: deps.checkMemberReachable } : {}),
  })

  // Local sessions first; when they say idle, fold in the injected overlay so a
  // member running its turn on a REMOTE owner still reads 'working' here.
  function memberStatus(appId: string): TeamMemberRuntimeStatus {
    const local = orchestration!.getMemberStatus(appId)
    if (local !== 'idle') return local
    return deps.getMemberStatusOverlay?.(appId) ?? 'idle'
  }

  const baseBlackboard = createBlackboard({
    store,
    getMemberStatus: memberStatus,
    getMemberBusy: (appId, teamId) => orchestration!.getMemberBusy(appId, teamId),
    // Reuse the same reachability seam the bus uses for its honest-delivery gate,
    // so the roster's presence column and delivery decisions agree.
    ...(deps.checkMemberReachable ? { getMemberReachable: deps.checkMemberReachable } : {}),
    getChecks: (teamId, epochId) => checks!.viewForEpoch(teamId, epochId),
    onWrite: deps.onBlackboardWrite,
  })
  // The location-aware decorator (if injected) routes shadow-office writes to the
  // authority; the authority's own runtime gets the kernel blackboard unwrapped.
  const routedBlackboard = deps.wrapBlackboard ? deps.wrapBlackboard(baseBlackboard) : baseBlackboard
  // Acts are counted where they are FILED, outside the routing decision above: on
  // a joined office a member's write travels to the authority and comes back
  // replicated, so reading the store at its turn's end can still show nothing.
  // Watching the call is the only observation true on every machine.
  const blackboard: Blackboard = {
    ...routedBlackboard,
    postActivity: (input) => {
      turnReport.noteAct(input)
      return routedBlackboard.postActivity(input)
    },
  }
  board = blackboard

  console.log(`${LOG_TAG} created`)

  return {
    bus,
    blackboard,
    checks,
    digest,
    archive,
    getDelegatedPolicy: (teamId, appId) => store.getMember(teamId, appId)?.delegatedPolicy ?? null,
    ...(deps.readArtifact ? { readArtifact: deps.readArtifact } : {}),
    getMemberStatus: memberStatus,
    getMemberBusy: (appId, teamId) => orchestration!.getMemberBusy(appId, teamId),
    noteMemberStatusChanged: (teamId) => orchestration!.noteMemberStatusChanged(teamId),
    noteMemberTurnStarted: (params) => turnReport.noteTurnStarted(params),
    noteMemberTurnEnded: (params) => turnReport.noteTurnEnded(params),
    reconcileAwaitingDecision: (appId) => orchestration!.reconcileAwaitingDecision(appId),
    startEpoch: (teamId, trigger) => orchestration!.startEpoch(teamId, trigger),
    ensureConversationEpoch: (teamId, chatKey, title) =>
      orchestration!.ensureConversationEpoch(teamId, chatKey, title),
    renameConversationEpoch: (teamId, epochId, title) =>
      orchestration!.renameConversationEpoch(teamId, epochId, title),
    maybeAutoNameConversation: (teamId, epochId, fromHuman, message) =>
      orchestration!.maybeAutoNameConversation(teamId, epochId, fromHuman, message),
    noteEpochTurn: (teamId, epochId) => orchestration!.noteEpochTurn(teamId, epochId),
    sealEpoch: (teamId, reason, summary) => orchestration!.sealEpoch(teamId, reason, summary),
    sealConversationEpoch: (teamId, epochId, reason, summary) =>
      orchestration!.sealConversationEpoch(teamId, epochId, reason, summary),
    requestSeal: (teamId, epochId, summary) => orchestration!.requestSeal(teamId, epochId, summary),
    captureReport: (correlationId, outcome) => orchestration!.captureReport(correlationId, outcome),
    buildPromptContext: (teamId, selfAppId) =>
      orchestration!.buildPromptContext(teamId, selfAppId),
    resumeFromEscalation: (params) => orchestration!.resumeFromEscalation(params),
  }
}

export function createDefaultSessionDeps(store: TeamStore): OrchestrationSessionDeps {
  return {
    async sendAppChatMessage(request) {
      const { sendAppChatMessage } = await import('../app-chat')

      // For a team-backed IM conversation epoch, the bound member is the chat's
      // front desk: its orchestration-driven turns (e.g. a teammate's team_send
      // reply waking it) must be framed for, and pushed back to, that IM chat —
      // the person's direct turn already gets this in dispatch-inbound, but later
      // woken turns would otherwise have no user-facing sink. Every other
      // member's woken turns stay internal.
      const imRoute = await resolveImRoute(
        store,
        request.appId,
        request.conversationId,
        getSpaceDir(request.spaceId)
      )

      // Held in a box, not a `let`: the assignment happens inside `onReply`, which
      // TypeScript's flow analysis does not see, so a plain local reads as `null`
      // below and silently types the IM push away.
      const captured: { reply: string | null } = { reply: null }
      await sendAppChatMessage({
        appId: request.appId,
        spaceId: request.spaceId,
        message: request.message,
        conversationId: request.conversationId,
        teamContext: request.teamContext,
        // Both halves of the IM route, or neither: the framing and the tool set
        // must match what dispatch-inbound gives this same session.
        ...(imRoute ? { imSession: imRoute.imSession, imFileSend: imRoute.imFileSend } : {}),
        onReply: (finalContent) => {
          captured.reply = finalContent
        },
      })

      const finalMessage = captured.reply
      if (imRoute && finalMessage && finalMessage.trim()) {
        try {
          await imRoute.instance.pushToChat(imRoute.chatId, finalMessage, imRoute.chatType)
        } catch (err) {
          console.error(`${LOG_TAG} failed to push front-desk reply to IM chat:`, err)
        }
      }
      return { finalMessage }
    },
    isSessionActive(sessionKey) {
      // A team turn runs through app-chat's consumer model, which never writes
      // the legacy `activeSessions` map — asking that map answered `false` for
      // every team session that has ever run. Nothing failed loudly: the gate's
      // reservation still queued mail correctly, so the only visible effect was
      // everything this probe is FOR quietly not happening (mid-turn delivery
      // refused, quiescence counting a streaming member as idle, the slot
      // watchdog willing to reclaim a session mid-stream).
      //
      // Same source as `isLeadGenerating`, which bootstrap already wires to the
      // truthful probe — one answer to "is this session busy", not two.
      return isAppChatConversationGenerating(sessionKey)
    },
    injectIntoSession(sessionKey, message) {
      // Statically imported, unlike app-chat above: this must answer within the
      // caller's synchronous window, and it is a leaf module (the live session
      // plus the transcript sink) that closes no cycle with the team runtime.
      return injectIntoAppChat(sessionKey, message)
    },
    async closeTeamSession(appId, teamId, epochId) {
      const { closeTeamSession } = await import('../app-chat')
      await closeTeamSession(appId, teamId, epochId)
    },
    getMemberSpaceId(appId) {
      const app = getAppManager()?.getApp(appId)
      return app?.spaceId ?? null
    },
  }
}

// ── Module-level accessor ──

let _activeRuntime: TeamRuntime | null = null

export function setActiveTeamRuntime(runtime: TeamRuntime | null): void {
  _activeRuntime = runtime
}

export function getActiveTeamRuntime(): TeamRuntime | null {
  return _activeRuntime
}

export { buildTeamSessionKey }
export type { Orchestration, OrchestrationSessionDeps } from './orchestration'
export type { Blackboard, BlackboardWriteRecord } from './blackboard'
export type { MessageBus, TurnCompletion } from './message-bus'
export { createTeamArtifactReader, createLocalArtifactResolver, RemoteArtifactError } from './artifact-read'
export type { ReadTeamArtifact, TeamArtifactReadResult, RemoteArtifactFailure } from './artifact-read'
export { resolveArtifactRef } from './artifact-path'
export type { ArtifactRefResolution, ArtifactRefRejection } from './artifact-path'
export { createTeamTriggerScheduler, TEAM_JOB_KIND } from './team-triggers'
export type { TeamTriggerScheduler } from './team-triggers'
export { TEAM_CHECK_JOB_KIND, TeamCheckError, describeSchedule, renderCheckWake } from './checks'
export type { TeamChecks } from './checks'
export { createBoardDigest } from './board-digest'
export type { BoardDigest } from './board-digest'
export { createBoardArchive } from './board-archive'
export type { BoardArchive } from './board-archive'
export { createTurnReport } from './turn-report'
export type { TurnReport, MemberTurnFate } from './turn-report'
export { renderBoardMarkdown } from './board-render'
