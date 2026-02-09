/**
 * File Watcher -- runs inside file-watcher utility process.
 *
 * Responsibilities:
 * - @parcel/watcher subscription management
 * - Event filtering (.gitignore, hidden patterns)
 * - Event coalescing (last-write-wins per path within throttle window)
 * - fs.stat for determining file/folder type
 * - Throttled event emission to main process
 *
 * HARD CONSTRAINT: This file MUST NOT import anything from 'electron'.
 */

import parcelWatcher from '@parcel/watcher'
import type { AsyncSubscription, Event as ParcelEvent } from '@parcel/watcher'
import { join, relative } from 'path'
import type { Ignore } from 'ignore'
import { CPP_LEVEL_IGNORE_DIRS } from '../../shared/constants/ignore-patterns'
import type { ProcessedFsEvent } from '../../shared/protocol/file-watcher.protocol'
import {
  loadIgnoreRules,
  isIgnored,
  shouldHide,
  isDiskRoot,
  createArtifactFromPath,
  createTreeNodeFromArtifact
} from './scanner'

interface SpaceWatcher {
  spaceId: string
  rootPath: string
  subscription: AsyncSubscription | null
  ignoreFilter: Ignore
}

const watchers = new Map<string, SpaceWatcher>()

// --- Event Coalescing ---

// Pending events per space, keyed by path. Last-write-wins within throttle window.
const pendingEvents = new Map<string, Map<string, ProcessedFsEvent>>()
let throttleTimer: ReturnType<typeof setTimeout> | null = null
const THROTTLE_MS = 300

let onEventsCallback: ((spaceId: string, events: ProcessedFsEvent[]) => void) | null = null

export function setOnEventsCallback(cb: (spaceId: string, events: ProcessedFsEvent[]) => void): void {
  onEventsCallback = cb
}

function flushEvents(): void {
  if (pendingEvents.size === 0) return

  for (const [spaceId, eventsMap] of Array.from(pendingEvents.entries())) {
    const events = Array.from(eventsMap.values())
    if (events.length > 0 && onEventsCallback) {
      onEventsCallback(spaceId, events)
    }
  }

  pendingEvents.clear()
}

function queueEvent(spaceId: string, event: ProcessedFsEvent): void {
  if (!pendingEvents.has(spaceId)) {
    pendingEvents.set(spaceId, new Map())
  }
  // Last-write-wins per path (coalescing)
  pendingEvents.get(spaceId)!.set(event.filePath, event)

  if (throttleTimer) clearTimeout(throttleTimer)
  throttleTimer = setTimeout(flushEvents, THROTTLE_MS)
}

// --- Event Processing ---

function getParentPath(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSep > 0 ? filePath.substring(0, lastSep) : filePath
}

async function processParcelEvents(
  sw: SpaceWatcher,
  events: ParcelEvent[]
): Promise<void> {
  // Filter
  const filtered = events.filter(event => {
    const relativePath = relative(sw.rootPath, event.path)
    if (isIgnored(sw.ignoreFilter, relativePath)) return false
    if (shouldHide(event.path)) return false
    return true
  })

  if (filtered.length === 0) return

  // Process each event
  await Promise.all(filtered.map(async (event) => {
    const relativePath = relative(sw.rootPath, event.path)
    const parentDir = getParentPath(event.path)

    if (event.type === 'delete') {
      queueEvent(sw.spaceId, {
        changeType: 'unlink', // Cannot determine file/dir here; main process resolves from cache
        filePath: event.path,
        relativePath,
        parentDir,
      })
      return
    }

    // create / update -> stat to determine file/folder
    const artifact = await createArtifactFromPath(event.path, sw.rootPath, sw.spaceId)
    if (!artifact) return

    const isDir = artifact.type === 'folder'
    const changeType = event.type === 'create'
      ? (isDir ? 'addDir' : 'add')
      : 'change'

    // Calculate depth for tree node
    const relPath = relative(sw.rootPath, event.path)
    const depth = relPath ? relPath.split(/[\\/]/).length - 1 : 0
    const treeNode = createTreeNodeFromArtifact(artifact, depth)

    queueEvent(sw.spaceId, {
      changeType,
      filePath: event.path,
      relativePath,
      artifact,
      treeNode,
      parentDir,
    })
  }))
}

// --- Public API ---

export async function startWatcher(spaceId: string, rootPath: string): Promise<void> {
  // Already watching
  if (watchers.has(spaceId)) return

  if (isDiskRoot(rootPath)) {
    console.warn(`[Watcher] Disk root detected (${rootPath}), skipping`)
    return
  }

  const ignoreFilter = loadIgnoreRules(rootPath)

  const sw: SpaceWatcher = {
    spaceId,
    rootPath,
    subscription: null,
    ignoreFilter,
  }

  try {
    const subscription = await parcelWatcher.subscribe(
      rootPath,
      async (err, events) => {
        if (err) {
          console.error(`[Watcher] Error for ${spaceId}:`, err)
          return
        }
        await processParcelEvents(sw, events)
      },
      {
        ignore: CPP_LEVEL_IGNORE_DIRS.map(dir => join(rootPath, dir))
      }
    )

    sw.subscription = subscription
    watchers.set(spaceId, sw)
    console.log(`[Watcher] Active for space: ${spaceId}`)
  } catch (error) {
    console.error(`[Watcher] Failed to start for ${spaceId}:`, error)
    throw error
  }
}

export async function stopWatcher(spaceId: string): Promise<void> {
  const sw = watchers.get(spaceId)
  if (!sw) return

  if (sw.subscription) {
    try {
      await sw.subscription.unsubscribe()
    } catch (error) {
      console.error(`[Watcher] Error unsubscribing ${spaceId}:`, error)
    }
  }

  watchers.delete(spaceId)
  pendingEvents.delete(spaceId)
  console.log(`[Watcher] Stopped for space: ${spaceId}`)
}

export function refreshIgnoreRules(spaceId: string, rootPath: string): void {
  const sw = watchers.get(spaceId)
  if (sw) {
    sw.ignoreFilter = loadIgnoreRules(rootPath)
    console.log(`[Watcher] Reloaded ignore rules for ${spaceId}`)
  }
}

export async function stopAll(): Promise<void> {
  for (const spaceId of Array.from(watchers.keys())) {
    await stopWatcher(spaceId)
  }
  if (throttleTimer) {
    clearTimeout(throttleTimer)
    flushEvents() // Flush remaining events before exit
  }
}
