/**
 * A due reminder becomes a turn of the conversation it was set in.
 *
 * The turn starts once the conversation is free rather than queueing behind a
 * running one: an IM turn takes the chat's live reply stream as it begins, and
 * a reminder must not write into a person's reply that is still streaming.
 *
 * An IM chat gets what dispatch-inbound gives the same session — its framing
 * and its file sending; a different tool set would rebuild the session — and
 * the reply is pushed to the chat, where nobody is waiting on it. The turn runs
 * with the standing the person who asked has now: someone dropped from the
 * owners since then is answered as a guest.
 */

import type { AppChatRequest } from '../app-chat'
import { renderReminderTurn, type ConversationReminder, type ReminderDelivery } from './index'
import { getAppManager } from '../../manager'
import { isAppChatConversationGenerating, onAppChatConversationChange } from '../app-chat-live-turn'
import { getImSessionRegistry } from '../im-session-registry'
import { getActiveImChannelManager } from '../im-channels'
import { resolveImFileSend } from '../im-channels/file-send-resolve'
import { setImPermissionContext } from '../im-permission-registry'
import { resolveImPermission } from '../im-sender-standing'
import { sanitizeRuntimeTags } from '../pending-relays'
import { getSpaceDir } from '../../../services/space.service'
import { parseAppChatKey, parseNativeChatKey } from '../../../../shared/apps/im-keys'
import { classifySessionSource, getImSessionDisplayName, LOCAL_SESSION_CHANNEL } from '../../../../shared/types/im-channel'

const LOG_TAG = '[Reminders]'

export function deliverReminder(reminder: ConversationReminder, dueAt: number): ReminderDelivery {
  const app = getAppManager()?.getApp(reminder.appId)
  if (!app || app.status === 'uninstalled' || !app.spaceId) return 'gone'
  const { conversationId } = reminder
  // Written by the model, read later as a message: no runtime tag may ride along.
  const text = sanitizeRuntimeTags(renderReminderTurn(reminder, dueAt, Date.now()))
  const base: AppChatRequest = { appId: app.id, spaceId: app.spaceId, conversationId, message: text }

  const native = parseNativeChatKey(conversationId)
  if (native) {
    if (native.kind === 'local' && !getImSessionRegistry()?.findSession(app.id, LOCAL_SESSION_CHANNEL, native.chatId)) return 'gone'
    sendWhenFree(base)
    return 'started'
  }

  const parsed = parseAppChatKey(conversationId)
  const session = parsed ? getImSessionRegistry()?.findSession(app.id, parsed.channel, parsed.chatId) : undefined
  if (!parsed || !session) return 'gone'
  if (classifySessionSource(parsed.channel) !== 'im') {
    // An API session: its client reads the transcript, as for any turn it did not send.
    sendWhenFree(base)
    return 'started'
  }

  const channels = getActiveImChannelManager()
  const instance = channels?.getInstance(session.instanceId)
  const config = channels?.getInstanceConfig(session.instanceId)
  // A chat its instance no longer fronts for this digital human (rebound, or
  // turned into a team's front desk) is not this reminder's to speak in.
  if (!instance || !config || config.appId !== app.id || config.teamId) return 'unavailable'

  const setter = reminder.setBy
  const permission = resolveImPermission(config, setter?.id ?? '', setter?.name ?? '')
  const senderIdentity = parsed.chatType === 'direct' && setter ? { id: setter.id, name: setter.name } : undefined
  const message = parsed.chatType === 'group' && setter
    ? `<msg-sender id="${setter.id}" name="${setter.name}" />\n${text}`
    : text

  sendWhenFree({
    ...base,
    message,
    imSession: {
      channel: instance.providerType,
      chatType: parsed.chatType,
      displayName: getImSessionDisplayName(session),
      sessionId: `${session.instanceId}:${parsed.chatId}`,
      senderIdentity,
    },
    imFileSend: resolveImFileSend({
      instanceId: session.instanceId,
      chatId: parsed.chatId,
      chatType: parsed.chatType,
      spaceDir: getSpaceDir(app.spaceId),
    }),
    imPermission: permission,
    senderIdentity,
    // IM has no Deep Thinking toggle; the same setting its inbound replies take.
    thinkingEnabled: true,
    onReply: (reply) => {
      if (!reply.trim()) return
      try {
        instance.pushToChat(parsed.chatId, reply, parsed.chatType)
      } catch (error) {
        console.error(`${LOG_TAG} Pushing the reminder reply failed: ${conversationId}`, error)
      }
    },
  }, () => setImPermissionContext(conversationId, permission))
  return 'started'
}

/**
 * Start the turn as soon as nothing is running in the conversation. The start
 * happens in the same tick as the check that found it free, and the send takes
 * the conversation before its first await, so nothing can begin in between.
 */
function sendWhenFree(request: AppChatRequest, beforeSend?: () => void): void {
  void import('../app-chat').then(({ sendAppChatMessage }) => {
    const conversationId = request.conversationId!
    const send = () => {
      beforeSend?.()
      sendAppChatMessage(request).catch((error: unknown) => {
        console.error(`${LOG_TAG} The reminder turn failed: ${conversationId}`, error)
      })
    }
    if (!isAppChatConversationGenerating(conversationId)) {
      send()
      return
    }
    let sent = false
    const stop = onAppChatConversationChange((changed) => {
      if (changed !== conversationId) return
      // After the engine's own end-of-turn bookkeeping, as queued IM messages are released.
      setImmediate(() => {
        if (sent || isAppChatConversationGenerating(conversationId)) return
        sent = true
        stop()
        send()
      })
    })
  })
}
