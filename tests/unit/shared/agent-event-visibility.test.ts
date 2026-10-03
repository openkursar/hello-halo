/**
 * One delivery rule for every transport: full detail for declared
 * conversations, status events for all others.
 */

import { describe, it, expect } from 'vitest'
import { AGENT_STATUS_CHANNELS, shouldDeliverAgentEvent } from '../../../src/shared/agent-event-visibility'

const declared = new Set(['visible'])

describe('shouldDeliverAgentEvent', () => {
  it.each([
    'agent:thought', 'agent:thought-delta', 'agent:message', 'agent:tool-call', 'agent:tool-result',
    'agent:session-info', 'agent:compact', 'agent:api-retry', 'toolsets:changed', 'toolsets:requested',
  ])('streaming/detail channel %s reaches only declared conversations', (channel) => {
    expect(shouldDeliverAgentEvent(channel, 'visible', declared)).toBe(true)
    expect(shouldDeliverAgentEvent(channel, 'background', declared)).toBe(false)
  })

  it.each([...AGENT_STATUS_CHANNELS])('status channel %s reaches every conversation', (channel) => {
    expect(shouldDeliverAgentEvent(channel, 'background', declared)).toBe(true)
    expect(shouldDeliverAgentEvent(channel, 'background', new Set())).toBe(true)
  })

  it('a tool call awaiting approval reaches every conversation; other tool calls do not', () => {
    expect(shouldDeliverAgentEvent('agent:tool-call', 'background', declared, { requiresApproval: true })).toBe(true)
    expect(shouldDeliverAgentEvent('agent:tool-call', 'background', declared, { requiresApproval: false })).toBe(false)
    expect(shouldDeliverAgentEvent('agent:tool-call', 'background', declared, undefined)).toBe(false)
  })

  it('status set is exactly what running/finished/blocked indicators need', () => {
    expect([...AGENT_STATUS_CHANNELS].sort()).toEqual([
      'agent:ask-question', 'agent:complete', 'agent:error', 'agent:goal-updated', 'agent:turn-start',
    ])
  })
})
