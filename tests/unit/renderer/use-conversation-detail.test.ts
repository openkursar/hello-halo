/**
 * useConversationDetail: retains on mount, releases on unmount, and moves the
 * retention when the conversation id changes — driven through a minimal effect
 * runner that applies React's dependency semantics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const runner = vi.hoisted(() => {
  let deps: unknown[] | undefined
  let cleanup: void | (() => void)
  return {
    render(effect: () => void | (() => void), nextDeps: unknown[]) {
      const changed = !deps || nextDeps.some((d, i) => !Object.is(d, deps![i]))
      if (!changed) return
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
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void), deps: unknown[]) => runner.render(effect, deps) }))

const held = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../src/renderer/api/conversation-visibility', () => ({
  retainConversationDetail: (id: string) => {
    held.set(id, (held.get(id) ?? 0) + 1)
    return () => held.set(id, held.get(id)! - 1)
  },
}))

import { useConversationDetail } from '../../../src/renderer/hooks/useConversationDetail'

beforeEach(() => {
  runner.unmount()
  held.clear()
})

describe('useConversationDetail', () => {
  it('retains on mount and releases on unmount', () => {
    useConversationDetail('a')
    expect(held.get('a')).toBe(1)
    useConversationDetail('a')
    expect(held.get('a')).toBe(1)
    runner.unmount()
    expect(held.get('a')).toBe(0)
  })

  it('moves retention when the id changes', () => {
    useConversationDetail('a')
    useConversationDetail('b')
    expect([held.get('a'), held.get('b')]).toEqual([0, 1])
  })

  it('holds nothing for a missing id', () => {
    useConversationDetail(null)
    useConversationDetail(undefined)
    expect(held.size).toBe(0)
    useConversationDetail('c')
    expect(held.get('c')).toBe(1)
  })
})
