/**
 * apps/runtime/im-channels -- WeCom Bot Provider (SDK-backed)
 *
 * ImChannelProvider implementation for WeCom Intelligent Bot (企业微信智能机器人).
 *
 * This is a thin adapter on top of `@wecom/aibot-node-sdk`. The SDK owns:
 *   - WebSocket lifecycle (connect / heartbeat / reconnect / auth)
 *   - Reply queueing per req_id with ack-waiting
 *   - Non-blocking back-pressure for stream frames
 *   - Chunked media upload (init → chunk → finish)
 *   - Encrypted file download with AES-256-CBC decrypt
 *
 * This file owns:
 *   - InboundMessage construction (translates SDK events to the normalized
 *     contract consumed by dispatch-inbound)
 *   - 24h reply-window tracking (caches the inbound WsFrame per chatId so
 *     we can call replyMedia / replyStream long after the original event)
 *   - Pending-push queue across brief WS bounces
 *   - StreamingTransport implementation backing WecomStreamSession
 *   - Provider/Instance lifecycle that plugs into ImChannelManager
 *
 * Long-task support is delegated to WecomStreamSession: when a stream is
 * about to hit the WeCom 10-minute single-stream cutoff, it proactively
 * finishes and switches to discrete proactive pushes via the queue.
 *
 * Protocol time limits (per official docs):
 *   - Reply window: 24 hours after inbound callback
 *   - Stream message: 10 minutes from first packet to finish=true
 *   - Media URL: 5 minutes (download window for image/file/video)
 *
 * Logging conventions: every event is emitted via the same key=value
 * `event=<name> field=value ...` shape historically used by this module.
 * SDK-internal logs are routed through the SDK's `logger` option and tagged
 * with `event=sdk` so they remain grep-distinguishable from our own events.
 */

import AiBot, {
  type WsFrame,
  type WsFrameHeaders,
  type BaseMessage,
  type TextMessage,
  type ImageMessage,
  type FileMessage,
  type VideoMessage,
  type MixedMessage,
  type Logger as SdkLogger,
  type WeComMediaType,
} from '@wecom/aibot-node-sdk'
import { readdirSync, statSync, unlinkSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join, basename, extname } from 'path'
import type {
  ImChannelProvider,
  ImChannelInstance,
  ImFileCapability,
  ImChannelConfigFieldDef,
  ImChannelType,
} from '../../../../shared/types/im-channel'
import type {
  InboundMessage,
  InboundAttachment,
  ReplyHandle,
  StreamingHandle,
  ProgressEvent,
} from '../../../../shared/types/inbound-message'
import type { ImageAttachment, ImageMediaType } from '../../../services/agent/types'
import {
  WecomStreamSession,
  type StreamingTransport,
  type StreamLogger,
  type StreamLogLevel,
} from './wecom-stream-session'
import { ensureUtf8 } from './wecom-content-utf8'

// ============================================
// Constants
// ============================================

const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com'
/** 24h reply window per official docs ("收到消息回调后，24小时内可以往该会话回复消息"). */
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000
/** Max wait for WS re-auth before dropping a queued push. */
const PUSH_QUEUE_WAIT_MS = 2 * 60 * 1000
/** Interval for periodic health-snapshot log lines. */
const HEALTH_SNAPSHOT_INTERVAL_MS = 5 * 60_000
/** Cleanup cadence for the inbound-frame cache (24h-expired entries). */
const REQ_ID_CLEANUP_INTERVAL_MS = 5 * 60_000
/** Local temp directory for downloaded WeCom media. */
const TEMP_DIR = join(tmpdir(), 'halo-wecom')
/** Image file extensions that map to WeCom 'image' media type. */
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp',
])

// ============================================
// Structured Logging
// ============================================

type LogLevel = 'info' | 'warn' | 'error'
type LogFields = Record<string, string | number | boolean | null | undefined>

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') {
    if (/[\s=]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`
    return v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return String(v)
}

function logEvent(
  instanceId: string,
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const parts: string[] = [`[WecomBot:${instanceId}]`, `event=${event}`]
  for (const key of Object.keys(fields)) {
    const val = fields[key]
    if (val === undefined) continue
    parts.push(`${key}=${formatVal(val)}`)
  }
  const line = parts.join(' ')
  // eslint-disable-next-line no-console -- structured logger by design
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

let traceIdCounter = 0
function generateTraceId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++traceIdCounter).toString(36)}`
}

// ============================================
// Public temp-file cleanup
// ============================================

/**
 * Remove stale WeCom media temp files older than 24 hours.
 *
 * Called once at startup by the im-channels layer. Files are only needed
 * for the duration of a single agent execution, so anything older than 24h
 * is safe to remove.
 */
export function cleanupWecomTempFiles(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  let cleaned = 0
  try {
    const files = readdirSync(TEMP_DIR)
    for (const f of files) {
      const fp = join(TEMP_DIR, f)
      try {
        if (statSync(fp).mtimeMs < cutoff) {
          unlinkSync(fp)
          cleaned++
        }
      } catch {
        /* file may be in use or already gone */
      }
    }
    if (cleaned > 0) {
      logEvent('_startup', 'info', 'temp_files_cleaned', {
        cleaned,
        dir: TEMP_DIR,
      })
    }
  } catch {
    /* directory may not exist on first run */
  }
}

