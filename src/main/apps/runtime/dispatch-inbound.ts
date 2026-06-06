/**
 * apps/runtime -- Inbound Dispatch
 *
 * Unified entry point for all inbound IM messages. The ImChannelManager
 * calls dispatchInboundMessage() with a normalized InboundMessage + ReplyHandle
 * plus the pre-resolved appId and instanceId (from the instance's binding).
 *
 * This module handles:
 *   1. App validation — ensure the bound App exists and has a spaceId
 *   2. Session key construction — per-app, per-channel, per-chat isolation
 *   3. Session registration — track IM sessions in the registry
 *   4. Execution — delegates to app-chat.ts for conversational AI
 *
 * Design principles:
 * - No routing logic — appId is provided by the caller (ImChannelManager)
 * - No IM protocol details — only works with InboundMessage + ReplyHandle
 * - No direct dependency on any specific adapter
 */

import { tmpdir } from 'os'
import type { InboundMessage, ReplyHandle, ProgressEvent } from '../../../shared/types/inbound-message'
import { getAppManager } from '../manager'
import { sendAppChatMessage, buildImSessionKey, clearImSession } from './app-chat'
import type { ImSessionContext } from './im-channels/im-prompt'
import { getImSessionRegistry } from './im-session-registry'
import { getActiveImChannelManager } from './im-channels'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import { stopGeneration } from '../../services/agent/control'
import { activeSessions } from '../../services/agent/session-manager'
import { setImPermissionContext, clearImPermissionContext } from './im-permission-registry'
import { analytics } from '../../services/analytics/analytics.service'
import { AnalyticsEvents } from '../../services/analytics/types'
import { FileExportGate } from './file-export-gate'
import { getSpaceDir } from '../../services/space.service'

// ============================================
// Constants
// ============================================

const LOG_TAG = '[Dispatch]'

/** Maximum reply length (platform-safe limit for most IM channels) */
const MAX_REPLY_LENGTH = 4000

/**
 * Commands that abort the current generation.
 * Slash-prefixed to avoid false triggers from normal conversation.
 */
const STOP_COMMANDS = new Set(['/halo-stop', '/halo-cancel', '/stop'])

/** Commands that clear the conversation context and start fresh. */
const CLEAR_COMMANDS = new Set(['/halo-clear', '/halo-reset', '/clear'])

/** Max characters of a supplement body shown in acks / round-switch prompts. */
const SUPPLEMENT_PREVIEW_MAX = 20

/** Beyond this count the ack switches to "last 3 + more" truncated form. */
const SUPPLEMENT_ACK_TRUNCATE_THRESHOLD = 5

/** Check whether a message is a stop command (case-insensitive, trimmed). */
function isStopCommand(body: string): boolean {
  return STOP_COMMANDS.has(body.trim().toLowerCase())
}

/** Check whether a message is a clear-context command (case-insensitive, trimmed). */
function isClearCommand(body: string): boolean {
  return CLEAR_COMMANDS.has(body.trim().toLowerCase())
}

/**
 * Bilingual rejection message sent when a DM is blocked by replyScope policy.
 * Hardcoded because the backend does not have renderer i18n loaded.
 */
const DM_REJECTED_MESSAGE =
  '⚠️ This bot only responds in group chats. Please contact the bot administrator for access.\n' +
  '⚠️ 该机器人仅在群聊中响应，请联系管理员开通权限。'

/** Bilingual rejection for group messages blocked by 'direct'-only scope. */
const GROUP_REJECTED_MESSAGE =
  '⚠️ This bot only responds to direct messages.\n' +
  '⚠️ 该机器人仅在私聊中响应。'

// ============================================
// Helpers
// ============================================

/**
 * Look up the fileCapability for a channel instance and return a pre-bound
 * send function for the given conversation.
 *
 * The returned closure integrates `FileExportGate` — it validates the file
 * path against the space sandbox before delegating to the channel adapter.
 * This ensures all AI-initiated file sends pass through path validation.
 *
 * Returns undefined when:
 *   - The ImChannelManager is not initialized
 *   - The instance does not expose fileCapability (text-only channel)
 *   - The instance is no longer registered
 *
 * @param instanceId - IM channel instance ID
 * @param chatId - Target conversation ID (bound into the closure)
 * @param chatType - Conversation type (bound into the closure)
 * @param exportGate - FileExportGate for path validation
 */
