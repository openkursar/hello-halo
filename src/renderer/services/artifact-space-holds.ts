/**
 * Which spaces this client is showing file state for.
 *
 * The main process keeps a space's file cache and recursive watcher alive only
 * while some client declares it is showing that space. Components that need a
 * space's files (the file tree, the @mention menu) take a hold while mounted;
 * the first hold retains the space, and when the last one goes the space is
 * released after a short grace period, so a remount or a quick switch back
 * does not tear the watcher down and rebuild it.
 *
 * Main treats a hold as a lease: one not renewed for a few minutes expires, so
 * a client that reloads, crashes or disconnects without releasing cannot keep
 * a space alive. Held spaces are therefore re-retained on an interval, and a
 * renewal that finds the hold gone (the cache was rebuilt, so changes in
 * between were not delivered) is raised locally as a resync of that space.
 */

import { api } from '../api'

const RELEASE_GRACE_MS = 5_000
/** Well inside main's hold lease (3 min), even with throttled background timers. */
const RENEW_INTERVAL_MS = 60_000

/** Identifies this renderer instance (or remote tab) to the main process. */
const clientId = globalThis.crypto.randomUUID()

const holdCounts = new Map<string, number>()
const pendingReleases = new Map<string, ReturnType<typeof setTimeout>>()
let renewTimer: ReturnType<typeof setInterval> | null = null

function retain(spaceId: string, renewal = false): void {
  api.retainArtifactSpace(spaceId, clientId).then(response => {
    const recreated = (response.data as { recreated?: boolean } | undefined)?.recreated
    if (!renewal || !recreated || !holdCounts.has(spaceId)) return
    console.warn('[ArtifactSpaceHolds] Hold had lapsed; resyncing space:', spaceId)
    api.emitLocalArtifactChangedBatch({ spaceId, changes: [], resync: true })
  }).catch(error => {
    console.warn('[ArtifactSpaceHolds] Failed to retain space:', spaceId, error)
  })
}

function renewHolds(): void {
  if (holdCounts.size === 0) {
    if (renewTimer) clearInterval(renewTimer)
    renewTimer = null
    return
  }
  for (const spaceId of holdCounts.keys()) retain(spaceId, true)
}

/** Take a hold on `spaceId`; call the returned function to drop it (idempotent). */
export function holdArtifactSpace(spaceId: string): () => void {
  const pending = pendingReleases.get(spaceId)
  if (pending) {
    clearTimeout(pending)
    pendingReleases.delete(spaceId)
  }

  const count = holdCounts.get(spaceId) ?? 0
  holdCounts.set(spaceId, count + 1)
  // A space still inside its release grace period is still retained in main.
  if (count === 0 && !pending) retain(spaceId)
  if (!renewTimer) renewTimer = setInterval(renewHolds, RENEW_INTERVAL_MS)

  let dropped = false
  return () => {
    if (dropped) return
    dropped = true
    const left = (holdCounts.get(spaceId) ?? 1) - 1
    if (left > 0) {
      holdCounts.set(spaceId, left)
      return
    }
    holdCounts.delete(spaceId)
    pendingReleases.set(spaceId, setTimeout(() => {
      pendingReleases.delete(spaceId)
      api.releaseArtifactSpace(spaceId, clientId).catch(error => {
        console.warn('[ArtifactSpaceHolds] Failed to release space:', spaceId, error)
      })
    }, RELEASE_GRACE_MS))
  }
}
