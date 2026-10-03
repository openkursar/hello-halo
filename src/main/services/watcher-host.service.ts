/**
 * Watcher Host Service -- manages the file-watcher utility process.
 *
 * Responsibilities:
 * - Fork and manage the utility process lifecycle
 * - Relay messages between main process and worker
 * - Handle crash recovery (auto-restart with pending space re-init)
 * - Provide async request/response API for scan operations
 */

import { fork, type ChildProcess } from 'child_process'
import { join } from 'path'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  ProcessedFsEvent
} from '../../shared/protocol/file-watcher.protocol'
import type { CachedTreeNode } from '../../shared/types/artifact'

// Lazy import to avoid circular dependency (artifact-cache imports from watcher-host)
let reconcileLoadedDirsLazy: ((spaceId: string, reason?: string) => Promise<void>) | null = null
async function getReconcileFn(): Promise<(spaceId: string, reason?: string) => Promise<void>> {
  if (!reconcileLoadedDirsLazy) {
    const mod = await import('./artifact-cache.service')
    reconcileLoadedDirsLazy = mod.reconcileLoadedDirs
  }
  return reconcileLoadedDirsLazy
}

// --- Worker process management ---

let workerProcess: ChildProcess | null = null
let isShuttingDown = false
// Set when a worker died with spaces active; the next fork must re-init them.
let workerCrashed = false
let restartTimer: ReturnType<typeof setTimeout> | null = null

// Watched spaces (spaceId -> rootPath), re-initialized after a worker restart
const activeSpaces = new Map<string, string>()
// Who needs each space watched; the watcher stops when the last holder releases
const spaceHolders = new Map<string, Set<string>>()

