/**
 * apps/runtime/im-channels -- Feishu Bot Provider (SDK-backed)
 *
 * ImChannelProvider implementation for Feishu / Lark app bots (飞书机器人).
 *
 * This is a thin adapter on top of `@larksuiteoapi/node-sdk`'s channel helper.
 * The SDK owns:
 *   - WebSocket long-connection lifecycle (endpoint discovery, handshake,
 *     ping/pong, auto-reconnect with the server-advertised backoff)
 *   - tenant_access_token acquisition and refresh
 *   - event decryption/verification (built into the long connection)
 *   - inbound dedup, stale-message drop, per-chat serialization, and merging of
 *     messages a user sends in quick succession
 *   - outbound message send/upload, and streaming cards (CardKit), including
 *     rolling over to a follow-up card when Feishu's per-element size limit is
 *     approached
 *
 * This file owns:
 *   - InboundMessage construction (translating the SDK's normalized message
 *     into the contract dispatch-inbound consumes)
 *   - media download into a temp dir, as attachments + multimodal images
 *   - the ReplyHandle: quote-reply semantics, streaming wiring, plain fallback
 *   - chat display-name resolution (cached)
 *   - Provider/Instance lifecycle that plugs into ImChannelManager
 *
 * Protocol characteristics that shape the design (and differ from WeCom):
 *   - Replies are ordinary API calls, valid at any time. There is no reply
 *     window and no per-request id to keep alive, so this provider needs no
 *     frame cache and no pending-push queue: a send works whenever the
 *     credentials are valid, even while the long connection is down.
 *   - Group messages are only delivered when the bot is mentioned, unless the
 *     tenant granted the sensitive "all group messages" scope. `requireMention`
 *     keeps mention-only behavior in that case too.
 *   - The long connection is single-delivery per app: with the same credentials
 *     connected from two machines, Feishu hands each event to exactly one of
 *     them. There is no supersede signal to arbitrate on (unlike WeCom), so one
 *     machine must own the credential — see `credentialId` and the duplicate
 *     check in binding.ts.
 *
 * Logging conventions: every event is emitted via the same key=value
 * `event=<name> field=value ...` shape used by the other providers. SDK-internal
 * logs are routed through the SDK's `logger` option and tagged `event=sdk` so
 * they remain grep-distinguishable from our own events.
 */

import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type HttpInstance,
  type LarkChannel,
  type Logger as SdkLogger,
  type NormalizedMessage,
  type ResourceDescriptor,
} from '@larksuiteoapi/node-sdk'
import axios from 'axios'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import {
  imCredentialId,
  type ImChannelConfigFieldDef,
  type ImChannelInstance,
  type ImChannelProvider,
  type ImChannelType,
  type ImConnectionState,
  type ImFileCapability,
  type ImIdentityCapability,
} from '../../../../shared/types/im-channel'
import type {
  InboundAttachment,
  InboundMessage,
  ProgressEvent,
  ReplyHandle,
  StreamingHandle,
} from '../../../../shared/types/inbound-message'
import type { ImageAttachment, ImageMediaType } from '../../../../shared/types/image-attachment'
import { pruneMediaTempDir, stageMediaFile } from './media-temp-files'
import {
  FeishuStreamSession,
  type FeishuStreamTransport,
  type StreamLogLevel,
  type StreamLogger,
} from './feishu-stream-session'
import { notifyAppEvent } from '../../../services/notification.service'
import { resolveProxyAgent } from '../../../services/proxy-fetch'

// ============================================
// Constants
// ============================================

/** Interval for periodic health-snapshot log lines. */
const HEALTH_SNAPSHOT_INTERVAL_MS = 5 * 60_000
/** First delay before rebuilding a channel that could not connect. */
const CONNECT_RETRY_BASE_MS = 5_000
/** Ceiling for the connect-retry backoff. */
const CONNECT_RETRY_MAX_MS = 5 * 60_000
/** How long a resolved chat display name stays cached. */
const CHAT_NAME_TTL_MS = 30 * 60_000
/** Cap on resolving a chat name inline, so inbound dispatch is never blocked. */
const CHAT_NAME_TIMEOUT_MS = 2_000
/** Local temp directory for downloaded Feishu media. */
const TEMP_DIR = join(tmpdir(), 'halo-feishu')
/** Temp media older than this is removed at startup. */
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Feishu App IDs are `cli_` + 16 hex chars; the SDK refuses anything else. */
const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/
/** Extensions sent as Feishu images rather than generic files. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'])
/** Extension → multimodal media type for inbound images. */
const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

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
  const parts: string[] = [`[FeishuBot:${instanceId}]`, `event=${event}`]
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Render one SDK log argument; objects would otherwise print as [object Object]. */
function describeLogArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return formatVal(value)
}

/**
 * Pull Feishu's own error code and message out of a rejected API call.
 *
 * The HTTP status alone is not a diagnosis — the platform answers a missing
 * permission, an unknown resource and a malformed parameter all with 400, and
 * only the body distinguishes them.
 *
 * Downloads ask for a streamed response, so a failure arrives with its body
 * still unread: an object that looks like data but yields nothing until it is
 * drained. That is why a rejected download used to report nothing but a status
 * code.
 */
async function describePlatformError(err: unknown): Promise<{ code?: number; msg?: string } | undefined> {
  const body = (err as { response?: { data?: unknown } })?.response?.data
  if (!body) return undefined

  if (typeof body === 'string') return parsePlatformBody(body)
  if (isReadable(body)) {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      return parsePlatformBody(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return undefined
    }
  }
  if (typeof body === 'object') {
    const { code, msg } = body as { code?: number; msg?: string }
    if (code === undefined && msg === undefined) return undefined
    return { code, msg }
  }
  return undefined
}

function parsePlatformBody(raw: string): { code?: number; msg?: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as { code?: number; msg?: string }
    if (parsed.code === undefined && parsed.msg === undefined) return undefined
    return { code: parsed.code, msg: parsed.msg }
  } catch {
    return raw ? { msg: raw.slice(0, 200) } : undefined
  }
}

function isReadable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === 'function'
}

/**
 * What the user has to do about a failed media download.
 *
 * Only the permission case is worth naming: the fix is a checkbox in the Feishu
 * console and nothing here can substitute for it. Feishu's own message already
 * lists the acceptable permissions and a link that grants them, so the hint
 * points at that rather than restating a list that could drift.
 */
