/**
 * IM Channel — Multi-instance channel architecture
 *
 * Defines the contracts for the IM channel system:
 *
 *   ImChannelProvider  — Channel type definition ("driver")
 *   ImChannelInstance   — A running connection instance
 *   ImChannelAdapter    — Channel-agnostic push interface (subset of Instance)
 *   ImChannelInstanceConfig — Persisted configuration for one instance
 *   ImSessionRecord     — Known IM session with instanceId binding
 *
 * Architecture:
 *   Provider (type definition) → creates N Instances (running connections)
 *   Each Instance binds to exactly one digital human (appId)
 *   Multiple Instances can bind to the same appId (N:1 supported)
 *   ImChannelManager manages all instances' lifecycle
 *
 * Design principles:
 * - Platform-agnostic — WeCom/Feishu/DingTalk use the same model
 * - No protocol details in shared types — only text + target identifiers
 * - Markdown as the universal message format (adapters convert internally)
 * - Synchronous success/failure return (no retry logic — caller decides)
 * - Plugin-ready — providers can be registered dynamically
 */

import type { InboundMessage, ReplyHandle } from './inbound-message'

// ============================================
// GuestPolicy (IM permission control)
// ============================================

/**
 * Permission policy for non-owner (guest) users in IM channels.
 *
 * White-list model: only explicitly listed tools are allowed.
 * When `allowedTools` is undefined, all tools are allowed (no restriction).
 * When `allowedTools` is an empty array, no tools are allowed.
 *
 * At runtime, this list is split by prefix:
 *   - Built-in tools (no prefix) → SDK `disallowedTools` (inverted whitelist)
 *   - MCP tools (`mcp__*`)       → legacy; replaced by injection-control fields below
 *
 * Used by ImChannelInstanceConfig (persisted) and ImPermissionContext (runtime).
 */
export interface GuestPolicy {
  /**
   * Built-in tool names the guest is allowed to use (white-list).
   * All built-in tools are selectable in the UI (advanced tools like
   * Bash, Write, Edit, NotebookEdit are in a separate group). All off by default.
   *
   * undefined = all tools allowed (no tool restriction)
   * []        = no tools allowed
   */
  allowedTools?: string[]

  // ── Halo MCP injection control (new — replaces mcp__ entries in allowedTools) ──
  // Conservative strategy: not configured = not injected for guests.

  /** Allow guest to use AI browser */
  allowAiBrowser?: boolean
  /** Allow guest to send email on behalf of owner */
  allowEmail?: boolean
  /** Allow guest to send notifications */
  allowNotify?: boolean
  /** Allow guest to manage digital humans */
  allowApps?: boolean
  /** Allow guest to send files via IM */
  allowFileSend?: boolean

  /**
   * User-installed MCP server names (specId) that guests are allowed to use.
   * Only servers in this list are injected into guest sessions.
   */
  allowedUserMcp?: string[]
}

// ============================================
// ImChannelInstanceConfig (Persisted)
// ============================================

/** Supported IM channel provider types */
export type ImChannelType = 'wecom-bot' | 'feishu-bot' | 'dingtalk-bot' | 'weixin-ilink-bot'

/**
 * Persisted configuration for a single IM channel instance.
 * Stored in config.json under imChannels.instances[].
 */
export interface ImChannelInstanceConfig {
  /** Auto-generated UUID for this instance */
  id: string
  /** Provider type — see ImChannelType for the full union */
  type: ImChannelType
  /** Whether this instance is enabled */
  enabled: boolean
  /** Bound digital human (App) ID — required for routing */
  appId: string
  /** Provider-specific configuration (e.g., botId, secret, wsUrl for WeCom) */
  config: Record<string, unknown>
  /**
   * Whether to enable streaming (thinking process + tool calls) for this instance.
   * When enabled, intermediate progress events are pushed; otherwise only the final
   * reply is sent.
   * Default: false (streaming disabled — current streaming pipeline is unstable;
   * users can opt in per-instance via the UI toggle).
   */
  streaming?: boolean
  /**
   * Reply scope — controls which chat types this instance responds to.
   *   'all'    — respond to both group and direct messages
   *   'group'  — only respond in group chats (secure)
   *   'direct' — only respond to direct messages
   *
   * Runtime default (when undefined): 'all' for backward compatibility.
   * New instances created via UI default to 'group' for security.
   */
  replyScope?: 'all' | 'group' | 'direct'

