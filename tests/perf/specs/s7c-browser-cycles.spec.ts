import os from 'node:os'
import { expect, test } from '@playwright/test'
import {
  getAppEntryPath, createTestConfigDir, cleanupTestConfigDir,
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installReloadGuard } from '../lib/reload-guard'
import { installRenderObserversNow, readRenderMetrics, resetRenderObservers } from '../lib/render-metrics'
import { installUnresponsiveTracker, readCrashCount, readUnresponsiveCount } from '../lib/unresponsive'
import { getBuildIdentity } from '../lib/build-identity'
import { beginScenario, currentLabel, currentThrottle, writeResult } from '../lib/result-writer'
import {
  captureBrowserPerf, closeBrowserPerfPage, collectMainHeap, createBrowserPerfPage,
  createBrowserPerfSite, executeBrowserPerf, oneCoreProcessStats, parkBrowserPerf,
  readBrowserGuestFailures, readBrowserResources, readBrowserRuntime, showBrowserPerf,
  launchBrowserPerfApp, type BrowserPerfApp, type BrowserFrameEvidence, type BrowserPageEvidence, type BrowserPerfResult, type BrowserResources,
} from '../lib/browser-workload'

function requestedCycles(): number {
  const value = Number(process.env.PERF_BROWSER_CYCLES ?? 12)
  if (!Number.isInteger(value) || value < 2 || value > 50) throw new Error('PERF_BROWSER_CYCLES must be an integer from 2 to 50')
  return value
}

interface CycleSample {
  cycle: number
  arm: 'baseline' | 'browser' | 'idle'
  tMs: number
  armDurationMs: number
  host: CdpSnapshot
  mainHeapMB: number
  totalRssAvgMB: number | null
  resources: BrowserResources
  perProcess: Array<{ pid: number; stats: ReturnType<typeof oneCoreProcessStats> }>
  loadAverage: number[]
}

