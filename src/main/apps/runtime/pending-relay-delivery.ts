import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { createTurnGate } from '../../platform/turn-gate'
import { hasLiveTurn, sendIntoLiveTurn, onAgentEvent } from '../../services/agent'
import { getSpace } from '../../services/space.service'
import { getAppManager } from '../manager'
import { getAppChatTurnIdentity, isAppChatConversationGenerating, onAppChatConversationChange } from './app-chat-live-turn'
import { getActiveImChannelManager } from './im-channels'
import { getImSessionRegistry } from './im-session-registry'
import { receivesImQuestions, resolveImPermission } from './im-sender-standing'
import { chatPushConversationId } from './chat-push'
import { prepareRelayActions } from './relay-actions'
import { getPendingRelayStore, renderRelayContext, type RelayEvent } from './pending-relays'
import { resolveTranscriptPath } from './session-store'

interface RelayDelivery {
  identity: string
  text: string
  events: RelayEvent[]
}

interface LiveRelayOffer {
  promise: Promise<void>
  again: boolean
  identities: Map<string, string>
  controller: AbortController
  authorizationRevision: object
  sessionRevision: object
}

// One preparation per active destination; all entries are released when it settles.
const activeOffers = new Map<string, LiveRelayOffer>()

const liveGate = createTurnGate<RelayDelivery>({
  isBusy: isAppChatConversationGenerating,
  getActiveIdentity: getAppChatTurnIdentity,
  getJobIdentity: job => job.identity,
  // Unread when a person stopped the turn: back to the spool for the next turn.
  deliverMidTurn: (key, job) => sendIntoLiveTurn(key, job.text, undefined, {
    onWithdrawn: () => getPendingRelayStore()?.restore(key, job.events),
  }),
  dispatch: async () => { throw new Error('Relay context is delivered only into existing work') },
})

