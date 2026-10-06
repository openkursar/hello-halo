/**
 * Space memory: consolidation after turns, and the owner's controls.
 *
 * services/agent has no turn-end hook of its own, but it broadcasts
 * `agent:complete` for every finished turn on the public `onAgentEvent`
 * subscription — the same signal conversation-interop listens to. Subscribing
 * here keeps the agent engine unaware of consolidation.
 */

import { onAgentEvent, activeSessions, getApiCredentialsForConversation, getApiCredentials } from '../agent'
import { resolveCredentialsForSdk } from '../agent/sdk-config'
import { getConversation } from '../conversation.service'
import { getSpace, getSpaceMemoryLayout, getSpaceMemorySettings } from '../space.service'
import type { IDisposable } from '../../platform/event'
import type { MemoryStatus } from '../../../shared/types/memory'
import { requestConsolidation, consolidateNow, getMemoryStatus, type ConsolidationRequest } from './service'

let subscription: IDisposable | null = null

function spaceRequest(
  spaceId: string,
  opts: { conversationId?: string; evenWhenOff?: boolean } = {}
): ConsolidationRequest | null {
  const { conversationId } = opts
  const settings = getSpaceMemorySettings(spaceId)
  if (!settings.enabled && !opts.evenWhenOff) return null
  const layout = getSpaceMemoryLayout(spaceId)
  if (!layout) return null
  return {
    layout,
    ownerKind: 'space',
    ownerName: getSpace(spaceId)?.name ?? spaceId,
    spaceId,
    settings,
    tag: `space:${spaceId.slice(0, 8)}`,
    resolveCredentials: async () => {
      // The conversation's own model when a turn triggered it; otherwise the global one.
      const credentials = conversationId
        ? await getApiCredentialsForConversation(getConversation(spaceId, conversationId))
        : await getApiCredentials()
      return resolveCredentialsForSdk(credentials)
    },
    isBusy: () => [...activeSessions.values()].some(
      s => s.spaceId === spaceId && s.conversationId !== conversationId
    ),
  }
}

/** Idempotent — a second call is a no-op until dispose. */
export function initSpaceMemoryConsolidation(): void {
  if (subscription) return
  subscription = onAgentEvent((event) => {
    if (event.channel !== 'agent:complete') return
    try {
      const req = spaceRequest(event.spaceId, { conversationId: event.conversationId })
      if (req) requestConsolidation(req)
    } catch (err) {
      console.error(`[MemoryConsolidation] Space trigger failed for ${event.spaceId}:`, err)
    }
  })
}

export function disposeSpaceMemoryConsolidation(): void {
  subscription?.dispose()
  subscription = null
}

export async function getSpaceMemoryStatus(spaceId: string): Promise<MemoryStatus | null> {
  const layout = getSpaceMemoryLayout(spaceId)
  return layout ? getMemoryStatus(layout) : null
}

/** The owner's "consolidate now": runs on what is there, even with memory off. */
export function consolidateSpaceMemoryNow(spaceId: string): { started: boolean; reason?: string } {
  const req = spaceRequest(spaceId, { evenWhenOff: true })
  if (!req) return { started: false, reason: 'not-found' }
  return consolidateNow(req)
}
