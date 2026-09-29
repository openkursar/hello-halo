/**
 * Transcript scrolling in a real window: a long conversation with widely
 * varying reply heights must open at its end, follow growth while the reader
 * is at the end, leave the reader alone once they scroll up, mount older
 * history without moving what is on screen, and be scrollable end to end in
 * both directions. Run at a normal window, a 4K-class fractional
 * device-pixel-ratio viewport (fractional row heights), and a phone-width one.
 */

import { test, expect, type Page, type Locator, type ElectronApplication } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp,
} from '../fixtures/electron'
import { seedLongConversation } from '../fixtures/seed-conversation'
import { seedDigitalHumanChat } from '../fixtures/seed-digital-human-chat'

const MESSAGE_COUNT = 300

const VIEWPORTS = [
  { name: 'standard', width: 1280, height: 800, deviceScaleFactor: 1 },
  { name: '4k-fractional-dpr', width: 2560, height: 1440, deviceScaleFactor: 1.5 },
  { name: 'narrow', width: 390, height: 844, deviceScaleFactor: 3 },
]

async function distanceToEnd(scroller: Locator): Promise<number> {
  return scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
}

async function mountedRows(scroller: Locator): Promise<number> {
  return scroller.evaluate(el => el.querySelectorAll('[data-transcript-index]').length)
}

/** Let layout, observers and one follow-up frame run. */
async function settle(window: Page, ms = 250): Promise<void> {
  await window.waitForTimeout(ms)
  await window.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** Grow the live area at the bottom of the transcript, as a streaming reply does. */
async function growBottom(scroller: Locator, px: number): Promise<void> {
  await scroller.evaluate((el, height) => {
    const content = el.firstElementChild as HTMLElement
    const block = document.createElement('div')
    block.dataset.testGrowth = ''
    block.style.height = `${height}px`
    content.lastElementChild!.appendChild(block)
  }, px)
}

async function removeGrowth(scroller: Locator): Promise<void> {
  await scroller.evaluate(el => el.querySelectorAll('[data-test-growth]').forEach(n => n.remove()))
}

/**
 * Deliver agent events to the renderer through the real IPC channels, as the
 * agent service does during a turn. No model is involved.
 */
async function sendAgentEvent(app: ElectronApplication, channel: string, data: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { channel, data }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    }
  }, { channel, data })
}

const STREAM_LINE = 'Streaming line with enough words to wrap and grow the live reply as it arrives. '

