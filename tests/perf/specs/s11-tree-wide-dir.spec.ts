/**
 * S11 — File tree: expand a 5,000-file directory, then collapse it.
 *
 * The tree loads one directory level per expand and virtualizes rows, so
 * expanding a wide directory must mount about a viewport of rows, not 5,000,
 * and collapsing must drop the loaded subtree (the tree holds what is open).
 * The gateable numbers are structural: rendered row count and DOM node delta.
 * The expand/collapse durations are same-machine comparisons only.
 *
 * After measuring, a functional check: a subfolder left open while its parent
 * was collapsed must come back with its rows when the parent is re-expanded
 * (collapse drops the subtree, but the tree remembers the subfolder as open).
 */

import fs from 'fs'
import path from 'path'
import { test, expect } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { openWorkspaceRail } from '../lib/open-artifact'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'

const WIDE_DIR = 'wide'
const WIDE_FILE_COUNT = 5000
/** Generous bound for a virtualized list: a tall viewport plus overscan, far below the file count. */
const MAX_RENDERED_ROWS = 200

function seedWideDirectory(testConfigDir: string): void {
  const dir = path.join(testConfigDir, '.halo', 'temp', 'artifacts', WIDE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < WIDE_FILE_COUNT; i++) {
    fs.writeFileSync(path.join(dir, `component_${String(i).padStart(4, '0')}.ts`), 'x')
  }
}

const NEST_DIR = 'nest_outer'
const NEST_SUBDIR = 'nest_inner'
const NEST_LEAF = 'nest_leaf.txt'
const NEST_NEW_LEAF = 'nest_new_leaf.txt'

function seedNestedDirectory(testConfigDir: string): void {
  const dir = path.join(testConfigDir, '.halo', 'temp', 'artifacts', NEST_DIR, NEST_SUBDIR)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, NEST_LEAF), 'x')
}

/** Expand outer, expand inner, collapse outer, expand outer: is the inner folder's row back? */
async function reexpandRestoresOpenSubfolder(window: import('@playwright/test').Page, testConfigDir: string): Promise<boolean> {
  const row = (name: string) => window.getByText(name, { exact: true }).first()
  const visible = (name: string) => row(name).waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
  await row(NEST_DIR).click()
  if (!await visible(NEST_SUBDIR)) return false
  await row(NEST_SUBDIR).click()
  if (!await visible(NEST_LEAF)) return false
  await row(NEST_DIR).click()
  if (!await row(NEST_SUBDIR).waitFor({ state: 'hidden', timeout: 15000 }).then(() => true, () => false)) return false
  fs.writeFileSync(path.join(testConfigDir, '.halo', 'temp', 'artifacts', NEST_DIR, NEST_SUBDIR, NEST_NEW_LEAF), 'x')
  await row(NEST_DIR).click()
  if (!await visible(NEST_SUBDIR)) return false
  return await visible(NEST_LEAF) && await visible(NEST_NEW_LEAF)
}

const countRows = (window: import('@playwright/test').Page) =>
  window.evaluate(() => document.querySelectorAll('[role="treeitem"]').length)

