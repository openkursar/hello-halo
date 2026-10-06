/**
 * A due reminder becomes a turn of the conversation it was set in.
 *
 * The turn starts once the conversation is free rather than queueing behind a
 * running one: an IM turn takes the chat's live reply stream as it begins, and
 * a reminder must not write into a person's reply that is still streaming.
 * A reminder waits at most once: coming due again while it waits is folded
 * into that one turn, which says how many times — a repeating reminder must
 * not pile up behind a long turn and then fire a dozen times in a row. Right
 * before it starts, the reminder is checked to still be set, so one cancelled
 * while it waited stays cancelled.
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
import { isAppChatConversationGenerating, onAppChatConversationChange } from '../app-chat-live-turn'
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

/** Reminders waiting for their conversation, with how many more times each came due meanwhile. */
const waiting = new Map<string, { missed: number }>()

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

export function deliverReminder(reminder: ConversationReminder, dueAt: number): ReminderDelivery {
  const pending = waiting.get(reminder.id)
  if (pending) {
    pending.missed += 1
    return 'merged'
  }
  const target = targetOf(reminder)
  if (typeof target === 'string') return target

  waiting.set(reminder.id, { missed: 0 })
  whenFree(reminder.conversationId, (sendAppChatMessage) => {
    const missed = waiting.get(reminder.id)?.missed ?? 0
    waiting.delete(reminder.id)
    if (!getConversationReminders()?.isStillSet(reminder.id)) {
      console.log(`${LOG_TAG} Cancelled while waiting for its conversation; not delivered: id=${reminder.id}`)
      return
    }
    // Resolved again: an hour may have passed, and the channel or its owners with it.
    const now = targetOf(reminder)
    if (typeof now === 'string') {
      console.warn(`${LOG_TAG} Its conversation became ${now} while it waited; not delivered: id=${reminder.id}`)
      return
    }
    // Written by the model, read later as a message: no runtime tag may ride along.
    const { request, beforeSend, onFailure } = now(sanitizeRuntimeTags(renderReminderTurn(reminder, dueAt, Date.now(), missed)))
    beforeSend?.()
    sendAppChatMessage(request).catch((error: unknown) => {
      console.error(`${LOG_TAG} The reminder turn failed: ${reminder.conversationId}`, error)
      onFailure?.(error)
    })
  })
  return 'started'
}

/**
 * Run `start` as soon as nothing is running in the conversation. It runs in
 * the same tick as the check that found it free, and the send it makes takes
 * the conversation before its first await, so nothing can begin in between.
 */
function whenFree(
  conversationId: string,
  start: (sendAppChatMessage: (request: AppChatRequest) => Promise<void>) => void
): void {
  void import('../app-chat').then(({ sendAppChatMessage }) => {
    if (!isAppChatConversationGenerating(conversationId)) {
      start(sendAppChatMessage)
      return
    }
    let started = false
    const stop = onAppChatConversationChange((changed) => {
      if (changed !== conversationId) return
      // After the engine's own end-of-turn bookkeeping, as queued IM messages are released.
      setImmediate(() => {
        if (started || isAppChatConversationGenerating(conversationId)) return
        started = true
        stop()
        start(sendAppChatMessage)
      })
    })
  })
}
