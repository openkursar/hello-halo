import { randomUUID } from 'crypto'
import { buildTeamChatKey } from '../../../shared/apps/im-keys'
import { isRemoteMember, type TeamTriggerContext } from '../../../shared/apps/team-types'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../shared/types/im-channel'
import { getTeamStore } from '../team'
import { chatPushConversationId } from './chat-push'
import { getActiveTeamRuntime } from './team'

export interface TeamBacking {
  teamId: string
  epochId: string
  teamContext: TeamTriggerContext
}

/** Resolve pushes from the current binding, never a cached archive address. */
export function resolveImPushConversation(
  session: ImSessionRecord,
  config: ImChannelInstanceConfig
): { conversationId: string; teamContext: ImSessionRecord['teamContext'] | null } | null {
  const refusal = !config.enabled ? 'instance disabled'
    : config.id !== session.instanceId ? 'instance changed'
    : config.appId !== session.appId ? 'bound app changed'
    : config.type !== session.channel ? 'channel changed'
    : null
  if (refusal) {
    console.warn(`[ImTeamSession] Push destination refused: appId=${session.appId}, instanceId=${session.instanceId}, chatId=${session.chatId}, reason=${refusal}`)
    return null
  }
  if (!config.teamId) {
    return { conversationId: chatPushConversationId(session), teamContext: null }
  }

  const chatKey = buildTeamChatKey(config.id, session.chatType, session.chatId)
  let backing: TeamBacking | null
  try {
    backing = resolveTeamBacking(config.teamId, session.appId, chatKey)
  } catch {
    console.warn(`[ImTeamSession] Push destination unavailable: chat=${chatKey}, appId=${session.appId}, teamId=${config.teamId}, reason=team conversation resolution failed`)
    return null
  }
  if (!backing) return null // resolveTeamBacking logs the refusal.
  const teamContext = { teamId: backing.teamId, epochId: backing.epochId }
  return { conversationId: chatPushConversationId(session, { teamContext }), teamContext }
}

/** Inbound turns and private questions must select the same current team chat. */
export function resolveTeamBacking(teamId: string, memberAppId: string, chatKey: string): TeamBacking | null {
  const store = getTeamStore()
  const runtime = getActiveTeamRuntime()
  if (!store || !runtime) {
    console.warn(`[ImTeamSession] Chat ${chatKey} unavailable (store/runtime not ready): teamId=${teamId}`)
    return null
  }
  const team = store.getTeamById(teamId)
  if (!team) {
    console.warn(`[ImTeamSession] Chat ${chatKey} points at a missing team: teamId=${teamId}`)
    return null
  }
  const member = memberAppId ? store.getMember(teamId, memberAppId) : null
  if (!member) {
    console.warn(`[ImTeamSession] Chat ${chatKey} bound member is not in team: teamId=${teamId}, appId=${memberAppId}`)
    return null
  }
  if (isRemoteMember(member)) {
    console.warn(`[ImTeamSession] Chat ${chatKey} bound member runs on another machine: teamId=${teamId}, appId=${memberAppId}, owner=${member.ownerNodeId}`)
    return null
  }
  const epoch = runtime.ensureConversationEpoch(teamId, chatKey, undefined, undefined, memberAppId)
  return {
    teamId,
    epochId: epoch.id,
    teamContext: {
      teamId,
      epochId: epoch.id,
      correlationId: randomUUID(),
      fromAppId: null,
      wait: false,
      kind: 'human_message',
    },
  }
}
