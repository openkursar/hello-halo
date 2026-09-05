/**
 * S7-b — browser (BrowserViewer / AI 浏览器), the other non-file-preview
 * ContentType. Like PDF, this renders through a separate Electron BrowserView
 * process — `includePerProcess`-style per-pid breakdown is required (not
 * just the type-level aggregate) so the cost can actually be attributed to
 * that process rather than blended into the main window's renderer numbers
 * (per Lead, this is exactly what the PDF run already proved is possible).
 *
 * Content: the same html-extreme-2mb.html fixture S5 used for HtmlViewer
 * (iframe srcDoc), loaded here instead through the BrowserView's own address
 * bar via a local file:// URL — same bytes, different rendering path, no
 * network dependency.
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentityString } from '../lib/build-identity'
import type { PerfResult } from '../types'

const __filename = fileURLToPath(import.meta.url)
const FIXTURES_ROOT = path.resolve(path.dirname(__filename), '../../../halo-local/temp/perf-fixtures')

test('S7b browser view (heavy html)', async () => {
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const warnings: string[] = []

  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
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

    // UI locale isn't fixed by test config (observed both English and
    // Chinese renders across runs) — match both, same convention as the
    // existing e2e helpers (tests/e2e/fixtures/helpers.ts).
    const openButton = window.getByTitle(/Open browser|打开浏览器/).first()
    await openButton.waitFor({ state: 'visible', timeout: 15000 })
    await openButton.click()

    const addressBar = window.getByPlaceholder(/Enter URL or search Bing|输入网址或搜索必应/)
    await addressBar.waitFor({ state: 'visible', timeout: 20000 })

    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()

    const sampler = new ProcessMetricsSampler(app)
    sampler.start()
    const t0 = Date.now()

    const fileUrl = `file://${path.join(FIXTURES_ROOT, 'html-extreme-2mb.html')}`
    await addressBar.fill(fileUrl)
    await addressBar.press('Enter')

    // BrowserView loading has its own overlay (see open-artifact.ts's
    // waitForPdfLoaded) but that only covers the *initial* BrowserView
    // handshake, not this specific navigation — settle on a fixed window
    // matching S5's html/pdf runs (~3s to render) plus margin.
    await window.waitForTimeout(8000)

    const durationMs = Date.now() - t0
    sampler.stop()

    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

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

    // Per Lead: `valid` = contamination-free (no status field here).
    const valid = noReloadOrCrash
    const unresponsiveCount = await readUnresponsiveCount(app)

    const result: PerfResult = {
      scenario: 's7b-browser-view',
      label: currentLabel(),
      gitSha: getBuildIdentityString(),
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
      // Per Lead: BrowserView is a separate process — must be broken out by
      // pid, not just blended into the renderer-type aggregate (same
      // requirement as S5 pdf).
      perProcess: sampler.summarizeByPid()
    }

    const filePath = writeResult(result)
    console.log(`[perf] S7b result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

    expect(result.durationMs).toBeGreaterThan(0)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
