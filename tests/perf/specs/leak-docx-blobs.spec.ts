/**
 * Does opening and closing a .docx leak? Three arms, one launch each, same
 * cadence, forced collection before every sample:
 *
 * - docx: open `docx-typical-5images.docx` (five embedded ~230 KB images), close all tabs.
 * - markdown: the same with `md-typical-5kb.md` — the comparison arm.
 * - idle: spend the docx arm's cycle time doing nothing — the arm that holds
 *   the clock and drops the action (measurement-practice §3).
 *
 * The docx viewer turns each embedded image into a blob: URL. Those are
 * counted directly (URL.createObjectURL/revokeObjectURL wrapped in the page):
 * after its tab closes the count must return to 0, and while the document is
 * open the embedded images must actually decode (proof the arm exercised the
 * image path). Working set per cycle is reported as a slope with the
 * trajectory and load average beside it — a slope alone is not a result.
 *
 * `LEAK_ARM` runs one arm (docx | markdown | idle; default all three),
 * `LEAK_CYCLES` the measured cycles (default 40), `LEAK_IDLE_MS` the idle
 * arm's cycle time (default 3000). `LEAK_SKIP_IMAGE_DECODE=1` is a diagnostic
 * docx-only variant that never assigns the images' blob URLs to `<img>`, so
 * the document still parses and renders text while the decode path is
 * dropped — used to attribute renderer-RSS growth to image decoding.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Page } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { CdpMetricsCollector } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { seedArtifact, beginOpenObservation, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { fixturePath } from '../lib/fixture-store'
import { beginScenario, currentLabel } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'

const __filename = fileURLToPath(import.meta.url)
const RESULTS_ROOT = path.resolve(path.dirname(__filename), '../results')

type Arm = 'docx' | 'markdown' | 'idle'
const ARMS: Arm[] = process.env.LEAK_ARM ? [process.env.LEAK_ARM as Arm] : ['docx', 'markdown', 'idle']
const CYCLES = Number(process.env.LEAK_CYCLES || 40)
const IDLE_MS = Number(process.env.LEAK_IDLE_MS || 3000)
const FIXTURE: Record<Exclude<Arm, 'idle'>, string> = {
  docx: 'docx-typical-5images.docx',
  markdown: 'md-typical-5kb.md'
}

interface Sample {
  cycle: number
  tMs: number
  heapMB: number
  nodes: number
  listeners: number
  liveBlobUrls: number | null
  windowRssMB: number | null
  closedWindowRssMB: number | null
  openTabCount: number
  loadAverage1m: number
}

async function installBlobCounter(window: Page): Promise<void> {
  await window.evaluate(() => {
    const holder = window as unknown as { __perfBlobUrls?: Set<string> }
    if (holder.__perfBlobUrls) return
    const live = new Set<string>()
    holder.__perfBlobUrls = live
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = create(obj)
      live.add(url)
      return url
    }
    URL.revokeObjectURL = (url: string) => {
      live.delete(url)
      revoke(url)
    }
  })
}

const liveBlobUrls = (window: Page) =>
  window
    .evaluate(() => (window as unknown as { __perfBlobUrls?: Set<string> }).__perfBlobUrls?.size ?? null)
    .catch(() => null)

/** Least-squares slope of `y` over `x`; null with fewer than ten points. */
function slope(points: Array<[number, number]>): number | null {
  if (points.length < 10) return null
  const mx = points.reduce((a, p) => a + p[0], 0) / points.length
  const my = points.reduce((a, p) => a + p[1], 0) / points.length
  let num = 0
  let den = 0
  for (const [x, y] of points) {
    num += (x - mx) * (y - my)
    den += (x - mx) ** 2
  }
  return den === 0 ? null : num / den
}

