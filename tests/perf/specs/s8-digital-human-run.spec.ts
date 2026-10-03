/**
 * S8 — Digital human run: trigger a seeded automation app and measure one
 * full run cycle. Reuses this repo's existing seeding infra
 * (`tests/e2e/fixtures/electron-with-app.ts` + `seed-app.ts`) rather than
 * building a second one — it already seeds a runnable app directly into the
 * SQLite file the app opens on boot, schema-identical to what `AppManager`
 * would have written (see seed-app.ts's own doc comment).
 *
 * Points at the local SSE mock the same way S2/S6 do, for the same reason:
 * a fixed token count/rate makes before/after comparable, and doesn't
 * depend on the currently-unreliable real provider.
 *
 * The mock must call report_to_user for the headless run to finish normally.
 */

import { test, expect } from '../../e2e/fixtures/electron-with-app'
import { navigateToApps } from '../../e2e/fixtures/helpers'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from '../lib/result-writer'
import { writeSkipResult } from '../lib/skip-record'
import { getBuildIdentity } from '../lib/build-identity'
import type { HaloAPI } from '../../../src/preload/index'
import type { AutomationRunWithSummary } from '../../../src/shared/apps/app-types'
import type { PerfResult } from '../types'

// The header shows "Run now" as the button's text; paused apps offer "Resume and run now".
const RUN_NOW_NAME = /^(Resume and run now|Run now)$/

test('S8 digital human run', async ({ electronApp, window, seededApp }, testInfo) => {
  beginScenario('s8-digital-human-run')
  if (!process.env.HALO_TEST_API_KEY) {
    writeSkipResult(
      's8-digital-human-run',
      'no-api-key',
      'Point HALO_TEST_* at tests/perf/mock/sse-server.mjs or a real source to run this.'
    )
    testInfo.skip(true, 'HALO_TEST_API_KEY not set (point it at tests/perf/mock/sse-server.mjs or a real source)')
    return
  }
  const warnings: string[] = []

  await navigateToApps(window)
  const appEntry = await window.waitForSelector(`text="${seededApp.name}"`, { timeout: 10000 })
  await appEntry.click()

  await installRenderObserversNow(window)
  await installUnresponsiveTracker(electronApp)
  const reloadGuard = installReloadGuard(window)

  const cdp = new CdpMetricsCollector(window)
  await cdp.connect()
  const throttle = currentThrottle()
  await cdp.setCpuThrottlingRate(throttle)

  await resetRenderObservers(window)
  const heapStart = await cdp.snapshot()

  const sampler = new ProcessMetricsSampler(electronApp)
  sampler.start()
  const t0 = Date.now()

  const existingRuns = await window.evaluate(async (appId) => {
    const response = await (window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId, options: { limit: 10 } })
    if (!response.success || !Array.isArray(response.data)) throw new Error('Could not read runs before triggering')
    return (response.data as AutomationRunWithSummary[]).map(run => run.runId)
  }, seededApp.appId)
  const runNowButton = window.getByRole('button', { name: RUN_NOW_NAME }).first()
  await runNowButton.waitFor({ state: 'visible', timeout: 10000 })
  await runNowButton.click()

  let observedRun: AutomationRunWithSummary | null = null
  let finishedRun: AutomationRunWithSummary | null = null
  const deadline = Date.now() + 90000
  while (Date.now() < deadline && !finishedRun) {
    const response = await window.evaluate(async (appId) => {
      return (window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId, options: { limit: 10 } })
    }, seededApp.appId)
    if (response.success && Array.isArray(response.data)) {
      const run = (response.data as AutomationRunWithSummary[]).find(item => !existingRuns.includes(item.runId))
      if (run) {
        observedRun = run
        if (run.status !== 'running') finishedRun = run
      }
    }
    if (!finishedRun) await window.waitForTimeout(500)
  }
  if (!observedRun) warnings.push('No new run record appeared after triggering the seeded app.')
  else if (!finishedRun) warnings.push(`Run ${observedRun.runId} did not finish within 90s.`)
  const session = finishedRun ? await window.evaluate(async ({ appId, runId }) => {
    return (window as unknown as { halo: HaloAPI }).halo.appGetSession({ appId, runId })
  }, { appId: seededApp.appId, runId: finishedRun.runId }) : null
  const messages = session?.success && Array.isArray(session.data) ? session.data as Array<{ role: string; content?: string }> : []
  const assistantOutput = messages.some(message => message.role === 'assistant' && !!message.content?.trim())

  const durationMs = Date.now() - t0
  sampler.stop()

  const rendererReloads = reloadGuard.getReloadCount()
  const crashCount = await readCrashCount(electronApp).catch(() => 0)
  const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

  const samplingStats = sampler.getSamplingStats()
  if (samplingStats.plannedTicks > 0 && samplingStats.succeededTicks < samplingStats.plannedTicks) {
    warnings.push(`cpu/mem: ${samplingStats.plannedTicks - samplingStats.succeededTicks}/${samplingStats.plannedTicks} process-metrics ticks failed.`)
  }

  let heapEnd: CdpSnapshot | null = null
  if (noReloadOrCrash) {
    try {
      heapEnd = await cdp.snapshot()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${message}) — end/delta reported as null.`)
    }
  }

  const { cpu, mem } = sampler.summarize()

  let render: { longtask: PerfResult['longtask']; eventLatency: PerfResult['eventLatency'] }
  try {
    render = await readRenderMetrics(window)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push(`longtask/eventLatency: window.__perf read failed (${message}) — reported as null.`)
    render = { longtask: null, eventLatency: null }
  }
  const unmeasuredMetrics: string[] = []
  if (render.longtask === null) {
    unmeasuredMetrics.push('longtask')
    warnings.push('longtask: PerformanceObserver never attached — null, not "0 observed".')
  }
  if (render.eventLatency === null) {
    unmeasuredMetrics.push('eventLatency')
    warnings.push('eventLatency: PerformanceObserver never attached — null, not "0 observed".')
  }

  // Headless runs write JSONL; SessionDetailView polls it instead of rendering
  // a streaming cursor. A matching persisted reply and completed run are the
  // proof this scenario exercised the execution path.
  const status: PerfResult['status'] = finishedRun?.status === 'ok' && assistantOutput ? 'ok' : 'precondition-failed'
  const note = `runId=${observedRun?.runId ?? 'none'}, runStatus=${finishedRun?.status ?? 'none'}, ` +
    `runError=${finishedRun?.errorMessage ?? 'none'}, sessionRead=${session?.success ?? false}, ` +
    `messageCount=${messages.length}, assistantOutput=${assistantOutput}`

  // `valid` = contamination-free AND a completed run with output.
  const valid = noReloadOrCrash && status === 'ok'
  const unresponsiveCount = await readUnresponsiveCount(electronApp)

  const result: PerfResult = {
    scenario: 's8-digital-human-run',
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
    unresponsiveCount,
    rendererReloads,
    crashCount,
    valid,
    unmeasuredMetrics: unmeasuredMetrics.length ? unmeasuredMetrics : undefined,
    status,
    note,
    warnings: warnings.length ? warnings : undefined
  }

  const filePath = writeResult(result)
  console.log(`[perf] S8 result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

  expect(result.durationMs).toBeGreaterThan(0)
  expect(result.valid, note).toBe(true)
})
