/**
 * Closing a dropdown from outside it: a click elsewhere or Escape, never the
 * click that opened it, and nothing is left listening once it is closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  effects: [] as Array<() => void | (() => void)>,
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: (value: any) => env.runner.ref(value),
  useEffect: (effect: () => void | (() => void)) => { env.effects.push(effect) },
}))

import { useDismiss } from '../../../src/renderer/hooks/useDismiss'

class ComponentRunner {
  values: any[] = []
  index = 0
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}

const listeners = new Map<string, Set<(event: any) => void>>()
const fakeDocument = {
  addEventListener: (type: string, listener: (event: any) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(listener)
  },
  removeEventListener: (type: string, listener: (event: any) => void) => { listeners.get(type)?.delete(listener) },
}
const fire = (type: string, event: object) => [...(listeners.get(type) ?? [])].forEach(listener => listener(event))
const listening = (type: string) => listeners.get(type)?.size ?? 0

const panel = { current: {} as HTMLElement | null }
const inside = { name: 'inside' }
const outside = { name: 'outside' }
const clickOn = (...path: object[]) => ({ composedPath: () => path })

let runner: ComponentRunner

/** One draw of a component using the hook, and the cleanups of the effects it asked for. */
function mount(open: boolean, close: () => void) {
  env.effects.length = 0
  runner.render(() => useDismiss(panel as React.RefObject<HTMLElement>, open, close))
  return env.effects.splice(0).map(effect => effect())
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('document', fakeDocument)
  listeners.clear()
  panel.current = {} as HTMLElement
  runner = new ComponentRunner()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('closing from outside', () => {
  it('listens to nothing while closed', () => {
    const close = vi.fn()
    mount(false, close)
    vi.runAllTimers()
    expect(listening('click')).toBe(0)
    expect(listening('keydown')).toBe(0)
  })

  it('closes on Escape and on no other key', () => {
    const close = vi.fn()
    mount(true, close)
    fire('keydown', { key: 'Enter' })
    expect(close).not.toHaveBeenCalled()
    fire('keydown', { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes on a click outside once the click that opened it is over', () => {
    const close = vi.fn()
    mount(true, close)
    expect(listening('click')).toBe(0)
    fire('click', clickOn(outside))
    expect(close).not.toHaveBeenCalled()

    vi.runOnlyPendingTimers()
    fire('click', clickOn(outside))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('stays open for a click inside, even when that click replaced the element it landed on', () => {
    const close = vi.fn()
    mount(true, close)
    vi.runOnlyPendingTimers()
    fire('click', clickOn(inside, panel.current as object))
    expect(close).not.toHaveBeenCalled()
  })

  it('does nothing about a click before the dropdown is on screen', () => {
    const close = vi.fn()
    mount(true, close)
    vi.runOnlyPendingTimers()
    panel.current = null
    fire('click', clickOn(outside))
    expect(close).not.toHaveBeenCalled()
  })

  it('stops listening when it closes, and cancels a click listener that was not yet added', () => {
    const close = vi.fn()
    const [cleanup] = mount(true, close) as Array<() => void>
    cleanup()
    vi.runAllTimers()
    fire('click', clickOn(outside))
    fire('keydown', { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    expect(listening('click')).toBe(0)
    expect(listening('keydown')).toBe(0)
  })

  it('removes both listeners that were added', () => {
    const [cleanup] = mount(true, vi.fn()) as Array<() => void>
    vi.runOnlyPendingTimers()
    expect(listening('click')).toBe(1)
    expect(listening('keydown')).toBe(1)
    cleanup()
    expect(listening('click')).toBe(0)
    expect(listening('keydown')).toBe(0)
  })

  it('calls the close it was last given, without listening again', () => {
    const first = vi.fn()
    const second = vi.fn()
    mount(true, first)
    runner.render(() => useDismiss(panel as React.RefObject<HTMLElement>, true, second))
    fire('keydown', { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
