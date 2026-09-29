/**
 * Batches telemetry reports from HTTP-mode clients (Capacitor, remote browser).
 *
 * Sent one request per report, the burst fired on entering a page competes with
 * that page's own data requests for the browser's per-server connection limit.
 * Reports now wait briefly and leave together; hiding or unloading the page
 * flushes at once. Only that flush uses keepalive: it lets the request outlive
 * the page, but a keepalive request that needs a CORS preflight (cross-origin
 * with Authorization, as in Capacitor) is unreliable, so routine flushes skip it.
 */
import { getAuthToken, getRemoteServerUrl } from './transport'

export interface ReportItem {
  event: string
  properties?: Record<string, unknown>
}

export type PostResult = 'ok' | 'legacy' | 'failed'

const REPORT_PATH = '/api/analytics/report'
const FLUSH_DELAY_MS = 5_000
const MAX_BATCH = 50
/** What a desktop server predating batch reports answers to a batch body. */
const LEGACY_REJECTION = 'Missing event name'

export function createReportBatcher(deps: {
  post: (body: Record<string, unknown>, keepalive: boolean) => Promise<PostResult>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}) {
  let queue: ReportItem[] = []
  let timer: unknown = null
  let legacyServer = false

  const sendSingly = (items: ReportItem[], keepalive: boolean): void => {
    for (const item of items) void deps.post({ ...item }, keepalive)
  }

  const flush = (keepalive = false): void => {
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
    if (queue.length === 0) return
    const batch = queue
    queue = []
    if (legacyServer) {
      sendSingly(batch, keepalive)
      return
    }
    void deps.post({ events: batch }, keepalive).then((result) => {
      if (result !== 'legacy') return
      legacyServer = true
      sendSingly(batch, keepalive)
    })
  }

  return {
    enqueue(item: ReportItem): void {
      queue.push(item)
      if (queue.length >= MAX_BATCH) {
        flush()
        return
      }
      if (timer === null) timer = deps.setTimer(() => flush(), FLUSH_DELAY_MS)
    },
    flush,
  }
}

async function postReport(body: Record<string, unknown>, keepalive: boolean): Promise<PostResult> {
  const baseUrl = getRemoteServerUrl()
  if (!baseUrl) return 'failed'
  const token = getAuthToken()
  try {
    const response = await fetch(`${baseUrl}${REPORT_PATH}`, {
      method: 'POST',
      keepalive,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (response.ok) return 'ok'
    if (response.status !== 400) return 'failed'
    const data = (await response.json().catch(() => null)) as { error?: unknown } | null
    return data?.error === LEGACY_REJECTION ? 'legacy' : 'failed'
  } catch {
    return 'failed'
  }
}

let batcher: ReturnType<typeof createReportBatcher> | null = null

export function enqueueReport(item: ReportItem): void {
  if (!batcher) {
    const created = createReportBatcher({
      post: postReport,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') created.flush(true)
    })
    window.addEventListener('pagehide', () => created.flush(true))
    batcher = created
  }
  batcher.enqueue(item)
  // The hide flush has already run and a hidden page's timer may never fire.
  if (document.visibilityState === 'hidden') batcher.flush(true)
}
