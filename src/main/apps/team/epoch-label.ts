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

import type { TeamConversationKind, TeamEpoch, TeamMember } from '../../../shared/apps/team-types'
import { parseMemberChatKey, isNativeConversationChatKey, parseTeamChatKey, parseSpaceCollabChatKey } from '../../../shared/apps/im-keys'
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
  // A space collaboration's room is its own kind, not a native session: a reader
  // that cannot tell them apart cannot tell which conversation the space
  // conversation coordinates (and must not create a second one beside it).
  if (parseSpaceCollabChatKey(chatKey)) return 'collab'
  if (parseMemberChatKey(chatKey)) return 'member'
  return 'im'
}

/**
 * Resolve the human label of a conversation epoch:
 *   1. a collaboration room labels as the space conversation it serves, through
 *      the injected describer, falling back to its stored title;
 *   2. an explicit user-set title always wins;
 *   3. a member direct chat labels as the member's name;
 *   4. an IM chat labels via the injected chat describer (IM session registry);
 *   5. otherwise empty — the renderer shows its own neutral category label.
 */
export function deriveConversationLabel(
  store: TeamStore,
  epoch: TeamEpoch,
  describeChatKey?: (teamId: string, chatKey: string) => string | null,
  members?: TeamMember[]
): string {
  const chatKey = epoch.chatKey ?? ''
  // The stored title is the name the room got when it opened (older rooms were
  // named from the first collaborator's brief); the conversation's own title
  // is what the user knows it by and follows a rename.
  if (parseSpaceCollabChatKey(chatKey)) return describeChatKey?.(epoch.teamId, chatKey)?.trim() || epoch.title?.trim() || ''
  if (epoch.title && epoch.title.trim()) return epoch.title.trim()
  if (!chatKey) return ''

  const memberAppId = parseMemberChatKey(chatKey)
  if (memberAppId) {
    const member = (members ?? store.listMembersByTeam(epoch.teamId)).find((m) => m.appId === memberAppId)
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
