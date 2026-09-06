/**
 * S9-PROBE — does the renderer listener leak found in S9 soak depend on
 * opening files through ArtifactTree (react-arborist, NodeApi.select()/focus()
 * per click), or does it reproduce with an equivalent open path that never
 * touches react-arborist?
 *
 * A probe copy, kept separate from s9-soak.spec.ts (the frozen baseline
 * script) so that script's numbers stay comparable across rounds.
 *
 * Controlled by S9_PROBE_VIEWMODE:
 *   'tree' (default) — reproduces the original S9 path: ArtifactRail's
 *     default view mode, clicking a file row calls ArtifactTree.tsx's
 *     handleClick -> node.select(); node.focus(); openFile(...).
 *   'card' — clicks "Switch to card view" once before the loop starts, so
 *     every subsequent file open goes through ArtifactCard.tsx's handleClick
 *     -> openFile(...) directly. No NodeApi, no react-arborist, no select()/
 *     focus() call anywhere in this path.
 *
 * Everything else (fixtures, cycle structure, terminal cadence, CDP
 * sampling) is copied verbatim from s9-soak.spec.ts so the two runs are
 * comparable apples-to-apples.
 *
 * Bundled into the same run so only one probe script is needed: a
 * `getEventListeners()` snapshot of `document` and `window`,
 * taken twice — once early in the loop, once 20 cycles later — diffed by
 * `type:useCapture` to see which listener type is actually accumulating and
 * on which target. See `captureListenerDistribution()` below for the CDP
 * mechanics and the caveats around `includeCommandLineAPI`.
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
import { seedArtifact, beginOpenObservation, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { fixturePath } from '../lib/fixture-store'
import type { CDPSession } from '@playwright/test'
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
// Two accepted spellings for the same knob, kept because both are already in
// use. Card view is what actually skips the ArtifactTree/react-arborist click
// path (see file header).
const PROBE_VIEWMODE =
  process.env.S9_PROBE_VIEWMODE === 'card' || process.env.PROBE_SKIP_TREE_CLICK === '1'
    ? 'card'
    : 'tree'

// Cycle at which to take the first getEventListeners() snapshot (let the
// loop run a few iterations past startup/onboarding jitter first), and how
// many cycles later to take the second one for the diff.
const LISTENER_DIFF_START_CYCLE = 10
const LISTENER_DIFF_CYCLE_GAP = 20

interface CycleSample {
  cycle: number
  tMs: number
  action: string
  heapMB: number
  nodes: number
  listeners: number
  unresponsiveCount: number
  crashCount: number
  loadAverage: [number, number, number]
}

type ListenerDistribution = Record<string, number>

interface ListenerSnapshot {
  cycle: number
  tMs: number
  ok: boolean
  error?: string
  /** Per compound key `${type}:capture=${useCapture}`, listener count. */
  document?: ListenerDistribution
  window?: ListenerDistribution
}

/**
 * Sample `getEventListeners(document)` / `getEventListeners(window)` via a
 * raw CDP `Runtime.evaluate` call.
 *
 * `getEventListeners` is a DevTools "Command Line API" function — it does
 * NOT exist on `window` normally, so a plain `page.evaluate()` cannot see
 * it. CDP exposes it by setting `includeCommandLineAPI: true` on the
 * `Runtime.evaluate` params; this is documented CDP behavior (the same
 * mechanism the actual DevTools console frontend uses to inject `$`, `$$`,
 * `getEventListeners`, `monitorEvents`, etc. into whatever expression it
 * evaluates) and does not require the DevTools UI to be open — a bare
 * CDPSession from Playwright is enough. Reference: Runtime.evaluate's
 * `includeCommandLineAPI` param in the CDP spec; this is the same call
 * shape Puppeteer users use for the identical purpose.
 *
 * If `includeCommandLineAPI` turns out not to inject `getEventListeners` in
 * this Electron/Chromium build, `raw.exceptionDetails` will say so and this
 * function reports `ok: false` with the error message instead of crashing the
 * whole soak run — the tree-vs-card A/B, the higher-value experiment, still
 * completes either way.
 *
 * `getEventListeners(target)` returns `{ [type]: Array<{ useCapture,
 * passive, once, listener }> }`. `listener` (a function) is not
 * JSON-cloneable, so the in-page expression below reduces it to counts per
 * `type:useCapture` compound key before returning — `returnByValue: true`
 * would otherwise fail to serialize the raw listener objects.
 */
