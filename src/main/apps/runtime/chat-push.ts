/**
 * apps/runtime -- Recording a push in the chat it went to
 *
 * What a digital human sends to an IM chat outside that chat's turns —
 * `notify_bot`, a run's result sent to the chats that receive results, a
 * question for the owner — goes into the chat's record here (chat-record).
 *
 * Loaded on use: the record's writer belongs to the chat runtime, which itself
 * loads the senders, and a push has already gone out by the time it is noted.
 */

import type { ChatPushVia } from '../../../shared/types/transcript'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { buildImSessionKey, buildTeamSessionKey } from '../../../shared/apps/im-keys'
import { getImSessionRegistry } from './im-session-registry'

export interface ChatPush {
  /** The digital human the chat belongs to, as the session registry keys it */
  appId: string
  /** The channel provider type, as the session registry keys it */
  channel: string
  chatType: 'direct' | 'group'
  chatId: string
  /** What the chat received */
  text: string
  via: ChatPushVia
  /** The digital human that sent it: the chat's own (`appId`), or one linked to the chat */
  pushedBy: string
  /** A resolved destination, pinned before asynchronous recording; null means non-team. */
  teamContext?: ImSessionRecord['teamContext'] | null
  /** Captured before deferred recording; null keeps only history after an invalidated delivery. */
  sessionRevision?: object | null
}

/** The same destination for the human-readable record and the AI's pending relay. */
export function chatPushConversationId(
  push: Pick<ChatPush, 'appId' | 'channel' | 'chatType' | 'chatId'>,
  session?: Pick<ImSessionRecord, 'teamContext'>
): string {
  return session?.teamContext
    ? buildTeamSessionKey(push.appId, session.teamContext.teamId, session.teamContext.epochId)
    : buildImSessionKey(push.appId, push.channel, push.chatType, push.chatId)
}

/** Note a push that was sent. Never throws and never waits. */
export function recordChatPush(push: ChatPush): void {
  const registry = getImSessionRegistry()
  const teamContext = push.teamContext === undefined
    ? registry?.findSession(push.appId, push.channel, push.chatId)?.teamContext
    : push.teamContext
  const captured = {
    ...push,
    teamContext: teamContext ? { ...teamContext } : null,
    sessionRevision: push.sessionRevision === undefined
      ? registry?.getSessionRevision(push.appId, push.channel, push.chatId) ?? null
      : push.sessionRevision,
  }
  void import('./chat-record')
    .then(({ writeChatPush }) => writeChatPush(captured))
    .catch((err) => console.warn(`[ChatPush] A push to ${push.channel}:${push.chatId} was sent but not recorded:`, err))
}
