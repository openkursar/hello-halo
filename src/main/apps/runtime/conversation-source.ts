/**
 * apps/runtime -- digital-human conversations as a cross-conversation source
 *
 * Registers with services/conversation-interop (bootstrap does it) so a space
 * conversation, or another digital human, can read a digital human's chats and
 * message them.
 *
 * Only the sessions the desktop user holds with a digital human are exposed:
 * its default session and its local sessions. IM chats, HTTP sessions and team
 * sessions belong to other people and other machinery — they are neither
 * listed, resolvable, readable nor deliverable to.
 *
 * While a digital human's owner has "conversation
 * collaboration" switched off, its chats are marked `unavailable` (read from its
 * permissions on every call). They are still owned and listed here — the
 * directory's admission decides what other conversations' AI may do with them,
 * and the user's own features, search included, are not held back by the switch.
 *
 * Delivery runs the ordinary chat send (`sendAppChatMessage`), so the turn is
 * assembled exactly like one the user typed; the module's turn gate decides
 * when. The transcript keeps the sender's own words with their provenance, not
 * the framed text the model was given.
 */

import { getAppManager } from '../manager'
import { getSpace } from '../../services/space.service'
import { getConfig } from '../../foundation/config.service'
import { formatMessageAttachmentsBrief, onAgentEvent, v2Sessions, hasPendingSessionInput } from '../../services/agent'
import type {
  ConversationSource,
  SourceConversation,
  TranscriptLine,
  DispatchedMessage,
  DispatchOutcome,
} from '../../services/conversation-interop'
import { hasActiveAppChatRound, peekAppChatSink } from './app-chat-sink'
import { isAppChatConversationGenerating, getAppChatTurnIdentity, injectIntoAppChatBatch } from './app-chat-live-turn'
import { loadChatMessagesForConversation, sendAppChatMessage } from './app-chat'
import { getImSessionRegistry } from './im-session-registry'
import {
  buildLocalSessionKey,
  getAppChatConversationId,
  isAppChatKey,
  parseNativeChatKey,
  type NativeChatKey,
} from '../../../shared/apps/im-keys'
import { digitalHumanChatTitle, shortConversationId } from '../../../shared/conversation-reference'
import type { TranscriptMessage } from '../../../shared/types/transcript'
import { isConversationCollabEnabled } from '../../../shared/apps/app-types'
import { COLLAB_OFF_REASON } from './conversation-collab'
import type { InstalledApp } from '../../../shared/apps/app-types'
import {
  LOCAL_SESSION_CHANNEL,
  NATIVE_DEFAULT_CHAT_ID,
  NATIVE_SESSION_CHANNEL,
} from '../../../shared/types/im-channel'
import type { ImSessionRecord } from '../../../shared/types/im-channel'

const LOG_TAG = '[DigitalHumanConversations]'

export const DIGITAL_HUMAN_SOURCE_KIND = 'digital-human'

function sessionKey(ref: NativeChatKey): string {
  return ref.kind === 'default' ? getAppChatConversationId(ref.appId) : buildLocalSessionKey(ref.appId, ref.chatId)
}

function findRecord(ref: NativeChatKey): ImSessionRecord | undefined {
  const registry = getImSessionRegistry()
  if (!registry) return undefined
  return ref.kind === 'default'
    ? registry.findSession(ref.appId, NATIVE_SESSION_CHANNEL, NATIVE_DEFAULT_CHAT_ID)
    : registry.findSession(ref.appId, LOCAL_SESSION_CHANNEL, ref.chatId)
}

/** The default session is registered on first send; before that it holds no conversation. */
function hasContent(record: ImSessionRecord): boolean {
  return (record.messageCount ?? 0) > 0 || !!record.lastMessage
}

function toConversation(app: InstalledApp, ref: NativeChatKey, record: ImSessionRecord): SourceConversation {
  return {
    id: sessionKey(ref),
    title: digitalHumanChatTitle({ name: app.spec.name || app.id, isDefault: ref.kind === 'default', ...record }, 'New chat'),
    updatedAt: new Date(record.lastActiveAt).toISOString(),
    // The registry counts inbound turns, not stored messages: close enough for a listing.
    messageCount: record.messageCount ?? 0,
    ...(isConversationCollabEnabled(app) ? {} : { unavailable: COLLAB_OFF_REASON }),
  }
}

/** The digital human an id belongs to, when digital humans are enabled and it is installed in this space. */
function installedApp(spaceId: string, appId: string): InstalledApp | null {
  if (getConfig().agent?.enableDigitalHumans === false) return null
  const app = getAppManager()?.getApp(appId)
  if (!app || app.spec.type !== 'automation' || app.spaceId !== spaceId || app.status === 'uninstalled') return null
  return app
}

/** The session behind an id when it exists and holds a conversation, with its app (collaboration not considered). */
function resolveSession(spaceId: string, conversationId: string): { app: InstalledApp; ref: NativeChatKey; record: ImSessionRecord } | null {
  const ref = parseNativeChatKey(conversationId)
  const app = ref ? installedApp(spaceId, ref.appId) : null
  const record = ref && app ? findRecord(ref) : undefined
  if (!ref || !app || !record) return null
  if (ref.kind === 'default' && !hasContent(record)) return null
  return { app, ref, record }
}

