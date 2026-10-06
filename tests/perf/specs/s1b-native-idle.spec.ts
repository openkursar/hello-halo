import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { getAppEntryPath, createTestConfigDir, cleanupTestConfigDir, launchElectronApp } from '../../e2e/fixtures/electron'
import { waitForHomePage } from '../../e2e/fixtures/helpers'
import { CdpMetricsCollector } from '../lib/cdp-metrics'
import { getBuildIdentity } from '../lib/build-identity'
import { ProcessMetricsSampler, type CpuSamplingQuality, type ProcessWindowStat } from '../lib/process-metrics'
import { installReloadGuard } from '../lib/reload-guard'
import { beginScenario, currentLabel, currentThrottle, writeResult } from '../lib/result-writer'
import { installUnresponsiveTracker, readCrashCount, readUnresponsiveCount } from '../lib/unresponsive'
import type { PerfResult } from '../types'

const SAMPLE_INTERVAL_MS = 500

interface IdleTracker {
  windowId: number
  events: Record<string, number>
  dispose(): void
}

async function readIdleState(app: ElectronApplication, window: Page) {
  const [native, documentState] = await Promise.all([
    app.evaluate(({ BrowserWindow, app, webContents }) => {
      const tracker = (globalThis as unknown as { perfNativeIdle: IdleTracker }).perfNativeIdle
      const main = BrowserWindow.fromId(tracker.windowId)
      if (!main || main.isDestroyed()) throw new Error('Native idle main window was destroyed')
      return {
        windowId: main.id, hostPid: main.webContents.getOSProcessId(), visible: main.isVisible(),
        minimized: main.isMinimized(), focused: main.isFocused(), captured: main.webContents.isBeingCaptured(),
        bounds: main.getContentBounds(), events: { ...tracker.events },
        contents: webContents.getAllWebContents().filter(contents => !contents.isDestroyed()).map(contents => ({ id: contents.id, pid: contents.getOSProcessId(), type: contents.getType() })),
        processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, creationTime: metric.creationTime, type: metric.type, rssMB: metric.memory.workingSetSize / 1024 })),
      }
    }),
    window.evaluate(() => ({
      visibility: document.visibilityState, focused: document.hasFocus(),
      conversationSelected: document.querySelector('nav button[aria-label="Conversation"]')?.getAttribute('aria-current') === 'page',
      composerReady: document.querySelector('textarea') instanceof HTMLTextAreaElement,
      draft: (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? null,
      viewport: { width: innerWidth, height: innerHeight },
    })),
  ])
  return { native, document: documentState, loadAverage: os.loadavg() }
}

type IdleState = Awaited<ReturnType<typeof readIdleState>>

interface IdleWindow {
  name: 'first10s' | 'next50s'
  requestedDurationMs: number
  durationMs: number
  sinceHomeInteractiveMs: number
  totalRssAvgMB: number | null
  sampling: { plannedTicks: number; succeededTicks: number }
  cpuQuality: CpuSamplingQuality
  perProcess: Array<ProcessWindowStat & { pid: number; type: string | null; cpuOneCoreAvg: number; cpuOneCoreMax: number }>
  before: IdleState
  after: IdleState
  valid: boolean
  failures: string[]
}

function stateFailures(before: IdleState, after: IdleState): string[] {
  const failures: string[] = []
  for (const [name, state] of [['before', before], ['after', after]] as const) {
    if (!state.native.visible || state.native.minimized || !state.native.focused) failures.push(`${name}: native main window must be visible, restored and focused`)
    if (state.document.visibility !== 'visible' || !state.document.focused) failures.push(`${name}: document must be visible and focused`)
    if (!state.document.conversationSelected || !state.document.composerReady || state.document.draft !== '') failures.push(`${name}: empty Home conversation surface must be mounted`)
  }
  for (const key of ['windowId', 'hostPid', 'captured', 'bounds', 'events', 'contents'] as const) {
    if (JSON.stringify(before.native[key]) !== JSON.stringify(after.native[key])) failures.push(`native ${key} changed during idle`)
  }
  if (JSON.stringify(before.document) !== JSON.stringify(after.document)) failures.push('Home document state changed during idle')
  const identities = (state: IdleState) => state.native.processes.map(process => `${process.pid}:${process.creationTime}:${process.type}`).sort()
  if (JSON.stringify(identities(before)) !== JSON.stringify(identities(after))) failures.push('process identity set changed during idle')
  return failures
}

