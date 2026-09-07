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
 * Build the chatKey for a member's 1:1 direct-chat 'conversation' epoch — one
 * long-lived thread per member, decoupled from team runs. The SAME key MUST be
 * used by the send path (open/reuse the epoch) and the history read (find it), so
 * a message and its transcript always resolve to the same epoch.
 *
 * Format: "direct:{appId}"
 */
export function memberChatKey(appId: string): string {
  return `direct:${appId}`
}

/** Parse a member direct-chat key back to its appId (null when not one). */
export function parseMemberChatKey(chatKey: string): string | null {
  return chatKey.startsWith('direct:') ? chatKey.slice('direct:'.length) : null
}

/**
 * Build the chatKey for a user-created native team conversation ("New session"
 * in the Conversations tab). The uuid makes each session an independent
 * context; the `native:` namespace distinguishes it from member direct chats
 * (`direct:`) and IM chats (`{instanceId}:{chatType}:{chatId}`).
 *
 * Format: "native:{uuid}"
 */
export function nativeConversationChatKey(uuid: string): string {
  return `native:${uuid}`
}

/** Whether a conversation chatKey is a user-created native team session. */
export function isNativeConversationChatKey(chatKey: string): boolean {
  return chatKey.startsWith('native:')
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
 * Build the team-channel session key for a member's participation in ONE team
 * run (epoch).
 *
 * Format: "app-chat:{appId}:team:{teamId}:{epochId}" (5 segments).
 *
 * The epochId is part of the key so EACH run is an independent, persistent
 * Claude Code session / history — a team behaves like a digital human with many
 * sessions: each run is a separate retrievable + resumable record (it is never
 * overwritten by the next run). The literal "team" 3rd segment disambiguates
 * from IM keys (which are also 5 segments).
 */
export function buildTeamSessionKey(appId: string, teamId: string, epochId: string): string {
  return `app-chat:${appId}:team:${teamId}:${epochId}`
}

/**
 * Check whether a conversationId belongs to a team-channel session.
 *
 * Team keys: "app-chat:{appId}:team:{teamId}:{epochId}" — exactly 5
 * colon-separated segments whose 3rd segment is the literal "team".
 */
export function isTeamSessionKey(conversationId: string): boolean {
  if (!conversationId.startsWith('app-chat:')) return false
  const parts = conversationId.split(':')
  return parts.length === 5 && parts[2] === 'team'
}

/** Parse a team-channel session key back into its parts (null when not a team key). */
export function parseTeamSessionKey(
  conversationId: string
): { appId: string; teamId: string; epochId: string } | null {
  if (!isTeamSessionKey(conversationId)) return null
  const parts = conversationId.split(':')
  return { appId: parts[1], teamId: parts[3], epochId: parts[4] }
}

/**
 * Build the chat scope key for a team-backed IM conversation epoch. Identifies
 * the exact IM chat a 'conversation' epoch serves so each chat gets its own
 * epoch AND so the team runtime can push the lead's later (woken) replies back
 * to that chat. Carries chatType because pushToChat needs it.
 *
 * Format: "{instanceId}:{chatType}:{chatId}" — chatId may itself contain ':'.
 */
export function buildTeamChatKey(
  instanceId: string,
  chatType: 'direct' | 'group',
  chatId: string
): string {
  return `${instanceId}:${chatType}:${chatId}`
}

/** Parse a team chat key. Splits only the first two ':' so chatId stays intact. */
export function parseTeamChatKey(
  chatKey: string
): { instanceId: string; chatType: 'direct' | 'group'; chatId: string } | null {
  const first = chatKey.indexOf(':')
  if (first < 0) return null
  const second = chatKey.indexOf(':', first + 1)
  if (second < 0) return null
  const instanceId = chatKey.slice(0, first)
  const chatType = chatKey.slice(first + 1, second)
  const chatId = chatKey.slice(second + 1)
  if (chatType !== 'direct' && chatType !== 'group') return null
  if (!instanceId || !chatId) return null
  return { instanceId, chatType, chatId }
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
 * Allowed charset for the caller-controlled segments of an externally-supplied
 * conversation key (an HTTP chatId, a team key's teamId/epochId).
 *
 * These segments become part of the on-disk JSONL filename (via the runtime's
 * deriveRunId), so an unconstrained, caller-controlled value is a
 * path-traversal vector. Restricting to a filename-safe charset (no dots,
 * slashes, or separators) makes traversal impossible while comfortably
 * covering typical business user keys and generated ids.
 */
const HTTP_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Result of validating an externally-supplied HTTP conversationId.
 *
 * `team` is present only for a team-channel key. It carries the ids the caller
 * asked for so the OWNERSHIP questions this module cannot answer — does this
 * epoch belong to this team, is this app a member of it — can be answered by
 * the main-process caller that holds the team store. A team key is not usable
 * until they are.
 */
export type HttpConversationIdResult =
  | { ok: true; conversationId: string; team?: { teamId: string; epochId: string } }
  | { ok: false; error: string }

/**
 * Validate and normalize a conversationId supplied by an external HTTP caller
 * on an app-chat request.
 *
 * Accepts:
 *   - empty / non-string      → the app's native default conversation
 *   - the native default key  → as-is (shared native chat)
 *   - a well-formed HTTP key  → "app-chat:{appId}:http:{direct|group}:{chatId}"
 *   - a native local key      → "app-chat:{appId}:local:direct:{sessionUuid}"
 *   - a team-channel key      → "app-chat:{appId}:team:{teamId}:{epochId}"
 *
 * Rejects everything else — in particular IM-channel keys (an HTTP caller must
 * never be able to address or inject into an IM session) and segments outside
 * the filename-safe charset. The 'local' channel is permitted so the remote
 * web client (an authenticated Halo UI that reaches the same endpoint over
 * HTTP) can drive the user's native multi-sessions; it is non-pushable and
 * carries no more capability than an 'http' session. The 'team' channel is
 * permitted for the same reason — it is the ONLY way the remote client can
 * reach a team-backed digital human, which the desktop client reaches over IPC
 * — but it is the one form whose validity is not decidable from the string, so
 * it is returned tagged rather than simply approved.
 *
 * This is the shape half of the trust boundary for caller-controlled
 * conversation ids.
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

  const team = parseTeamSessionKey(raw)
  if (team) {
    if (team.appId !== appId) {
      return { ok: false, error: 'Invalid conversationId: the key addresses a different app' }
    }
    if (!HTTP_KEY_SEGMENT_PATTERN.test(team.teamId) || !HTTP_KEY_SEGMENT_PATTERN.test(team.epochId)) {
      return {
        ok: false,
        error: 'Invalid conversationId: teamId and epochId must match [A-Za-z0-9_-] and be 1-128 characters',
      }
    }
    return { ok: true, conversationId: raw, team: { teamId: team.teamId, epochId: team.epochId } }
  }

  const parsed = parseAppChatKey(raw)
  if (!parsed || parsed.appId !== appId) {
    return {
      ok: false,
      error: `Invalid conversationId: expected "app-chat:${appId}", "app-chat:${appId}:{http|local}:{direct|group}:{chatId}" or "app-chat:${appId}:team:{teamId}:{epochId}"`,
    }
  }
  if (parsed.channel !== HTTP_SESSION_CHANNEL && parsed.channel !== LOCAL_SESSION_CHANNEL) {
    return {
      ok: false,
      error: 'Invalid conversationId: the HTTP API may only address the "http", "local" or "team" channel',
    }
  }
  if (!HTTP_KEY_SEGMENT_PATTERN.test(parsed.chatId)) {
    return {
      ok: false,
      error: 'Invalid conversationId: chatId must match [A-Za-z0-9_-] and be 1-128 characters',
    }
  }
  return { ok: true, conversationId: raw }
}
