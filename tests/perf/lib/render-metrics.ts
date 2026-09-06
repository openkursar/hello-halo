import type { Page } from '@playwright/test'

declare global {
  interface Window {
    __perf?: {
      longtasks: { duration: number }[]
      events: { duration: number }[]
      longtaskSupported: boolean
      eventSupported: boolean
    }
  }
}

/**
 * Runs in-page: sets up the longtask + slow-interaction observers.
 *
 * A `catch` that leaves the bucket empty makes "entryType
 * unsupported, observer never attached" and "observer worked fine and
 * genuinely saw zero" produce the exact same `{count: 0}` — the one case
 * this harness must never allow, since it's indistinguishable from "zero
 * jank" in the report. `longtaskSupported`/`eventSupported` record which
 * case actually happened; `readRenderMetrics` turns `supported: false` into
 * `null`, not a `0` count.
 */
function attachObservers(): void {
  window.__perf = { longtasks: [], events: [], longtaskSupported: true, eventSupported: true }
  try {
    const longtaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf!.longtasks.push({ duration: entry.duration })
      }
    })
    // buffered: true replays any longtask entries Chromium already recorded
    // before this observer was attached — free
    // extra coverage for the addInitScript path, and it does no harm on the
    // evaluate() path either.
    longtaskObserver.observe({ entryTypes: ['longtask'], buffered: true })
  } catch {
    window.__perf.longtaskSupported = false
  }
  try {
    const eventObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf!.events.push({ duration: entry.duration })
      }
    })
    // @ts-expect-error durationThreshold is Chromium-specific, not in lib.dom types
    eventObserver.observe({ type: 'event', durationThreshold: 100, buffered: true })
  } catch {
    window.__perf.eventSupported = false
  }
}

/**
 * Installs longtask + slow-interaction observers before any page script runs.
 * Use for scenarios that control the page from before its first navigation
 * (e.g. S1 cold start). For an already-loaded SPA page, use
 * `installRenderObserversNow` instead — `addInitScript` only affects future
 * navigations, and Halo never navigates again after its initial load.
 */
export async function installRenderObservers(page: Page): Promise<void> {
  await page.addInitScript(attachObservers)
}

/** Installs the same observers directly into an already-loaded page. */
export async function installRenderObserversNow(page: Page): Promise<void> {
  await page.evaluate(attachObservers)
}

/** Clears buffers so a scenario can isolate its own window from boot noise. */
export async function resetRenderObservers(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__perf) {
      window.__perf.longtasks = []
      window.__perf.events = []
    }
  })
}

export interface RenderMetricsSummary {
  /** `null` when the longtask PerformanceObserver never attached — never a fabricated `{count: 0}`. */
  longtask: { count: number; totalMs: number; maxMs: number; p95Ms: number } | null
  /** `null` when the event-timing PerformanceObserver never attached. */
  eventLatency: { count: number; maxMs: number } | null
}

export async function readRenderMetrics(page: Page): Promise<RenderMetricsSummary> {
  const raw = await page.evaluate(() => ({
    longtasks: window.__perf?.longtasks ?? [],
    events: window.__perf?.events ?? [],
    longtaskSupported: window.__perf?.longtaskSupported ?? false,
    eventSupported: window.__perf?.eventSupported ?? false
  }))

  const durations = raw.longtasks.map((t) => t.duration).sort((a, b) => a - b)
  const eventDurations = raw.events.map((e) => e.duration)

  return {
    longtask: raw.longtaskSupported
      ? {
          count: durations.length,
          totalMs: durations.reduce((a, b) => a + b, 0),
          maxMs: durations.length ? durations[durations.length - 1] : 0,
          p95Ms: percentile(durations, 0.95)
        }
      : null,
    eventLatency: raw.eventSupported
      ? {
          count: eventDurations.length,
          maxMs: eventDurations.length ? Math.max(...eventDurations) : 0
        }
      : null
  }
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const idx = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * p))
  return sortedValues[idx]
}
