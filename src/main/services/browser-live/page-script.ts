import type { WebContents } from 'electron'

/** Kept apart from the page's own scripts, which can neither see nor tamper with it. */
const WORLD_ID = 1099
/** A page frozen by a modal dialog runs no script and never answers. */
const TIMEOUT_MS = 300
const METRICS_SCRIPT = '[innerWidth, innerHeight, scrollY, Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0)]'

/** The page's screen and document, in CSS pixels. */
export interface PageMetrics {
  width: number
  height: number
  top: number
  total: number
}

/** Runs a short script against the page's DOM; null when it threw or did not answer in time. */
export async function runPageScript(contents: WebContents, code: string): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), TIMEOUT_MS) }),
    ])
  } catch {
    // A page mid-navigation has no document to run against.
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function readPageMetrics(contents: WebContents): Promise<PageMetrics | null> {
  const metrics = await runPageScript(contents, METRICS_SCRIPT)
  if (!Array.isArray(metrics) || metrics.length !== 4) return null
  if (!metrics.every(n => typeof n === 'number' && Number.isFinite(n)) || metrics[0] <= 0 || metrics[1] <= 0) return null
  const [width, height, top, total] = metrics as number[]
  return { width, height, top, total: Math.max(total, height) }
}
