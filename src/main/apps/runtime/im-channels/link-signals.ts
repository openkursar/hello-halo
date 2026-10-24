/**
 * apps/runtime/im-channels -- Link signals
 *
 * Moments when an IM link should be re-checked rather than left to its own
 * backoff or heartbeat: the machine woke from sleep, its network addresses
 * changed (Wi-Fi switch, VPN up/down), or the user changed where IM traffic
 * goes. Plus one slow shared tick for the supervisors' own consistency checks.
 *
 * One set of listeners and one timer for the whole process, held only while at
 * least one link is supervised.
 */

import { powerMonitor } from 'electron'
import { networkInterfaces } from 'node:os'
import { onLinkRouteChange } from './link-route'

export type LinkSignal = 'resume' | 'network-changed' | 'route-changed'

export interface LinkSignalListener {
  onSignal(signal: LinkSignal): void
  onTick(): void
}

/** The network usually needs a few seconds after wake before a dial can succeed. */
const RESUME_DELAY_MS = 5_000
/** Several fields saved in a row (proxy, then bypass list) settle into one redial. */
const ROUTE_CHANGE_DEBOUNCE_MS = 1_000
const TICK_INTERVAL_MS = 30_000

const listeners = new Set<LinkSignalListener>()
let teardown: (() => void) | null = null

function dispatch(signal: LinkSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener.onSignal(signal)
    } catch (err) {
      console.error(`[ImLinkSignals] ${signal} handler failed:`, err)
    }
  }
}

/**
 * The machine's external IPv4 addresses. Internal and IPv6 link-local
 * addresses are left out: they come and go with virtual interfaces without
 * any effect on established connections.
 */
function addressFingerprint(): string {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return addresses.sort().join(',')
}

function startWatching(): () => void {
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let routeTimer: ReturnType<typeof setTimeout> | null = null
  let lastAddresses = addressFingerprint()

  const onResume = (): void => {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      // Wake already redials everything; an address change seen across the
      // sleep must not trigger a second round on the next tick.
      lastAddresses = addressFingerprint()
      dispatch('resume')
    }, RESUME_DELAY_MS)
  }
  powerMonitor.on('resume', onResume)

  const stopRouteWatch = onLinkRouteChange(() => {
    if (routeTimer) clearTimeout(routeTimer)
    routeTimer = setTimeout(() => {
      routeTimer = null
      dispatch('route-changed')
    }, ROUTE_CHANGE_DEBOUNCE_MS)
  })

  const tick = setInterval(() => {
    const addresses = addressFingerprint()
    if (addresses !== lastAddresses) {
      console.log(`[ImLinkSignals] Network addresses changed (${lastAddresses || 'none'} -> ${addresses || 'none'})`)
      lastAddresses = addresses
      dispatch('network-changed')
    }
    for (const listener of [...listeners]) {
      try {
        listener.onTick()
      } catch (err) {
        console.error('[ImLinkSignals] Tick handler failed:', err)
      }
    }
  }, TICK_INTERVAL_MS)
  tick.unref?.()

  return () => {
    powerMonitor.removeListener('resume', onResume)
    stopRouteWatch()
    clearInterval(tick)
    if (resumeTimer) clearTimeout(resumeTimer)
    if (routeTimer) clearTimeout(routeTimer)
  }
}

export function watchLinkSignals(listener: LinkSignalListener): () => void {
  listeners.add(listener)
  if (!teardown) teardown = startWatching()
  return () => {
    if (!listeners.delete(listener)) return
    if (listeners.size === 0 && teardown) {
      teardown()
      teardown = null
    }
  }
}
