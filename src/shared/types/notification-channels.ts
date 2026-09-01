/**
 * Notification Channels — Shared type definitions
 *
 * Used by both main process and renderer process.
 * Must NOT import any Node.js or Electron APIs.
 *
 * Defines the configuration schema for external notification channels
 * (email, WeCom, DingTalk, Feishu, webhook).
 */

import type { LocalizedText } from './ai-sources'

// ============================================
// Channel Type Enum
// ============================================

/** All supported notification channel types */
export type NotificationChannelType = 'email' | 'wecom' | 'dingtalk' | 'feishu' | 'webhook'

/** Display metadata for each channel */
export const NOTIFICATION_CHANNEL_META: Record<NotificationChannelType, {
  labelKey: string
  descriptionKey: string
}> = {
  email: {
    labelKey: 'Email',
    descriptionKey: 'Send notifications via SMTP email',
  },
  wecom: {
    labelKey: 'WeCom',
    descriptionKey: 'Send notifications via WeChat Work (企业微信)',
  },
  dingtalk: {
    labelKey: 'DingTalk',
    descriptionKey: 'Send notifications via DingTalk (钉钉)',
  },
  feishu: {
    labelKey: 'Feishu',
    descriptionKey: 'Send notifications via Feishu/Lark (飞书)',
  },
  webhook: {
    labelKey: 'Webhook',
    descriptionKey: 'Send notifications via HTTP webhook',
  },
}

// ============================================
// Per-Channel Config Types
// ============================================

/** Email (SMTP) channel configuration */
export interface EmailChannelConfig {
  enabled: boolean
  smtp: {
    host: string         // e.g. "smtp.example.com"
    port: number         // e.g. 465 (SSL), 587 (STARTTLS)
    secure: boolean      // true for SSL (port 465), false for STARTTLS
    user: string         // sender email address
    password: string     // app password / authorization code
  }
  defaultTo: string      // default recipient email
  /** CalDAV calendar URL template. Supports {host} and {email} placeholders.
   *  Example: "https://{host}/dav/users/{email}/calendars/default/"
   *  When omitted, calendar tools are disabled. */
  caldavUrl?: string
  /** TLS cipher suite override for IMAP/SMTP connections.
   *  When omitted, Node.js default ciphers are used. */
  tlsCiphers?: string
}

/** WeCom (企业微信) self-built app configuration */
export interface WecomChannelConfig {
  enabled: boolean
  corpId: string         // enterprise ID (企业ID)
  agentId: number        // app ID (应用AgentId)
  secret: string         // app secret (应用Secret)
  defaultToUser?: string // default recipient userid (optional)
  defaultToParty?: string // default recipient department id (optional)
}

/** DingTalk (钉钉) enterprise internal app configuration */
export interface DingtalkChannelConfig {
  enabled: boolean
  appKey: string         // app key from DingTalk open platform
  appSecret: string      // app secret
  agentId: number        // app agentId from DingTalk open platform (应用AgentId)
  robotCode?: string     // robot code for single-chat messages
  defaultChatId?: string // default group chat ID (optional)
}

/** Feishu/Lark (飞书) self-built app configuration */
export interface FeishuChannelConfig {
  enabled: boolean
  appId: string          // app ID from Feishu Open Platform
  appSecret: string      // app secret
  defaultChatId?: string // default group chat ID (optional)
  defaultUserId?: string // default recipient user open_id (optional)
}

/** Generic HTTP webhook channel configuration */
export interface WebhookChannelConfig {
  enabled: boolean
  url: string            // target URL
  method?: 'POST' | 'PUT' // default: POST
  headers?: Record<string, string> // custom headers
  secret?: string        // HMAC signing secret (optional)
}

// ============================================
// WeCom Intelligent Bot (企业微信智能机器人)
// ============================================
// Independent from WecomChannelConfig (self-built app for push notifications).
// This config is for the bidirectional WebSocket-based intelligent bot protocol
// that allows digital humans to receive and reply to messages via WeCom.

/** WeCom Intelligent Bot (企业微信智能机器人) configuration */
export interface WecomBotConfig {
  enabled: boolean
  /** Bot ID from WeCom admin console (aib-xxx format) */
  botId: string
  /** Bot secret from WeCom admin console */
  secret: string
  /** WebSocket URL (default: wss://openws.work.weixin.qq.com) */
  wsUrl?: string
}

// ============================================
// IM Channels Config (Multi-instance)
// ============================================

/**
 * IM channel configuration — supports multiple instances per channel type.
 *
 * Each instance is a separate connection (e.g., a separate WeCom bot)
 * bound to a specific digital human (App). Multiple instances can bind
 * to the same App (N:1 supported).
 */
export interface ImChannelsConfig {
  /** All configured IM channel instances */
  instances?: import('./im-channel').ImChannelInstanceConfig[]
  /**
   * @deprecated Legacy field — migrated to instances[].appId on load.
   * Kept for backward compatibility during migration.
   */
  defaultAppId?: string
}

// ============================================
// Aggregate Config
// ============================================

/** All notification channels configuration — stored in HaloConfig */
export interface NotificationChannelsConfig {
  email?: EmailChannelConfig
  wecom?: WecomChannelConfig
  dingtalk?: DingtalkChannelConfig
  feishu?: FeishuChannelConfig
  webhook?: WebhookChannelConfig
}

// ============================================
// Output Notify Config (for App Spec)
// ============================================

/**
 * Extended output notification config.
 * Replaces the old `output.notify: boolean` in App Spec.
 */
export interface OutputNotifyConfig {
  /** Send system desktop notification (default: true) */
  system?: boolean
  /**
   * @deprecated External channels are now AI-driven via the notify_channel tool.
   * This field is retained for backward compatibility but ignored at runtime.
   */
  channels?: NotificationChannelType[]
}

// ============================================
// Notification Payload (internal)
// ============================================

/** Standard payload passed to channel adapters */
export interface NotificationPayload {
  title: string
  body: string
  appId?: string
  appName?: string
  /** Timestamp (epoch ms) when the event occurred */
  timestamp: number
}

// ============================================
// Send Result
// ============================================

export interface NotifySendResult {
  channel: NotificationChannelType
  success: boolean
  error?: string
}

// ============================================
// Product-level Channel Customization
// ============================================

/**
 * Help-doc link rendered inside a channel's settings card (e.g. how to obtain
 * an SMTP authorization code). Declared per deployment in product.json;
 * builds that omit it render no link.
 */
export interface ChannelDocsLink {
  url: string
  /** Localized link label. A generic string is used when omitted. */
  label?: LocalizedText
}

/** Per-channel customization entry */
export interface NotifyChannelProductConfig {
  /** Help link rendered under the channel's credential field */
  docs?: ChannelDocsLink
}

/**
 * Notification-channel customizations a deployment declares in product.json.
 *
 * Presentation-only: credentials and endpoints belong to `serviceDefaults`
 * (seeded into the user's config) or to the user, never here.
 */
export type NotifyChannelsProductConfig = Partial<Record<NotificationChannelType, NotifyChannelProductConfig>>

// ============================================
// Channel Test Result (for Settings UI)
// ============================================

export interface ChannelTestResult {
  channel: NotificationChannelType
  success: boolean
  error?: string
  latencyMs?: number
}
