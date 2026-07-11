/**
 * apps/runtime/federation -- LAN mesh link (concrete transport)
 *
 * Concrete FederationLink that rides a pluggable WS sender. It carries no
 * discovery/addressing of its own — the Lead's WS wiring at the http layer
 * supplies a WsSender (to=null → broadcast) and calls deliver() when a
 * federation frame arrives on /ws. This keeps websocket.ts decoupled: the WS
 * layer only knows deliver(); the link forwards inbound frames to the
 * coordinator's onMessage handler and outbound frames to the WsSender.
 *
 * This is the concrete LAN implementation, not an abstract transport; tests
 * verify join + presence logic via InMemoryFederationLink instead.
 */

import type { FederationLink } from './link'
import type { FederationMessage, NodeId } from './types'

/** Outbound sender supplied by the WS wiring. `to=null` means broadcast. */
export type WsSender = (to: NodeId | null, frame: FederationMessage) => void

export class LanMeshLink implements FederationLink {
  private handler: ((from: NodeId, msg: FederationMessage) => void) | null = null
  private closed = false
  private wsSend: WsSender

  constructor(wsSend: WsSender) {
    this.wsSend = wsSend
  }

  send(to: NodeId, msg: FederationMessage): void {
    if (this.closed) return
    this.wsSend(to, msg)
  }

  broadcast(msg: FederationMessage): void {
    if (this.closed) return
    this.wsSend(null, msg)
  }

  /**
   * Swap the outbound sender in place. The link's identity and inbound handler
   * are unchanged — only where outgoing frames go. Lets a survivor's outbound
   * leg be redirected to a new peer target after a host loss without rebuilding
   * the coordinator. A repoint on a closed link is ignored.
   */
  repoint(wsSend: WsSender): void {
    if (this.closed) return
    this.wsSend = wsSend
  }

  onMessage(handler: (from: NodeId, msg: FederationMessage) => void): void {
    this.handler = handler
  }

  /**
   * Inbound entrypoint for the WS layer: call this when a federation frame
   * arrives from `from`. Forwards to the coordinator's registered handler.
   */
  deliver(from: NodeId, msg: FederationMessage): void {
    if (this.closed) return
    this.handler?.(from, msg)
  }

  close(): void {
    this.closed = true
    this.handler = null
  }
}
