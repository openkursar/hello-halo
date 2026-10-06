/**
 * One streamed reply of a fixed shape, measured like S2 (`s2-long-stream`).
 *
 * The shape comes from the local SSE mock: the prompt carries
 * `mock-content:<preset>` (see mock/sse-server.mjs), so the reply is
 * byte-identical every run. The caller proves the reply really had that shape
 * (`precondition`) and may watch the live bubble while it streams
 * (`probes`: elements matching each selector are counted in the page every
 * 200 ms; the largest count per probe is reported).
 */

import type { ElectronApplication, Page } from '@playwright/test'
import { navigateToChat, sendMessage } from '../../e2e/fixtures/helpers'
import { waitForStreamComplete } from './wait-for-stream-complete'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from './render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from './cdp-metrics'
import { ProcessMetricsSampler } from './process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from './unresponsive'
import { installReloadGuard } from './reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from './result-writer'
import { getBuildIdentity } from './build-identity'
import { installLiveUpdateCounters, readLiveUpdates } from './live-updates'
import type { PerfResult } from '../types'

export interface StreamShapeScenario {
  scenario: string
  prompt: string
  /** Selectors counted while the reply streams; the largest count of each is passed to `precondition`. */
  probes?: Record<string, string>
  /** Runs on the chat page before measuring starts, e.g. to open a preview beside the chat. */
  prepare?: (page: Page) => Promise<void>
  /** Count how often the live turn changes (`liveUpdates` in the result). */
  countLiveUpdates?: boolean
  /** After the reply settled: a failure message if it does not have the promised shape. */
  precondition: (page: Page, probeMax: Record<string, number>, liveUpdates: PerfResult['liveUpdates'] | null) => Promise<string | undefined>
}

export async function runStreamShapeScenario(
  electronApp: ElectronApplication,
  page: Page,
  spec: StreamShapeScenario,
): Promise<PerfResult> {
  beginScenario(spec.scenario)
  const warnings: string[] = []

  await navigateToChat(page)
  await spec.prepare?.(page)
  await installRenderObserversNow(page)
  await installUnresponsiveTracker(electronApp)

  const cdp = new CdpMetricsCollector(page)
  await cdp.connect()
  const throttle = currentThrottle()
  await cdp.setCpuThrottlingRate(throttle)

  await resetRenderObservers(page)
  const heapStart = await cdp.snapshot()
  const reloadGuard = installReloadGuard(page)

  const probes = spec.probes ?? {}
  await page.evaluate((selectors) => {
    const max: Record<string, number> = {}
    for (const name of Object.keys(selectors)) max[name] = 0
    const timer = window.setInterval(() => {
      for (const [name, selector] of Object.entries(selectors)) {
        max[name] = Math.max(max[name], document.querySelectorAll(selector).length)
      }
    }, 200)
    ;(window as unknown as { __streamProbe?: unknown }).__streamProbe = { max, timer }
  }, probes)

  if (spec.countLiveUpdates) await installLiveUpdateCounters(page)

  const sampler = new ProcessMetricsSampler(electronApp)
  sampler.start()
  const t0 = Date.now()

  await sendMessage(page, spec.prompt)
  await waitForStreamComplete(page, 120000)

  const durationMs = Date.now() - t0
  sampler.stop()

  const probeMax = await page.evaluate(() => {
    const probe = (window as unknown as { __streamProbe?: { max: Record<string, number>; timer: number } }).__streamProbe
    if (probe) window.clearInterval(probe.timer)
    return probe?.max ?? {}
  })

  let liveUpdates: PerfResult['liveUpdates'] | null = null
  if (spec.countLiveUpdates) {
    try {
      liveUpdates = await readLiveUpdates(page)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`liveUpdates: counters could not be read (${message}) — reported as null.`)
    }
  }

  // Let the finished message render statically (and highlight) before checking its shape.
  await page.waitForTimeout(1500)
  const preconditionFailure = await spec.precondition(page, probeMax, liveUpdates)

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
    render = await readRenderMetrics(page)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push(`longtask/eventLatency: window.__perf read failed (${message}) — reported as null.`)
    render = { longtask: null, eventLatency: null }
  }
  const unmeasuredMetrics: string[] = []
  if (render.longtask === null) unmeasuredMetrics.push('longtask')
  if (render.eventLatency === null) unmeasuredMetrics.push('eventLatency')
  if (spec.countLiveUpdates && liveUpdates === null) unmeasuredMetrics.push('liveUpdates')

  const status: PerfResult['status'] = preconditionFailure ? 'precondition-failed' : 'ok'
  const result: PerfResult = {
    scenario: spec.scenario,
    label: currentLabel(),
    build: getBuildIdentity(),
    throttle,
    durationMs,
    cpu,
    mem,
    sampling: samplingStats,
    longtask: render.longtask,
    eventLatency: render.eventLatency,
    heap: { startMB: heapStart.heapMB, endMB: heapEnd?.heapMB ?? null, deltaMB: heapEnd ? heapEnd.heapMB - heapStart.heapMB : null },
    nodes: { start: heapStart.nodes, end: heapEnd?.nodes ?? null, delta: heapEnd ? heapEnd.nodes - heapStart.nodes : null },
    listeners: { start: heapStart.listeners, end: heapEnd?.listeners ?? null, delta: heapEnd ? heapEnd.listeners - heapStart.listeners : null },
    unresponsiveCount: await readUnresponsiveCount(electronApp),
    rendererReloads,
    crashCount,
    valid: noReloadOrCrash && status === 'ok',
    ...(liveUpdates ? { liveUpdates } : {}),
    unmeasuredMetrics: unmeasuredMetrics.length ? unmeasuredMetrics : undefined,
    status,
    note: preconditionFailure,
    warnings: warnings.length ? warnings : undefined,
  }

  const filePath = writeResult(result)
  console.log(`[perf] ${spec.scenario} result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)
  return result
}
