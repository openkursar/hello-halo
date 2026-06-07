/**
 * IM session key builders — shared between main process and renderer.
 *
 * The conversation-ID format is the single source of truth for session
 * isolation across all layers: runtime, event routing, store lookups, and
 * renderer subscriptions.  Both sides MUST use these functions instead of
 * constructing the key string inline, so that any future format change is
 * automatically reflected everywhere.
 */

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
 * Check whether a conversationId belongs to an IM channel session.
 *
 * IM keys have the form "app-chat:{appId}:{channel}:{chatType}:{chatId}"
 * (5 segments, 4 colons).  Other key formats in the system:
 *   - Native Halo chat:   "app-chat:{appId}"                         (2 segments)
 *   - Team channel:       "app-chat:{appId}:team:{teamId}:{epochId}" (5 segments, 3rd = "team")
 *   - Automation run:     "app-run-{runId}"                          (0 colons)
 *
 * Team keys are ALSO 5 segments, so the 3rd segment is checked to disambiguate
 * (an IM channel name is never the literal "team"). Keeping this predicate next
 * to buildImSessionKey ensures the detection logic stays in sync (single SSOT).
 */
export function isImSessionKey(conversationId: string): boolean {
  if (!conversationId.startsWith('app-chat:')) return false
  const parts = conversationId.split(':')
  return parts.length === 5 && parts[2] !== 'team'
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
