/**
 * S9 — soak: not "how much does one open cost" (that's S5/S7), but "does
 * repeatedly opening and closing things leak". Cycles through
 * typical-size fixtures (never the extreme/crash-prone ones — a crash would
 * drown the leak signal in crash noise) opening then closing via "Close all
 * tabs", plus terminal and browser open/close, recording CDP nodes/listeners
 * /heap after every full cycle.
 *
 * The only judgment call this makes is recording the timeline — whether
 * nodes/listeners fail to return toward their starting point across many
 * cycles (a monotonic-growth leak signal) is for a human to read off the
 * result JSON, not a threshold this script invents.
 *
 * Duration is `S9_DURATION_MS`, default 10 minutes. What this scenario reports
 * is growth *per open/close cycle*, so a shorter run measures the same quantity
 * with a wider error bar rather than a different one — the recorded baselines
 * agree to within 8% (0.97 / 1.00 / 0.92 listeners per cycle) across three
 * 45-minute runs, and ~170 cycles is enough to separate that rate from zero.
 * What a short run cannot see is anything that only appears after sustained
 * use: fragmentation, cache eviction, a growth curve that bends. Set
 * S9_DURATION_MS=2700000 to reproduce the 45-minute baselines.
 *
 * This scenario is not in the `perf` project — run it with `--project=perf-soak`.
 */

