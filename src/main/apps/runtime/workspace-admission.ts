const changes = new Map<string, { done: Promise<void>; release: () => void }>()
const released = new Set<(appId: string) => void>()
let recovery: Promise<void> | undefined
let initialization: Promise<void> | undefined

/** Full service readiness is for explicit workspace operations, never chat admission. */
export function pendingWorkspaceInitialization(): Promise<void> | undefined {
  return initialization
}

export function setWorkspaceInitialization(pending: Promise<void>): () => void {
  initialization = pending
  return () => { if (initialization === pending) initialization = undefined }
}

/** Data repair only, independent of engine, IM and runtime readiness. */
export function pendingWorkspaceRecovery(): Promise<void> | undefined {
  return recovery
}

export function setWorkspaceRecovery(pending: Promise<void>): () => void {
  recovery = pending
  return () => { if (recovery === pending) recovery = undefined }
}

/** Bootstrap installs this before publishing the manager; only data repair completes it. */
export function beginWorkspaceRecovery(): {
  ready: Promise<void>
  complete(): void
  fail(error: unknown): void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const ready = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  void ready.catch(() => {})
  const clear = setWorkspaceRecovery(ready)
  let settled = false
  return {
    ready,
    complete() {
      if (settled) return
      settled = true
      clear()
      resolve()
    },
    fail(error) {
      if (settled) return
      settled = true
      console.error('[WorkspaceAdmission] Startup data repair failed; app workspace writes remain blocked', error)
      reject(error)
    },
  }
}

/** Absent on ordinary work; a move alone holds admission until its records and files agree. */
export function pendingWorkspaceChange(appId: string): Promise<void> | undefined {
  return changes.get(appId)?.done
}

export function onWorkspaceChangeReleased(listener: (appId: string) => void): () => void {
  released.add(listener)
  return () => { released.delete(listener) }
}

/** A deadline fails the move rather than treating an unfinished writer as drained. */
export async function awaitWorkspaceDrain(appId: string, kind: string, work: Promise<unknown>, timeoutMs = 30_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        console.error('[WorkspaceAdmission] Work did not drain before relocation', { appId, kind, timeoutMs })
        reject(new Error(`The digital human's ${kind} did not finish stopping. Its workspace was not moved.`))
      }, timeoutMs)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Takes every app together, so overlapping moves cannot hold each other partially. */
export async function acquireAppWorkspaceChange(appIds: Iterable<string>): Promise<() => void> {
  const ids = [...new Set(appIds)]
  for (;;) {
    const blockers = ids.flatMap(id => changes.has(id) ? [changes.get(id)!.done] : [])
    if (blockers.length === 0) break
    await Promise.all(blockers)
  }
  let release!: () => void
  const done = new Promise<void>(resolve => { release = resolve })
  const held = { done, release }
  for (const id of ids) changes.set(id, held)
  let finished = false
  return () => {
    if (finished) return
    finished = true
    for (const id of ids) if (changes.get(id) === held) changes.delete(id)
    release()
    for (const appId of ids) for (const listener of released) {
      try { listener(appId) }
      catch (error) { console.error('[WorkspaceAdmission] Could not resume workspace work', { appId, error }) }
    }
  }
}

export async function withWorkspaceChange<T>(appId: string, change: () => Promise<T>): Promise<T> {
  const release = await acquireAppWorkspaceChange([appId])
  try { return await change() }
  finally { release() }
}
