/**
 * S16 — Chat: reading a long conversation to the top and back.
 *
 * The transcript keeps at most `MAX_LIVE_ROWS` (300) rows live; rows beyond
 * are retired to placeholders of their measured height and come back as the
 * reader nears them (transcript/DESIGN.md). This scenario seeds 800 messages
 * of mixed heights and checks, in a real window:
 *
 * 1. the live-row count never exceeds the cap while paging to the top, and
 *    retirement really happened (placeholders exist) — the precondition;
 * 2. anchoring on re-live: scrolling up into retired rows brings them back
 *    without moving the row the reader is looking at (error ≤ 2 px);
 * 3. a search jump to a retired row (the newest message, retired after
 *    reading to the top) mounts it and brings it into view;
 * 4. a jump to the end that skips every sentinel (scrollTop = scrollHeight as
 *    a scrollbar drag does, then End) after paging up past the cap lands on
 *    live rows with the newest message visible — never a viewport of blank
 *    placeholders — and a reply sent in that state renders (needs the SSE
 *    mock; recorded as a warning without it). Any failed check also fails the
 *    Playwright test after its JSON result is written.
 *
 * Node count at the top is the gateable number (≈230k before the cap for
 * 2,000 messages; bounded by the cap now).
 */

import { test, expect } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp,
  hasApiKey
} from '../../e2e/fixtures/electron'
import { navigateToChat, sendMessage } from '../../e2e/fixtures/helpers'
import { waitForStreamComplete } from '../lib/wait-for-stream-complete'
import { seedLongConversation } from '../../e2e/fixtures/seed-conversation'
import { installRenderObserversNow, resetRenderObservers, readRenderMetrics } from '../lib/render-metrics'
import { CdpMetricsCollector, type CdpSnapshot } from '../lib/cdp-metrics'
import { ProcessMetricsSampler } from '../lib/process-metrics'
import { installUnresponsiveTracker, readUnresponsiveCount, readCrashCount } from '../lib/unresponsive'
import { installReloadGuard } from '../lib/reload-guard'
import { writeResult, beginScenario, currentLabel, currentThrottle } from '../lib/result-writer'
import { getBuildIdentity } from '../lib/build-identity'
import type { PerfResult } from '../types'

const SEEDED_MESSAGE_COUNT = 800
const MAX_LIVE_ROWS = 300
const MAX_ANCHOR_ERROR_PX = 2
const LIVE_ROW = '[data-transcript-index]:not([aria-hidden="true"])'
const PLACEHOLDER_ROW = '[data-transcript-index][aria-hidden="true"]'

