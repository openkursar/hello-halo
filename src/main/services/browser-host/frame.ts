import type { WebContents } from 'electron'
import { browserHostManager } from './manager'

const FRAME_PREPARATION_TIMEOUT_MS = 5000
const RELEASE_CLEANUP_TIMEOUT_MS = 500

interface FrameLease {
  count: number
  throttling: boolean
  controller: AbortController
  ready: Promise<() => void>
  failed: boolean
  release?: () => void
}

export interface BrowserFrameOptions {
  signal?: AbortSignal
  /** Absolute Date.now() deadline, including frame preparation. */
  deadline?: number
  /** Releases only this operation's pressed input, while frames remain lent; limited to 500 ms. */
  beforeRelease?: () => Promise<void>
}

const frameLeases = new WeakMap<WebContents, FrameLease>()

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Browser operation was cancelled')
}

/** A failed preparation is retried by the next caller instead of being handed to it. */
function prepareLease(contents: WebContents, lease: FrameLease): void {
  const attempt = browserHostManager.prepareFrames(contents, FRAME_PREPARATION_TIMEOUT_MS, lease.controller.signal)
    .then(release => {
      lease.release = release
      return release
    })
  lease.ready = attempt
  lease.failed = false
  attempt.catch(() => {
    if (lease.ready === attempt) lease.failed = true
  })
}

async function finishPressedInput(contents: WebContents, beforeRelease: () => Promise<void>): Promise<void> {
  if (contents.isDestroyed()) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.resolve().then(beforeRelease),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Browser input cleanup timed out')), RELEASE_CLEANUP_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    console.warn('[BrowserFrame] Failed to release pressed input', { contentsId: contents.id }, error)
  } finally {
    clearTimeout(timer)
  }
}

/** Lends frames to a bounded page operation and restores the original background policy. */
export async function withBrowserFrames<T>(
  contents: WebContents,
  operation: () => Promise<T>,
  preparationTimeoutMs = FRAME_PREPARATION_TIMEOUT_MS,
  options: BrowserFrameOptions = {}
): Promise<T> {
  const assertActive = () => {
    if (options.signal?.aborted) throw abortError(options.signal)
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw new Error('Browser operation timed out')
    if (contents.isDestroyed()) throw new Error('Browser page closed during operation')
  }
  assertActive()
  let lease = frameLeases.get(contents)
  if (!lease) {
    lease = {
      count: 0,
      throttling: contents.getBackgroundThrottling(),
      controller: new AbortController(),
      ready: Promise.resolve(() => {}),
      failed: false,
    }
    if (lease.throttling) contents.setBackgroundThrottling(false)
    frameLeases.set(contents, lease)
    prepareLease(contents, lease)
  } else if (lease.failed) {
    prepareLease(contents, lease)
  }
  lease.count++

  let deadlineTimer: NodeJS.Timeout | undefined
  let preparationTimer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  let onDestroyed: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    onDestroyed = () => reject(new Error('Browser page closed during operation'))
    contents.once('destroyed', onDestroyed)
    if (options.signal) {
      const signal = options.signal
      onAbort = () => reject(abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
    if (options.deadline !== undefined) {
      deadlineTimer = setTimeout(() => reject(new Error('Browser operation timed out')), Math.max(1, options.deadline - Date.now()))
    }
    preparationTimer = setTimeout(() => reject(new Error('Browser frame preparation timed out')), Math.max(1, preparationTimeoutMs))
  })
  try {
    await Promise.race([lease.ready, interrupted])
    clearTimeout(preparationTimer)
    assertActive()
    return await Promise.race([Promise.resolve().then(() => {
      assertActive()
      return operation()
    }), interrupted])
  } finally {
    clearTimeout(preparationTimer)
    clearTimeout(deadlineTimer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
    if (onDestroyed) contents.removeListener('destroyed', onDestroyed)
    if (options.beforeRelease) await finishPressedInput(contents, options.beforeRelease)
    if (--lease.count === 0) {
      frameLeases.delete(contents)
      // Cancelling preparation releases the host even before its first readiness ack.
      lease.controller.abort(new Error('Browser frame lease released'))
      lease.release?.()
      if (!contents.isDestroyed() && lease.throttling) {
        try {
          contents.setBackgroundThrottling(true)
        } catch (error) {
          console.warn('[BrowserFrame] Failed to restore page throttling', { contentsId: contents.id }, error)
        }
      }
    }
  }
}
