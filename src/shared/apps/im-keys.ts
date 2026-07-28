/**
 * IM session key builders — shared between main process and renderer.
 *
 * The conversation-ID format is the single source of truth for session
 * isolation across all layers: runtime, event routing, store lookups, and
 * renderer subscriptions.  Both sides MUST use these functions instead of
 * constructing the key string inline, so that any future format change is
 * automatically reflected everywhere.
 */

import { classifySessionSource, HTTP_SESSION_CHANNEL, LOCAL_SESSION_CHANNEL } from '../types/im-channel'

/**
 * Build the virtual conversationId for the native Halo app-chat session.
 * Used for V2 session keying, active session tracking, and renderer event routing.
 *
 * Format: "app-chat:{appId}"
 */
export function getAppChatConversationId(appId: string): string {
  return `app-chat:${appId}`
}

/**
 * Build a fully-qualified session key for IM channel conversations.
 *
 * Format: "app-chat:{appId}:{channel}:{chatType}:{chatId}"
 *
 * This ensures complete session isolation across channels, chat types, and
 * individual chats.  The prefix "app-chat:" keeps the key in the same
 * namespace as native app-chat so the renderer's chat store can handle both
 * uniformly.
 */
export function buildImSessionKey(
  appId: string,
  channel: string,
  chatType: 'direct' | 'group',
  chatId: string
): string {
  return `app-chat:${appId}:${channel}:${chatType}:${chatId}`
}

/**
 * Build the conversationId for a native client-side multi-session.
 *
 * Format: "app-chat:{appId}:local:direct:{sessionUuid}"
 *
 * These are the desktop user's own extra chat windows for a digital human,
 * alongside the legacy default session ("app-chat:{appId}"). The 5-segment
 * shape reuses the existing IM-session plumbing (parseAppChatKey, deriveRunId,
 * the session registry, and the app-chat send path) with a dedicated 'local'
 * channel so these sessions are never mistaken for IM or evicted like HTTP.
 */
export function buildLocalSessionKey(appId: string, sessionUuid: string): string {
  return `app-chat:${appId}:${LOCAL_SESSION_CHANNEL}:direct:${sessionUuid}`
}

/**
 * Check whether a conversationId belongs to a native client-side local session.
 */
export function isLocalSessionKey(conversationId: string): boolean {
  const parsed = parseAppChatKey(conversationId)
  return parsed !== null && parsed.channel === LOCAL_SESSION_CHANNEL
}

/** Parsed components of a channel-qualified app-chat conversation key. */
export interface ParsedAppChatKey {
  appId: string
  channel: string
  chatType: 'direct' | 'group'
  chatId: string
}

/**
 * Parse a channel-qualified app-chat key into its components.
 *
 * Accepts only the 5-segment channel form
 * "app-chat:{appId}:{channel}:{chatType}:{chatId}". Returns null for the native
 * 2-segment form ("app-chat:{appId}"), non-app-chat keys, and malformed input.
 * chatId must not contain ":".
 */
export function parseAppChatKey(conversationId: string): ParsedAppChatKey | null {
  if (!conversationId.startsWith('app-chat:')) return null
  const parts = conversationId.split(':')
  if (parts.length !== 5) return null
  const [, appId, channel, chatType, chatId] = parts
  if (!appId || !channel || !chatId) return null
  if (chatType !== 'direct' && chatType !== 'group') return null
  return { appId, channel, chatType, chatId }
}

/**
 * Check whether a conversationId belongs to a (pushable) IM channel session.
 *
 * A key is an IM session only when it parses as a channel-qualified app-chat key
 * AND its channel is a known IM channel. HTTP sessions share the same 5-segment
 * shape but must not enter IM-only paths (config invalidation, proactive push,
 * notify_bot directory), so they are excluded here.
 */
export function isImSessionKey(conversationId: string): boolean {
  const parsed = parseAppChatKey(conversationId)
  return parsed !== null && classifySessionSource(parsed.channel) === 'im'
}

/**
 * Check whether a conversationId belongs to the app-chat namespace — native
 * digital-human chat ("app-chat:{appId}") or any IM session under it. Keeps the
 * "app-chat:" prefix knowledge here rather than inlined at call sites.
 */
export function isAppChatKey(conversationId: string): boolean {
  return conversationId.startsWith('app-chat:')
}

/**
 * Allowed chatId charset for externally-supplied HTTP conversation keys.
 *
 * The chatId becomes part of the on-disk JSONL filename (via the runtime's
 * deriveRunId), so an unconstrained, caller-controlled value is a
 * path-traversal vector. Restricting to a filename-safe charset (no dots,
 * slashes, or separators) makes traversal impossible while comfortably
 * covering typical business user keys.
 */
const HTTP_CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Result of validating an externally-supplied HTTP conversationId. */
export type HttpConversationIdResult =
  | { ok: true; conversationId: string }
  | { ok: false; error: string }

/**
 * Validate and normalize a conversationId supplied by an external HTTP caller
 * on an app-chat /send request.
 *
 * Accepts:
 *   - empty / non-string      → the app's native default conversation
 *   - the native default key  → as-is (shared native chat)
 *   - a well-formed HTTP key  → "app-chat:{appId}:http:{direct|group}:{chatId}"
 *   - a native local key      → "app-chat:{appId}:local:direct:{sessionUuid}"
 *
 * Rejects everything else — in particular IM-channel keys (an HTTP caller must
 * never be able to address or inject into an IM session) and chatIds outside
 * the filename-safe charset. The 'local' channel is permitted so the remote
 * web client (an authenticated Halo UI that reaches the same endpoint over
 * HTTP) can drive the user's native multi-sessions; it is non-pushable and
 * carries no more capability than an 'http' session. This is the trust boundary
 * for caller-controlled conversation ids.
 */
export function resolveHttpConversationId(
  appId: string,
  conversationId: unknown
): HttpConversationIdResult {
  const raw = typeof conversationId === 'string' ? conversationId.trim() : ''
  const nativeDefault = getAppChatConversationId(appId)

  if (!raw || raw === nativeDefault) {
    return { ok: true, conversationId: nativeDefault }
  }

  const parsed = parseAppChatKey(raw)
  if (!parsed || parsed.appId !== appId) {
    return {
      ok: false,
      error: `Invalid conversationId: expected "app-chat:${appId}:{http|local}:{direct|group}:{chatId}"`,
    }
  }
  if (parsed.channel !== HTTP_SESSION_CHANNEL && parsed.channel !== LOCAL_SESSION_CHANNEL) {
    return {
      ok: false,
      error: 'Invalid conversationId: the HTTP API may only address the "http" or "local" channel',
    }
  }
  if (!HTTP_CHAT_ID_PATTERN.test(parsed.chatId)) {
    return {
      ok: false,
      error: 'Invalid conversationId: chatId must match [A-Za-z0-9_-] and be 1-128 characters',
    }
  }
  return { ok: true, conversationId: raw }
}
