/**
 * Regression test for the canvas/AI-Browser white-screen bug.
 *
 * `backgroundThrottling: false` on a BrowserView hosted on the main window
 * suppresses Electron's hidden-widget bookkeeping. The very next
 * removeBrowserView/addBrowserView cycle — which every canvas tab switch and
 * every "View live feed" click performs — then evicts the compositor frame
 * without ever re-embedding it: the view keeps routing input and running JS,
 * but paints nothing but its background color, permanently (confirmed via a
 * live main-process probe: requestAnimationFrame never fires again and
 * webContents.capturePage() hangs indefinitely).
 *
 * The flag is only safe — and only necessary — for views hosted on the
 * permanently-hidden offscreen automation window, which never goes through
 * that cycle and would otherwise stall Page.captureScreenshot.
 *
 * This test locks the exact `create()` behavior in place: throttling must be
 * disabled for offscreen-hosted views and left at its default for every
 * main-window view (canvas tabs, AI Browser's interactive "View live feed").
 * See tests/e2e/specs/browser-view-frame.spec.ts for the end-to-end proof
 * that a main-window view actually keeps painting across a hide/show cycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface CapturedView {
  webPreferencesOptions: Record<string, unknown>
}

const capturedViews: CapturedView[] = []

function makeFakeWebContents() {
  return {
    setUserAgent: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: { isAttached: vi.fn(() => false), attach: vi.fn(), sendCommand: vi.fn() },
    isDestroyed: vi.fn(() => false),
    id: capturedViews.length + 1
  }
}

vi.mock('electron', () => {
  class FakeBrowserView {
    webContents = makeFakeWebContents()
    setBackgroundColor = vi.fn()
    setBounds = vi.fn()
    setAutoResize = vi.fn()
    constructor(options: { webPreferences: Record<string, unknown> }) {
      capturedViews.push({ webPreferencesOptions: options.webPreferences })
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    webContents = { send: vi.fn() }
    addBrowserView = vi.fn()
    removeBrowserView = vi.fn()
    setSkipTaskbar = vi.fn()
    on = vi.fn()
    isDestroyed = vi.fn(() => false)
    constructor() {
      FakeBrowserWindow.instances.push(this)
    }
  }

  return { BrowserView: FakeBrowserView, BrowserWindow: FakeBrowserWindow }
})

vi.mock('../../../src/main/services/browser-policy.service', () => ({
  isUrlAllowedByPolicy: () => true
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({}),
  onBrowserConfigChange: () => {}
}))

import { BrowserWindow } from 'electron'
import { browserViewManager } from '../../../src/main/services/browser-view.service'

describe('browserViewManager.create — backgroundThrottling scoping', () => {
  beforeEach(() => {
    capturedViews.length = 0
    browserViewManager.initialize(new BrowserWindow() as never)
  })

  it('leaves throttling at its default for a main-window view (canvas tab / AI Browser live view)', async () => {
    await browserViewManager.create('main-window-view', 'https://example.com')

    expect(capturedViews).toHaveLength(1)
    expect(capturedViews[0].webPreferencesOptions.backgroundThrottling).toBe(true)
  })

  it('disables throttling only for a view hosted on the offscreen automation window', async () => {
    await browserViewManager.create('offscreen-view', 'https://example.com', { offscreen: true })

    expect(capturedViews).toHaveLength(1)
    expect(capturedViews[0].webPreferencesOptions.backgroundThrottling).toBe(false)
  })
})