for (const viewport of VIEWPORTS) {
  test(`transcript scrolling — ${viewport.name}`, async () => {
    test.setTimeout(180000)
    const appEntryPath = getAppEntryPath()
    const testConfigDir = createTestConfigDir(appEntryPath)
    const seeded = seedLongConversation(testConfigDir, { messageCount: MESSAGE_COUNT, title: 'Transcript scroll', variety: 'mixed' })
    const app = await launchElectronApp(appEntryPath, testConfigDir)

    try {
      const window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      const cdp = await window.context().newCDPSession(window)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: false,
      })
      // The app opens straight into the seeded (only) conversation.
      const scroller = window.locator('[data-testid="transcript-scroller"]')
      await scroller.waitFor({ state: 'visible', timeout: 15000 })
      await settle(window, 1500)

      // Opens at the end, with only a bounded window of rows built.
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
      const initiallyMounted = await mountedRows(scroller)
      expect(initiallyMounted).toBeGreaterThan(0)
      expect(initiallyMounted).toBeLessThan(MESSAGE_COUNT)

      // Follows growth while at the end.
      await growBottom(scroller, 700)
      await settle(window)
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
      await removeGrowth(scroller)
      await settle(window)

      // A live turn streams in: the view follows every chunk to the end.
      const turn = { spaceId: 'halo-temp', conversationId: seeded.conversationId }
      await sendAgentEvent(app, 'agent:turn-start', turn)
      for (let i = 0; i < 12; i++) {
        await sendAgentEvent(app, 'agent:message', { ...turn, delta: STREAM_LINE.repeat(3) + '\n\n', isStreaming: true, isComplete: false })
        await settle(window, 60)
        expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
      }
      await expect(scroller.getByText('Streaming line', { exact: false }).first()).toBeVisible()

      // Scrolling up mid-stream detaches at once; the stream no longer moves the reader.
      await scroller.hover()
      await window.mouse.wheel(0, -300)
      await settle(window, 300)
      const midStreamTop = await scroller.evaluate(el => el.scrollTop)
      const midStreamHeight = await scroller.evaluate(el => el.scrollHeight)
      for (let i = 0; i < 6; i++) {
        await sendAgentEvent(app, 'agent:message', { ...turn, delta: STREAM_LINE.repeat(3) + '\n\n', isStreaming: true, isComplete: false })
        await settle(window, 60)
      }
      expect(await scroller.evaluate(el => el.scrollHeight)).toBeGreaterThan(midStreamHeight)
      expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - midStreamTop)).toBeLessThanOrEqual(1)

      // Back at the end, following resumes for the rest of the stream.
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight })
      await settle(window)
      for (let i = 0; i < 4; i++) {
        await sendAgentEvent(app, 'agent:message', { ...turn, delta: STREAM_LINE.repeat(3) + '\n\n', isStreaming: true, isComplete: false })
        await settle(window, 60)
        expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
      }
      await sendAgentEvent(app, 'agent:error', { ...turn, error: 'stopped by test', errorType: 'interrupted' })
      await settle(window, 400)
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)

      // Growth the reader caused (a panel they clicked expanding) stays put
      // instead of sliding away under the pointer, and ends following.
      await scroller.locator('[data-transcript-index]').last().click({ position: { x: 4, y: 4 } })
      const clickedTop = await scroller.evaluate(el => el.scrollTop)
      await growBottom(scroller, 700)
      await settle(window)
      expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - clickedTop)).toBeLessThanOrEqual(1)
      expect(await distanceToEnd(scroller)).toBeGreaterThan(100)
      await removeGrowth(scroller)
      await settle(window)

      // Scrolling up detaches: growth no longer moves the reader.
      await scroller.hover()
      await window.mouse.wheel(0, -400)
      await settle(window, 400)
      const readingTop = await scroller.evaluate(el => el.scrollTop)
      await growBottom(scroller, 700)
      await settle(window)
      expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - readingTop)).toBeLessThanOrEqual(1)
      // Its label is localized, so select the jump-to-latest button by shape.
      const jumpButton = window.locator('button:has(svg.lucide-chevron-down).rounded-full.absolute')
      await expect(jumpButton).toHaveClass(/pointer-events-auto/)

      // While reading, a row above the view changing height (an off-screen row
      // rendering at its real height) does not move what is on screen.
      const shift = await scroller.evaluate(async (el) => {
        const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        const box = el.getBoundingClientRect()
        const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-index]'))
        const visible = rows.find(r => r.getBoundingClientRect().bottom > box.top + 1)!
        const above = rows[rows.indexOf(visible) - 2]
        const before = visible.getBoundingClientRect().top
        const block = document.createElement('div')
        block.style.height = '300px'
        above.appendChild(block)
        await frame()
        const after = visible.getBoundingClientRect().top
        block.remove()
        await frame()
        return after - before
      })
      expect(Math.abs(shift)).toBeLessThanOrEqual(1)

      // The jump affordance returns to the end and re-attaches.
      await jumpButton.click()
      await settle(window)
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
      await growBottom(scroller, 300)
      await settle(window)
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
      await removeGrowth(scroller)
      await settle(window)

      // Mounting older rows above the viewport does not move what is on screen.
      const before = await mountedRows(scroller)
      const probe = await scroller.evaluate((el) => {
        el.scrollTop = Math.max(1, el.scrollTop - el.scrollHeight)
        const top = el.getBoundingClientRect().top
        const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-index]'))
        const row = rows.find(r => r.getBoundingClientRect().bottom > top + 1)!
        return { index: row.dataset.transcriptIndex!, top: row.getBoundingClientRect().top }
      })
      await settle(window, 800)
      const after = await scroller.evaluate((el, index) => {
        return el.querySelector<HTMLElement>(`[data-transcript-index="${index}"]`)!.getBoundingClientRect().top
      }, probe.index)
      expect(await mountedRows(scroller)).toBeGreaterThan(before)
      expect(Math.abs(after - probe.top)).toBeLessThanOrEqual(2)

      // The whole conversation is reachable upward with the wheel.
      // Scrolling up, content only ever moves down: older rows rendering or
      // being mounted above never push what is on screen back up.
      const visibleRowTop = () => scroller.evaluate((el) => {
        const box = el.getBoundingClientRect()
        const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-index]'))
        const row = rows.find(r => r.getBoundingClientRect().top >= box.top)
        return row ? { index: row.dataset.transcriptIndex!, top: row.getBoundingClientRect().top } : null
      })
      await scroller.hover()
      for (let i = 0; i < 1500; i++) {
        const atTop = await scroller.evaluate(el => el.scrollTop === 0 && !!el.querySelector('[data-transcript-index="0"]'))
        if (atTop) break
        const seen = await visibleRowTop()
        await window.mouse.wheel(0, -600)
        await window.waitForTimeout(60)
        if (seen) {
          const now = await scroller.evaluate((el, index) => el.querySelector<HTMLElement>(`[data-transcript-index="${index}"]`)?.getBoundingClientRect().top ?? null, seen.index)
          if (now !== null) expect(now).toBeGreaterThanOrEqual(seen.top - 2)
        }
      }
      await settle(window, 600)
      expect(await scroller.evaluate(el => el.scrollTop)).toBe(0)
      expect(await mountedRows(scroller)).toBe(MESSAGE_COUNT)
      await expect(scroller.getByText('Seeded question #1 —', { exact: false }).first()).toBeVisible()

      // And back down to the very end, where following resumes.
      for (let i = 0; i < 400; i++) {
        if ((await distanceToEnd(scroller)) <= 1) break
        await window.mouse.wheel(0, 2500)
        await window.waitForTimeout(40)
      }
      await settle(window, 600)
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
      await growBottom(scroller, 500)
      await settle(window)
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)

      // Jumping to a message that is not mounted yet mounts and centers it.
      // Reload so older history is unmounted again.
      await window.reload()
      await scroller.waitFor({ state: 'visible', timeout: 15000 })
      await settle(window, 1500)
      expect(await mountedRows(scroller)).toBeLessThan(MESSAGE_COUNT)
      const earlyId = seeded.messageIds[41]
      await window.evaluate(id => {
        globalThis.dispatchEvent(new CustomEvent('search:navigate-to-message', { detail: { messageId: id, query: '' } }))
      }, earlyId)
      await settle(window, 1200)
      const target = scroller.locator(`[data-message-id="${earlyId}"]`)
      await expect(target).toHaveCount(1)
      // Its row is centered — or top-aligned when taller than the view — and
      // holds still once the rows around it have rendered.
      const placement = async () => target.evaluate((el) => {
        const scrollerEl = el.closest('[data-testid="transcript-scroller"]') as HTMLElement
        const s = scrollerEl.getBoundingClientRect()
        const r = el.closest('[data-transcript-index]')!.getBoundingClientRect()
        return {
          tall: r.height > s.height,
          centerOffset: Math.abs((r.top + r.bottom) / 2 - (s.top + s.bottom) / 2),
          topOffset: Math.abs(r.top - s.top),
          top: r.top,
        }
      })
      const landed = await placement()
      expect(landed.tall ? landed.topOffset : landed.centerOffset).toBeLessThanOrEqual(2)
      await settle(window, 500)
      expect(Math.abs((await placement()).top - landed.top)).toBeLessThanOrEqual(1)
      await window.screenshot({ path: test.info().outputPath(`jump-${viewport.name}.png`) })
    } finally {
      await app.close()
      cleanupTestConfigDir(testConfigDir)
    }
  })
}

