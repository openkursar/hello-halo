/**
 * Unit tests for conversation-interop/busy.
 *
 * `isNativeConversationBusy` reconstructs `session-manager.ts`'s private
 * `isSessionBusy` from primitives that are already exported (`activeSessions`,
 * `getConsumerHandle`, `hasActiveTeamTasks`) rather than adding a new export
 * to `services/agent` — see the module doc. This test mocks those exports and
 * asserts the composition matches the private function's documented logic
 * exactly: legacy `activeSessions` wins first, then an actively-processing
 * consumer, then a team-task-holding idle consumer, else not busy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { activeSessions, getConsumerHandle, v2Sessions } = vi.hoisted(() => ({
  activeSessions: new Map<string, unknown>(),
  getConsumerHandle: vi.fn(),
  v2Sessions: new Map<string, unknown>(),
}))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({ activeSessions, getConsumerHandle, v2Sessions }))

const { hasActiveTeamTasks } = vi.hoisted(() => ({ hasActiveTeamTasks: vi.fn() }))
vi.mock('../../../../src/main/services/agent/subagent-handler', () => ({ hasActiveTeamTasks }))

import { isNativeConversationBusy, hasLiveNativeSession } from '../../../../src/main/services/conversation-interop/busy'

describe('isNativeConversationBusy', () => {
  beforeEach(() => {
    activeSessions.clear()
    v2Sessions.clear()
    getConsumerHandle.mockReset()
    hasActiveTeamTasks.mockReset()
  })

  it('is busy when a legacy activeSessions entry exists, before even checking the consumer', () => {
    activeSessions.set('conv-1', {})
    expect(isNativeConversationBusy('conv-1')).toBe(true)
    expect(getConsumerHandle).not.toHaveBeenCalled()
  })

  it('is not busy when there is no consumer at all', () => {
    getConsumerHandle.mockReturnValue(null)
    expect(isNativeConversationBusy('conv-1')).toBe(false)
  })

  it('is not busy when the consumer exists but is not running', () => {
    getConsumerHandle.mockReturnValue({ isRunning: false, getActiveSessionState: () => null, getTeamLifecycleThoughts: () => [] })
    expect(isNativeConversationBusy('conv-1')).toBe(false)
  })

  it('is busy when the consumer is actively processing a turn', () => {
    getConsumerHandle.mockReturnValue({
      isRunning: true,
      getActiveSessionState: () => ({ someTurnState: true }),
      getTeamLifecycleThoughts: () => [],
    })
    expect(isNativeConversationBusy('conv-1')).toBe(true)
  })

  it('is busy when idle between turns but team agents are still working', () => {
    const thoughts = [{ type: 'tool_use' }]
    getConsumerHandle.mockReturnValue({
      isRunning: true,
      getActiveSessionState: () => null,
      getTeamLifecycleThoughts: () => thoughts,
    })
    hasActiveTeamTasks.mockReturnValue(true)
    expect(isNativeConversationBusy('conv-1')).toBe(true)
    expect(hasActiveTeamTasks).toHaveBeenCalledWith(thoughts)
  })

  it('is not busy when idle between turns with no active team agents', () => {
    getConsumerHandle.mockReturnValue({
      isRunning: true,
      getActiveSessionState: () => null,
      getTeamLifecycleThoughts: () => [],
    })
    hasActiveTeamTasks.mockReturnValue(false)
    expect(isNativeConversationBusy('conv-1')).toBe(false)
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
