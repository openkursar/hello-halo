/**
 * Tlon file watcher — @parcel/watcher subscriptions per KB.
 *
 * Watches each active KB's raw/ directory and every linked directory. On a
 * settled change, computes the changed source files, enqueues them, and starts
 * processing. @parcel/watcher already coalesces writes; a small debounce
 * further collapses bursts before re-scanning.
 *
 * Subscriptions are keyed so they can be started/stopped per-KB (used by
 * createKB/deleteKB/addLinkedDir/removeLinkedDir).
 */

import parcelWatcher from '@parcel/watcher'
import type { AsyncSubscription } from '@parcel/watcher'
import { existsSync } from 'fs'
import type { LinkedDirectory } from '../../../shared/types/tlon'
import { getKBRawDir } from './paths'
import { listKBs, getKB, collectIngestCandidates } from './service'
import { enqueueFiles, processQueue, rebuildIndexMd } from './ingest'

interface WatchHandle {
  key: string
  subscription: AsyncSubscription
}

// Keyed by `${kbId}:raw` and `${kbId}:linked:${linkId}`.
const handles = new Map<string, WatchHandle>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DEBOUNCE_MS = 500

/** Re-scan a KB for changed files and process them (debounced per KB). */
function scheduleScan(kbId: string): void {
  const existing = debounceTimers.get(kbId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounceTimers.delete(kbId)
    const kb = getKB(kbId)
    if (!kb || kb.status !== 'active') return
    const candidates = collectIngestCandidates(kbId)
    if (candidates.length === 0) return
    enqueueFiles(kbId, candidates)
    processQueue(kbId).catch(err =>
      console.error(`[Tlon] processQueue failed for ${kbId}:`, err)
    )
  }, DEBOUNCE_MS)
  timer.unref?.()
  debounceTimers.set(kbId, timer)
}

async function subscribe(key: string, dir: string, kbId: string): Promise<void> {
  if (handles.has(key)) return
  if (!existsSync(dir)) {
    console.warn(`[Tlon] Watch path missing, skipping: ${dir}`)
    return
  }
  try {
    const subscription = await parcelWatcher.subscribe(dir, (err) => {
      if (err) {
        console.error(`[Tlon] Watcher error for ${key}:`, err)
        return
      }
      scheduleScan(kbId)
    })
    handles.set(key, { key, subscription })
    console.log(`[Tlon] Watching ${key}: ${dir}`)
  } catch (error) {
    console.error(`[Tlon] Failed to watch ${dir}:`, error)
  }
}

async function unsubscribe(key: string): Promise<void> {
  const handle = handles.get(key)
  if (!handle) return
  try {
    await handle.subscription.unsubscribe()
  } catch (error) {
    console.error(`[Tlon] Failed to unsubscribe ${key}:`, error)
  }
  handles.delete(key)
}

// ============================================================================
// Per-KB control (used by service.ts)
// ============================================================================

export async function startWatchersForKB(kbId: string): Promise<void> {
  const kb = getKB(kbId)
  if (!kb || kb.status !== 'active') return
  await subscribe(`${kbId}:raw`, getKBRawDir(kbId), kbId)
  for (const linked of kb.linkedDirs) {
    await startLinkedDirWatch(kbId, linked)
  }
}

export async function stopWatchersForKB(kbId: string): Promise<void> {
  const keys = Array.from(handles.keys()).filter(
    k => k === `${kbId}:raw` || k.startsWith(`${kbId}:linked:`)
  )
  for (const key of keys) {
    await unsubscribe(key)
  }
  const timer = debounceTimers.get(kbId)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(kbId)
  }
}

export async function startLinkedDirWatch(kbId: string, linked: LinkedDirectory): Promise<void> {
  await subscribe(`${kbId}:linked:${linked.id}`, linked.path, kbId)
  // Initial scan of the newly-linked directory.
  scheduleScan(kbId)
}

export async function stopLinkedDirWatch(kbId: string, linked: LinkedDirectory): Promise<void> {
  await unsubscribe(`${kbId}:linked:${linked.id}`)
}

// ============================================================================
// Lifecycle (used by bootstrap)
// ============================================================================

export async function initTlonWatchers(): Promise<void> {
  const kbs = listKBs().filter(kb => kb.status === 'active')
  console.log(`[Tlon] Initializing watchers for ${kbs.length} active KB(s)`)
  for (const kb of kbs) {
    // Refresh each KB's index into the current (synopsis-rich) format without
    // re-ingesting, so existing KBs benefit immediately.
    try {
      rebuildIndexMd(kb.id)
    } catch (error) {
      console.error(`[Tlon] index rebuild failed for ${kb.id}:`, error)
    }
    await startWatchersForKB(kb.id)
  }
}

export async function shutdownTlon(): Promise<void> {
  for (const key of Array.from(handles.keys())) {
    await unsubscribe(key)
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  console.log('[Tlon] Watchers shut down')
}
