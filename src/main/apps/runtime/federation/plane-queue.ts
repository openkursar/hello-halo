/**
 * apps/runtime/federation -- Outbound frames waiting for a link, by plane
 *
 * One bounded queue per plane (`shared/federation/planes`), drained in plane
 * order so coordination leaves ahead of any stream/feed/artifact backlog built
 * up while the link was down. A full plane drops its OWN oldest frame — by
 * count, and by size where the plane has a byte budget — so a flood in one
 * plane never evicts another plane's frames.
 */

import { FEDERATION_PLANE_ORDER, federationPlaneSpec, type FederationPlane } from '../../../../shared/federation/planes'

export class PlaneQueue<T> {
  private readonly items = new Map<FederationPlane, Array<{ item: T; bytes: number }>>()
  private readonly bytes = new Map<FederationPlane, number>()

  /**
   * Queue `item` on `plane`; `size` is only asked for a plane with a byte
   * budget. Returns how many older frames of that plane were dropped for it.
   */
  push(plane: FederationPlane, item: T, size: () => number): number {
    const spec = federationPlaneSpec(plane)
    const queue = this.items.get(plane) ?? []
    this.items.set(plane, queue)
    const bytes = spec.capBytes > 0 ? size() : 0
    let used = this.bytes.get(plane) ?? 0
    let dropped = 0
    while (queue.length > 0 && (queue.length >= spec.capFrames || (spec.capBytes > 0 && used + bytes > spec.capBytes))) {
      used -= queue.shift()!.bytes
      dropped += 1
    }
    queue.push({ item, bytes })
    this.bytes.set(plane, used + bytes)
    return dropped
  }

  /** Hand every queued item to `send`, highest-priority plane first, and empty the queue. */
  drain(send: (item: T) => void): void {
    for (const plane of FEDERATION_PLANE_ORDER) {
      const queue = this.items.get(plane)
      if (!queue || queue.length === 0) continue
      this.items.set(plane, [])
      this.bytes.set(plane, 0)
      for (const { item } of queue) send(item)
    }
  }

  size(plane: FederationPlane): number {
    return this.items.get(plane)?.length ?? 0
  }
}
