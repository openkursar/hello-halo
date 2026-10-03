/**
 * apps/runtime/federation -- Who receives which live stream
 *
 * Authority side: a viewer receives a team session's `stream-frames` in full only
 * while it has that session subscribed; every other node gets the batch's status
 * events. `fanOutStream` is the one place this is decided, for the first host and
 * for an authority elected later alike.
 *
 * Viewer side: the sessions a local viewer shows are subscribed at the
 * authority; a session no longer shown is released after a grace period (a
 * panel toggled closed and open again keeps its stream). Subscriptions are soft
 * state: `resend` re-declares them after every (re)join, reconnect or election.
 */

import { randomUUID } from 'crypto'
import type { NodeId, StreamFramesFrame } from './types'
import type { StreamSubscribeFrame } from './protocol-m2'
import { milestoneOnly, statusOnly } from './relay'

/** How long a session stays subscribed after its last viewer went away. */
export const STREAM_UNSUBSCRIBE_GRACE_MS = 60_000

export interface StreamRecipients {
  subscribe(node: NodeId, sessionKey: string): void
  unsubscribe(node: NodeId, sessionKey: string): void
  dropNode(node: NodeId): void
  /** Whether `node` subscribed to the stream of `sessionKey`. */
  wants(node: NodeId, sessionKey: string): boolean
}

export function createStreamRecipients(): StreamRecipients {
  const byNode = new Map<NodeId, Set<string>>()
  return {
    subscribe(node, sessionKey) {
      let set = byNode.get(node)
      if (!set) byNode.set(node, (set = new Set()))
      set.add(sessionKey)
    },
    unsubscribe(node, sessionKey) {
      byNode.get(node)?.delete(sessionKey)
    },
    dropNode(node) {
      byNode.delete(node)
    },
    wants(node, sessionKey) {
      return byNode.get(node)?.has(sessionKey) ?? false
    },
  }
}

/** How the serving node reaches the office's nodes; the host and an elected authority each supply one. */
export interface StreamRoute {
  /** Nodes a batch may go to, the producer already left out. */
  nodes: readonly NodeId[]
  /**
   * Send one frame to `nodes`. A `droppable` frame may be replaced by `degrade()`
   * for a node whose connection is backed up.
   */
  send(
    nodes: readonly NodeId[],
    frame: StreamFramesFrame,
    opts: { droppable: boolean; degrade?: () => StreamFramesFrame | null }
  ): void
}

/**
 * One live batch to the office: the full batch to the session's subscribers (cut
 * to its milestones for a backed-up one), its status events to everyone else —
 * never shed, so a "running" indicator cannot go stale.
 */
export function fanOutStream(batch: StreamFramesFrame, recipients: StreamRecipients, route: StreamRoute): void {
  const detail: NodeId[] = []
  const status: NodeId[] = []
  for (const node of route.nodes) {
    if (recipients.wants(node, batch.sessionKey)) detail.push(node)
    else status.push(node)
  }
  if (detail.length > 0) route.send(detail, batch, { droppable: true, degrade: () => milestoneOnly(batch) })
  if (status.length === 0) return
  const reduced = statusOnly(batch)
  if (reduced) route.send(status, reduced, { droppable: false })
}

export interface StreamWatchDeps {
  officeId: string
  selfNodeId: NodeId
  /** Deliver to the authority. */
  send: (frame: StreamSubscribeFrame) => void
  schedule?: (ms: number, fn: () => void) => () => void
}

export interface StreamWatch {
  /** The office's team sessions local viewers show now (other offices' keys are the caller's filter). */
  setWatched(sessionKeys: ReadonlySet<string>): void
  /** Re-declare every held subscription (after a (re)join / reconnect / election). */
  resend(): void
  stop(): void
}

export function createStreamWatch(deps: StreamWatchDeps): StreamWatch {
  const schedule =
    deps.schedule ??
    ((ms: number, fn: () => void) => {
      const timer = setTimeout(fn, ms)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    })
  // Sessions subscribed at the authority, and pending releases of ones no longer shown.
  const held = new Set<string>()
  const releases = new Map<string, () => void>()

  function send(kind: StreamSubscribeFrame['kind'], sessionKey: string): void {
    deps.send({ kind, officeId: deps.officeId, fromNode: deps.selfNodeId, sessionKey, fid: randomUUID() })
  }

  function setWatched(sessionKeys: ReadonlySet<string>): void {
    for (const key of sessionKeys) {
      releases.get(key)?.()
      releases.delete(key)
      if (held.has(key)) continue
      held.add(key)
      send('stream-subscribe', key)
    }
    for (const key of held) {
      if (sessionKeys.has(key) || releases.has(key)) continue
      releases.set(
        key,
        schedule(STREAM_UNSUBSCRIBE_GRACE_MS, () => {
          releases.delete(key)
          held.delete(key)
          send('stream-unsubscribe', key)
        })
      )
    }
  }

  function resend(): void {
    for (const key of held) send('stream-subscribe', key)
  }

  function stop(): void {
    for (const cancel of releases.values()) cancel()
    releases.clear()
    held.clear()
  }

  return { setWatched, resend, stop }
}
