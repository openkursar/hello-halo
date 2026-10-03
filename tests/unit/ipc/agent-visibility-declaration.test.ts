/**
 * Visibility declarations: one reload/destroy listener pair per renderer no
 * matter how often it reloads and re-declares; a reload clears its set.
 */

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../../src/main/services/agent', () => ({}))
vi.mock('../../../src/main/services/agent/resolved-sdk', () => ({}))
vi.mock('../../../src/main/services/agent/engine-availability', () => ({}))
vi.mock('../../../src/main/services/agent/capabilities', () => ({}))
vi.mock('../../../src/main/services/agent/codex', () => ({}))
vi.mock('../../../src/main/http/websocket', () => ({}))
vi.mock('../../../src/main/services/analytics/analytics.service', () => ({ analytics: {} }))
vi.mock('../../../src/main/apps/runtime', () => ({}))

import { applyVisibilityDeclaration } from '../../../src/main/ipc/agent'
import { getDetailConversations } from '../../../src/main/services/conversation-detail'

const tick = () => new Promise<void>((r) => queueMicrotask(r))

describe('applyVisibilityDeclaration', () => {
  it('keeps one listener pair across reloads and clears the set on each reload', async () => {
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    for (let reload = 0; reload < 20; reload++) {
      applyVisibilityDeclaration(sender, ['a', 'b'])
      await tick()
      expect([...getDetailConversations()].sort()).toEqual(['a', 'b'])
      sender.emit('did-navigate')
      await tick()
      expect(getDetailConversations().size).toBe(0)
    }
    expect(sender.listenerCount('did-navigate')).toBe(1)
    expect(sender.listenerCount('destroyed')).toBe(1)

    sender.emit('destroyed')
    // A new renderer reusing the id is followed again.
    applyVisibilityDeclaration(sender, ['c'])
    expect(sender.listenerCount('destroyed')).toBe(1)
  })
})
