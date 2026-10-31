import fs from 'node:fs'
import { navigateToChat } from '../fixtures/helpers'
import {
  test, expect, RECOVERY_FILES, MODAL_CONTENT, openLocalBrowser, openRecoveredBrowser,
  observeMain, observeGuest, clickGuestAction, browserGeometry, capturePaintedGuest,
} from '../fixtures/browser-recovery'

test.describe('application browser renderer recovery', () => {
  test('the application recovers its crashed renderer and opens usable browser work through the recovered UI', {
    annotation: { type: 'acceptance', description: '{"caseId":"browser.recovery.renderer","evidence":"app-e2e","mode":"none","variant":{}}' },
  }, async ({ recoveryApp, browserSite }, testInfo) => {
    const { app, window } = recoveryApp
    await navigateToChat(window)
    const original = await openLocalBrowser(window, app, RECOVERY_FILES.original, browserSite.pageUrl('renderer-original'))
    const mainId = await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.hostWebContents!.id, original.id)
    const nonce = await observeGuest<string>(app, original.id, 'carrierNonce')
    const attachment = await observeMain(app, mainId, `document.querySelector('webview[data-browser-page-id="${original.viewId}"]')?.isConnected`)
    expect(attachment).toBe(true)
    await capturePaintedGuest(app, mainId, original.id)
    await clickGuestAction(app, mainId, original.id)

    const crash = await app.evaluate(({ webContents }, mainId) => {
      const main = webContents.fromId(mainId)!
      const processId = main.mainFrame.processId
      const osProcessId = main.getOSProcessId()
      return new Promise<{ processId: number; osProcessId: number; reason: string; exitCode: number }>(resolve => {
        main.once('render-process-gone', (_event, details) => resolve({ processId, osProcessId, reason: details.reason, exitCode: details.exitCode }))
        main.forcefullyCrashRenderer()
      })
    }, mainId)
    await testInfo.attach('renderer-fault', { body: JSON.stringify(crash), contentType: 'application/json' })
    expect(['killed', 'crashed']).toContain(crash.reason)
    expect(crash.osProcessId).toBeGreaterThan(0)
    await expect.poll(() => app.evaluate(({ webContents }, id) => !!webContents.fromId(id), original.id), { timeout: 20000, message: 'The crashed main renderer must release its old guest' }).toBe(false)

    const recovered = () => app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed() && candidate.isVisible())
      if (!main || main.webContents.isLoading() || main.webContents.isCrashed()) return null
      try {
        const ready = await main.webContents.executeJavaScript("document.readyState === 'complete' && !!document.querySelector('#root nav button') && !!document.querySelector('textarea')")
        return ready ? { mainId: main.webContents.id, processId: main.webContents.mainFrame.processId, osProcessId: main.webContents.getOSProcessId() } : null
      } catch {
        return null
      }
    })
    await expect.poll(recovered, { timeout: 25000, message: 'Product recovery must restore a working main UI without test reloads or replacement windows' }).not.toBeNull()
    const current = (await recovered())!
    await testInfo.attach('recovered-renderer-process', { body: JSON.stringify(current), contentType: 'application/json' })
    expect(current.mainId).toBe(mainId)
    expect(current.osProcessId).toBeGreaterThan(0)
    expect(current.osProcessId).not.toBe(crash.osProcessId)
    const old = await observeMain(app, current.mainId, `(async () => ({
      attached: !!document.querySelector('webview[data-browser-page-id="${original.viewId}"]'),
      state: await window.halo.getBrowserState(${JSON.stringify(original.viewId)})
    }))()`)
    expect(old).toEqual({ attached: false, state: { success: true, data: null } })

    const freshUrl = browserSite.pageUrl('renderer-fresh')
    const fresh = await openRecoveredBrowser(app, current.mainId, RECOVERY_FILES.fresh, freshUrl)
    expect(fresh.id).not.toBe(original.id)
    expect(fresh.viewId).not.toBe(original.viewId)
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.hostWebContents!.id, fresh.id)).toBe(current.mainId)
    await expect.poll(() => observeGuest(app, fresh.id, 'document.readyState')).toBe('complete')
    expect(await observeGuest(app, fresh.id, '({ url: location.href, nonce: carrierNonce, clicks: pageClicks, draft: document.querySelector("#draft").value })')).toEqual({ url: freshUrl, nonce: expect.any(String), clicks: 0, draft: '' })
    expect(await observeGuest(app, fresh.id, 'carrierNonce')).not.toBe(nonce)
    await clickGuestAction(app, current.mainId, fresh.id)
    const painted = await capturePaintedGuest(app, current.mainId, fresh.id)
    const { png, ...pixels } = painted.capture
    await testInfo.attach('recovered-browser-window', { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
    await testInfo.attach('renderer-recovery', { body: JSON.stringify({ crash, recovered: current, old, originalGuestId: original.id, freshGuestId: fresh.id, geometry: painted.geometry, pixels }), contentType: 'application/json' })
  })
})