// Pending scan requests: requestId -> { resolve, reject, timer }
type WorkerReply = WorkerToMainMessage & { type: 'scan-result' | 'query-result' }
const pendingScans = new Map<string, {
  resolve: (msg: WorkerReply) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

// Callbacks for events from worker
// fsEventsCallbacks supports multiple subscribers (artifact-cache + FileWatcherSource)
type FsEventsCallback = (spaceId: string, events: ProcessedFsEvent[]) => void
const onFsEventsCallbacks = new Set<FsEventsCallback>()
// Subset that only wants stat-resolved events (state derived per node, e.g. the tree cache).
const resolvedOnlyCallbacks = new Set<FsEventsCallback>()
const onFsEventsLostCallbacks = new Set<(spaceId: string) => void>()
let onSpaceReadyCallback: ((spaceId: string) => void) | null = null
let onSpaceErrorCallback: ((spaceId: string, error: string) => void) | null = null

const SCAN_TIMEOUT_MS = 30000

export const RESTART_BASE_DELAY_MS = 1000
export const RESTART_MAX_DELAY_MS = 30_000
export const MAX_RESTARTS_IN_WINDOW = 5
export const RESTART_WINDOW_MS = 5 * 60_000

/**
 * Crash-restart pacing. A worker that dies on the same input every time it is
 * replayed would otherwise restart forever: delays double per crash, and past
 * the cap automatic restarts stop until a caller needs the worker again.
 */
export class RestartBackoff {
  private crashes: number[] = []

  /** Delay before the next automatic restart, or null once the cap is reached. */
  nextDelay(now: number): number | null {
    this.crashes = this.crashes.filter(t => now - t < RESTART_WINDOW_MS)
    this.crashes.push(now)
    if (this.crashes.length > MAX_RESTARTS_IN_WINDOW) return null
    return Math.min(RESTART_BASE_DELAY_MS * 2 ** (this.crashes.length - 1), RESTART_MAX_DELAY_MS)
  }
}

const restartBackoff = new RestartBackoff()

/**
 * Get worker entry file path.
 * Development: out/worker/file-watcher/index.cjs
 * Production: out/worker/file-watcher/index.cjs (inside app.asar)
 */
function getWorkerEntryPath(): string {
  // electron-vite puts worker output under out/main/worker/file-watcher/index.cjs
  // __dirname at runtime is out/main/, so the relative path is ./worker/...
  return join(__dirname, 'worker/file-watcher/index.cjs')
}

/**
 * Fork the file-watcher worker process using child_process.fork().
 */
function forkWorker(): ChildProcess {
  const workerPath = getWorkerEntryPath()
  console.log(`[WatcherHost] Forking worker: ${workerPath}`)

  const child = fork(workerPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env },
  })

  // Handle messages from worker
  child.on('message', (msg: WorkerToMainMessage) => {
    handleWorkerMessage(msg)
  })

  // Pipe worker stdout/stderr to main process log
  child.stdout?.on('data', (data: Buffer) => {
    console.log(`[WatcherWorker] ${data.toString().trim()}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    console.error(`[WatcherWorker] ${data.toString().trim()}`)
  })

  // Handle worker exit
  child.on('exit', (code, signal) => {
    console.warn(`[WatcherHost] Worker exited: code=${code}, signal=${signal}`)
    if (workerProcess === child) workerProcess = null

    // Reject all pending scans
    for (const [requestId, pending] of Array.from(pendingScans.entries())) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`Worker exited unexpectedly (code=${code})`))
      pendingScans.delete(requestId)
    }

    if (isShuttingDown || code === 0) return
    workerCrashed = true
    if (activeSpaces.size === 0) return

    const delay = restartBackoff.nextDelay(Date.now())
    if (delay === null) {
      console.error(
        `[WatcherHost] Worker crashed ${MAX_RESTARTS_IN_WINDOW + 1} times within ${RESTART_WINDOW_MS / 1000}s; ` +
        `automatic restarts stopped until the next file request (${activeSpaces.size} spaces unwatched)`
      )
      return
    }
    console.log(`[WatcherHost] Auto-restarting worker in ${delay}ms...`)
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!isShuttingDown) ensureWorker()
    }, delay)
  })

  child.on('error', (error) => {
    console.error('[WatcherHost] Worker error:', error)
  })

  return child
}

/**
 * Re-initialize all active spaces on a freshly forked worker and reconcile
 * them to recover events missed while no worker was running.
 */
function reinitActiveSpaces(worker: ChildProcess): void {
  for (const [spaceId, rootPath] of Array.from(activeSpaces.entries())) {
    console.log(`[WatcherHost] Re-initializing space after restart: ${spaceId}`)
    worker.send({ type: 'init-space', spaceId, rootPath } satisfies MainToWorkerMessage)
    notifyEventsLost(spaceId)
  }
  getReconcileFn().then(async (reconcile) => {
    for (const [spaceId] of activeSpaces) {
      try {
        await reconcile(spaceId, 'worker-restart')
      } catch (err) {
        console.error(`[WatcherHost] Post-crash reconciliation failed for ${spaceId}:`, err)
      }
    }
  }).catch(err => {
    console.error('[WatcherHost] Failed to load reconcile function:', err)
  })
}

function ensureWorker(): ChildProcess {
  if (!workerProcess) {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    workerProcess = forkWorker()
    if (workerCrashed) {
      workerCrashed = false
      reinitActiveSpaces(workerProcess)
    }
  }
  return workerProcess
}

function sendToWorker(msg: MainToWorkerMessage): void {
  const worker = ensureWorker()
  worker.send(msg)
}

// --- Worker message handler ---

function notifyEventsLost(spaceId: string): void {
  for (const cb of Array.from(onFsEventsLostCallbacks)) {
    try { cb(spaceId) } catch (err) {
      console.error('[WatcherHost] events-lost callback error:', err)
    }
  }
}

function handleWorkerMessage(msg: WorkerToMainMessage): void {
  switch (msg.type) {
    case 'space-ready':
      console.log(`[WatcherHost] Space ready: ${msg.spaceId}`)
      onSpaceReadyCallback?.(msg.spaceId)
      break

    case 'space-error':
      console.error(`[WatcherHost] Space error: ${msg.spaceId} - ${msg.error}`)
      onSpaceErrorCallback?.(msg.spaceId, msg.error)
      break

    case 'scan-result':
    case 'query-result': {
      const pending = pendingScans.get(msg.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        pending.resolve(msg)
        pendingScans.delete(msg.requestId)
      }
      break
    }

    case 'scan-error': {
      const pending = pendingScans.get(msg.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(msg.error))
        pendingScans.delete(msg.requestId)
      }
      break
    }

    case 'fs-events':
      for (const cb of Array.from(onFsEventsCallbacks)) {
        if (msg.resolved === false && resolvedOnlyCallbacks.has(cb)) continue
        try { cb(msg.spaceId, msg.events) } catch (err) {
          console.error('[WatcherHost] fs-events callback error:', err)
        }
      }
      break

    case 'fs-overflow':
      console.warn(
        `[WatcherHost] ${msg.overflowedEvents} fs events for ${msg.spaceId} over the burst limit: ` +
        `delivered unresolved, ${msg.droppedEvents} dropped past the memory ceiling; resyncing by rescan`
      )
      notifyEventsLost(msg.spaceId)
      getReconcileFn().then(fn => fn(msg.spaceId, 'event-overflow')).catch(err => {
        console.error('[WatcherHost] Post-overflow reconciliation failed:', err)
      })
      break

    case 'watcher-error':
      console.warn(`[WatcherHost] Watcher error for ${msg.spaceId}: ${msg.error}. Triggering reconciliation.`)
      notifyEventsLost(msg.spaceId)
      // Reconcile the affected space to recover from missed events
      getReconcileFn().then(fn => fn(msg.spaceId, 'watcher-error')).catch(err => {
        console.error('[WatcherHost] Post-error reconciliation failed:', err)
      })
      break

    case 'log':
      if (msg.level === 'error') {
        console.error(`[WatcherWorker] ${msg.message}`)
      } else if (msg.level === 'warn') {
        console.warn(`[WatcherWorker] ${msg.message}`)
      } else {
        console.log(`[WatcherWorker] ${msg.message}`)
      }
      break
  }
}

// --- Public API ---

let scanIdCounter = 0
function nextScanId(): string {
  return `scan-${++scanIdCounter}-${Date.now()}`
}

/**
 * Keep a space's recursive watcher running on behalf of `holder`.
 *
 * Watchers are reference-counted: every consumer that needs a space's file
 * events (the artifact tree cache, automation file triggers, ...) retains it
 * under its own holder key and releases it when done. The first retain starts
 * the watcher; the last release stops it. Idempotent per holder.
 */
export function retainSpaceWatcher(spaceId: string, rootPath: string, holder: string): void {
  let holders = spaceHolders.get(spaceId)
  if (!holders) {
    holders = new Set()
    spaceHolders.set(spaceId, holders)
  }
  holders.add(holder)

  const watchedRoot = activeSpaces.get(spaceId)
  if (watchedRoot !== undefined) {
    if (watchedRoot !== rootPath) {
      console.warn(`[WatcherHost] ${holder} retained ${spaceId} at ${rootPath}; already watched at ${watchedRoot}`)
    }
    return
  }
  activeSpaces.set(spaceId, rootPath)
  sendToWorker({ type: 'init-space', spaceId, rootPath })
}

/** Drop `holder`'s claim on a space; stops the watcher when no holder is left. */
export function releaseSpaceWatcher(spaceId: string, holder: string): void {
  const holders = spaceHolders.get(spaceId)
  if (!holders?.delete(holder) || holders.size > 0) return
  spaceHolders.delete(spaceId)
  activeSpaces.delete(spaceId)
  // No worker means nothing is watching; do not fork one just to stop it.
  workerProcess?.send({ type: 'destroy-space', spaceId } satisfies MainToWorkerMessage)
  console.log(`[WatcherHost] Stopped watching ${spaceId} (last holder ${holder} released)`)
}

/** Holders currently keeping each watched space alive (diagnostics). */
export function getWatchedSpaces(): Array<{ spaceId: string; rootPath: string; holders: string[] }> {
  return Array.from(activeSpaces, ([spaceId, rootPath]) => ({
    spaceId,
    rootPath,
    holders: Array.from(spaceHolders.get(spaceId) ?? []),
  }))
}

function requestFromWorker(
  build: (requestId: string) => MainToWorkerMessage,
  describe: string
): Promise<WorkerReply> {
  const requestId = nextScanId()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingScans.delete(requestId)
      reject(new Error(`Worker request timeout: ${describe}`))
    }, SCAN_TIMEOUT_MS)
    pendingScans.set(requestId, { resolve, reject, timer })
    sendToWorker(build(requestId))
  })
}

/**
 * Scan directory for tree nodes (async request/response via worker)
 */
export async function scanTreeViaWorker(
  spaceId: string,
  dirPath: string,
  rootPath: string,
  depth: number
): Promise<CachedTreeNode[]> {
  const reply = await requestFromWorker(
    requestId => ({ type: 'scan-dir', requestId, spaceId, dirPath, rootPath, depth }),
    dirPath
  )
  return reply.type === 'scan-result' ? reply.nodes : []
}

export type WorkerPathQueryResult = NonNullable<(WorkerToMainMessage & { type: 'query-result' })['result']>

/**
 * Best path matches from the worker's index of a watched space; null when the
 * space is not watched.
 */
export async function queryFilesViaWorker(
  spaceId: string,
  query: string,
  limit: number,
  maxDepth?: number
): Promise<WorkerPathQueryResult | null> {
  const reply = await requestFromWorker(
    requestId => ({ type: 'query-files', requestId, spaceId, query, limit, maxDepth }),
    `query ${spaceId}`
  )
  return reply.type === 'query-result' ? reply.result : null
}

/**
 * Reload .gitignore rules for a space
 */
export function refreshIgnoreRules(spaceId: string, rootPath: string): void {
  sendToWorker({ type: 'refresh-ignore', spaceId, rootPath })
}

/**
 * Register a handler for file system events from worker.
 * Multiple handlers are supported simultaneously (artifact-cache + FileWatcherSource).
 * Returns an unsubscribe function that removes this specific handler.
 */
export function addFsEventsHandler(
  cb: FsEventsCallback,
  options?: {
    /**
     * Skip events delivered unresolved from an overflow burst (no stat, no
     * tree node). Such a handler must resync from `addFsEventsLostHandler`.
     */
    resolvedOnly?: boolean
  }
): () => void {
  onFsEventsCallbacks.add(cb)
  if (options?.resolvedOnly) resolvedOnlyCallbacks.add(cb)
  return () => {
    onFsEventsCallbacks.delete(cb)
    resolvedOnlyCallbacks.delete(cb)
  }
}

/**
 * Register a handler for "events for this space were lost" — a burst over the
 * delivery limit, a watcher failure, or a worker restart — so anything derived
 * from individual events is stale. The host itself reconciles loaded tree
 * directories; this is for other derived state.
 */
export function addFsEventsLostHandler(cb: (spaceId: string) => void): () => void {
  onFsEventsLostCallbacks.add(cb)
  return () => { onFsEventsLostCallbacks.delete(cb) }
}

/**
 * @deprecated Use addFsEventsHandler() for multi-subscriber support.
 * Kept for backward compatibility; adds to the handler set (does not replace).
 */
export function setFsEventsHandler(
  cb: (spaceId: string, events: ProcessedFsEvent[]) => void
): void {
  onFsEventsCallbacks.add(cb)
}

/**
 * Set the handler for space ready events.
 * Only one handler is supported; calling again overwrites the previous one.
 */
export function setSpaceReadyHandler(cb: (spaceId: string) => void): void {
  if (onSpaceReadyCallback) {
    console.warn('[WatcherHost] Overwriting existing SpaceReady handler')
  }
  onSpaceReadyCallback = cb
}

/**
 * Set the handler for space error events.
 * Only one handler is supported; calling again overwrites the previous one.
 */
export function setSpaceErrorHandler(cb: (spaceId: string, error: string) => void): void {
  if (onSpaceErrorCallback) {
    console.warn('[WatcherHost] Overwriting existing SpaceError handler')
  }
  onSpaceErrorCallback = cb
}

/**
 * Shutdown the worker process gracefully
 */
export async function shutdown(): Promise<void> {
  isShuttingDown = true
  activeSpaces.clear()
  spaceHolders.clear()
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }

  // Reject all pending scans
  for (const [requestId, pending] of Array.from(pendingScans.entries())) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Worker shutting down'))
    pendingScans.delete(requestId)
  }

  if (workerProcess) {
    console.log('[WatcherHost] Shutting down worker...')

    workerProcess.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (workerProcess) {
          console.warn('[WatcherHost] Force killing worker after timeout')
          workerProcess.kill('SIGKILL')
        }
        resolve()
      }, 3000)

      workerProcess!.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    workerProcess = null
  }
}