// A digital human's conversation is the same page, read a page at a time: it
// opens on its newest page only, follows a live turn, pulls older history in as
// the reader reaches the top without moving what is on screen, and a search hit
// far back is loaded and centered.
test('transcript scrolling — digital-human conversation, paged', async () => {
  test.setTimeout(180000)
  const TURNS = 150
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const seeded = seedDigitalHumanChat(testConfigDir, { turnCount: TURNS })
  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const cdp = await window.context().newCDPSession(window)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await window.getByText(seeded.turns[TURNS - 1].reply.slice(0, 24)).first().click()

    const scroller = window.locator('[data-testid="transcript-scroller"]')
    await scroller.waitFor({ state: 'visible', timeout: 15000 })
    await settle(window, 1200)

    // Opens at the end with only the newest page built.
    expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
    const opened = await mountedRows(scroller)
    expect(opened).toBeGreaterThan(0)
    expect(opened).toBeLessThanOrEqual(50)

    // Follows a live turn.
    const turn = { spaceId: 'halo-temp', conversationId: seeded.conversationId }
    await sendAgentEvent(app, 'agent:turn-start', turn)
    for (let i = 0; i < 6; i++) {
      await sendAgentEvent(app, 'agent:message', { ...turn, delta: STREAM_LINE.repeat(3) + '\n\n', isStreaming: true, isComplete: false })
      await settle(window, 60)
      expect(await distanceToEnd(scroller)).toBeLessThanOrEqual(1)
    }
    await sendAgentEvent(app, 'agent:error', { ...turn, error: 'stopped by test', errorType: 'interrupted' })
    await settle(window, 300)

    // Reaching the top pulls older pages in; rows on screen never move back up.
    const visibleRowTop = () => scroller.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
      const row = rows.find(r => r.getBoundingClientRect().top >= box.top)
      return row ? { id: row.dataset.messageId!, top: row.getBoundingClientRect().top } : null
    })
    await scroller.hover()
    for (let i = 0; i < 2500; i++) {
      const done = await scroller.evaluate(el => el.scrollTop === 0 && !!el.querySelector('[data-transcript-index="0"]'))
      if (done && (await scroller.getByText('Question number 1', { exact: true }).count()) > 0) break
      const seen = await visibleRowTop()
      await window.mouse.wheel(0, -700)
      await window.waitForTimeout(60)
      if (seen) {
        const now = await scroller.evaluate((el, id) => el.querySelector<HTMLElement>(`[data-message-id="${id}"]`)?.getBoundingClientRect().top ?? null, seen.id)
        if (now !== null) expect(now).toBeGreaterThanOrEqual(seen.top - 2)
      }
    }
    await settle(window, 800)
    await expect(scroller.getByText('Question number 1', { exact: true }).first()).toBeVisible()
    expect(await mountedRows(scroller)).toBe(TURNS * 2)

    // A search hit far back is loaded and centered, from a reloaded page that
    // has only the newest page again.
    await window.reload()
    await window.getByText(seeded.turns[TURNS - 1].reply.slice(0, 24)).first().click()
    await scroller.waitFor({ state: 'visible', timeout: 15000 })
    await settle(window, 1200)
    expect(await mountedRows(scroller)).toBeLessThanOrEqual(50)
    // Turn 11's question: user line of turn index 10 is line 21.
    const farId = 'session-msg-21'
    await window.evaluate(([id, appId, conversationId]) => {
      globalThis.dispatchEvent(new CustomEvent('search:navigate-to-result', {
        detail: { messageId: id, spaceId: 'halo-temp', conversationId, query: '', resultIndex: 0, kind: 'digital-human', appId },
      }))
    }, [farId, seeded.appId, seeded.conversationId])
    await settle(window, 2000)
    const target = scroller.locator(`[data-message-id="${farId}"]`)
    await expect(target).toHaveCount(1)
    const centered = await target.evaluate((el) => {
      const s = (el.closest('[data-testid="transcript-scroller"]') as HTMLElement).getBoundingClientRect()
      const r = el.closest('[data-transcript-index]')!.getBoundingClientRect()
      return Math.abs((r.top + r.bottom) / 2 - (s.top + s.bottom) / 2)
    })
    expect(centered).toBeLessThanOrEqual(40)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
