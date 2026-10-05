import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runner = vi.hoisted(() => {
  let deps: unknown[] | undefined
  let cleanup: void | (() => void)
  return {
    render(effect: () => void | (() => void), nextDeps: unknown[]) {
      if (deps && nextDeps.every((value, index) => Object.is(value, deps![index]))) return
      if (typeof cleanup === 'function') cleanup()
      deps = nextDeps
      cleanup = effect()
    },
    unmount() {
      if (typeof cleanup === 'function') cleanup()
      cleanup = undefined
      deps = undefined
    },
  }
})
vi.mock('react', () => ({ useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => runner.render(effect, deps) }))

const store = vi.hoisted(() => ({
  setVisibleConversation: vi.fn(),
  readActiveCompletion: vi.fn(),
}))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: { getState: () => store } }))

import { useVisibleConversation } from '../../../src/renderer/hooks/useVisibleConversation'

let windowEvents: EventTarget
let documentEvents: EventTarget
beforeEach(() => {
  vi.clearAllMocks()
  windowEvents = new EventTarget()
  documentEvents = new EventTarget()
  vi.stubGlobal('window', windowEvents)
  vi.stubGlobal('document', documentEvents)
})
afterEach(() => {
  runner.unmount()
  vi.unstubAllGlobals()
})

describe('visible conversation lifecycle', () => {
  it('reports the mounted chat, follows selection, and clears on unmount', () => {
    useVisibleConversation('c1')
    useVisibleConversation('c1')
    expect(store.setVisibleConversation.mock.calls).toEqual([['c1']])

    useVisibleConversation('app-chat:a1')
    expect(store.setVisibleConversation.mock.calls).toEqual([['c1'], [null], ['app-chat:a1']])
    runner.unmount()
    expect(store.setVisibleConversation).toHaveBeenLastCalledWith(null)
  })

  it('checks read state on focus and visibility changes without duplicate listeners', () => {
    useVisibleConversation('c1')
    useVisibleConversation('c2')
    windowEvents.dispatchEvent(new Event('focus'))
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(store.readActiveCompletion).toHaveBeenCalledTimes(2)

    runner.unmount()
    windowEvents.dispatchEvent(new Event('focus'))
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(store.readActiveCompletion).toHaveBeenCalledTimes(2)
  })

  it('clears a chat covered by the mobile canvas and reports it when revealed', () => {
    useVisibleConversation('c1')
    useVisibleConversation(null)
    expect(store.setVisibleConversation).toHaveBeenLastCalledWith(null)
    useVisibleConversation('c1')
    expect(store.setVisibleConversation).toHaveBeenLastCalledWith('c1')
  })

  it('leaving and returning to the page restores visibility without needing a new focus event', () => {
    useVisibleConversation('c1')
    runner.unmount()
    useVisibleConversation('c1')
    expect(store.setVisibleConversation.mock.calls).toEqual([['c1'], [null], ['c1']])
  })
})
