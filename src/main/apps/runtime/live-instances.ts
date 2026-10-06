/** Execution identity for History attribution, and local activity for memory consolidation. */

import { getConversationsWithActiveRound } from './app-chat-sink'
import { getRunningConsumerIds, isSessionBusy } from '../../services/agent/session-manager'
import { listActiveRuns } from './active-runs'
import { getImPermissionContext } from './im-permission-registry'
import { getAppChatConversationId, parseAppChatKey, parseTeamSessionKey } from '../../../shared/apps/im-keys'
import { classifySessionSource } from '../../../shared/types/im-channel'
import type { TriggerType } from './types'

export interface InstanceIdentity {
  id: string
  origin: string
}

/** Includes idle resident consumers: stop/clear/restart must still be able to close them. */
export function collectAppConversationIds(appId: string): string[] {
  const prefix = getAppChatConversationId(appId)
  const ids = new Set<string>()
  for (const id of getConversationsWithActiveRound()) {
    if (id === prefix || id.startsWith(prefix + ':')) ids.add(id)
  }
  for (const id of getRunningConsumerIds()) {
    if (id === prefix || id.startsWith(prefix + ':')) ids.add(id)
  }
  return Array.from(ids)
}

/** Only active turns defer consolidation; an idle session is not executing. */
export function hasOtherAppExecution(appId: string, selfId?: string): boolean {
  if (listActiveRuns(appId).some(run => shortRunId(run.runId) !== selfId)) return true
  const rounds = new Set(getConversationsWithActiveRound())
  return collectAppConversationIds(appId).some(conversationId =>
    shortConversationId(conversationId) !== selfId && (rounds.has(conversationId) || isSessionBusy(conversationId))
  )
}

/** Stable across session rebuilds; IM guest/owner changes deliberately change the origin. */
export function describeSelfInstance(
  source: { runId: string; triggerType: TriggerType } | { conversationId: string }
): InstanceIdentity {
  if ('runId' in source) {
    return { id: shortRunId(source.runId), origin: runOrigin(source.triggerType) }
  }
  const conversationId = source.conversationId
  let origin = 'chat'
  if (parseTeamSessionKey(conversationId)) {
    origin = 'team'
  } else {
    const parsed = parseAppChatKey(conversationId)
    if (parsed && classifySessionSource(parsed.channel) === 'im') {
      origin = getImPermissionContext(conversationId)?.isOwner === false ? 'im-guest' : 'im'
    }
  }
  return { id: shortConversationId(conversationId), origin }
}

/** Origins are runtime-owned, never IM display names or other user-controlled text. */
export function formatInstanceTag(instance: InstanceIdentity): string {
  return `${instance.origin}#${instance.id.slice(0, 4)}`
}

function runOrigin(triggerType: TriggerType): string {
  switch (triggerType) {
    case 'schedule': return 'schedule'
    case 'event': return 'event'
    case 'manual': return 'manual'
    default: return 'run'
  }
}

function shortRunId(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 8)
}

/** Conversation keys share an app prefix, so hash the full key for attribution. */
function shortConversationId(conversationId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < conversationId.length; i++) {
    hash ^= conversationId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
