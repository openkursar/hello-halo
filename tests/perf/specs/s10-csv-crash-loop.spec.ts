/**
 * S10 — Watch a 5MB CSV open for 90s instead of ending at the first crash, so
 * the whole mechanism lands in one recording:
 *
 *   crash (render-process-gone) -> recoverRenderer() silently reloads ->
 *   [if it crashes 3x within 60s] -> relaunchApp() (app.relaunch() +
 *   app.exit(0), the whole process restarts)
 *
 * which is the concrete, reproducible version of the user's own words
 * ("卡死，需要强制退出"). Screenshots are the primary artifact here — they
 * are what the user actually sees, which crashCount/reloadCount alone
 * cannot show.
 *
 * The fixture is the *tall* 5MB CSV (269k short rows), not the wide one S5
 * opens. Row count is what the crash tracked: the wide 5MB file holds ~67k
 * rows and stopped crashing once row virtualization landed, while the narrow
 * shape kept throwing from a per-row spread argument inside a `useMemo`,
 * where the nearest boundary is the renderer root. Pointing this at the file
 * that no longer crashes would have left the check permanently green.
 *
 * This does not fit the standard S1-S9 PerfResult schema (it is a timeline,
 * not a single before/after measurement) — it writes its own JSON alongside
 * a directory of timestamped screenshots.
 */

import { expect, test } from '@playwright/test'
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
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { seedArtifact, clickArtifactByName } from '../lib/open-artifact'
import { isRendererFatal } from '../lib/renderer-fatal'
import { fixturePath } from '../lib/fixture-store'
import { beginScenario, currentLabel } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'

const __filename = fileURLToPath(import.meta.url)
const RESULTS_ROOT = path.resolve(path.dirname(__filename), '../results')

interface TimelineEntry {
  tMs: number
  crashCount: number | 'unreachable'
  unresponsiveCount: number | 'unreachable'
  processAlive: boolean
  /** React caught the throw and replaced the UI — no crash, no reload, nothing left. */
  rendererFatal: boolean
  /** Crash likelihood appears load-dependent (S4 froze at low load, crashed at high load) — record it at every sample, not just once. */
  loadAverage: [number, number, number]
  screenshot?: string
}

test('S10 csv crash-loop observation', async () => {
  beginScenario('s10-csv-crash-loop')
  test.setTimeout(180000)

  const label = currentLabel()
  const outDir = path.join(RESULTS_ROOT, label, 's10-screenshots')
  fs.mkdirSync(outDir, { recursive: true })

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const { name: artifactName } = seedArtifact(testConfigDir, fixturePath('csv-extreme-tall.csv'))

  const app = await launchElectronApp(appEntryPath, testConfigDir)
  const t0 = Date.now()
  const timeline: TimelineEntry[] = []
  let window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await navigateToChat(window)
  await installUnresponsiveTracker(app)

  // Trigger the crash — don't wait for it to "finish loading", just click and move on.
  await clickArtifactByName(window, artifactName)

  const observeWindowMs = 90000
  const pollIntervalMs = 5000
  const deadline = Date.now() + observeWindowMs
  let pollIndex = 0

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    pollIndex++
    const tMs = Date.now() - t0

    let crashCount: number | 'unreachable' = 'unreachable'
    let unresponsiveCount: number | 'unreachable' = 'unreachable'
    let processAlive = false
    let rendererFatal = false
    let screenshot: string | undefined

    try {
      processAlive = app.process() !== null && app.process()?.exitCode === null
      crashCount = await readCrashCount(app)
      unresponsiveCount = await readUnresponsiveCount(app)
    } catch {
      // app.evaluate() failing here is itself informative: the main process
      // is unreachable, consistent with an in-flight relaunch (app.exit(0)
      // killed the old process before a replacement CDP connection exists).
    }

    try {
      // Playwright's `window` handle may point at a destroyed BrowserWindow
      // after a reload/relaunch — try to re-acquire the current one each poll
      // rather than assume the original handle is still valid.
      const liveWindow = await app.firstWindow().catch(() => null)
      if (liveWindow) {
        window = liveWindow
        rendererFatal = await isRendererFatal(window)
        const shotPath = path.join(outDir, `t${String(tMs).padStart(7, '0')}ms.png`)
        await window.screenshot({ path: shotPath, timeout: 5000 })
        screenshot = path.relative(RESULTS_ROOT, shotPath)
      }
    } catch {
      // Screenshot failure (no reachable window) is itself informative — recorded as absent.
    }

    timeline.push({ tMs, crashCount, unresponsiveCount, processAlive, rendererFatal, loadAverage: os.loadavg() as [number, number, number], screenshot })
    console.log(`[perf] S10 t+${tMs}ms crashCount=${crashCount} unresponsive=${unresponsiveCount} processAlive=${processAlive} rendererFatal=${rendererFatal} screenshot=${screenshot ?? 'none'}`)
  }

  const result = {
    scenario: 's10-csv-crash-loop',
    label,
    build: getBuildIdentity(),
    loadAverageAtStart: os.loadavg(),
    observeWindowMs,
    pollIntervalMs,
    timeline,
    summary: {
      maxCrashCountObserved: Math.max(0, ...timeline.map((e) => (typeof e.crashCount === 'number' ? e.crashCount : 0))),
      everUnreachable: timeline.some((e) => e.crashCount === 'unreachable'),
      everRendererFatal: timeline.some((e) => e.rendererFatal),
      finalProcessAlive: timeline[timeline.length - 1]?.processAlive ?? null
    }
  }

  const resultPath = path.join(RESULTS_ROOT, label, 's10-csv-crash-loop.json')
  fs.mkdirSync(path.dirname(resultPath), { recursive: true })
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
  console.log(`[perf] S10 result written to ${resultPath}, ${timeline.length} screenshots in ${outDir}`)

  await app.close().catch(() => {})
  cleanupTestConfigDir(testConfigDir)

  // Asserted after the artifacts are written: the screenshots and timeline are
  // what a failure gets diagnosed from, so they must survive it.
  expect(result.summary.everUnreachable, 'the main process went unreachable — the app relaunched itself').toBe(false)
  expect(result.summary.maxCrashCountObserved, 'the renderer crashed opening a 5MB CSV').toBe(0)
  // Listed last because it is the one that actually fires: the throw this
  // scenario guards against is caught by React, so the process survives and
  // only this flag moves.
  expect(result.summary.everRendererFatal, 'the UI was replaced by the root error boundary').toBe(false)
})
