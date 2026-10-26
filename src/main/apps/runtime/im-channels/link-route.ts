/**
 * apps/runtime/im-channels -- Link route
 *
 * Where an IM channel's traffic goes: through the same proxy every other
 * outbound request in Halo takes (Settings proxy, else the system's, with the
 * bypass list honoured), or straight to the platform when the user turned
 * "Message channels use proxy" off. A failing proxy is never bypassed on the
 * channel's own initiative — a proxy may be there for compliance or to hide
 * the exit address, so changing the route is the user's call.
 *
 * The setting is read once and then kept current from config-change
 * notifications, so resolving a route never touches the disk.
 */

import type { Agent } from 'node:http'
import { setMaxListeners } from 'node:events'
import { getConfig, onNetworkConfigChange, type NetworkConfigPayload } from '../../../foundation/config.service'
import { proxyFetch, resolveProxyAgent, resolveProxyDialAgent } from '../../../services/proxy-fetch'

/** The route of one long-lived connection, released when the connection is. */
export interface LinkRoute {
  /** Agent to dial through; undefined means a direct connection. */
  readonly agent: Agent | undefined
  readonly viaProxy: boolean
  /** Destroy every socket this route opened. Idempotent. */
  close(): void
}

export const DIRECT_ROUTE: LinkRoute = { agent: undefined, viaProxy: false, close: () => {} }

interface RouteSettings {
  imUseProxy: boolean
  /** Everything that decides an IM route, so a change elsewhere in the network settings is ignored. */
  key: string
}

let settings: RouteSettings | undefined
const changeHandlers = new Set<() => void>()

function settingsFrom(network: Partial<NetworkConfigPayload> | undefined): RouteSettings {
  const imUseProxy = network?.imUseProxy !== false
  return {
    imUseProxy,
    key: JSON.stringify([imUseProxy, network?.proxy?.trim() || '', network?.noProxy?.trim() || '']),
  }
}

function currentSettings(): RouteSettings {
  if (!settings) settings = settingsFrom(getConfig().network)
  return settings
}

onNetworkConfigChange((network) => {
  const previous = settings
  settings = settingsFrom(network)
  if (!previous || previous.key === settings.key) return
  for (const handler of changeHandlers) {
    try {
      handler()
    } catch (err) {
      console.error('[ImLinkRoute] Route change handler failed:', err)
    }
  }
})

/** Called after a settings save changes where IM traffic goes. */
export function onLinkRouteChange(handler: () => void): () => void {
  currentSettings()
  changeHandlers.add(handler)
  return () => {
    changeHandlers.delete(handler)
  }
}

/** Pooled agent for one-off requests (sends, uploads); undefined means direct. */
export async function resolveLinkAgent(url: string): Promise<Agent | undefined> {
  if (!currentSettings().imUseProxy) return undefined
  return resolveProxyAgent(url)
}

/** `fetch` for a channel's one-off requests (media, setup, lookups), on the same route as its link. */
export function linkFetch(...args: [url: string | URL, init?: RequestInit]): Promise<Response> {
  return currentSettings().imUseProxy ? proxyFetch(...args) : globalThis.fetch(...args)
}

/**
 * Route for one connection attempt. Resolved per attempt, never cached, so the
 * next attempt after a settings change already takes the new route.
 */
export async function openLinkRoute(url: string): Promise<LinkRoute> {
  if (!currentSettings().imUseProxy) return DIRECT_ROUTE
  const controller = new AbortController()
  // Each socket of a route listens on this signal, and a channel's HTTP calls
  // can hold several at once.
  setMaxListeners(0, controller.signal)
  const agent = await resolveProxyDialAgent(url, controller.signal)
  if (!agent) return DIRECT_ROUTE
  let closed = false
  return {
    agent,
    viaProxy: true,
    close: () => {
      if (closed) return
      closed = true
      controller.abort()
      agent.destroy()
    },
  }
}
