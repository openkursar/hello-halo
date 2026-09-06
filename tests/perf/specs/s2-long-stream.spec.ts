/**
 * S2 — Chat: long streaming reply.
 *
 * Prompts for a response guaranteed to be long (multiple code blocks), then
 * samples all four collector layers across the full streaming window. This
 * is the scenario user feedback points at most directly: "打开文件预览之后，
 * 再和 AI 聊天，CPU 起来很明显" and the zero-throttle streaming path itself
 * (`stream-processor.ts:668-679` sends every text_delta immediately).
 */

import { test, expect, hasApiKey } from '../fixtures/perf-electron'
import { navigateToChat, sendMessage } from '../../e2e/fixtures/helpers'
import { waitForStreamComplete } from '../lib/wait-for-stream-complete'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, currentLabel, currentThrottle } from '../lib/result-writer'
import { writeSkipResult } from '../lib/skip-record'
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'

const LONG_REPLY_PROMPT =
  'Write a complete React todo app. Give me the full code for 5 separate components ' +
  '(App, TodoList, TodoItem, AddTodoForm, FilterBar) with explanations for each, in Markdown ' +
  'with fenced code blocks. Do not use any tools, just write the answer directly in the chat.'

test('S2 long stream', async ({ electronApp, window }, testInfo) => {
  if (!hasApiKey()) {
    writeSkipResult(
      's2-long-stream',
      'no-api-key',
      'Point HALO_TEST_* at tests/perf/mock/sse-server.mjs or a real source to run this.'
    )
    testInfo.skip(true, 'HALO_TEST_API_KEY not set (point it at tests/perf/mock/sse-server.mjs or a real source)')
    return
  }
  const warnings: string[] = []

  await navigateToChat(window)
  await installRenderObserversNow(window)
  await installUnresponsiveTracker(electronApp)

  const cdp = new CdpMetricsCollector(window)
  await cdp.connect()
  const throttle = currentThrottle()
  await cdp.setCpuThrottlingRate(throttle)

  await resetRenderObservers(window)
  const heapStart = await cdp.snapshot()
  const reloadGuard = installReloadGuard(window)

  const sampler = new ProcessMetricsSampler(electronApp)
  sampler.start()
  const t0 = Date.now()

  await sendMessage(window, LONG_REPLY_PROMPT)
  // Not waitForAIResponse: it waits on the "Halo 工作中" pre-content
  // indicator, already hidden by the time real streaming begins — resolves
  // near-instantly instead of tracking the actual stream (see
  // wait-for-stream-complete.ts). waitForStreamComplete tracks the
  // `.streaming-message` class directly: appear, then disappear.
  await waitForStreamComplete(window, 90000)

  const durationMs = Date.now() - t0
  sampler.stop()

  // "Measured a real number" and "actually happened" are different claims —
  // a scenario that resolves early (e.g. a stale/broken completion detector)
  // can still write out a plausible-looking valid:true result.
  // `waitForStreamComplete` returning isn't proof by itself; check the thing
  // this scenario exists to measure actually occurred, the same way
  // file-preview-scenario.ts asserts nodes.delta > 0.
  const assistantTextLength: number = await window.evaluate(() => {
    const nodes = document.querySelectorAll('.message-assistant [data-message-content]')
    let total = 0
    for (const n of nodes) total += (n.textContent ?? '').length
    return total
  }).catch(() => 0)
  const MIN_ASSISTANT_TEXT_LENGTH = 1000
  let status: PerfResult['status'] | undefined
  let note: string | undefined
  if (assistantTextLength < MIN_ASSISTANT_TEXT_LENGTH) {
    status = 'precondition-failed'
    note = `Assistant message text is only ${assistantTextLength} chars (< ${MIN_ASSISTANT_TEXT_LENGTH}) — this does not look like a real long-stream reply landed; treat this run's numbers as not measuring what S2 claims to measure.`
  } else {
    status = 'ok'
  }

  const rendererReloads = reloadGuard.getReloadCount()
  const crashCount = await readCrashCount(electronApp).catch(() => 0)
  const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

  const samplingStats = sampler.getSamplingStats()
  if (samplingStats.plannedTicks > 0 && samplingStats.succeededTicks < samplingStats.plannedTicks) {
    warnings.push(`cpu/mem: ${samplingStats.plannedTicks - samplingStats.succeededTicks}/${samplingStats.plannedTicks} process-metrics ticks failed — avg/max may be skewed toward the calmer part of the run.`)
  }

  let heapEnd: CdpSnapshot | null = null
  if (noReloadOrCrash) {
    try {
      heapEnd = await cdp.snapshot()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${message}) — end/delta reported as null, not backfilled with the start value.`)
    }
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

  // `valid` answers "was this run contaminated" (reload/crash) "and did the
  // action complete" (status === 'ok', which also covers the precondition
  // self-check above) — not "was every metric measured", see
  // `unmeasuredMetrics` for per-field gaps.
  const valid = noReloadOrCrash && status === 'ok'

  const unresponsiveCount = await readUnresponsiveCount(electronApp)

  const result: PerfResult = {
    scenario: 's2-long-stream',
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
  console.log(`[perf] S2 result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

  expect(result.durationMs).toBeGreaterThan(0)
})
