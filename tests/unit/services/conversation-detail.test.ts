/**
 * Union of conversations local viewers render in detail, with coalesced
 * change notifications.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  clearDetailConversations,
  getDetailConversations,
  onDetailConversationsChanged,
  setDetailConversations,
} from '../../../src/main/services/conversation-detail'

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('conversation detail union', () => {
  it('unions sources and notifies once per change burst', async () => {
    const listener = vi.fn()
    const off = onDetailConversationsChanged(listener)

    setDetailConversations('renderer:1', ['a', 'b'])
    setDetailConversations('ws:x', ['b', 'c'])
    await tick()
    expect([...getDetailConversations()].sort()).toEqual(['a', 'b', 'c'])
    expect(listener).toHaveBeenCalledTimes(1)

    setDetailConversations('ws:x', ['c', 'b'])
    await tick()
    expect(listener).toHaveBeenCalledTimes(1)

    clearDetailConversations('renderer:1')
    clearDetailConversations('ws:x')
    await tick()
    expect(getDetailConversations().size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })
})
