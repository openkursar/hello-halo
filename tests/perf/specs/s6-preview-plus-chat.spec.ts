/**
 * S6 — Preview + chat overlay: open a large markdown preview, record an idle
 * CPU baseline *before* starting a chat (so "preview alone" vs "preview +
 * streaming chat" can be told apart), then send a long-reply prompt against
 * the WP9 local mock and measure through to stream completion.
 *
 * This is the scenario user feedback points at most directly: "打开文件预览
 * 之后，再和 AI 聊天，CPU 起来很明显。" Per Lead: without a pre-chat idle
 * baseline there's no way to attribute the overlay's cost to chat specifically
 * versus the preview simply not having settled yet.
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { sampleIdleCpu } from '../lib/idle-cpu'
import { seedArtifact, clickArtifactByName, waitForCanvasLoaded } from '../lib/open-artifact'
import { writeResult, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentityString } from '../lib/build-identity'
import type { PerfResult } from '../types'

const __filename = fileURLToPath(import.meta.url)
const FIXTURES_ROOT = path.resolve(path.dirname(__filename), '../../../halo-local/temp/perf-fixtures')

const LONG_REPLY_PROMPT =
  'Write a complete React todo app. Give me the full code for 5 separate components ' +
  '(App, TodoList, TodoItem, AddTodoForm, FilterBar) with explanations for each, in Markdown ' +
  'with fenced code blocks. Do not use any tools, just write the answer directly in the chat.'

// Per Lead: a control run swapping only the fixture size (extreme 2MB vs
// typical 5KB) isolates whether a hang is "the 2MB markdown's 536K nodes
// make every subsequent UI interaction slow" versus an environment/test
// issue — everything else in the scenario is identical.
const FIXTURE_FILE = process.env.S6_FIXTURE || 'md-extreme-2mb.md'
const SCENARIO_NAME = FIXTURE_FILE === 'md-extreme-2mb.md' ? 's6-preview-plus-chat' : 's6-control-typical-md'

test(`S6 preview + chat overlay (${FIXTURE_FILE})`, async () => {
  // Two heavy phases back to back (60s idle CPU window + up to 90s stream)
  // on top of an already-expensive markdown open — give real headroom
  // instead of the project default.
  test.setTimeout(360000)
  if (!process.env.HALO_TEST_API_KEY) {
    // Per WP7 harness audit P1#9: don't let this vanish silently from the
    // comparison table — write an explicit status:'skipped' stub.
    const skipResult: PerfResult = {
      scenario: SCENARIO_NAME,
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
    test.skip(true, 'Skipping S6: HALO_TEST_API_KEY not set (point it at the WP9 mock or a real source)')
    return
  }
  const warnings: string[] = []

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const { name: artifactName } = seedArtifact(testConfigDir, path.join(FIXTURES_ROOT, FIXTURE_FILE))

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

    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()

    const sampler = new ProcessMetricsSampler(app)
    sampler.start()
    const t0 = Date.now()

    // Per Lead: a bare total duration or timeout only tells you *that*
    // something was slow, not *which step* — record a checkpoint at every
    // phase transition so a stuck run is a one-glance answer instead of
    // "read不到明确阻塞点".
    const steps: Array<{ label: string; tMs: number }> = []
    const markStep = (label: string) => steps.push({ label, tMs: Date.now() - t0 })

    await clickArtifactByName(window, artifactName)
    await waitForCanvasLoaded(window, 60000)
    markStep('preview-opened')

    // Per Lead: assert both halves of "preview + chat overlay" actually
    // happened, not just that the wait calls returned without error. Preview
    // half: the canvas should have real nodes in it after opening a 2MB file.
    let preconditionFailure: string | undefined
    const afterPreviewSnapshot = await cdp.snapshot().catch(() => null)
    if (afterPreviewSnapshot && afterPreviewSnapshot.nodes - heapStart.nodes <= 0) {
      preconditionFailure = `nodes.delta after opening the preview was ${afterPreviewSnapshot.nodes - heapStart.nodes} (<= 0) — the preview does not look like it actually rendered.`
    }

    // Pre-chat idle baseline — isolates "preview alone" from "preview + chat".
    const idleCpu = await sampleIdleCpu(app, 60000, 1000)
    if (idleCpu.failedTicks > 0) {
      warnings.push(`idleCpu: ${idleCpu.failedTicks}/${idleCpu.totalTicks} sample ticks failed.`)
    }
    markStep('idle-baseline-done')

    // Per Lead's hypothesis: App.tsx's no-selector useChatStore() re-renders
    // the whole root on every streamed token, on top of the 536K nodes the
    // markdown preview left in the document — the two effects may multiply
    // rather than add, to the point the chat phase might not complete in any
    // reasonable time at all. That itself is the finding (a documented
    // multiplier from S2's standalone number would be more precise, but
    // "did not finish within N seconds while overlaid on the preview,
    // whereas standalone chat finishes in ~45s" is still a real, reportable
    // result) — so this phase gets the same hang tolerance as S5 CSV
    // extreme, not an unbounded wait.
    const chatTimeoutMs = 180000
    let status: PerfResult['status'] = 'ok'
    let note: string | undefined

    // Per Lead: eventLatency (the event-timing observer, durationThreshold
    // 100ms) has nothing to measure unless the user actually interacts
    // during streaming — S2 ran the whole 45s hands-off and eventLatency
    // came back {count: 0}, which isn't "no jank", it's "no interaction was
    // simulated to notice jank with". This is the metric closest to what
    // users mean by "卡" (persistent sluggish response), as opposed to
    // longtask which only catches single blocking tasks — a stream of
    // sub-50ms token updates never trips it no matter how bad the
    // cumulative cost gets. Scroll wheel ticks are a safe periodic
    // interaction: they generate real 'event' timing entries without
    // risking a stray click on a button/link mid-test.
    let stopInteracting = false
    const interactionLoop = (async () => {
      while (!stopInteracting) {
        await window.mouse.wheel(0, 120).catch(() => {})
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    })()

    try {
      await Promise.race([
        (async () => {
          // Manually instrumented equivalent of sendMessage() +
          // waitForStreamComplete(), with a markStep() between each phase —
          // this is what lets a stuck run point at the exact step instead
          // of just "chat phase timed out somewhere in there".
          const chatInput = await window.waitForSelector('textarea', { timeout: 30000 })
          markStep('input-clickable')
          await chatInput.fill(LONG_REPLY_PROMPT)
          markStep('text-filled')
          const sendButton = await window.waitForSelector('[data-onboarding="send-button"]', { timeout: 30000 })
          await sendButton.click({ force: true })
          markStep('send-clicked')
          await window.waitForSelector('.streaming-cursor', { timeout: 30000 })
          markStep('first-token-arrived')
          await window.waitForSelector('.streaming-cursor', { state: 'detached', timeout: chatTimeoutMs })
          markStep('stream-complete')
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`S6 chat phase did not complete within ${chatTimeoutMs}ms`)), chatTimeoutMs)
        )
      ])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      status = 'hung'
      note = `Chat phase (send + stream) did not complete within ${chatTimeoutMs}ms while overlaid on the preview — ` +
        `compare against S2's standalone ~45s to gauge the overlay's multiplier. Underlying error: ${message}`
    } finally {
      stopInteracting = true
      await interactionLoop
    }

    // Chat half of the precondition: same check as S2 — a resolved wait
    // isn't proof real streamed content landed.
    if (status === 'ok') {
      const assistantTextLength: number = await window.evaluate(() => {
        const nodes = document.querySelectorAll('.message-assistant [data-message-content]')
        let total = 0
        for (const n of nodes) total += (n.textContent ?? '').length
        return total
      }).catch(() => 0)
      if (assistantTextLength < 1000) {
        preconditionFailure = `${preconditionFailure ? preconditionFailure + ' ' : ''}Assistant message text is only ${assistantTextLength} chars (< 1000) — the chat half does not look like it actually streamed a real reply.`
      }
    }
    if (status === 'ok' && preconditionFailure) {
      status = 'precondition-failed'
      note = preconditionFailure
    }

    const durationMs = Date.now() - t0
    sampler.stop()

    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

    const samplingStats = sampler.getSamplingStats()
    if (samplingStats.plannedTicks > 0 && samplingStats.succeededTicks < samplingStats.plannedTicks) {
      warnings.push(`cpu/mem: ${samplingStats.plannedTicks - samplingStats.succeededTicks}/${samplingStats.plannedTicks} process-metrics ticks failed.`)
    }

    // If status is 'hung' the app may be genuinely unresponsive — bound
    // these final reads too, rather than risk the same open-ended hang that
    // caused the chat-phase timeout above.
    const boundedRead = async <T>(fn: () => Promise<T>, boundMs: number): Promise<T> =>
      Promise.race([fn(), new Promise<T>((_, reject) => setTimeout(() => reject(new Error('read timed out')), boundMs))])

    let heapEnd: CdpSnapshot | null = null
    if (noReloadOrCrash && status === 'ok') {
      try {
        heapEnd = await boundedRead(() => cdp.snapshot(), 15000)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${message}) — end/delta reported as null.`)
      }
    }

    const { cpu, mem } = sampler.summarize()

    let render: { longtask: PerfResult['longtask']; eventLatency: PerfResult['eventLatency'] }
    try {
      render = status === 'ok' ? await boundedRead(() => readRenderMetrics(window), 15000) : { longtask: null, eventLatency: null }
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

    // Per Lead: `valid` = contamination-free AND action completed
    // (status === 'ok'); a single unmeasured metric alone must not sink it
    // (see `unmeasuredMetrics`).
    const valid = noReloadOrCrash && status === 'ok'
    const unresponsiveCount = await readUnresponsiveCount(app)

    const result: PerfResult = {
      scenario: SCENARIO_NAME,
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
      idleCpu,
      // Per Lead: getAppMetrics() aggregates by `type`, blending the main
      // window's renderer with any other renderer-type process Halo has
      // running (AI browser offscreen window, daemon, overlay) — S6's
      // "main window re-renders 536K nodes per token" claim needs a per-pid
      // breakdown to actually attribute the cost, not just the blended avg/max.
      perProcess: sampler.summarizeByPid(),
      steps
    }

    const filePath = writeResult(result)
    console.log(`[perf] S6 result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

    expect(result.durationMs).toBeGreaterThan(0)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
