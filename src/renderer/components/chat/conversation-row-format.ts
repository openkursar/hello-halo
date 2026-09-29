/**
 * How a conversation row reads, shared by every list of conversations (the
 * sidebar and the mobile history sheet) so the same conversation never shows
 * two different labels or times.
 */

import type { AppChatConversationRow } from '../../hooks/useAppChatConversationRows'

/**
 * Conversation timestamp: clock time for today, weekday-less date beyond it.
 * Kept narrower than `formatTimeAgo` because it has to fit beside a title in a
 * 140–360px sidebar without truncating it. The hover card reuses it so the same
 * conversation never shows two different times.
 */
export function formatRowTime(timestamp: string | number, t: (s: string) => string): string {
  const d = new Date(timestamp)
  const ms = d.getTime()
  if (!ms) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return t('Yesterday')
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
  }
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' })
}


/**
 * Same shape as conversation.service.ts's generateTitle() ("Chat M-D H:MM"),
 * so a fresh digital-human session reads like a fresh regular conversation
 * instead of the more generic, slightly misleading "New chat". Computed here
 * rather than persisted server-side: local-session displayName is left empty
 * on purpose so the renderer can localize this fallback (see
 * im-session-registry.ts's createLocalSession doc comment).
 */
function formatDefaultChatTitle(timestamp: number, t: (s: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(timestamp)
  const minute = d.getMinutes().toString().padStart(2, '0')
  return t('Chat {{date}}', { date: `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${minute}` })
}

/**
 * What distinguishes one session of the same digital human from another.
 * Inside its own section the digital human's name/avatar is already on the
 * sub-header, so a row shows only this; the collapsed rail has no header at
 * all and pairs it with the owner's name instead.
 */
export function appChatSessionLabel(row: AppChatConversationRow, t: (s: string, opts?: Record<string, unknown>) => string): string {
  return row.isDefault
    ? (row.lastMessage || t('No messages yet'))
    : (row.customName || row.displayName.trim() || row.lastMessage || formatDefaultChatTitle(row.updatedAt, t))
}

