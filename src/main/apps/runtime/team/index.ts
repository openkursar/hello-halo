/**
 * Team runtime public API + module-level accessor.
 * Session deps use dynamic import by default to keep the static graph acyclic
 * (app-chat imports the accessor from here).
 */

import { createMessageBus } from './message-bus'
import { createBlackboard } from './blackboard'
import { createOrchestration } from './orchestration'
import type { Orchestration, OrchestrationSessionDeps } from './orchestration'
import type { MessageBus, TurnCompletion, CircuitLimits } from './message-bus'
import type { Blackboard, BlackboardWriteRecord } from './blackboard'
import type { TeamPromptContext } from './team-prompt'
import type { ReadTeamArtifact } from './artifact-read'
import type { TeamStore } from '../../team'
import type {
  TeamEpoch,
  EpochEndReason,
  TeamTriggerContext,
  TeamRunTrigger,
  TeamMemberRuntimeStatus,
  RosterBusyEntry,
} from '../../../../shared/apps/team-types'
import { buildTeamSessionKey } from '../../../../shared/apps/team-types'
import { parseTeamSessionKey, parseTeamChatKey } from '../../../../shared/apps/im-keys'
import type { ImSessionContext } from '../im-channels/im-prompt'
import { activeSessions } from '../../../services/agent/session-manager'
import { getAppManager } from '../../manager'

const LOG_TAG = '[TeamRuntime]'

/** Resolved IM push target for a team LEAD serving an IM conversation epoch. */
interface ImRoute {
  instance: { pushToChat(chatId: string, text: string, chatType: 'direct' | 'group'): Promise<boolean> }
  chatId: string
  chatType: 'direct' | 'group'
  imSession: ImSessionContext
}

/**
 * If `conversationId` is the LEAD's session in a team-backed IM conversation
 * epoch, resolve how to frame + push that turn's reply to the IM chat. Returns
 * null for member turns, non-conversation epochs, or when the IM instance is
 * gone — those turns stay internal (no IM side effects).
 */
async function resolveImRoute(
  store: TeamStore,
  appId: string,
  conversationId: string
): Promise<ImRoute | null> {
  const parsed = parseTeamSessionKey(conversationId)
  if (!parsed) return null
  const team = store.getTeamById(parsed.teamId)
  // Only the lead is the chat's front desk; members stay internal.
  if (!team || team.leadAppId !== appId) return null
  const epoch = store.getEpochById(parsed.epochId)
  if (!epoch || epoch.lifecycle !== 'conversation' || !epoch.chatKey) return null
  const target = parseTeamChatKey(epoch.chatKey)
  if (!target) return null

  const { getActiveImChannelManager } = await import('../im-channels')
  const instance = getActiveImChannelManager()?.getInstance(target.instanceId)
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
  }
}

