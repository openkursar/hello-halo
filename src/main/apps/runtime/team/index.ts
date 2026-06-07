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
import type { Blackboard } from './blackboard'
import type { TeamPromptContext } from './team-prompt'
import type { TeamStore } from '../../team'
import type {
  TeamEpoch,
  EpochEndReason,
  TeamTriggerContext,
  TeamRunTrigger,
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
  startEpoch(teamId: string, trigger?: TeamRunTrigger): Promise<TeamEpoch>
  /** Get/create a per-chat long-lived 'conversation' epoch (message-driven entries, e.g. IM). */
  ensureConversationEpoch(teamId: string, chatKey: string): TeamEpoch
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
    },
    circuitOverrides: deps.circuitOverrides,
    syncWaitTimeoutMs: deps.syncWaitTimeoutMs,
  })

  orchestration = createOrchestration({
    store,
    bus,
    session,
    turnTimeoutMs: deps.turnTimeoutMs,
  })

  const blackboard = createBlackboard({
    store,
    getMemberStatus: (appId) => orchestration!.getMemberStatus(appId),
  })

  console.log(`${LOG_TAG} created`)

  return {
    bus,
    blackboard,
    startEpoch: (teamId, trigger) => orchestration!.startEpoch(teamId, trigger),
    ensureConversationEpoch: (teamId, chatKey) => orchestration!.ensureConversationEpoch(teamId, chatKey),
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

function createDefaultSessionDeps(store: TeamStore): OrchestrationSessionDeps {
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
export { createTeamTriggerScheduler, TEAM_JOB_KIND } from './team-triggers'
export type { TeamTriggerScheduler } from './team-triggers'
