/**
 * Regression: canvas/AI-Browser BrowserView goes permanently blank after a
 * hide/show cycle (every canvas tab switch, every "View live feed" click).
 *
 * Root cause: `backgroundThrottling: false` on a BrowserView hosted on the
 * main window suppresses Electron's hidden-widget bookkeeping. The very next
 * removeBrowserView/addBrowserView cycle then evicts the compositor frame
 * without ever re-embedding it — the view keeps routing input and running
 * JS, but paints only its background color, forever. Fixed by scoping the
 * flag to views hosted on the permanently-hidden offscreen automation
 * window, which never goes through that cycle.
 *
 * This is invisible to DOM/element-based assertions: the accessibility tree,
 * click targets and page JS are all completely unaffected. Only the actual
 * compositor frame is gone, so the test asserts on frame production
 * (webContents.capturePage) rather than presence of any UI element.
 *
 * The bug reproduces via the OS window compositor, so it's platform/GPU
 * dependent. To avoid a false green light on an environment that can't
 * reproduce it (e.g. GPU disabled in CI), a control group establishes the
 * known-bad configuration first and the whole test is skipped — not passed
 * — if that control group doesn't actually go blank here.
 *
 * See tests/unit/services/browser-view-background-throttling.test.ts for the
 * fast, platform-independent lock on the exact source line.
 */

import { test, expect } from '../fixtures/electron'

const HIDE_SHOW_URL = 'data:text/html,<html><body style="background:red"></body></html>'

test.describe('BrowserView survives a hide/show cycle', () => {
  test('a main-window view still produces frames after removeBrowserView/addBrowserView', async ({ electronApp, window }) => {
    test.setTimeout(45000)

    // Control group: reproduce the known-bad configuration directly against a
    // throwaway view, using the exact sequence every canvas tab switch performs.
    // This is what proves the assertion below is actually meaningful here.
    const controlReproducedTheBug = await electronApp.evaluate(async ({ BrowserWindow, BrowserView }, url) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return false
      win.show()
      win.focus()
      const view = new BrowserView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          partition: 'persist:e2e-control-group',
          backgroundThrottling: false // the exact configuration being regression-tested against
        }
      })

      try {
        win.addBrowserView(view)
        view.setBounds({ x: -10000, y: -10000, width: 400, height: 300 })
        await view.webContents.loadURL(url)
        await new Promise(resolve => setTimeout(resolve, 300))

        // The same round trip CanvasLifecycle.switchTab() performs on every tab switch.
        win.removeBrowserView(view)
        await new Promise(resolve => setTimeout(resolve, 150))
        win.addBrowserView(view)
        view.setBounds({ x: 40, y: 40, width: 400, height: 300 })
        await new Promise(resolve => setTimeout(resolve, 400))

        return await Promise.race([
          view.webContents.capturePage().then(() => false), // resolved -> frame still alive, bug did not reproduce
          new Promise<boolean>(resolve => setTimeout(() => resolve(true), 3000)) // hung -> bug reproduced
        ])
      } finally {
        win.removeBrowserView(view)
      }
    }, HIDE_SHOW_URL)

    test.skip(
      !controlReproducedTheBug,
      'This environment did not reproduce the compositor-hide bug on the known-bad configuration ' +
      '(e.g. hardware acceleration disabled) — skipping rather than reporting a false pass.'
    )

    // Subject: the real production create()/show()/hide() IPC path — the exact
    // one used by canvas browser tabs and the AI Browser "View live feed" button.
    const viewId = `e2e-browserview-${Date.now()}`
    const bounds = { x: 40, y: 40, width: 400, height: 300 }

    const result = await window.evaluate(
      async ({ viewId, url, bounds }) => {
        const halo = (window as unknown as { halo: Record<string, (...args: unknown[]) => Promise<unknown>> }).halo

        await halo.createBrowserView(viewId, url)
        await halo.showBrowserView(viewId, bounds)
        await halo.hideBrowserView(viewId)
        await halo.showBrowserView(viewId, bounds)

        const captured = await Promise.race([
          halo.captureBrowserView(viewId).then((r) => {
            const res = r as { success: boolean; data?: string | null }
            return res.success && res.data ? 'ok' : 'empty'
          }),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000))
        ])

        await halo.destroyBrowserView(viewId)
        return captured
      },
      { viewId, url: HIDE_SHOW_URL, bounds }
    )

    expect(result).toBe('ok')
  })
})