export interface TeamRuntime {
  bus: MessageBus
  blackboard: Blackboard
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
  startEpoch(teamId: string, trigger?: TeamRunTrigger): Promise<TeamEpoch>
  /** Get/create a per-chat long-lived 'conversation' epoch (message-driven entries, e.g. IM). */
  ensureConversationEpoch(teamId: string, chatKey: string, title?: string): TeamEpoch
  /** Rename a conversation epoch (captured + replicated office-wide). */
  renameConversationEpoch(teamId: string, epochId: string, title: string | null): void
  /** Auto-name an untitled native conversation from the lead's first user message. */
  maybeAutoNameConversation(teamId: string, epochId: string, appId: string, message: string): void
  /** Reversible seal: wake a hibernated epoch when re-engaged (no-op if already open). */
  reactivateEpoch(teamId: string, epochId: string): void
  sealEpoch(teamId: string, endReason: EpochEndReason, summary?: string | null): Promise<void>
  /** Seal a single conversation epoch (e.g. an IM chat cleared by the user). */
  sealConversationEpoch(teamId: string, epochId: string, endReason?: EpochEndReason, summary?: string | null): Promise<void>
  requestSeal(teamId: string, epochId: string, summary: string): void
  captureReport(correlationId: string, outcome: TurnCompletion): void
  buildPromptContext(trigger: TeamTriggerContext, selfAppId: string): TeamPromptContext | null
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

export interface CreateTeamRuntimeDeps {
  store: TeamStore
  session?: OrchestrationSessionDeps
  circuitOverrides?: Partial<CircuitLimits>
  syncWaitTimeoutMs?: number
  turnTimeoutMs?: number
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
  /**
   * Immediate reachability of a member's owner at send time (bootstrap wires it to
   * the federation manager). Drives the wait=false honest "not delivered" gate.
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
}

export function createTeamRuntime(deps: CreateTeamRuntimeDeps): TeamRuntime {
  const { store } = deps
  const session = deps.session ?? createDefaultSessionDeps(store)

  // Late-bound: bus is created first, orchestration hooks are forwarded once wired.
  let orchestration: Orchestration | null = null

  const bus = createMessageBus({
    store,
    hooks: {
      wakeTarget: (params) => {
        if (!orchestration) throw new Error('Team orchestration not initialized')
        return orchestration.wakeTarget(params)
      },
      isBusy: (sessionKey) => (orchestration ? orchestration.isBusy(sessionKey) : false),
      ...(deps.checkMemberReachable ? { checkReachable: deps.checkMemberReachable } : {}),
    },
    circuitOverrides: deps.circuitOverrides,
    syncWaitTimeoutMs: deps.syncWaitTimeoutMs,
  })

  orchestration = createOrchestration({
    store,
    bus,
    session,
    turnTimeoutMs: deps.turnTimeoutMs,
    onRunStateChanged: deps.onRunStateChanged,
    onMemberStatusChanged: deps.onMemberStatusChanged,
    onEpochMutation: deps.onEpochMutation,
    hasPendingEscalation: deps.hasPendingEscalation,
    describeChatKey: deps.describeChatKey,
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
    onWrite: deps.onBlackboardWrite,
  })
  // The location-aware decorator (if injected) routes shadow-office writes to the
  // authority; the authority's own runtime gets the kernel blackboard unwrapped.
  const blackboard = deps.wrapBlackboard ? deps.wrapBlackboard(baseBlackboard) : baseBlackboard

  console.log(`${LOG_TAG} created`)

  return {
    bus,
    blackboard,
    ...(deps.readArtifact ? { readArtifact: deps.readArtifact } : {}),
    getMemberStatus: memberStatus,
    getMemberBusy: (appId, teamId) => orchestration!.getMemberBusy(appId, teamId),
    startEpoch: (teamId, trigger) => orchestration!.startEpoch(teamId, trigger),
    ensureConversationEpoch: (teamId, chatKey, title) =>
      orchestration!.ensureConversationEpoch(teamId, chatKey, title),
    renameConversationEpoch: (teamId, epochId, title) =>
      orchestration!.renameConversationEpoch(teamId, epochId, title),
    maybeAutoNameConversation: (teamId, epochId, appId, message) =>
      orchestration!.maybeAutoNameConversation(teamId, epochId, appId, message),
    reactivateEpoch: (teamId, epochId) => orchestration!.reactivateEpoch(teamId, epochId),
    sealEpoch: (teamId, reason, summary) => orchestration!.sealEpoch(teamId, reason, summary),
    sealConversationEpoch: (teamId, epochId, reason, summary) =>
      orchestration!.sealConversationEpoch(teamId, epochId, reason, summary),
    requestSeal: (teamId, epochId, summary) => orchestration!.requestSeal(teamId, epochId, summary),
    captureReport: (correlationId, outcome) => orchestration!.captureReport(correlationId, outcome),
    buildPromptContext: (trigger, selfAppId) =>
      orchestration!.buildPromptContext(trigger, selfAppId),
    resumeFromEscalation: (params) => orchestration!.resumeFromEscalation(params),
  }
}

export function createDefaultSessionDeps(store: TeamStore): OrchestrationSessionDeps {
  return {
    async sendAppChatMessage(request) {
      const { sendAppChatMessage } = await import('../app-chat')

      // For a team-backed IM conversation epoch, the LEAD is the chat's front
      // desk: its orchestration-driven turns (e.g. a member's wait=false reply
      // waking it) must be framed for, and pushed back to, that IM chat — the
      // user's direct turn already gets this in dispatch-inbound, but later
      // woken turns would otherwise have no user-facing sink. Members' woken
      // turns (not the lead) stay internal.
      const imRoute = await resolveImRoute(store, request.appId, request.conversationId)

      let finalMessage: string | null = null
      await sendAppChatMessage({
        appId: request.appId,
        spaceId: request.spaceId,
        message: request.message,
        conversationId: request.conversationId,
        teamContext: request.teamContext,
        ...(imRoute ? { imSession: imRoute.imSession } : {}),
        onReply: (finalContent) => {
          finalMessage = finalContent
        },
      })

      if (imRoute && finalMessage && finalMessage.trim()) {
        try {
          await imRoute.instance.pushToChat(imRoute.chatId, finalMessage, imRoute.chatType)
        } catch (err) {
          console.error(`${LOG_TAG} failed to push lead reply to IM chat:`, err)
        }
      }
      return { finalMessage }
    },
    isSessionActive(sessionKey) {
      return activeSessions.has(sessionKey)
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
export { createTeamTriggerScheduler, TEAM_JOB_KIND } from './team-triggers'
export type { TeamTriggerScheduler } from './team-triggers'