function mediaFailureHint(code: number | undefined): string | undefined {
  // 99991671/2 are the platform's "app lacks the required permission" codes.
  if (code === 99991672 || code === 99991671) {
    return 'The app is missing a message-read permission; grant one of the permissions named above in the Feishu console, then publish a new version'
  }
  return undefined
}

// ============================================
// Public temp-file cleanup
// ============================================

/**
 * Remove stale Feishu media temp files older than 24 hours.
 *
 * Called once at startup by the im-channels layer. Files are only needed for the
 * duration of a single agent execution, so anything older is safe to remove.
 */
export function cleanupFeishuTempFiles(): void {
  const cleaned = pruneMediaTempDir(TEMP_DIR, TEMP_FILE_MAX_AGE_MS)
  if (cleaned > 0) {
    logEvent('_startup', 'info', 'temp_files_cleaned', { cleaned, dir: TEMP_DIR })
  }
}

// ============================================
// Provider
// ============================================

interface FeishuBotProviderConfig {
  /** App ID (`cli_…`) of the Feishu app whose bot this is. */
  appId: string
  /** App Secret. Encrypted at rest by config-encryption (key matches /secret/i). */
  appSecret: string
  /**
   * Which Feishu deployment the credentials belong to: `feishu` (China, the
   * default) or `lark` (international). Wrong domain means every call is
   * rejected, so the scan-auth flow records what the tenant reported rather
   * than asking the user.
   */
  domain?: 'feishu' | 'lark'
  /**
   * Whether a group message must mention the bot to be answered. Default true.
   *
   * Feishu only delivers un-mentioned group messages at all if the tenant
   * granted the sensitive "获取群组中所有消息" scope; where it has been granted,
   * turning this off lets the bot answer every group message.
   */
  requireMention?: boolean
  /**
   * Whether GROUP replies quote the triggering message. Default true.
   *
   * Direct messages never quote: there is no ambiguity about what is being
   * answered in a one-to-one chat.
   */
  quoteReply?: boolean
}

export class FeishuBotProvider implements ImChannelProvider {
  readonly type: ImChannelType = 'feishu-bot'
  readonly displayName = 'Feishu Bot'
  readonly description = 'Bidirectional messaging via Feishu/Lark long connection'
  readonly direction = 'bidirectional' as const

