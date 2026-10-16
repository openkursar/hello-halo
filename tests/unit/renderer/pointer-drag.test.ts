import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PointerEvent as ReactPointerEvent } from 'react'

const lifecycle = vi.hoisted(() => {
  let cursor = 0
  const slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) }> = []
  return {
    begin() { cursor = 0 },
    ref(value: unknown) { return slots[cursor++] ??= { value } },
    effect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++
      const previous = slots[index]
      if (previous && deps && previous.deps && deps.every((value, i) => Object.is(value, previous.deps![i]))) return
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      slots[index] = { deps, cleanup: effect() }
    },
    unmount() { for (const slot of slots) if (typeof slot.cleanup === 'function') slot.cleanup(); slots.length = 0; cursor = 0 },
  }
})
vi.mock('react', () => ({
  useRef: (value: unknown) => {
    const slot = lifecycle.ref(value)
    return { get current() { return slot.value }, set current(value) { slot.value = value } }
  },
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: lifecycle.effect,
}))

import { usePointerDrag } from '../../../src/renderer/hooks/usePointerDrag'

class TrackedTarget extends EventTarget {
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type)!.add(listener)
    }
    super.addEventListener(type, listener)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    if (listener) this.listeners.get(type)?.delete(listener)
    super.removeEventListener(type, listener)
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0) }
}

function harness() {
  const view = new TrackedTarget()
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  Object.assign(view, {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })
  const shields = new Set<unknown>()
  const document = {
    defaultView: view,
    body: { appendChild: (element: unknown) => shields.add(element) },
    createElement: () => {
      const element = { dataset: {}, className: '', setAttribute: vi.fn(), remove: () => shields.delete(element) }
      return element
    },
  }
  const captures = new Set<number>()
  const target = Object.assign(new TrackedTarget(), {
    ownerDocument: document,
    setPointerCapture: vi.fn((id: number) => captures.add(id)),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: vi.fn((id: number) => {
      captures.delete(id)
      emit('lostpointercapture', { pointerId: id })
    }),
  })
  const options = { enabled: true, onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn() }
  function render(next = options) { lifecycle.begin(); return usePointerDrag(next) }
  let start = render()
  function emit(type: string, properties: Record<string, unknown> = {}) {
    target.dispatchEvent(Object.assign(new Event(type), { pointerId: 7, clientX: 250, clientY: 80, ...properties }))
  }
  return {
    target, view, shields, frames, captures, options, emit,
    render(next = options) { start = render(next) },
    start(properties = {}) {
      const event = { currentTarget: target, pointerId: 7, isPrimary: true, button: 0, clientX: 100, clientY: 50, preventDefault: vi.fn(), ...properties }
      start(event as unknown as ReactPointerEvent<HTMLElement>)
      return event
    },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) },
    assertReleased() {
      expect(shields.size).toBe(0)
      expect(frames.size).toBe(0)
      expect(captures.size).toBe(0)
      expect(target.listenerCount).toBe(0)
      expect(view.listenerCount).toBe(0)
    },
  }
}

afterEach(() => lifecycle.unmount())

describe('pointer drag lifecycle', () => {
  it('coalesces moves and saves the release coordinate even before the pending frame paints', () => {
    const drag = harness()
    expect(drag.start().preventDefault).toHaveBeenCalledOnce()
    expect(drag.shields.size).toBe(1)
    expect(drag.captures.has(7)).toBe(true)
    drag.emit('pointermove', { clientX: 180 })
    drag.emit('pointermove', { clientX: 220 })
    expect(drag.frames.size).toBe(1)
    drag.flush()
    expect(drag.options.onMove.mock.calls).toEqual([[{ clientX: 220, clientY: 80 }]])
    drag.emit('pointermove', { clientX: 280 })
    drag.emit('pointerup', { clientX: 310 })
    expect(drag.options.onEnd.mock.calls).toEqual([[{ clientX: 310, clientY: 80 }]])
    drag.assertReleased()
    drag.emit('pointermove', { clientX: 900 })
    drag.emit('pointerup')
    drag.flush()
    expect(drag.options.onMove).toHaveBeenCalledOnce()
    expect(drag.options.onEnd).toHaveBeenCalledOnce()
  })

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'disabled', 'unmount'])('%s releases every gesture resource without a late frame', reason => {
    const drag = harness()
    drag.start()
    drag.emit('pointermove', { clientX: 270, clientY: 90 })
    if (reason === 'blur') drag.view.dispatchEvent(new Event('blur'))
    else if (reason === 'disabled') drag.render({ ...drag.options, enabled: false })
    else if (reason === 'unmount') lifecycle.unmount()
    else drag.emit(reason)
    drag.assertReleased()
    drag.flush()
    drag.emit('pointerup')
    drag.view.dispatchEvent(new Event('blur'))
    expect(drag.options.onMove).not.toHaveBeenCalled()
    expect(drag.options.onEnd.mock.calls).toEqual(reason === 'unmount' ? [] : [[{ clientX: 270, clientY: 90 }]])
  })

  it.each([{ isPrimary: false }, { button: 1 }, { button: 2 }])('ignores non-primary input %j', properties => {
    const drag = harness()
    expect(drag.start(properties).preventDefault).not.toHaveBeenCalled()
    expect(drag.options.onStart).not.toHaveBeenCalled()
    drag.assertReleased()
  })

  it('ignores disabled starts, overlapping starts and other pointer IDs', () => {
    const drag = harness()
    drag.render({ ...drag.options, enabled: false })
    drag.start()
    drag.assertReleased()
    drag.render()
    drag.start()
    drag.start({ pointerId: 8 })
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) drag.emit(type, { pointerId: 8 })
    expect(drag.options.onStart).toHaveBeenCalledOnce()
    expect(drag.frames.size).toBe(0)
    expect(drag.shields.size).toBe(1)
    expect(drag.options.onEnd).not.toHaveBeenCalled()
    drag.emit('pointerup')
    drag.assertReleased()
  })

  it('uses current callbacks after rerender and can start another gesture after cleanup', () => {
    const drag = harness()
    drag.start()
    drag.emit('pointermove')
    const updated = { ...drag.options, onMove: vi.fn(), onEnd: vi.fn() }
    drag.render(updated)
    drag.flush()
    drag.emit('pointerup')
    expect(drag.options.onMove).not.toHaveBeenCalled()
    expect(drag.options.onEnd).not.toHaveBeenCalled()
    expect(updated.onMove).toHaveBeenCalledOnce()
    expect(updated.onEnd).toHaveBeenCalledOnce()
    drag.assertReleased()
    drag.start()
    drag.emit('pointerup')
    expect(updated.onEnd).toHaveBeenCalledTimes(2)
    drag.assertReleased()
  })
})
