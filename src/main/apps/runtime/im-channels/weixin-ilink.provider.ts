/**
 * apps/runtime/im-channels -- WeChat iLink Bot Provider
 *
 * ImChannelProvider implementation for WeChat Personal Bot via iLink API
 * (微信个人号 via iLink API — https://ilinkai.weixin.qq.com).
 *
 * Protocol (confirmed):
 * - QR code login flow (GET /ilink/bot/get_bot_qrcode + GET /ilink/bot/get_qrcode_status)
 * - HTTP long-polling for inbound messages (POST /ilink/bot/getupdates, up to 35s hold)
 * - HTTP POST for outbound messages (POST /ilink/bot/sendmessage)
 * - Auth via `bot_token` obtained after QR scan — stored in instance config
 * - context_token is per-message, no expiry; echoed back verbatim in reply
 * - Missing context_token is a hard error — send is blocked until next inbound msg
 * - errcode/ret === -14 means session expired → stop and require re-auth
 * - AbortController used for clean long-poll cancellation on stop()
 * - Exponential backoff reconnect: 2s base, 30s cap, 100 attempts max
 * - context_token cache key: `${accountId}:${userId}` (accountId = ilink_bot_id)
 * - Media rides the WeChat C2C CDN in both directions — see ilink-media.ts;
 *   inbound handles are downloaded and staged as local files, outbound files
 *   are uploaded and referenced from a sendmessage image/file item
 * - An item whose media cannot be resolved degrades to a text placeholder
 *   rather than costing the user the rest of the message
 * - Inbound handling runs off the poll loop: serialised per chat so one
 *   conversation stays in order, and capped process-wide so a backlog of media
 *   cannot fan out into memory
 */

import { randomUUID } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import type {
  ImChannelProvider,
  ImChannelInstance,
  ImChannelConfigFieldDef,
  ImChannelType,
  ImFileCapability,
} from '../../../../shared/types/im-channel'
import type {
  InboundMessage,
  InboundAttachment,
  ReplyHandle,
} from '../../../../shared/types/inbound-message'
import type { ImageAttachment, ImageMediaType } from '../../../services/agent/types'
import { Semaphore } from '../concurrency'
import {
  ILINK_BASE_URL,
  CHANNEL_VERSION,
  buildAuthHeaders,
  isSessionExpired,
  fetchJson,
} from './ilink-api'
import {
  downloadIlinkMedia,
  uploadIlinkMedia,
  MAX_MEDIA_BYTES,
  type IlinkCdnMedia,
  type IlinkMediaItem,
} from './ilink-media'
import { stageMediaFile, pruneMediaTempDir } from './media-temp-files'

// ============================================
// Constants
// ============================================

const RECONNECT_BASE_DELAY_MS = 2_000
const RECONNECT_MAX_DELAY_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 100
const DEDUP_MAX_SIZE = 200

/** Local temp directory for downloaded iLink media. */
const TEMP_DIR = join(tmpdir(), 'halo-weixin-ilink')
/** Downloaded media only has to outlive a single agent execution. */
const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000
/**
 * Cap on an image inlined as multimodal input. Base64 expands the payload by
 * a third, so this keeps a single image inside the request-wide image budget.
 * Larger images are still attached as files, just not inlined.
 */
const MAX_INLINE_IMAGE_BYTES = 2.5 * 1024 * 1024
/**
 * Cap on how many images from one message are inlined. Without it a single
 * message carrying N images sends N × MAX_INLINE_IMAGE_BYTES of base64 into the
 * model request. The rest still arrive as file attachments.
 */
const MAX_INLINE_IMAGES = 4
/** File extensions sent as an image item; WeChat rejects anything else inline. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
])
const INLINE_IMAGE_MIMES = new Set<string>([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
])
const MEDIA_LABEL: Record<InboundMediaKind, string> = {
  image: 'Image',
  file: 'File',
  video: 'Video',
}

/**
 * Downloads run detached from the poll loop, so nothing else bounds how many a
 * backlog can start at once — and each one buffers up to MAX_MEDIA_BYTES in the
 * main process. Shared by every instance, because the memory ceiling is a
 * property of the process, not of one account.
 */
const MAX_CONCURRENT_MEDIA_DOWNLOADS = 3
const mediaDownloadSlots = new Semaphore(MAX_CONCURRENT_MEDIA_DOWNLOADS)

// ============================================
// Public temp-file cleanup
// ============================================

