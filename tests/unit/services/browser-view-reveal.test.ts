/**
 * Watching a page an AI drives offscreen.
 *
 * A digital-human chat's pages live on a hidden host window. "View live feed"
 * shows the EXACT page (same WebContents), so show() must move it to the main
 * window and hide() must send it home again — otherwise the AI would be left
 * with a detached view that produces no frames. Throttling has to follow the
 * move: disabled it evicts the frame on the very next remove/add round trip.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const hostOf = new Map<unknown, unknown>()
const throttling: boolean[] = []
let nextId = 1

vi.mock('electron', () => {
  class FakeBrowserView {
    webContents = {
      id: nextId++,
      setUserAgent: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: { isAttached: vi.fn(() => false), attach: vi.fn(), sendCommand: vi.fn() },
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
      getZoomFactor: () => 1,
      setBackgroundThrottling: vi.fn((allowed: boolean) => { throttling.push(allowed) }),
    }
    bounds: unknown = null
    setBackgroundColor = vi.fn()
    setBounds = vi.fn((b: unknown) => { this.bounds = b })
    setAutoResize = vi.fn()
  }

  class FakeBrowserWindow {
    webContents = { send: vi.fn(), getZoomFactor: () => 1 }
    addBrowserView = vi.fn((view: unknown) => { hostOf.set(view, this) })
    removeBrowserView = vi.fn((view: unknown) => { if (hostOf.get(view) === this) hostOf.delete(view) })
    setSkipTaskbar = vi.fn()
    on = vi.fn()
    destroy = vi.fn()
    isDestroyed = vi.fn(() => false)
  }

  return { BrowserView: FakeBrowserView, BrowserWindow: FakeBrowserWindow }
})

vi.mock('../../../src/main/services/browser-policy.service', () => ({ isUrlAllowedByPolicy: () => true }))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({}),
  onBrowserConfigChange: () => {},
}))

import { BrowserWindow } from 'electron'
import { browserViewManager } from '../../../src/main/services/browser-view.service'

const BOUNDS = { x: 10, y: 20, width: 800, height: 600 }
let mainWindow: InstanceType<typeof BrowserWindow>

async function createOffscreen(id: string) {
  await browserViewManager.create(id, 'https://example.com', { offscreen: true })
  return (browserViewManager as any).views.get(id)
}

describe('revealing an offscreen page', () => {
  beforeEach(() => {
    browserViewManager.destroyAll()
    hostOf.clear()
    throttling.length = 0
    mainWindow = new BrowserWindow() as never
    browserViewManager.initialize(mainWindow as never)
  })

  it('moves the exact view to the main window and re-enables throttling first', async () => {
    const view = await createOffscreen('ai-1')
    const offscreenHost = hostOf.get(view)
    expect(offscreenHost).not.toBe(mainWindow)

    expect(browserViewManager.show('ai-1', BOUNDS)).toBe(true)

    expect(hostOf.get(view)).toBe(mainWindow)
    expect(throttling).toEqual([true])
    expect(browserViewManager.isRevealed('ai-1')).toBe(true)
    expect(view.setBounds).toHaveBeenLastCalledWith(BOUNDS)
  })

  it('puts the view back on its hidden host when the main window refuses it', async () => {
    const view = await createOffscreen('ai-1')
    const offscreenHost = hostOf.get(view)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(mainWindow as any).addBrowserView.mockImplementationOnce(() => { throw new Error('window destroyed') })

    expect(browserViewManager.show('ai-1', BOUNDS)).toBe(false)

    expect(hostOf.get(view)).toBe(offscreenHost)
    expect(browserViewManager.isRevealed('ai-1')).toBe(false)
    expect(throttling).toEqual([true, false])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('addBrowserView failed'), expect.any(Error))
    error.mockRestore()
  })

  it('sends the view home when it is hidden, so the AI keeps a compositing surface', async () => {
    const view = await createOffscreen('ai-1')
    const offscreenHost = hostOf.get(view)
    browserViewManager.show('ai-1', BOUNDS)

    browserViewManager.hide('ai-1')

    expect(hostOf.get(view)).toBe(offscreenHost)
    expect(throttling).toEqual([true, false])
    expect(browserViewManager.isRevealed('ai-1')).toBe(false)
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })

  it('survives repeated tab-switch round trips', async () => {
    const view = await createOffscreen('ai-1')
    for (let i = 0; i < 3; i++) {
      browserViewManager.show('ai-1', BOUNDS)
      expect(hostOf.get(view)).toBe(mainWindow)
      browserViewManager.hide('ai-1')
      expect(hostOf.get(view)).not.toBe(mainWindow)
    }
    expect(throttling).toEqual([true, false, true, false, true, false])
  })

  it('returns a revealed view home when another view is shown in its place', async () => {
    const first = await createOffscreen('ai-1')
    await createOffscreen('ai-2')
    browserViewManager.show('ai-1', BOUNDS)

    browserViewManager.show('ai-2', BOUNDS)

    expect(hostOf.get(first)).not.toBe(mainWindow)
    expect(browserViewManager.isRevealed('ai-1')).toBe(false)
    expect(browserViewManager.isRevealed('ai-2')).toBe(true)
  })

  it('never re-homes an ordinary canvas view', async () => {
    await browserViewManager.create('canvas-1', 'https://example.com')
    const view = (browserViewManager as any).views.get('canvas-1')
    browserViewManager.show('canvas-1', BOUNDS)
    browserViewManager.hide('canvas-1')

    expect(hostOf.get(view)).toBeUndefined()
    expect(throttling).toEqual([])
    expect(browserViewManager.isRevealed('canvas-1')).toBe(false)
  })
})

describe('destroying a page', () => {
  beforeEach(() => {
    browserViewManager.destroyAll()
    hostOf.clear()
    mainWindow = new BrowserWindow() as never
    browserViewManager.initialize(mainWindow as never)
  })

  it('notifies subscribers whichever host the view was on, and forgets the reveal', async () => {
    const seen: string[] = []
    const off = browserViewManager.onViewDestroyed((id) => seen.push(id))
    await createOffscreen('ai-1')
    browserViewManager.show('ai-1', BOUNDS)

    browserViewManager.destroy('ai-1')

    expect(seen).toEqual(['ai-1'])
    expect(browserViewManager.isRevealed('ai-1')).toBe(false)
    expect(browserViewManager.getState('ai-1')).toBeNull()
    off()
  })

  it('does not notify for a view that never existed', () => {
    const seen: string[] = []
    const off = browserViewManager.onViewDestroyed((id) => seen.push(id))
    browserViewManager.destroy('nope')
    expect(seen).toEqual([])
    off()
  })

  it('keeps notifying the rest when one subscriber throws', async () => {
    const seen: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const offBad = browserViewManager.onViewDestroyed(() => { throw new Error('boom') })
    const offGood = browserViewManager.onViewDestroyed((id) => seen.push(id))
    await createOffscreen('ai-1')

    browserViewManager.destroy('ai-1')

    expect(seen).toEqual(['ai-1'])
    offBad()
    offGood()
    errorSpy.mockRestore()
  })
})