/** Every chat-board session holding a conversation, of every digital human in the space. */
function listSessions(spaceId: string): { app: InstalledApp; ref: NativeChatKey; record: ImSessionRecord }[] {
  if (getConfig().agent?.enableDigitalHumans === false) return []
  const registry = getImSessionRegistry()
  const manager = getAppManager()
  if (!registry || !manager) return []

  const sessions: { app: InstalledApp; ref: NativeChatKey; record: ImSessionRecord }[] = []
  for (const app of manager.listApps({ spaceId, type: 'automation' })) {
    if (app.status === 'uninstalled') continue
    for (const record of registry.getAllSessions(app.id)) {
      const ref: NativeChatKey | null =
        record.source === 'native'
          ? { appId: app.id, kind: 'default' }
          : record.source === 'local'
            ? { appId: app.id, kind: 'local', chatId: record.chatId }
            : null
      if (!ref) continue
      if (ref.kind === 'default' && !hasContent(record)) continue
      sessions.push({ app, ref, record })
    }
  }
  return sessions
}

function dispatchBatch(
  spaceId: string,
  conversationId: string,
  messages: readonly DispatchedMessage[]
): Promise<DispatchOutcome[]> {
  const ref = parseNativeChatKey(conversationId)
  if (!ref) return Promise.reject(new Error(`not a digital-human session: ${conversationId}`))
  // A message taken back after a stop keeps the record it already has.
  const fresh = messages.filter((message) => !message.inputRecorded)
  const recordedInputIds = messages.flatMap(message => message.recordedInputIds ?? [])
  const first = fresh[0] ?? messages[0]
  return new Promise((resolve, reject) => {
    let accepted = false
    const outcomes = messages.map(() => ({}))
    sendAppChatMessage({
      appId: ref.appId,
      spaceId,
      conversationId,
      message: messages.map((message) => message.turnInput).join('\n\n'),
      recorded: {
        content: first.record.content,
        provenance: { source: first.record.source, metadata: first.record.metadata },
      },
      recordedMessages: fresh.map((message) => ({
        content: message.record.content,
        provenance: { source: message.record.source, metadata: message.record.metadata },
      })),
      ...(recordedInputIds.length ? { recordedInputIds } : {}),
      onMessageAccepted: () => {
        accepted = true
        resolve(outcomes)
      },
    }).then(() => resolve(outcomes), (err: unknown) => {
      if (!accepted) reject(err)
      else console.error(`${LOG_TAG} turn on ${conversationId} failed after delivery:`, err)
    })
  })
}

export function createDigitalHumanConversationSource(): ConversationSource {
  return {
    kind: DIGITAL_HUMAN_SOURCE_KIND,
    label: 'digital human',
    capabilities: { readable: true, writable: true },

    owns: isAppChatKey,

    list(spaceId) {
      return listSessions(spaceId).map(({ app, ref, record }) => toConversation(app, ref, record))
    },

    getMeta(spaceId, conversationId) {
      const session = resolveSession(spaceId, conversationId)
      return session ? toConversation(session.app, session.ref, session.record) : null
    },

    shortRef: shortConversationId,

    readTranscript(spaceId, conversationId) {
      const ref = parseNativeChatKey(conversationId)
      const app = ref ? installedApp(spaceId, ref.appId) : null
      const spacePath = getSpace(spaceId)?.path
      if (!ref || !app || !spacePath) return null

      // One pass over the session's parsed messages (cached per file while it is
      // unchanged); only the clean fields are carried, never the thoughts.
      const messages: TranscriptMessage[] = loadChatMessagesForConversation(spacePath, ref.appId, conversationId)
      return messages.map((m): TranscriptLine => ({
        id: m.id,
        role: m.role,
        // The places a message pointed at are named, never their excerpts.
        content: m.metadata?.references?.length
          ? [formatMessageAttachmentsBrief(m.metadata.references, undefined), m.content].filter(Boolean).join('\n')
          : m.content,
        timestamp: m.timestamp,
        source: m.source,
      }))
    },

    // A dispatched message not yet claimed by a turn counts: the round is queued
    // on the sink, and `isAppChatConversationGenerating` covers it.
    isBusy: isAppChatConversationGenerating,

    hasLiveSession: (conversationId) => v2Sessions.has(conversationId) || hasActiveAppChatRound(conversationId),

    getActiveIdentity: getAppChatTurnIdentity,

    dispatch: async (spaceId, conversationId, message) => (await dispatchBatch(spaceId, conversationId, [message]))[0],
    dispatchBatch,

    deliverMidTurn(_spaceId, conversationId, messages, onWithdrawn) {
      const accepted = injectIntoAppChatBatch(conversationId, messages.map((message) => ({
        text: message.turnInput,
        recorded: { content: message.record.content, provenance: { source: message.record.source, metadata: message.record.metadata } },
        inputRecorded: message.inputRecorded,
        ...(message.recordedInputIds?.length ? { recordedInputIds: message.recordedInputIds } : {}),
      })), (_indexes, recordedInputIds) => onWithdrawn(recordedInputIds))
      return accepted ? messages.map(() => ({})) : false
    },

    onTurnReady(listener) {
      return onAgentEvent((event) => {
        if (event.channel === 'agent:turn-start' && isAppChatKey(event.conversationId)) listener(event.conversationId)
      })
    },

    onTurnEnd(listener) {
      return onAgentEvent((event) => {
        if (event.channel !== 'agent:complete' && event.channel !== 'agent:error') return
        if (!isAppChatKey(event.conversationId)) return
        if (hasPendingSessionInput(event.conversationId)) return
        listener(event.conversationId)
      })
    },

    writeNotice(_spaceId, conversationId, content) {
      // The sender is mid-turn, so its sink is live. Without one there is no
      // transcript writer to borrow, and a notice is not worth opening one for.
      const sink = peekAppChatSink(conversationId)
      if (!sink) {
        console.warn(`${LOG_TAG} notice not written: no active transcript for ${conversationId}`)
        return
      }
      sink.writeUserMessage(content, undefined, undefined, { source: 'cross-conversation-notice' })
    },
  }
}