// ============================================
// Provider
// ============================================

interface WecomBotProviderConfig {
  botId: string
  secret: string
  wsUrl?: string
  /**
   * Whether GROUP replies should carry WeCom's quote-reply bubble.
   *
   * WeCom renders a quote bubble whenever a reply is sent via aibot_respond_msg
   * (passive reply carrying the inbound req_id) or aibot_reply_stream. Setting
   * this to false routes GROUP replies through aibot_send_msg (proactive push)
   * which carries no req_id and therefore renders as plain text. Direct
   * messages always keep the quote bubble regardless of this setting.
   *
   * Default: true (preserves the legacy quote-bubble behavior).
   */
  quoteReply?: boolean
}

export class WecomBotProvider implements ImChannelProvider {
  readonly type: ImChannelType = 'wecom-bot'
  readonly displayName = 'WeCom Intelligent Bot'
  readonly description = 'Bidirectional messaging via WeCom AI Bot WebSocket'
  readonly direction = 'bidirectional' as const

  readonly configFields: ImChannelConfigFieldDef[] = [
    { key: 'botId', label: 'Bot ID', type: 'text', placeholder: 'aib-xxx', required: true },
    { key: 'secret', label: 'Secret', type: 'password', required: true },
    { key: 'wsUrl', label: 'WebSocket URL', type: 'text', placeholder: 'wss://openws.work.weixin.qq.com' },
    { key: 'quoteReply', label: 'Quote Reply', type: 'toggle', default: true },
  ]

  readonly defaultConfig: Record<string, unknown> = {
    botId: '',
    secret: '',
    wsUrl: '',
    quoteReply: true,
  }

  createInstance(instanceId: string, config: Record<string, unknown>): ImChannelInstance {
    return new WecomBotInstance(instanceId, config as unknown as WecomBotProviderConfig)
  }

  validateConfig(config: Record<string, unknown>): string | null {
    if (!config.botId || typeof config.botId !== 'string') return 'Bot ID is required'
    if (!config.secret || typeof config.secret !== 'string') return 'Secret is required'
    return null
  }
}

// ============================================
// Instance
// ============================================

/** Cached inbound frame headers keyed by chatId, with arrival timestamp. */
interface FrameCacheEntry {
  /** Stored frame is enough to satisfy the SDK's WsFrameHeaders requirement. */
  frame: WsFrameHeaders
  ts: number
}

/** A queued push waiting for the WS to re-authenticate. */
interface PendingPush {
  chatId: string
  text: string
  chatType: 'direct' | 'group'
  enqueuedAt: number
  sourceTag: string
  trace: string | undefined
  resolve: (sent: boolean) => void
}

class WecomBotInstance implements ImChannelInstance {
  readonly instanceId: string
  readonly providerType: ImChannelType = 'wecom-bot'

  private config: WecomBotProviderConfig
  private wsClient: InstanceType<typeof AiBot.WSClient> | null = null
  private active = false
  private authenticated = false
  private inboundHandler:
    | ((msg: InboundMessage, reply: ReplyHandle) => void)
    | null = null

  /** Cached inbound frames per chat for 24h reply window. */
  private frameCache = new Map<string, FrameCacheEntry>()
  /** Stream sessions in flight — for cleanup on WS close. */
  private activeStreamSessions = new Set<WecomStreamSession>()
  /** Pushes deferred while WS is unauthenticated; flushed on next auth. */
  private pendingPushes: PendingPush[] = []
  /** Timer handles for cleanup on stop(). */
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null
  private healthSnapshotTimer: ReturnType<typeof setInterval> | null = null
  /** Counters surfaced in the periodic health snapshot. */
  private counters = {
    totalInbound: 0,
    totalReply: 0,
    totalPush: 0,
    totalStreamPackets: 0,
    totalError: 0,
    totalDispatched: 0,
  }
  /** Timestamp instance was started, for uptime in snapshots. */
  private startedAt = 0

  constructor(instanceId: string, config: WecomBotProviderConfig) {
    this.instanceId = instanceId
    this.config = config
  }

  // ── ImChannelInstance interface ────────────────────────────────

  onInbound(handler: (msg: InboundMessage, reply: ReplyHandle) => void): void {
    this.inboundHandler = handler
  }

  start(): void {
    this.active = true
    this.startedAt = Date.now()
    if (!this.config.botId || !this.config.secret) {
      logEvent(this.instanceId, 'warn', 'start_skip', {
        reason: 'missing botId or secret',
      })
      return
    }
    this.openClient()
    this.cacheCleanupTimer = setInterval(
      () => this.cleanupExpiredFrames(),
      REQ_ID_CLEANUP_INTERVAL_MS,
    )
    this.healthSnapshotTimer = setInterval(
      () => this.emitHealthSnapshot('periodic'),
      HEALTH_SNAPSHOT_INTERVAL_MS,
    )
    logEvent(this.instanceId, 'info', 'instance_start', {
      botIdPrefix: this.config.botId.slice(0, 8),
      wsUrl: this.config.wsUrl || DEFAULT_WS_URL,
    })
  }

