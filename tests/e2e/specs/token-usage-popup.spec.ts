/**
 * The token usage popup under an AI reply, in a real window: it opens on
 * hover, follows its count while the pointer stays on it, and closes once the
 * pointer is off the count — also when the wheel carries the count away from a
 * pointer that did not move, which used to leave it open beside the next one.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp,
} from '../fixtures/electron'
import { seedLongConversation } from '../fixtures/seed-conversation'
import { navigateToChat } from '../fixtures/helpers'

const MESSAGE_COUNT = 40

/** Let layout, observers and one follow-up frame run. */
async function settle(window: Page, ms = 250): Promise<void> {
  await window.waitForTimeout(ms)
  await window.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
}

test('token usage popup — follows its count, closes once the pointer is off it', async () => {
  test.setTimeout(120000)
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  const seeded = seedLongConversation(testConfigDir, { messageCount: MESSAGE_COUNT, title: 'Token usage popup', tokenUsage: true })
  const app = await launchElectronApp(appEntryPath, testConfigDir)

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    const cdp = await window.context().newCDPSession(window)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    const scroller = window.locator('[data-testid="transcript-scroller"]')
    await scroller.waitFor({ state: 'visible', timeout: 15000 })
    await settle(window, 1500)

    // The seed labels the n-th message's count `${600 + n}K`; its popup is
    // portaled to the body and reads "<used> / <limit>".
    const count = (index: number): Locator =>
      scroller.locator(`[data-message-id="${seeded.messageIds[index]}"]`).getByText(`${601 + index}K`, { exact: true })
    const popups = window.locator('body > div.fixed', { hasText: '/ 1000K' })
    const newest = MESSAGE_COUNT - 1
    const older = MESSAGE_COUNT - 3

    await count(newest).hover()
    await expect(popups).toHaveCount(1)
    await expect(popups).toContainText(`${601 + newest}K / 1000K`)

    // The transcript moves a little under the pointer: the popup stays and
    // keeps sitting just above its count.
    await scroller.evaluate(el => { el.scrollTop -= 4 })
    const gapAboveCount = async (): Promise<number> => {
      const anchor = await count(newest).boundingBox()
      const popup = await popups.boundingBox()
      return anchor && popup ? anchor.y - (popup.y + popup.height) : Number.NaN
    }
    await expect.poll(async () => Math.abs((await gapAboveCount()) - 8), { timeout: 2000 }).toBeLessThanOrEqual(1)
    await expect(popups).toHaveCount(1)

    // The wheel carries the count away from the still pointer: its popup
    // closes. (Another count may now be under the pointer and open its own.)
    await window.mouse.wheel(0, -240)
    await settle(window, 400)
    await expect(popups.filter({ hasText: `${601 + newest}K / 1000K` })).toHaveCount(0)

    // The next count hovered shows its popup alone.
    await count(older).hover()
    await expect(popups).toHaveCount(1)
    await expect(popups).toContainText(`${601 + older}K / 1000K`)

    await window.mouse.move(640, 60)
    await expect(popups).toHaveCount(0)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
})
