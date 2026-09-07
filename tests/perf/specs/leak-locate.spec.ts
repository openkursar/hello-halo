/**
 * Locates the growth that four soak runs have measured and none has explained:
 * ~1 event listener, ~6.8 DOM nodes and ~0.20 MB of working set per file
 * open/close cycle, linear over 45 minutes and not released by a forced
 * collection.
 *
 * Not a scenario: it writes no `PerfResult` and has no threshold. It produces
 * evidence — which call sites registered listeners that outlive their cycle,
 * and whether the leaked DOM is still attached to the document.
 *
 * Three questions, in the order that makes the later ones cheap to skip:
 *
 * 1. **Does the instrument work at all?** The terminal library registers two
 *    listeners (focus and blur on its textarea) outside the registry its
 *    `dispose()` walks — a leak established by reading the dependency, not by
 *    measurement. The cycle loop opens a terminal, so those two must appear in
 *    the outstanding set. If a known leak is invisible here, nothing else this
 *    file reports can be trusted.
 * 2. **Is the leaked DOM attached or detached?** CDP's `Nodes` counts both;
 *    the census counts only what hangs off `document`. Attached growth means a
 *    container accumulating children, which the path diff names directly.
 *    Detached growth means something in JS holds the subtrees, which needs the
 *    heap snapshot.
 * 3. **Which code adds the listeners nobody removes?** Grouped by call stack,
 *    counting only listeners whose target is still alive — a listener on a
 *    collected target was never a leak.
 *
 * `LEAK_CYCLES` sets the measured cycle count (default 60), `LEAK_WARMUP_CYCLES`
 * the unmeasured ones before it, and `LEAK_HEAP_SNAPSHOT=1` additionally writes
 * two heap snapshots — hundreds of megabytes each, so opt-in.
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
import { seedArtifact, beginOpenObservation, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { fixturePath } from '../lib/fixture-store'
import { beginScenario, currentLabel } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'
import {
  installListenerTracker,
  startListenerRecording,
  stopListenerRecording,
  dumpOutstandingListeners
} from '../lib/listener-tracker'
import { takeDomCensus, diffCensusMap } from '../lib/dom-census'
import { captureHeapSnapshot } from '../lib/heap-snapshot'

const __filename = fileURLToPath(import.meta.url)
const RESULTS_ROOT = path.resolve(path.dirname(__filename), '../results')

/** The same eight files the soaks cycle, so the growth being located is the growth they measured. */
const ALL_TYPICAL_FIXTURES = [
  'md-typical-5kb.md',
  'code-typical-200lines.ts',
  'json-typical-small.json',
  'csv-typical.csv',
  'image-typical.png',
  'html-typical.html',
  'text-typical.log',
  'pdf-typical.pdf'
]

/**
 * `LEAK_FIXTURES` narrows the rotation to a comma-separated subset. Growth that
 * is flat for one viewer and steep for another is attributed; growth averaged
 * over eight viewers is not.
 */
const TYPICAL_FIXTURES = process.env.LEAK_FIXTURES
  ? process.env.LEAK_FIXTURES.split(',').map((f) => f.trim()).filter(Boolean)
  : ALL_TYPICAL_FIXTURES

const MEASURED_CYCLES = Number(process.env.LEAK_CYCLES || 60)
const WARMUP_CYCLES = Number(process.env.LEAK_WARMUP_CYCLES || TYPICAL_FIXTURES.length)
const WANT_HEAP_SNAPSHOT = process.env.LEAK_HEAP_SNAPSHOT === '1'
/**
 * Open a terminal every Nth cycle, matching the soaks. `0` opens none, which is
 * the control that separates what the terminal costs from what opening a file
 * costs — the two are mixed together in every soak number recorded so far.
 */
const TERMINAL_EVERY = Number(process.env.LEAK_TERMINAL_EVERY ?? 5)
/**
 * Hold an undisposed `ElementHandle` on the terminal, the way the soaks do.
 * The point of the knob is that it is an arm of an experiment: the difference
 * between the two settings is how much of a soak's reported growth belongs to
 * the test rather than to the product.
 */