async function captureListenerDistribution(
  cdpSession: CDPSession,
  cycle: number,
  tMs: number
): Promise<ListenerSnapshot> {
  const expression = `
    (() => {
      function distribution(target) {
        const out = {}
        let listenersByType
        try {
          listenersByType = getEventListeners(target)
        } catch (e) {
          return { __error: 'getEventListeners threw: ' + (e && e.message) }
        }
        for (const type of Object.keys(listenersByType)) {
          for (const l of listenersByType[type]) {
            const key = type + ':capture=' + !!l.useCapture
            out[key] = (out[key] || 0) + 1
          }
        }
        return out
      }
      return {
        document: distribution(document),
        window: distribution(window)
      }
    })()
  `

  try {
    const raw = (await cdpSession.send('Runtime.evaluate', {
      expression,
      includeCommandLineAPI: true,
      returnByValue: true
    })) as {
      result?: { value?: { document?: ListenerDistribution; window?: ListenerDistribution } }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }

    if (raw.exceptionDetails) {
      const msg = raw.exceptionDetails.exception?.description || raw.exceptionDetails.text || 'unknown Runtime.evaluate exception'
      return { cycle, tMs, ok: false, error: msg }
    }

    const value = raw.result?.value
    if (!value || (!value.document && !value.window)) {
      return { cycle, tMs, ok: false, error: 'Runtime.evaluate returned no usable value (getEventListeners likely unavailable via includeCommandLineAPI in this build)' }
    }

    return { cycle, tMs, ok: true, document: value.document, window: value.window }
  } catch (err) {
    return { cycle, tMs, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Diff two listener-count maps: positive = grew, negative = shrank. */
function diffDistributions(before: ListenerDistribution = {}, after: ListenerDistribution = {}): ListenerDistribution {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const diff: ListenerDistribution = {}
  for (const k of keys) {
    const d = (after[k] || 0) - (before[k] || 0)
    if (d !== 0) diff[k] = d
  }
  return diff
}

test('S9 soak probe', async () => {
  beginScenario('s9-soak-probe')
  test.setTimeout(DURATION_MS + 120000)

  const label = currentLabel()
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  for (const f of TYPICAL_FIXTURES) seedArtifact(testConfigDir, fixturePath(f))

  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await installUnresponsiveTracker(app)

    // Switch to card view BEFORE the loop starts, so every open in this run
    // goes through ArtifactCard.tsx (no react-arborist NodeApi involved) —
    // the "B group" of the A/B comparison. Default (no toggle) reproduces
    // the original S9 tree-view path ("A group").
    if (PROBE_VIEWMODE === 'card') {
      const toggleBtn = window.getByTitle(/Switch to card view|切换到卡片视图/).first()
      await toggleBtn.waitFor({ state: 'visible', timeout: 15000 })
      await toggleBtn.click()
      // Card view lazy-loads the artifact list via IPC (ArtifactRail's
      // loadArtifacts) — give it a moment before the loop starts clicking.
      await window.waitForTimeout(500)
    }

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()

    // Separate raw CDP session for the getEventListeners() experiment — kept
    // independent from CdpMetricsCollector's internal session (that class
    // only exposes Performance.getMetrics; adding a second session here
    // avoids touching the shared lib file while the baseline run depends on
    // it staying frozen).
    const listenerCdp: CDPSession = await window.context().newCDPSession(window)
    await listenerCdp.send('Runtime.enable')
    const listenerSnapshots: ListenerSnapshot[] = []

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
        console.warn(`[perf] S9-probe cycle ${cycle} (${action}) sample failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await recordSample('baseline')

    while (Date.now() - t0 < DURATION_MS) {
      cycle++
      const fixtureName = TYPICAL_FIXTURES[cycle % TYPICAL_FIXTURES.length]

      try {
        if (PROBE_VIEWMODE === 'tree') {
          // Same collapse/expand recovery as the original S9 (tree view only
          // — card view's footer button is always visible regardless).
          const expandButton = window.getByLabel(/Open artifacts panel|打开产物面板/).first()
          if (await expandButton.isVisible().catch(() => false)) {
            await expandButton.click()
          }
        }
        await beginOpenObservation(window)
        await clickArtifactByName(window, fixtureName)
        await waitForCanvasLoaded(window, 20000).catch(() => {})
        await closeAllTabs()
        await recordSample(`file:${fixtureName}`)
      } catch (err) {
        console.warn(`[perf] S9-probe cycle ${cycle} file-open failed: ${err instanceof Error ? err.message : String(err)}`)
      }

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
          console.warn(`[perf] S9-probe cycle ${cycle} terminal failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Two getEventListeners() snapshots, LISTENER_DIFF_CYCLE_GAP
      // cycles apart, diffed after the loop ends (see bottom of test for the diff + write-out).
      if (cycle === LISTENER_DIFF_START_CYCLE || cycle === LISTENER_DIFF_START_CYCLE + LISTENER_DIFF_CYCLE_GAP) {
        const snap = await captureListenerDistribution(listenerCdp, cycle, Date.now() - t0)
        listenerSnapshots.push(snap)
        if (!snap.ok) {
          console.warn(`[perf] S9-probe getEventListeners snapshot at cycle ${cycle} failed: ${snap.error}`)
        }
      }
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

    // If the run was too short to reach the second checkpoint cycle, take it
    // now (better a late diff than none) rather than silently shipping an
    // empty listenerSnapshots array.
    if (listenerSnapshots.length < 2 && cycle >= LISTENER_DIFF_START_CYCLE) {
      const snap = await captureListenerDistribution(listenerCdp, cycle, Date.now() - t0)
      listenerSnapshots.push(snap)
    }

    const listenerDiff =
      listenerSnapshots.length >= 2 && listenerSnapshots[0].ok && listenerSnapshots[listenerSnapshots.length - 1].ok
        ? {
            fromCycle: listenerSnapshots[0].cycle,
            toCycle: listenerSnapshots[listenerSnapshots.length - 1].cycle,
            document: diffDistributions(listenerSnapshots[0].document, listenerSnapshots[listenerSnapshots.length - 1].document),
            window: diffDistributions(listenerSnapshots[0].window, listenerSnapshots[listenerSnapshots.length - 1].window)
          }
        : null

    const result = {
      scenario: 's9-soak-probe',
      probeViewMode: PROBE_VIEWMODE,
      label,
      build: getBuildIdentity(),
      loadAverageAtStart: os.loadavg(),
      durationMs: Date.now() - t0,
      configuredDurationMs: DURATION_MS,
      samples,
      summary,
      listenerSnapshots,
      listenerDiff
    }

    const resultPath = path.join(RESULTS_ROOT, label, 's9-soak-probe.json')
    fs.mkdirSync(path.dirname(resultPath), { recursive: true })
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    console.log(`[perf] S9-probe (${PROBE_VIEWMODE}) result written to ${resultPath} (${cycle} cycles, ${samples.length} samples)`)
    console.log(`[perf] S9-probe listeners: start=${summary.listeners.start} end=${summary.listeners.end} firstQ=${summary.listeners.firstQuarterAvg.toFixed(0)} lastQ=${summary.listeners.lastQuarterAvg.toFixed(0)}`)
    if (listenerDiff) {
      console.log(`[perf] S9-probe getEventListeners diff (cycle ${listenerDiff.fromCycle}->${listenerDiff.toCycle}): document=${JSON.stringify(listenerDiff.document)} window=${JSON.stringify(listenerDiff.window)}`)
    } else {
      console.warn('[perf] S9-probe getEventListeners diff unavailable — see listenerSnapshots[].error in the result JSON')
    }
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})