test('S11 file tree wide directory expand', async () => {
  beginScenario('s11-tree-wide-dir')
  test.setTimeout(120000)
  const warnings: string[] = []
  const steps: Array<{ label: string; tMs: number }> = []

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  seedWideDirectory(testConfigDir)
  seedNestedDirectory(testConfigDir)
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

    let preconditionFailure: string | undefined
    await openWorkspaceRail(window)
    const folderRow = window.getByText(WIDE_DIR, { exact: true }).first()
    await folderRow.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
      preconditionFailure = `The "${WIDE_DIR}" folder never appeared in the file tree — the seeded directory was not listed.`
    })

    await window.waitForTimeout(1000)
    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()
    const rowsBefore = await countRows(window)

    const sampler = new ProcessMetricsSampler(app)
    sampler.start()
    const t0 = Date.now()

    let rowsExpanded: number | null = null
    let rowsCollapsed: number | null = null
    if (!preconditionFailure) {
      await folderRow.click()
      const firstChild = window.getByText('component_0000.ts', { exact: true }).first()
      const appeared = await firstChild.waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false)
      steps.push({ label: 'expanded', tMs: Date.now() - t0 })
      if (!appeared) {
        preconditionFailure = 'No child row appeared after expanding the wide folder — the expand did not load its children.'
      } else {
        await window.waitForTimeout(500)
        rowsExpanded = await countRows(window)
        if (rowsExpanded <= rowsBefore) {
          preconditionFailure = `Row count did not grow on expand (${rowsBefore} -> ${rowsExpanded}).`
        }
      }
    }

    let heapExpanded: CdpSnapshot | null = null
    if (!preconditionFailure) {
      heapExpanded = await cdp.snapshot().catch((err) => {
        warnings.push(`nodes: expanded-state CDP snapshot failed (${err instanceof Error ? err.message : String(err)}).`)
        return null
      })
      await folderRow.click()
      await window.getByText('component_0000.ts', { exact: true }).first()
        .waitFor({ state: 'hidden', timeout: 15000 })
        .catch(() => { preconditionFailure = 'The first child row stayed visible after collapsing the wide folder.' })
      steps.push({ label: 'collapsed', tMs: Date.now() - t0 })
      await window.waitForTimeout(500)
      rowsCollapsed = await countRows(window)
    }

    const durationMs = Date.now() - t0
    sampler.stop()

    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

    let heapEnd: CdpSnapshot | null = null
    if (noReloadOrCrash) {
      heapEnd = await cdp.snapshot().catch((err) => {
        warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${err instanceof Error ? err.message : String(err)}) — end/delta reported as null.`)
        return null
      })
    }

    // Functional check, after every measured snapshot so it cannot skew them.
    let reexpandRestored: boolean | null = null
    if (!preconditionFailure && noReloadOrCrash) {
      reexpandRestored = await reexpandRestoresOpenSubfolder(window, testConfigDir)
      steps.push({ label: `reexpand-restores-open-subfolder:${reexpandRestored}`, tMs: 0 })
      if (!reexpandRestored) {
        preconditionFailure = `After collapse/re-expand of "${NEST_DIR}", its open subfolder did not re-fetch and show "${NEST_NEW_LEAF}".`
      }
    }

    if (rowsExpanded !== null && rowsExpanded > MAX_RENDERED_ROWS) {
      warnings.push(`rows: ${rowsExpanded} tree rows rendered after expanding ${WIDE_FILE_COUNT} files — virtualization is not bounding the list.`)
    }
    if (heapExpanded) {
      steps.push({ label: `nodes-expanded:${heapExpanded.nodes}`, tMs: 0 })
    }
    steps.push({ label: `rows-before:${rowsBefore}`, tMs: 0 })
    if (rowsExpanded !== null) steps.push({ label: `rows-expanded:${rowsExpanded}`, tMs: 0 })
    if (rowsCollapsed !== null) steps.push({ label: `rows-collapsed:${rowsCollapsed}`, tMs: 0 })

    const samplingStats = sampler.getSamplingStats()
    const { cpu, mem } = sampler.summarize()
    let render: { longtask: PerfResult['longtask']; eventLatency: PerfResult['eventLatency'] }
    try {
      render = await readRenderMetrics(window)
    } catch (err) {
      warnings.push(`longtask/eventLatency: window.__perf read failed (${err instanceof Error ? err.message : String(err)}) — reported as null.`)
      render = { longtask: null, eventLatency: null }
    }
    const unmeasuredMetrics: string[] = []
    if (render.longtask === null) unmeasuredMetrics.push('longtask')
    if (render.eventLatency === null) unmeasuredMetrics.push('eventLatency')

    const status: PerfResult['status'] = preconditionFailure ? 'precondition-failed' : 'ok'
    const result: PerfResult = {
      scenario: 's11-tree-wide-dir',
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
      unresponsiveCount: await readUnresponsiveCount(app),
      rendererReloads,
      crashCount,
      valid: noReloadOrCrash && status === 'ok',
      unmeasuredMetrics: unmeasuredMetrics.length ? unmeasuredMetrics : undefined,
      status,
      note: preconditionFailure,
      warnings: warnings.length ? warnings : undefined,
      steps
    }

    const filePath = writeResult(result)
    console.log(`[perf] S11 result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.valid, preconditionFailure ?? `rendererReloads=${rendererReloads}, crashCount=${crashCount}`).toBe(true)
    if (status === 'ok') {
      expect(rowsExpanded!).toBeLessThanOrEqual(MAX_RENDERED_ROWS)
      expect(rowsCollapsed!).toBeLessThanOrEqual(rowsBefore)
      if (reexpandRestored !== null) {
        expect(reexpandRestored, 'collapsed-then-reopened folder lost its open subfolder').toBe(true)
      }
    }
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
