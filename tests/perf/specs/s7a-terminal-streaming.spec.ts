/**
 * S7-a — terminal (TerminalViewer, xterm.js, scrollback: 10000). A
 * high-frequency streaming scenario, closer in kind to S2's chat stream than
 * to S5's one-shot file renders: run a command that prints a large volume of
 * output fast, and check two specific things:
 *   1. Does the 10000-line scrollback cap actually bound memory growth?
 *   2. Does high-frequency output block the main thread (longtask)?
 */

import { test, expect } from '@playwright/test'
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
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'

test('S7a terminal high-volume output', async () => {
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
    const openButton = window.getByTitle(/Open terminal|打开终端/).first()
    await openButton.waitFor({ state: 'visible', timeout: 15000 })
    await openButton.click()

    // xterm mounts into a plain container (TerminalViewer.tsx, no
    // data-testid) — wait for the canvas it draws into as the "ready" signal.
    await window.waitForSelector('.xterm', { timeout: 20000 })
    await window.waitForTimeout(500) // let the PTY attach before typing

    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()

    const sampler = new ProcessMetricsSampler(app)
    sampler.start()
    const t0 = Date.now()

    // Click into the terminal to focus it, then type a command that prints
    // 100,000 lines fast — well past the 10,000-line scrollback cap, so any
    // memory growth beyond a bounded amount is the cap failing to hold.
    await window.locator('.xterm').click()
    await window.keyboard.type('seq 1 100000')
    await window.keyboard.press('Enter')

    // Let output fully flush before measuring — 100k lines at terminal
    // speed settles well within this window on a warm local shell.
    await window.waitForTimeout(15000)

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

    // `valid` = contamination-free (no status field here — this
    // scenario either completes or throws, no hang/error state of its own).
    const valid = noReloadOrCrash
    const unresponsiveCount = await readUnresponsiveCount(app)

    const result: PerfResult = {
      scenario: 's7a-terminal-streaming',
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
      warnings: warnings.length ? warnings : undefined
    }

    const filePath = writeResult(result)
    console.log(`[perf] S7a result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

    expect(result.durationMs).toBeGreaterThan(0)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