const PIN_TERMINAL_HANDLE = process.env.LEAK_PIN_TERMINAL_HANDLE === '1'
/**
 * `LEAK_IDLE_MS` replaces the file open with a wait of that many milliseconds,
 * leaving the rest of the run identical. It is the control every per-cycle
 * memory figure recorded so far has been missing: growth of X MB per cycle and
 * growth of X MB per however long a cycle happens to take are the same
 * measurement until an arm holds the clock and drops the work. Set it to the
 * measured cycle duration of the arm being compared against.
 */
const IDLE_MS = Number(process.env.LEAK_IDLE_MS || 0)
/**
 * `LEAK_CYCLE_GAP_MS` pauses after each cycle's work instead of replacing it,
 * which slows the cadence without changing what is done. The idle arm shows the
 * process gives memory back when left alone, so a run that does the same work
 * more slowly gives it more room to do that — meaning a slower machine can
 * report a flatter curve for the same product, and "the growth went away" and
 * "the machine got busier" look identical without this arm.
 */
const CYCLE_GAP_MS = Number(process.env.LEAK_CYCLE_GAP_MS || 0)
/**
 * `LEAK_RELEASE_CONSOLE=1` drops the debugger's own retention before the final
 * measurement. Every figure this probe has produced was taken with a CDP client
 * attached, and the retainer paths for the leftover detached nodes end at the
 * console object group — so the arm that does not release cannot say whether it
 * is measuring the product or the instrument.
 */
const RELEASE_CONSOLE = process.env.LEAK_RELEASE_CONSOLE === '1'
/**
 * `LEAK_GC_BEFORE_SAMPLE=1` collects garbage before every working-set sample.
 * Without it a sample counts whatever has not been collected yet, and a loop
 * running far faster than a person can click is exactly the condition under
 * which collection falls behind — so an unforced run cannot tell memory that is
 * retained from memory that is merely still queued. The soaks all ran unforced.
 */
const GC_BEFORE_SAMPLE = process.env.LEAK_GC_BEFORE_SAMPLE === '1'
const RSS_SAMPLE_EVERY = 10

/** Least-squares slope of y over x, ignoring windows where nothing was sampled. */
function slopePerCycle(points: Array<[number, number | null]>): number | null {
  const usable = points.filter((p): p is [number, number] => p[1] !== null)
  if (usable.length < 3) return null
  const n = usable.length
  const meanX = usable.reduce((s, p) => s + p[0], 0) / n
  const meanY = usable.reduce((s, p) => s + p[1], 0) / n
  let num = 0
  let den = 0
  for (const [x, y] of usable) {
    num += (x - meanX) * (y - meanY)
    den += (x - meanX) ** 2
  }
  return den === 0 ? null : num / den
}