function resolveImFileSend(
  instanceId: string,
  chatId: string,
  chatType: 'direct' | 'group',
  exportGate: FileExportGate
): ((filePath: string, filename?: string) => Promise<boolean>) | undefined {
  const manager = getActiveImChannelManager()
  if (!manager) return undefined
  const instance = manager.getInstance(instanceId)
  if (!instance?.fileCapability) return undefined
  return (filePath: string, filename?: string) => {
    const sanctioned = exportGate.sanction(filePath)
    // Override displayName if caller provided an explicit filename
    const file = filename
      ? { ...sanctioned, displayName: filename }
      : sanctioned
    return instance.fileCapability!.sendFile(chatId, file, chatType)
  }
}

// ============================================
// Supplement Buffer
// ============================================
//
// When a message arrives while AI is generating, we buffer it (with ack) instead
// of starting a concurrent generation. On completion, buffered messages are merged
// into a single new round using the latest entry's ReplyHandle.

interface SupplementEntry {
  msg: InboundMessage
  reply: ReplyHandle
  appId: string
  instanceId: string
}

const supplementBuffers = new Map<string, SupplementEntry[]>()

function truncatePreview(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= SUPPLEMENT_PREVIEW_MAX) return trimmed || '(empty)'
  return trimmed.slice(0, SUPPLEMENT_PREVIEW_MAX) + '...'
}

function buildSupplementAck(buffer: SupplementEntry[]): string {
  const count = buffer.length

  if (count === 1) {
    return [
      '✏️ 已收到补充消息',
      'AI 正在这一轮的回应中，你的补充会在下一轮回应时一并理解处理。',
      '当前已收到补充：1 条',
      `• ${truncatePreview(buffer[0].msg.body)}`,
    ].join('\n')
  }

  if (count <= SUPPLEMENT_ACK_TRUNCATE_THRESHOLD) {
    const lines = buffer.map((e) => `• ${truncatePreview(e.msg.body)}`)
    return [
      '✏️ 又收到补充',
      '下一轮回应时，会把这些补充合并理解、一起回复：',
      ...lines,
    ].join('\n')
  }

  const recent = buffer.slice(-3).map((e) => `• ${truncatePreview(e.msg.body)}`)
  return [
    `✏️ 又收到补充（共 ${count} 条）`,
    '下一轮回应时合并处理。最近 3 条：',
    ...recent,
    '... 更多',
  ].join('\n')
}

/** Prefix pushed before the merged supplement round starts streaming. */
function buildRoundSwitchPrefix(buffer: SupplementEntry[]): string {
  const lines = buffer.map((e) => `• ${truncatePreview(e.msg.body)}`)
  return [
    '（上一轮回应已结束）',
    '',
    `现在合并处理你刚才的 ${buffer.length} 条补充：`,
    ...lines,
  ].join('\n')
}

/** Drop all buffered supplements for a conversation, disposing stream sessions. */
function clearSupplementBuffer(conversationId: string): SupplementEntry[] {
  const entries = supplementBuffers.get(conversationId)
  if (!entries || entries.length === 0) {
    supplementBuffers.delete(conversationId)
    return []
  }
  supplementBuffers.delete(conversationId)
  for (const e of entries) {
    try {
      e.reply.streaming?.dispose?.()
    } catch (err) {
      console.error(`${LOG_TAG} clearSupplementBuffer dispose error:`, err)
    }
  }
  return entries
}

/** Drop supplements bound to a torn-down instance to prevent stale closure leaks. */
export function clearSupplementBuffersForInstance(instanceId: string): number {
  let dropped = 0
  for (const [conversationId, entries] of supplementBuffers) {
    const kept: SupplementEntry[] = []
    for (const e of entries) {
      if (e.instanceId === instanceId) {
        try {
          e.reply.streaming?.dispose?.()
        } catch (err) {
          console.error(
            `${LOG_TAG} clearSupplementBuffersForInstance dispose error:`,
            err
          )
        }
        dropped++
      } else {
        kept.push(e)
      }
    }
    if (kept.length === 0) {
      supplementBuffers.delete(conversationId)
    } else if (kept.length !== entries.length) {
      supplementBuffers.set(conversationId, kept)
    }
  }
  if (dropped > 0) {
    console.log(
      `${LOG_TAG} Dropped ${dropped} buffered supplement(s) for stopped ` +
      `instance ${instanceId}`
    )
  }
  return dropped
}

