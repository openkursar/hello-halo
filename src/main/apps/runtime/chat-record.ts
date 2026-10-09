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
 * session list. This never changes the AI's context. Only notify_bot messages
 * and private questions for the owner also enter the relay spool; automatic
 * run-result pushes remain solely in the record the person reads.
 */

import { TEAM_EVENTS } from '../../../shared/apps/team-types'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import { getSpace } from '../../services/space.service'
import { getAppManager } from '../manager'
import { getAppChatSink } from './app-chat-sink'
import { chatPushConversationId, type ChatPush } from './chat-push'
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
  // A resolved push keeps its destination even if the registry changes before recording.
  const teamContext = push.teamContext === undefined ? session?.teamContext : push.teamContext ?? undefined
  const conversationId = chatPushConversationId(push, { teamContext })

  const manager = getAppManager()
  const app = manager?.getApp(push.appId)
  const fallback = app?.spaceId ? getSpace(app.spaceId)?.path ?? '' : ''
  const spacePath = chatRecordPath(push.appId, conversationId, fallback)
  if (!spacePath) {
    console.warn(`${LOG_TAG} Push to ${conversationId} not recorded: no space to keep its record in`)
    return
  }

  // A push from a digital human linked to the chat goes into the record of the
  // chat's own digital human — the one the chat's replies go to — under the
  // sender's name.
  const by = push.pushedBy === push.appId
    ? undefined
    : { appId: push.pushedBy, name: manager?.getApp(push.pushedBy)?.spec.name ?? push.pushedBy }
  getAppChatSink({
    appId: push.appId,
    conversationId,
    runId: appChatRunId(conversationId, push.appId),
    spacePath,
  }).writePush({ text: push.text, via: push.via, by })

  const sessionRevision = registry?.getSessionRevision(push.appId, push.channel, push.chatId)
  if (sessionRevision !== undefined && (push.sessionRevision === undefined || push.sessionRevision === sessionRevision)) {
    const lastMessage = truncateUtf16Safe(push.text, 50)
    const lastSender = by?.name ?? app?.spec.name
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
  } else if (push.sessionRevision) {
    console.warn(`${LOG_TAG} Push recorded without refreshing session: target=${conversationId}, reason=session changed before recording`)
  }
  if (teamContext) {
    // What an open view of the team's conversation reloads on.
    const history = { teamId: teamContext.teamId, appId: push.appId, epochId: teamContext.epochId }
    sendToRenderer(TEAM_EVENTS.memberHistory, history)
    broadcastToAll(TEAM_EVENTS.memberHistory, history)
  }
}
