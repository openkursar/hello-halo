/**
 * Inbound Message — Normalized IM message type
 *
 * Platform-agnostic message format produced by channel adapters (WeCom Bot,
 * Feishu Bot, DingTalk Bot, etc.). The core runtime only knows this type —
 * it never sees any platform-specific fields or SDK objects.
 *
 * Design principles:
 * - All fields are platform-neutral; adapters handle the mapping
 * - No credentials, protocol details, or platform SDK objects
 * - recentHistory is optional — some platforms support history pull, some don't
 */

import type { ImageAttachment } from './image-attachment'

// ============================================
// InboundMessage
// ============================================

/** Normalized inbound message from any IM channel adapter. */
export interface InboundMessage {
  /** Message text body */
  body: string
  /** Sender identifier (platform-side user ID) */
  from: string
  /** Sender display name (used as sender label in prompts) */
  fromName?: string
  /** Channel identifier: 'wecom-bot' | 'feishu-bot' | 'dingtalk-bot' | ... */
  channel: string
  /** Conversation type */
  chatType: 'direct' | 'group'
  /** Platform-side conversation ID (group ID or direct-chat ID) */
  chatId: string
  /** Protocol-provided conversation name (group name / channel name), if available */
  chatName?: string
  /** Platform-side message ID (used for dedup) */
  messageId?: string
  /** Message timestamp (epoch ms) */
  timestamp: number
  /** Optional recent history provided by the adapter (if the platform API supports it) */
  recentHistory?: InboundHistoryEntry[]
  /**
   * Downloaded media attachments from IM channels.
   *
   * Channel adapters download and decrypt platform-specific media into local temp
   * files before constructing this message. The runtime sees only local paths.
   * Files / video attachments are surfaced to the AI via a text description in
   * the message body; images are also available as `images` for multimodal input.
   */
  attachments?: InboundAttachment[]
  /**
   * Image data for multimodal AI input.
   *
   * Channel adapters download, decrypt, and base64-encode received images into
   * this array before dispatch. Only populated for image-type attachments
   * (not files or video).
   */
  images?: ImageAttachment[]
}

/** A single entry in the optional recent history array. */
export interface InboundHistoryEntry {
  sender: string
  body: string
  timestamp: number
}

// ============================================
// InboundAttachment
// ============================================

/**
 * A downloaded media attachment from an IM channel.
 *
 * Channel adapters download and decrypt platform-specific media into local
 * temp files. The runtime layer only sees local file paths — no platform
 * protocol details leak through this type.
 */
export interface InboundAttachment {
  /** Media type */
  type: 'file' | 'image' | 'video'
  /** Original filename (from platform metadata) */
  filename: string
  /** Absolute path to decrypted local temp file */
  localPath: string
  /** MIME type if known (e.g. 'image/jpeg', 'application/pdf') */
  mimeType?: string
}

// ============================================
// ReplyHandle
// ============================================

/**
 * Reply capability provided by a channel adapter.
 *
 * The core runtime calls `send(text)` to reply — it never knows whether
 * the underlying transport is WebSocket, HTTP API, or something else.
 * The adapter binds the target conversation (chatId, reqId, etc.) at
 * construction time.
 *
 * Minimal interface: only `send` is required. `sendTyping` is optional
 * for platforms that support typing indicators.
 *
 * Channel TTL notes:
 * - WeCom bot: 24h reply window for aibot_respond_msg; 10-min lifetime on a single
 *   stream message (server-enforced). Adapter auto-transitions to aibot_send_msg push
 *   inside both windows when needed.
 * - Feishu/DingTalk: similar protocol-level TTLs — adapters handle internally
 * - Webhook/Schedule: no TTL — reply path is always available
 *
 * Adapters are responsible for TTL fallback internally; callers use `send()` uniformly.
 */
export interface ReplyHandle {
  /** Send a text reply to the originating conversation. */
  send(text: string): Promise<void>
  /** Optional: send a "typing" indicator. */
  sendTyping?(): Promise<void>
  /** Channel identifier (for logging). */
  channel: string
  /** Target conversation ID (for logging). */
  chatId: string
  /**
   * TTL (ms) of the synchronous reply path for this channel.
   * After this duration, `send()` will automatically fall back to a proactive push.
   * Undefined means no TTL — the synchronous reply path is always valid.
   *
   * Examples:
   *   WeCom bot: 24 * 60 * 60 * 1000 (24h reply window per official docs)
   *   Webhook:   undefined (HTTP response is immediate, no TTL)
   */
  replyTtlMs?: number
  /** Optional streaming capability, present only when the channel supports incremental updates. */
  streaming?: StreamingHandle
}

// ============================================
// ProgressEvent
// ============================================

/**
 * Platform-agnostic progress event produced by the core runtime.
 * Channel adapters convert these to platform-specific formats.
 */
export type ProgressEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; tool: string; summary: string }
  | { type: 'tool_result'; tool: string; summary: string; success: boolean }
  | { type: 'text_delta'; text: string }
  | { type: 'status'; text: string }

// ============================================
// StreamingHandle
// ============================================

/**
 * Optional streaming capability on a ReplyHandle.
 * Present only when the channel supports incremental updates.
 *
 * Channel adapters implement this to translate ProgressEvents
 * into platform-specific streaming formats.
 */
export interface StreamingHandle {
  /**
   * Send a progress event during execution.
   * The adapter accumulates these and pushes to the IM platform.
   * May be called dozens of times per execution (batching is the adapter's job).
   */
  update(event: ProgressEvent): Promise<void>

  /**
   * Finalize the stream with the AI's response.
   * After this call, no more update() calls should be made.
   */
  finish(finalText: string): Promise<void>

  /** Abandon the stream without sending. Releases internal state. Safe to call multiple times. */
  dispose?(): void
}
