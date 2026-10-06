import type { NativeImage, Rectangle, WebContents } from 'electron'
import { withBrowserFrames, type BrowserFrameOptions } from './frame'

/** Presentation and compositor commits are asynchronous even after a guest is loaded. */
export async function captureBrowserPage(contents: WebContents, rect?: Rectangle, timeoutMs = 5000, options: BrowserFrameOptions = {}): Promise<NativeImage> {
  const started = Date.now()
  const deadline = Math.min(started + timeoutMs, options.deadline ?? Infinity)
  return withBrowserFrames(contents,
    () => framesReadyPage(contents, rect, Math.max(1, deadline - Date.now()), options.signal),
    Math.min(5000, timeoutMs), { ...options, deadline })
}

async function framesReadyPage(contents: WebContents, rect: Rectangle | undefined, timeoutMs: number, signal?: AbortSignal): Promise<NativeImage> {
  let cancelled = false
  let deadlineTimer: NodeJS.Timeout | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let finishRetry: (() => void) | undefined
  let onAbort: (() => void) | undefined
  let onDestroyed: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    onDestroyed = () => {
      cancelled = true
      reject(new Error('Browser page closed during capture'))
    }
    contents.once('destroyed', onDestroyed)
    if (signal) {
      onAbort = () => {
        cancelled = true
        reject(signal.reason instanceof Error ? signal.reason : new Error('Browser screenshot was cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
    deadlineTimer = setTimeout(() => {
      cancelled = true
      reject(new Error('Browser screenshot timed out while waiting for a frame'))
    }, timeoutMs)
  })
  const capture = async (): Promise<NativeImage> => {
    while (!cancelled) {
      if (contents.isDestroyed()) throw new Error('Browser page closed during capture')
      try {
        const image = await contents.capturePage(rect, { stayHidden: true, stayAwake: true })
        if (!image.isEmpty()) return image
      } catch (error) {
        if (!(error instanceof Error) || !/display surface.*(?:available|capture)/i.test(error.message)) throw error
      }
      if (!cancelled) await new Promise<void>(resolve => {
        finishRetry = resolve
        retryTimer = setTimeout(resolve, 25)
      })
    }
    throw new Error('Browser screenshot was cancelled')
  }
  try {
    return await Promise.race([capture(), deadline])
  } finally {
    cancelled = true
    clearTimeout(deadlineTimer)
    clearTimeout(retryTimer)
    finishRetry?.()
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (onDestroyed) contents.removeListener('destroyed', onDestroyed)
  }
}
