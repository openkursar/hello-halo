/**
 * apps/runtime -- A digital human's chat record: where it is kept, and the
 * messages the digital human pushes into a chat outside its turns
 *
 * A chat's record is the JSONL its turns are written to (session-store), in the
 * space its session was pinned to. Readers and writers must agree on that
 * place, so it is decided once ({@link chatRecordPath}).
 *
 * A push — a `notify_bot` message, a run's result, a question for the owner —
 * reaches the chat on the platform without a turn of that chat, so nothing else
 * would put it in the record its owner reads in Halo. It is written through the
 * chat's sink, the record's one writer, and moves the chat to the top of the
 * session list. The chat's AI is not told here: it learns of a push from the
 * relay spool (pending-relays) with the next message in the chat.
 */

import { buildImSessionKey } from '../../../shared/apps/im-keys'
import { buildTeamSessionKey, TEAM_EVENTS } from '../../../shared/apps/team-types'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import { getSpace } from '../../services/space.service'
import { getAppManager } from '../manager'
import { getAppChatSink } from './app-chat-sink'
import type { ChatPush } from './chat-push'
import { appChatRunId, legacySessionEnvironmentKey } from './execution-environment'
import { getImSessionRegistry } from './im-session-registry'
import { getActivityStore } from './index'
import { truncateUtf16Safe } from './text-truncate'

const LOG_TAG = '[ChatRecord]'

/** The space a chat's record is kept in: the one its session was pinned to, else `fallback`. */
export function chatRecordPath(appId: string, conversationId: string, fallback: string): string {
  const store = getActivityStore()
  return store?.getSessionEnvironment(conversationId)?.spacePath
    ?? store?.getSessionEnvironment(legacySessionEnvironmentKey(appId, appChatRunId(conversationId, appId)))?.spacePath
    ?? fallback
}

/** Put a sent push into the chat's record and session list. */
export function writeChatPush(push: ChatPush): void {
  const registry = getImSessionRegistry()
  const session = registry?.findSession(push.appId, push.channel, push.chatId)
  // A chat a team fronts is recorded in the team's conversation with it.
  const conversationId = session?.teamContext
    ? buildTeamSessionKey(push.appId, session.teamContext.teamId, session.teamContext.epochId)
    : buildImSessionKey(push.appId, push.channel, push.chatType, push.chatId)

  const app = getAppManager()?.getApp(push.appId)
  const fallback = app?.spaceId ? getSpace(app.spaceId)?.path ?? '' : ''
  const spacePath = chatRecordPath(push.appId, conversationId, fallback)
  if (!spacePath) {
    console.warn(`${LOG_TAG} Push to ${conversationId} not recorded: no space to keep its record in`)
    return
  }

  getAppChatSink({
    appId: push.appId,
    conversationId,
    runId: appChatRunId(conversationId, push.appId),
    spacePath,
  }).writePush(push.text, push.via)

  const lastMessage = truncateUtf16Safe(push.text, 50)
  const lastSender = app?.spec.name
  registry?.notePush(push.appId, push.channel, push.chatId, { lastSender, lastMessage })
  const update = {
    appId: push.appId,
    channel: push.channel,
    chatId: push.chatId,
    chatType: push.chatType,
    instanceId: session?.instanceId ?? '',
    lastMessage,
    lastSender,
  }
  sendToRenderer('app:im-session-updated', update)
  broadcastToAll('app:im-session-updated', update)
  if (session?.teamContext) {
    // What an open view of the team's conversation reloads on.
    const history = { teamId: session.teamContext.teamId, appId: push.appId, epochId: session.teamContext.epochId }
    sendToRenderer(TEAM_EVENTS.memberHistory, history)
    broadcastToAll(TEAM_EVENTS.memberHistory, history)
  }
}
