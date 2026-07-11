/**
 * apps/runtime/federation -- Control-plane link seam (minimal transport)
 *
 * The link is a dumb pipe: it moves FederationMessages between nodes and
 * surfaces inbound frames to a single handler. All join + presence logic lives
 * in the coordinator; the link knows nothing about message semantics — no
 * 11-method god-interface, just send/broadcast/onMessage/close, pluggable
 * behind either an in-memory hub (tests) or the LAN WS transport (production).
 */

import type { FederationMessage, NodeId } from './types'

export interface FederationLink {
  /** Deliver a message to a specific node. */
  send(to: NodeId, msg: FederationMessage): void
  /** Deliver a message to every peer (excluding self). */
  broadcast(msg: FederationMessage): void
  /** Register the single inbound handler. A later call replaces the prior one. */
  onMessage(handler: (from: NodeId, msg: FederationMessage) => void): void
  /** Detach from transport; further send/broadcast become no-ops. */
  close(): void
}

/**
 * In-process hub that wires several InMemoryFederationLink instances together so
 * a unit test can simulate a small LAN of nodes inside one process. Delivery is
 * synchronous: send/broadcast invoke peer handlers before returning, which keeps
 * tests free of timers and ordering races.
 */
export class InMemoryFederationHub {
  private readonly links = new Map<NodeId, InMemoryFederationLink>()

  register(nodeId: NodeId, link: InMemoryFederationLink): void {
    this.links.set(nodeId, link)
  }

  unregister(nodeId: NodeId): void {
    this.links.delete(nodeId)
  }

  deliver(from: NodeId, to: NodeId, msg: FederationMessage): void {
    this.links.get(to)?.receive(from, msg)
  }

  deliverAll(from: NodeId, msg: FederationMessage): void {
    for (const [nodeId, link] of this.links) {
      if (nodeId === from) continue
      link.receive(from, msg)
    }
  }
}

/**
 * Hub-backed link for a single simulated node. Construct several over one shared
 * hub (each with a distinct nodeId) to exchange messages synchronously in tests.
 */
export class InMemoryFederationLink implements FederationLink {
  private handler: ((from: NodeId, msg: FederationMessage) => void) | null = null
  private closed = false

  constructor(
    private readonly nodeId: NodeId,
    private readonly hub: InMemoryFederationHub
  ) {
    hub.register(nodeId, this)
  }

  send(to: NodeId, msg: FederationMessage): void {
    if (this.closed) return
    this.hub.deliver(this.nodeId, to, msg)
  }

  broadcast(msg: FederationMessage): void {
    if (this.closed) return
    this.hub.deliverAll(this.nodeId, msg)
  }

  onMessage(handler: (from: NodeId, msg: FederationMessage) => void): void {
    this.handler = handler
  }

  /** Hub entrypoint: deliver an inbound frame to this node's handler. */
  receive(from: NodeId, msg: FederationMessage): void {
    if (this.closed) return
    this.handler?.(from, msg)
  }

  close(): void {
    this.closed = true
    this.handler = null
    this.hub.unregister(this.nodeId)
  }
}