/**
 * Remove stale iLink media temp files. Called once at startup by the
 * im-channels layer.
 */
export function cleanupWeixinIlinkTempFiles(): void {
  const cleaned = pruneMediaTempDir(TEMP_DIR, TEMP_FILE_TTL_MS)
  if (cleaned > 0) {
    console.log(`[WeixinIlink] Cleaned ${cleaned} stale temp file(s) from ${TEMP_DIR}`)
  }
}

// ============================================
// Provider-local types
// ============================================

interface WeixinIlinkConfig {
  botToken?: string
  baseUrl?: string
  accountId?: string   // ilink_bot_id — used as part of context_token cache key
}

/** Inbound media kinds that are downloaded and surfaced as attachments. */
type InboundMediaKind = 'image' | 'file' | 'video'

/** One entry of an inbound `item_list`; the server omits handles it has none for. */
interface WeixinMessageItem {
  type: number   // 1=text, 2=image, 3=voice, 4=file, 5=video
  text_item?: { text: string }
  voice_item?: { text?: string }
  image_item?: IlinkMediaItem
  /** Both name spellings are read — the server has been seen using either. */
  file_item?: IlinkMediaItem & { file_name?: string; filename?: string }
  video_item?: IlinkMediaItem
}

/** Outbound item_list entry — 1=text, 2=image, 4=file. */
interface WeixinOutboundItem {
  type: 1 | 2 | 4
  text_item?: { text: string }
  image_item?: { media: IlinkCdnMedia; mid_size: number }
  file_item?: { media: IlinkCdnMedia; file_name: string; file_size: number }
}

interface WeixinMessage {
  from_user_id?: string
  to_user_id?: string
  message_id?: number    // Server-assigned numeric ID
  message_type?: number  // 1=USER (inbound), 2=BOT (outbound)
  message_state?: number
  context_token?: string
  item_list?: WeixinMessageItem[]
}

interface GetUpdatesResponse {
  ret?: number           // May be absent on success — treat missing as 0
  errcode?: number
  msgs?: WeixinMessage[]
  get_updates_buf: string
  longpolling_timeout_ms?: number
}

// ============================================
// Provider
// ============================================

export class WeixinIlinkBotProvider implements ImChannelProvider {
  readonly type: ImChannelType = 'weixin-ilink-bot'
  readonly displayName = 'WeChat iLink Bot'
  readonly description = 'WeChat personal bot via iLink API (QR code login)'
  readonly direction = 'bidirectional' as const

  // No configFields — QR flow is done via separate IPC, not text form inputs
  readonly configFields: ImChannelConfigFieldDef[] = []

  readonly defaultConfig: Record<string, unknown> = {
    botToken: '',
    baseUrl: '',
    accountId: '',
  }

  createInstance(instanceId: string, config: Record<string, unknown>): ImChannelInstance {
    return new WeixinIlinkBotInstance(instanceId, config as unknown as WeixinIlinkConfig)
  }

  validateConfig(_config: Record<string, unknown>): string | null {
    // No required user-facing fields — bot_token is obtained via QR flow
    return null
  }
}

// ============================================
// Instance
// ============================================

class WeixinIlinkBotInstance implements ImChannelInstance {
  readonly instanceId: string
  readonly providerType: ImChannelType = 'weixin-ilink-bot'

  private config: WeixinIlinkConfig
  private active = false
  private connected = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pollAbortController: AbortController | null = null
  /**
   * Aborted when the instance goes down for good — stop(), or a fatal error.
   * Media downloads outlive the poll iteration that dispatched them, so they
   * cannot ride the per-poll controller, which reconnect() aborts while those
   * downloads are still legitimately running.
   */
  private shutdownController = new AbortController()
  private inboundHandler: ((msg: InboundMessage, reply: ReplyHandle) => void) | null = null

  // context_token cache: key is `${accountId}:${userId}`, value is most recent context_token.
  // Per-message, no expiry. Missing = hard error on send.
  private contextTokens = new Map<string, string>()

  // Message deduplication: circular buffer of last N message IDs
  private seenMessageIds: string[] = []

  // Long-poll cursor — empty string means start from the beginning
  private updatesBuf = ''

  // Tail of each chat's in-flight handling chain, keyed by chatId
  private chatQueues = new Map<string, Promise<void>>()

