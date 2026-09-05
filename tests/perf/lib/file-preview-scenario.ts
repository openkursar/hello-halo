import path from 'path'
import { fileURLToPath } from 'url'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from './render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from './cdp-metrics'
import { ProcessMetricsSampler } from './process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from './unresponsive'
import { installReloadGuard } from './reload-guard'
import { sampleIdleCpu } from './idle-cpu'
import { seedArtifact, clickArtifactByName, waitForCanvasLoaded, waitForPdfLoaded } from './open-artifact'
import { writeResult, currentLabel, currentThrottle } from './result-writer'
import { getBuildIdentityString } from './build-identity'
import type { PerfResult } from '../types'

const __filename = fileURLToPath(import.meta.url)
const FIXTURES_ROOT = path.resolve(path.dirname(__filename), '../../../halo-local/temp/perf-fixtures')

export interface FilePreviewScenarioOptions {
  scenario: string
  /** Filename inside halo-local/temp/perf-fixtures/, e.g. "md-extreme-2mb.md". */
  fixtureFileName: string
  /** How long to wait for the file to finish loading before giving up. */
  openTimeoutMs?: number
  /** If true, an open timeout is recorded as `status: "hung"` instead of throwing. */
  toleratesHang?: boolean
  /** How long to sample idle CPU after render settles (Lead's S4/S5/S6 requirement). 0 skips it. */
  idleCpuMs?: number
  /** Also record a per-pid breakdown (e.g. S5 pdf's separate BrowserView process). */
  includePerProcess?: boolean
  /** pdf/browser tabs bypass ContentCanvas's "Loading..." branch (own "Opening..." overlay). */
  loadingKind?: 'canvas' | 'pdf'
}

/**
 * One full launch -> seed fixture -> open in canvas -> measure -> close cycle.
 * Shared by S4 (markdown deep-dive) and S5 (breadth across 8 content types)
 * so each scenario isolates its own DOM/heap baseline instead of carrying
 * over state from a previously opened file in the same window.
 *
 * Every fallback in this function follows one rule (WP7 harness audit): a
 * failed read becomes `null` + a `warnings` entry, never a plausible-looking
 * number. The scenario most likely to fail partway through collection is
 * exactly the scenario the report most needs correct — "how bad did this
 * get" — so silently substituting a clean default is the one thing this
 * harness must never do.
 */
