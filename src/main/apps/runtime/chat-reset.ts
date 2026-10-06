/**
 * Clearing every conversation a digital human holds, at once — after its
 * instructions or knowledge changed, so no chat keeps answering from what it
 * said before: each is cleared exactly as `/clear` clears it. Its default and
 * local chats in Halo and its IM chats are covered; API sessions belong to
 * their callers and team chats to their teams, so both are left alone, as are
 * its memory, reminders and runs. Nothing is posted into the chats.
 */

import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { classifySessionSource } from '../../../shared/types/im-channel'
import { buildImSessionKey, buildLocalSessionKey } from '../../../shared/apps/im-keys'
import { getAppManager } from '../manager'
import { clearAppChat, clearImSession } from './app-chat'
import { clearSupplementBuffer } from './dispatch-inbound'
import { clearImPermissionContext } from './im-permission-registry'
import { getImSessionRegistry } from './im-session-registry'
import { getPendingRelayStore } from './pending-relays'

const LOG_TAG = '[ChatReset]'

export interface ClearableChats {
  total: number
  /** Of those, chats in IM groups and private chats. */
  im: number
}

/** The conversations a clear covers: Halo and IM chats that have something to clear. */
function clearableSessions(appId: string): ImSessionRecord[] {
  return (getImSessionRegistry()?.getAllSessions(appId) ?? []).filter(session => {
    if (session.teamContext) return false
    const source = session.source ?? classifySessionSource(session.channel)
    if (source !== 'native' && source !== 'local' && source !== 'im') return false
    // A legacy record has no count; it may well have history.
    return session.messageCount === undefined || session.messageCount > 0
  })
}

export function countClearableChats(appId: string): ClearableChats {
  const sessions = clearableSessions(appId)
  return {
    total: sessions.length,
    im: sessions.filter(session => (session.source ?? classifySessionSource(session.channel)) === 'im').length,
  }
}

/**
 * Clear each of the digital human's conversations in turn. A failure is
 * logged and counted, and does not stop the rest.
 */
export async function clearAllChats(appId: string): Promise<{ cleared: number; failed: number }> {
  const app = getAppManager()?.getApp(appId)
  if (!app || !app.spaceId) throw new Error('Digital human not found')
  const spaceId = app.spaceId
  let cleared = 0
  let failed = 0
  for (const session of clearableSessions(appId)) {
    try {
      const source = session.source ?? classifySessionSource(session.channel)
      if (source === 'im') {
        const conversationId = buildImSessionKey(appId, session.channel, session.chatType, session.chatId)
        clearSupplementBuffer(conversationId)
        await clearImSession(appId, spaceId, session.channel, session.chatType, session.chatId)
        clearImPermissionContext(conversationId)
        getPendingRelayStore()?.clear(conversationId)
      } else {
        await clearAppChat(appId, spaceId, source === 'local' ? buildLocalSessionKey(appId, session.chatId) : undefined)
      }
      cleared += 1
    } catch (error) {
      failed += 1
      console.error(`${LOG_TAG} Could not clear ${session.channel}:${session.chatId} of ${appId}:`, error)
    }
  }
  console.log(`${LOG_TAG} Cleared ${cleared} conversation(s) of ${appId}${failed > 0 ? `, ${failed} failed` : ''}`)
  return { cleared, failed }
}
