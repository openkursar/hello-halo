/**
 * apps/runtime/federation -- Remote-busy overlay (host authority role)
 *
 * Members whose turn is currently running on a REMOTE owner (a wake was sent,
 * its turn-complete has not come back). The host's local runtime only knows
 * turns it executes itself, so without this overlay the roster projected to
 * viewers pulses ONLY host-owned members — a joiner-owned member looked idle
 * everywhere while it was actually working. Keyed by wake correlationId;
 * entries clear on turn-complete / waiter-cleanup / owner-confirmed-offline,
 * with a TTL backstop against a wake whose completion never arrives.
 *
 * Self-contained state (the correlation → entry map) with a narrow surface, so
 * the manager composes it instead of carrying the map + its lifecycle inline.
 * Its one outward dependency is a roster-refresh signal: every mutation asks
 * the manager to schedule a throttled roster re-projection so viewers animate
 * the working/idle transition.
 */

import type { NodeId } from './types'

/** Backstop for a wake whose turn-complete never arrives (owner died mid-turn). */
const REMOTE_BUSY_TTL_MS = 10 * 60_000

interface RemoteBusyEntry {
  officeId: string
  appId: string
  ownerNodeId: NodeId
  startedAt: number
}

export interface RemoteBusyOverlay {
  /** A wake was sent to `ownerNodeId`: overlay the member as working. */
  mark(correlationId: string, officeId: string, appId: string, ownerNodeId: NodeId): void
  /** Drop one correlation (its turn completed, or its waiter was cancelled). */
  clear(correlationId: string): void
  /** Drop every in-flight entry for one member (its owner was confirmed offline). */
  clearForApp(appId: string): void
  /** Whether a member currently has a turn in flight on a remote owner. */
  isBusy(appId: string): boolean
  /**
   * The node a correlation's wake was sent to, or undefined when unknown. The
   * host asserts an inbound turn-complete's session identity against this so a
   * peer cannot forge another member's turn outcome.
   */
  ownerNodeId(correlationId: string): NodeId | undefined
}

/**
 * @param onChange invoked with the affected officeId on every mutation, so the
 * caller can schedule a throttled roster re-projection to the office's viewers.
 */
export function createRemoteBusyOverlay(onChange: (officeId: string) => void): RemoteBusyOverlay {
  const byCorr = new Map<string, RemoteBusyEntry>()

  function mark(correlationId: string, officeId: string, appId: string, ownerNodeId: NodeId): void {
    byCorr.set(correlationId, { officeId, appId, ownerNodeId, startedAt: Date.now() })
    onChange(officeId)
  }

  function clear(correlationId: string): void {
    const entry = byCorr.get(correlationId)
    if (!entry) return
    byCorr.delete(correlationId)
    onChange(entry.officeId)
  }

  function clearForApp(appId: string): void {
    for (const [corr, entry] of byCorr) {
      if (entry.appId !== appId) continue
      byCorr.delete(corr)
      onChange(entry.officeId)
    }
  }

  function isBusy(appId: string): boolean {
    const now = Date.now()
    let busy = false
    for (const [corr, entry] of byCorr) {
      if (now - entry.startedAt > REMOTE_BUSY_TTL_MS) {
        byCorr.delete(corr)
        // The backstop finally fired: a turn-complete never arrived and the owner
        // was never confirmed offline. Signal a roster refresh so the stale
        // 'working' projection is corrected — otherwise the eviction is silent
        // and the pulse lingers until an unrelated event happens to re-project.
        onChange(entry.officeId)
        continue
      }
      // Do not early-return: sweep the whole map so every expired entry is
      // evicted (and its refresh scheduled) in this pass, not just up to the match.
      if (entry.appId === appId) busy = true
    }
    return busy
  }

  function ownerNodeId(correlationId: string): NodeId | undefined {
    return byCorr.get(correlationId)?.ownerNodeId
  }

  return { mark, clear, clearForApp, isBusy, ownerNodeId }
}