export async function runFilePreviewScenario(opts: FilePreviewScenarioOptions): Promise<PerfResult> {
  const openTimeoutMs = opts.openTimeoutMs ?? 60000
  const idleCpuMs = opts.idleCpuMs ?? 60000

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const fixturePath = path.join(FIXTURES_ROOT, opts.fixtureFileName)
  const { name: artifactName } = seedArtifact(testConfigDir, fixturePath)

  const app = await launchElectronApp(appEntryPath, testConfigDir)
  let status: PerfResult['status'] = 'ok'
  let note: string | undefined
  const warnings: string[] = []

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await installRenderObserversNow(window)
    await installUnresponsiveTracker(app)
    // Installed after the SPA's own initial load — any 'load' event from
    // here on is a silent recoverRenderer() reload, not real navigation.
    const reloadGuard = installReloadGuard(window)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()
    const throttle = currentThrottle()
    await cdp.setCpuThrottlingRate(throttle)

    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()

    const sampler = new ProcessMetricsSampler(app)
    sampler.start()
    const t0 = Date.now()

    await clickArtifactByName(window, artifactName)

    try {
      if (opts.loadingKind === 'pdf') {
        await waitForPdfLoaded(window, openTimeoutMs)
      } else {
        await waitForCanvasLoaded(window, openTimeoutMs)
      }
    } catch (err) {
      if (!opts.toleratesHang) throw err
      const message = err instanceof Error ? err.message : String(err)
      // Only classify as "hung" when we actually hit our own wait timeout —
      // any other failure (crashed context, closed target, etc.) is a
      // different finding and must not be relabeled as "rendering never
      // finishes", which is a specific, real claim about the app.
      status = message.includes('Timeout') && message.includes(`${openTimeoutMs}ms`) ? 'hung' : 'error'
      note = status === 'hung'
        ? `Did not finish loading within ${openTimeoutMs}ms — the hang itself is the result, not a test failure.`
        : `Failed for a reason other than a load timeout: ${message}`
    }

    const durationMs = Date.now() - t0

    // A reload or crash mid-scenario resets window.__perf and can invalidate
    // the CDP session's execution context — check before touching either,
    // since the worst thing we can do here is let a stale-context error
    // crash the whole scenario and lose the one datum (rendererReloads /
    // crashCount) that actually matters for a run this broken. Both are
    // read even though we already have a caught error/timeout above:
    // 'render-process-gone' can fire and recover *silently* mid-wait
    // without ever surfacing as a thrown error on this end.
    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    if ((rendererReloads > 0 || crashCount > 0) && status === 'ok') {
      status = 'error'
      note = crashCount > 0
        ? `Renderer crashed ${crashCount}x mid-scenario ('render-process-gone') — recoverRenderer() may have recreated the window; this file's numbers are not trustworthy.`
        : `Renderer silently reloaded ${rendererReloads}x mid-scenario (recoverRenderer() on 'unresponsive') — buffers reset, this file's numbers are not trustworthy.`
    }
    // Gates whether it's worth attempting idleCpu/heapEnd below (reload/crash
    // invalidate the execution context). `valid` itself is finalized further
    // down once we also know whether the longtask/event observers attached —
    // per Lead, "collector never worked" must sink `valid` exactly like
    // "renderer reloaded" does.
    const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

    let idleCpu: PerfResult['idleCpu']
    if (noReloadOrCrash && status === 'ok' && idleCpuMs > 0) {
      idleCpu = await sampleIdleCpu(app, idleCpuMs, 1000)
      if (idleCpu.failedTicks > 0) {
        warnings.push(`idleCpu: ${idleCpu.failedTicks}/${idleCpu.totalTicks} sample ticks failed (app unreachable) — avg/max computed from the ${idleCpu.totalTicks - idleCpu.failedTicks} that succeeded.`)
      }
    }

    sampler.stop()
    const samplingStats = sampler.getSamplingStats()
    if (samplingStats.plannedTicks > 0 && samplingStats.succeededTicks < samplingStats.plannedTicks) {
      warnings.push(`cpu/mem: ${samplingStats.plannedTicks - samplingStats.succeededTicks}/${samplingStats.plannedTicks} process-metrics ticks failed — avg/max may be skewed toward the calmer part of the run.`)
    }

    let heapEnd: CdpSnapshot | null = null
    if (noReloadOrCrash && status === 'ok') {
      try {
        heapEnd = await cdp.snapshot()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${message}) — end/delta reported as null, not backfilled with the start value.`)
      }
    }

    // Per Lead: "waitForCanvasLoaded resolved without error" is not proof
    // the file actually rendered — assert the thing this scenario exists to
    // measure actually happened. Opening any real file adds at least one
    // DOM node; a zero/negative delta means nothing rendered, the same
    // "measured a plausible number without the scenario doing its job"
    // failure mode as S2's premature-completion bug.
    if (status === 'ok' && heapEnd && heapEnd.nodes - heapStart.nodes <= 0) {
      status = 'precondition-failed'
      note = `nodes.delta was ${heapEnd.nodes - heapStart.nodes} (<= 0) after opening ${opts.fixtureFileName} — this does not look like the file actually rendered.`
    }

    const { cpu, mem } = sampler.summarize()

    let render: { longtask: PerfResult['longtask']; eventLatency: PerfResult['eventLatency'] }
    try {
      render = await readRenderMetrics(window)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`longtask/eventLatency: window.__perf read failed (${message}) — reported as null, not a fabricated 0.`)
      render = { longtask: null, eventLatency: null }
    }
    const unmeasuredMetrics: string[] = []
    if (render.longtask === null) {
      unmeasuredMetrics.push('longtask')
      warnings.push('longtask: PerformanceObserver never attached (entryType unsupported) — null, not "0 observed".')
    }
    if (render.eventLatency === null) {
      unmeasuredMetrics.push('eventLatency')
      warnings.push('eventLatency: PerformanceObserver never attached (entryType unsupported) — null, not "0 observed".')
    }

    // Per Lead: `valid` = "was this run contaminated (reload/crash) and did
    // the action itself complete" — a single unmeasured metric must not sink
    // an otherwise-good run (see `unmeasuredMetrics`), but a 'hung'/'error'
    // status genuinely means the action didn't complete, so it does count here.
    const valid = noReloadOrCrash && status === 'ok'

    const unresponsiveCount = await readUnresponsiveCount(app)

    const result: PerfResult = {
      scenario: opts.scenario,
      label: currentLabel(),
      gitSha: getBuildIdentityString(),
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
      status,
      note,
      warnings: warnings.length ? warnings : undefined,
      idleCpu
    }

    if (opts.includePerProcess) {
      result.perProcess = sampler.summarizeByPid()
    }

    const filePath = writeResult(result)
    console.log(`[perf] ${opts.scenario} result written to ${filePath} (status=${status}${warnings.length ? `, ${warnings.length} warning(s)` : ''})`)

    return result
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
}
