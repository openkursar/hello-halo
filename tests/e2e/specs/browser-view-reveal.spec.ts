/**
 * A page an AI drives on the hidden host window can be moved to the main window
 * for the user and sent back, and keeps painting the whole way.
 *
 * Digital-human chats keep their browser pages on a hidden window created with
 * backgroundThrottling disabled (so CDP screenshots get frames). "View live
 * feed" reparents that exact view onto the main window and re-enables
 * throttling first; hiding it returns it to the hidden host and disables it
 * again. If the sequence in BrowserViewManager (revealOffscreenView /
 * returnToOffscreenWindow) is wrong, the view goes permanently blank — which no
 * DOM-level assertion can see, so this asserts on frame production
 * (webContents.capturePage) across the same round trip, using Electron's own
 * API. See tests/unit/services/browser-view-reveal.test.ts for the manager's
 * side of the contract.
 */

import { test, expect } from '../fixtures/electron'

const URL = 'data:text/html,<html><body style="background:red"></body></html>'

test.describe('Offscreen AI page reveal', () => {
  test('keeps producing frames across reveal, hide and reveal again', async ({ electronApp, window }) => {
    test.setTimeout(45000)
    // The window fixture guarantees the app's main window exists and is loaded.
    await window.waitForLoadState('domcontentloaded')

    const outcome = await electronApp.evaluate(async ({ BrowserWindow, BrowserView }, url) => {
      const main = BrowserWindow.getAllWindows()[0]
      if (!main) return { error: 'no main window' }
      main.show()
      main.focus()

      const host = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } })
      const view = new BrowserView({
        webPreferences: { sandbox: true, contextIsolation: true, partition: 'persist:e2e-reveal', backgroundThrottling: false },
      })
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const paints = async () =>
        Promise.race([
          view.webContents.capturePage().then((img) => !img.isEmpty()),
          sleep(3000).then(() => false),
        ])

      try {
        host.addBrowserView(view)
        view.setBounds({ x: 0, y: 0, width: 1280, height: 720 })
        await view.webContents.loadURL(url)
        await sleep(300)
        const homePaints = await paints()

        // reveal
        host.removeBrowserView(view)
        view.webContents.setBackgroundThrottling(true)
        main.addBrowserView(view)
        view.setBounds({ x: 40, y: 40, width: 400, height: 300 })
        await sleep(400)
        const revealedPaints = await paints()

        // hide -> home
        main.removeBrowserView(view)
        host.addBrowserView(view)
        view.setBounds({ x: 0, y: 0, width: 1280, height: 720 })
        view.webContents.setBackgroundThrottling(false)
        await sleep(400)
        const returnedPaints = await paints()

        // reveal again (a second tab switch)
        host.removeBrowserView(view)
        view.webContents.setBackgroundThrottling(true)
        main.addBrowserView(view)
        view.setBounds({ x: 40, y: 40, width: 400, height: 300 })
        await sleep(400)
        const revealedAgainPaints = await paints()

        return { homePaints, revealedPaints, returnedPaints, revealedAgainPaints }
      } finally {
        try { main.removeBrowserView(view) } catch { /* not attached */ }
        try { host.removeBrowserView(view) } catch { /* not attached */ }
        host.destroy()
      }
    }, URL)

    expect(outcome).toEqual({
      homePaints: true,
      revealedPaints: true,
      returnedPaints: true,
      revealedAgainPaints: true,
    })
  })
})
