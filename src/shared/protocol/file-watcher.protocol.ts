/**
 * File Watcher Worker Protocol
 *
 * Defines messages between main process and file-watcher utility process.
 * Communication uses process.send() / process.on('message') (child_process)
 * or postMessage / on('message') (Electron utilityProcess).
 *
 * MUST NOT import any Node.js or Electron modules.
 */

import type { CachedTreeNode, CachedArtifact, ArtifactChangeEvent } from '../types/artifact'

// --- Main -> Worker ---

export type MainToWorkerMessage =
  | {
      type: 'init-space'
      spaceId: string
      rootPath: string
    }
  | {
      type: 'destroy-space'
      spaceId: string
    }
  | {
      type: 'scan-dir'
      requestId: string
      spaceId: string
      dirPath: string
      rootPath: string
      depth: number
    }
  | {
      type: 'query-files'
      requestId: string
      spaceId: string
      query: string
      limit: number
      /** Only paths at most this many segments deep. */
      maxDepth?: number
    }
  | {
      type: 'refresh-ignore'
      spaceId: string
      rootPath: string
    }

// --- Worker -> Main ---

export type WorkerToMainMessage =
  | {
      type: 'space-ready'
      spaceId: string
    }
  | {
      type: 'space-error'
      spaceId: string
      error: string
    }
  | {
      type: 'scan-result'
      requestId: string
      spaceId: string
      dirPath: string
      nodes: CachedTreeNode[]
    }
  | {
      type: 'query-result'
      requestId: string
      spaceId: string
      /** Null when the space is not watched (so it has no index). */
      result: { items: Array<{ relativePath: string; isFolder: boolean }>; truncated: boolean; indexing: boolean; hasPaths: boolean; rootPath: string } | null
    }
  | {
      type: 'scan-error'
      requestId: string
      spaceId: string
      error: string
    }
  | {
      type: 'fs-events'
      spaceId: string
      events: ProcessedFsEvent[]
      /**
       * False for events from an overflow window: not stat'ed, type taken from
       * the OS event (a new directory reads as 'add'), no artifact / tree node.
       */
      resolved?: boolean
    }
  | {
      type: 'watcher-error'
      spaceId: string
      error: string
    }
  | {
      /**
       * Too many events arrived in one window to resolve individually. They
       * follow as unresolved `fs-events`; derived state (tree, caches) must be
       * resynced by rescanning. `droppedEvents` past the memory ceiling were
       * only counted.
       */
      type: 'fs-overflow'
      spaceId: string
      overflowedEvents: number
      droppedEvents: number
    }
  | {
      type: 'log'
      level: 'info' | 'warn' | 'error'
      message: string
    }

/**
 * Processed file system event from the worker.
 * Compared to raw @parcel/watcher events:
 * - Filtered by .gitignore / hidden patterns
 * - fs.stat applied to determine file/folder type
 * - Event coalescing applied (last-write-wins per path)
 * - Includes full CachedArtifact / CachedTreeNode data
 */
export interface ProcessedFsEvent {
  changeType: ArtifactChangeEvent['type']
  filePath: string
  relativePath: string
  artifact?: CachedArtifact
  treeNode?: CachedTreeNode
  parentDir: string
}