test('S1b cold Home and 60 seconds of native cumulative idle CPU', async () => {
  test.skip(process.platform !== 'darwin', 'native cumulative idle CPU is collected on macOS only')
  test.setTimeout(180000)
  beginScenario('s1b-native-idle')
  expect(currentThrottle(), 'native idle CPU must be measured without CDP CPU throttling').toBe(1)
  const appEntryPath = getAppEntryPath()
  const mainBundleSha256 = createHash('sha256').update(readFileSync(appEntryPath)).digest('hex')
  const profile = createTestConfigDir(appEntryPath)
  const samplers: ProcessMetricsSampler[] = []
  let app: ElectronApplication | undefined

  try {
    const launchStarted = performance.now()
    app = await launchElectronApp(appEntryPath, profile)
    const window = await app.firstWindow()
    await waitForHomePage(window)
    await expect(window.getByRole('button', { name: 'Conversation', exact: true }).first()).toHaveAttribute('aria-current', 'page')
    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.locator('textarea')).toBeEnabled()
    const firstScreenInteractiveMs = performance.now() - launchStarted
    const reloadGuard = installReloadGuard(window)
    await installUnresponsiveTracker(app)
    await expect.poll(() => window.evaluate(async () => {
      const response = await (window as unknown as { halo: HaloAPI }).halo.getBootstrapStatus()
      return response.success && response.data?.extendedReady === true
    }), { timeout: 30000 }).toBe(true)
    const bootstrapReadyMs = performance.now() - launchStarted

    const runtime = await app.evaluate(({ BrowserWindow, app }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.isVisible())
      if (!main) throw new Error('Native idle scenario has no visible main window')
      main.focus()
      const events: Record<string, number> = {}
      const listeners = ['blur', 'hide', 'minimize', 'close', 'unresponsive'].map(event => {
        events[event] = 0
        const listener = () => { events[event]++ }
        main.on(event as 'blur', listener)
        return { event, listener }
      })
      ;(globalThis as unknown as { perfNativeIdle: IdleTracker }).perfNativeIdle = {
        windowId: main.id, events,
        dispose() { for (const { event, listener } of listeners) main.removeListener(event as 'blur', listener) },
      }
      return { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, appVersion: app.getVersion(), mainPid: process.pid, mainWindowPid: main.webContents.getOSProcessId() }
    })
    if (!runtime.electron || !runtime.chromium) throw new Error('Actual Electron runtime identity is unavailable')
    if (process.env.PERF_EXPECT_ELECTRON_MAJOR) expect(runtime.electron.split('.')[0]).toBe(process.env.PERF_EXPECT_ELECTRON_MAJOR)
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => {
      const tracker = (globalThis as unknown as { perfNativeIdle: IdleTracker }).perfNativeIdle
      return BrowserWindow.fromId(tracker.windowId)?.isFocused() ?? false
    }), { timeout: 10000 }).toBe(true)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()
    const heapStart = await cdp.snapshot()
    const logicalCores = os.cpus().length
    const warnings: string[] = []
    const windows: IdleWindow[] = []
    const idleStarted = performance.now()

    for (const [name, requestedDurationMs] of [['first10s', 10000], ['next50s', 50000]] as const) {
      const before = await readIdleState(app, window)
      const sampler = new ProcessMetricsSampler(app, SAMPLE_INTERVAL_MS, { cpuSource: 'cumulative' })
      samplers.push(sampler)
      await sampler.startAsync()
      const started = performance.now()
      await window.waitForTimeout(requestedDurationMs)
      const drained = await sampler.drainSettled()
      const durationMs = performance.now() - started
      const after = await readIdleState(app, window)
      const sampling = sampler.getSamplingStats()
      const cpuQuality = sampler.getCpuQuality()
      const failures = stateFailures(before, after)
      const minimumCpuSamples = Math.floor(requestedDurationMs / SAMPLE_INTERVAL_MS * 0.9)
      if (sampling.plannedTicks !== sampling.succeededTicks) failures.push('process sampling ticks failed')
      if (cpuQuality.source !== 'cumulative' || !cpuQuality.native) failures.push('native cumulative CPU identity was not recorded')
      if (cpuQuality.notMeasured.length || cpuQuality.noPrior.length) failures.push('one or more process CPU intervals were not measured')
      if (drained.totalRssAvgMB === null) failures.push('total RSS window was not measured')
      const perProcess = [...drained.byPid].map(([pid, stats]) => ({
        pid, type: before.native.processes.find(process => process.pid === pid)?.type ?? after.native.processes.find(process => process.pid === pid)?.type ?? null,
        ...stats, cpuOneCoreAvg: stats.cpuAvg * logicalCores, cpuOneCoreMax: stats.cpuMax * logicalCores,
      }))
      for (const process of before.native.processes) {
        const stats = drained.byPid.get(process.pid)
        if (!stats || stats.creationTime !== process.creationTime || (stats.cpuSampleCount ?? 0) < minimumCpuSamples) failures.push(`PID ${process.pid}: stable cumulative CPU coverage is incomplete`)
      }
      if (!before.native.processes.some(process => process.pid === runtime.mainPid) || !before.native.processes.some(process => process.pid === runtime.mainWindowPid)) failures.push('main process or Home renderer PID was missing')
      warnings.push(...failures.map(failure => `${name}: ${failure}`))
      windows.push({ name, requestedDurationMs, durationMs, sinceHomeInteractiveMs: started - launchStarted - firstScreenInteractiveMs, totalRssAvgMB: drained.totalRssAvgMB,
        sampling, cpuQuality, perProcess, before, after, valid: failures.length === 0, failures })
    }

    const heapEnd = await cdp.snapshot()
    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app)
    const unresponsiveCount = await readUnresponsiveCount(app)
    const valid = warnings.length === 0 && rendererReloads === 0 && crashCount === 0 && unresponsiveCount === 0
    const finalSampler = samplers[samplers.length - 1]
    const { cpu, mem } = finalSampler.summarize()
    const result: PerfResult & { startup: unknown; idle: unknown } = {
      scenario: 's1b-native-idle', label: currentLabel(), build: getBuildIdentity(), throttle: 1,
      durationMs: performance.now() - launchStarted, cpu, mem,
      sampling: samplers.map(sampler => sampler.getSamplingStats()).reduce((sum, stats) => ({ plannedTicks: sum.plannedTicks + stats.plannedTicks, succeededTicks: sum.succeededTicks + stats.succeededTicks }), { plannedTicks: 0, succeededTicks: 0 }),
      longtask: null, eventLatency: null,
      heap: { startMB: heapStart.heapMB, endMB: heapEnd.heapMB, deltaMB: heapEnd.heapMB - heapStart.heapMB },
      nodes: { start: heapStart.nodes, end: heapEnd.nodes, delta: heapEnd.nodes - heapStart.nodes },
      listeners: { start: heapStart.listeners, end: heapEnd.listeners, delta: heapEnd.listeners - heapStart.listeners },
      unresponsiveCount, rendererReloads, crashCount, valid, status: valid ? 'ok' : 'precondition-failed',
      warnings: warnings.length ? warnings : undefined,
      unmeasuredMetrics: ['longtask', 'eventLatency', 'startup.cpu', 'idle.totalRssPeakMB'],
      perProcess: finalSampler.summarizeByPid(),
      startup: { firstScreenInteractiveMs, bootstrapReadyMs, cpu: null, marker: 'Home conversation destination selected with its visible enabled empty composer' },
      idle: {
        runtime: { ...runtime, mainBundleSha256, logicalCores }, requestedDurationMs: 60000, durationMs: performance.now() - idleStarted,
        windows, cpuUnit: 'percent of one logical core', totalRssPeakMB: null, forcedGc: false,
        workload: 'Fresh isolated profile, empty Home, no conversation submission or content stream',
        control: { driver: 'Playwright Electron', rootFocusEmulation: true, nativeVisibleFocusedRequired: true,
          scope: 'Visible focused Home idle only. Playwright emulates document focus; native window state and blur/hide/minimize events are checked separately. No hidden, minimized or unfocused behavior is inferred.' },
      },
      note: 'Top-level CPU, memory and perProcess summaries describe next50s. Both independent native cumulative windows include priming and actual same-tick total RSS averages. Startup CPU, total RSS peak and interaction observers were not measured; heap snapshots were not forced through GC.',
    }
    expect(createHash('sha256').update(readFileSync(appEntryPath)).digest('hex'), 'the measured main bundle stayed fixed').toBe(mainBundleSha256)
    const file = writeResult(result)
    console.log(`[perf] native idle result written to ${file}`)
    expect(firstScreenInteractiveMs).toBeGreaterThan(0)
    expect(windows.reduce((sum, window) => sum + window.durationMs, 0)).toBeGreaterThanOrEqual(60000)
    expect(result.valid, 'both native idle windows must have stable focus, process identities and complete cumulative CPU samples').toBe(true)
  } finally {
    try {
      for (const sampler of samplers) await sampler.stopSettled()
    } finally {
      try {
        if (app) {
          try { await app.evaluate(() => { const state = globalThis as unknown as { perfNativeIdle?: IdleTracker }; state.perfNativeIdle?.dispose(); delete state.perfNativeIdle }) }
          finally { await app.close() }
        }
      } finally { cleanupTestConfigDir(profile) }
    }
  }
})