  readonly fileCapability: ImFileCapability = {
    sendFile: (chatId, file) =>
      this.sendFileToChat(chatId, file.resolvedPath, file.displayName),
  }

  constructor(instanceId: string, config: WeixinIlinkConfig) {
    this.instanceId = instanceId
    this.config = config
  }

  // ── ImChannelInstance interface ───────────────────────────────

  onInbound(handler: (msg: InboundMessage, reply: ReplyHandle) => void): void {
    this.inboundHandler = handler
  }

  start(): void {
    this.active = true
    if (this.shutdownController.signal.aborted) {
      this.shutdownController = new AbortController()
    }
    if (!this.config.botToken) {
      console.log(`[WeixinIlink:${this.instanceId}] No bot_token configured — waiting for QR login`)
      return
    }
    this.startPolling()
    console.log(`[WeixinIlink:${this.instanceId}] Started`)
  }

  stop(): void {
    this.active = false
    this.connected = false
    this.abortCurrentPoll()
    this.shutdownController.abort()
    this.inboundHandler = null
    this.contextTokens.clear()
    this.seenMessageIds = []
    this.chatQueues.clear()
    this.updatesBuf = ''
    this.reconnectAttempts = 0
    console.log(`[WeixinIlink:${this.instanceId}] Stopped`)
  }

