/**
 * Path Index -- runs inside file-watcher utility process.
 *
 * Every path in a watched space (under the watcher's ignore rules), built in
 * the background and kept current from watcher events, so a file query
 * (the @ menu) is answered here and only the top matches cross to the
 * renderer. Replaces shipping the whole recursive listing on every change.
 *
 * HARD CONSTRAINT: This file MUST NOT import anything from 'electron'.
 */

import { promises as fs } from 'fs'
import { join, sep } from 'path'
import type { Ignore } from 'ignore'
import { isIgnored, shouldHide } from './scanner'
import { normalizePathLike, rankPaths, type RankablePath } from '../../shared/file-path-match'

/** Entries kept per space; past it the index is marked truncated (breadth-first, so shallow paths win). */
export const MAX_INDEX_ENTRIES = 200_000
/**
 * Past this size a folder deletion stops pruning descendants key-by-key (an
 * O(all entries) scan per deleted folder — a branch switch deletes hundreds of
 * folders) and schedules the debounced background rebuild instead; queries
 * report `indexing` until it lands. Below it the prune stays exact.
 */
const FOLDER_REMOVE_SCAN_MAX_ENTRIES = 20_000
/** Entries walked between yields to the event loop, so queries and events stay responsive. */
const ENTRIES_PER_SLICE = 2000
/** Directory reads kept in flight while walking. */
const READS_IN_FLIGHT = 8
/** Coalesces rebuild requests from a burst of overflow windows / rule changes. */
const REBUILD_DELAY_MS = 1000

export interface PathQueryResult {
  items: Array<{ relativePath: string; isFolder: boolean }>
  /** The index hit MAX_INDEX_ENTRIES; paths beyond it are not searchable. */
  truncated: boolean
  /** Still building; results may be missing paths not walked yet. */
  indexing: boolean
  /** The index holds at least one path, whether or not any matched. */
  hasPaths: boolean
}

function depthOf(relativePath: string): number {
  let depth = 1
  for (let i = 0; i < relativePath.length; i++) {
    const ch = relativePath[i]
    if (ch === '/' || ch === '\\') depth++
  }
  return depth
}

export class PathIndex {
  private readonly entries = new Map<string, RankablePath>()
  private generation = 0
  private activeWalks = 0
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null
  private truncated = false

  constructor(
    private readonly rootPath: string,
    private readonly getIgnore: () => Ignore,
    private readonly maxEntries: number = MAX_INDEX_ENTRIES
  ) {}

  get size(): number {
    return this.entries.size
  }

  get indexing(): boolean {
    return this.activeWalks > 0 || this.rebuildTimer !== null
  }

  /** Discard everything and walk the whole space again. */
  rebuild(): Promise<void> {
    this.cancelScheduledRebuild()
    this.generation++
    this.entries.clear()
    this.truncated = false
    return this.walk('', this.generation)
  }

  /** Rebuild soon, once, however many times this is called meanwhile. */
  scheduleRebuild(): void {
    if (this.rebuildTimer) return
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      void this.rebuild()
    }, REBUILD_DELAY_MS)
  }

  /** A path appeared. A new directory's contents are walked in the background. */
  add(relativePath: string, isFolder: boolean): void {
    if (!relativePath || this.entries.has(relativePath)) return
    if (!this.insert(relativePath, isFolder)) return
    if (isFolder) void this.walk(relativePath, this.generation)
  }

  /** A path disappeared; a directory takes its indexed descendants with it. */
  remove(relativePath: string): void {
    const entry = this.entries.get(relativePath)
    if (!entry) return
    this.entries.delete(relativePath)
    if (!entry.isFolder) return
    if (this.entries.size > FOLDER_REMOVE_SCAN_MAX_ENTRIES) {
      this.scheduleRebuild()
      return
    }
    const prefixes = [relativePath + '/', relativePath + '\\']
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefixes[0]) || key.startsWith(prefixes[1])) this.entries.delete(key)
    }
  }

  query(query: string, limit: number, maxDepth?: number): PathQueryResult {
    const candidates = maxDepth === undefined
      ? this.entries.values()
      : Array.from(this.entries.values()).filter(e => depthOf(e.relativePath) <= maxDepth)
    return {
      items: rankPaths(candidates, query, limit).map(e => ({ relativePath: e.relativePath, isFolder: e.isFolder })),
      truncated: this.truncated,
      indexing: this.indexing,
      hasPaths: this.entries.size > 0,
    }
  }

  dispose(): void {
    this.cancelScheduledRebuild()
    this.generation++
    this.entries.clear()
  }

  private cancelScheduledRebuild(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer)
      this.rebuildTimer = null
    }
  }

  private insert(relativePath: string, isFolder: boolean): boolean {
    if (this.entries.size >= this.maxEntries) {
      this.truncated = true
      return false
    }
    this.entries.set(relativePath, { relativePath, normalized: normalizePathLike(relativePath), isFolder })
    return true
  }

  /**
   * Breadth-first walk below `startRelative` with a few directory reads in
   * flight, abandoned when the generation moves on.
   */
  private async walk(startRelative: string, generation: number): Promise<void> {
    this.activeWalks++
    const queue: string[] = [startRelative]
    let head = 0
    let sinceYield = 0
    let full = false
    const stale = (): boolean => full || generation !== this.generation

    const readNext = async (): Promise<void> => {
      while (head < queue.length && !stale()) {
        const dirRelative = queue[head++]
        const dirPath = dirRelative ? join(this.rootPath, dirRelative) : this.rootPath
        let entries
        try {
          entries = await fs.readdir(dirPath, { withFileTypes: true })
        } catch {
          continue // Removed or unreadable since it was queued; its own events handle the rest.
        }
        if (stale()) return
        const ig = this.getIgnore()
        for (const entry of entries) {
          if (shouldHide(entry.name)) continue
          const entryRelative = dirRelative ? dirRelative + sep + entry.name : entry.name
          if (isIgnored(ig, entryRelative)) continue
          const isFolder = entry.isDirectory()
          if (!this.entries.has(entryRelative) && !this.insert(entryRelative, isFolder)) {
            full = true
            return
          }
          if (isFolder) queue.push(entryRelative)
        }
        sinceYield += entries.length
        if (sinceYield >= ENTRIES_PER_SLICE) {
          sinceYield = 0
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
    }

    try {
      // Readers drain the shared queue; one that finds it momentarily empty
      // re-checks after the others have had a chance to add directories.
      while (head < queue.length && !stale()) {
        await Promise.all(Array.from({ length: READS_IN_FLIGHT }, readNext))
      }
    } finally {
      this.activeWalks--
    }
  }
}
