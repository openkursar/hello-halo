/**
 * apps/team -- Conversation labeling (single source of truth).
 *
 * Human labels for conversation epochs are generated on the MAIN side so every
 * surface (roster busy projection, conversation list, federation snapshot)
 * agrees and the renderer performs zero translation logic (§ product spec:
 * "the down-send side generates the human name"). Labels are proper nouns
 * (a person's name, an IM chat name, a user-typed title) — category fallbacks
 * (e.g. "New session") stay in the renderer where t() lives.
 */

import type { TeamConversationKind, TeamEpoch } from '../../../shared/apps/team-types'
import { parseMemberChatKey, isNativeConversationChatKey, parseTeamChatKey } from '../../../shared/apps/im-keys'
import type { TeamStore } from './types'

/** Max stored length of an auto-derived conversation title (UI truncates further). */
const AUTO_TITLE_MAX = 48

/**
 * Derive a native conversation's title from its first user message — the same
 * "leading characters of the first message" rule the space chat uses
 * (`conversation.service` auto-title). Whitespace is collapsed so a multi-line
 * paste yields a clean one-line label; an ellipsis marks truncation. Returns
 * null when the message has no usable text (the caller keeps the epoch untitled).
 */
export function deriveConversationTitle(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > AUTO_TITLE_MAX ? `${text.slice(0, AUTO_TITLE_MAX)}…` : text
}

/** Classify a conversation epoch by its chatKey namespace. */
export function conversationKindOf(chatKey: string): TeamConversationKind {
  if (isNativeConversationChatKey(chatKey)) return 'native'
  if (parseMemberChatKey(chatKey)) return 'member'
  return 'im'
}

/**
 * Resolve the human label of a conversation epoch:
 *   1. an explicit user-set title always wins;
 *   2. a member direct chat labels as the member's name;
 *   3. an IM chat labels via the injected chat describer (IM session registry);
 *   4. otherwise empty — the renderer shows its own neutral category label.
 */
export function deriveConversationLabel(
  store: TeamStore,
  epoch: TeamEpoch,
  describeChatKey?: (teamId: string, chatKey: string) => string | null
): string {
  if (epoch.title && epoch.title.trim()) return epoch.title.trim()
  const chatKey = epoch.chatKey ?? ''
  if (!chatKey) return ''

  const memberAppId = parseMemberChatKey(chatKey)
  if (memberAppId) {
    const member = store.listMembersByTeam(epoch.teamId).find((m) => m.appId === memberAppId)
    return member?.memberName ?? ''
  }

  if (!isNativeConversationChatKey(chatKey)) {
    const described = describeChatKey?.(epoch.teamId, chatKey)
    if (described) return described
    // Fall back to the raw chat id — still a stable, recognizable handle.
    return parseTeamChatKey(chatKey)?.chatId ?? ''
  }

  return ''
}