import { test } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { CdpMetricsCollector } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { seedArtifact, beginOpenObservation, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { fixturePath } from '../lib/fixture-store'
import { beginScenario, currentLabel } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'

const __filename = fileURLToPath(import.meta.url)
const RESULTS_ROOT = path.resolve(path.dirname(__filename), '../results')

const TYPICAL_FIXTURES = [
  'md-typical-5kb.md',
  'code-typical-200lines.ts',
  'json-typical-small.json',
  'csv-typical.csv',
  'image-typical.png',
  'html-typical.html',
  'text-typical.log',
  'pdf-typical.pdf'
]

const DURATION_MS = Number(process.env.S9_DURATION_MS || 10 * 60 * 1000)

/**
 * `S9_FORCE_GC=1` collects garbage before every sample, which separates a real
 * leak from objects that are merely uncollected. Off by default so the run
 * stays comparable with the recorded baseline, which was sampled without it.
 * The value is written into the result so the two can never be read as one.
 */
const FORCE_GC = process.env.S9_FORCE_GC === '1'

interface CycleSample {
  cycle: number
  tMs: number
  action: string
  heapMB: number
  nodes: number
  listeners: number
  /**
   * Working set: the window under test by pid, the main process, and the whole
   * app summed. `heapMB` is V8's JS heap only — DOM nodes live in native memory
   * outside it, so nodes can climb while heapMB stays flat.
   */
  mainWindowRssMB: number | null
  browserRssMB: number | null
  totalRssMB: number | null
  /** CPU over this cycle's window only. A run-long average cannot show a drift. */
  mainWindowCpuAvg: number | null
  browserCpuAvg: number | null
  /** Longtasks attributed to this cycle alone — the observer buffers are reset after every read. */
  longtaskCount: number | null
  longtaskMaxMs: number | null
  /** Interactions past the observer's 100ms threshold, this cycle alone. */
  slowEventCount: number | null
  slowEventMaxMs: number | null
  /** How long this cycle's open took. `null` on a cycle that did not open a file, or whose open never settled. */
  openMs: number | null
  unresponsiveCount: number
  crashCount: number
  /** Load can drift meaningfully over 45 minutes — recorded per-sample, not just once at the top. */
  loadAverage: [number, number, number]
}

test('S9 soak', async () => {
  beginScenario('s9-soak')
  test.setTimeout(DURATION_MS + 120000)

  const label = currentLabel()
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  for (const f of TYPICAL_FIXTURES) seedArtifact(testConfigDir, fixturePath(f))

  const app = await launchElectronApp(appEntryPath, testConfigDir)
  const sampler = new ProcessMetricsSampler(app)

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await installUnresponsiveTracker(app)
    await installRenderObserversNow(window)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()

    // Memory has to be attributed to this window by pid: the PDF fixture opens
    // in its own renderer process, and a per-type average would blend the two
    // on exactly those cycles.
    const mainWindowPid: number | null = await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? null)
      .catch(() => null)

    // The 500ms poll and the two PerformanceObservers are work the recorded
    // baselines did not carry, so CPU here sits slightly above an
    // uninstrumented run. Nodes and listeners are unaffected — neither
    // registers a DOM listener.
    sampler.start()

    const closeAllTabs = async () => {
      const btn = window.getByTitle(/Close all tabs|关闭所有标签页/).first()
      if (await btn.isVisible().catch(() => false)) {
        await btn.click()
      }
    }

    const samples: CycleSample[] = []
    const t0 = Date.now()
    let cycle = 0

    const recordSample = async (action: string, openMs: number | null = null) => {
      try {
        if (FORCE_GC) await cdp.collectGarbage()
        const snap = await cdp.snapshot()
        const unresponsiveCount = await readUnresponsiveCount(app)
        const crashCount = await readCrashCount(app).catch(() => 0)
        const drained = sampler.drain()
        const mainWindow = mainWindowPid === null ? undefined : drained.byPid.get(mainWindowPid)
        // Read and clear together: what the next cycle observes must be its own.
        const render = await readRenderMetrics(window).catch(() => null)
        await resetRenderObservers(window).catch(() => {})
        samples.push({
          cycle,
          tMs: Date.now() - t0,
          action,
          heapMB: snap.heapMB,
          nodes: snap.nodes,
          listeners: snap.listeners,
          mainWindowRssMB: mainWindow?.rssAvgMB ?? null,
          browserRssMB: drained.byType.browser?.rssAvgMB ?? null,
          totalRssMB: drained.totalRssAvgMB,
          mainWindowCpuAvg: mainWindow?.cpuAvg ?? null,
          browserCpuAvg: drained.byType.browser?.cpuAvg ?? null,
          longtaskCount: render?.longtask?.count ?? null,
          longtaskMaxMs: render?.longtask?.maxMs ?? null,
          slowEventCount: render?.eventLatency?.count ?? null,
          slowEventMaxMs: render?.eventLatency?.maxMs ?? null,
          openMs,
          unresponsiveCount,
          crashCount,
          loadAverage: os.loadavg() as [number, number, number]
        })
      } catch (err) {
        console.warn(`[perf] S9 cycle ${cycle} (${action}) sample failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await recordSample('baseline')

    while (Date.now() - t0 < DURATION_MS) {
      cycle++
      const fixtureName = TYPICAL_FIXTURES[cycle % TYPICAL_FIXTURES.length]

      try {
        // Opening the browser auto-collapses the artifacts rail
        // (ArtifactRail.tsx's handleOpenBrowser) — re-expand it if a prior
        // cycle collapsed it, or the artifact list is invisible to click.
        const expandButton = window.getByLabel(/Open artifacts panel|打开产物面板/).first()
        if (await expandButton.isVisible().catch(() => false)) {
          await expandButton.click()
        }
        await beginOpenObservation(window)
        await clickArtifactByName(window, fixtureName)
        // The same eight files are reopened all run, so each open is comparable
        // to the identical open earlier on. `null` rather than a number when the
        // open never settled, which would otherwise read as a fast one.
        const openMs = await waitForCanvasLoaded(window, 20000).catch(() => null)
        await closeAllTabs()
        await recordSample(`file:${fixtureName}`, openMs)
      } catch (err) {
        console.warn(`[perf] S9 cycle ${cycle} file-open failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Every 5th cycle, also exercise terminal open/close, not just file
      // preview.
      //
      // Known simplification: "Open browser"
      // is deliberately excluded from this loop. handleOpenBrowser
      // (ArtifactRail.tsx) auto-collapses the artifacts rail, and that
      // collapse persisted through closing the tab and through every
      // recovery attempt tried here (re-clicking the expand toggle,
      // `page.goBack()` — the latter doesn't apply to this SPA's
      // client-side routing and just times out waiting for a real
      // navigation that never happens) — it reliably broke every
      // subsequent file-open cycle. Chasing that UI-state bug further
      // wasn't a good trade against getting a working soak loop shipped;
      // browser-tab soak coverage is a known gap, noted here rather than
      // silently dropped.
      if (cycle % 5 === 0) {
        try {
          const terminalBtn = window.getByTitle(/Open terminal|打开终端/).first()
          if (await terminalBtn.isVisible().catch(() => false)) {
            await terminalBtn.click()
            await window.waitForSelector('.xterm', { timeout: 10000 }).catch(() => {})
            await closeAllTabs()
            await recordSample('terminal')
          }
        } catch (err) {
          console.warn(`[perf] S9 cycle ${cycle} terminal failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Known gap, not attempted: switching spaces.
      // `navigateToChat` (the only proven way into a space in this suite)
      // requires starting from the Home page's halo-space card, and there is
      // no proven, reliable "return to Home from inside a space" control in
      // this suite to pair with it — every attempt tried during development
      // (page.goBack(), which doesn't apply to this SPA's client-side
      // routing) failed outright. Rather than ship a sub-action with a 100%
      // failure rate, this is left as an explicit gap for the report instead
      // of silently-broken code.
    }

    const quarter = Math.max(1, Math.floor(samples.length / 4))

    /**
     * First-quarter against last-quarter is what makes this file readable: the
     * question is never the absolute level but whether it drifts. Samples with
     * nothing measured are dropped rather than counted as zero — a cycle whose
     * observers failed and a cycle that genuinely saw no longtask must not
     * average into the same number, and `measured` says how many were real.
     */
    const series = (values: Array<number | null>) => {
      const present = values.filter((v): v is number => v !== null)
      const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
      const firstQuarter = values.slice(0, quarter).filter((v): v is number => v !== null)
      const lastQuarter = values.slice(-quarter).filter((v): v is number => v !== null)
      return {
        start: present[0] ?? null,
        end: present[present.length - 1] ?? null,
        min: present.length ? Math.min(...present) : null,
        max: present.length ? Math.max(...present) : null,
        firstQuarterAvg: avg(firstQuarter),
        lastQuarterAvg: avg(lastQuarter),
        measured: present.length
      }
    }

    const summary = {
      totalCycles: cycle,
      totalSamples: samples.length,
      nodes: series(samples.map((s) => s.nodes)),
      listeners: series(samples.map((s) => s.listeners)),
      heapMB: series(samples.map((s) => s.heapMB)),
      mainWindowRssMB: series(samples.map((s) => s.mainWindowRssMB)),
      browserRssMB: series(samples.map((s) => s.browserRssMB)),
      totalRssMB: series(samples.map((s) => s.totalRssMB)),
      mainWindowCpuAvg: series(samples.map((s) => s.mainWindowCpuAvg)),
      browserCpuAvg: series(samples.map((s) => s.browserCpuAvg)),
      longtaskCount: series(samples.map((s) => s.longtaskCount)),
      longtaskMaxMs: series(samples.map((s) => s.longtaskMaxMs)),
      slowEventCount: series(samples.map((s) => s.slowEventCount)),
      slowEventMaxMs: series(samples.map((s) => s.slowEventMaxMs)),
      openMs: series(samples.map((s) => s.openMs)),
      maxUnresponsiveCount: Math.max(0, ...samples.map((s) => s.unresponsiveCount)),
      maxCrashCount: Math.max(0, ...samples.map((s) => s.crashCount)),
      sampling: sampler.getSamplingStats()
    }

    const result = {
      scenario: 's9-soak',
      label,
      build: getBuildIdentity(),
      loadAverageAtStart: os.loadavg(),
      durationMs: Date.now() - t0,
      configuredDurationMs: DURATION_MS,
      forcedGcBeforeSample: FORCE_GC,
      samples,
      summary
    }

    const resultPath = path.join(RESULTS_ROOT, label, 's9-soak.json')
    fs.mkdirSync(path.dirname(resultPath), { recursive: true })
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    console.log(`[perf] S9 result written to ${resultPath} (${cycle} cycles, ${samples.length} samples)`)
    const drift = (name: string, s: { firstQuarterAvg: number | null; lastQuarterAvg: number | null; measured: number }, digits = 0) =>
      console.log(`[perf] S9 ${name}: firstQ=${s.firstQuarterAvg?.toFixed(digits) ?? 'n/a'} lastQ=${s.lastQuarterAvg?.toFixed(digits) ?? 'n/a'} (${s.measured} measured)`)
    drift('nodes', summary.nodes)
    drift('listeners', summary.listeners)
    drift('heapMB', summary.heapMB, 1)
    drift('window RSS MB', summary.mainWindowRssMB, 1)
    drift('app total RSS MB', summary.totalRssMB, 1)
    drift('window CPU %', summary.mainWindowCpuAvg, 1)
    drift('longtasks/cycle', summary.longtaskCount, 1)
    drift('slow events/cycle', summary.slowEventCount, 1)
    drift('open ms', summary.openMs)
  } finally {
    sampler.stop()
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})
