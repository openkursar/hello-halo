/**
 * A viewer's imperative resources are released exactly once when it goes
 * away, including ones that arrive after it is gone.
 */

import { describe, it, expect, vi } from 'vitest'
import { DisposableStore } from '../../../../src/renderer/components/canvas/viewer-resources'

describe('DisposableStore', () => {
  it('releases every kind of resource once', () => {
    const store = new DisposableStore()
    const fn = vi.fn()
    const worker = { terminate: vi.fn() }
    const observer = { disconnect: vi.fn() }
    const view = { destroy: vi.fn() }
    const term = { dispose: vi.fn() }
    for (const r of [fn, worker, observer, view, term]) store.add(r)
    expect(store.size).toBe(5)

    store.dispose()
    store.dispose()
    expect([fn, worker.terminate, observer.disconnect, view.destroy, term.dispose].map(f => f.mock.calls.length))
      .toEqual([1, 1, 1, 1, 1])
    expect(store.size).toBe(0)
  })

  it('releases newest first, so a dependent goes before what it depends on', () => {
    const store = new DisposableStore()
    const order: string[] = []
    store.add(() => order.push('terminal'))
    store.add(() => order.push('subscription on terminal'))
    store.dispose()
    expect(order).toEqual(['subscription on terminal', 'terminal'])
  })

  it('releases a resource added after disposal immediately', () => {
    const store = new DisposableStore()
    store.dispose()
    const late = { terminate: vi.fn() }
    expect(store.add(late)).toBe(late)
    expect(late.terminate).toHaveBeenCalledTimes(1)
  })

  it('lets an effect release its scope early without growing the parent', () => {
    const store = new DisposableStore()
    for (let i = 0; i < 100; i++) {
      const scope = store.scope()
      scope.add(vi.fn())
      scope.dispose()
    }
    expect(store.size).toBe(0)
  })

  it('releases live scopes with the parent', () => {
    const store = new DisposableStore()
    const inner = vi.fn()
    store.scope().add(inner)
    store.dispose()
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('keeps releasing the rest when one release throws', () => {
    const store = new DisposableStore()
    const after = vi.fn()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.add(() => { throw new Error('boom') })
    store.add(after)
    store.dispose()
    expect(after).toHaveBeenCalled()
    spy.mockRestore()
  })
})
