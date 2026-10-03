/**
 * Renderer declaration of visible conversations: reference-counted retains,
 * one coalesced declaration per tick on desktop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const setVisibleConversations = vi.fn()
;(globalThis as unknown as { window: unknown }).window = { halo: { setVisibleConversations } }

const { retainConversationDetail, isConversationDetailRetained } = await import(
  '../../../src/renderer/api/conversation-visibility'
)

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

beforeEach(() => {
  setVisibleConversations.mockClear()
})

describe('retainConversationDetail (desktop)', () => {
  it('declares the whole set once per tick', async () => {
    const releaseA = retainConversationDetail('a')
    const releaseB = retainConversationDetail('b')
    await tick()
    expect(setVisibleConversations).toHaveBeenCalledTimes(1)
    expect(setVisibleConversations.mock.calls[0][0].sort()).toEqual(['a', 'b'])
    releaseA()
    releaseB()
    await tick()
    expect(setVisibleConversations).toHaveBeenLastCalledWith([])
  })

  it('keeps a conversation declared until its last holder releases', async () => {
    const first = retainConversationDetail('c')
    const second = retainConversationDetail('c')
    await tick()
    setVisibleConversations.mockClear()

    first()
    first()
    await tick()
    expect(setVisibleConversations).not.toHaveBeenCalled()
    expect(isConversationDetailRetained('c')).toBe(true)

    second()
    await tick()
    expect(setVisibleConversations).toHaveBeenLastCalledWith([])
    expect(isConversationDetailRetained('c')).toBe(false)
  })
})