/** Merge supplement bodies. Groups get per-entry <msg-sender> tags for attribution. */
function buildMergedMessageText(
  entries: SupplementEntry[],
  chatType: 'direct' | 'group'
): string {
  if (chatType === 'direct') {
    return entries
      .map((e) => e.msg.body)
      .filter((b) => b && b.length > 0)
      .join('\n')
  }
  return entries
    .map((e) => {
      const senderName = e.msg.fromName ?? e.msg.from
      if (!e.msg.from) return e.msg.body
      return `<msg-sender id="${e.msg.from}" name="${senderName}" />\n${e.msg.body}`
    })
    .filter((b) => b && b.length > 0)
    .join('\n')
}

/**
 * Drain the supplement buffer and dispatch a merged round. No-op if empty.
 * Re-checks the busy lock to avoid racing with a newly-arrived message;
 * if busy, defers — the next round's finally will retry.
 */
export function flushSupplementBuffer(conversationId: string): void {
  const entries = supplementBuffers.get(conversationId)
  if (!entries || entries.length === 0) {
    supplementBuffers.delete(conversationId)
    return
  }

  if (activeSessions.has(conversationId)) {
    console.log(
      `${LOG_TAG} flushSupplementBuffer deferred: conv=${conversationId} is ` +
      `busy (race with newly-arrived message), ${entries.length} supplement(s) ` +
      `remain queued for the next idle window`
    )
    return
  }

  supplementBuffers.delete(conversationId)

  const last = entries[entries.length - 1]

  // Dispose all stream sessions except the last (used for the merged round)
  for (let i = 0; i < entries.length - 1; i++) {
    try {
      entries[i].reply.streaming?.dispose?.()
    } catch (err) {
      console.error(`${LOG_TAG} flush dispose error:`, err)
    }
  }

  const mergedAttachments = entries.flatMap((e) => e.msg.attachments ?? [])
  const mergedImages = entries.flatMap((e) => e.msg.images ?? [])
  const messageText = buildMergedMessageText(entries, last.msg.chatType)

  // For groups with mixed owners/guests, use the first guest as effective sender
  // so the merged round runs under guest restrictions (least privilege).
  const channelManager = getActiveImChannelManager()
  const cfgForPerm = channelManager?.getInstanceConfig(last.instanceId)
  const permEnabled = cfgForPerm?.permissionEnabled ?? false
  const ownerList = permEnabled ? cfgForPerm?.owners ?? [] : []
  let effectiveFrom = last.msg.from
  let effectiveFromName = last.msg.fromName
  if (last.msg.chatType === 'group' && permEnabled && ownerList.length > 0) {
    const guestEntry = entries.find(
      (e) => e.msg.from && !ownerList.includes(e.msg.from)
    )
    if (guestEntry) {
      effectiveFrom = guestEntry.msg.from
      effectiveFromName = guestEntry.msg.fromName ?? guestEntry.msg.from
    }
  }

  const merged: InboundMessage = {
    body: messageText,
    from: effectiveFrom,
    fromName: effectiveFromName,
    channel: last.msg.channel,
    chatType: last.msg.chatType,
    chatId: last.msg.chatId,
    chatName: last.msg.chatName,
    messageId: last.msg.messageId,
    timestamp: Date.now(),
    ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
    ...(mergedImages.length > 0 ? { images: mergedImages } : {}),
  }

  const senderIdentity =
    last.msg.chatType === 'direct' && last.msg.from
      ? { id: last.msg.from, name: last.msg.fromName ?? last.msg.from }
      : undefined

  // Push round-switch prefix (non-fatal)
  const instance = channelManager?.getInstance(last.instanceId)
  if (instance) {
    try {
      instance.pushToChat(
        merged.chatId,
        buildRoundSwitchPrefix(entries),
        merged.chatType
      )
    } catch (err) {
      console.error(`${LOG_TAG} round-switch prefix push failed:`, err)
    }
  }

  console.log(
    `${LOG_TAG} Flushing ${entries.length} supplement(s): conv=${conversationId}, ` +
    `chat=${merged.chatId}, attachments=${mergedAttachments.length}, ` +
    `images=${mergedImages.length}`
  )

  setImmediate(() => {
    dispatchInboundMessage(merged, last.reply, last.appId, last.instanceId, {
      skipBusyCheck: true,
      preBuiltMessageText: messageText,
      preBuiltSenderIdentity: senderIdentity,
    }).catch((err) => {
      console.error(`${LOG_TAG} Supplement flush dispatch failed:`, err)
    })
  })
}

// ============================================
// Dispatch
// ============================================

