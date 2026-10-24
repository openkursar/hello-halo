import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const workAreas = vi.hoisted(() => ({
  primary: { x: 0, y: 0, width: 1536, height: 816 },
  current: { x: 0, y: 0, width: 1536, height: 816 },
}))

vi.mock('electron', () => ({
  screen: { getDisplayMatching: vi.fn(() => ({ workArea: workAreas.current })) },
}))

import { centeredIn, drawFirstFrameMaximized, startupWindowColors, THEME_WINDOW_COLORS } from '../../../src/main/foundation/window-startup'

type Rect = { x: number; y: number; width: number; height: number }

class FakeWindow extends EventEmitter {
  destroyed = false
  constructor(public bounds: Rect) { super() }
  getBounds = () => ({ ...this.bounds })
  setBounds = vi.fn((bounds: Rect, _animate?: boolean) => { this.bounds = { ...bounds } })
  isDestroyed = () => this.destroyed
}

const DEFAULT_BOUNDS = { x: 168, y: 8, width: 1200, height: 800 }

function createWindow(platform: NodeJS.Platform = 'win32'): FakeWindow {
  const win = new FakeWindow(DEFAULT_BOUNDS)
  drawFirstFrameMaximized(win as never, platform)
  return win
}

beforeEach(() => {
  workAreas.current = workAreas.primary
})

describe('startupWindowColors', () => {
  it('follows an explicit theme regardless of the system', () => {
    expect(startupWindowColors('dark', false)).toEqual(THEME_WINDOW_COLORS.dark)
    expect(startupWindowColors('light', true)).toEqual(THEME_WINDOW_COLORS.light)
  })

  it('follows the system for "system" and when no theme is saved', () => {
    expect(startupWindowColors('system', true)).toEqual(THEME_WINDOW_COLORS.dark)
    expect(startupWindowColors('system', false)).toEqual(THEME_WINDOW_COLORS.light)
    expect(startupWindowColors(undefined, false)).toEqual(THEME_WINDOW_COLORS.light)
  })
})

describe('centeredIn', () => {
  it('centers the size in the area', () => {
    expect(centeredIn({ x: 1920, y: 0, width: 1536, height: 816 }, { width: 1200, height: 800 }))
      .toEqual({ x: 2088, y: 8, width: 1200, height: 800 })
  })

  it('shrinks a size larger than the area to fit', () => {
    expect(centeredIn({ x: 0, y: 0, width: 1000, height: 700 }, { width: 1200, height: 800 }))
      .toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })
})

describe('drawFirstFrameMaximized', () => {
  it('sizes the hidden window to the work area on Windows and macOS only', () => {
    expect(createWindow('win32').setBounds).toHaveBeenCalledWith(workAreas.primary)
    expect(createWindow('darwin').setBounds).toHaveBeenCalledWith(workAreas.primary)
    expect(createWindow('linux').setBounds).not.toHaveBeenCalled()
  })

  it('puts the default size back when macOS first restores the window to a stray frame', () => {
    const win = createWindow('darwin')
    win.bounds = { x: 0, y: 216, width: 900, height: 600 }
    win.emit('unmaximize')
    expect(win.bounds).toEqual(DEFAULT_BOUNDS)
  })

  it('restores to the default size, centered, the first time the window is restored', () => {
    const win = createWindow()
    win.emit('unmaximize')
    expect(win.bounds).toEqual(DEFAULT_BOUNDS)

    win.setBounds.mockClear()
    win.bounds = { ...workAreas.primary }
    win.emit('unmaximize')
    expect(win.setBounds).not.toHaveBeenCalled()
  })

  it('centers on the display the window was restored on', () => {
    const win = createWindow()
    workAreas.current = { x: 1536, y: 0, width: 1536, height: 816 }
    win.emit('unmaximize')
    expect(win.bounds).toEqual({ x: 1704, y: 8, width: 1200, height: 800 })
  })

  it('recognizes the full-size frame as Windows reports it back, a pixel off from the request', () => {
    const win = new FakeWindow(DEFAULT_BOUNDS)
    win.setBounds.mockImplementation((bounds: Rect) => { win.bounds = { ...bounds, width: bounds.width + 2, height: bounds.height + 1 } })
    drawFirstFrameMaximized(win as never, 'win32')
    win.emit('unmaximize')
    expect(win.bounds).toEqual({ ...DEFAULT_BOUNDS, width: 1202, height: 801 })
  })

  it('leaves a window dragged out of maximized where Windows put it', () => {
    const win = createWindow()
    win.setBounds.mockClear()
    win.bounds = { x: 0, y: 24, width: 1536, height: 816 }
    win.emit('unmaximize')
    expect(win.setBounds).not.toHaveBeenCalled()
  })

  it('does nothing once the window is gone', () => {
    const win = createWindow()
    win.setBounds.mockClear()
    win.destroyed = true
    win.emit('unmaximize')
    expect(win.setBounds).not.toHaveBeenCalled()
  })
})