  stop(): void {
    this.active = false
    this.authenticated = false
    this.emitHealthSnapshot('stop')
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer)
      this.cacheCleanupTimer = null
    }
    if (this.healthSnapshotTimer) {
      clearInterval(this.healthSnapshotTimer)
      this.healthSnapshotTimer = null
    }
    if (this.pendingPushes.length > 0) {
      logEvent(this.instanceId, 'warn', 'push_queue_drop_on_stop', {
        count: this.pendingPushes.length,
      })
      const drained = this.pendingPushes.splice(0)
      for (const entry of drained) entry.resolve(false)
    }
    this.activeStreamSessions.forEach((s) => s.dispose())
    this.activeStreamSessions.clear()
    try {
      this.wsClient?.disconnect()
    } catch (err) {
      logEvent(this.instanceId, 'warn', 'ws_disconnect_error', {
        err: err instanceof Error ? err.message : String(err),
      })
    }
    this.wsClient = null
    this.inboundHandler = null
    this.frameCache.clear()
    logEvent(this.instanceId, 'info', 'instance_stop', {})
  }

  reconnect(): void {
    if (!this.active) return
    try {
      this.wsClient?.disconnect()
    } catch {
      /* ignore */
    }
    this.wsClient = null
    this.authenticated = false
    if (this.config.botId && this.config.secret) {
      this.openClient()
    }
  }

  isConnected(): boolean {
    return this.wsClient?.isConnected === true && this.authenticated
  }

  /**
   * Synchronous push via SDK aibot_send_msg. The SDK returns a Promise that
   * resolves on ack, but the ImChannelInstance contract is `boolean` — we
   * fire-and-forget and report whether the WS was ready to accept the send.
   * Errors after the synchronous return are logged but do not retroactively
   * change the return value.
   */
  pushToChat(
    chatId: string,
    text: string,
    chatType: 'direct' | 'group',
    trace?: string,
  ): boolean {
    if (!this.wsClient || !this.authenticated) {
      logEvent(this.instanceId, 'warn', 'push_unavailable', {
        trace,
        chatId,
        chatType,
        authenticated: this.authenticated,
        cat: 'network',
      })
      return false
    }

    const sanitized = ensureUtf8(text)
    const bytes = Buffer.byteLength(sanitized, 'utf8')

    // Fire and forget — the SDK queues + acks under the hood.
    void this.wsClient
      .sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: sanitized },
      })
      .then(() => {
        this.counters.totalPush++
        logEvent(this.instanceId, 'info', 'push_sent', {
          trace,
          chatId,
          chatType,
          bytes,
        })
      })
      .catch((err: Error) => {
        this.counters.totalError++
        logEvent(this.instanceId, 'error', 'push_send_error', {
          trace,
          chatId,
          chatType,
          cat: 'network',
          err: err.message,
        })
      })
    return true
  }

  /**
   * File send capability. The runtime supplies a SanctionedFile produced by
   * FileExportGate, guaranteeing a safe resolved path.
   */
  readonly fileCapability: ImFileCapability = {
    sendFile: (chatId, file, chatType) =>
      this.sendFileToChat(chatId, file.resolvedPath, chatType, file.displayName),
  }

  // ── SDK client lifecycle ──────────────────────────────────────

  private openClient(): void {
    const wsUrl = this.config.wsUrl || DEFAULT_WS_URL

    const sdkLogger = this.makeSdkLogger()
    const client = new AiBot.WSClient({
      botId: this.config.botId,
      secret: this.config.secret,
      wsUrl,
      // -1 = infinite — bot is long-lived; we'd rather keep retrying with
      // exponential backoff than give up. Stop() always aborts cleanly.
      maxReconnectAttempts: -1,
      heartbeatInterval: 30_000,
      logger: sdkLogger,
    })

    client.on('connected', () => {
      logEvent(this.instanceId, 'info', 'ws_open', { wsUrl })
    })
    client.on('authenticated', () => {
      this.authenticated = true
      logEvent(this.instanceId, 'info', 'subscribe_ok', {})
      this.flushPendingPushes()
    })
    client.on('disconnected', (reason: string) => {
      const wasAuthenticated = this.authenticated
      this.authenticated = false
      logEvent(this.instanceId, 'warn', 'ws_close', {
        reason,
        wasAuthenticated,
        activeStreams: this.activeStreamSessions.size,
        cat: 'network',
      })
      // Mark all in-flight stream sessions broken so finish() falls back to push.
      this.activeStreamSessions.forEach((s) =>
        s.markStreamBroken(`ws disconnected: ${reason}`),
      )
    })
    client.on('reconnecting', (attempt: number) => {
      logEvent(this.instanceId, 'info', 'reconnect_scheduled', { attempt })
    })
    client.on('error', (err: Error) => {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'ws_error', {
        cat: 'network',
        err: err.message,
      })
    })

    // Inbound routing — one handler per message type, each translates to the
    // normalized InboundMessage contract.
    client.on('message.text', (data) => this.handleInbound(data, 'text'))
    client.on('message.image', (data) => this.handleInbound(data, 'image'))
    client.on('message.mixed', (data) => this.handleInbound(data, 'mixed'))
    client.on('message.voice', (data) => this.handleInbound(data, 'voice'))
    client.on('message.file', (data) => this.handleInbound(data, 'file'))
    client.on('message.video', (data) => this.handleInbound(data, 'video'))

    client.on('event.disconnected_event', () => {
      // Server kicked us off because a newer connection took the bot slot.
      // The SDK already marks isManualClose and won't auto-reconnect; we
      // re-open here so the bot stays online if Halo is still running.
      logEvent(this.instanceId, 'warn', 'disconnected_event', {
        reason: 'new connection took bot slot',
        cat: 'protocol',
      })
      this.activeStreamSessions.forEach((s) =>
        s.markStreamBroken('disconnected_event: superseded'),
      )
      if (this.active) {
        // Schedule via microtask so SDK has a chance to finish its own close.
        Promise.resolve().then(() => {
          if (this.active) this.reconnect()
        })
      }
    })

    this.wsClient = client
    client.connect()
  }

  /**
   * Single-line health snapshot — counters + connection state. Fires on a
   * 5-minute timer plus once on stop().
   */
  private emitHealthSnapshot(trigger: 'periodic' | 'stop'): void {
    logEvent(this.instanceId, 'info', 'health_snapshot', {
      trigger,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      active: this.active,
      authenticated: this.authenticated,
      activeStreams: this.activeStreamSessions.size,
      pendingPushes: this.pendingPushes.length,
      frameCacheSize: this.frameCache.size,
      totalInbound: this.counters.totalInbound,
      totalReply: this.counters.totalReply,
      totalPush: this.counters.totalPush,
      totalStreamPackets: this.counters.totalStreamPackets,
      totalDispatched: this.counters.totalDispatched,
      totalError: this.counters.totalError,
    })
  }

  /**
   * Wrap our `logEvent` as the SDK Logger interface. SDK-internal lines are
   * tagged `event=sdk` so they remain grep-distinguishable from our own.
   */
  private makeSdkLogger(): SdkLogger {
    const wrap = (level: LogLevel) =>
      (msg: string, ...args: unknown[]): void => {
        logEvent(this.instanceId, level, 'sdk', {
          msg,
          args: args.length > 0 ? args.map((a) => formatVal(a)).join(' ') : undefined,
        })
      }
    return {
      debug: wrap('info'), // SDK debug is too chatty — route to info but keep tagged
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
    }
  }

  // ── Inbound translation ──────────────────────────────────────

  private async handleInbound(
    data: WsFrame<BaseMessage>,
    msgType: 'text' | 'image' | 'mixed' | 'voice' | 'file' | 'video',
  ): Promise<void> {
    if (!this.active || !this.inboundHandler) return
    const body = data.body
    if (!body) return

    const senderId = body.from?.userid
    const senderName = (body.from as unknown as { name?: string })?.name ?? senderId
    const chatId = body.chatid ?? senderId
    const chatType: 'direct' | 'group' = body.chattype === 'group' ? 'group' : 'direct'
    const msgId = body.msgid

    if (!senderId || !chatId) {
      logEvent(this.instanceId, 'warn', 'inbound_drop_missing_fields', {
        hasSender: Boolean(senderId),
        hasChat: Boolean(chatId),
        msgId,
      })
      return
    }

    const trace: string = msgId || generateTraceId('inbound')
    this.counters.totalInbound++

    // Cache the frame (headers) so we can reply within the 24h window.
    this.frameCache.set(chatId, {
      frame: { headers: data.headers },
      ts: Date.now(),
    })

    const inboundReceivedAt = Date.now()
    logEvent(this.instanceId, 'info', 'inbound_received', {
      trace,
      chatId,
      chatType,
      from: senderId,
      fromName: senderName !== senderId ? senderName : undefined,
      msgType,
      reqId: data.headers?.req_id,
      hasQuote: Boolean(body.quote),
    })

    // Download / decode any media in the message. Failures are per-item;
    // we still dispatch with whatever succeeded.
    const attachments: InboundAttachment[] = []
    const images: ImageAttachment[] = []
    await this.collectMedia(body, msgType, attachments, images)

    if (body.quote) {
      const quoteType = body.quote.msgtype as
        | 'text' | 'image' | 'mixed' | 'voice' | 'file' | 'video'
      const before = attachments.length + images.length
      await this.collectMedia(body.quote, quoteType, attachments, images)
      const added = attachments.length + images.length - before
      if (added > 0) {
        logEvent(this.instanceId, 'info', 'inbound_quote_media', {
          trace,
          count: added,
          quoteMsgType: quoteType,
        })
      }
    }

    const text = this.extractText(body)
    const mediaPrepMs = Date.now() - inboundReceivedAt

    logEvent(this.instanceId, 'info', 'inbound_parsed', {
      trace,
      chatId,
      textLen: text.length,
      attachments: attachments.length,
      images: images.length,
      mediaPrepMs,
    })

    const inbound: InboundMessage = {
      body: text,
      from: senderId,
      fromName: senderName,
      channel: 'wecom-bot',
      chatType,
      chatId,
      messageId: msgId,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(images.length > 0 ? { images } : {}),
    }

    // ReplyHandle wires both passive reply (stream) and push fallback.
    const reply = this.buildReplyHandle(chatId, chatType, trace, data.headers)

    this.counters.totalDispatched++
    logEvent(this.instanceId, 'info', 'inbound_dispatch_begin', {
      trace,
      chatId,
      hasStream: this.authenticated,
    })

    try {
      this.inboundHandler(inbound, reply)
      logEvent(this.instanceId, 'info', 'inbound_dispatch_handed_off', {
        trace,
        chatId,
        elapsedMs: Date.now() - inboundReceivedAt,
      })
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'inbound_dispatch_threw', {
        trace,
        chatId,
        cat: 'internal',
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /**
   * Build the ReplyHandle exposed to the runtime. Both `send` and the
   * optional `streaming` capability dispatch through SDK-backed transport
   * primitives that own ack/back-pressure.
   */
  private buildReplyHandle(
    chatId: string,
    chatType: 'direct' | 'group',
    trace: string,
    headers: WsFrame['headers'],
  ): ReplyHandle {
    const frame: WsFrameHeaders = { headers }
    // quoteReply only suppresses the quote bubble in GROUP chats. Direct
    // messages always use the passive reply path (aibot_respond_msg, which
    // carries req_id → quote bubble) regardless of the toggle, matching the
    // issue scope ("群回复可关闭引用气泡").
    const useQuoteReply = chatType === 'direct' || this.config.quoteReply !== false
    let streamSession: WecomStreamSession | null = null
    const ensureStream = (): WecomStreamSession | null => {
      if (!this.authenticated) return null
      if (!streamSession) {
        streamSession = this.createTrackedStreamSession(frame, chatId, chatType, trace)
      }
      return streamSession
    }

    // When quoteReply is disabled for a group chat, replyStream* would still
    // carry the inbound req_id and render a quote bubble. Strip the streaming
    // capability so dispatch-inbound falls back to the one-shot send() path,
    // which routes through pushToChat (no req_id, no quote bubble). Direct
    // chats always keep streaming since they never suppress the quote.
    const streaming: StreamingHandle | undefined = useQuoteReply
      ? {
          update: async (event: ProgressEvent) => {
            const s = ensureStream()
            if (s) await s.update(event)
            // No session yet and WS not authenticated: progress events are not
            // critical to deliver. Silent skip is acceptable here — finish()
            // owns the must-deliver guarantee.
          },
          finish: async (finalText: string) => {
            const s = ensureStream()
            if (s) {
              await s.finish(finalText)
              return
            }
            // No session could be acquired (WS unauthenticated at first call to
            // streaming.update AND at finish time, so no session was ever lazily
            // created). The final answer must not be silently dropped — mirror
            // the `send()` fallback path: try the 24h reply window, then push.
            await this.deliverFinalWithoutSession(chatId, chatType, trace, frame, finalText)
          },
          dispose: () => {
            if (streamSession) {
              streamSession.dispose()
              streamSession = null
            }
          },
        }
      : undefined

    return {
      channel: 'wecom-bot',
      chatId,
      replyTtlMs: REPLY_WINDOW_MS,
      send: async (text: string): Promise<void> => {
        // Single-shot reply: prefer aibot_respond_msg when useQuoteReply is on
        // (passive reply carrying req_id → quote bubble). When off (group chat
        // with quoteReply disabled), skip it entirely and go straight to
        // aibot_send_msg (proactive push, no req_id → plain text). Fall back to
        // push in both cases when the preferred path is unavailable.
        const sanitized = ensureUtf8(text)
        const replied = useQuoteReply
          ? await this.replyMarkdown(chatId, sanitized, frame, trace)
          : false
        if (replied) return
        const sourceTag = useQuoteReply ? `reply:${trace}` : `reply-noquote:${trace}`
        logEvent(this.instanceId, 'info', useQuoteReply ? 'reply_fallback_to_push' : 'reply_skip_quote', {
          trace,
          chatId,
          chatType,
          quoteReply: useQuoteReply,
        })
        const pushed = await this.queuePush(
          chatId, sanitized, chatType, sourceTag, trace,
        )
        if (!pushed) {
          this.counters.totalError++
          throw new Error(
            `[WecomBot:${this.instanceId}] Both reply and push failed for chat ${chatId} (trace=${trace})`,
          )
        }
      },
      ...(streaming ? { streaming } : {}),
    }
  }

  private async replyMarkdown(
    chatId: string,
    text: string,
    frame: WsFrameHeaders,
    trace: string,
  ): Promise<boolean> {
    if (!this.wsClient || !this.authenticated) {
      logEvent(this.instanceId, 'warn', 'reply_skip_ws_not_active', {
        trace, chatId, cat: 'network',
      })
      return false
    }
    const entry = this.frameCache.get(chatId)
    if (!entry || Date.now() - entry.ts > REPLY_WINDOW_MS) {
      logEvent(this.instanceId, 'warn', 'reply_skip_window_expired', {
        trace,
        chatId,
        ageMs: entry ? Date.now() - entry.ts : -1,
        windowMs: REPLY_WINDOW_MS,
      })
      return false
    }
    try {
      // The SDK uses the frame's req_id; we trust the cached frame.
      await this.wsClient.reply(
        frame,
        { msgtype: 'markdown', markdown: { content: text } },
      )
      this.counters.totalReply++
      logEvent(this.instanceId, 'info', 'reply_sent', {
        trace,
        chatId,
        bytes: Buffer.byteLength(text, 'utf8'),
      })
      return true
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'reply_send_error', {
        trace,
        chatId,
        cat: 'network',
        err: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  // ── Stream session wiring ─────────────────────────────────────

  private createTrackedStreamSession(
    frame: WsFrameHeaders,
    chatId: string,
    chatType: 'direct' | 'group',
    trace: string,
  ): WecomStreamSession {
    const session = new WecomStreamSession({
      frame,
      streamId: `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      chatType,
      trace,
      transport: this.makeStreamingTransport(),
      logger: this.makeStreamLogger(),
      onDispose: () => this.activeStreamSessions.delete(session),
    })
    this.activeStreamSessions.add(session)
    return session
  }

  /** StreamLogger adapter forwarding to our logEvent. */
  private makeStreamLogger(): StreamLogger {
    return (level: StreamLogLevel, event: string, fields) => {
      logEvent(this.instanceId, level, event, fields)
    }
  }

  /**
   * The StreamingTransport — the only API surface visible to
   * WecomStreamSession. All calls route through the SDK so we never touch
   * a WebSocket directly.
   */
  private makeStreamingTransport(): StreamingTransport {
    return {
      replyStreamNonBlocking: async (
        f: WsFrameHeaders, streamId: string, content: string,
      ): Promise<'sent' | 'skipped' | 'failed'> => {
        if (!this.wsClient || !this.authenticated) return 'failed'
        try {
          const r = await this.wsClient.replyStreamNonBlocking(
            f, streamId, content, false,
          )
          if (r === 'skipped') return 'skipped'
          this.counters.totalStreamPackets++
          return 'sent'
        } catch {
          return 'failed'
        }
      },
      replyStreamFinish: async (
        f: WsFrameHeaders, streamId: string, content: string,
      ): Promise<'sent' | 'failed'> => {
        if (!this.wsClient || !this.authenticated) return 'failed'
        try {
          await this.wsClient.replyStream(f, streamId, content, true)
          this.counters.totalStreamPackets++
          return 'sent'
        } catch (err) {
          logEvent(this.instanceId, 'warn', 'stream_finish_failed', {
            streamId,
            cat: 'protocol',
            err: err instanceof Error ? err.message : String(err),
          })
          return 'failed'
        }
      },
      queuePush: (chatId, text, chatType, sourceTag, trace) =>
        this.queuePush(chatId, text, chatType, sourceTag, trace),
      isAuthenticated: () => this.authenticated,
    }
  }

  /**
   * Fallback path for streaming.finish when no stream session was ever
   * established (the WS was unauthenticated at every update + finish call).
   * Mirrors `send()`'s 24h-reply-then-push fallback so the final answer is
   * never silently dropped.
   */
  private async deliverFinalWithoutSession(
    chatId: string,
    chatType: 'direct' | 'group',
    trace: string,
    frame: WsFrameHeaders,
    finalText: string,
  ): Promise<void> {
    const sanitized = ensureUtf8(finalText)
    logEvent(this.instanceId, 'info', 'streaming_finish_fallback_begin', {
      trace,
      chatId,
      bytes: Buffer.byteLength(sanitized, 'utf8'),
    })
    const replied = await this.replyMarkdown(chatId, sanitized, frame, trace)
    if (replied) {
      logEvent(this.instanceId, 'info', 'streaming_finish_fallback_via_reply', {
        trace,
        chatId,
      })
      return
    }
    const pushed = await this.queuePush(
      chatId,
      sanitized,
      chatType,
      `stream-finish:${trace}`,
      trace,
    )
    if (!pushed) {
      this.counters.totalError++
      throw new Error(
        `[WecomBot:${this.instanceId}] streaming.finish fallback failed for chat ${chatId} (trace=${trace})`,
      )
    }
    logEvent(this.instanceId, 'info', 'streaming_finish_fallback_via_push', {
      trace,
      chatId,
    })
  }

  // ── Push queueing (across brief WS bounces) ─────────────────

  /**
   * Internal push that awaits the SDK's ack and reports honest delivery
   * status. Used by `queuePush` and `flushPendingPushes` so the
   * StreamingTransport.queuePush contract (Promise<boolean> = delivered)
   * holds end-to-end.
   *
   * The public `pushToChat` keeps its fire-and-forget boolean shape to
   * preserve the `ImChannelInstance` contract for external callers.
   */
  private async pushToChatAwaited(
    chatId: string,
    text: string,
    chatType: 'direct' | 'group',
    trace?: string,
  ): Promise<boolean> {
    if (!this.wsClient || !this.authenticated) {
      logEvent(this.instanceId, 'warn', 'push_unavailable', {
        trace,
        chatId,
        chatType,
        authenticated: this.authenticated,
        cat: 'network',
      })
      return false
    }
    const sanitized = ensureUtf8(text)
    const bytes = Buffer.byteLength(sanitized, 'utf8')
    try {
      await this.wsClient.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: sanitized },
      })
      this.counters.totalPush++
      logEvent(this.instanceId, 'info', 'push_sent', {
        trace,
        chatId,
        chatType,
        bytes,
      })
      return true
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'push_send_error', {
        trace,
        chatId,
        chatType,
        cat: 'network',
        err: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  private queuePush(
    chatId: string,
    text: string,
    chatType: 'direct' | 'group',
    sourceTag: string,
    trace?: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.authenticated) {
        // Honest ack: await the SDK's send before resolving so the caller
        // (e.g. WecomStreamSession.finalPushSent) sees real delivery state.
        void this.pushToChatAwaited(chatId, text, chatType, trace).then(resolve)
        return
      }
      const entry: PendingPush = {
        chatId,
        text,
        chatType,
        enqueuedAt: Date.now(),
        sourceTag,
        trace,
        resolve,
      }
      this.pendingPushes.push(entry)
      logEvent(this.instanceId, 'info', 'push_queued', {
        trace,
        chatId,
        chatType,
        source: sourceTag,
        queueLen: this.pendingPushes.length,
        bytes: Buffer.byteLength(text, 'utf8'),
      })
      setTimeout(() => {
        const idx = this.pendingPushes.indexOf(entry)
        if (idx === -1) return
        this.pendingPushes.splice(idx, 1)
        this.counters.totalError++
        logEvent(this.instanceId, 'error', 'push_queue_timeout', {
          trace,
          chatId,
          source: sourceTag,
          waitMs: PUSH_QUEUE_WAIT_MS,
          cat: 'network',
        })
        resolve(false)
      }, PUSH_QUEUE_WAIT_MS)
    })
  }

  private flushPendingPushes(): void {
    if (this.pendingPushes.length === 0) return
    const drained = this.pendingPushes.splice(0)
    logEvent(this.instanceId, 'info', 'push_queue_flush_start', {
      count: drained.length,
    })
    let delivered = 0
    let dropped = 0
    let remaining = drained.length
    const finalize = (): void => {
      logEvent(this.instanceId, 'info', 'push_queue_flush_done', {
        delivered,
        dropped,
        failed: drained.length - delivered - dropped,
      })
    }
    for (const entry of drained) {
      if (Date.now() - entry.enqueuedAt > PUSH_QUEUE_WAIT_MS) {
        dropped++
        logEvent(this.instanceId, 'error', 'push_queue_flush_stale', {
          trace: entry.trace,
          chatId: entry.chatId,
          source: entry.sourceTag,
          ageMs: Date.now() - entry.enqueuedAt,
          cat: 'internal',
        })
        entry.resolve(false)
        if (--remaining === 0) finalize()
        continue
      }
      void this.pushToChatAwaited(
        entry.chatId, entry.text, entry.chatType, entry.trace,
      ).then((ok) => {
        if (ok) delivered++
        entry.resolve(ok)
        if (--remaining === 0) finalize()
      })
    }
  }

  // ── File send (uploadMedia + replyMedia / sendMediaMessage) ───

  private async sendFileToChat(
    chatId: string,
    filePath: string,
    chatType: 'direct' | 'group',
    filename?: string,
  ): Promise<boolean> {
    if (!this.wsClient || !this.authenticated) {
      logEvent(this.instanceId, 'warn', 'send_file_skip_ws_not_open', {
        chatId, cat: 'network',
      })
      return false
    }
    try {
      const displayName = filename || basename(filePath)
      const ext = extname(filePath).toLowerCase()
      const mediaType: WeComMediaType = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file'
      const fileBuf = await readFile(filePath)

      logEvent(this.instanceId, 'info', 'send_file_start', {
        chatId,
        chatType,
        displayName,
        mediaType,
        bytes: fileBuf.length,
      })

      const t0 = Date.now()
      const uploadResult = await this.wsClient.uploadMedia(fileBuf, {
        type: mediaType,
        filename: displayName,
      })
      logEvent(this.instanceId, 'info', 'upload_complete', {
        chatId,
        mediaId: uploadResult.media_id,
        displayName,
        elapsedMs: Date.now() - t0,
      })

      // Prefer passive reply when we still have a valid frame, otherwise push.
      const entry = this.frameCache.get(chatId)
      const canReply = entry && Date.now() - entry.ts < REPLY_WINDOW_MS
      if (canReply && entry) {
        await this.wsClient.replyMedia(entry.frame, mediaType, uploadResult.media_id)
        logEvent(this.instanceId, 'info', 'send_file_sent', {
          chatId, displayName, mediaType, mediaId: uploadResult.media_id, via: 'reply',
        })
      } else {
        await this.wsClient.sendMediaMessage(chatId, mediaType, uploadResult.media_id)
        logEvent(this.instanceId, 'info', 'send_file_sent', {
          chatId, displayName, mediaType, mediaId: uploadResult.media_id, via: 'push',
        })
      }
      return true
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'send_file_failed', {
        chatId,
        cat: 'protocol',
        err: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  // ── Media collection (download + decrypt + decode) ─────────────

  private async collectMedia(
    fragment: BaseMessage | NonNullable<BaseMessage['quote']>,
    fragmentMsgType: 'text' | 'image' | 'mixed' | 'voice' | 'file' | 'video',
    attachments: InboundAttachment[],
    images: ImageAttachment[],
  ): Promise<void> {
    const frag = fragment as Record<string, unknown>
    if (fragmentMsgType === 'image') {
      const img = frag.image as ImageMessage['image'] | undefined
      if (img?.url && img.aeskey) {
        await this.fetchImage(img.url, img.aeskey, attachments, images)
      }
    } else if (fragmentMsgType === 'file') {
      const file = frag.file as FileMessage['file'] | undefined
      if (file?.url && file.aeskey) {
        await this.fetchFile(file.url, file.aeskey, 'file', `file_${Date.now()}`, attachments)
      }
    } else if (fragmentMsgType === 'video') {
      const video = frag.video as VideoMessage['video'] | undefined
      if (video?.url && video.aeskey) {
        await this.fetchFile(video.url, video.aeskey, 'video', `video_${Date.now()}.mp4`, attachments)
      }
    } else if (fragmentMsgType === 'mixed') {
      const mixed = frag.mixed as MixedMessage['mixed'] | undefined
      const items = mixed?.msg_item ?? []
      for (const item of items) {
        if (item.msgtype === 'image' && item.image?.url && item.image.aeskey) {
          await this.fetchImage(item.image.url, item.image.aeskey, attachments, images)
        }
      }
    }
  }

  /** Download an encrypted image, save locally, and prepare for multimodal AI. */
  private async fetchImage(
    url: string,
    aesKey: string,
    attachments: InboundAttachment[],
    images: ImageAttachment[],
  ): Promise<void> {
    if (!this.wsClient) return
    try {
      await mkdir(TEMP_DIR, { recursive: true })
      const { buffer, filename } = await this.wsClient.downloadFile(url, aesKey)
      const safeBase = filename || `image_${Date.now()}.jpg`
      const localPath = join(
        TEMP_DIR,
        `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeBase}`,
      )
      await writeFile(localPath, buffer)

      const ext = (url.split('?')[0].split('.').pop() ?? '').toLowerCase()
      const mimeMap: Record<string, ImageMediaType> = {
        png: 'image/png',
        gif: 'image/gif',
      }
      const mediaType: ImageMediaType = mimeMap[ext] ?? 'image/jpeg'

      attachments.push({
        type: 'image',
        filename: safeBase,
        localPath,
        mimeType: 'image/jpeg',
      })
      images.push({
        id: `wecom_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'image',
        mediaType,
        data: buffer.toString('base64'),
        name: safeBase,
      })
      logEvent(this.instanceId, 'info', 'media_download_done', {
        mediaType: 'image',
        filename: safeBase,
        bytes: buffer.length,
      })
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'image_download_failed', {
        cat: 'network',
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Download an encrypted file/video, save locally, register as attachment. */
  private async fetchFile(
    url: string,
    aesKey: string,
    type: 'file' | 'video',
    fallbackName: string,
    attachments: InboundAttachment[],
  ): Promise<void> {
    if (!this.wsClient) return
    try {
      await mkdir(TEMP_DIR, { recursive: true })
      const { buffer, filename } = await this.wsClient.downloadFile(url, aesKey)
      const safeBase = filename || fallbackName
      const localPath = join(
        TEMP_DIR,
        `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeBase}`,
      )
      await writeFile(localPath, buffer)
      attachments.push({ type, filename: safeBase, localPath })
      logEvent(this.instanceId, 'info', 'media_download_done', {
        mediaType: type,
        filename: safeBase,
        bytes: buffer.length,
      })
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'media_download_failed', {
        mediaType: type,
        cat: 'network',
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Text extraction (mirrors prior behaviour) ─────────────────

  private extractText(body: BaseMessage): string {
    const mainText = this.extractTextFromFragment(body)
    if (body.quote) {
      const quoteText = this.extractTextFromFragment(
        body.quote as unknown as Record<string, unknown>,
      )
      if (quoteText) {
        return mainText
          ? `${mainText}\n\n[Quoted message: ${quoteText}]`
          : `[Quoted message: ${quoteText}]`
      }
    }
    return mainText
  }

  private extractTextFromFragment(fragment: Record<string, unknown>): string {
    const f = fragment as {
      msgtype?: string
      text?: { content?: string }
      file?: { filename?: string }
      link?: { title?: string; url?: string }
      mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> }
    }
    switch (f.msgtype) {
      case 'text':
        return (f.text as TextMessage['text'] | undefined)?.content ?? ''
      case 'image':
        return '(image)'
      case 'voice':
        return '(voice message)'
      case 'file':
        return `(file: ${f.file?.filename ?? 'unknown'})`
      case 'video':
        return '(video)'
      case 'link':
        return `(link: ${f.link?.title ?? f.link?.url ?? ''})`
      case 'mixed': {
        const items = f.mixed?.msg_item ?? []
        const parts = items
          .filter((it) => it.msgtype === 'text')
          .map((it) => (it.text?.content ?? '').trim())
          .filter(Boolean)
        return parts.length > 0 ? parts.join(' ') : '(mixed media)'
      }
      default:
        return `(${f.msgtype ?? 'unknown message type'})`
    }
  }

  // ── Frame cache cleanup ────────────────────────────────────────

  private cleanupExpiredFrames(): void {
    const now = Date.now()
    let cleaned = 0
    for (const [chatId, entry] of this.frameCache) {
      if (now - entry.ts > REPLY_WINDOW_MS) {
        this.frameCache.delete(chatId)
        cleaned++
      }
    }
    if (cleaned > 0) {
      logEvent(this.instanceId, 'info', 'frame_cache_cleanup', {
        cleaned,
        remaining: this.frameCache.size,
      })
    }
  }
}

