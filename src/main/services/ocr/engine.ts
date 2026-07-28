/**
 * Local, offline OCR engine (tesseract.js, LSTM engine).
 *
 * Shared on-device text-from-image capability with three consumers: knowledge-
 * base ingest (services/tlon), the interactive `ocr` toolset, and the automation
 * runtime's built-in OCR. Everything runs on-device: the WASM engine ships in the
 * app bundle and the eng+chi_sim language data under resources/ocr/tessdata is
 * passed as a local path, so nothing is fetched from a CDN and image content
 * never leaves the machine.
 *
 * The worker is created lazily and reused across images and across consumers. If
 * it fails to initialize, OCR degrades gracefully: the caller gets '' rather than
 * a crash. Chinese recognition is serviceable but not exact; a high-precision
 * engine is a separate optional pack.
 *
 * Lifecycle note: because the worker is shared, its shutdown is owned by the
 * bootstrap cleanup flow (cleanupExtendedServices), not by any single consumer.
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'
import type { Worker } from 'tesseract.js'

let workerPromise: Promise<Worker | null> | null = null

/** Bundled language-data directory, resolved for dev and packaged. */
function tessdataDir(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'ocr', 'tessdata')]
    : [
        join(app.getAppPath(), 'resources', 'ocr', 'tessdata'),
        join(process.cwd(), 'resources', 'ocr', 'tessdata'),
      ]
  for (const c of candidates) {
    if (existsSync(join(c, 'eng.traineddata'))) return c
  }
  return candidates[candidates.length - 1]
}

async function getWorker(): Promise<Worker | null> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      // Under Electron the worker reports its env as 'electron', not 'node', so
      // tesseract treats langPath as a URL and fetch()es it — which throws on a
      // local file path. Point it at the bundled language data as a read-only
      // cache instead: cache reads go through fs and skip fetch entirely.
      return createWorker('eng+chi_sim', 1, {
        cachePath: tessdataDir(),
        cacheMethod: 'readOnly',
        logger: () => {},
      })
    })().catch(err => {
      console.error('[OCR] Engine failed to initialize; images will be skipped:', err)
      workerPromise = null
      return null
    })
  }
  return workerPromise
}

/**
 * tesseract splits CJK runs into space-separated glyphs; collapse the spaces
 * between adjacent CJK characters so Chinese phrases stay grep-able, while
 * keeping the spaces that separate CJK from Latin.
 */
function collapseCjkSpaces(text: string): string {
  const cjk = '\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef'
  return text.replace(new RegExp(`([${cjk}])\\s+(?=[${cjk}])`, 'g'), '$1')
}

/**
 * Terminate the cached worker (a real worker thread holding the WASM engine).
 * Called on app shutdown; a later ocrImage lazily re-creates the worker.
 */
export async function shutdownOcr(): Promise<void> {
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  try {
    const worker = await pending
    await worker?.terminate()
  } catch (err) {
    console.error('[OCR] Worker termination failed:', err)
  }
}

/** OCR an image buffer to plaintext. Returns '' when no text is found or the engine is unavailable. */
export async function ocrImage(buf: Buffer): Promise<string> {
  const worker = await getWorker()
  if (!worker) return ''
  try {
    const { data } = await worker.recognize(buf)
    return collapseCjkSpaces(data.text).trim()
  } catch (err) {
    console.error('[OCR] Recognition failed for an image:', err)
    return ''
  }
}
