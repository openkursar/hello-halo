/**
 * S3 — Chat: long-list scroll. Per perf-program.md: seed 100+ messages into a
 * conversation, then scroll it 30 times, watching whether DOM node count
 * grows unbounded (virtualization failing) or the message list's own
 * `react-virtuoso` keeps it flat.
 *
 * Seeding goes through the real `conversation.service.ts` functions (see
 * seed-conversation.ts) rather than a hand-written JSON fixture, so the file
 * on disk is exactly what the chat UI itself would have produced.
 */

import { test, expect } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp
} from '../../e2e/fixtures/electron'
import { navigateToChat } from '../../e2e/fixtures/helpers'
import { seedLongConversation } from '../../e2e/fixtures/seed-conversation'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'

const SEEDED_MESSAGE_COUNT = 120
const SCROLL_REPEATS = 30

test('S3 long-list scroll', async () => {
  beginScenario('s3-long-list-scroll')
  // Seeding + agent-session bootstrap for a 120-message conversation adds a
  // few seconds over a blank one; keep headroom above the 240s default.
  test.setTimeout(120000)
  const warnings: string[] = []

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  // Must run before launchElectronApp: conversation.service.ts's cache is
  // keyed by file path, seeding after the app has opened the file would race
  // its own in-memory cache (same ordering constraint as seedAutomationApp).
  seedLongConversation(testConfigDir, { messageCount: SEEDED_MESSAGE_COUNT, title: 'S3 long list' })

  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // navigateToChat clicks into the halo-temp space; SpacePage auto-selects
    // `conversations[0]` when one already exists (see its initSpace effect),
    // so this lands directly in the seeded conversation — no extra picking.
    await navigateToChat(window)
    await installRenderObserversNow(window)
    await installUnresponsiveTracker(app)
    const reloadGuard = installReloadGuard(window)

    const cdp = new CdpMetricsCollector(window)
    await cdp.connect()
    const throttle = currentThrottle()
    await cdp.setCpuThrottlingRate(throttle)

    // react-virtuoso's default scroll container — see MessageList.tsx. The
    // conversation-list sidebar (ConversationList) also renders its own
    // Virtuoso, so the bare test id resolves to 2 elements (Playwright
    // strict-mode violation) — scope to the one containing the seeded
    // message text to target the message list specifically.
    const scroller = window.locator('[data-testid="virtuoso-scroller"]').filter({ hasText: /Seeded (question|answer) #/ })
    await scroller.waitFor({ state: 'visible', timeout: 15000 })
    // Let Virtuoso finish its initial mount-to-bottom layout pass before the
    // baseline snapshot, so that settling isn't misattributed to scrolling.
    await window.waitForTimeout(1000)

    let preconditionFailure: string | undefined
    const seededTextVisible = await window
      .getByText(/Seeded (question|answer) #/)
      .first()
      .isVisible()
      .catch(() => false)
    if (!seededTextVisible) {
      preconditionFailure = 'No "Seeded question/answer #" text is visible after opening the conversation — the seeded messages do not look like they actually rendered.'
    }

    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()

    const sampler = new ProcessMetricsSampler(app)
    sampler.start()
    const t0 = Date.now()

    // Alternate scroll direction so the run exercises both "scroll toward
    // older messages" and "scroll back down" — Virtuoso mounts/unmounts rows
    // on both, a one-directional sweep would only ever grow the window.
    for (let i = 0; i < SCROLL_REPEATS; i++) {
      const deltaY = i % 2 === 0 ? -600 : 600
      await scroller.hover()
      await window.mouse.wheel(0, deltaY)
      await window.waitForTimeout(200)
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

    let heapEnd: CdpSnapshot | null = null
    if (noReloadOrCrash) {
      try {
        heapEnd = await cdp.snapshot()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`heap/nodes/listeners: final CDP snapshot failed (${message}) — end/delta reported as null.`)
      }
    }

    // A resolved wheel-event loop isn't proof the list actually scrolled. Virtuoso exposes no scroll-position
    // API here, so read the native scrollTop the same way MessageList's own
    // scrollToEnd() does.
    if (!preconditionFailure) {
      const scrollTop = await scroller.evaluate((el) => el.scrollTop).catch(() => null)
      if (scrollTop === null) {
        preconditionFailure = 'Could not read scroller.scrollTop after the scroll loop — the scroll container may have been unmounted.'
      } else if (scrollTop === 0) {
        preconditionFailure = 'scroller.scrollTop is 0 after 30 alternating wheel scrolls — the list does not look like it actually moved (could also mean 120 seeded messages fit within the container without needing to scroll).'
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

    const status: PerfResult['status'] = preconditionFailure ? 'precondition-failed' : 'ok'
    const valid = noReloadOrCrash && status === 'ok'
    const unresponsiveCount = await readUnresponsiveCount(app)

    const result: PerfResult = {
      scenario: 's3-long-list-scroll',
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
      note: preconditionFailure,
      warnings: warnings.length ? warnings : undefined
    }

    const filePath = writeResult(result)
    console.log(`[perf] S3 result written to ${filePath}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`)

    expect(result.durationMs).toBeGreaterThan(0)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