  /**
   * Master switch for permission control on this channel instance.
   *
   * false/undefined = no restrictions, everyone has full access (personal use default).
   * true            = owners/guestPolicy are enforced.
   *
   * When false, the `owners` and `guestPolicy` fields are stored but ignored at runtime,
   * so toggling the switch off doesn't lose user configuration.
   */
  permissionEnabled?: boolean

  /**
   * Owner user IDs for this channel instance (platform-side user IDs).
   * Owners have unrestricted access to all tools and paths.
   * Only effective when `permissionEnabled` is true.
   *
   * undefined or [] = everyone is a deny-all guest. In this state the
   *                   runtime auto-claims: the first direct-message sender
   *                   is bound as the sole owner (see owner-claim.ts).
   * Non-empty array  = only listed IDs are owners; others are guests.
   *
   * IDs are platform-specific: WeCom userid, Feishu open_id, DingTalk staffId, etc.
   */
  owners?: string[]

  /**
   * Permission policy applied to non-owner (guest) users.
   * Only effective when `permissionEnabled` is true and `owners` is a non-empty array.
   * When undefined, guests have no tool or path access (deny-all default).
   */
  guestPolicy?: GuestPolicy
}

// ============================================
// ImChannelProvider (Plugin interface)
// ============================================

/**
 * Field definition for data-driven config form rendering.
 * Used by the settings UI to dynamically build the instance form.
 */
export interface ImChannelConfigFieldDef {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'toggle'
  placeholder?: string
  required?: boolean
  /** For toggle fields: the default value when creating a new instance. */
  default?: boolean
}

/**
 * Channel type provider — defines what an IM channel IS.
 *
 * Each provider (WeCom Bot, Feishu Bot, etc.) registers a provider
 * instance with the ImChannelManager. The provider knows how to
 * create connection instances and what config fields it needs.
 *
 * Future: providers can be loaded from plugins.
 */
export interface ImChannelProvider {
  /** Unique type identifier: 'wecom-bot' */
  readonly type: ImChannelType
  /** Human-readable display name: 'WeCom Intelligent Bot' */
  readonly displayName: string
  /** Short description of the channel */
  readonly description: string
  /** Communication direction */
  readonly direction: 'bidirectional' | 'inbound-only'
  /** Config field definitions for the settings UI */
  readonly configFields: ImChannelConfigFieldDef[]
  /** Default config values for new instances */
  readonly defaultConfig: Record<string, unknown>

  /**
   * Create a running instance from persisted config.
   * The instance is NOT started automatically — call start() separately.
   */
  createInstance(instanceId: string, config: Record<string, unknown>): ImChannelInstance

  /**
   * Validate a config object. Returns null if valid, or an error message.
   */
  validateConfig(config: Record<string, unknown>): string | null
}

// ============================================
// ImChannelInstance (Running connection)
// ============================================

/**
 * A running IM channel connection instance.
 *
 * Each instance owns exactly one connection (e.g., one WebSocket to WeCom).
 * The Manager creates instances from ImChannelInstanceConfig and manages
 * their lifecycle (start/stop/reconnect).
 */
export interface ImChannelInstance {
  /** Unique instance ID (matches ImChannelInstanceConfig.id) */
  readonly instanceId: string
  /** Provider type (e.g., 'wecom-bot') */
  readonly providerType: ImChannelType

  /** Start the connection. */
  start(): void
  /** Stop the connection and clean up resources. Safe to call multiple times. */
  stop(): void
  /** Reconnect with potentially updated config. */
  reconnect(): void
  /** Check if the connection is active and ready. */
  isConnected(): boolean

  /**
   * Push a message proactively to a specific chat.
   * @returns true if sent successfully, false otherwise
   */
  pushToChat(chatId: string, text: string, chatType: 'direct' | 'group'): boolean

  /**
   * Register a handler for inbound messages.
   * The Manager calls this once after creating the instance.
   */
  onInbound(handler: (msg: InboundMessage, reply: ReplyHandle) => void): void

  /**
   * Optional file-sending capability.
   *
   * Not all channels support file uploads — this is opt-in.
   * Channel adapters implement the platform-specific upload logic internally.
   * Absence means the channel is text-only for outbound.
   */
  fileCapability?: ImFileCapability
}

// ============================================
// ImFileCapability
// ============================================

/**
 * Branded file reference produced by `FileExportGate.sanction()`.
 *
 * Re-exported here so channel adapters can reference the type without
 * importing from the runtime layer (shared/ must not depend on main/).
 * The runtime's `FileExportGate` is the sole producer of this type.
 */