function waitForStartingTurn(key: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || hasLiveTurn(key) || !isAppChatConversationGenerating(key)) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => {
      stop()
      ready.dispose()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const check = (changed: string) => {
      if (changed !== key || (!hasLiveTurn(key) && isAppChatConversationGenerating(key))) return
      finish()
    }
    const stop = onAppChatConversationChange(check)
    const ready = onAgentEvent(event => {
      if (event.channel === 'agent:turn-start' && !event.relayed) check(event.conversationId)
    })
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** The push is already recorded; only accepted context is removed from its durable spool. */
export function offerPendingRelaysToLiveTurn(
  key: string,
  destination: ImSessionRecord,
  event?: { id: string; identity: string | undefined },
): Promise<void> {
  if (!isAppChatConversationGenerating(key)) return Promise.resolve()
  const authorizationRevision = getActiveImChannelManager()?.getAuthorizationRevision(destination.instanceId)
  const sessionRevision = getImSessionRegistry()?.getSessionRevision(destination.appId, destination.channel, destination.chatId)
  if (!authorizationRevision || !sessionRevision) {
    console.warn(`[PendingRelayDelivery] Context retained without a current destination revision: conversation=${key}`)
    return Promise.resolve()
  }
  const existing = activeOffers.get(key)
  if (existing && existing.authorizationRevision === authorizationRevision && existing.sessionRevision === sessionRevision) {
    existing.again = true
    if (event?.identity) existing.identities.set(event.id, event.identity)
    const pendingIds = new Set(getPendingRelayStore()?.peek(key).map(item => item.id) ?? [])
    for (const id of existing.identities.keys()) if (!pendingIds.has(id)) existing.identities.delete(id)
    return existing.promise
  }
  existing?.controller.abort()
  const offer: LiveRelayOffer = {
    promise: Promise.resolve(), again: true, identities: new Map(), controller: new AbortController(),
    authorizationRevision, sessionRevision,
  }
  if (event?.identity) offer.identities.set(event.id, event.identity)
  activeOffers.set(key, offer)
  offer.promise = (async () => {
    do {
      offer.again = false
      await offerOnce(key, destination, offer)
    } while (offer.again && !offer.controller.signal.aborted && isAppChatConversationGenerating(key))
  })().finally(() => { if (activeOffers.get(key) === offer) activeOffers.delete(key) })
  return offer.promise
}

async function offerOnce(key: string, destination: ImSessionRecord, offer: LiveRelayOffer): Promise<void> {
  const signal = offer.controller.signal
  await waitForStartingTurn(key, signal)
  if (signal.aborted || !hasLiveTurn(key)) return
  const store = getPendingRelayStore()
  if (!store) return
  const currentDestination = () => getImSessionRegistry()?.findSession(destination.appId, destination.channel, destination.chatId)
  const currentConfig = () => getActiveImChannelManager()?.getInstanceConfig(destination.instanceId)
  const sameDestination = () => {
    const manager = getActiveImChannelManager()
    const registry = getImSessionRegistry()
    const session = currentDestination()
    const config = currentConfig()
    return !signal.aborted && manager?.getAuthorizationRevision(destination.instanceId) === offer.authorizationRevision &&
      registry?.getSessionRevision(destination.appId, destination.channel, destination.chatId) === offer.sessionRevision &&
      !!session && !!config?.enabled && session.instanceId === destination.instanceId &&
      config.appId === destination.appId && config.teamId === session.teamContext?.teamId &&
      chatPushConversationId(destination, session) === key
  }
  const authorized = () => {
    const config = currentConfig()
    const session = currentDestination()
    const sender = session?.contactId ?? session?.chatId ?? ''
    return sameDestination() && !!config && receivesImQuestions(config, session) &&
      resolveImPermission(config, sender, '').isOwner && getAppChatTurnIdentity(key) === 'owner'
  }
  if (!sameDestination()) {
    console.warn(`[PendingRelayDelivery] Context retained after destination changed: conversation=${key}`)
    return
  }
  const batches = new Map<string, RelayEvent[]>()
  for (const event of store.peek(key)) {
    if (event.kind !== 'push') continue
    const identity = event.action ? authorized() ? 'owner' : undefined : offer.identities.get(event.id)
    if (!identity) continue
    const events = batches.get(identity) ?? []
    events.push(event)
    batches.set(identity, events)
  }
  for (const [identity, events] of batches) {
    try {
      const actions = await prepareRelayActions(events, authorized)
      if (signal.aborted) return
      if (!sameDestination()) {
        console.warn(`[PendingRelayDelivery] Prepared context retained after destination changed: conversation=${key}`)
        return
      }
      if (events.some(event => event.kind === 'push' && event.action) && !authorized()) {
        console.warn(`[PendingRelayDelivery] Private question retained after authorization changed: conversation=${key}`)
        return
      }
      const pendingIds = new Set(store.peek(key).map(event => event.id))
      const remaining = events.filter(event => pendingIds.has(event.id))
      if (remaining.length === 0) continue
      const app = getAppManager()?.getApp(destination.appId)
      const spacePath = app?.spaceId ? getSpace(app.spaceId)?.path : undefined
      const config = currentConfig()
      const text = renderRelayContext(remaining, {
        includeOrigin: identity === 'owner',
        allowTranscript: identity === 'owner' && !!config?.permissionEnabled && !!config.owners?.length,
        resolveTranscriptPath: spacePath ? event => resolveTranscriptPath(spacePath, event.source.appId, event.source.runId) : undefined,
        actions,
      })
      if (liveGate.tryDeliverLive(key, { identity, text, events: remaining })) store.commit(key, remaining.map(event => event.id))
    } catch (error) {
      console.warn(`[PendingRelayDelivery] Context retained for a later message: conversation=${key}`, error)
    }
  }
}

/** Stop pending live offers; their messages remain in the spool for the next accepted turn. */
export function shutdownPendingRelayDelivery(): void {
  for (const [key, offer] of activeOffers) {
    offer.controller.abort()
    console.log(`[PendingRelayDelivery] Live offer cancelled for shutdown; context retained: conversation=${key}`)
  }
  activeOffers.clear()
}
