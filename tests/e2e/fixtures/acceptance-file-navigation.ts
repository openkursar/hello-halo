import type { BrowserWindow } from 'electron'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from './acceptance-management'

export async function resizeFileWindow(app: ElectronApplication, page: Page, width: number, height: number) {
  const handle = await app.browserWindow(page)
  try {
    await expect.poll(() => handle.evaluate((native: BrowserWindow) => native.isVisible()), { timeout: 15000 }).toBe(true)
    await handle.evaluate(async (native: BrowserWindow, size) => {
      const transition = (event: 'leave-full-screen' | 'unmaximize', change: () => void) => new Promise<void>((resolve, reject) => {
        const remove = () => {
          if (event === 'unmaximize') native.removeListener('unmaximize', finish)
          else native.removeListener('leave-full-screen', finish)
        }
        const finish = () => { clearTimeout(timer); remove(); resolve() }
        const timer = setTimeout(() => { remove(); reject(new Error(`The owned file window did not settle ${event}`)) }, 6000)
        if (event === 'unmaximize') native.once('unmaximize', finish)
        else native.once('leave-full-screen', finish)
        try { change() } catch (error) { clearTimeout(timer); remove(); reject(error) }
      })
      if (native.isFullScreen()) await transition('leave-full-screen', () => native.setFullScreen(false))
      if (native.isMaximized()) await transition('unmaximize', () => native.unmaximize())
      native.setMinimumSize(320, 480)
      native.setContentSize(size.width, size.height)
    }, { width, height })
    await expect.poll(() => handle.evaluate((native: BrowserWindow) => native.getContentSize())).toEqual([width, height])
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height })
    return await handle.evaluate((native: BrowserWindow) => ({ contentSize: native.getContentSize(), zoomFactor: native.webContents.getZoomFactor() }))
  } finally { await handle.dispose() }
}

export async function readFileAnchor(scroller: Locator) {
  return scroller.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    for (const line of element.querySelectorAll<HTMLElement>('.cm-line')) {
      const box = line.getBoundingClientRect()
      if (box.top < bounds.top + 1 || box.bottom > bounds.bottom - 1 || !line.textContent?.trim()) continue
      const x = Math.min(box.right - 2, box.left + Math.min(40, box.width / 2))
      if (document.elementFromPoint(x, box.top + box.height / 2)?.closest('.cm-line') !== line) continue
      return { text: line.textContent, offset: box.top - bounds.top, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }
    }
    return null
  })
}

export type FileAnchor = NonNullable<Awaited<ReturnType<typeof readFileAnchor>>>

export async function settleFileAnchor(page: Page, scroller: Locator): Promise<FileAnchor> {
  let previous: FileAnchor | null = null
  let result: FileAnchor | null = null
  let steady = 0
  await expect.poll(async () => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    result = await readFileAnchor(scroller)
    steady = result && previous?.text === result.text && Math.abs(previous.offset - result.offset) <= 0.5 && Math.abs(previous.scrollTop - result.scrollTop) <= 0.5 ? steady + 1 : 0
    previous = result
    return steady
  }, { intervals: [50], timeout: 5000 }).toBeGreaterThanOrEqual(3)
  expect(result).not.toBeNull()
  return result!
}

export async function expectFileAnchor(page: Page, scroller: Locator, expected: FileAnchor) {
  await expect.poll(async () => {
    const current = await readFileAnchor(scroller)
    return !!current && current.text === expected.text && Math.abs(current.offset - expected.offset) <= 2 && Math.abs(current.scrollTop - expected.scrollTop) <= 2
  }, { timeout: 10000 }).toBe(true)
  const current = await settleFileAnchor(page, scroller)
  expect(current.text).toBe(expected.text)
  expect(Math.abs(current.offset - expected.offset)).toBeLessThanOrEqual(2)
  expect(Math.abs(current.scrollTop - expected.scrollTop)).toBeLessThanOrEqual(2)
  return current
}

export async function boundsInsideViewport(page: Page, target: Locator) {
  await expect(target).toBeVisible()
  await expect(target).toBeInViewport()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await expect.poll(async () => {
    const box = await target.boundingBox()
    return !!box && box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1
  }).toBe(true)
  return { viewport, bounds: (await target.boundingBox())! }
}
