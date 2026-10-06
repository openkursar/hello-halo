/** Identical local HTML and visible bounds isolate the two browser carriers from homepage/network races. */

import { test, expect } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'
import {
  browserGuestSnapshot, captureBrowserPerf, closeBrowserPerfPage, createBrowserPerfPage,
  createBrowserPerfSite, oneCoreProcessStats, readBrowserGuestFailures, readBrowserResources, readBrowserRuntime,
  launchBrowserPerfApp, type BrowserPerfApp, type BrowserPerfResult,
} from '../lib/browser-workload'

test('S7b browser view (heavy html)', async () => {
  beginScenario('s7b-browser-view')
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const warnings: string[] = []
  const site = await createBrowserPerfSite()
  let app: BrowserPerfApp['app'] | undefined
  let launched: BrowserPerfApp | undefined
  let sampler: ProcessMetricsSampler | undefined

  try {
    launched = await launchBrowserPerfApp(appEntryPath, testConfigDir)
    app = launched.app
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await installRenderObserversNow(window)
    await installUnresponsiveTracker(app)
    const reloadGuard = installReloadGuard(window)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()
    const throttle = currentThrottle()
    await cdp.setCpuThrottlingRate(throttle)
    const runtime = await readBrowserRuntime(app, appEntryPath)
    const resourcesBefore = await readBrowserResources(app, window)
    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()
    const t0 = Date.now()
    const page = await createBrowserPerfPage(app, window, 'perf-heavy-browser', site.heavy)
    expect(page.pid, 'guest process can be attributed separately from the main renderer').not.toBe(runtime.mainWindowPid)
    const frame = await captureBrowserPerf(app, window, 'perf-heavy-browser')
    const durationMs = Date.now() - t0
    const workloadPrecondition = {
      fullyOpaque: frame.fullyOpaquePixels === frame.width * frame.height,
      whiteBlankCorner: frame.blankCorner.whitePixels === frame.blankCorner.pixels,
    }
    const comparablePixels = workloadPrecondition.fullyOpaque && workloadPrecondition.whiteBlankCorner
    if (!comparablePixels) warnings.push('browser pixels: the heavy fixture must paint a fully opaque frame and an exactly white blank corner; this run is not a comparable workload.')
    const guestHeap = await browserGuestSnapshot(app, page.contentsId)

    // The separate window is an idle sample, not part of the loading measurement.
    const warmupMs = 1000
    const steadyRequestedMs = 5000
    await window.waitForTimeout(warmupMs)
    sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    const steadyStarted = Date.now()
    await window.waitForTimeout(steadyRequestedMs)
    const steady = await sampler.drainSettled()
    const steadyDurationMs = Date.now() - steadyStarted
    const mainWindow = oneCoreProcessStats(steady.byPid.get(runtime.mainWindowPid), runtime.logicalCores)
    const guest = oneCoreProcessStats(steady.byPid.get(page.pid), runtime.logicalCores)
    expect(mainWindow, 'main renderer stable-period samples were collected').not.toBeNull()
    expect(guest, 'guest stable-period samples were collected by its actual OS PID').not.toBeNull()
    expect(guest!.cpuSampleCount).toBeGreaterThanOrEqual(5)

    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app)
    const guestFailures = await readBrowserGuestFailures(app)
    const noReloadOrCrash = rendererReloads === 0 && crashCount === 0 && guestFailures.crashes === 0 && guestFailures.navigations === 0

    const samplingStats = sampler.getSamplingStats()
    if (samplingStats.plannedTicks > 0 && samplingStats.succeededTicks < samplingStats.plannedTicks) {
      warnings.push(`cpu/mem: ${samplingStats.plannedTicks - samplingStats.succeededTicks}/${samplingStats.plannedTicks} process-metrics ticks failed.`)
    }

    let heapEnd: CdpSnapshot | null = null
    if (noReloadOrCrash) {
      try {
        heapEnd = await cdp.snapshot()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${message}) — end/delta reported as null.`)
      }
    }

    const { cpu, mem } = sampler.summarize()

    let render: { longtask: PerfResult['longtask']; eventLatency: PerfResult['eventLatency'] }
    try {
      render = await readRenderMetrics(window)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`longtask/eventLatency: window.__perf read failed (${message}) — reported as null.`)
      render = { longtask: null, eventLatency: null }
    }
    const unmeasuredMetrics: string[] = []
    if (render.longtask === null) {
      unmeasuredMetrics.push('longtask')
      warnings.push('longtask: PerformanceObserver never attached — null, not "0 observed".')
    }
    if (render.eventLatency === null) {
      unmeasuredMetrics.push('eventLatency')
      warnings.push('eventLatency: PerformanceObserver never attached — null, not "0 observed".')
    }

    const valid = noReloadOrCrash && comparablePixels
    const unresponsiveCount = await readUnresponsiveCount(app)

    const result: BrowserPerfResult = {
      scenario: 's7b-browser-view',
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
      warnings: warnings.length ? warnings : undefined,
      perProcess: sampler.summarizeByPid(),
      status: comparablePixels ? 'ok' : 'precondition-failed',
      steps: [{ label: 'fixture and pixels ready', tMs: durationMs }, { label: 'steady sampling ended', tMs: Date.now() - t0 }],
      browser: {
        runtime, fixture: site.heavy, page, frame, workloadPrecondition, guestHeap, guestFailures,
        loadingDurationMs: durationMs,
        loadingIncludesPixels: true,
        warmupMs, steadyRequestedMs, steadyDurationMs,
        steady: { mainWindow, guest, totalRssAvgMB: steady.totalRssAvgMB, cpuUnit: 'percent of one logical core', cpuQuality: sampler.getCpuQuality() },
        resourcesBefore,
      },
    }

    await closeBrowserPerfPage(app, window, 'perf-heavy-browser', page.contentsId)
    const resourcesAfter = await readBrowserResources(app, window)
    result.browser.resourcesAfter = resourcesAfter
    expect(resourcesAfter.domPages).toBe(resourcesBefore.domPages)
    expect(resourcesAfter.webContentsIds).not.toContain(page.contentsId)
    expect((await readBrowserRuntime(app, appEntryPath)).mainBundleSha256).toBe(runtime.mainBundleSha256)

    const filePath = writeResult(result)
    console.log(`[perf] S7b result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

    expect(result.durationMs).toBeGreaterThan(0)
    expect(workloadPrecondition, 'the heavy fixture must render the same opaque white background before its telemetry can be compared').toEqual({ fullyOpaque: true, whiteBlankCorner: true })
    expect(result.valid, 'browser loading and stable telemetry were not contaminated by a reload or crash').toBe(true)
  } finally {
    try { await sampler?.stopSettled() }
    finally {
      try { await launched?.dispose() }
      finally {
        try { await site.close() }
        finally { cleanupTestConfigDir(testConfigDir) }
      }
    }
  }
})