  readonly configFields: ImChannelConfigFieldDef[] = [
    { key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_xxxxxxxxxxxxxxxx', required: true },
    { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
    { key: 'domain', label: 'Domain', type: 'text', placeholder: 'feishu | lark' },
    { key: 'requireMention', label: 'Require @mention in groups', type: 'toggle', default: true },
    { key: 'quoteReply', label: 'Quote Reply', type: 'toggle', default: true },
  ]

  readonly defaultConfig: Record<string, unknown> = {
    appId: '',
    appSecret: '',
    domain: 'feishu',
    requireMention: true,
    quoteReply: true,
  }

  /**
   * Both keys change behavior without changing identity: `requireMention` is
   * pushed into the live policy gate, `quoteReply` is read when the next reply
   * is built. Reconnecting for either would drop the long connection (and with
   * it any in-flight streaming card) for a preference toggle.
   */
  readonly hotUpdatableConfigKeys = ['requireMention', 'quoteReply']

  /**
   * Two enabled instances sharing an App ID is worse here than on other
   * platforms: Feishu delivers each event to exactly one connection, so the
   * traffic would be split at random between two digital humans rather than
   * merely duplicated.
   */
  credentialId(config: Record<string, unknown>): string | undefined {
    return imCredentialId(this.type, config)
  }

  createInstance(instanceId: string, config: Record<string, unknown>): ImChannelInstance {
    return new FeishuBotInstance(instanceId, config as unknown as FeishuBotProviderConfig)
  }

  validateConfig(config: Record<string, unknown>): string | null {
    const appId = typeof config.appId === 'string' ? config.appId.trim() : ''
    if (!appId) return 'App ID is required'
    // Checked here rather than left to the SDK: an App ID of the wrong shape
    // makes the SDK refuse to open the connection with a log line only, which
    // would surface in the UI as a bot that silently never connects.
    if (!APP_ID_PATTERN.test(appId)) return 'App ID must look like cli_ followed by 16 hex characters'
    if (!config.appSecret || typeof config.appSecret !== 'string') return 'App Secret is required'
    const domain = config.domain
    if (domain !== undefined && domain !== 'feishu' && domain !== 'lark') {
      return 'Domain must be either "feishu" or "lark"'
    }
    return null
  }
}

// ============================================
// Reachability (consumed by the Feishu settings card)
// ============================================

/** A plain snapshot of whether this bot can be reached, and since when. */
export interface FeishuReachability {
  state: ImConnectionState
  /** Milliseconds since the long connection was established, null if never. */
  connectedSinceMs: number | null
  /** Milliseconds since the last inbound message, null if none ever arrived. */
  lastInboundAgoMs: number | null
  inboundCount: number
  lastError?: string
}

/**
 * Read the reachability of a running instance, if it is a Feishu one.
 *
 * The manager hands out instances through the shared interface, so this is how
 * the brand's own status surface gets at brand-specific state without anyone
 * outside this file knowing the instance class.
 */
export function readFeishuReachability(instance: unknown): FeishuReachability | null {
  return instance instanceof FeishuBotInstance ? instance.getReachability() : null
}

// ============================================
// Instance
// ============================================

/** Cached chat display name with its resolution timestamp. */
interface ChatNameEntry {
  name?: string
  ts: number
}

class FeishuBotInstance implements ImChannelInstance {
  readonly instanceId: string
  readonly providerType: ImChannelType = 'feishu-bot'

  private config: FeishuBotProviderConfig
  private channel: LarkChannel | null = null
  private active = false
  private inboundHandler:
    | ((msg: InboundMessage, reply: ReplyHandle) => void)
    | null = null

  /** Unsubscribers for the channel event handlers of the current channel. */
  private unsubscribers: (() => void)[] = []
  /** Stream sessions in flight — marked broken on disconnect, disposed on stop. */
  private activeStreamSessions = new Set<FeishuStreamSession>()
  /** Chat display names, so a group's name is resolved at most once per TTL. */
  private chatNames = new Map<string, ChatNameEntry>()
  /** Sender names by open id, for the direct chats Feishu leaves unnamed. */
  private senderNames = new Map<string, ChatNameEntry>()
  /**
   * Set when the tenant has not granted the contacts scopes. Retrying then
   * costs a failed request per message and can never succeed until the app is
   * re-published, so the first refusal turns the lookup off for this session.
   */
  private contactLookupDisabled = false
  /** Whether the "cannot connect" notification has fired for this episode. */
  private connectFailureNotified = false
  /** Last terminal connection error, surfaced in health snapshots. */
  private lastError: string | undefined
  private healthSnapshotTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Pending channel rebuild. The SDK reconnects a *live* connection on its own,
   * but it only owns that loop once the handshake has succeeded: a connect that
   * fails before it (no network yet at login, a token call that times out) or a
   * link that exhausts the SDK's own retries leaves a channel object that will
   * never try again. This timer is that missing outer loop.
   */
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Consecutive failed rebuilds, for the backoff. Reset on a good connect. */
  private connectAttempts = 0
  /**
   * Bumped on every open attempt. Opening is async (the proxy lookup), so a
   * stop() or reconnect() can land mid-flight; the generation tells a late
   * arrival that it no longer owns the instance.
   */
  private channelGeneration = 0
  /** Counters surfaced in the periodic health snapshot. */
  private counters = {
    totalInbound: 0,
    totalRejected: 0,
    totalDispatched: 0,
    totalReply: 0,
    totalPush: 0,
    totalStreams: 0,
    totalMedia: 0,
    totalError: 0,
  }
  /** Timestamp the instance was started, for uptime in snapshots. */
  private startedAt = 0
  /** When the last inbound message arrived; 0 means "never heard anything". */
  private lastInboundAt = 0
  /** When the long connection last completed a handshake. */
  private connectedAt = 0

  constructor(instanceId: string, config: FeishuBotProviderConfig) {
    this.instanceId = instanceId
    this.config = config
  }

  // ── ImChannelInstance interface ────────────────────────────────

  onInbound(handler: (msg: InboundMessage, reply: ReplyHandle) => void): void {
    this.inboundHandler = handler
  }

  /**
   * Apply a hot-updatable config change (see
   * FeishuBotProvider.hotUpdatableConfigKeys) without touching the connection.
   * ImChannelManager only calls this when every other field is unchanged.
   */
  updateConfig(config: Record<string, unknown>): void {
    const next = config as unknown as FeishuBotProviderConfig
    const mentionChanged = (next.requireMention !== false) !== (this.config.requireMention !== false)
    this.config = next
    if (mentionChanged && this.channel) {
      this.channel.updatePolicy({ requireMention: next.requireMention !== false })
    }
    logEvent(this.instanceId, 'info', 'config_hot_updated', {
      requireMention: next.requireMention !== false,
      quoteReply: next.quoteReply !== false,
    })
  }

  /**
   * Synchronous by contract, and must not throw: the manager records an
   * instance only after start() returns, so a throw would leave nothing to
   * reconnect. Unusable config returns early with a log line; the connection
   * itself is opened fire-and-forget.
   */
  start(): void {
    this.active = true
    this.startedAt = Date.now()
    this.connectFailureNotified = false
    this.lastError = undefined

    if (!this.config.appId || !this.config.appSecret) {
      logEvent(this.instanceId, 'warn', 'start_skip', { reason: 'missing appId or appSecret' })
      return
    }

    this.openChannel()
    this.healthSnapshotTimer = setInterval(
      () => this.emitHealthSnapshot('periodic'),
      HEALTH_SNAPSHOT_INTERVAL_MS,
    )
    logEvent(this.instanceId, 'info', 'instance_start', {
      appIdPrefix: this.config.appId.slice(0, 12),
      domain: this.config.domain ?? 'feishu',
      requireMention: this.config.requireMention !== false,
    })
  }

  /** Idempotent and non-throwing, per the manager's contract. */
  stop(): void {
    this.active = false
    this.clearRetryTimer()
    this.emitHealthSnapshot('stop')
    if (this.healthSnapshotTimer) {
      clearInterval(this.healthSnapshotTimer)
      this.healthSnapshotTimer = null
    }
    this.activeStreamSessions.forEach((s) => s.dispose())
    this.activeStreamSessions.clear()
    this.teardownChannel()
    this.inboundHandler = null
    this.chatNames.clear()
    this.senderNames.clear()
    logEvent(this.instanceId, 'info', 'instance_stop', {})
  }

  /**
   * Rebuild the connection with the current config. Also the user-facing
   * "Reconnect" action: the SDK reconnects on its own, so an explicit request
   * means the user wants the current attempt abandoned and a clean one started.
   */
  reconnect(): void {
    if (!this.active) return
    this.connectFailureNotified = false
    this.lastError = undefined
    // An explicit user action beats a pending backoff: reset the schedule so
    // "Reconnect" reconnects now rather than whenever the timer was due.
    this.clearRetryTimer()
    this.connectAttempts = 0
    this.activeStreamSessions.forEach((s) => s.markStreamBroken('manual reconnect'))
    this.teardownChannel()
    if (this.config.appId && this.config.appSecret) {
      this.openChannel()
    }
  }

  isConnected(): boolean {
    return this.channel?.getConnectionStatus()?.state === 'connected'
  }

  /**
   * Fine-grained state for the settings UI. Feishu has no equivalent of WeCom's
   * slot contention, so there is no 'standby': the SDK is either connected,
   * working on it, or has given up (which reads as offline plus a logged error,
   * since the shared state vocabulary has no 'failed').
   */
  getConnectionState(): ImConnectionState {
    if (!this.active) return 'offline'
    const state = this.channel?.getConnectionStatus()?.state
    if (state === 'connected') return 'online'
    if (state === 'failed') return 'offline'
    if (state === 'connecting' || state === 'reconnecting' || state === 'idle') return 'connecting'
    return this.channel ? 'connecting' : 'offline'
  }

  /**
   * Proactive push. Feishu sends are plain API calls, so this works while the
   * long connection is down — only missing credentials make it impossible. The
   * ImChannelInstance contract is a synchronous boolean, so the ack is awaited
   * out of band: the return value reports that the send was accepted for
   * delivery, and a later failure is logged rather than retro-actively reported.
   */
  pushToChat(
    chatId: string,
    text: string,
    chatType: 'direct' | 'group',
    trace?: string,
  ): boolean {
    const channel = this.channel
    if (!channel) {
      logEvent(this.instanceId, 'warn', 'push_unavailable', {
        trace,
        chatId,
        chatType,
        reason: 'channel not initialized',
        cat: 'internal',
      })
      return false
    }

    const bytes = Buffer.byteLength(text, 'utf8')
    void channel
      .send(chatId, { markdown: text })
      .then(() => {
        this.counters.totalPush++
        logEvent(this.instanceId, 'info', 'push_sent', { trace, chatId, chatType, bytes })
      })
      .catch((err: unknown) => {
        this.counters.totalError++
        logEvent(this.instanceId, 'error', 'push_send_error', {
          trace,
          chatId,
          chatType,
          cat: 'network',
          err: describeError(err),
        })
      })
    return true
  }

  /**
   * File send capability. Presence is unconditional and stable for the
   * instance's lifetime: a conditional capability would change the tool set of
   * an existing agent session and destroy the turn that is starting (see
   * file-send-resolve.ts).
   */
  readonly fileCapability: ImFileCapability = {
    sendFile: (chatId, file) => this.sendFileToChat(chatId, file.resolvedPath, file.displayName),
  }

  /**
   * Publishes the names this instance has learned, so conversations that were
   * first seen without one stop showing a raw chat id.
   *
   * A conversation's label is fixed the first time it is registered and never
   * rewritten — which is right, because a label the user may have customized
   * must not be clobbered by every later message. The one channel that does
   * update after the fact is this one, so a name learned on the second message
   * (or after a fix like this one) still reaches the screen.
   *
   * No separate credential is involved, unlike the WeCom case this contract was
   * built for: the map is simply what has already been resolved for the chats
   * this bot has talked in.
   */
  readonly identityCapability: ImIdentityCapability = {
    fetchIdentityDirectory: async () => {
      const directory = new Map<string, string>()
      for (const [chatId, entry] of this.chatNames) {
        if (entry.name) directory.set(chatId, entry.name)
      }
      return directory
    },
  }

  // ── Channel lifecycle ─────────────────────────────────────────

  /**
   * Open the connection.
   *
   * Kicked off without awaiting because `start()` is synchronous by contract;
   * the proxy lookup it awaits is a local Chromium call, and the generation
   * guard covers a stop() that lands while it is in flight.
   */
  private openChannel(): void {
    void this.openChannelWithProxy().catch((err: unknown) => {
      logEvent(this.instanceId, 'error', 'channel_open_threw', {
        cat: 'internal',
        err: describeError(err),
      })
    })
  }

  private async openChannelWithProxy(): Promise<void> {
    const generation = ++this.channelGeneration

    // Resolve the route the same way every other outbound call in Halo does.
    // The SDK owns two transports and neither reads Halo's proxy settings on
    // its own: `agent` covers the WebSocket dial, and the axios instance
    // behind every API call needs the agent pushed onto it. Without both, a
    // machine that reaches Feishu through a proxy connects to nothing and the
    // bot looks broken rather than blocked.
    const domain = this.config.domain === 'lark' ? Domain.Lark : Domain.Feishu
    const apiOrigin = domain === Domain.Lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
    let agent: Awaited<ReturnType<typeof resolveProxyAgent>>
    try {
      agent = await resolveProxyAgent(apiOrigin)
    } catch (err) {
      agent = undefined
      logEvent(this.instanceId, 'warn', 'proxy_resolve_failed', {
        cat: 'network',
        err: describeError(err),
      })
    }
    if (!this.active || generation !== this.channelGeneration) {
      logEvent(this.instanceId, 'info', 'channel_open_abandoned', {
        reason: this.active ? 'superseded' : 'stopped',
      })
      return
    }
    if (agent) {
      logEvent(this.instanceId, 'info', 'proxy_applied', { apiOrigin })
    }

    const channel = createLarkChannel({
      agent,
      // A private transport per channel, never the SDK's module-level
      // defaultHttpInstance: mutating that singleton leaks one instance's
      // proxy route into every other Feishu/Lark instance, and outlives
      // turning the proxy off (API calls then die against a closed proxy
      // while the freshly-dialed WebSocket connects direct — "online but
      // never answers").
      httpInstance: createChannelHttpInstance(agent),
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      transport: 'websocket',
      source: 'halo',
      loggerLevel: LoggerLevel.info,
      logger: this.makeSdkLogger(),
      policy: {
        requireMention: this.config.requireMention !== false,
        // Authorization is Halo's own concern: owner claim, guest policy and
        // replyScope all live in dispatch-inbound, and the first direct message
        // is what binds an owner. A second gate here would silently drop the
        // very message the owner-claim flow depends on.
        dmMode: 'open',
        respondToMentionAll: false,
      },
      outbound: {
        // Long AI answers arrive as many small deltas; patch on either a short
        // interval or a decent chunk of text, whichever comes first.
        streamThrottleMs: 500,
        streamThrottleChars: 60,
      },
    })

    this.channel = channel

    // Events from a superseded channel object must not mutate our state:
    // teardownChannel() unsubscribes, so handlers registered here belong to
    // exactly one channel generation.
    this.unsubscribers.push(
      channel.on('message', (msg: NormalizedMessage) => this.handleInbound(msg)),
    )
    this.unsubscribers.push(
      channel.on('reject', (evt) => {
        this.counters.totalRejected++
        logEvent(this.instanceId, 'info', 'inbound_rejected', {
          chatId: evt.chatId,
          reason: evt.reason,
        })
      }),
    )
    this.unsubscribers.push(
      channel.on('error', (err) => {
        this.counters.totalError++
        this.lastError = err.message
        logEvent(this.instanceId, 'error', 'channel_error', {
          code: err.code,
          cat: err.code === 'not_connected' ? 'network' : 'protocol',
          err: err.message,
        })
        // The SDK gives up after exhausting its own reconnect budget and parks
        // the client in 'failed'. Nothing inside it will try again, so the
        // rebuild has to come from here or the bot stays silent for good.
        if (this.channel === channel && channel.getConnectionStatus()?.state === 'failed') {
          this.scheduleChannelRetry('link failed')
        }
      }),
    )
    this.unsubscribers.push(
      channel.on('reconnecting', () => {
        // An in-flight streaming card cannot be patched while the link is down.
        // Marking it broken makes finish() deliver through a plain message
        // instead of leaving the user with a half-written card.
        this.activeStreamSessions.forEach((s) => s.markStreamBroken('long connection reconnecting'))
        logEvent(this.instanceId, 'warn', 'ws_reconnecting', {
          attempts: channel.getConnectionStatus()?.reconnectAttempts ?? 0,
          cat: 'network',
        })
      }),
    )
    this.unsubscribers.push(
      channel.on('reconnected', () => {
        this.connectFailureNotified = false
        this.lastError = undefined
        logEvent(this.instanceId, 'info', 'ws_reconnected', {})
      }),
    )
    this.unsubscribers.push(
      channel.on('botAdded', (evt) => {
        logEvent(this.instanceId, 'info', 'bot_added_to_chat', {
          chatId: evt.chatId,
          external: evt.external ?? false,
        })
      }),
    )

    // connect() resolves after the first successful handshake. Failure is not
    // fatal to the instance: the SDK keeps retrying, and the UI shows the state.
    channel
      .connect()
      .then(() => {
        if (this.channel !== channel) return
        this.connectAttempts = 0
        this.connectedAt = Date.now()
        logEvent(this.instanceId, 'info', 'ws_open', {
          domain: this.config.domain ?? 'feishu',
        })
      })
      .catch((err: unknown) => {
        if (this.channel !== channel) return
        this.counters.totalError++
        this.lastError = describeError(err)
        logEvent(this.instanceId, 'error', 'ws_open_failed', {
          cat: 'network',
          err: this.lastError,
        })
        this.notifyConnectFailureOnce(this.lastError)
        // connect() can fail before the SDK ever builds its WebSocket client
        // (token call, bot-identity lookup), in which case there is no internal
        // reconnect loop to inherit — so schedule our own.
        this.scheduleChannelRetry('connect failed')
      })
  }

  /**
   * Rebuild the channel after a backoff. Jittered so several instances (or
   * several machines resuming from sleep at once) do not retry in lockstep.
   */
  private scheduleChannelRetry(reason: string): void {
    if (!this.active || this.retryTimer) return
    const base = Math.min(
      CONNECT_RETRY_BASE_MS * 2 ** this.connectAttempts,
      CONNECT_RETRY_MAX_MS,
    )
    const delayMs = Math.round(base * (0.5 + Math.random()))
    this.connectAttempts++
    logEvent(this.instanceId, 'warn', 'connect_retry_scheduled', {
      reason,
      delayMs,
      attempt: this.connectAttempts,
      cat: 'network',
    })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.active) return
      logEvent(this.instanceId, 'info', 'connect_retry_start', { attempt: this.connectAttempts })
      this.teardownChannel()
      this.openChannel()
    }, delayMs)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private teardownChannel(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub()
      } catch {
        // Unsubscribing is bookkeeping; a failure must not block teardown.
      }
    }
    this.unsubscribers = []
    const channel = this.channel
    this.channel = null
    if (!channel) return
    void channel.disconnect().catch((err: unknown) => {
      logEvent(this.instanceId, 'warn', 'ws_disconnect_error', { err: describeError(err) })
    })
  }

  /**
   * Tell the user once per episode that the bot cannot connect. Without this a
   * revoked secret or deleted app looks like a bot that simply stopped
   * answering, with the explanation only in the log.
   */
  private notifyConnectFailureOnce(reason: string): void {
    if (this.connectFailureNotified) return
    this.connectFailureNotified = true
    try {
      notifyAppEvent(
        'Feishu bot cannot connect',
        `Check the App ID / App Secret and that the app is published. Details: ${reason}`,
      )
    } catch (err) {
      logEvent(this.instanceId, 'warn', 'connect_failure_notify_failed', {
        err: describeError(err),
      })
    }
  }

  /**
   * Route SDK-internal logs through our own sink, tagged `event=sdk` so they
   * stay grep-distinguishable from this provider's events.
   */
  private makeSdkLogger(): SdkLogger {
    const wrap = (level: LogLevel) =>
      (...args: unknown[]): void => {
        logEvent(this.instanceId, level, 'sdk', {
          msg: args.map(describeLogArg).join(' '),
        })
      }
    return {
      // SDK debug/trace are too chatty for production — routed to info but kept
      // tagged, matching how the WeCom adapter handles the same problem.
      trace: wrap('info'),
      debug: wrap('info'),
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
    }
  }

  // ── Inbound translation ──────────────────────────────────────

  private async handleInbound(msg: NormalizedMessage): Promise<void> {
    if (!this.active || !this.inboundHandler) {
      // A message that lands while the instance is stopping, or before the
      // manager wired the handler, is genuinely lost: Feishu already counts it
      // as delivered to this connection, and nothing will re-push it.
      logEvent(this.instanceId, 'warn', 'inbound_drop_inactive', {
        messageId: msg.messageId,
        chatId: msg.chatId,
        active: this.active,
        hasHandler: this.inboundHandler !== null,
        cat: 'internal',
      })
      return
    }

    const chatId = msg.chatId
    const senderId = msg.senderId
    if (!chatId || !senderId) {
      logEvent(this.instanceId, 'warn', 'inbound_drop_missing_fields', {
        hasChat: Boolean(chatId),
        hasSender: Boolean(senderId),
        messageId: msg.messageId,
      })
      return
    }

    const chatType: 'direct' | 'group' = msg.chatType === 'p2p' ? 'direct' : 'group'
    const trace = msg.messageId || generateTraceId('inbound')
    const receivedAt = Date.now()
    this.counters.totalInbound++
    this.lastInboundAt = receivedAt

    logEvent(this.instanceId, 'info', 'inbound_received', {
      trace,
      chatId,
      chatType,
      from: senderId,
      fromName: msg.senderName,
      msgType: msg.rawContentType,
      resources: msg.resources.length,
      mentionedBot: msg.mentionedBot,
    })

    const attachments: InboundAttachment[] = []
    const images: ImageAttachment[] = []
    const mediaFailures: string[] = []
    if (msg.resources.length > 0 && msg.messageId) {
      await this.collectMedia(msg.messageId, msg.resources, trace, attachments, images, mediaFailures)
    } else if (msg.resources.length > 0) {
      // Every resource is addressed by the message that carried it; without a
      // message id there is nothing to fetch, and the text would arrive
      // pretending no attachment existed.
      logEvent(this.instanceId, 'warn', 'media_skip_no_message_id', {
        trace,
        chatId,
        resources: msg.resources.length,
        cat: 'protocol',
      })
    }

    const chatName = await this.resolveChatName(chatId, chatType, senderId, msg.senderName)

    const inbound: InboundMessage = {
      body: msg.content ?? '',
      from: senderId,
      channel: 'feishu-bot',
      chatType,
      chatId,
      timestamp: msg.createTime || Date.now(),
      ...(msg.senderName ? { fromName: msg.senderName } : {}),
      ...(chatName ? { chatName } : {}),
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(images.length > 0 ? { images } : {}),
    }

    if (mediaFailures.length > 0) {
      inbound.body = `${inbound.body}\n\n[Attachments could not be downloaded — ${mediaFailures.join('; ')}]`
    }

    const reply = this.buildReplyHandle(chatId, chatType, trace, msg.messageId)

    this.counters.totalDispatched++
    logEvent(this.instanceId, 'info', 'inbound_parsed', {
      trace,
      chatId,
      textLen: inbound.body.length,
      attachments: attachments.length,
      images: images.length,
      prepMs: Date.now() - receivedAt,
    })

    try {
      this.inboundHandler(inbound, reply)
      logEvent(this.instanceId, 'info', 'inbound_dispatch_handed_off', {
        trace,
        chatId,
        elapsedMs: Date.now() - receivedAt,
      })
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'inbound_dispatch_threw', {
        trace,
        chatId,
        cat: 'internal',
        err: describeError(err),
      })
    }
  }

  /**
   * Resolve a human-readable conversation name.
   *
   * Both chat types are looked up. A group has its own name; a one-to-one chat
   * is named after the person on the other side, and that is the only way to
   * get it here — the SDK accepts a sender-name resolver but never supplies
   * one, so the sender's name arrives empty and the conversation list would
   * otherwise show a raw id.
   *
   * The lookup is bounded by a timeout so a slow tenant API cannot delay a
   * reply, and cached so a busy chat costs one call per TTL. A miss is cached
   * too — retrying a chat the bot cannot read would add that latency to every
   * message in it.
   */
  private async resolveChatName(
    chatId: string,
    chatType: 'direct' | 'group',
    senderId: string,
    senderName: string | undefined,
  ): Promise<string | undefined> {
    const fallback = chatType === 'direct' ? senderName : undefined
    const cached = this.chatNames.get(chatId)
    if (cached && Date.now() - cached.ts < CHAT_NAME_TTL_MS) return cached.name ?? fallback

    const channel = this.channel
    if (!channel) return cached?.name ?? fallback

    try {
      const info = await withTimeout(channel.getChatInfo(chatId), CHAT_NAME_TIMEOUT_MS)
      let name = info?.name?.trim() || undefined
      // Feishu names groups but not one-to-one chats, so a direct conversation
      // has to borrow the name of the person on the other side.
      if (!name && chatType === 'direct') {
        name = await this.resolvePersonName(channel, senderId)
      }
      this.chatNames.set(chatId, { name, ts: Date.now() })
      logEvent(this.instanceId, 'info', 'chat_name_resolved', {
        chatId,
        chatType,
        hasName: Boolean(name),
      })
      return name ?? fallback
    } catch (err) {
      this.chatNames.set(chatId, { name: cached?.name, ts: Date.now() })
      logEvent(this.instanceId, 'warn', 'chat_name_resolve_failed', {
        chatId,
        cat: 'network',
        err: describeError(err),
      })
      return cached?.name ?? fallback
    }
  }

  /**
   * Look up who an open id belongs to.
   *
   * Optional by design: without the contacts scopes the call is refused, and a
   * conversation simply keeps showing what it showed before. Refusal disables
   * further attempts rather than repeating a request that cannot start working
   * until the app is re-published.
   */
  private async resolvePersonName(
    channel: LarkChannel,
    openId: string,
  ): Promise<string | undefined> {
    if (this.contactLookupDisabled || !openId) return undefined
    const cached = this.senderNames.get(openId)
    if (cached && Date.now() - cached.ts < CHAT_NAME_TTL_MS) return cached.name

    try {
      const res = await withTimeout(
        channel.rawClient.contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        }),
        CHAT_NAME_TIMEOUT_MS,
      )
      const name = res?.data?.user?.name?.trim() || undefined
      this.senderNames.set(openId, { name, ts: Date.now() })
      return name
    } catch (err) {
      const platform = await describePlatformError(err)
      if (platform?.code === 99991672 || platform?.code === 99991671) {
        this.contactLookupDisabled = true
        logEvent(this.instanceId, 'warn', 'contact_lookup_unavailable', {
          feishuCode: platform.code,
          hint: 'Grant the contacts permissions named above so direct chats show a person instead of an id',
          cat: 'protocol',
        })
      } else {
        logEvent(this.instanceId, 'warn', 'contact_lookup_failed', {
          cat: 'network',
          err: describeError(err),
        })
      }
      this.senderNames.set(openId, { name: undefined, ts: Date.now() })
      return undefined
    }
  }

  // ── Reply handling ───────────────────────────────────────────

  /**
   * Build the ReplyHandle exposed to the runtime.
   *
   * `streaming` is always offered: unlike WeCom there is no configuration in
   * which streaming is impossible, and dispatch-inbound discards the capability
   * unless the instance opted in.
   */
  private buildReplyHandle(
    chatId: string,
    chatType: 'direct' | 'group',
    trace: string,
    messageId: string | undefined,
  ): ReplyHandle {
    // Quoting only makes sense in a group, where several conversations
    // interleave. The toggle exists because the quote card adds visual noise to
    // groups that only talk to the bot.
    const replyTo = chatType === 'group' && this.config.quoteReply !== false
      ? messageId
      : undefined

    let session: FeishuStreamSession | null = null
    const ensureSession = (): FeishuStreamSession => {
      if (!session) {
        session = this.createTrackedStreamSession(chatId, trace, replyTo)
      }
      return session
    }

    const streaming: StreamingHandle = {
      update: async (event: ProgressEvent) => {
        await ensureSession().update(event)
      },
      finish: async (finalText: string) => {
        if (session) {
          await session.finish(finalText)
          return
        }
        // No progress ever arrived (a turn that answered immediately): there is
        // no card to close, so deliver the answer as an ordinary message.
        await this.deliverText(chatId, finalText, trace, replyTo)
      },
      dispose: () => {
        if (session) {
          session.dispose()
          session = null
        }
      },
    }

    return {
      channel: 'feishu-bot',
      chatId,
      send: async (text: string): Promise<void> => {
        await this.deliverText(chatId, text, trace, replyTo)
      },
      streaming,
    }
  }

  /**
   * Send one message, honoring the quote preference.
   *
   * A quoted reply can fail on its own (the quoted message was recalled, or a
   * thread it belonged to is gone) while a plain send to the same chat still
   * works, so a failed quote is retried without the quote before the error is
   * propagated. Throwing matters: dispatch-inbound reports a failed reply, and
   * swallowing it here would look like an answer the user never received.
   */
  private async deliverText(
    chatId: string,
    text: string,
    trace: string,
    replyTo: string | undefined,
  ): Promise<void> {
    const channel = this.channel
    if (!channel) {
      this.counters.totalError++
      throw new Error(`[FeishuBot:${this.instanceId}] channel not initialized (trace=${trace})`)
    }
    const bytes = Buffer.byteLength(text, 'utf8')

    if (replyTo) {
      try {
        await channel.send(chatId, { markdown: text }, { replyTo })
        this.counters.totalReply++
        logEvent(this.instanceId, 'info', 'reply_sent', { trace, chatId, bytes, quoted: true })
        return
      } catch (err) {
        logEvent(this.instanceId, 'warn', 'reply_quote_failed', {
          trace,
          chatId,
          cat: 'protocol',
          err: describeError(err),
        })
      }
    }

    try {
      await channel.send(chatId, { markdown: text })
      this.counters.totalReply++
      logEvent(this.instanceId, 'info', 'reply_sent', { trace, chatId, bytes, quoted: false })
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'reply_send_error', {
        trace,
        chatId,
        cat: 'network',
        err: describeError(err),
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  // ── Stream session wiring ────────────────────────────────────

  private createTrackedStreamSession(
    chatId: string,
    trace: string,
    replyTo: string | undefined,
  ): FeishuStreamSession {
    this.counters.totalStreams++
    const session = new FeishuStreamSession({
      chatId,
      trace,
      transport: this.makeStreamTransport(chatId, trace, replyTo),
      logger: this.makeStreamLogger(),
      onDispose: () => this.activeStreamSessions.delete(session),
    })
    this.activeStreamSessions.add(session)
    return session
  }

  private makeStreamLogger(): StreamLogger {
    return (level: StreamLogLevel, event: string, fields) => {
      logEvent(this.instanceId, level, event, fields)
    }
  }

  /**
   * The stream transport — the only outbound surface the stream session sees.
   * Both calls route through the SDK, so the session never touches a socket,
   * a card payload, or a credential.
   */
  private makeStreamTransport(
    chatId: string,
    trace: string,
    replyTo: string | undefined,
  ): FeishuStreamTransport {
    return {
      openStream: async (producer) => {
        const channel = this.channel
        if (!channel) throw new Error('channel not initialized')
        await channel.stream(
          chatId,
          { markdown: (controller) => producer(controller) },
          replyTo ? { replyTo } : undefined,
        )
      },
      sendPlain: async (text: string) => {
        try {
          await this.deliverText(chatId, text, trace, replyTo)
          return true
        } catch {
          // deliverText already logged and counted; the session turns a false
          // into its own hard failure.
          return false
        }
      },
    }
  }

  // ── Media ────────────────────────────────────────────────────

  /**
   * Download every resource attached to the inbound message.
   *
   * Failures are per-item: a message with one unreadable attachment is still
   * dispatched with the rest, because the text usually carries the request.
   */
  private async collectMedia(
    messageId: string,
    resources: ResourceDescriptor[],
    trace: string,
    attachments: InboundAttachment[],
    images: ImageAttachment[],
    failures: string[],
  ): Promise<void> {
    const channel = this.channel
    if (!channel) return

    for (const resource of resources) {
      const isImage = resource.type === 'image'
      const fallbackName = defaultResourceName(resource)
      try {
        const buffer = await this.downloadMessageResource(
          channel,
          messageId,
          resource.fileKey,
          isImage ? 'image' : 'file',
        )
        const staged = await stageMediaFile(
          TEMP_DIR,
          resource.fileName || fallbackName,
          buffer,
          TEMP_FILE_MAX_AGE_MS,
        )
        this.counters.totalMedia++
        const mediaType = isImage ? imageMediaType(buffer, staged.filename) : undefined

        attachments.push({
          type: isImage ? 'image' : resource.type === 'video' ? 'video' : 'file',
          filename: staged.filename,
          localPath: staged.localPath,
          ...(mediaType ? { mimeType: mediaType } : {}),
        })

        if (isImage && mediaType) {
          // Also pass the bytes inline so the model can actually see the image,
          // not just know a file exists.
          images.push({
            id: `feishu-${resource.fileKey.slice(0, 16)}-${images.length}`,
            type: 'image',
            mediaType,
            data: buffer.toString('base64'),
            name: staged.filename,
            size: buffer.byteLength,
          })
        }

        logEvent(this.instanceId, 'info', 'media_download_done', {
          trace,
          mediaType: resource.type,
          filename: staged.filename,
          bytes: buffer.byteLength,
        })
      } catch (err) {
        this.counters.totalError++
        const platform = await describePlatformError(err)
        logEvent(this.instanceId, 'warn', 'media_download_failed', {
          trace,
          mediaType: resource.type,
          fileKeyPrefix: resource.fileKey.slice(0, 12),
          cat: 'network',
          err: describeError(err),
          // "status 400" says nothing; the code and message Feishu returned are
          // the only part that identifies which of a dozen causes this was.
          feishuCode: platform?.code,
          feishuMsg: platform?.msg,
          hint: mediaFailureHint(platform?.code),
        })
        // Without this the model is handed a message that mentions an image and
        // no image, and answers "I can't see it" — which reads as a fault in
        // the model rather than a permission the user can grant in one click.
        failures.push(
          platform?.code === 99991672 || platform?.code === 99991671
            ? `${resource.type}: the Feishu app lacks permission to read files in messages`
            : `${resource.type}: download failed (${platform?.msg ?? describeError(err)})`,
        )
      }
    }
  }

  /**
   * Download one resource carried by an inbound message.
   *
   * Deliberately not the SDK's convenience helper: that one fetches by key
   * alone, which is the API for re-reading something the app itself uploaded.
   * A key that arrived inside someone else's message is only addressable
   * together with that message, and asking the upload API for it returns a bare
   * HTTP 400 — the message then reaches the model claiming an attachment that
   * was never written to disk.
   */
  private async downloadMessageResource(
    channel: LarkChannel,
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<Buffer> {
    const response = await channel.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    })
    const stream = response.getReadableStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
    }
    return Buffer.concat(chunks)
  }

  /**
   * Upload and send a local file. Images go out as Feishu images so they render
   * inline; everything else as a file attachment. The path arrives already
   * sanctioned by FileExportGate.
   */
  private async sendFileToChat(
    chatId: string,
    filePath: string,
    displayName: string,
  ): Promise<boolean> {
    const channel = this.channel
    if (!channel) {
      logEvent(this.instanceId, 'warn', 'send_file_skip', {
        chatId,
        reason: 'channel not initialized',
        cat: 'internal',
      })
      return false
    }
    const isImage = IMAGE_EXTENSIONS.has(extname(displayName || filePath).toLowerCase())
    const startedAt = Date.now()
    logEvent(this.instanceId, 'info', 'send_file_start', {
      chatId,
      filename: displayName,
      asImage: isImage,
    })
    try {
      await channel.send(
        chatId,
        isImage
          ? { image: { source: filePath } }
          : { file: { source: filePath, fileName: displayName } },
      )
      logEvent(this.instanceId, 'info', 'send_file_sent', {
        chatId,
        filename: displayName,
        elapsedMs: Date.now() - startedAt,
      })
      return true
    } catch (err) {
      this.counters.totalError++
      logEvent(this.instanceId, 'error', 'send_file_failed', {
        chatId,
        filename: displayName,
        cat: 'network',
        err: describeError(err),
      })
      return false
    }
  }

  // ── Reachability report ──────────────────────────────────────

  /**
   * What this bot can actually be said to be doing right now.
   *
   * The link being up is not the same as the bot working. A Feishu app whose
   * release is still awaiting an administrator connects perfectly well and
   * never receives a thing — so does one whose availability scope does not
   * include the person trying to talk to it. Reporting only "connected" in
   * those cases sends the user looking for a fault in Halo.
   *
   * This deliberately reports observation, not diagnosis: "connected, nothing
   * received yet" is something we know, whereas "pending approval" would be a
   * guess unless the app grants the self-management permission, which the
   * default install does not ask for.
   */
  getReachability(): FeishuReachability {
    const state = this.getConnectionState()
    return {
      state,
      connectedSinceMs: this.connectedAt ? Date.now() - this.connectedAt : null,
      lastInboundAgoMs: this.lastInboundAt ? Date.now() - this.lastInboundAt : null,
      inboundCount: this.counters.totalInbound,
      lastError: this.lastError,
    }
  }

  // ── Housekeeping ─────────────────────────────────────────────

  /**
   * Periodic state line. A long-lived connection has to report its own state
   * with numbers, not only emit events: "this machine stopped receiving" is
   * otherwise invisible, and with Feishu's single-delivery long connection it
   * is the failure mode most worth being able to see.
   */
  private emitHealthSnapshot(trigger: 'periodic' | 'stop'): void {
    const status = this.channel?.getConnectionStatus()
    logEvent(this.instanceId, 'info', 'health_snapshot', {
      trigger,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      active: this.active,
      state: status?.state ?? 'none',
      reconnectAttempts: status?.reconnectAttempts ?? 0,
      activeStreams: this.activeStreamSessions.size,
      chatNameCache: this.chatNames.size,
      lastInboundAgoMs: this.lastInboundAt ? Date.now() - this.lastInboundAt : null,
      connectAttempts: this.connectAttempts,
      retryPending: this.retryTimer !== null,
      lastError: this.lastError,
      ...this.counters,
    })
  }
}