export interface SanctionedFile {
  /** Brand — prevents ad-hoc construction outside FileExportGate */
  readonly [sanctionedBrand]: true
  /** Absolute real path (symlinks resolved) to the file */
  readonly resolvedPath: string
  /** Display name for the file (basename of resolved path) */
  readonly displayName: string
}

/** @internal Brand symbol for SanctionedFile — not meant for external use */
declare const sanctionedBrand: unique symbol

/**
 * Channel-agnostic file sending interface.
 *
 * Implemented by channel adapters that support outbound file delivery.
 * The adapter handles all platform-specific upload logic (chunked WebSocket
 * upload for WeCom, HTTP multipart for Feishu, etc.).
 *
 * Security: `sendFile` accepts only a `SanctionedFile` (validated by
 * `FileExportGate`) to prevent path-traversal exfiltration.
 */
export interface ImFileCapability {
  /**
   * Upload a sanctioned file and send it to the specified chat.
   *
   * @param chatId - Target platform-side conversation ID
   * @param file - A SanctionedFile produced by FileExportGate.sanction()
   * @param chatType - Conversation type ('direct' | 'group')
   * @returns true if sent successfully, false on recoverable failure
   */
  sendFile(
    chatId: string,
    file: SanctionedFile,
    chatType: 'direct' | 'group',
  ): Promise<boolean>
}

// ============================================
// ImChannelAdapter (Legacy compat + push interface)
// ============================================

/**
 * Channel adapter interface for proactive message pushing.
 *
 * This is the minimal interface for pushing messages to IM channels.
 * Used by notify_bot (via ImChannelInstance) for AI-driven notifications.
 * ImChannelInstance extends this interface.
 */
export interface ImChannelAdapter {
  /** Channel identifier matching InboundMessage.channel (e.g., 'wecom-bot') */
  readonly channel: string

  /**
   * Push a message proactively to a specific chat.
   *
   * Unlike replyToChat() (which requires a req_id from an inbound message),
   * this method can send messages at any time without a prior user message
   * in the current request cycle.
   *
   * @param chatId - Platform-side conversation ID
   * @param text - Message content (Markdown format)
   * @param chatType - Conversation type
   * @returns true if sent successfully, false otherwise
   */
  pushToChat(chatId: string, text: string, chatType: 'direct' | 'group'): boolean

  /**
   * Check if the underlying connection is available for sending.
   */
  isConnected(): boolean
}

// ============================================
// ImChannelStatus (Runtime status)
// ============================================

/**
 * Runtime status of a single IM channel instance.
 * Returned by IPC/HTTP status APIs.
 */
export interface ImChannelInstanceStatus {
  /** Instance ID */
  id: string
  /** Provider type */
  type: ImChannelType
  /** Whether enabled in config */
  enabled: boolean
  /** Whether the connection is currently active */
  connected: boolean
  /** Bound digital human App ID */
  appId: string
  /** Bound digital human App name (resolved at query time) */
  appName?: string
}

// ============================================
// ImSessionRecord
// ============================================

/**
 * Persistent record of a known IM session.
 *
 * Created automatically when a user first messages the bot in a chat.
 * The `proactive` flag is toggled per contact in the digital human
 * detail page (AppNotifyChannelsSection).
 */
export interface ImSessionRecord {
  /** Associated digital human (App) ID */
  appId: string
  /** Channel type identifier: 'wecom-bot' | 'feishu-bot' | 'dingtalk-bot' | ... */
  channel: string
  /** IM channel instance ID that owns this session (for adapter lookup on push) */
  instanceId: string
  /** Platform-side conversation ID */
  chatId: string
  /** Conversation type */
  chatType: 'direct' | 'group'
  /** Human-readable name for UI display (set once on first registration, never overwritten) */
  displayName: string
  /** User-assigned custom name — highest display priority */
  customName?: string
  /** Most recent message sender name */
  lastSender?: string
  /** Most recent message preview (truncated to 50 chars) */
  lastMessage?: string
  /**
   * When true, the run's final assistant text response is auto-pushed to
   * this contact at run completion (apps/runtime/im-auto-sync.ts). The AI
   * is informed of this state via the auto-sync awareness fragment so it
   * does not duplicate via notify_bot.
   */
  proactive: boolean
  /** Last activity timestamp (epoch ms) */
  lastActiveAt: number
}
