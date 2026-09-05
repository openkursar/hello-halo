/**
 * S8 — Digital human run: trigger a seeded automation app and measure one
 * full run cycle. Reuses this repo's existing seeding infra
 * (`tests/e2e/fixtures/electron-with-app.ts` + `seed-app.ts`) rather than
 * building a second one — it already seeds a runnable app directly into the
 * SQLite file the app opens on boot, schema-identical to what `AppManager`
 * would have written (see seed-app.ts's own doc comment).
 *
 * Points at the WP9 local mock the same way S2/S6 do, for the same reason:
 * a fixed token count/rate makes before/after comparable, and doesn't
 * depend on the currently-unreliable real provider.
 */

import { test, expect } from '../../e2e/fixtures/electron-with-app'
import { navigateToApps } from '../../e2e/fixtures/helpers'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentityString } from '../lib/build-identity'
import type { PerfResult } from '../types'

const RUN_NOW_SELECTOR = [
  'button[title="Run now"]', 'button[title="立即执行"]',
  'button[title="Resume and run now"]', 'button[title="立即恢复并运行"]',
].join(', ')

test('S8 digital human run', async ({ electronApp, window, seededApp }, testInfo) => {
  if (!process.env.HALO_TEST_API_KEY) {
    // Per WP7 harness audit P1#9: don't let this vanish silently from the
    // comparison table — write an explicit status:'skipped' stub.
    const skipResult: PerfResult = {
      scenario: 's8-digital-human-run',
      label: currentLabel(),
      gitSha: getBuildIdentityString(),
      throttle: currentThrottle(),
      durationMs: 0,
      cpu: { byProcessType: {} },
      mem: { byProcessType: {} },
      sampling: { plannedTicks: 0, succeededTicks: 0 },
      longtask: null,
      eventLatency: null,
      heap: { startMB: 0, endMB: null, deltaMB: null },
      nodes: { start: 0, end: null, delta: null },
      listeners: { start: 0, end: null, delta: null },
      unresponsiveCount: 0,
      rendererReloads: 0,
      crashCount: 0,
      valid: false,
      status: 'skipped',
      note: 'HALO_TEST_API_KEY not set — point HALO_TEST_* at the WP9 mock or a real source to run this.'
    }
    writeResult(skipResult)
    testInfo.skip(true, 'Skipping S8: HALO_TEST_API_KEY not set (point it at the WP9 mock or a real source)')
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

  const runNowButton = await window.waitForSelector(RUN_NOW_SELECTOR, { timeout: 10000 })
  await runNowButton.click()

  // Follow into the live process view the same way digital-human-lifecycle.spec.ts does.
  await window.waitForTimeout(800)
  const activityTab = await window.$('text=/^Activity$|^活动$/i')
  if (activityTab) {
    await activityTab.click()
    await window.waitForTimeout(400)
  }
  await window.waitForSelector('text=/View process|查看进程/i', { timeout: 45000 }).catch(() => {
    warnings.push('Never reached "View process" — run may not have started visibly within 45s.')
  })

  // Completion signal: the run's own working/streaming indicator clearing,
  // same shape as S2's chat — not the "Halo 工作中" text (see
  // wait-for-stream-complete.ts's rationale), the `.streaming-cursor`
  // element used across the whole chat surface.
  const streamingObserved = await window.waitForSelector('.streaming-cursor', { timeout: 15000 })
    .then(() => true)
    .catch(() => false)
  await window.waitForSelector('.streaming-cursor', { state: 'detached', timeout: 90000 }).catch((err) => {
    warnings.push(`Run did not visibly complete within 90s: ${err instanceof Error ? err.message : String(err)}`)
  })

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

  // Per Lead: a scenario that spins through its own timeouts without the
  // seeded app ever actually doing anything must fail loudly, not blend in
  // as another valid:true row — same "自证前提" requirement as S2/S4/S5/S6.
  // `streamingObserved` is the minimal proof any real activity happened;
  // without it, `durationMs` is just the sum of this file's own wait
  // timeouts (see the diagnosis reported to Lead: 60886ms ≈ 45s+15s+800ms+400ms).
  const status: PerfResult['status'] = streamingObserved ? 'ok' : 'precondition-failed'
  const note = streamingObserved
    ? undefined
    : 'No ".streaming-cursor" was ever observed — the run does not look like it produced any real output ' +
      '(durationMs is likely just the sum of this test\'s own wait timeouts, not actual work).'

  // Per Lead: `valid` = contamination-free AND the run actually did
  // something (status === 'ok'), same narrowed definition used elsewhere.
  const valid = noReloadOrCrash && status === 'ok'
  const unresponsiveCount = await readUnresponsiveCount(electronApp)

  const result: PerfResult = {
    scenario: 's8-digital-human-run',
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
    warnings: warnings.length ? warnings : undefined
  }

  const filePath = writeResult(result)
  console.log(`[perf] S8 result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

  expect(result.durationMs).toBeGreaterThan(0)
})
