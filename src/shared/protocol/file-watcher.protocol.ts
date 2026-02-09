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
      mode: 'tree' | 'flat'
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
      nodes?: CachedTreeNode[]
      artifacts?: CachedArtifact[]
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
