/**
 * Tracks how many times each artifact path has been rewritten on disk, so a
 * viewer can build a URL that is stable while the file is unchanged and
 * different once it is not.
 *
 * A viewer that rewrites its URL on every mount defeats the renderer's resource
 * cache by design: each open becomes a fresh entry rather than a hit, and the
 * cache grows with the number of opens. Measured on the image viewer at
 * 0.51 MB per open before this existed, against 0.09 MB for viewers that keep
 * their URL — see tests/perf/docs/rounds/2026-09-locating-the-leak.md.
 *
 * The subscription lives here rather than in the viewer because the case a
 * per-mount token was there to cover is a file changing while no viewer is
 * mounted. It starts with the first subscriber, so a rewrite landing before any
 * viewer has ever mounted is not counted; the first URL built for that path is
 * then the same one an earlier session used. Nothing here can close that
 * window — whether it is reachable at all depends on whether `halo-file://`
 * responses outlive the process, which is the protocol handler's property.
 */

import { api } from '../api'

const versions = new Map<string, number>()
const listeners = new Set<() => void>()
/**
 * The change subscription is deliberately never torn down: it is one listener
 * for a module-level singleton that lives as long as the renderer, and it must
 * keep counting across the gaps when no viewer is mounted.
 */
let watching = false

function ensureWatching(): void {
  if (watching) return
  watching = true
  api.onArtifactChanged((data) => {
    if (data.type !== 'change' && data.type !== 'add') return
    const current = versions.get(data.path)
    if (current === undefined) return
    versions.set(data.path, current + 1)
    for (const listener of listeners) listener()
  })
}

/** Subscribe shape for `useSyncExternalStore`. */
export function subscribeArtifactVersions(listener: () => void): () => void {
  ensureWatching()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Starts tracking `path` on the first call, which is what bounds this map to
 * the files a viewer actually showed. Change events arrive for every file in
 * the space, so counting them all would grow the map with how fast the space is
 * written rather than with anything the user did. Registering on demand loses
 * nothing: a path nobody has asked about has never been turned into a URL, so
 * there is no cache entry under it for a counter to invalidate.
 *
 * Registering while reading is safe under `useSyncExternalStore` — it is
 * idempotent and does not change the value returned.
 *
 * Entries are never dropped. A dropped counter restarts at zero and rebuilds a
 * URL the pre-change bytes may still be cached under.
 */
export function getArtifactVersion(path: string): number {
  const current = versions.get(path)
  if (current !== undefined) return current
  versions.set(path, 0)
  return 0
}