test.describe('narrow browser overlays with persistent UI scaling', () => {
  test.use({ recoveryDisplayScale: 1.25 })

  test('a 375 CSS pixel scaled browser accepts modal and fullscreen controls without forwarding clicks', {
    annotation: { type: 'acceptance', description: '{"caseId":"browser.recovery.overlay","evidence":"app-e2e","mode":"none","variant":{}}' },
  }, async ({ recoveryApp, browserSite }, testInfo) => {
    const { app, window, modalPath } = recoveryApp
    await navigateToChat(window)
    await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible())!
      if (main.isFullScreen()) {
        await new Promise<void>((resolve, reject) => {
          const left = () => { clearTimeout(timer); resolve() }
          const timer = setTimeout(() => { main.removeListener('leave-full-screen', left); reject(new Error('Native fullscreen did not finish leaving')) }, 6000)
          main.once('leave-full-screen', left)
          main.setFullScreen(false)
        })
      }
      if (main.isMaximized()) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { main.removeListener('unmaximize', restored); reject(new Error('The maximized window did not restore')) }, 6000)
          const restored = () => { clearTimeout(timer); resolve() }
          main.once('unmaximize', restored)
          main.unmaximize()
        })
      }
      main.setMinimumSize(320, 480)
      const scale = main.webContents.getZoomFactor()
      main.setContentSize(Math.round(375 * scale), Math.round(844 * scale))
    })
    await expect.poll(() => window.evaluate(() => innerWidth)).toBe(375)
    const page = await openLocalBrowser(window, app, RECOVERY_FILES.original, browserSite.pageUrl('narrow-scaled-overlay'))
    const mainId = await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.hostWebContents!.id, page.id)
    const nonce = await observeGuest(app, page.id, 'carrierNonce')
    const evidence: unknown[] = []
    const recordPaint = async (state: string, narrow = true) => {
      const painted = await capturePaintedGuest(app, mainId, page.id)
      if (narrow) expect(painted.geometry.width).toBe(375)
      else expect(painted.geometry.width).toBeGreaterThan(375)
      expect(painted.geometry.scale).toBe(1.25)
      const { png, ...pixels } = painted.capture
      evidence.push({ state, geometry: painted.geometry, pixels })
      await testInfo.attach(`scaled-browser-${state}`, { body: Buffer.from(png, 'base64'), contentType: 'image/png' })
    }
    await recordPaint('before-fullscreen')
    await clickGuestAction(app, mainId, page.id)
    const initialClicks = await observeGuest<number>(app, page.id, 'pageClicks')
    await window.getByRole('button', { name: 'Open workspace resources', exact: true }).click()
    const artifact = window.getByText(RECOVERY_FILES.modal, { exact: true })
    await expect(artifact).toBeVisible()
    await artifact.click({ button: 'right' })
    await window.getByText('Delete', { exact: true }).click()
    const dialog = window.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(element => element.parentElement?.parentElement === document.body)).toBe(true)
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const box = (await cancel.boundingBox())!
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const geometry = await browserGeometry(app, mainId, page.id)
    expect(geometry.width).toBe(375)
    expect(geometry.scale).toBe(1.25)
    expect(point.x).toBeGreaterThan(geometry.guest.x)
    expect(point.x).toBeLessThan(geometry.guest.x + geometry.guest.width)
    expect(point.y).toBeGreaterThan(geometry.guest.y)
    expect(point.y).toBeLessThan(geometry.guest.y + geometry.guest.height)
    expect(await window.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest('[role="alertdialog"]'), point)).toBe(true)
    const screenshot = await window.screenshot()
    const pixel = await app.evaluate(({ nativeImage }, { data, point, width }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
      const ratio = image.getSize().width / width
      return Array.from(image.crop({ x: Math.round(point.x * ratio), y: Math.round(point.y * ratio), width: 1, height: 1 }).toBitmap().subarray(0, 3))
    }, { data: screenshot.toString('base64'), point, width: geometry.width })
    expect(pixel, 'The global modal must paint above the cyan guest').not.toEqual([255, 180, 0])
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(initialClicks)
    await testInfo.attach('scaled-narrow-global-modal', { body: screenshot, contentType: 'image/png' })
    await window.mouse.click(point.x, point.y)
    await expect(dialog).toHaveCount(0)
    expect(fs.readFileSync(modalPath, 'utf8')).toBe(MODAL_CONTENT)
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(initialClicks)
    await window.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(artifact).toBeHidden()
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(initialClicks)
    await recordPaint('modal-dismissed')
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(initialClicks)
    await clickGuestAction(app, mainId, page.id)

    const fullscreenClicks = await observeGuest<number>(app, page.id, 'pageClicks')
    await window.getByTitle('Enter fullscreen', { exact: true }).click()
    await expect(window.getByTitle('Exit fullscreen', { exact: true })).toBeVisible()
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(fullscreenClicks)
    await recordPaint('fullscreen', false)
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(fullscreenClicks)
    await clickGuestAction(app, mainId, page.id)
    const returnClicks = await observeGuest<number>(app, page.id, 'pageClicks')
    await window.getByTitle('Exit fullscreen', { exact: true }).click()
    await expect(window.getByTitle('Enter fullscreen', { exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(() => innerWidth)).toBe(375)
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(returnClicks)
    expect(await observeGuest(app, page.id, 'carrierNonce')).toBe(nonce)
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.hostWebContents!.id, page.id)).toBe(mainId)
    await recordPaint('after-fullscreen')
    expect(await observeGuest(app, page.id, 'pageClicks')).toBe(returnClicks)
    await clickGuestAction(app, mainId, page.id)
    await testInfo.attach('scaled-narrow-overlay-journey', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  })
})
