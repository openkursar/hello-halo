/**
 * S12 — switching between two open code tabs, back and forth.
 *
 * Each canvas tab mounts its own viewer, so every switch rebuilds the editor
 * for the file being shown (before, same-type tabs shared one editor and a
 * switch was an undoable whole-document replace). This measures what that
 * costs and whether it leaves anything behind:
 *
 * - per-switch settle time (same-machine comparison only — not gateable);
 * - DOM nodes and listeners after every switch: showing A then B then A again
 *   must land on the same counts, so any drift across 20 switches is growth
 *   the switch leaves behind (structural, gateable);
 * - JS heap after a forced collection at the start and the end.
 *
 * Preconditions checked before any number is read: both tabs opened, every
 * switch landed on the tab it clicked, no renderer reload or crash.
 *
 * `S12_SWITCHES` sets the switch count (default 20); `S12_FIXTURE` the file
 * (default the 20,000-line code fixture, opened twice under two names).
 */

import { test, expect } from '@playwright/test'
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
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { installRenderObserversNow } from '../lib/render-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { seedArtifact, beginOpenObservation, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { fixturePath } from '../lib/fixture-store'
import { beginScenario, currentLabel } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'

const __filename = fileURLToPath(import.meta.url)
const RESULTS_ROOT = path.resolve(path.dirname(__filename), '../results')

const SWITCHES = Number(process.env.S12_SWITCHES || 20)
const FIXTURE = process.env.S12_FIXTURE || 'code-extreme-20000lines.ts'

interface SwitchSample {
  index: number
  target: string
  landed: boolean
  settleMs: number | null
  nodes: number
  listeners: number
  heapMB: number
}

test('S12 canvas tab switch', async () => {
  beginScenario('s12-canvas-tab-switch')
  test.setTimeout(10 * 60 * 1000)

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const first = seedArtifact(testConfigDir, fixturePath(FIXTURE))
  const ext = path.extname(first.name)
  const secondName = `${path.basename(first.name, ext)}-second${ext}`
  fs.copyFileSync(first.destPath, path.join(path.dirname(first.destPath), secondName))
  const names = [first.name, secondName]

  const app = await launchElectronApp(appEntryPath, testConfigDir)
  const problems: string[] = []
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await installRenderObserversNow(window)
    await installUnresponsiveTracker(app)
    const reloadGuard = installReloadGuard(window)
    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()

    for (const name of names) {
      await beginOpenObservation(window)
      await clickArtifactByName(window, name)
      await waitForCanvasLoaded(window, 60000)
    }
    const openTabs = await window.locator('.canvas-tab-bar .canvas-tab-title').allInnerTexts()
    const bothOpen = names.every((name) => openTabs.includes(name))
    if (!bothOpen) problems.push(`expected tabs ${names.join(', ')}, found ${openTabs.join(', ')}`)

    const activeTitle = () =>
      window.locator('.canvas-tab-bar .canvas-tab.active .canvas-tab-title').first().innerText().catch(() => '')

    await cdp.collectGarbage()
    const start: CdpSnapshot = await cdp.snapshot()
    const samples: SwitchSample[] = []
    const t0 = Date.now()

    for (let i = 0; i < SWITCHES && bothOpen; i++) {
      const target = names[i % 2]
      await beginOpenObservation(window)
      await window.locator('.canvas-tab-bar .canvas-tab-title', { hasText: target }).first().click({ noWaitAfter: true })
      const settleMs = await waitForCanvasLoaded(window, 30000).catch((err: unknown) => {
        problems.push(`switch ${i} to ${target} did not settle: ${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      const landed = (await activeTitle()) === target
      if (!landed) problems.push(`switch ${i} clicked ${target} but the active tab is "${await activeTitle()}"`)
      const snap = await cdp.snapshot()
      samples.push({ index: i, target, landed, settleMs, nodes: snap.nodes, listeners: snap.listeners, heapMB: snap.heapMB })
    }

    await cdp.collectGarbage()
    const end: CdpSnapshot = await cdp.snapshot()
    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    if (rendererReloads > 0) problems.push(`renderer reloaded ${rendererReloads}x`)
    if (crashCount > 0) problems.push(`renderer crashed ${crashCount}x`)
    if (samples.length !== SWITCHES) problems.push(`${samples.length}/${SWITCHES} switches measured`)

    // Same file shown after every even switch: its counts must repeat.
    const sameTarget = (k: 0 | 1) => samples.filter((s) => s.index % 2 === k)
    const drift = (list: SwitchSample[], pick: (s: SwitchSample) => number) =>
      list.length >= 2 ? pick(list[list.length - 1]) - pick(list[0]) : null
    const settle = samples.map((s) => s.settleMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
    const pct = (p: number) => (settle.length ? settle[Math.min(settle.length - 1, Math.floor(p * settle.length))] : null)

    const result = {
      scenario: 's12-canvas-tab-switch',
      label: currentLabel(),
      build: getBuildIdentity(),
      fixture: FIXTURE,
      switches: SWITCHES,
      loadAverage: os.loadavg(),
      durationMs: Date.now() - t0,
      valid: problems.length === 0,
      problems,
      rendererReloads,
      crashCount,
      unresponsiveCount: await readUnresponsiveCount(app),
      settleMs: { p50: pct(0.5), p90: pct(0.9), max: settle.length ? settle[settle.length - 1] : null, measured: settle.length },
      nodesDriftSameTab: { first: drift(sameTarget(0), (s) => s.nodes), second: drift(sameTarget(1), (s) => s.nodes) },
      listenersDriftSameTab: { first: drift(sameTarget(0), (s) => s.listeners), second: drift(sameTarget(1), (s) => s.listeners) },
      afterGc: {
        heapMB: { start: start.heapMB, end: end.heapMB, delta: end.heapMB - start.heapMB },
        nodes: { start: start.nodes, end: end.nodes, delta: end.nodes - start.nodes },
        listeners: { start: start.listeners, end: end.listeners, delta: end.listeners - start.listeners }
      },
      samples
    }

    const resultPath = path.join(RESULTS_ROOT, result.label, 's12-canvas-tab-switch.json')
    fs.mkdirSync(path.dirname(resultPath), { recursive: true })
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    console.log(`[perf] S12 result written to ${resultPath} (valid=${result.valid})`)
    console.log(`[perf] S12 settle p50=${result.settleMs.p50?.toFixed(0) ?? 'n/a'}ms p90=${result.settleMs.p90?.toFixed(0) ?? 'n/a'}ms (load ${result.loadAverage[0].toFixed(2)})`)
    console.log(`[perf] S12 same-tab drift nodes=${JSON.stringify(result.nodesDriftSameTab)} listeners=${JSON.stringify(result.listenersDriftSameTab)}`)

    expect(problems, problems.join('\n')).toEqual([])
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})
