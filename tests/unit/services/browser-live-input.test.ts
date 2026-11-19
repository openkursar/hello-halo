import { describe, expect, it, vi } from 'vitest'

const keyboard = vi.hoisted(() => ({ dispatchBrowserKeyboard: vi.fn(async () => {}), dispatchBrowserText: vi.fn(async () => {}) }))
vi.mock('../../../src/main/services/browser-input', () => keyboard)

import { BrowserLiveInputState, changesPage, parseBrowserLiveInput } from '../../../src/main/services/browser-live/input'

describe('browser live input parsing', () => {
  it('accepts well-formed input and pins positions to the frame', () => {
    expect(parseBrowserLiveInput({ kind: 'mouse', action: 'down', x: 1.4, y: -2, button: 'right', clickCount: 2, modifiers: ['shift', 'bogus'] }))
      .toEqual({ kind: 'mouse', action: 'down', x: 1, y: 0, button: 'right', clickCount: 2, modifiers: ['shift'] })
    expect(parseBrowserLiveInput({ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 99 }))
      .toEqual({ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 5 })
    expect(parseBrowserLiveInput({ kind: 'text', text: '你好' })).toEqual({ kind: 'text', text: '你好' })
    expect(parseBrowserLiveInput({ kind: 'scroll-to', top: 812.6 })).toEqual({ kind: 'scroll-to', top: 813 })
    expect(parseBrowserLiveInput({ kind: 'scroll-to', top: -5 })).toEqual({ kind: 'scroll-to', top: 0 })
  })

  it('rejects anything malformed instead of guessing', () => {
    expect(parseBrowserLiveInput(null)).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'mouse', action: 'down', x: 'left', y: 0 })).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'mouse', action: 'drag', x: 0, y: 0 })).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'key', action: 'down', key: 'x'.repeat(33) })).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'text', text: '' })).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'text', text: 'x'.repeat(10_001) })).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'eval', code: '1' })).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'scroll-to', top: '0); alert(1' })).toBeNull()
    expect(parseBrowserLiveInput({ kind: 'scroll-to', top: Number.NaN })).toBeNull()
  })

  it('does not route host clipboard shortcuts through remote key input', () => {
    for (const modifiers of [['control'], ['meta']]) {
      for (const key of ['c', 'v', 'x']) {
        expect(parseBrowserLiveInput({ kind: 'key', action: 'down', key, modifiers })).toBeNull()
      }
    }
    expect(parseBrowserLiveInput({ kind: 'key', action: 'down', key: 'a', modifiers: ['meta'] })).toMatchObject({ key: 'a' })
    expect(parseBrowserLiveInput({ kind: 'text', text: 'Pasted from the client' })).not.toBeNull()
  })

  it('counts hovering as watching, not changing the page', () => {
    expect(changesPage({ kind: 'mouse', action: 'move', x: 0, y: 0 })).toBe(false)
    expect(changesPage({ kind: 'mouse', action: 'down', x: 0, y: 0 })).toBe(true)
    expect(changesPage({ kind: 'text', text: 'a' })).toBe(true)
  })
})

describe('browser live input state', () => {
  const contents = () => ({ isDestroyed: () => false, sendInputEvent: vi.fn() })

  it('releases keys still held when the viewer leaves', async () => {
    keyboard.dispatchBrowserKeyboard.mockClear()
    const page = contents()
    const state = new BrowserLiveInputState(page as never)
    await state.dispatch({ kind: 'key', action: 'down', key: 'Shift', modifiers: ['shift'] }, { width: 100, height: 100 })
    await state.dispatch({ kind: 'key', action: 'down', key: 'Enter' }, { width: 100, height: 100 })
    await state.dispatch({ kind: 'key', action: 'up', key: 'Enter' }, { width: 100, height: 100 })
    await state.release()

    expect(keyboard.dispatchBrowserKeyboard).toHaveBeenLastCalledWith(page, { type: 'keyUp', key: 'Shift', modifiers: 8 })
    expect(keyboard.dispatchBrowserKeyboard).toHaveBeenCalledTimes(4)
  })

  it('sends typed text as composed text', async () => {
    const page = contents()
    await new BrowserLiveInputState(page as never).dispatch({ kind: 'text', text: '验证码' }, { width: 100, height: 100 })
    expect(keyboard.dispatchBrowserText).toHaveBeenCalledWith(page, '验证码')
  })

  it('jumps the page to a position instantly, overriding smooth scrolling', async () => {
    const page = { ...contents(), executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined) }
    await new BrowserLiveInputState(page as never).dispatch({ kind: 'scroll-to', top: 1500 }, { width: 100, height: 100 })
    expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(expect.any(Number), [{ code: "scrollTo({ top: 1500, behavior: 'instant' })" }])
  })

  it('does nothing to a page that has closed', async () => {
    const page = { isDestroyed: () => true, sendInputEvent: vi.fn() }
    const state = new BrowserLiveInputState(page as never)
    await state.dispatch({ kind: 'mouse', action: 'down', x: 0, y: 0 }, { width: 100, height: 100 })
    await state.release()
    expect(page.sendInputEvent).not.toHaveBeenCalled()
  })
})