/** Resource conservation is asserted each cycle; GC trajectories distinguish retention from ordinary garbage. */
test('S7c browser create/show/park/switch/capture/close cycles', async () => {
  const count = requestedCycles()
  test.setTimeout(count * 30000 + 120000)
  beginScenario('s7c-browser-cycles')
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
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
    await installUnresponsiveTracker(app)
    await installRenderObserversNow(window)
    const reloadGuard = installReloadGuard(window)
    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()
    const throttle = currentThrottle()
    await cdp.setCpuThrottlingRate(throttle)
    const runtime = await readBrowserRuntime(app, appEntryPath)
    // Electron keeps first-webview embedder listeners until the host is destroyed.
    const coldResources = await readBrowserResources(app, window)
    const warmupStarted = Date.now()
    const warmupId = 'perf-cycle-warmup'
    const warmupPage = await createBrowserPerfPage(app, window, warmupId, site.cycle('warmup'))
    const afterFirstLazyInit = await readBrowserResources(app, window)
    const warmupFrame = await captureBrowserPerf(app, window, warmupId)
    await parkBrowserPerf(window, warmupId)
    await closeBrowserPerfPage(app, window, warmupId, warmupPage.contentsId)
    const warmedResources = await readBrowserResources(app, window)
    expect(warmedResources.webContentsIds).toEqual(coldResources.webContentsIds)
    expect(warmedResources.domPages).toBe(0)
    expect(warmedResources.nativeBrowserViews).toBe(coldResources.nativeBrowserViews)
    expect(warmedResources.windowCount).toBe(coldResources.windowCount)
    const warmup = { durationMs: Date.now() - warmupStarted, page: warmupPage, frame: warmupFrame, coldResources, afterFirstLazyInit, warmedResources }
    sampler = new ProcessMetricsSampler(app, 500, { cpuSource: 'cumulative' })
    await sampler.startAsync()
    await window.waitForTimeout(1000)
    await resetRenderObservers(window)
    const started = Date.now()
    const samples: CycleSample[] = []
    const actions: Array<{ cycle: number; pages: BrowserPageEvidence[]; loadingMs: number[]; frames: BrowserFrameEvidence[]; elapsedMs: number }> = []
    const closedProcesses: Array<{ cycle: number; arm: 'browser' | 'idle'; processes: unknown }> = []
    const readClosedProcesses = async (cycle: number, arm: 'browser' | 'idle', pids: number[]) => {
      const processes = await app!.evaluate(({ app, webContents }, pids) => {
        const contents = webContents.getAllWebContents().filter(page => !page.isDestroyed())
        return app.getAppMetrics().filter(metric => pids.includes(metric.pid)).map(metric => ({
          pid: metric.pid, creationTime: metric.creationTime, type: metric.type, rssMB: metric.memory.workingSetSize / 1024,
          contentsIds: contents.filter(page => page.getOSProcessId() === metric.pid).map(page => page.id),
        }))
      }, pids)
      closedProcesses.push({ cycle, arm, processes })
    }

    const sample = async (cycle: number, arm: CycleSample['arm'], armStarted: number) => {
      await cdp.releaseDebuggerRetention()
      await cdp.collectGarbage()
      const host = await cdp.snapshot()
      const mainHeapMB = await collectMainHeap(app!)
      const resources = await readBrowserResources(app!, window)
      const drained = await sampler!.drainSettled()
      const point: CycleSample = {
        cycle, arm, tMs: Date.now() - started, armDurationMs: Date.now() - armStarted,
        host, mainHeapMB, totalRssAvgMB: drained.totalRssAvgMB, resources,
        perProcess: [...drained.byPid].map(([pid, stats]) => ({ pid, stats: oneCoreProcessStats(stats, runtime.logicalCores) })),
        loadAverage: os.loadavg(),
      }
      samples.push(point)
      return point
    }
    const baseline = await sample(0, 'baseline', started)
    expect(baseline.resources).toEqual(warmedResources)

    for (let cycle = 1; cycle <= count; cycle++) {
      await sampler.startAsync()
      const actionStarted = Date.now()
      const firstId = `perf-cycle-${cycle}-first`
      const secondId = `perf-cycle-${cycle}-second`
      const firstFixture = site.cycle(`${cycle}-first`)
      const secondFixture = site.cycle(`${cycle}-second`)
      const firstStarted = Date.now()
      const first = await createBrowserPerfPage(app, window, firstId, firstFixture)
      expect(first.pid).not.toBe(runtime.mainWindowPid)
      const firstFrame = await captureBrowserPerf(app, window, firstId)
      const firstLoadMs = Date.now() - firstStarted
      expect(first.nonce).toEqual(expect.any(String))
      await parkBrowserPerf(window, firstId)

      const secondStarted = Date.now()
      const second = await createBrowserPerfPage(app, window, secondId, secondFixture)
      const secondFrame = await captureBrowserPerf(app, window, secondId)
      const secondLoadMs = Date.now() - secondStarted
      expect(second.contentsId).not.toBe(first.contentsId)
      expect(second.nonce).not.toBe(first.nonce)
      await parkBrowserPerf(window, secondId)
      await showBrowserPerf(window, firstId)
      const switchedFrame = await captureBrowserPerf(app, window, firstId)
      expect(await executeBrowserPerf(window, firstId, 'window.browserPerfNonce')).toBe(first.nonce)
      expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), first.contentsId)).toBe(firstFixture.url)
      await closeBrowserPerfPage(app, window, firstId, first.contentsId)
      await closeBrowserPerfPage(app, window, secondId, second.contentsId)

      const action = await sample(cycle, 'browser', actionStarted)
      await readClosedProcesses(cycle, 'browser', [first.pid, second.pid])
      expect(action.resources.domPages).toBe(baseline.resources.domPages)
      expect(action.resources.webContentsIds).toEqual(baseline.resources.webContentsIds)
      expect(action.resources.nativeBrowserViews).toBe(baseline.resources.nativeBrowserViews)
      expect(action.resources.windowCount).toBe(baseline.resources.windowCount)
      expect(action.resources.mainWindowListeners).toEqual(baseline.resources.mainWindowListeners)
      expect(action.resources.mainWindowEvents).toEqual(baseline.resources.mainWindowEvents)
      expect(action.resources.appListeners).toEqual(baseline.resources.appListeners)
      actions.push({ cycle, pages: [first, second], loadingMs: [firstLoadMs, secondLoadMs], frames: [firstFrame, secondFrame, switchedFrame], elapsedMs: action.armDurationMs })

      // Match the action's clock without creating pages, in the same process and environment.
      await sampler.startAsync()
      const idleStarted = Date.now()
      await window.waitForTimeout(action.armDurationMs)
      const idle = await sample(cycle, 'idle', idleStarted)
      await readClosedProcesses(cycle, 'idle', [first.pid, second.pid])
      expect(idle.resources).toEqual(action.resources)
    }
    await sampler.stopSettled()
    const heapStart = baseline.host
    const heapEnd = samples[samples.length - 1].host
    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app)
    const guestFailures = await readBrowserGuestFailures(app)
    const render = await readRenderMetrics(window)
    const { cpu, mem } = sampler.summarize()
    const samplingMissing = ['browser.transientGuestCost.cpuOneCoreAvg', 'browser.transientGuestCost.peakRssMB']
    const unmeasuredMetrics = [render.longtask === null ? 'longtask' : null, render.eventLatency === null ? 'eventLatency' : null, ...samplingMissing].filter((name): name is string => name !== null)
    const perProcess = sampler.summarizeByPid()
    const guestPids = [...new Set(actions.flatMap(action => action.pages.map(page => page.pid)))]
    const cpuSampledPids = guestPids.filter(pid => perProcess.some(process => process.pid === pid))
    const transientGuestCost = {
      cpuOneCoreAvg: null, peakRssMB: null, samplingIntervalMs: 500, guestPids, cpuSampledPids,
      reason: 'Sampling every 500 ms does not cover the complete lifetime or peak RSS of guests created and closed within a short cycle.',
    }
    const { url: _fixtureUrl, ...cycleFixture } = site.cycle('workload')
    const result: BrowserPerfResult = {
      scenario: 's7c-browser-cycles', label: currentLabel(), build: getBuildIdentity(), throttle,
      durationMs: Date.now() - started,
      cpu, mem, sampling: sampler.getSamplingStats(), longtask: render.longtask, eventLatency: render.eventLatency,
      heap: { startMB: heapStart.heapMB, endMB: heapEnd.heapMB, deltaMB: heapEnd.heapMB - heapStart.heapMB },
      nodes: { start: heapStart.nodes, end: heapEnd.nodes, delta: heapEnd.nodes - heapStart.nodes },
      listeners: { start: heapStart.listeners, end: heapEnd.listeners, delta: heapEnd.listeners - heapStart.listeners },
      unresponsiveCount: await readUnresponsiveCount(app), rendererReloads, crashCount,
      valid: rendererReloads === 0 && crashCount === 0 && guestFailures.crashes === 0 && guestFailures.navigations === 0, status: 'ok',
      perProcess, unmeasuredMetrics,
      browser: {
        runtime, cycles: count, fixture: cycleFixture, forcedGc: true, guestFailures, warmup,
        loadingIncludesPixels: true,
        cpuUnit: 'percent of one logical core', cpuQuality: sampler.getCpuQuality(), samplingMissing, transientGuestCost, actions, samples, closedProcesses,
        note: 'Every closed guest, public view state and DOM page must be released. The bounded forced-GC trajectory is leak evidence for this workload, not a long-duration soak.',
      },
    }
    expect((await readBrowserRuntime(app, appEntryPath)).mainBundleSha256).toBe(runtime.mainBundleSha256)
    const path = writeResult(result)
    console.log(`[perf] browser lifecycle result written to ${path}: ${count} browser cycles and ${count} clock-matched idle arms`)
    expect(result.sampling.succeededTicks).toBeGreaterThan(0)
    expect(result.valid, 'lifecycle telemetry was not contaminated by renderer reload or crash').toBe(true)
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