test('leak locate', async () => {
  beginScenario('leak-locate')
  test.setTimeout(30 * 60 * 1000)

  const label = currentLabel()
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  for (const f of TYPICAL_FIXTURES) seedArtifact(testConfigDir, fixturePath(f))

  const app = await launchElectronApp(appEntryPath, testConfigDir)
  const warnings: string[] = []

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()

    const closeAllTabs = async () => {
      const btn = window.getByTitle(/Close all tabs|关闭所有标签页/).first()
      if (await btn.isVisible().catch(() => false)) await btn.click()
    }

    const openOneFile = async (fixtureName: string) => {
      const expandButton = window.getByLabel(/Open artifacts panel|打开产物面板/).first()
      if (await expandButton.isVisible().catch(() => false)) await expandButton.click()
      await beginOpenObservation(window)
      await clickArtifactByName(window, fixtureName)
      await waitForCanvasLoaded(window, 20000).catch(() => null)
      await closeAllTabs()
    }

    const openTerminal = async () => {
      const terminalBtn = window.getByTitle(/Open terminal|打开终端/).first()
      if (!(await terminalBtn.isVisible().catch(() => false))) return false
      await terminalBtn.click()
      if (PIN_TERMINAL_HANDLE) {
        // Reproduces what the soaks do. `waitForSelector` returns an
        // `ElementHandle`, and an undisposed one pins the terminal's DOM from
        // the test side — so the growth a soak reports includes DOM the
        // product had already released.
        await window.waitForSelector('.xterm', { timeout: 10000 }).catch(() => {})
      } else {
        // A locator resolves and releases, leaving only what the product holds.
        await window.locator('.xterm').first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})
      }
      await closeAllTabs()
      return true
    }

    // Warmup runs the same loop unmeasured, so one-off registrations made on
    // the first open of each type are not counted as accumulation.
    for (let i = 0; i < WARMUP_CYCLES; i++) {
      await openOneFile(TYPICAL_FIXTURES[i % TYPICAL_FIXTURES.length]).catch((err) =>
        warnings.push(`warmup cycle ${i} failed: ${err instanceof Error ? err.message : String(err)}`)
      )
    }
    if (TERMINAL_EVERY > 0) await openTerminal().catch(() => false)

    await cdp.collectGarbage()
    await window.waitForTimeout(1000)
    await cdp.collectGarbage()

    const installStatus = await installListenerTracker(window)
    await startListenerRecording(window)

    const censusBefore = await takeDomCensus(window)
    const cdpBefore = await cdp.snapshot()
    if (WANT_HEAP_SNAPSHOT) {
      const bytes = await captureHeapSnapshot(window, path.join(RESULTS_ROOT, label, 'leak-before.heapsnapshot'))
      console.log(`[perf] leak-locate heap snapshot before: ${(bytes / 1024 / 1024).toFixed(1)} MB`)
    }

    // Working set, sampled per window of cycles. Node and listener counts turn
    // out to explain almost none of the memory the soaks measure, so the two
    // have to be attributed separately — and doing it here costs minutes rather
    // than the soak's 45.
    const mainWindowPid: number | null = await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? null)
      .catch(() => null)
    const rssSeries: Array<{ cycle: number; tMs: number; windowRssMB: number | null; totalRssMB: number | null }> = []
    const rssSampler = new ProcessMetricsSampler(app)
    rssSampler.start()
    const drainWindowRss = (): number | null => {
      const drained = rssSampler.drain()
      return (mainWindowPid === null ? undefined : drained.byPid.get(mainWindowPid))?.rssAvgMB ?? null
    }

    const cyclesStartedAt = Date.now()
    let terminalCycles = 0
    for (let cycle = 1; cycle <= MEASURED_CYCLES; cycle++) {
      if (IDLE_MS > 0) {
        await window.waitForTimeout(IDLE_MS)
      } else {
        const fixtureName = TYPICAL_FIXTURES[cycle % TYPICAL_FIXTURES.length]
        await openOneFile(fixtureName).catch((err) =>
          warnings.push(`cycle ${cycle} file open failed: ${err instanceof Error ? err.message : String(err)}`)
        )
      }
      // The soaks' cadence, and the only thing that exercises the terminal path
      // this run depends on for its positive control.
      if (TERMINAL_EVERY > 0 && cycle % TERMINAL_EVERY === 0 && (await openTerminal().catch(() => false))) terminalCycles++
      if (CYCLE_GAP_MS > 0) await window.waitForTimeout(CYCLE_GAP_MS)

      if (cycle % RSS_SAMPLE_EVERY === 0) {
        // Before the sample, not only at the end: releasing once at the end
        // would leave the whole series measured against an accumulating
        // debugger, which is the quantity in question.
        if (RELEASE_CONSOLE) await cdp.releaseDebuggerRetention()
        if (GC_BEFORE_SAMPLE) {
          await cdp.collectGarbage()
          // The sampler averages over the window it is draining, so the
          // collection has to land inside that window to be reflected in it.
          await window.waitForTimeout(1500)
        }
        const drained = rssSampler.drain()
        const win = mainWindowPid === null ? undefined : drained.byPid.get(mainWindowPid)
        rssSeries.push({
          cycle,
          tMs: Date.now() - cyclesStartedAt,
          windowRssMB: win?.rssAvgMB ?? null,
          totalRssMB: drained.totalRssAvgMB
        })
      }
    }
    const cyclesElapsedMs = Date.now() - cyclesStartedAt

    if (RELEASE_CONSOLE) await cdp.releaseDebuggerRetention()
    await cdp.collectGarbage()
    await window.waitForTimeout(1000)
    await cdp.collectGarbage()
    await window.waitForTimeout(500)

    await stopListenerRecording(window)
    const listeners = await dumpOutstandingListeners(window, 60)
    const censusAfter = await takeDomCensus(window)
    const cdpAfter = await cdp.snapshot()
    if (WANT_HEAP_SNAPSHOT) {
      const bytes = await captureHeapSnapshot(window, path.join(RESULTS_ROOT, label, 'leak-after.heapsnapshot'))
      console.log(`[perf] leak-locate heap snapshot after: ${(bytes / 1024 / 1024).toFixed(1)} MB`)
    }

    const attachedGrowth = censusAfter.attachedTotal - censusBefore.attachedTotal
    const totalNodeGrowth = cdpAfter.nodes - cdpBefore.nodes

    /**
     * The question the per-cycle slope cannot answer: is what accumulated held
     * because something points at it, or only because discarding it had no
     * benefit yet? A working set that returns to where it started once the
     * renderer is made to drop every cache was a cache — bounded, evicted under
     * pressure, not a leak. One that does not is the leak.
     *
     * Read against this run's own first sample, because absolute working set is
     * not comparable between sessions.
     *
     * Deliberately the last thing the run does. Critical memory pressure can
     * take the renderer down with it, and everything above is worth more than
     * this is — sequencing it here means a purge that kills the page costs only
     * the purge numbers. RSS afterwards comes from the OS per-pid sampler, not
     * from the page, for the same reason.
     */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 3000))
    // Both readings are averages over their own settle window, so they are the
    // same kind of number. Draining immediately after the loop is not: the last
    // in-loop sample already emptied the buffer, leaving nothing to average.
    await settle()
    const rssBeforePurge = drainWindowRss()
    const purgeOutcome = await cdp.purgeRetainedCaches().catch((err: unknown) => ({
      purge: err instanceof Error ? err.message : String(err)
    }))
    await settle()
    const rssAfterPurge = drainWindowRss()
    rssSampler.stop()

    const result = {
      scenario: 'leak-locate',
      label,
      build: getBuildIdentity(),
      loadAverage: os.loadavg(),
      measuredCycles: MEASURED_CYCLES,
      warmupCycles: WARMUP_CYCLES,
      terminalCycles,
      terminalEvery: TERMINAL_EVERY,
      pinTerminalHandle: PIN_TERMINAL_HANDLE,
      idleMs: IDLE_MS,
      cycleGapMs: CYCLE_GAP_MS,
      releaseConsole: RELEASE_CONSOLE,
      gcBeforeSample: GC_BEFORE_SAMPLE,
      cyclesElapsedMs,
      msPerCycle: cyclesElapsedMs / MEASURED_CYCLES,
      trackerInstall: installStatus,
      warnings,
      /**
       * `attachedGrowth` counts nodes still reachable from `document`;
       * `totalNodeGrowth` is CDP's counter, which also includes detached nodes
       * that something still references. The gap between them is the detached
       * share.
       */
      nodes: {
        attachedBefore: censusBefore.attachedTotal,
        attachedAfter: censusAfter.attachedTotal,
        attachedGrowth,
        cdpNodesBefore: cdpBefore.nodes,
        cdpNodesAfter: cdpAfter.nodes,
        totalNodeGrowth,
        detachedShare: totalNodeGrowth - attachedGrowth,
        attachedPerCycle: attachedGrowth / MEASURED_CYCLES,
        totalPerCycle: totalNodeGrowth / MEASURED_CYCLES
      },
      cdpListeners: {
        before: cdpBefore.listeners,
        after: cdpAfter.listeners,
        growth: cdpAfter.listeners - cdpBefore.listeners,
        perCycle: (cdpAfter.listeners - cdpBefore.listeners) / MEASURED_CYCLES
      },
      heapMB: { before: cdpBefore.heapMB, after: cdpAfter.heapMB },
      /**
       * Slope by least squares over the sampled windows rather than
       * last-minus-first: working set moves by megabytes between any two
       * samples, so a two-point difference over 60 cycles is noise.
       *
       * Per minute as well as per cycle, because arms whose cycles take
       * different amounts of time cannot be compared on the per-cycle figure
       * alone — that is the whole point of the idle arm.
       */
      rss: {
        series: rssSeries,
        windowSlopeMBPerCycle: slopePerCycle(rssSeries.map((r) => [r.cycle, r.windowRssMB])),
        totalSlopeMBPerCycle: slopePerCycle(rssSeries.map((r) => [r.cycle, r.totalRssMB])),
        windowSlopeMBPerMinute: slopePerCycle(rssSeries.map((r) => [r.tMs / 60000, r.windowRssMB])),
        totalSlopeMBPerMinute: slopePerCycle(rssSeries.map((r) => [r.tMs / 60000, r.totalRssMB])),
        /**
         * `firstSample` is the baseline the other two are read against:
         * `afterPurge` back down at `firstSample` means everything that
         * accumulated was discardable, and the growth is a cache rather than a
         * leak. Still above it means something holds a reference.
         */
        firstSampleMB: rssSeries[0]?.windowRssMB ?? null,
        beforePurgeMB: rssBeforePurge,
        afterPurgeMB: rssAfterPurge,
        purgeReleasedMB:
          rssBeforePurge !== null && rssAfterPurge !== null ? rssBeforePurge - rssAfterPurge : null,
        purgeOutcome
      },
      listenerDump: listeners,
      domGrowthByTag: diffCensusMap(censusBefore.byTag, censusAfter.byTag).slice(0, 30),
      domGrowthByPath: diffCensusMap(censusBefore.byPath, censusAfter.byPath).slice(0, 40)
    }

    const resultPath = path.join(RESULTS_ROOT, label, 'leak-locate.json')
    fs.mkdirSync(path.dirname(resultPath), { recursive: true })
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))

    console.log(`[perf] leak-locate written to ${resultPath}`)
    console.log(`[perf] tracker=${installStatus} terminalCycles=${terminalCycles} warnings=${warnings.length}`)
    console.log(`[perf] nodes: attached +${attachedGrowth} (${result.nodes.attachedPerCycle.toFixed(2)}/cycle), CDP total +${totalNodeGrowth} (${result.nodes.totalPerCycle.toFixed(2)}/cycle), detached share ${result.nodes.detachedShare}`)
    console.log(`[perf] CDP listeners: +${result.cdpListeners.growth} (${result.cdpListeners.perCycle.toFixed(2)}/cycle)`)
    console.log(`[perf] RSS slope: window ${result.rss.windowSlopeMBPerCycle?.toFixed(4) ?? 'n/a'} MB/cycle, app total ${result.rss.totalSlopeMBPerCycle?.toFixed(4) ?? 'n/a'} MB/cycle (${rssSeries.length} windows)`)
    console.log(`[perf] RSS slope: window ${result.rss.windowSlopeMBPerMinute?.toFixed(3) ?? 'n/a'} MB/min at ${(result.msPerCycle / 1000).toFixed(2)} s/cycle${IDLE_MS > 0 ? ' (idle arm: no file opened)' : ''}`)
    console.log(`[perf] RSS purge: first=${result.rss.firstSampleMB?.toFixed(1) ?? 'n/a'} beforePurge=${rssBeforePurge?.toFixed(1) ?? 'n/a'} afterPurge=${rssAfterPurge?.toFixed(1) ?? 'n/a'} released=${result.rss.purgeReleasedMB?.toFixed(1) ?? 'n/a'} MB`)
    console.log(`[perf] tracked adds=${listeners.added} removed=${listeners.removed} targetCollected=${listeners.targetCollected} outstanding=${listeners.outstanding}`)
    for (const group of listeners.groups.slice(0, 15)) {
      console.log(`[perf]   ${String(group.count).padStart(4)}  ${group.type}${group.capture ? ' (capture)' : ''} on ${group.target}`)
      console.log(`[perf]         ${group.origin}`)
    }
  } finally {
    await app.close().catch(() => {})
    cleanupTestConfigDir(testConfigDir)
  }
})