for (const arm of ARMS) {
  test(`leak docx blobs — ${arm} arm`, async () => {
    beginScenario(`leak-docx-blobs-${arm}`)
    test.setTimeout(CYCLES * 20000 + 120000)

    const appEntryPath = getAppEntryPath()
    const testConfigDir = createTestConfigDir(appEntryPath)
    const fixtureName = arm === 'idle' ? null : seedArtifact(testConfigDir, fixturePath(FIXTURE[arm])).name
    const app = await launchElectronApp(appEntryPath, testConfigDir)
    const sampler = new ProcessMetricsSampler(app)
    const problems: string[] = []

    try {
      const window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await navigateToChat(window)
      await installUnresponsiveTracker(app)
      const reloadGuard = installReloadGuard(window)
      await installBlobCounter(window)
      if (arm === 'docx' && process.env.LEAK_SKIP_IMAGE_DECODE === '1') {
        await window.evaluate(() => {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
          Object.defineProperty(HTMLImageElement.prototype, 'src', {
            ...descriptor,
            set(this: HTMLImageElement, value: string) {
              if (!value.startsWith('blob:')) descriptor.set!.call(this, value)
            }
          })
        })
      }
      const cdp = new CdpMetricsCollector(window)
      await cdp.connect()
      const windowPid: number | null = await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? null)
        .catch(() => null)
      sampler.start()

      const closeAllTabs = async () => {
        const btn = window.getByTitle(/Close all tabs|关闭所有标签页/).first()
        if (await btn.isVisible().catch(() => false)) await btn.click()
      }

      const samples: Sample[] = []
      let maxLiveWhileOpen = 0
      let maxDecodedImagesWhileOpen = 0
      const t0 = Date.now()
      const readWindowRss = () => windowPid === null ? Promise.resolve(null) : app.evaluate(({ app }, pid) => {
        const metric = app.getAppMetrics().find((m) => m.pid === pid)
        return metric ? metric.memory.workingSetSize / 1024 : null
      }, windowPid)
      const record = async (cycle: number) => {
        await cdp.collectGarbage()
        const snap = await cdp.snapshot()
        const drained = sampler.drain()
        const closedWindowRssMB = await readWindowRss()
        samples.push({
          cycle,
          tMs: Date.now() - t0,
          heapMB: snap.heapMB,
          nodes: snap.nodes,
          listeners: snap.listeners,
          liveBlobUrls: await liveBlobUrls(window),
          windowRssMB: windowPid === null ? null : drained.byPid.get(windowPid)?.rssAvgMB ?? null,
          closedWindowRssMB,
          openTabCount: await window.locator('.canvas-tab-bar .canvas-tab').count(),
          loadAverage1m: os.loadavg()[0]
        })
      }

      await record(0)
      for (let cycle = 1; cycle <= CYCLES; cycle++) {
        if (fixtureName) {
          await beginOpenObservation(window)
          await clickArtifactByName(window, fixtureName)
          const opened = await waitForCanvasLoaded(window, 20000).then(() => true).catch(() => false)
          if (!opened) problems.push(`cycle ${cycle}: ${fixtureName} did not finish opening`)
          maxLiveWhileOpen = Math.max(maxLiveWhileOpen, (await liveBlobUrls(window)) ?? 0)
          if (arm === 'docx') {
            const decoded = await window.evaluate(() =>
              [...document.querySelectorAll<HTMLImageElement>('.docx-wrapper img')]
                .filter(image => image.complete && image.naturalWidth > 0).length)
            maxDecodedImagesWhileOpen = Math.max(maxDecodedImagesWhileOpen, decoded)
          }
          await closeAllTabs()
        } else {
          await window.waitForTimeout(IDLE_MS)
        }
        await record(cycle)
        const closed = samples[samples.length - 1]
        if (closed.openTabCount !== 0) problems.push(`cycle ${cycle}: ${closed.openTabCount} tabs remain open`)
        if (closed.liveBlobUrls !== 0) problems.push(`cycle ${cycle}: ${closed.liveBlobUrls ?? 'unknown'} blob URLs remain after close`)
        if (closed.closedWindowRssMB === null) problems.push(`cycle ${cycle}: no post-close renderer RSS sample`)
      }

      let cacheProbe: {
        afterIdleMB: number | null
        afterDebuggerReleaseMB: number | null
        afterCriticalPressureMB: number | null
      } | null = null
      if (arm === 'docx') {
        await window.waitForTimeout(5000)
        await cdp.collectGarbage()
        const afterIdleMB = await readWindowRss()
        await cdp.releaseDebuggerRetention()
        await cdp.collectGarbage()
        const afterDebuggerReleaseMB = await readWindowRss()
        // Report-only: whether the grown working set is reclaimable decides
        // cache-retention vs leak, and that judgment belongs to review, not to
        // this test's valid flag.
        await cdp.simulateMemoryPressure()
        await window.waitForTimeout(2000)
        await cdp.collectGarbage()
        const afterCriticalPressureMB = await readWindowRss()
        cacheProbe = { afterIdleMB, afterDebuggerReleaseMB, afterCriticalPressureMB }
      }

      const rendererReloads = reloadGuard.getReloadCount()
      const crashCount = await readCrashCount(app).catch(() => 0)
      if (rendererReloads > 0) problems.push(`renderer reloaded ${rendererReloads}x — blob and heap counters reset`)
      if (crashCount > 0) problems.push(`renderer crashed ${crashCount}x`)
      if (arm === 'docx' && process.env.LEAK_SKIP_IMAGE_DECODE !== '1' && maxDecodedImagesWhileOpen === 0) {
        problems.push('no embedded image decoded while the document was open')
      }

      const steady = samples.slice(Math.min(5, samples.length))
      const perCycle = (pick: (s: Sample) => number | null) =>
        slope(steady.map((s) => [s.cycle, pick(s)] as [number, number | null]).filter((p): p is [number, number] => p[1] !== null))
      const perMinute = (pick: (s: Sample) => number | null) =>
        slope(steady.map((s) => [s.tMs / 60000, pick(s)] as [number, number | null]).filter((p): p is [number, number] => p[1] !== null))

      const last = samples[samples.length - 1]
      const result = {
        scenario: `leak-docx-blobs-${arm}`,
        label: currentLabel(),
        build: getBuildIdentity(),
        arm,
        fixture: fixtureName,
        cycles: CYCLES,
        msPerCycle: samples.length > 1 ? (last.tMs - samples[0].tMs) / (samples.length - 1) : null,
        forcedGcBeforeSample: true,
        valid: problems.length === 0,
        problems,
        blobUrls: { maxLiveWhileOpen, liveAtEnd: last?.liveBlobUrls ?? null },
        maxDecodedImagesWhileOpen,
        cacheProbe,
        ratePerCycle: {
          windowRssMB: perCycle((s) => s.windowRssMB),
          closedWindowRssMB: perCycle((s) => s.closedWindowRssMB),
          heapMB: perCycle((s) => s.heapMB),
          nodes: perCycle((s) => s.nodes),
          listeners: perCycle((s) => s.listeners)
        },
        ratePerMinute: { windowRssMB: perMinute((s) => s.windowRssMB) },
        samples
      }

      const resultPath = path.join(RESULTS_ROOT, result.label, `${result.scenario}.json`)
      fs.mkdirSync(path.dirname(resultPath), { recursive: true })
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
      console.log(`[perf] ${result.scenario} written to ${resultPath} (valid=${result.valid})`)
      console.log(`[perf] ${arm}: blob URLs live while open ≤${maxLiveWhileOpen}, at end ${result.blobUrls.liveAtEnd}; window RSS ${result.ratePerCycle.windowRssMB?.toFixed(3) ?? 'n/a'} MB/cycle`)
      console.log(`[perf] ${arm} trajectory (cycle: avg/closed rssMB @load): ${samples.map((s) => `${s.cycle}:${s.windowRssMB?.toFixed(0) ?? '-'}/${s.closedWindowRssMB?.toFixed(0) ?? '-'}@${s.loadAverage1m.toFixed(1)}`).join(' ')}`)
      if (cacheProbe) console.log(`[perf] docx cache probe: ${JSON.stringify(cacheProbe)}`)

      expect(problems, problems.join('\n')).toEqual([])
      if (arm === 'docx') expect(result.blobUrls.liveAtEnd, 'blob URLs outlived their closed tab').toBe(0)
    } finally {
      sampler.stop()
      console.log(`[perf] ${arm}: closing Electron after measurement`)
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          app.close(),
          new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error(`${arm}: Electron close exceeded 30s`)), 30000)
          })
        ])
        console.log(`[perf] ${arm}: Electron closed`)
      } catch (error) {
        app.process().kill('SIGKILL')
        throw error
      } finally {
        if (closeTimer) clearTimeout(closeTimer)
        cleanupTestConfigDir(testConfigDir)
      }
    }
  })
}