/** Internal options used by flushSupplementBuffer() for pre-merged dispatch. */
interface DispatchOptions {
  skipBusyCheck?: boolean
  preBuiltMessageText?: string
  preBuiltSenderIdentity?: { id: string; name: string }
}

/**
 * Dispatch an inbound IM message to a specific digital human.
 *
 * Called by the ImChannelManager's onInbound callback, which provides
 * the pre-resolved appId and instanceId from the instance's config binding.
 *
 * @param msg - Normalized inbound message from the channel adapter
 * @param reply - Reply handle for sending responses back to the IM channel
 * @param appId - Bound digital human App ID (from instance config)
 * @param instanceId - IM channel instance ID (for session tracking)
 * @param options - Internal options (set only by flushSupplementBuffer)
 */
export async function dispatchInboundMessage(
  msg: InboundMessage,
  reply: ReplyHandle,
  appId: string,
  instanceId: string,
  options: DispatchOptions = {}
): Promise<void> {
  const manager = getAppManager()
  if (!manager) {
    console.warn(`${LOG_TAG} App manager not initialized`)
    return
  }

  const app = manager.getApp(appId)
  if (!app) {
    console.log(
      `${LOG_TAG} No app found for appId="${appId}": ` +
      `channel=${msg.channel}, chatId=${msg.chatId}, instanceId=${instanceId}`
    )
    return
  }

  if (!app.spaceId) {
    console.warn(`${LOG_TAG} App "${app.spec.name}" (${app.id}) has no spaceId — cannot dispatch`)
    return
  }

  // ── Reply scope check (security gate) ─────────────────────────
  // Default: 'all' for backward compatibility (existing instances without the
  // field should not break). New instances default to 'group' in the UI.
  const channelManager = getActiveImChannelManager()
  const instanceCfg = channelManager?.getInstanceConfig(instanceId)
  const replyScope = instanceCfg?.replyScope ?? 'all'

  if (replyScope !== 'all' && replyScope !== msg.chatType) {
    const rejectionMsg = msg.chatType === 'direct' ? DM_REJECTED_MESSAGE : GROUP_REJECTED_MESSAGE
    console.log(
      `${LOG_TAG} Blocked by replyScope: scope=${replyScope}, chatType=${msg.chatType}, ` +
      `channel=${msg.channel}, chatId=${msg.chatId}, instanceId=${instanceId}`
    )
    reply.send(rejectionMsg).catch(() => {})
    return
  }

  // ── Streaming disable check ───────────────────────────────────
  // Streaming is opt-in (default off — pipeline currently unstable). Strip the
  // streaming handle unless the instance has explicitly enabled streaming, so the
  // runtime sends only the final reply.
  if (instanceCfg?.streaming !== true && reply.streaming) {
    reply = { ...reply, streaming: undefined }
  }

  // Build isolated session key
  const conversationId = buildImSessionKey(app.id, msg.channel, msg.chatType, msg.chatId)

  // Register session in ImSessionRegistry (idempotent — updates lastActiveAt on repeat)
  const registry = getImSessionRegistry()
  if (registry) {
    const displayName = msg.chatName ?? msg.fromName ?? msg.chatId
    registry.register(app.id, msg.channel, msg.chatId, msg.chatType, instanceId, {
      displayName,
      lastSender: msg.fromName,
      lastMessage: msg.body.slice(0, 50),
    })

    // Notify renderer of session update for real-time panel refresh
    const sessionEvent = {
      appId: app.id,
      channel: msg.channel,
      chatId: msg.chatId,
      chatType: msg.chatType,
      instanceId,
      lastMessage: msg.body.slice(0, 50),
      lastSender: msg.fromName,
    }
    sendToRenderer('app:im-session-updated', sessionEvent)
    broadcastToAll('app:im-session-updated', sessionEvent)
  }

  // ── Stop command: abort generation, silently drop buffered supplements ──
  if (isStopCommand(msg.body)) {
    const dropped = clearSupplementBuffer(conversationId)
    const isActive = activeSessions.has(conversationId)
    if (isActive) {
      console.log(
        `${LOG_TAG} Stop command received: channel=${msg.channel}, chatId=${msg.chatId}, ` +
        `session=${conversationId}, droppedSupplements=${dropped.length}`
      )
      try {
        await stopGeneration(conversationId)
        await reply.send('Generation stopped.')
      } catch (err) {
        console.error(`${LOG_TAG} Failed to stop generation: session=${conversationId}`, err)
        await reply.send('Failed to stop generation.').catch(() => {})
      }
    } else {
      await reply.send('No active generation to stop.').catch(() => {})
    }
    return
  }

  // ── Clear command: reset context, silently drop buffered supplements ──
  if (isClearCommand(msg.body)) {
    const dropped = clearSupplementBuffer(conversationId)
    console.log(
      `${LOG_TAG} Clear command received: channel=${msg.channel}, chatId=${msg.chatId}, ` +
      `session=${conversationId}, droppedSupplements=${dropped.length}`
    )
    try {
      await clearImSession(app.id, app.spaceId!, msg.channel, msg.chatType, msg.chatId)
      clearImPermissionContext(conversationId)
      await reply.send('Context cleared. Starting a fresh conversation.')
    } catch (err) {
      console.error(`${LOG_TAG} Failed to clear context: session=${conversationId}`, err)
      await reply.send('Failed to clear context. Please try again.').catch(() => {})
    }
    return
  }

  // ── Supplement buffering (busy → buffer, flush after generation ends) ──
  if (!options.skipBusyCheck && activeSessions.has(conversationId)) {
    const entry: SupplementEntry = { msg, reply, appId, instanceId }
    const buffer = supplementBuffers.get(conversationId) ?? []
    buffer.push(entry)
    supplementBuffers.set(conversationId, buffer)

    // Ack via proactive push (non-fatal)
    const ackInstance = channelManager?.getInstance(instanceId)
    if (ackInstance) {
      try {
        ackInstance.pushToChat(msg.chatId, buildSupplementAck(buffer), msg.chatType)
      } catch (err) {
        console.error(`${LOG_TAG} Supplement ack push failed:`, err)
      }
    }

    console.log(
      `${LOG_TAG} Buffered as supplement: conv=${conversationId}, ` +
      `bufferSize=${buffer.length}, msgLen=${msg.body.length}`
    )
    return
  }

  // ── Identity injection ───────────────────────────────
  // Direct: senderIdentity in system prompt. Group: per-message <msg-sender> tag.
  // Pre-built paths (from flushSupplementBuffer) short-circuit here.
  const senderName = msg.fromName ?? msg.from
  let messageText: string
  let senderIdentity: { id: string; name: string } | undefined

  if (options.preBuiltMessageText !== undefined) {
    messageText = options.preBuiltMessageText
    senderIdentity = options.preBuiltSenderIdentity
  } else if (msg.chatType === 'direct') {
    messageText = msg.body
    if (msg.from) {
      senderIdentity = { id: msg.from, name: senderName }
    }
  } else {
    // Group: per-message sender tag (AI sees who said what in conversation history)
    messageText = msg.from
      ? `<msg-sender id="${msg.from}" name="${senderName}" />\n${msg.body}`
      : msg.body
  }

  // Resolve owner status and write permission context to the registry.
  // app-chat.ts reads this to enforce tool restrictions for guests.
  //
  // Three cases:
  //   permissionEnabled=false            → everyone is owner (no restrictions, personal use default)
  //   permissionEnabled=true, owners=[]  → everyone is guest, deny-all (no one has write access)
  //   permissionEnabled=true, owners=[…] → only listed IDs are owners; others are guests
  const permissionEnabled = instanceCfg?.permissionEnabled ?? false
  const owners = permissionEnabled ? instanceCfg?.owners : undefined
  const hasOwnerRestriction = Array.isArray(owners) && owners.length > 0
  const isOwner = !permissionEnabled || (hasOwnerRestriction && owners!.includes(msg.from))
  setImPermissionContext(conversationId, {
    senderId: msg.from,
    senderName,
    isOwner,
    guestPolicy: permissionEnabled ? instanceCfg?.guestPolicy : undefined,
    ownerIds: hasOwnerRestriction ? owners! : undefined,
  })

  // Inject file attachment context so the AI can access them via the Read tool.
  // Images are passed separately as multimodal input (see `images` below);
  // files and videos are described here so the AI knows to use Read/Bash.
  if (msg.attachments && msg.attachments.length > 0) {
    const fileLines = msg.attachments
      .map(a => `- [${a.type}] ${a.filename}: ${a.localPath}`)
      .join('\n')
    messageText += `\n\n[Attached files — use the Read tool to access their content]\n${fileLines}`
  }

  // FileExportGate roots = the space's working directory (matches the AI's
  // cwd, where attachments and AI-produced files actually live) + tmpdir.
  // See getSpaceDir() for why this is not the same as space.path.
  const exportGate = new FileExportGate([getSpaceDir(app.spaceId!), tmpdir()])

  // Resolve file-send capability for this instance (absent for text-only channels)
  const chatTypeNorm: 'direct' | 'group' = msg.chatType
  const imFileSend = resolveImFileSend(instanceId, msg.chatId, chatTypeNorm, exportGate)

  // Build IM session context for system prompt injection.
  // Resolves display name with priority: customName > chatName > fromName > chatId.
  // customName is user-set in the UI; chatName comes from the IM platform (often
  // unavailable for group chats in WeCom); fromName/chatId are fallbacks.
  const registeredSession = registry?.findSession(app.id, msg.channel, msg.chatId)
  const sessionDisplayName = registeredSession?.customName
    || msg.chatName
    || msg.fromName
    || msg.chatId
  const imSession: ImSessionContext = {
    channel: msg.channel,
    chatType: msg.chatType,
    displayName: sessionDisplayName,
    sessionId: `${instanceId}:${msg.chatId}`,
    senderIdentity,
  }

  console.log(
    `${LOG_TAG} Routing: channel=${msg.channel}, chatId=${msg.chatId}, ` +
    `chatType=${msg.chatType}, instanceId=${instanceId} → ` +
    `app="${app.spec.name}" (${app.id}), session=${conversationId}, msgLen=${msg.body.length}, ` +
    `attachments=${msg.attachments?.length ?? 0}, images=${msg.images?.length ?? 0}, ` +
    `fileSend=${imFileSend ? 'yes' : 'no'}, ` +
    `sender=${msg.from}(${senderName}), isOwner=${isOwner}`
  )

  // Telemetry: count inbound IM messages (no content). specId is gated by
  // SENSITIVE_KEYS in the telemetry provider; open-source builds drop it.
  void analytics.track(AnalyticsEvents.MESSAGE_RECEIVED, {
    source: 'im',
    channel: msg.channel,
    chatType: msg.chatType,
    appId: app.id,
    specId: app.specId,
  })

  // Send an immediate acknowledgment so the user sees the <think> block appear
  // right away instead of staring at silence while session + MCP servers init.
  if (reply.streaming) {
    reply.streaming.update({ type: 'status', text: 'Received, processing...' }).catch(() => {})
  }

  try {
    await sendAppChatMessage({
      appId: app.id,
      spaceId: app.spaceId,
      message: messageText,
      conversationId,
      images: msg.images,
      imFileSend,
      senderIdentity,
      imSession,

      // Forward progress events to streaming handle (if channel supports streaming)
      onProgress: reply.streaming
        ? (event: ProgressEvent) => {
            reply.streaming!.update(event).catch((err: Error) => {
              console.error(
                `${LOG_TAG} streaming.update failed: channel=${reply.channel}, chatId=${reply.chatId}`,
                err
              )
            })
          }
        : undefined,

      // Use streaming.finish when available, else fall back to one-shot send
      onReply: (finalContent: string) => {
        // Telemetry: count outbound replies (no content). specId is gated
        // by SENSITIVE_KEYS at sanitize time.
        void analytics.track(AnalyticsEvents.MESSAGE_SENT, {
          source: 'im-reply',
          channel: msg.channel,
          chatType: msg.chatType,
          appId: app.id,
          specId: app.specId,
        })

        const replyText = finalContent.slice(0, MAX_REPLY_LENGTH)
        const sendFn = reply.streaming
          ? () => reply.streaming!.finish(replyText)
          : () => reply.send(replyText)
        sendFn().catch((err: Error) => {
          console.error(
            `${LOG_TAG} Reply failed: channel=${reply.channel}, chatId=${reply.chatId}`,
            err
          )
        })
      },
    })
  } catch (err) {
    console.error(
      `${LOG_TAG} Execution failed: app=${app.id}, channel=${msg.channel}, chatId=${msg.chatId}`,
      err
    )
    // Attempt to send error notification back to the IM channel.
    // If streaming was started, we MUST finish the stream rather than sending a
    // separate one-shot reply — otherwise WeCom receives an unterminated stream
    // plus a duplicate message, garbling the user's chat.
    try {
      const errorMsg = `⚠️ Error: ${(err as Error).message?.slice(0, 200) ?? 'Unknown error'}`
      if (reply.streaming) {
        await reply.streaming.finish(errorMsg)
      } else {
        await reply.send(errorMsg)
      }
    } catch {
      // Reply channel may be unavailable — nothing more we can do
    }
  }
}