  reconnect(): void {
    if (!this.active) return
    this.abortCurrentPoll()
    this.connected = false
    this.reconnectAttempts = 0
    this.updatesBuf = ''
    if (this.config.botToken) {
      this.startPolling()
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  pushToChat(chatId: string, text: string, _chatType: 'direct' | 'group'): boolean {
    if (!this.config.botToken) {
      console.warn(`[WeixinIlink:${this.instanceId}] Cannot push: no bot_token`)
      return false
    }
    const contextToken = this.contextTokens.get(this.contextTokenKey(chatId))
    if (!contextToken) {
      console.warn(
        `[WeixinIlink:${this.instanceId}] Cannot push to ${chatId}: ` +
        'no context_token — blocked until next inbound message from user'
      )
      return false
    }
    this.sendMessage(chatId, text, contextToken).catch((err) => {
      console.error(`[WeixinIlink:${this.instanceId}] pushToChat failed for ${chatId}:`, err)
    })
    return true
  }

  // ── Long-poll loop ────────────────────────────────────────────

  private startPolling(): void {
    this.abortCurrentPoll()
    this.connected = false
    this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    while (this.active && this.config.botToken) {
      const abortController = new AbortController()
      this.pollAbortController = abortController

      try {
        const baseUrl = this.config.baseUrl || ILINK_BASE_URL
        const url = `${baseUrl}/ilink/bot/getupdates`
        const headers = buildAuthHeaders(this.config.botToken)
        const body = {
          get_updates_buf: this.updatesBuf,
          base_info: { channel_version: CHANNEL_VERSION },
        }

        const response = await fetchJson<GetUpdatesResponse>(
          'POST',
          url,
          headers,
          body,
          abortController.signal
        )

        if (!this.active) break

        // iLink API omits `ret` on success — treat missing as 0.
        // Use errcode as fallback; errcode=-14 means session expired.
        const retCode = response.ret ?? response.errcode ?? 0

        // Session expired — stop and require re-auth
        if (isSessionExpired(retCode, response.errcode)) {
          console.error(
            `[WeixinIlink:${this.instanceId}] Session expired (code -14) — re-auth via QR required`
          )
          this.haltOnFatal()
          break
        }

        if (retCode !== 0) {
          console.warn(
            `[WeixinIlink:${this.instanceId}] getupdates error retCode=${retCode} errcode=${response.errcode ?? 'n/a'}, will retry`
          )
          this.connected = false
          await this.backoffDelay()
          continue
        }

        // Successful response
        if (!this.connected) {
          this.connected = true
          this.reconnectAttempts = 0
          console.log(`[WeixinIlink:${this.instanceId}] Connected (long-poll active)`)
        }

        if (response.get_updates_buf) {
          this.updatesBuf = response.get_updates_buf
        }

        // Dispatched without awaiting: handling downloads media, and the poll
        // must be back on getupdates long before a slow CDN finishes.
        if (response.msgs && response.msgs.length > 0) {
          for (const msg of response.msgs) {
            if (msg.message_type !== 1) continue
            this.dispatchInChatOrder(msg)
          }
        }

        // Re-poll immediately — server holds connection up to 35s
      } catch (err: unknown) {
        if (!this.active) break

        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg === 'Aborted') break

        console.error(`[WeixinIlink:${this.instanceId}] Poll error:`, errMsg)
        this.connected = false
        await this.backoffDelay()
      }
    }

    this.pollAbortController = null
  }

  private async backoffDelay(): Promise<void> {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[WeixinIlink:${this.instanceId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, stopping`
      )
      this.haltOnFatal()
      return
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS
    )
    this.reconnectAttempts++
    console.log(
      `[WeixinIlink:${this.instanceId}] Backing off ${delay}ms (attempt ${this.reconnectAttempts})`
    )
    await new Promise<void>((resolve) => {
      this.reconnectTimer = setTimeout(resolve, delay)
    })
    this.reconnectTimer = null
  }

  /**
   * Give up on the channel from the inside — session expiry, exhausted
   * reconnects. Downloads still in flight are aborted rather than left to run
   * to their deadline and stage files nothing will ever read; start() issues a
   * fresh controller once the channel is revived.
   */
  private haltOnFatal(): void {
    this.active = false
    this.connected = false
    this.abortCurrentPoll()
    this.shutdownController.abort()
  }

  private abortCurrentPoll(): void {
    if (this.pollAbortController) {
      this.pollAbortController.abort()
      this.pollAbortController = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // ── Inbound message handling ─────────────────────────────────

  /**
   * Hand a message to its chat's queue. Detached handling would otherwise let a
   * text-only message overtake an earlier one whose media is still downloading,
   * so each conversation is serialised while separate chats still run in
   * parallel. The tail is dropped once it drains, so the map only ever holds
   * chats with work in flight.
   */
  private dispatchInChatOrder(msg: WeixinMessage): void {
    const chatId = msg.from_user_id
    if (!chatId) return

    const tail = this.chatQueues.get(chatId) ?? Promise.resolve()
    const next: Promise<void> = tail
      .then(() => this.handleInboundMessage(msg))
      .catch((err) => {
        console.error(
          `[WeixinIlink:${this.instanceId}] Inbound handling failed for message ` +
          `${msg.message_id ?? 'n/a'}:`,
          err
        )
      })
      .finally(() => {
        if (this.chatQueues.get(chatId) === next) this.chatQueues.delete(chatId)
      })
    this.chatQueues.set(chatId, next)
  }

  private async handleInboundMessage(msg: WeixinMessage): Promise<void> {
    if (!this.active || !this.inboundHandler) return

    const userId = msg.from_user_id
    if (!userId) return

    // Deduplicate — prefer numeric message_id, fall back to context composite
    const msgId = msg.message_id != null
      ? String(msg.message_id)
      : `${userId}:${msg.context_token ?? Date.now()}`
    if (this.isDuplicate(msgId)) {
      console.log(`[WeixinIlink:${this.instanceId}] Duplicate message skipped: ${msgId}`)
      return
    }
    this.trackMessageId(msgId)

    // Cache context_token — per-message, no expiry, overwritten on each new message
    if (msg.context_token) {
      this.contextTokens.set(this.contextTokenKey(userId), msg.context_token)
    }

    const { text, attachments, images } = await this.collectContent(msg)
    if (!this.active || !this.inboundHandler) return

    console.log(
      `[WeixinIlink:${this.instanceId}] Inbound from=${userId} len=${text.length} ` +
      `attachments=${attachments.length} images=${images.length}`
    )

    const inbound: InboundMessage = {
      body: text,
      from: userId,
      fromName: userId,
      channel: 'weixin-ilink-bot',
      chatType: 'direct',
      chatId: userId,
      messageId: msgId,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(images.length > 0 ? { images } : {}),
    }

    // Capture context_token at dispatch time — must be echoed in reply
    const contextToken = msg.context_token
    const reply: ReplyHandle = {
      channel: 'weixin-ilink-bot',
      chatId: userId,
      // replyTtlMs omitted — context_token has no expiry; reply path is always valid
      send: async (replyText: string): Promise<void> => {
        if (!contextToken) {
          throw new Error(
            `[WeixinIlink:${this.instanceId}] Cannot reply to ${userId}: missing context_token`
          )
        }
        await this.sendMessage(userId, replyText, contextToken)
      },
    }

    this.inboundHandler(inbound, reply)
  }

  /**
   * Turn the item list into message text plus downloaded media. Media failures
   * degrade to a text placeholder so one bad item cannot cost the user the
   * whole message.
   */
  private async collectContent(msg: WeixinMessage): Promise<{
    text: string
    attachments: InboundAttachment[]
    images: ImageAttachment[]
  }> {
    const parts: string[] = []
    const attachments: InboundAttachment[] = []
    const images: ImageAttachment[] = []

    for (const item of msg.item_list ?? []) {
      switch (item.type) {
        case 1:
          if (item.text_item?.text) parts.push(item.text_item.text)
          break
        case 2:
          parts.push(await this.collectMedia(item, 'image', attachments, images))
          break
        case 3:
          // Speech-to-text transcript when the server supplies one; the audio
          // itself is not surfaced. A voice message without a transcript is
          // ordinary traffic, not something to report.
          parts.push(item.voice_item?.text || '[Voice]')
          break
        case 4:
          parts.push(await this.collectMedia(item, 'file', attachments, images))
          break
        case 5:
          parts.push(await this.collectMedia(item, 'video', attachments, images))
          break
        default:
          console.warn(
            `[WeixinIlink:${this.instanceId}] Unhandled inbound item type ${item.type}`
          )
          parts.push(`[Unknown message type: ${item.type}]`)
      }
    }

    return { text: parts.join('\n').trim(), attachments, images }
  }

  /** Download one media item into the temp store and return its text label. */
  private async collectMedia(
    item: WeixinMessageItem,
    kind: InboundMediaKind,
    attachments: InboundAttachment[],
    images: ImageAttachment[],
  ): Promise<string> {
    const label = MEDIA_LABEL[kind]
    const handle = kind === 'image'
      ? item.image_item
      : kind === 'video' ? item.video_item : item.file_item
    const wireName = kind === 'file'
      ? item.file_item?.file_name || item.file_item?.filename
      : undefined

    if (!handle) {
      console.warn(`[WeixinIlink:${this.instanceId}] Inbound ${kind} item carries no media handle`)
      return `[${label}]`
    }

    await mediaDownloadSlots.acquire()
    try {
      const { data, mime } = await downloadIlinkMedia(handle, kind, this.shutdownController.signal)
      const staged = await stageMediaFile(
        TEMP_DIR,
        wireName || this.defaultMediaName(kind, mime),
        data,
      )

      attachments.push({
        type: kind,
        filename: staged.filename,
        localPath: staged.localPath,
        mimeType: mime,
      })

      if (
        kind === 'image' &&
        INLINE_IMAGE_MIMES.has(mime) &&
        data.length <= MAX_INLINE_IMAGE_BYTES &&
        images.length < MAX_INLINE_IMAGES
      ) {
        images.push({
          id: `ilink_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'image',
          mediaType: mime as ImageMediaType,
          data: data.toString('base64'),
          name: staged.filename,
        })
      }

      console.log(
        `[WeixinIlink:${this.instanceId}] Media ready kind=${kind} ` +
        `name=${staged.filename} bytes=${data.length} mime=${mime}`
      )
      return `[${label}: ${staged.filename}]`
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[WeixinIlink:${this.instanceId}] Inbound ${kind} download failed: ${message}`)
      return wireName
        ? `[${label}: ${wireName} — download failed]`
        : `[${label} — download failed]`
    } finally {
      mediaDownloadSlots.release()
    }
  }

  private defaultMediaName(kind: InboundMediaKind, mime: string): string {
    // An image the download could not type arrives as a generic MIME, and
    // `.octet-stream` is not an extension anyone wants to see.
    if (kind === 'image') {
      return `image_${Date.now()}.${mime.startsWith('image/') ? mime.slice('image/'.length) : 'bin'}`
    }
    if (kind === 'video') return `video_${Date.now()}.mp4`
    return `file_${Date.now()}`
  }

  // ── Send message ──────────────────────────────────────────────

  private sendMessage(toUserId: string, text: string, contextToken: string): Promise<void> {
    return this.sendItems(toUserId, [{ type: 1, text_item: { text } }], contextToken)
  }

  private async sendItems(
    toUserId: string,
    itemList: WeixinOutboundItem[],
    contextToken: string
  ): Promise<void> {
    if (!this.config.botToken) {
      throw new Error(`[WeixinIlink:${this.instanceId}] Cannot send: no bot_token`)
    }
    if (!contextToken) {
      throw new Error(
        `[WeixinIlink:${this.instanceId}] Cannot send to ${toUserId}: missing context_token`
      )
    }

    const baseUrl = this.config.baseUrl || ILINK_BASE_URL
    const url = `${baseUrl}/ilink/bot/sendmessage`
    const headers = buildAuthHeaders(this.config.botToken)

    const body = {
      msg: {
        from_user_id: '',            // Always empty for bot-originated messages
        to_user_id: toUserId,
        client_id: randomUUID(),     // Idempotency key
        message_type: 2,             // BOT
        message_state: 2,            // FINISH
        context_token: contextToken,
        item_list: itemList,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }

    interface SendMessageResponse { ret?: number; errcode?: number; errmsg?: string }
    const response = await fetchJson<SendMessageResponse>(
      'POST',
      url,
      headers,
      body
    )

    const sendRetCode = response.ret ?? response.errcode ?? 0
    if (isSessionExpired(sendRetCode, response.errcode)) {
      this.haltOnFatal()
      throw new Error(
        `[WeixinIlink:${this.instanceId}] Session expired (code -14) — re-auth required`
      )
    }

    if (sendRetCode !== 0) {
      throw new Error(
        `[WeixinIlink:${this.instanceId}] sendmessage failed: retCode=${sendRetCode} msg=${response.errmsg ?? ''}`
      )
    }

    console.log(`[WeixinIlink:${this.instanceId}] Message sent to ${toUserId}`)
  }

  // ── Send file (CDN upload + media item) ───────────────────────

  private async sendFileToChat(
    chatId: string,
    filePath: string,
    displayName: string,
  ): Promise<boolean> {
    if (!this.config.botToken) {
      console.warn(`[WeixinIlink:${this.instanceId}] Cannot send file: no bot_token`)
      return false
    }
    const contextToken = this.contextTokens.get(this.contextTokenKey(chatId))
    if (!contextToken) {
      console.warn(
        `[WeixinIlink:${this.instanceId}] Cannot send file to ${chatId}: ` +
        'no context_token — blocked until next inbound message from user'
      )
      return false
    }

    try {
      // Size is checked before reading — uploadIlinkMedia's own cap would only
      // fire once the whole file is already resident in the main process.
      const { size } = await stat(filePath)
      if (size > MAX_MEDIA_BYTES) {
        console.warn(
          `[WeixinIlink:${this.instanceId}] Cannot send ${displayName} to ${chatId}: ` +
          `${size} bytes exceeds the ${MAX_MEDIA_BYTES} byte limit`
        )
        return false
      }

      const data = await readFile(filePath)
      // The extension is read off the name the recipient will see, so the item
      // type and the file_name never disagree about what is being sent.
      const asImage = IMAGE_EXTENSIONS.has(extname(displayName).toLowerCase())

      const { media, ciphertextSize } = await uploadIlinkMedia({
        baseUrl: this.config.baseUrl,
        botToken: this.config.botToken,
        toUserId: chatId,
        kind: asImage ? 'image' : 'file',
        data,
      })

      // mid_size describes the encrypted CDN object; file_size is rendered to
      // the user as the size of their file, so it carries the raw byte count.
      const item: WeixinOutboundItem = asImage
        ? { type: 2, image_item: { media, mid_size: ciphertextSize } }
        : {
            type: 4,
            file_item: { media, file_name: displayName, file_size: data.length },
          }

      await this.sendItems(chatId, [item], contextToken)
      console.log(
        `[WeixinIlink:${this.instanceId}] File sent to ${chatId}: ` +
        `name=${displayName} bytes=${data.length} as=${asImage ? 'image' : 'file'}`
      )
      return true
    } catch (err) {
      console.error(
        `[WeixinIlink:${this.instanceId}] sendFile failed for ${chatId} (${displayName}):`,
        err
      )
      return false
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Build the context_token cache key.
   * Uses `${accountId}:${userId}` when accountId (ilink_bot_id) is available,
   * otherwise just userId.
   */
  private contextTokenKey(userId: string): string {
    return this.config.accountId ? `${this.config.accountId}:${userId}` : userId
  }

  private isDuplicate(msgId: string): boolean {
    return this.seenMessageIds.includes(msgId)
  }

  private trackMessageId(msgId: string): void {
    if (this.seenMessageIds.length >= DEDUP_MAX_SIZE) {
      this.seenMessageIds.shift()
    }
    this.seenMessageIds.push(msgId)
  }
}
