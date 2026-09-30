/**
 * Unit tests for conversation-interop/busy.
 *
 * Busyness is the engine's own `isSessionBusy` (covered by
 * services/agent/session-manager-busy.test.ts); this module must ask it rather
 * than keep a copy of the rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { isSessionBusy, v2Sessions } = vi.hoisted(() => ({
  isSessionBusy: vi.fn(),
  v2Sessions: new Map<string, unknown>(),
}))
vi.mock('../../../../src/main/services/agent', () => ({ isSessionBusy, v2Sessions }))

import { isNativeConversationBusy, hasLiveNativeSession } from '../../../../src/main/services/conversation-interop/busy'

describe('isNativeConversationBusy', () => {
  beforeEach(() => {
    isSessionBusy.mockReset()
  })

  it('answers with the engine\'s own busyness check', () => {
    isSessionBusy.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(isNativeConversationBusy('conv-1')).toBe(true)
    expect(isNativeConversationBusy('conv-2')).toBe(false)
    expect(isSessionBusy.mock.calls).toEqual([['conv-1'], ['conv-2']])
  })
})

describe('hasLiveNativeSession', () => {
  beforeEach(() => {
    v2Sessions.clear()
  })

  it('is true when the agent layer has a V2 session for this conversation, busy or idle', () => {
    v2Sessions.set('conv-1', {})
    expect(hasLiveNativeSession('conv-1')).toBe(true)
  })

  it('is false when no V2 session exists for this conversation', () => {
    expect(hasLiveNativeSession('conv-1')).toBe(false)
  })
})