// ============================================
// Helpers
// ============================================

/**
 * Per-channel HTTP transport handed to the SDK, replacing its module-level
 * `defaultHttpInstance` so proxy routing stays scoped to one instance.
 *
 * Must honor the same response contract as the SDK's own instance
 * (lib response interceptor): every consumer inside the SDK reads the
 * unwrapped body, and requests flagged `$return_headers` get `{data, headers}`.
 * `proxy: false` keeps axios from applying its own env-var proxy handling,
 * which can disagree with what Halo resolved; with no agent this is a plain
 * direct-connection transport.
 */
function createChannelHttpInstance(
  agent: Awaited<ReturnType<typeof resolveProxyAgent>>,
): HttpInstance {
  const instance = axios.create(
    agent ? { httpsAgent: agent, httpAgent: agent, proxy: false } : { proxy: false },
  )
  instance.interceptors.response.use((resp) => {
    if ((resp.config as { $return_headers?: boolean }).$return_headers) {
      return { data: resp.data, headers: resp.headers } as typeof resp
    }
    return resp.data
  })
  return instance as HttpInstance
}

/**
 * Media type for an inbound image, sniffed from the bytes with the filename as
 * a fallback.
 *
 * The bytes win because the name is not evidence: Feishu often omits it, and
 * this provider then invents one. A model handed a PNG labelled `image/jpeg`
 * rejects the whole message, so a wrong label costs more than no image at all —
 * hence undefined (attachment only, no inline copy) when neither source
 * identifies a format the model accepts.
 */
function imageMediaType(buffer: Buffer, filename: string): ImageMediaType | undefined {
  if (buffer.length >= 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return 'image/png'
    }
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
    if (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp'
    }
  }
  return IMAGE_MEDIA_TYPES[extname(filename).toLowerCase()]
}

/** Filename for a resource Feishu delivered without one. */
function defaultResourceName(resource: ResourceDescriptor): string {
  const stamp = Date.now()
  switch (resource.type) {
    case 'image':
      return `image_${stamp}.jpg`
    case 'sticker':
      return `sticker_${stamp}.png`
    case 'audio':
      return `audio_${stamp}.opus`
    case 'video':
      return `video_${stamp}.mp4`
    default:
      return `file_${stamp}`
  }
}

/**
 * Bound a promise that must not delay the caller. The underlying request is
 * left to settle on its own — Feishu's client has no cancellation here, and an
 * abandoned read costs nothing but the socket it already owns.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
