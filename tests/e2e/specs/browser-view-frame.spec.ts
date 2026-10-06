import type { HaloAPI } from '../../../src/preload'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { navigateToChat } from '../fixtures/helpers'
import { openFromHeaderMenu, clickArtifactByName } from '../../perf/lib/open-artifact'
import { getAppEntryPath, createTestConfigDir, cleanupTestConfigDir, launchElectronApp } from '../fixtures/electron'
import { seedLongConversation } from '../fixtures/seed-conversation'
import { runNativeBrowserVisibility } from '../fixtures/browser-native-visibility'
import { MAX_LIVE_BROWSER_VIEWS } from '../../../src/shared/constants/canvas-budget'
import {
  test, expect, createBrowser, showBrowser, hideBrowser, destroyBrowser,
  executeBrowser, guestIdentity, assertBrowserFrame, browserPdfFixture,
} from '../fixtures/browser-site'

test.describe('production webview carrier', () => {
  test.setTimeout(90000)

  test('keeps the guest, draft, scroll and painted surface through repeated hide/show', async ({ electronApp, window, browserSite }) => {
    const viewId = 'carrier-retention'
    const url = browserSite.pageUrl(viewId)
    await createBrowser(window, viewId, url)
    await showBrowser(window, viewId)
    const id = await guestIdentity(electronApp, url)
    const original = await executeBrowser(window, viewId, `document.querySelector('#draft').value = 'unsaved draft'; scrollTo(0, 350); ({ nonce: carrierNonce, draft: document.querySelector('#draft').value, scroll: scrollY })`)

    for (let cycle = 0; cycle < 12; cycle++) {
      await hideBrowser(window, viewId)
      await showBrowser(window, viewId)
      expect(await guestIdentity(electronApp, url)).toBe(id)
      expect(await executeBrowser(window, viewId, `({ nonce: carrierNonce, draft: document.querySelector('#draft').value, scroll: scrollY })`)).toEqual(original)
      if (cycle % 3 === 0) await assertBrowserFrame(electronApp, window, viewId)
    }
    expect(await window.evaluate(id => Array.from(document.querySelectorAll('webview')).some(element => {
      const guest = element as HTMLElement & { getWebContentsId: () => number }
      return guest.isConnected && guest.getWebContentsId() === id
    }), id)).toBe(true)
    await destroyBrowser(window, viewId)
    expect(await electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(false)
  })

  test('switches pages without reparenting or recreating either guest', async ({ electronApp, window, browserSite }) => {
    const pages = ['carrier-switch-a', 'carrier-switch-b'].map(viewId => ({ viewId, url: browserSite.pageUrl(viewId) }))
    const identities: number[] = []
    const nonces: unknown[] = []
    for (const page of pages) {
      await createBrowser(window, page.viewId, page.url)
      identities.push(await guestIdentity(electronApp, page.url))
      nonces.push(await executeBrowser(window, page.viewId, 'carrierNonce'))
    }
    for (let cycle = 0; cycle < 8; cycle++) {
      const index = cycle % 2
      await showBrowser(window, pages[index].viewId)
      await assertBrowserFrame(electronApp, window, pages[index].viewId)
      for (let i = 0; i < pages.length; i++) {
        expect(await guestIdentity(electronApp, pages[i].url)).toBe(identities[i])
        expect(await executeBrowser(window, pages[i].viewId, 'carrierNonce')).toBe(nonces[i])
      }
    }
    for (const page of pages) await destroyBrowser(window, page.viewId)
  })

  test('an immediate capture waits for presentation to produce a real frame', async ({ electronApp, window, browserSite }) => {
    const viewId = 'carrier-immediate-capture'
    await createBrowser(window, viewId, browserSite.pageUrl(viewId))
    const shown = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.showBrowserView(viewId, { x: 240, y: 100, width: 640, height: 480 }), viewId)
    expect(shown).toMatchObject({ success: true })
    await assertBrowserFrame(electronApp, window, viewId)
    await destroyBrowser(window, viewId)
  })

  test('a fresh page does not expose the internal attachment document in navigation history', async ({ window, browserSite }) => {
    const viewId = 'carrier-history'
    await createBrowser(window, viewId, browserSite.pageUrl(viewId))
    const state = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.getBrowserState(viewId), viewId)
    expect(state).toMatchObject({ success: true, data: { canGoBack: false } })
    await destroyBrowser(window, viewId)
  })

  test('a guest renderer crash can be reloaded without losing its canvas page identity', async ({ electronApp, window, browserSite }) => {
    const viewId = 'carrier-crash'
    const url = browserSite.pageUrl(viewId)
    await createBrowser(window, viewId, url)
    await showBrowser(window, viewId)
    const id = await guestIdentity(electronApp, url)
    const nonce = await executeBrowser(window, viewId, 'carrierNonce')
    await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.forcefullyCrashRenderer(), id)
    await expect.poll(() => window.evaluate(async viewId => (await (window as unknown as { halo: HaloAPI }).halo.getBrowserState(viewId)).data, viewId)).toMatchObject({ error: expect.stringMatching(/stopped/) })
    const reloaded = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.browserReload(viewId), viewId)
    expect(reloaded).toMatchObject({ success: true })
    await expect.poll(async () => { const replacement = await executeBrowser(window, viewId, 'carrierNonce'); return typeof replacement === 'string' && replacement !== nonce }).toBe(true)
    expect(await guestIdentity(electronApp, url)).toBe(id)
    await showBrowser(window, viewId)
    await assertBrowserFrame(electronApp, window, viewId)
    await destroyBrowser(window, viewId)
  })

  test('keeps timers, accessibility and fresh screenshots alive while parked, minimized and hidden', async ({ browserSite }, testInfo) => {
    const result = await runNativeBrowserVisibility(browserSite.pageUrl('carrier-native-visibility'))
    const { diagnostics, ...evidence } = result
    await testInfo.attach('native-window-visibility', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' })
    if (!result.ok) await testInfo.attach('native-window-diagnostics', { body: Buffer.from(diagnostics), contentType: 'text/plain' })
    expect(result.ok, JSON.stringify(evidence)).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.runtime.electron.split('.')[0]).toBe('43')
    expect(result.identity?.guestType).toBe('webview')
    expect(result.captureBaseline).toEqual({ host: false, guest: false })
    expect(result.states.map(state => state.state)).toEqual(['parked', 'minimized', 'hidden'])
    expect(result.states.every(state => state.ok && state.nativePNG!.currentPixels >= 10000)).toBe(true)
    expect(result.cleanup?.guestReleased).toBe(true)
    expect(result.cleanup?.viewState).toBeNull()
  })

  test('the real header popover paints above the guest and receives clicks without leaking them', async ({ electronApp, window, browserSite }, testInfo) => {
    await navigateToChat(window)
    const trigger = window.getByTitle('More', { exact: true }).first()
    await trigger.click()
    const action = window.getByRole('button', { name: /Open browser Built-in AI browser window/ })
    await expect(action).toBeVisible()
    const box = await action.boundingBox()
    expect(box).not.toBeNull()
    await window.keyboard.press('Escape')
    const viewId = 'carrier-overlay'
    await createBrowser(window, viewId, browserSite.pageUrl(viewId))
    await showBrowser(window, viewId, { x: Math.floor(box!.x), y: Math.floor(box!.y), width: 500, height: 400 })
    await assertBrowserFrame(electronApp, window, viewId)
    await trigger.click()
    await expect(action).toBeVisible()
    const screenshot = await window.screenshot()
    await testInfo.attach('popover-over-webview', { body: screenshot, contentType: 'image/png' })
    const point = { x: Math.floor(box!.x + 8), y: Math.floor(box!.y + 8) }
    const visiblePixel = await electronApp.evaluate(({ nativeImage }, { data, point }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
      const cropped = image.crop({ ...point, width: 1, height: 1 }).toBitmap()
      return Array.from(cropped.subarray(0, 3))
    }, { data: screenshot.toString('base64'), point })
    expect(visiblePixel, 'the popover must replace the cyan webpage at its position').not.toEqual([255, 180, 0])
    await action.click()
    await expect(window.getByPlaceholder(/Enter URL or search Bing/)).toBeVisible()
    expect(await executeBrowser(window, viewId, 'pageClicks')).toBe(0)
    await destroyBrowser(window, viewId)
  })

  test('shares login storage while keeping guest privileges isolated', async ({ electronApp, window, browserSite }) => {
    await navigateToChat(window)
    expect(await window.evaluate(() => ({ require: typeof (globalThis as unknown as { require?: unknown }).require,
      process: typeof (globalThis as unknown as { process?: unknown }).process,
      bridge: typeof (window as unknown as { halo?: unknown }).halo }))).toEqual({ require: 'undefined', process: 'undefined', bridge: 'object' })
    const viewId = 'carrier-login'
    const url = browserSite.pageUrl(viewId)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.once('will-attach-webview', (_event, preferences) => {
        const state = globalThis as unknown as { carrierPreferences: Record<string, unknown> }
        state.carrierPreferences = { sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation }
      })
    })
    await createBrowser(window, viewId, url)
    const id = await guestIdentity(electronApp, url)
    const result = await window.evaluate(async url =>
      (window as unknown as { halo: HaloAPI }).halo.openLoginWindow(url), `${browserSite.origin}/login`)
    expect(result).toMatchObject({ success: true })
    await expect.poll(() => executeBrowser<string>(window, viewId, 'document.cookie')).toContain('carrier-login=shared')
    const privileges = await electronApp.evaluate(({ webContents, session }, id) => {
      const guest = webContents.fromId(id)!
      const state = globalThis as unknown as { carrierPreferences: Record<string, unknown> }
      return { sharedSession: guest.session === session.fromPartition('persist:browser'), ...state.carrierPreferences }
    }, id)
    expect(privileges).toEqual({ sharedSession: true, sandbox: true, nodeIntegration: false, contextIsolation: true })
    expect(await executeBrowser(window, viewId, '({ require: typeof require, halo: typeof window.halo })')).toEqual({ require: 'undefined', halo: 'undefined' })
    await destroyBrowser(window, viewId)
  })

  test('retains navigation, zoom, mobile emulation and native keyboard input', async ({ electronApp, window, browserSite }) => {
    const viewId = 'carrier-input'
    const firstUrl = browserSite.pageUrl(viewId)
    await createBrowser(window, viewId, firstUrl)
    await showBrowser(window, viewId)
    const id = await guestIdentity(electronApp, firstUrl)
    await executeBrowser(window, viewId, `document.querySelector('#draft').focus()`)
    await electronApp.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)!
      guest.focus()
      guest.sendInputEvent({ type: 'char', keyCode: '中' })
      guest.sendInputEvent({ type: 'char', keyCode: '文' })
    }, id)
    await expect.poll(() => executeBrowser(window, viewId, `document.querySelector('#draft').value`)).toBe('中文')
    const zoom = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.setBrowserZoom(viewId, 1.25), viewId)
    expect(zoom).toMatchObject({ success: true })
    expect(await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), id)).toBeCloseTo(1.25)
    const mode = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.setBrowserDeviceMode(viewId, 'h5'), viewId)
    expect(mode).toMatchObject({ success: true })
    await expect.poll(() => executeBrowser(window, viewId, 'navigator.userAgent')).toMatch(/iPhone/)
    expect(await executeBrowser<number>(window, viewId, 'innerWidth')).toBe(430)
    const secondUrl = browserSite.pageUrl(`${viewId}-second`)
    const navigated = await window.evaluate(async ({ viewId, url }) => (window as unknown as { halo: HaloAPI }).halo.navigateBrowserView(viewId, url), { viewId, url: secondUrl })
    expect(navigated).toMatchObject({ success: true })
    await expect.poll(() => guestIdentity(electronApp, secondUrl)).toBe(id)
    expect(await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.browserGoBack(viewId), viewId)).toMatchObject({ success: true })
    await expect.poll(() => guestIdentity(electronApp, firstUrl)).toBe(id)
    expect(await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.setBrowserDeviceMode(viewId, 'pc'), viewId)).toMatchObject({ success: true })
    await hideBrowser(window, viewId)
    await showBrowser(window, viewId)
    expect(await guestIdentity(electronApp, firstUrl)).toBe(id)
    await assertBrowserFrame(electronApp, window, viewId)
    await destroyBrowser(window, viewId)
  })

  test('cleans up guests after the main renderer reloads and accepts a fresh page', async ({ electronApp, window, browserSite }) => {
    const viewId = 'carrier-reload'
    const url = browserSite.pageUrl(viewId)
    await createBrowser(window, viewId, url)
    const id = await guestIdentity(electronApp, url)
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await expect.poll(() => electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(false)
    const state = await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.getBrowserState(viewId), viewId)
    expect(state).toMatchObject({ success: true, data: null })
    await createBrowser(window, viewId, url)
    expect(await guestIdentity(electronApp, url)).not.toBe(id)
    await showBrowser(window, viewId)
    await assertBrowserFrame(electronApp, window, viewId)
    await destroyBrowser(window, viewId)
  })

  test('a real main renderer crash releases its pages and the recovered UI can create a fresh guest', async ({ electronApp, window, browserSite }, testInfo) => {
    const viewId = 'carrier-main-crash'
    const url = browserSite.pageUrl(viewId)
    await createBrowser(window, viewId, url)
    await showBrowser(window, viewId)
    const guestId = await guestIdentity(electronApp, url)
    const mainId = await electronApp.evaluate(({ webContents }, guestId) => webContents.fromId(guestId)!.hostWebContents!.id, guestId)
    await electronApp.evaluate(({ webContents }, mainId) => webContents.fromId(mainId)!.forcefullyCrashRenderer(), mainId)
    await expect.poll(() => electronApp.evaluate(({ webContents }, guestId) => !!webContents.fromId(guestId), guestId), { timeout: 20000 }).toBe(false)
    const ready = () => electronApp.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible() && !candidate.isDestroyed())
      if (!main || main.webContents.isLoading()) return false
      return main.webContents.executeJavaScript("document.readyState === 'complete' && !!window.halo && !!document.querySelector('textarea') && !!document.querySelector('#root')")
    })
    await expect.poll(ready, { timeout: 20000 }).toBe(true)
    const result = await electronApp.evaluate(async ({ BrowserWindow }, { viewId, url, guestId }) => {
      const main = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible() && !candidate.isDestroyed())!
      const execute = (code: string) => main.webContents.executeJavaScript(code)
      const old = await execute(`window.halo.getBrowserState(${JSON.stringify(viewId)})`)
      const created = await execute(`window.halo.createBrowserView(${JSON.stringify(viewId)},${JSON.stringify(url)})`)
      const shown = await execute(`window.halo.showBrowserView(${JSON.stringify(viewId)},{x:240,y:100,width:640,height:480})`)
      const captured = await execute(`window.halo.captureBrowserView(${JSON.stringify(viewId)})`)
      const fresh = await execute(`window.halo.executeBrowserJS(${JSON.stringify(viewId)},'({url:location.href,nonce:carrierNonce})')`)
      return { mainId: main.webContents.id, oldGuestId: guestId, old, created, shown, captured, fresh }
    }, { viewId, url, guestId })
    expect(result.old).toMatchObject({ success: true, data: null })
    expect(result.created).toMatchObject({ success: true })
    expect(result.shown).toMatchObject({ success: true })
    expect(result.fresh).toMatchObject({ success: true, data: { url, nonce: expect.any(String) } })
    const freshId = await guestIdentity(electronApp, url)
    expect(freshId).toBeGreaterThan(0)
    expect(freshId).not.toBe(guestId)
    expect(result.captured).toMatchObject({ success: true, data: expect.stringMatching(/^data:image\/png;base64,/) })
    const painted = await electronApp.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromDataURL(data)
      const bitmap = image.toBitmap()
      let bluePixels = 0
      for (let offset = 0; offset < bitmap.length; offset += 4) if (bitmap[offset] > 200 && bitmap[offset + 1] > 120 && bitmap[offset + 2] < 40) bluePixels++
      return { ...image.getSize(), bluePixels }
    }, result.captured.data)
    expect(painted.bluePixels).toBeGreaterThan(10000)
    await testInfo.attach('main-renderer-crash-recovery', { body: Buffer.from(JSON.stringify({ mainIdBefore: mainId, mainIdAfter: result.mainId, oldGuestId: guestId, freshGuestId: freshId, oldState: result.old.data, fresh: result.fresh.data, pixels: painted })), contentType: 'application/json' })
    await electronApp.evaluate(async ({ BrowserWindow }, viewId) => {
      const main = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible() && !candidate.isDestroyed())!
      const result = await main.webContents.executeJavaScript(`window.halo.destroyBrowserView(${JSON.stringify(viewId)})`)
      if (!result.success) throw new Error('Could not release the recovered browser guest')
    }, viewId)
    await expect.poll(() => electronApp.evaluate(({ webContents }, freshId) => !!webContents.fromId(freshId), freshId)).toBe(false)
  })

  test('the actual live browser budget releases the oldest hidden guest and recreates it only on activation', async ({ electronApp, window, browserSite }, testInfo) => {
    await navigateToChat(window)
    const pages: Array<{ url: string; id: number; viewId: string; nonce: unknown }> = []
    for (let index = 0; index <= MAX_LIVE_BROWSER_VIEWS; index++) {
      await openFromHeaderMenu(window, 'Open browser')
      await window.keyboard.press('Escape')
      const url = browserSite.pageUrl(`live-budget-${index}`)
      const address = window.getByPlaceholder(/Enter URL or search Bing/)
      await address.fill(url)
      await address.press('Enter')
      await expect.poll(() => guestIdentity(electronApp, url)).toBeGreaterThan(0)
      const id = await guestIdentity(electronApp, url)
      const viewId = await window.evaluate(id => {
        const element = Array.from(document.querySelectorAll('webview')).find(element => (element as HTMLElement & { getWebContentsId: () => number }).getWebContentsId() === id) as HTMLElement
        return element.dataset.browserPageId!
      }, id)
      const nonce = await executeBrowser(window, viewId, 'carrierNonce')
      pages.push({ url, id, viewId, nonce })
      if (index < MAX_LIVE_BROWSER_VIEWS) expect(await electronApp.evaluate(({ webContents }, pages) => pages.every(page => !!webContents.fromId(page.id)), pages)).toBe(true)
    }
    const live = () => electronApp.evaluate(({ webContents }, origin) => webContents.getAllWebContents().filter(contents => contents.getType() === 'webview' && contents.getURL().startsWith(origin)).map(contents => contents.id).sort((a, b) => a - b), browserSite.origin)
    await expect.poll(live).toEqual(pages.slice(1).map(page => page.id).sort((a, b) => a - b))
    await expect(window.locator('.canvas-tab')).toHaveCount(MAX_LIVE_BROWSER_VIEWS + 1)
    expect(await window.evaluate(async viewId => (window as unknown as { halo: HaloAPI }).halo.getBrowserState(viewId), pages[0].viewId)).toMatchObject({ success: true, data: null })
    const newest = pages.at(-1)!
    await executeBrowser(window, newest.viewId, "document.querySelector('#draft').value = 'budget survivor draft'; true")
    await window.locator('.canvas-tab').first().click()
    await expect.poll(() => guestIdentity(electronApp, pages[0].url)).toBeGreaterThan(0)
    const recreated = await guestIdentity(electronApp, pages[0].url)
    expect(recreated).not.toBe(pages[0].id)
    const recreatedViewId = await window.evaluate(id => {
      const element = Array.from(document.querySelectorAll('webview')).find(element => (element as HTMLElement & { getWebContentsId: () => number }).getWebContentsId() === id) as HTMLElement
      return element.dataset.browserPageId!
    }, recreated)
    expect(await executeBrowser(window, recreatedViewId, 'carrierNonce')).not.toBe(pages[0].nonce)
    await assertBrowserFrame(electronApp, window, recreatedViewId)
    await expect.poll(async () => (await live()).length).toBe(MAX_LIVE_BROWSER_VIEWS)
    expect(await guestIdentity(electronApp, newest.url)).toBe(newest.id)
    expect(await executeBrowser(window, newest.viewId, "({ nonce:carrierNonce, draft:document.querySelector('#draft').value })")).toEqual({ nonce: newest.nonce, draft: 'budget survivor draft' })
    await testInfo.attach('actual-browser-budget', { body: Buffer.from(JSON.stringify({ limit: MAX_LIVE_BROWSER_VIEWS, evicted: pages[0].id, recreated, remaining: await live() })), contentType: 'application/json' })
  })

  test('the themed fullscreen chat capsule receives the real click and returns with the chat draft and guest intact', async ({ electronApp, window, browserSite }, testInfo) => {
    await navigateToChat(window)
    const draft = 'fullscreen chat draft 中文🙂'
    await window.locator('textarea').fill(draft)
    await openFromHeaderMenu(window, 'Open browser')
    await window.keyboard.press('Escape')
    const url = browserSite.pageUrl('fullscreen-capsule')
    const address = window.getByPlaceholder(/Enter URL or search Bing/)
    await address.fill(url)
    await address.press('Enter')
    await expect.poll(() => guestIdentity(electronApp, url)).toBeGreaterThan(0)
    const id = await guestIdentity(electronApp, url)
    const viewId = await window.evaluate(id => {
      const element = Array.from(document.querySelectorAll('webview')).find(element => (element as HTMLElement & { getWebContentsId: () => number }).getWebContentsId() === id) as HTMLElement
      return element.dataset.browserPageId!
    }, id)
    const nonce = await executeBrowser(window, viewId, 'carrierNonce')
    await window.getByTitle('Enter fullscreen', { exact: true }).click()
    const capsule = window.getByRole('button', { name: 'Exit fullscreen and return to chat', exact: true })
    await expect(capsule).toBeVisible()
    const theme = await capsule.evaluate(element => {
      const style = getComputedStyle(element)
      const expected = document.createElement('span')
      expected.style.cssText = 'position:fixed;visibility:hidden;color:hsl(var(--primary-foreground));background-color:hsl(var(--primary))'
      document.body.appendChild(expected)
      try { const resolved = getComputedStyle(expected); return { background: style.backgroundColor, foreground: style.color, expectedBackground: resolved.backgroundColor, expectedForeground: resolved.color } }
      finally { expected.remove() }
    })
    expect(theme.background).toBe(theme.expectedBackground)
    expect(theme.foreground).toBe(theme.expectedForeground)
    const box = await capsule.boundingBox()
    expect(box).not.toBeNull()
    expect(await window.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('button')?.getAttribute('aria-label'), { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })).toBe('Exit fullscreen and return to chat')
    await testInfo.attach('fullscreen-return-capsule', { body: await window.screenshot(), contentType: 'image/png' })
    const clicks = await executeBrowser(window, viewId, 'pageClicks')
    await capsule.click()
    await expect(capsule).toHaveCount(0)
    await expect(window.getByTitle('Enter fullscreen', { exact: true })).toBeVisible()
    await expect(window.locator('textarea')).toHaveValue(draft)
    expect(await guestIdentity(electronApp, url)).toBe(id)
    expect(await executeBrowser(window, viewId, '({nonce:carrierNonce,clicks:pageClicks})')).toEqual({ nonce, clicks })
    await assertBrowserFrame(electronApp, window, viewId)
  })

  test('real canvas tab switching, collapse, page navigation and fullscreen retain the page', async ({ electronApp, window, browserSite }, testInfo) => {
    await navigateToChat(window)
    await openFromHeaderMenu(window, 'Open browser')
    await window.keyboard.press('Escape')
    const firstUrl = browserSite.pageUrl('canvas-first')
    const address = window.getByPlaceholder(/Enter URL or search Bing/)
    await address.fill(firstUrl)
    await address.press('Enter')
    await expect.poll(() => guestIdentity(electronApp, firstUrl)).toBeGreaterThan(0)
    const id = await guestIdentity(electronApp, firstUrl)
    const viewId = await window.evaluate(id => {
      const element = Array.from(document.querySelectorAll('webview')).find(element => (element as HTMLElement & { getWebContentsId: () => number }).getWebContentsId() === id) as HTMLElement
      return element.dataset.browserPageId!
    }, id)
    const nonce = await executeBrowser(window, viewId, `document.querySelector('#draft').value = 'canvas draft'; carrierNonce`)
    await openFromHeaderMenu(window, 'Open browser')
    await window.keyboard.press('Escape')
    const secondUrl = browserSite.pageUrl('canvas-second')
    await address.fill(secondUrl)
    await address.press('Enter')
    await expect.poll(() => guestIdentity(electronApp, secondUrl)).toBeGreaterThan(0)
    for (let cycle = 0; cycle < 4; cycle++) {
      await window.locator('.canvas-tab').nth(0).click()
      await assertBrowserFrame(electronApp, window, viewId)
      await window.locator('.canvas-tab').nth(1).click()
      expect(await guestIdentity(electronApp, firstUrl)).toBe(id)
    }
    await window.locator('.canvas-tab').nth(0).click()
    await window.locator('textarea').focus()
    await window.keyboard.press('Escape')
    await expect(address).toBeHidden()
    await openFromHeaderMenu(window, 'Open browser')
    await window.keyboard.press('Escape')
    await window.locator('.canvas-tab').nth(0).click()
    await expect(address).toBeVisible()
    await window.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await window.getByRole('button', { name: 'Conversation', exact: true }).first().click()
    await expect(address).toBeVisible()
    expect(await executeBrowser(window, viewId, 'carrierNonce')).toBe(nonce)
    expect(await executeBrowser(window, viewId, `document.querySelector('#draft').value`)).toBe('canvas draft')
    await window.getByTitle('Enter fullscreen', { exact: true }).click()
    await assertBrowserFrame(electronApp, window, viewId)
    await testInfo.attach('fullscreen-webview', { body: await window.screenshot(), contentType: 'image/png' })
    await window.getByTitle('Exit fullscreen', { exact: true }).click()
    expect(await guestIdentity(electronApp, firstUrl)).toBe(id)
    await window.locator('.canvas-tab').nth(0).getByTitle('Close (⌘W / Middle-click)', { exact: true }).click()
    await expect.poll(() => electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(false)
  })

  test('display scaling aligns the guest with the real canvas surface without duplicating page zoom', async ({ electronApp, window, browserSite }, testInfo) => {
    await navigateToChat(window)
    await openFromHeaderMenu(window, 'Open browser')
    await window.keyboard.press('Escape')
    const url = browserSite.pageUrl('display-scale')
    const address = window.getByPlaceholder(/Enter URL or search Bing/)
    await address.fill(url)
    await address.press('Enter')
    await expect.poll(() => guestIdentity(electronApp, url)).toBeGreaterThan(0)
    const id = await guestIdentity(electronApp, url)
    const evidence: unknown[] = []
    try {
      for (const scale of [0.8, 1.25, 1]) {
        await electronApp.evaluate(({ BrowserWindow }, scale) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(scale), scale)
        await window.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const geometry = await window.evaluate(id => {
          const input = document.querySelector('input[placeholder^="Enter URL"]')!
          const surface = input.closest('form')!.parentElement!.parentElement!.lastElementChild!
          const guest = Array.from(document.querySelectorAll('webview')).find(element => (element as HTMLElement & { getWebContentsId: () => number }).getWebContentsId() === id)!
          return { surface: surface.getBoundingClientRect().toJSON(), guest: guest.getBoundingClientRect().toJSON(), windowWidth: innerWidth }
        }, id)
        for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(geometry.surface[key] - geometry.guest[key]), `canvas and guest ${key} at scale ${scale}`).toBeLessThan(2)
        await expect.poll(async () => {
          const width = await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('innerWidth'), id)
          return Math.abs(width - geometry.guest.width * scale)
        }, { message: `guest viewport consumes the host resize at scale ${scale}` }).toBeLessThan(3)
        const metrics = await electronApp.evaluate(async ({ webContents }, id) => {
          const guest = webContents.fromId(id)!
          return { zoom: guest.getZoomFactor(), viewport: await guest.executeJavaScript('({ width: innerWidth, height: innerHeight })') }
        }, id)
        expect(metrics.zoom).toBe(1)
        expect(Math.abs(metrics.viewport.width - geometry.guest.width * scale)).toBeLessThan(3)
        const screenshot = await window.screenshot()
        const pixel = await electronApp.evaluate(({ nativeImage }, { data, geometry }) => {
          const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
          const ratio = image.getSize().width / geometry.windowWidth
          const point = { x: Math.round((geometry.guest.x + geometry.guest.width / 2) * ratio), y: Math.round((geometry.guest.y + geometry.guest.height / 2) * ratio), width: 1, height: 1 }
          return Array.from(image.crop(point).toBitmap().subarray(0, 3))
        }, { data: screenshot.toString('base64'), geometry })
        expect(pixel).toEqual([255, 180, 0])
        evidence.push({ scale, geometry, metrics, pixel })
      }
    } finally {
      await testInfo.attach('display-scale-geometry', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    }
  })

  test('a parked page can fill and capture without taking focus from the composer', async ({ electronApp, window, browserSite }) => {
    await navigateToChat(window)
    const viewId = 'carrier-focus'
    await createBrowser(window, viewId, browserSite.pageUrl(viewId))
    const composer = window.locator('textarea')
    await composer.fill('host draft')
    await composer.focus()
    await executeBrowser(window, viewId, `document.querySelector('#draft').focus(); document.querySelector('#draft').value = 'background draft'; true`)
    await assertBrowserFrame(electronApp, window, viewId)
    expect(await window.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
    expect(await window.evaluate(() => document.hasFocus())).toBe(true)
    await window.keyboard.type(' continues')
    await expect(composer).toHaveValue('host draft continues')
    expect(await executeBrowser(window, viewId, `document.querySelector('#draft').value`)).toBe('background draft')
    await destroyBrowser(window, viewId)
  })

  test('the mobile canvas covers chat controls and the resource sheet opens a working global modal above the guest', async ({ browserSite }, testInfo) => {
    const entry = getAppEntryPath()
    const profile = createTestConfigDir(entry)
    seedLongConversation(profile, { messageCount: 120, title: 'Mobile carrier transcript', variety: 'mixed' })
    const file = path.join(profile, '.halo', 'temp', 'artifacts', 'carrier-modal.txt')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'Mobile modal fixture\n')
    const electronApp = await launchElectronApp(entry, profile)
    try {
      const window = await electronApp.firstWindow()
      await navigateToChat(window)
      await electronApp.evaluate(async ({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows()[0]
        if (main.isFullScreen()) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { main.removeListener('leave-full-screen', left); reject(new Error('Native fullscreen did not finish leaving')) }, 6000)
            const left = () => { clearTimeout(timer); resolve() }
            main.once('leave-full-screen', left)
            main.setFullScreen(false)
          })
        }
        main.unmaximize()
        main.setMinimumSize(320, 480)
        main.setContentSize(390, 844)
      })
      await expect.poll(() => window.evaluate(() => innerWidth)).toBeLessThan(640)
      const transcript = window.getByTestId('transcript-scroller')
      await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
      await transcript.hover()
      await window.mouse.wheel(0, -450)
      const scrollButton = window.getByRole('button', { name: 'Scroll to latest message', exact: true })
      await expect(scrollButton).toHaveCSS('opacity', '1')
      await window.getByRole('button', { name: 'More', exact: true }).click()
      await window.getByRole('button', { name: 'Open browser', exact: true }).click()
      const address = window.getByPlaceholder(/Enter URL or search Bing/)
      await expect(address).toBeVisible()
      const url = browserSite.pageUrl('mobile-canvas')
      await address.fill(url)
      await address.press('Enter')
      await expect.poll(() => guestIdentity(electronApp, url)).toBeGreaterThan(0)
      const id = await guestIdentity(electronApp, url)
      const viewId = await window.evaluate(id => {
        const guest = Array.from(document.querySelectorAll('webview')).find(element => (element as HTMLElement & { getWebContentsId: () => number }).getWebContentsId() === id) as HTMLElement
        return guest.dataset.browserPageId!
      }, id)
      await assertBrowserFrame(electronApp, window, viewId)
      const point = await scrollButton.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      })
      const shot = await window.screenshot()
      const pixel = await electronApp.evaluate(({ nativeImage }, { data, point, width }) => {
        const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
        const ratio = image.getSize().width / width
        return Array.from(image.crop({ x: Math.round(point.x * ratio), y: Math.round(point.y * ratio), width: 1, height: 1 }).toBitmap().subarray(0, 3))
      }, { data: shot.toString('base64'), point, width: await window.evaluate(() => innerWidth) })
      expect(pixel, 'the hidden chat scroll control must not paint over the page').toEqual([255, 180, 0])
      const scrollTop = await transcript.evaluate(element => element.scrollTop)
      const clicks = await executeBrowser<number>(window, viewId, 'pageClicks')
      await window.mouse.click(point.x, point.y)
      await expect.poll(() => executeBrowser<number>(window, viewId, 'pageClicks')).toBe(clicks + 1)
      expect(await transcript.evaluate(element => element.scrollTop)).toBe(scrollTop)
      await testInfo.attach('mobile-canvas-covers-chat', { body: shot, contentType: 'image/png' })

      await window.getByRole('button', { name: 'Open workspace resources', exact: true }).click()
      const artifact = window.getByText('carrier-modal.txt', { exact: true })
      await expect(artifact).toBeVisible()
      await artifact.click({ button: 'right' })
      await window.getByText('Delete', { exact: true }).click()
      const dialog = window.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      expect(await dialog.evaluate(element => element.parentElement?.parentElement === document.body)).toBe(true)
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
      const cancelBounds = await cancel.boundingBox()
      expect(cancelBounds).not.toBeNull()
      expect(await window.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest('[role="alertdialog"]'), { x: cancelBounds!.x + cancelBounds!.width / 2, y: cancelBounds!.y + cancelBounds!.height / 2 })).toBe(true)
      const modalClicks = await executeBrowser<number>(window, viewId, 'pageClicks')
      await testInfo.attach('mobile-global-modal-above-guest', { body: await window.screenshot(), contentType: 'image/png' })
      await cancel.click()
      await expect(dialog).toHaveCount(0)
      expect(await executeBrowser(window, viewId, 'pageClicks')).toBe(modalClicks)
      expect(fs.readFileSync(file, 'utf8')).toBe('Mobile modal fixture\n')
      await window.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(artifact).toBeHidden()
      await assertBrowserFrame(electronApp, window, viewId)
    } finally {
      await electronApp.close()
      cleanupTestConfigDir(profile)
    }
  })

  test('a local PDF opened from the file rail paints in a guest and survives switching away', async ({ electronApp, window, browserSite }, testInfo) => {
    const dataDirectory = await electronApp.evaluate(() => process.env.HALO_DATA_DIR!)
    const file = path.join(dataDirectory, 'temp', 'artifacts', 'carrier-regression.pdf')
    fs.writeFileSync(file, browserPdfFixture())
    await navigateToChat(window)
    await clickArtifactByName(window, path.basename(file))
    const url = pathToFileURL(file).href
    await expect.poll(() => guestIdentity(electronApp, url)).toBeGreaterThan(0)
    const id = await guestIdentity(electronApp, url)
    const readPdfFrame = () => electronApp.evaluate(async ({ webContents }, id) => {
      const image = await webContents.fromId(id)!.capturePage()
      const size = image.getSize()
      const bitmap = image.toBitmap()
      const white = (x: number, y: number) => { const offset = (y * size.width + x) * 4; return bitmap[offset] > 250 && bitmap[offset + 1] > 250 && bitmap[offset + 2] > 250 }
      const runs: Array<{ x: number; end: number; y: number }> = []
      let widest = 0
      for (let y = 0; y < size.height; y += 2) {
        for (let x = 0; x < size.width;) {
          if (!white(x, y)) { x++; continue }
          const start = x
          while (x < size.width && white(x, y)) x++
          if (x - start > widest) widest = x - start
          if (x - start > 100) runs.push({ x: start, end: x, y })
        }
      }
      const paper = runs.filter(run => run.end - run.x >= widest - 2)
      let darkPixels = 0
      if (paper.length) {
        const left = paper[0].x + 4
        const right = paper[0].end - 4
        const top = paper[0].y + 4
        const bottom = paper[paper.length - 1].y - 4
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          const offset = (y * size.width + x) * 4
          if (bitmap[offset] < 80 && bitmap[offset + 1] < 80 && bitmap[offset + 2] < 80) darkPixels++
        }
      }
      return { size, bytes: image.toPNG().length, paperWidth: widest, darkPixels }
    }, id)
    await expect.poll(async () => (await readPdfFrame()).darkPixels).toBeGreaterThan(200)
    const frame = await readPdfFrame()
    expect(frame.size.width).toBeGreaterThan(100)
    expect(frame.bytes).toBeGreaterThan(1000)
    expect(frame.paperWidth).toBeGreaterThan(100)
    await testInfo.attach('local-pdf-webview', { body: await window.screenshot(), contentType: 'image/png' })
    await openFromHeaderMenu(window, 'Open browser')
    await window.keyboard.press('Escape')
    const address = window.getByPlaceholder(/Enter URL or search Bing/)
    await address.fill(browserSite.pageUrl('pdf-second-tab'))
    await address.press('Enter')
    await window.locator('.canvas-tab').nth(0).click()
    expect(await guestIdentity(electronApp, url)).toBe(id)
    await window.locator('.canvas-tab').nth(0).getByTitle('Close (⌘W / Middle-click)', { exact: true }).click()
    await expect.poll(() => electronApp.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)).toBe(false)
  })

  test('rejects unsolicited and replayed guest attachments in the running application', async ({ electronApp, window, browserSite }) => {
    const viewId = 'carrier-trust'
    const url = browserSite.pageUrl(viewId)
    await createBrowser(window, viewId, url)
    const id = await guestIdentity(electronApp, url)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const state = globalThis as unknown as { carrierDenied: number }
      state.carrierDenied = 0
      BrowserWindow.getAllWindows()[0].webContents.on('will-attach-webview', event => { if (event.defaultPrevented) state.carrierDenied++ })
    })
    await window.evaluate(url => {
      const existing = document.querySelector('webview') as HTMLElement
      const sources = [url, `about:blank#halo-browser-${existing.dataset.browserPageToken}`]
      for (const src of sources) {
        const rogue = document.createElement('webview')
        rogue.setAttribute('partition', 'persist:browser')
        rogue.setAttribute('webpreferences', 'nodeIntegration=yes,sandbox=no,contextIsolation=no')
        rogue.setAttribute('src', src)
        document.body.appendChild(rogue)
      }
    }, browserSite.pageUrl('forbidden'))
    await expect.poll(() => electronApp.evaluate(() => (globalThis as unknown as { carrierDenied: number }).carrierDenied)).toBe(2)
    expect(await guestIdentity(electronApp, url)).toBe(id)
    expect(await electronApp.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(contents => contents.getURL() === url), browserSite.pageUrl('forbidden'))).toBe(false)
    await destroyBrowser(window, viewId)
  })

  test('native terminal availability and local file paths preserve platform behavior', async ({ window }, testInfo) => {
    await navigateToChat(window)
    const localFile = testInfo.outputPath('native-file.txt')
    fs.writeFileSync(localFile, 'Native file path fixture\n')
    await window.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'native-path-input'; document.body.appendChild(input) })
    await window.locator('#native-path-input').setInputFiles(localFile)
    expect(await window.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.getPathForFile((document.querySelector('#native-path-input') as HTMLInputElement).files![0]))).toBe(localFile)
    if (process.platform === 'linux') {
      const refused = await window.evaluate(async () => (window as unknown as { halo: HaloAPI }).halo.createTerminal({ spaceId: 'halo-temp' }))
      expect(refused).toMatchObject({ success: false, error: expect.stringMatching(/not available|not supported/i) })
      await window.getByTitle('More', { exact: true }).first().click()
      await expect(window.getByText('Open terminal', { exact: true })).toHaveCount(0)
      await window.keyboard.press('Escape')
      return
    }
    await openFromHeaderMenu(window, 'Open terminal')
    await window.keyboard.press('Escape')
    await expect(window.locator('.xterm')).toBeVisible()
    const terminalId = await window.evaluate(async () => {
      const result = await (window as unknown as { halo: HaloAPI }).halo.listTerminals()
      const terminals = result.data as Array<{ id: string }>
      if (!result.success || !terminals.length) throw new Error('No terminal created through the menu')
      return terminals[0].id
    })
    const sent = await window.evaluate(async sessionId => (window as unknown as { halo: HaloAPI }).halo.terminalInput({ sessionId, data: "printf 'CARRIER_TERMINAL_OK\\n'\r" }), terminalId)
    expect(sent).toMatchObject({ success: true })
    await expect.poll(() => window.evaluate(async sessionId => {
      const result = await (window as unknown as { halo: HaloAPI }).halo.getTerminalReplay({ sessionId })
      return JSON.stringify(result.data)
    }, terminalId)).toContain('CARRIER_TERMINAL_OK')
    expect(await window.evaluate(async sessionId => (window as unknown as { halo: HaloAPI }).halo.killTerminal({ sessionId }), terminalId)).toMatchObject({ success: true })
  })
})
