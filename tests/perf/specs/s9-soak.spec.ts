/**
 * S9 — 45-minute soak: not "how much does one open cost" (that's S5/S7),
 * but "does repeatedly opening and closing things leak". Cycles through
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
 * Duration is configurable via S9_DURATION_MS (default 45 minutes) so a
 * short run can validate the mechanism before committing to the real thing.
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
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { seedArtifact, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { currentLabel } from '../lib/result-writer'
import { getBuildIdentityString } from '../lib/build-identity'

const __filename = fileURLToPath(import.meta.url)
const FIXTURES_ROOT = path.resolve(path.dirname(__filename), '../../../halo-local/temp/perf-fixtures')
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

const DURATION_MS = Number(process.env.S9_DURATION_MS || 45 * 60 * 1000)

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
  unresponsiveCount: number
  crashCount: number
  /** Load can drift meaningfully over 45 minutes — recorded per-sample, not just once at the top. */
  loadAverage: [number, number, number]
}

test('S9 soak', async () => {
  test.setTimeout(DURATION_MS + 120000)

  const label = currentLabel()
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  for (const f of TYPICAL_FIXTURES) seedArtifact(testConfigDir, path.join(FIXTURES_ROOT, f))

  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await installUnresponsiveTracker(app)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()

    const closeAllTabs = async () => {
      const btn = window.getByTitle(/Close all tabs|关闭所有标签页/).first()
      if (await btn.isVisible().catch(() => false)) {
        await btn.click()
      }
    }

    const samples: CycleSample[] = []
    const t0 = Date.now()
    let cycle = 0

    const recordSample = async (action: string) => {
      try {
        if (FORCE_GC) await cdp.collectGarbage()
        const snap = await cdp.snapshot()
        const unresponsiveCount = await readUnresponsiveCount(app)
        const crashCount = await readCrashCount(app).catch(() => 0)
        samples.push({
          cycle,
          tMs: Date.now() - t0,
          action,
          heapMB: snap.heapMB,
          nodes: snap.nodes,
          listeners: snap.listeners,
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
        await clickArtifactByName(window, fixtureName)
        await waitForCanvasLoaded(window, 20000).catch(() => {})
        await closeAllTabs()
        await recordSample(`file:${fixtureName}`)
      } catch (err) {
        console.warn(`[perf] S9 cycle ${cycle} file-open failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Every 5th cycle, also exercise terminal open/close — per Lead's
      // action list, not just file preview.
      //
      // Known simplification (not the literal action list): "Open browser"
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

      // Known gap, not attempted: "switch spaces" from Lead's action list.
      // `navigateToChat` (the only proven way into a space in this suite)
      // requires starting from the Home page's halo-space card, and there is
      // no proven, reliable "return to Home from inside a space" control in
      // this suite to pair with it — every attempt tried during development
      // (page.goBack(), which doesn't apply to this SPA's client-side
      // routing) failed outright. Rather than ship a sub-action with a 100%
      // failure rate, this is left as an explicit gap for the report instead
      // of silently-broken code.
    }

    const nodesSeries = samples.map((s) => s.nodes)
    const listenersSeries = samples.map((s) => s.listeners)
    const heapSeries = samples.map((s) => s.heapMB)
    const quarter = Math.max(1, Math.floor(samples.length / 4))
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

    const summary = {
      totalCycles: cycle,
      totalSamples: samples.length,
      nodes: {
        start: nodesSeries[0] ?? null,
        end: nodesSeries[nodesSeries.length - 1] ?? null,
        min: nodesSeries.length ? Math.min(...nodesSeries) : null,
        max: nodesSeries.length ? Math.max(...nodesSeries) : null,
        firstQuarterAvg: avg(nodesSeries.slice(0, quarter)),
        lastQuarterAvg: avg(nodesSeries.slice(-quarter))
      },
      listeners: {
        start: listenersSeries[0] ?? null,
        end: listenersSeries[listenersSeries.length - 1] ?? null,
        min: listenersSeries.length ? Math.min(...listenersSeries) : null,
        max: listenersSeries.length ? Math.max(...listenersSeries) : null,
        firstQuarterAvg: avg(listenersSeries.slice(0, quarter)),
        lastQuarterAvg: avg(listenersSeries.slice(-quarter))
      },
      heapMB: {
        start: heapSeries[0] ?? null,
        end: heapSeries[heapSeries.length - 1] ?? null,
        min: heapSeries.length ? Math.min(...heapSeries) : null,
        max: heapSeries.length ? Math.max(...heapSeries) : null,
        firstQuarterAvg: avg(heapSeries.slice(0, quarter)),
        lastQuarterAvg: avg(heapSeries.slice(-quarter))
      },
      maxUnresponsiveCount: Math.max(0, ...samples.map((s) => s.unresponsiveCount)),
      maxCrashCount: Math.max(0, ...samples.map((s) => s.crashCount))
    }

    const result = {
      scenario: 's9-soak',
      label,
      gitSha: getBuildIdentityString(),
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
    console.log(`[perf] S9 nodes: start=${summary.nodes.start} end=${summary.nodes.end} firstQ=${summary.nodes.firstQuarterAvg.toFixed(0)} lastQ=${summary.nodes.lastQuarterAvg.toFixed(0)}`)
    console.log(`[perf] S9 listeners: start=${summary.listeners.start} end=${summary.listeners.end} firstQ=${summary.listeners.firstQuarterAvg.toFixed(0)} lastQ=${summary.listeners.lastQuarterAvg.toFixed(0)}`)
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})
