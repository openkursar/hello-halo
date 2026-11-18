import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserLiveInputController, type PointerLike } from '../../../src/renderer/components/canvas/viewers/browser-live-input'
import type { BrowserLiveInput } from '../../../src/shared/types/browser-live'

const rect = { left: 100, top: 50, width: 400, height: 200 }
const keys = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }

function pointer(clientX: number, clientY: number, overrides: Partial<PointerLike> = {}): PointerLike {
  return { pointerType: 'mouse', button: 0, clientX, clientY, ...keys, ...overrides }
}

describe('browser live input controller', () => {
  let sent: BrowserLiveInput[]
  let clock: number
  let input: BrowserLiveInputController

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    clock = 0
    input = new BrowserLiveInputController(event => sent.push(event), () => clock)
  })

  afterEach(() => { vi.useRealTimers() })

  it('turns a mouse click into a press and release at the same fraction of the frame', () => {
    input.pointerDown(pointer(300, 100), rect)
    input.pointerUp(pointer(300, 100), rect)
    expect(sent).toEqual([
      { kind: 'mouse', action: 'down', x: 0.5, y: 0.25, button: 'left', clickCount: 1, modifiers: [] },
      { kind: 'mouse', action: 'up', x: 0.5, y: 0.25, button: 'left', clickCount: 1, modifiers: [] },
    ])
  })

  it('counts a quick second click in the same place as a double click', () => {
    input.pointerDown(pointer(300, 100), rect)
    input.pointerUp(pointer(300, 100), rect)
    clock = 200
    input.pointerDown(pointer(302, 101), rect)
    expect(sent[2]).toMatchObject({ action: 'down', clickCount: 2 })
    clock = 2000
    input.pointerUp(pointer(302, 101), rect)
    input.pointerDown(pointer(302, 101), rect)
    expect(sent[4]).toMatchObject({ action: 'down', clickCount: 1 })
  })

  it('thins out mouse moves but always delivers the last one', () => {
    input.pointerMove(pointer(100, 50), rect)
    clock = 10
    input.pointerMove(pointer(200, 50), rect)
    input.pointerMove(pointer(300, 50), rect)
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(50)
    expect(sent).toEqual([
      { kind: 'mouse', action: 'move', x: 0, y: 0, modifiers: [] },
      { kind: 'mouse', action: 'move', x: 0.5, y: 0, modifiers: [] },
    ])
  })

  it('jumps at once, then thins out a dragged scrollbar to its latest position', () => {
    input.scrollTo(1200.4)
    clock = 10
    input.scrollTo(1500)
    input.scrollTo(-30)
    expect(sent).toEqual([{ kind: 'scroll-to', top: 1200 }])
    vi.advanceTimersByTime(50)
    expect(sent).toEqual([{ kind: 'scroll-to', top: 1200 }, { kind: 'scroll-to', top: 0 }])
  })

  it('treats a finger tap as a click and a finger drag as scrolling the page along', () => {
    const touch = { pointerType: 'touch' }
    input.pointerDown(pointer(300, 150, touch), rect)
    input.pointerUp(pointer(302, 151, touch), rect)
    expect(sent.map(event => event.kind === 'mouse' && event.action)).toEqual(['move', 'down', 'up'])
    expect(sent[1]).toMatchObject({ x: 0.5, y: 0.5, button: 'left' })

    sent.length = 0
    input.pointerDown(pointer(300, 200, touch), rect)
    input.pointerMove(pointer(300, 150, touch), rect)
    input.pointerMove(pointer(300, 100, touch), rect)
    input.pointerUp(pointer(300, 100, touch), rect)
    expect(sent).toEqual([{ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 }])
  })

  it('gathers wheel ticks into one scroll measured in frames', () => {
    input.wheel({ clientX: 300, clientY: 150, deltaX: 0, deltaY: 50, deltaMode: 0 }, rect)
    input.wheel({ clientX: 300, clientY: 150, deltaX: 0, deltaY: 3, deltaMode: 1 }, rect)
    vi.advanceTimersByTime(50)
    expect(sent).toEqual([{ kind: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.49 }])
  })

  it('sends editing keys and shortcuts, and leaves characters and paste to the text box', () => {
    expect(input.keyDown({ key: 'a', ...keys })).toBe(false)
    expect(input.keyDown({ key: '中', ...keys, isComposing: true })).toBe(false)
    expect(input.keyDown({ key: 'Process', ...keys })).toBe(false)
    expect(input.keyDown({ key: 'Shift', ...keys, shiftKey: true })).toBe(false)
    expect(input.keyDown({ key: 'v', ...keys, metaKey: true })).toBe(false)
    expect(input.keyDown({ key: 'Enter', ...keys })).toBe(true)
    expect(input.keyDown({ key: 'a', ...keys, ctrlKey: true })).toBe(true)
    expect(input.keyUp({ key: 'b', ...keys })).toBe(false)
    expect(sent).toEqual([
      { kind: 'key', action: 'down', key: 'Enter', modifiers: [] },
      { kind: 'key', action: 'down', key: 'a', modifiers: ['control'] },
    ])
  })

  it('lets go of every key and button it still holds when operating stops', () => {
    input.keyDown({ key: 'ArrowDown', ...keys })
    input.pointerDown(pointer(300, 100), rect)
    input.pointerMove(pointer(500, 250), rect)
    sent.length = 0
    input.dispose()
    expect(sent).toEqual([
      { kind: 'mouse', action: 'up', x: 1, y: 1, button: 'left', clickCount: 1 },
      { kind: 'key', action: 'up', key: 'ArrowDown' },
    ])
  })

  it('caps pasted text at what the server accepts', () => {
    input.text('x'.repeat(20_000))
    expect(sent[0]).toEqual({ kind: 'text', text: 'x'.repeat(10_000) })
  })
})
