import { hasSpace } from '../space.service'
import type { V2SDKSession } from './types'

const DRAIN_TIMEOUT_MS = 10_000

interface SpaceOperation {
  conversationId: string
  controller: AbortController
  done: Promise<void>
}

interface MaintenanceState {
  released: Promise<void>
  resume(): void
  operations: SpaceOperation[]
  cleanups: Promise<void>[]
}

const operations = new Map<string, Set<SpaceOperation>>()
const maintenance = new Map<string, MaintenanceState>()
const operationSignals = new WeakMap<AbortSignal, string>()
const incompleteCleanups = new Map<string, Set<() => Promise<void>>>()

export function isSpaceUnderMaintenance(spaceId: string): boolean {
  return maintenance.has(spaceId)
}

export function assertSpaceAvailable(spaceId: string): void {
  if (spaceId !== 'halo-temp' && !hasSpace(spaceId)) {
    throw new Error('This workspace was deleted. Choose another workspace or start a new conversation there.')
  }
}

export function assertSpaceOperationCurrent(signal: AbortSignal): void {
  signal.throwIfAborted()
}

export function getSpaceOperationConversationIds(spaceId: string): Set<string> {
  return new Set([...(operations.get(spaceId) ?? [])].map(operation => operation.conversationId))
}

export function hasSpaceOperations(spaceId: string): boolean {
  return operations.has(spaceId)
}

async function waitForRelease(released: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return released
  signal.throwIfAborted()
  let abort!: () => void
  try {
    await Promise.race([
      released,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function maintenanceError(): Error {
  return Object.assign(new Error('Workspace maintenance stopped this work. Send it again after maintenance finishes.'), { name: 'AbortError' })
}

/** Tracks the whole attempt, including asynchronous preparation and its finally cleanup. */
export async function runSpaceOperation<T>(
  spaceId: string,
  conversationId: string,
  run: (signal: AbortSignal) => Promise<T>,
  inheritedSignal?: AbortSignal,
): Promise<T> {
  if (inheritedSignal) {
    inheritedSignal.throwIfAborted()
    if (operationSignals.get(inheritedSignal) === spaceId) return run(inheritedSignal)
  }
  while (maintenance.has(spaceId)) {
    await waitForRelease(maintenance.get(spaceId)!.released, inheritedSignal)
  }
  inheritedSignal?.throwIfAborted()
  assertSpaceAvailable(spaceId)
  const controller = new AbortController()
  operationSignals.set(controller.signal, spaceId)
  const abort = () => controller.abort(inheritedSignal?.reason)
  inheritedSignal?.addEventListener('abort', abort, { once: true })
  let finish!: () => void
  const operation: SpaceOperation = {
    conversationId, controller, done: new Promise(resolve => { finish = resolve }),
  }
  const pending = operations.get(spaceId) ?? new Set<SpaceOperation>()
  pending.add(operation)
  operations.set(spaceId, pending)
  try {
    return await run(controller.signal)
  } finally {
    inheritedSignal?.removeEventListener('abort', abort)
    operationSignals.delete(controller.signal)
    pending.delete(operation)
    if (pending.size === 0 && operations.get(spaceId) === pending) operations.delete(spaceId)
    finish()
  }
}

export function beginSpaceOperationMaintenance(spaceId: string): {
  state: MaintenanceState
  conversationIds: Set<string>
  release(): void
} {
  if (maintenance.has(spaceId)) throw new Error('This workspace is already undergoing maintenance. Try again when it finishes.')
  let resume!: () => void
  const state: MaintenanceState = {
    released: new Promise(resolve => { resume = resolve }),
    resume: () => resume(),
    operations: [...(operations.get(spaceId) ?? [])], cleanups: [],
  }
  maintenance.set(spaceId, state)
  for (const cleanup of incompleteCleanups.get(spaceId) ?? []) startCleanup(spaceId, state, cleanup)
  for (const operation of state.operations) operation.controller.abort(maintenanceError())
  return {
    state,
    conversationIds: new Set(state.operations.map(operation => operation.conversationId)),
    release() {
      if (maintenance.get(spaceId) !== state) return
      maintenance.delete(spaceId)
      state.resume()
    },
  }
}

export function recordMaintenanceCleanup(spaceId: string, cleanup: () => Promise<void>, retain = false): boolean {
  const state = maintenance.get(spaceId)
  if (!state && !retain) return false
  retainSpaceCleanup(spaceId, cleanup)
  if (state) startCleanup(spaceId, state, cleanup)
  return true
}

export function retainSpaceCleanup(spaceId: string, cleanup: () => Promise<void>): () => void {
  const pending = incompleteCleanups.get(spaceId) ?? new Set<() => Promise<void>>()
  pending.add(cleanup)
  incompleteCleanups.set(spaceId, pending)
  return () => {
    pending.delete(cleanup)
    if (pending.size === 0 && incompleteCleanups.get(spaceId) === pending) incompleteCleanups.delete(spaceId)
  }
}

function startCleanup(spaceId: string, state: MaintenanceState, cleanup: () => Promise<void>): void {
  const promise = (async () => { await cleanup() })().then(() => {
    const pending = incompleteCleanups.get(spaceId)
    pending?.delete(cleanup)
    if (pending?.size === 0) incompleteCleanups.delete(spaceId)
  })
  // Failed cleanup remains retryable; releasing a failed maintenance never forgets its writer.
  void promise.catch(() => {})
  state.cleanups.push(promise)
}

export async function withDrainTimeout<T>(promise: Promise<T>, timeoutMs = DRAIN_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Workspace cleanup has not finished. Its files were preserved; wait for the work to stop and try again.')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** No process signal is sent: the adapter owns termination, and the main PID is never killable. */
export async function waitForSessionCleanup(session: V2SDKSession, pid: number | null | undefined, timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
  await withDrainTimeout(Promise.resolve().then(() => session.flush?.()), timeoutMs)
  if (pid == null || pid === process.pid) return
  const alive = () => {
    try { process.kill(pid, 0); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  const deadline = Date.now() + timeoutMs
  while (alive()) {
    if (Date.now() >= deadline) throw new Error('An engine process is still running. The workspace files were preserved; wait and try again.')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
