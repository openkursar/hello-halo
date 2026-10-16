/**
 * A due reminder becomes a turn of the conversation it was set in.
 *
 * Permission-compatible reminders join live work. Repeating notices share a
 * mailbox key, and a cancelled reminder is checked again before delivery.
 *
 * An IM chat gets what dispatch-inbound gives the same session — its framing
 * and its file sending; a different tool set would rebuild the session — and
 * the reply is pushed to the chat, where nobody is waiting on it. The turn runs
 * with the standing the person who asked has at that moment: someone dropped
 * from the owners since is answered as a guest.
 */

import type { AppChatRequest } from '../app-chat'
import { getConversationReminders, renderReminderTurn, type ConversationReminder, type ReminderDelivery } from './index'
import { getAppManager } from '../../manager'
import { getImSessionRegistry } from '../im-session-registry'
import { getActiveImChannelManager } from '../im-channels'
import { resolveImFileSend } from '../im-channels/file-send-resolve'
import { setImPermissionContext } from '../im-permission-registry'
import { instanceTakesChat, resolveImPermission } from '../im-sender-standing'
import { sanitizeRuntimeTags } from '../pending-relays'
import { withTurnEndingNote } from '../turn-ending'
import { imErrorReply } from '../im-error-reply'
import { getSpaceDir } from '../../../services/space.service'
import { parseAppChatKey, parseNativeChatKey } from '../../../../shared/apps/im-keys'
import { classifySessionSource, getImSessionDisplayName, LOCAL_SESSION_CHANNEL } from '../../../../shared/types/im-channel'

const LOG_TAG = '[Reminders]'

/**
 * The turn a reminder starts, given the text it carries, and what its chat is
 * told if that turn fails; or why it has nowhere to go now.
 */
type Target =
  | ((text: string) => { request: AppChatRequest; beforeSend?: () => void; onFailure?: (error: unknown) => void })
  | 'gone'
  | 'unavailable'

function targetOf(reminder: ConversationReminder): Target {
  const app = getAppManager()?.getApp(reminder.appId)
  if (!app || app.status === 'uninstalled' || !app.spaceId) return 'gone'
  const spaceId = app.spaceId
  const { conversationId } = reminder
  const base = (text: string): AppChatRequest => ({ appId: app.id, spaceId, conversationId, message: text })

  const native = parseNativeChatKey(conversationId)
  if (native) {
    if (native.kind === 'local' && !getImSessionRegistry()?.findSession(app.id, LOCAL_SESSION_CHANNEL, native.chatId)) return 'gone'
    return text => ({ request: base(text) })
  }

  const parsed = parseAppChatKey(conversationId)
  const session = parsed ? getImSessionRegistry()?.findSession(app.id, parsed.channel, parsed.chatId) : undefined
  if (!parsed || !session) return 'gone'
  // An API session: its client reads the transcript, as for any turn it did not send.
  if (classifySessionSource(parsed.channel) !== 'im') return text => ({ request: base(text) })

  const channels = getActiveImChannelManager()
  const instance = channels?.getInstance(session.instanceId)
  const config = channels?.getInstanceConfig(session.instanceId)
  // A chat its instance no longer fronts for this digital human (rebound, or
  // turned into a team's front desk) is not this reminder's to speak in.
  if (!instance || !config || config.appId !== app.id || config.teamId) return 'unavailable'
  // Nor one where a message would be refused now: outside the instance's reply
  // scope, or a group while permission control has no owner bound.
  if (!instanceTakesChat(config, parsed.chatType)) return 'unavailable'

  const setter = reminder.setBy
  const permission = resolveImPermission(config, setter?.id ?? '', setter?.name ?? '')
  const senderIdentity = parsed.chatType === 'direct' && setter ? { id: setter.id, name: setter.name } : undefined
  // Nobody waits on a reminder's turn, so a push the chat does not take is
  // only logged.
  const push = (text: string, what: string) => {
    try {
      if (!instance.pushToChat(parsed.chatId, text, parsed.chatType)) {
        console.warn(`${LOG_TAG} The ${what} was not taken by the chat: ${conversationId}`)
      }
    } catch (error) {
      console.error(`${LOG_TAG} Pushing the ${what} failed: ${conversationId}`, error)
    }
  }
  return text => ({
    request: {
      ...base(parsed.chatType === 'group' && setter ? `<msg-sender id="${setter.id}" name="${setter.name}" />\n${text}` : text),
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
        spaceDir: getSpaceDir(spaceId),
      }),
      imPermission: permission,
      senderIdentity,
      // A push this turn makes is attributed to the person who asked for it.
      ...(setter ? { relayOrigin: { subject: { id: setter.id, name: setter.name } } } : {}),
      // IM has no Deep Thinking toggle; the same setting its inbound replies take.
      thinkingEnabled: true,
      onReply: (reply, ending) => {
        // A turn that stopped short says so, as any reply in an IM chat does.
        const pushed = ending ? withTurnEndingNote(reply, ending) : reply
        if (pushed.trim()) push(pushed, 'reminder reply')
      },
    },
    beforeSend: () => setImPermissionContext(conversationId, permission),
    // Told as the chat is told when a turn of its own fails.
    onFailure: error => push(imErrorReply(error), 'note that the reminder failed'),
  })
}

/**
 * Occurrences of a reminder still waiting for their chat. The mailbox keeps
 * only the latest (same coalescing key); this count is how its text can still
 * say how many more times it came due while the conversation was busy.
 */
const waitingOccurrences = new Map<string, number>()

export function deliverReminder(reminder: ConversationReminder, dueAt: number): ReminderDelivery {
  const target = targetOf(reminder)
  if (typeof target === 'string') return target
  waitingOccurrences.set(reminder.id, (waitingOccurrences.get(reminder.id) ?? 0) + 1)
  const settle = () => { waitingOccurrences.delete(reminder.id) }
  const refresh = (): AppChatRequest | undefined => {
    if (!getConversationReminders()?.isStillSet(reminder.id)) { settle(); return undefined }
    const current = targetOf(reminder)
    if (typeof current === 'string') { settle(); return undefined }
    const missed = Math.max(0, (waitingOccurrences.get(reminder.id) ?? 1) - 1)
    const { request, beforeSend } = current(sanitizeRuntimeTags(renderReminderTurn(reminder, dueAt, Date.now(), missed)))
    return {
      ...request,
      coalescingKey: `reminder:${reminder.id}`,
      refreshBeforeDelivery: refresh,
      onMessageAccepted: () => { settle(); beforeSend?.() },
    }
  }
  void import('../app-chat').then(({ sendAppChatMessage }) => {
    const request = refresh()
    if (!request) {
      console.log(`${LOG_TAG} Reminder cancelled before delivery: id=${reminder.id}`)
      return
    }
    return sendAppChatMessage(request).catch((error: unknown) => {
      settle()
      console.error(`${LOG_TAG} Reminder delivery failed: conversation=${reminder.conversationId}`, error)
      const current = targetOf(reminder)
      if (typeof current === 'function') current('').onFailure?.(error)
    })
  }).catch(error => console.error(`${LOG_TAG} Reminder dispatch unavailable: id=${reminder.id}`, error))
  return 'started'
}
