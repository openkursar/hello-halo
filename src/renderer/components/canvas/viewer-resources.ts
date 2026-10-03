/**
 * Per-viewer ownership of imperative resources (workers, observers, editor
 * and terminal instances, IPC subscriptions, object URLs).
 *
 * A viewer registers each resource where it creates it; the store releases
 * everything when the viewer unmounts, and anything registered after that —
 * the tail of an async load that finished late — is released on arrival. An
 * effect that recreates resources on a dependency change takes a `scope()` and
 * disposes it in its cleanup.
 */

import { useEffect, useState } from 'react'

export type DisposableLike =
  | (() => void)
  | { dispose(): void }
  | { terminate(): void }
  | { destroy(): unknown }
  | { disconnect(): void }

function releaserFor(resource: DisposableLike): () => void {
  if (typeof resource === 'function') return resource
  if ('dispose' in resource) return () => resource.dispose()
  if ('terminate' in resource) return () => resource.terminate()
  if ('destroy' in resource) return () => { void resource.destroy() }
  return () => resource.disconnect()
}

export class DisposableStore {
  private releasers = new Set<() => void>()
  private disposed = false

  constructor(private readonly onDispose?: () => void) {}

  /** Resources held right now. */
  get size(): number {
    return this.releasers.size
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Registers `resource` (released at once if this store is already disposed) and returns it. */
  add<T extends DisposableLike>(resource: T): T {
    const release = releaserFor(resource)
    if (this.disposed) {
      release()
    } else {
      this.releasers.add(release)
    }
    return resource
  }

  /** A child store, released with this one or earlier by its own `dispose()`. */
  scope(): DisposableStore {
    let release: () => void = () => {}
    const child = new DisposableStore(() => this.releasers.delete(release))
    release = () => child.dispose()
    this.add(release)
    return child
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Newest first: later resources may depend on earlier ones (a subscription on a terminal).
    const releasers = [...this.releasers].reverse()
    this.releasers.clear()
    for (const release of releasers) {
      try {
        release()
      } catch (error) {
        console.error('[ViewerResources] Failed to release a resource:', error)
      }
    }
    this.onDispose?.()
  }
}

/** The calling viewer's resource store; released when the viewer unmounts. */
export function useViewerResources(): DisposableStore {
  const [store] = useState(() => new DisposableStore())
  useEffect(() => () => store.dispose(), [store])
  return store
}
