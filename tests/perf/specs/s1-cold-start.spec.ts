/**
 * S1 — Cold start: launch -> first screen interactive.
 *
 * Launches the same way the e2e suite does — the `out/main` entry (the
 * electron-vite production build) via the e2e fixture's own env prep
 * (isolated HOME/HALO_DATA_DIR, product.json path rewrite, OAuth source
 * loading, SDK symlink). Not the shared `perf-electron` `test.extend`
 * fixture, so timing starts at the `launchElectronApp()` call itself.
 */

import { test, expect } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { waitForHomePage } from '../../e2e/fixtures/helpers'
import { installRenderObserversNow, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'

test('S1 cold start', async () => {
  beginScenario('s1-cold-start')
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const warnings: string[] = []

  const t0 = Date.now()
  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
    const sampler = new ProcessMetricsSampler(app)
    sampler.start()

    const window = await app.firstWindow()

    // installUnresponsiveTracker must run after the window exists — BrowserWindow.getAllWindows() right after launch can
    // still be empty, which used to hook zero windows and made
    // unresponsiveCount structurally 0 for this scenario regardless of what
    // actually happened.
    await installUnresponsiveTracker(app)

    // addInitScript (installRenderObservers) only affects a
    // *future* navigation. By the time app.firstWindow() resolves, Halo's
    // one-and-only navigation has already started, so the deferred script
    // never got a next navigation to attach to and longtask.count was
    // structurally 0 forever. installRenderObserversNow (page.evaluate)
    // attaches immediately into the current document instead — it still
    // can't see whatever ran before this point (external-CDP limitation),
    // but it now captures everything from here on instead of nothing ever.
    await installRenderObserversNow(window)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()
    const throttle = currentThrottle()
    await cdp.setCpuThrottlingRate(throttle)
    const heapStart = await cdp.snapshot()

    // First-screen-interactive marker. A `Promise.race` against several
    // selectors (including a splash-screen one) resolves as soon as the
    // *splash screen* appears, not real content —
    // S1's nodes.end (~180-270) was landing below S4's nodes.start (446,
    // the app's already-loaded baseline), proving it was timing the splash,
    // not "interactive". `waitForHomePage` waits specifically for
    // `[data-onboarding="halo-space"]` (the real Home page content), same
    // as every other e2e test's definition of "loaded" — createTestConfigDir
    // always seeds an API key source, so this test config never lands on
    // the api-setup screen instead.
    await waitForHomePage(window)

    // Installed only after first-screen-interactive, so the boot's own
    // legitimate load isn't miscounted — every 'load' from here on is a
    // recoverRenderer() silent reload (see reload-guard.ts).
    const reloadGuard = installReloadGuard(window)

    const durationMs = Date.now() - t0

    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    // Gates whether it's even worth attempting the final CDP snapshot below
    // (reload/crash invalidate the execution context). The result's `valid`
    // field is computed later, once we also know whether the longtask/event
    // observers actually attached — "collector never worked" must sink
    // `valid` exactly like "renderer reloaded" does.
    const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

    sampler.stop()
    const samplingStats = sampler.getSamplingStats()
    if (samplingStats.plannedTicks > 0 && samplingStats.succeededTicks < samplingStats.plannedTicks) {
      warnings.push(`cpu/mem: ${samplingStats.plannedTicks - samplingStats.succeededTicks}/${samplingStats.plannedTicks} process-metrics ticks failed — avg/max may be skewed toward the calmer part of the run.`)
    }

    let heapEnd: CdpSnapshot | null = null
    if (noReloadOrCrash) {
      try {
        heapEnd = await cdp.snapshot()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${message}) — end/delta reported as null, not backfilled with the start value.`)
      }
    }

    const { cpu, mem } = sampler.summarize()

    let render: { longtask: PerfResult['longtask']; eventLatency: PerfResult['eventLatency'] }
    try {
      render = await readRenderMetrics(window)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`longtask/eventLatency: window.__perf read failed (${message}) — reported as null, not a fabricated 0.`)
      render = { longtask: null, eventLatency: null }
    }
    const unmeasuredMetrics: string[] = []
    if (render.longtask === null) {
      unmeasuredMetrics.push('longtask')
      warnings.push('longtask: PerformanceObserver never attached (entryType unsupported, or — for S1 specifically — the window it could attach in starts after first-screen-interactive, see the note field) — null, not "0 observed".')
    }
    if (render.eventLatency === null) {
      unmeasuredMetrics.push('eventLatency')
      warnings.push('eventLatency: PerformanceObserver never attached — null, not "0 observed".')
    }

    // `valid` answers "was this run contaminated" (reload/crash),
    // not "was every metric measured" — a single unmeasured field (like
    // S1's longtask, which is physically unobservable pre-first-paint) must
    // not sink the whole run's otherwise-good duration/nodes/memory/CPU out
    // of every comparison table. See `unmeasuredMetrics` for per-field gaps.
    const valid = noReloadOrCrash

    const unresponsiveCount = await readUnresponsiveCount(app)

    const result: PerfResult = {
      scenario: 's1-cold-start',
      label: currentLabel(),
      build: getBuildIdentity(),
      throttle,
      durationMs,
      cpu,
      mem,
      sampling: samplingStats,
      longtask: render.longtask,
      eventLatency: render.eventLatency,
      heap: {
        startMB: heapStart.heapMB,
        endMB: heapEnd?.heapMB ?? null,
        deltaMB: heapEnd ? heapEnd.heapMB - heapStart.heapMB : null
      },
      nodes: {
        start: heapStart.nodes,
        end: heapEnd?.nodes ?? null,
        delta: heapEnd ? heapEnd.nodes - heapStart.nodes : null
      },
      listeners: {
        start: heapStart.listeners,
        end: heapEnd?.listeners ?? null,
        delta: heapEnd ? heapEnd.listeners - heapStart.listeners : null
      },
      unresponsiveCount,
      rendererReloads,
      crashCount,
      valid,
      unmeasuredMetrics: unmeasuredMetrics.length ? unmeasuredMetrics : undefined,
      // A true "supported:true, count:0" reads to a human as "cold
      // start has no jank", but the longtask/eventLatency observers can only
      // attach after waitForHomePage resolves (external-CDP limitation — see
      // the comment above installRenderObserversNow's call site) — the boot
      // work that ran *before* that point was never in the observation
      // window at all. This number means "no jank after first paint", not
      // "no jank during boot"; recorded explicitly so it can't be misread as
      // the latter by anyone reading the raw JSON, not just in the report.
      note: 'longtask/eventLatency observation window starts at first-screen-interactive (post waitForHomePage), not at process launch — pre-first-paint boot work is outside what this scenario can measure.',
      warnings: warnings.length ? warnings : undefined
    }

    const filePath = writeResult(result)
    console.log(`[perf] S1 result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

    expect(result.durationMs).toBeGreaterThan(0)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
