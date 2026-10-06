/**
 * Which IM chats a digital human may add as push targets: chats another
 * digital human's bot already knows, offered in its settings so it can push
 * there without the chat ever messaging it.
 */

import type { ImChannelInstanceStatus, ImSessionRecord } from '../../../shared/types/im-channel'

/** The bot chat a session pushes through. */
const routeOf = (session: ImSessionRecord) => `${session.instanceId}:${session.chatId}`

/** Whether `appId` already pushes to this session through a link. */
export function isLinkedTo(session: ImSessionRecord, appId: string): boolean {
  return session.appId !== appId && !!session.pushLinks?.some(link => link.appId === appId)
}

/**
 * Other digital humans' IM sessions `appId` could add, one per bot chat, most
 * recently active first: never a chat it already reaches (its own or linked),
 * nor one whose bot was removed — nothing could be pushed there.
 */
export function pushTargetCandidates(
  all: readonly ImSessionRecord[],
  appId: string,
  bots: readonly ImChannelInstanceStatus[]
): ImSessionRecord[] {
  const botIds = new Set(bots.map(bot => bot.id))
  const reached = new Set(all.filter(s => s.source === 'im' && (s.appId === appId || isLinkedTo(s, appId))).map(routeOf))
  const byRoute = new Map<string, ImSessionRecord>()
  for (const session of all) {
    if (session.source !== 'im' || session.appId === appId || !botIds.has(session.instanceId)) continue
    const route = routeOf(session)
    if (reached.has(route)) continue
    const held = byRoute.get(route)
    if (!held || session.lastActiveAt > held.lastActiveAt) byRoute.set(route, session)
  }
  return [...byRoute.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