test('S16 long history window', async () => {
  beginScenario('s16-long-history-window')
  test.setTimeout(300000)
  const warnings: string[] = []

  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const seeded = seedLongConversation(testConfigDir, { messageCount: SEEDED_MESSAGE_COUNT, title: 'S16 long history', variety: 'mixed' })
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

    const scroller = window.locator('[data-testid="transcript-scroller"]')
    await scroller.waitFor({ state: 'visible', timeout: 15000 })
    await window.waitForTimeout(1000)

    await resetRenderObservers(window)
    const heapStart = await cdp.snapshot()
    const sampler = new ProcessMetricsSampler(app)
    sampler.start()
    const t0 = Date.now()

    const liveRows = () => window.locator(LIVE_ROW).count()
    const failures: string[] = []
    let maxLive = await liveRows()

    // 1. Page to the top: jump to scrollTop 0 until the first row is mounted.
    let reachedTop = false
    for (let step = 0; step < 200 && !reachedTop; step++) {
      await scroller.evaluate((el) => { el.scrollTop = 0 })
      await window.waitForTimeout(150)
      maxLive = Math.max(maxLive, await liveRows())
      reachedTop = await window.locator(`${LIVE_ROW}[data-transcript-index="0"]`).count() > 0
    }
    const placeholdersAtTop = await window.locator(PLACEHOLDER_ROW).count()
    const nodesAtTop = (await cdp.snapshot()).nodes
    if (!reachedTop) failures.push('Never mounted the first message while paging to the top.')
    if (placeholdersAtTop === 0) failures.push('No placeholders after reading 800 messages to the top — rows were never retired, so the cap was not exercised.')

    // 2. Scroll down until rows at the top are retired, then back up in steps:
    //    each re-live above must leave the reference row where the scroll put it.
    for (let step = 0; step < 200; step++) {
      if (await window.locator(`${PLACEHOLDER_ROW}[data-transcript-index="0"]`).count() > 0) break
      await scroller.evaluate((el) => { el.scrollTop += 2000 })
      await window.waitForTimeout(120)
      maxLive = Math.max(maxLive, await liveRows())
    }
    // A re-live is the oldest live row moving up. The placeholder count is no
    // signal: re-living rows above retires as many below while at the cap.
    const readView = () => scroller.evaluate((el) => {
      const view = el.getBoundingClientRect()
      const hit = document.elementFromPoint(view.left + view.width / 2, view.top + 40)?.closest<HTMLElement>('[data-transcript-index]')
      let liveStart = Infinity
      for (const row of el.querySelectorAll<HTMLElement>('[data-transcript-index]:not([aria-hidden="true"])')) {
        liveStart = Math.min(liveStart, Number(row.dataset.transcriptIndex))
      }
      return { index: hit?.dataset.transcriptIndex ?? null, top: hit?.getBoundingClientRect().top ?? 0, liveStart }
    })
    // The reader is now ~300 live rows below the retired ones. Put the oldest
    // live row 2500 px above the viewport (just past the 1500 px preload
    // margin), so the upward steps below reach the retired rows quickly.
    await scroller.evaluate((el) => {
      let first: HTMLElement | null = null
      for (const row of el.querySelectorAll<HTMLElement>('[data-transcript-index]:not([aria-hidden="true"])')) {
        if (!first || Number(row.dataset.transcriptIndex) < Number(first.dataset.transcriptIndex)) first = row
      }
      if (first) el.scrollTop += first.getBoundingClientRect().top - el.getBoundingClientRect().top + 2500
    })
    await window.waitForTimeout(500)
    let anchorErrorMax = 0
    let reLives = 0
    const liveStartBeforeUp = (await readView()).liveStart
    for (let step = 0; step < 200 && reLives < 5; step++) {
      const before = await readView()
      if (before.index === null || before.liveStart === 0) break
      await scroller.evaluate((el) => { el.scrollTop -= 300 })
      await window.waitForTimeout(250)
      const after = await scroller.evaluate((el, index) => {
        const row = el.querySelector<HTMLElement>(`[data-transcript-index="${index}"]`)
        let liveStart = Infinity
        for (const r of el.querySelectorAll<HTMLElement>('[data-transcript-index]:not([aria-hidden="true"])')) {
          liveStart = Math.min(liveStart, Number(r.dataset.transcriptIndex))
        }
        return { top: row?.getBoundingClientRect().top ?? null, liveStart }
      }, before.index)
      maxLive = Math.max(maxLive, await liveRows())
      if (after.top === null) continue
      if (after.liveStart < before.liveStart) {
        reLives++
        anchorErrorMax = Math.max(anchorErrorMax, Math.abs(after.top - (before.top + 300)))
      }
    }
    const liveStartAfterUp = (await readView()).liveStart
    if (reLives === 0) failures.push('Scrolling up into retired rows never brought any back.')
    if (anchorErrorMax > MAX_ANCHOR_ERROR_PX) failures.push(`A re-live moved the row in view by ${anchorErrorMax.toFixed(1)} px (max ${MAX_ANCHOR_ERROR_PX}).`)

    // 3. Search-jump to the newest message, retired while reading near the top.
    const newestId = seeded.messageIds[seeded.messageIds.length - 1]
    const newestRetired = await window.locator(`[data-message-id="${newestId}"]`).count() === 0
    await window.evaluate((messageId) => {
      globalThis.dispatchEvent(new CustomEvent('search:navigate-to-message', { detail: { messageId, query: '' } }))
    }, newestId)
    const jumped = await window.waitForFunction((messageId) => {
      const el = document.querySelector(`[data-message-id="${messageId}"]`)
      const scrollerEl = document.querySelector('[data-testid="transcript-scroller"]')
      if (!el || !scrollerEl) return false
      const box = el.getBoundingClientRect()
      const view = scrollerEl.getBoundingClientRect()
      return box.bottom > view.top && box.top < view.bottom
    }, newestId, { timeout: 5000 }).then(() => true, () => false)
    if (!newestRetired) warnings.push('The newest message was still mounted before the jump, so the jump did not test a retired row.')
    if (!jumped) failures.push('A search jump to the newest message did not bring it into view within 5 s.')
    maxLive = Math.max(maxLive, await liveRows())

    // 4. Page up past the cap again, then jump straight to the end.
    for (let step = 0; step < 200; step++) {
      if (await window.locator(`${LIVE_ROW}[data-transcript-index="0"]`).count() > 0) break
      await scroller.evaluate((el) => { el.scrollTop = 0 })
      await window.waitForTimeout(150)
    }
    const newestRetiredBeforeEnd = await window.locator(`[data-message-id="${newestId}"]`).count() === 0
    if (!newestRetiredBeforeEnd) failures.push('After paging back to the top the newest message was still mounted — the end jump would not test retired rows.')
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await scroller.focus()
    await window.keyboard.press('End')
    await window.waitForTimeout(600)
    const endView = await scroller.evaluate((el, messageId) => {
      const view = el.getBoundingClientRect()
      let liveInView = 0
      for (const row of el.querySelectorAll<HTMLElement>('[data-transcript-index]:not([aria-hidden="true"])')) {
        const box = row.getBoundingClientRect()
        if (box.bottom > view.top && box.top < view.bottom) liveInView++
      }
      const newest = document.querySelector(`[data-message-id="${messageId}"]`)
      const box = newest?.getBoundingClientRect()
      const newestVisible = !!box && box.bottom > view.top && box.top < view.bottom && (newest?.textContent ?? '').includes('Seeded answer')
      return { liveInView, newestVisible, distanceToEnd: el.scrollHeight - el.scrollTop - el.clientHeight }
    }, newestId)
    maxLive = Math.max(maxLive, await liveRows())
    if (endView.liveInView === 0) failures.push(`After jumping to the end the viewport shows only placeholders (distance to end ${endView.distanceToEnd.toFixed(0)} px).`)
    if (!endView.newestVisible) failures.push('After jumping to the end the newest message text is not visible.')

    // Sending from the composer also re-attaches the window itself; check
    // the new reply, not the changing number of mounted code blocks.
    let replyRendered: boolean | null = null
    let replyDetail = 'not run'
    if (hasApiKey()) {
      const beforeReply = await scroller.evaluate((el) => {
        const rows = el.querySelectorAll<HTMLElement>('[data-transcript-index]')
        const last = rows[rows.length - 1]
        return {
          index: Number(last?.dataset.transcriptIndex ?? -1),
          messageId: last?.querySelector<HTMLElement>('.message-assistant')?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? null,
        }
      })
      await sendMessage(window, 'Reply with the module. mock-content:code150')
      await waitForStreamComplete(window, 120000)
      await window.waitForFunction(({ index, messageId }) => {
        const rows = document.querySelectorAll<HTMLElement>('[data-testid="transcript-scroller"] [data-transcript-index]')
        const last = rows[rows.length - 1]
        const reply = last?.querySelector<HTMLElement>('.message-assistant:not(.message-working)')
        const id = reply?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId
        const content = reply?.querySelector('[data-message-content]')
        const code = content?.querySelector('[data-streamdown="code-block-body"] code')
        const ending = [...(content?.querySelectorAll('p') ?? [])].find(p => p.textContent?.includes('That is all 150 lines.'))
        const box = ending?.getBoundingClientRect()
        const view = document.querySelector('[data-testid="transcript-scroller"]')?.getBoundingClientRect()
        const text = code?.textContent ?? ''
        return Number(last?.dataset.transcriptIndex ?? -1) > index && !!id && id !== messageId
          && last?.getAttribute('aria-hidden') !== 'true'
          && (code?.querySelectorAll(':scope > span').length ?? 0) >= 150
          && text.includes('step1(input: number)') && text.includes('step150(input: number)')
          && !!box && !!view && box.bottom > view.top && box.top < view.bottom
      }, beforeReply, { timeout: 10000 }).catch(() => {})
      const reply = await scroller.evaluate((el, before) => {
        const rows = el.querySelectorAll<HTMLElement>('[data-transcript-index]')
        const row = rows[rows.length - 1]
        const bubble = row?.querySelector<HTMLElement>('.message-assistant:not(.message-working)')
        const id = bubble?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId
        const newRow = Number(row?.dataset.transcriptIndex ?? -1) > before.index && !!id && id !== before.messageId
        const content = newRow ? bubble?.querySelector<HTMLElement>('[data-message-content]') : null
        const code = content?.querySelector<HTMLElement>('[data-streamdown="code-block-body"] code')
        const text = code?.textContent ?? ''
        const ending = [...(content?.querySelectorAll('p') ?? [])].find(p => p.textContent?.includes('That is all 150 lines.'))
        const box = ending?.getBoundingClientRect()
        const view = el.getBoundingClientRect()
        return {
          newRow,
          live: newRow && row?.getAttribute('aria-hidden') !== 'true',
          codeLines: code?.querySelectorAll(':scope > span').length ?? 0,
          codeComplete: text.includes('step1(input: number)') && text.includes('step150(input: number)'),
          endingVisible: !!box && box.bottom > view.top && box.top < view.bottom,
        }
      }, beforeReply)
      replyRendered = reply.newRow && reply.live && reply.codeLines >= 150 && reply.codeComplete && reply.endingVisible
      replyDetail = `newRow=${reply.newRow}, live=${reply.live}, codeLines=${reply.codeLines}, codeComplete=${reply.codeComplete}, endingVisible=${reply.endingVisible}`
      if (!replyRendered) failures.push(`A reply sent after the end jump did not render completely as a live, visible row (${replyDetail}).`)
    } else {
      warnings.push('No AI source configured: the reply-after-end-jump check was not run.')
    }
    maxLive = Math.max(maxLive, await liveRows())
    if (maxLive > MAX_LIVE_ROWS) failures.push(`${maxLive} live rows at once (cap ${MAX_LIVE_ROWS}).`)

    const durationMs = Date.now() - t0
    sampler.stop()

    const rendererReloads = reloadGuard.getReloadCount()
    const crashCount = await readCrashCount(app).catch(() => 0)
    const noReloadOrCrash = rendererReloads === 0 && crashCount === 0

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

    const status: PerfResult['status'] = failures.length ? 'precondition-failed' : 'ok'
    const result: PerfResult = {
      scenario: 's16-long-history-window',
      label: currentLabel(),
      build: getBuildIdentity(),
      throttle,
      durationMs,
      cpu,
      mem,
      sampling: sampler.getSamplingStats(),
      longtask: render.longtask,
      eventLatency: render.eventLatency,
      heap: { startMB: heapStart.heapMB, endMB: heapEnd?.heapMB ?? null, deltaMB: heapEnd ? heapEnd.heapMB - heapStart.heapMB : null },
      nodes: { start: heapStart.nodes, end: heapEnd?.nodes ?? null, delta: heapEnd ? heapEnd.nodes - heapStart.nodes : null },
      listeners: { start: heapStart.listeners, end: heapEnd?.listeners ?? null, delta: heapEnd ? heapEnd.listeners - heapStart.listeners : null },
      unresponsiveCount: await readUnresponsiveCount(app),
      rendererReloads,
      crashCount,
      valid: noReloadOrCrash && status === 'ok',
      status,
      note: [
        ...failures,
        `maxLiveRows=${maxLive}, placeholdersAtTop=${placeholdersAtTop}, nodesAtTop=${nodesAtTop}, liveStart ${liveStartBeforeUp}→${liveStartAfterUp} while scrolling up, reLives=${reLives}, anchorErrorMaxPx=${anchorErrorMax.toFixed(1)}, searchJump=${jumped}, endJumpLiveRowsInView=${endView.liveInView}, endJumpNewestVisible=${endView.newestVisible}, replyAfterEndJump=${replyRendered} (${replyDetail})`,
      ].join(' '),
      warnings: warnings.length ? warnings : undefined,
    }

    const filePath = writeResult(result)
    console.log(`[perf] S16 result written to ${filePath}`)
    expect(result.durationMs).toBeGreaterThan(0)
    expect(failures, failures.join('\n')).toEqual([])
    expect(noReloadOrCrash, `rendererReloads=${rendererReloads}, crashCount=${crashCount}`).toBe(true)
    expect(result.valid).toBe(true)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
