/**
 * Fetching the update package.
 *
 * Uses Electron's net stack rather than Node's http module so the download
 * follows whatever proxy the machine is configured with — the corporate
 * networks this ships into route through one, and a download that ignores it
 * fails in a way that looks like the update server being down.
 *
 * The digest is checked by the helper before it unpacks anything, not here:
 * this module's job ends at "bytes are on disk".
 */

import { net } from 'electron'
import { createWriteStream } from 'fs'
import { mkdir, rename, rm, stat } from 'fs/promises'
import { dirname } from 'path'

export interface DownloadProgress {
  transferred: number
  total: number
  percent: number
  bytesPerSecond: number
}

/** Redirects are followed by Electron itself; this only bounds our own retries. */
const MAX_ATTEMPTS = 3

/** Gap between retries, growing per attempt. */
const RETRY_BASE_MS = 2000

/**
 * Longest a download may go without receiving a byte before it is abandoned.
 *
 * A connection can stall without closing — a proxy holding it, a server that
 * stopped writing — and with no bound the preparation never settles, which
 * blocks every later check in the session. Time spent paused for the disk is
 * not counted: that stall is ours, not the network's.
 */
const IDLE_TIMEOUT_MS = 60_000

/**
 * Electron's `IncomingMessage` implements the Readable Stream interface but its
 * typings declare only the EventEmitter half, so flow control is invisible to
 * tsc. A package is ~1 GB; without pausing, the whole body buffers in memory
 * whenever the disk falls behind.
 */
type FlowControlled = { pause(): void; resume(): void }

/**
 * Download `url` to `destination`, reporting progress.
 *
 * Writes to a sibling `.part` file and renames on success, so a destination
 * that exists is always a complete download. An in-flight download is
 * abandoned by resolving `signal`.
 */
export async function downloadPackage(
  url: string,
  destination: string,
  expectedBytes: number,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new Error('update download cancelled')
    try {
      await attemptDownload(url, destination, expectedBytes, onProgress, signal)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (signal.aborted) throw lastError
      console.warn(`[Updater] Download attempt ${attempt} failed: ${lastError.message}`)
      if (attempt < MAX_ATTEMPTS) {
        await delay(RETRY_BASE_MS * attempt, signal)
      }
    }
  }
  throw lastError ?? new Error('update download failed')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function attemptDownload(
  url: string,
  destination: string,
  expectedBytes: number,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const partial = `${destination}.part`

  return new Promise<void>((resolve, reject) => {
    const request = net.request({ url, method: 'GET' })
    let settled = false
    let file: ReturnType<typeof createWriteStream> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const disarmIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      disarmIdle()
      signal.removeEventListener('abort', onAbort)
      file?.destroy()
      rm(partial, { force: true }).catch(() => undefined)
      reject(error)
    }

    const abortWith = (error: Error) => {
      request.abort()
      fail(error)
    }

    const armIdle = () => {
      disarmIdle()
      idleTimer = setTimeout(
        () => abortWith(new Error(`update download stalled: no data for ${IDLE_TIMEOUT_MS / 1000}s`)),
        IDLE_TIMEOUT_MS
      )
    }

    const onAbort = () => abortWith(new Error('update download cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    armIdle()

    request.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`update server returned HTTP ${response.statusCode}`))
        return
      }

      file = createWriteStream(partial)
      file.on('error', fail)

      const body = response as unknown as FlowControlled
      let transferred = 0
      const started = Date.now()
      let lastReport = 0

      response.on('data', (chunk: Buffer) => {
        if (settled) return
        transferred += chunk.length
        // The signed description fixed the size; more bytes than that is not
        // the package, and waiting for the end to say so could mean filling
        // the disk first.
        if (transferred > expectedBytes) {
          abortWith(new Error(`update package exceeds the expected ${expectedBytes} bytes`))
          return
        }
        armIdle()
        if (!file!.write(chunk)) {
          disarmIdle()
          body.pause()
          file!.once('drain', () => {
            armIdle()
            body.resume()
          })
        }

        // Progress drives a UI element; reporting every chunk would spend more
        // time crossing process boundaries than downloading.
        const now = Date.now()
        if (now - lastReport >= 500) {
          lastReport = now
          const elapsed = Math.max(1, now - started) / 1000
          onProgress({
            transferred,
            total: expectedBytes,
            percent: expectedBytes > 0 ? (transferred / expectedBytes) * 100 : 0,
            bytesPerSecond: transferred / elapsed,
          })
        }
      })

      response.on('error', (error: unknown) =>
        fail(error instanceof Error ? error : new Error(String(error)))
      )

      response.on('end', () => {
        if (settled) return
        disarmIdle()
        file!.end(async () => {
          try {
            const written = await stat(partial)
            if (written.size !== expectedBytes) {
              throw new Error(
                `update package is ${written.size} bytes, expected ${expectedBytes}`
              )
            }
            await rm(destination, { force: true })
            await rename(partial, destination)
            settled = true
            signal.removeEventListener('abort', onAbort)
            resolve()
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })
      })
    })

    request.end()
  })
}
