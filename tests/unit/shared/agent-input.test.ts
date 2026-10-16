import { describe, expect, it } from 'vitest'
import { isAgentInputArrivedEvent, isAgentInputStoppedEvent } from '../../../src/shared/types/agent-input'
import { shouldDeliverAgentEvent } from '../../../src/shared/agent-event-visibility'

const record = { id: 'input', role: 'system', source: 'team-message', content: 'report', timestamp: 'now' }
const event = { spaceId: 'space', conversationId: 'chat', live: true, messages: [record] }

describe('input-arrival transport', () => {
  it('is detail-only on both desktop and remote visibility rules', () => {
    expect(shouldDeliverAgentEvent('agent:input-arrived', 'chat', new Set(), event)).toBe(false)
    expect(shouldDeliverAgentEvent('agent:input-arrived', 'chat', new Set(['chat']), event)).toBe(true)
  })
  it('refuses malformed relayed records before subscribers render them', () => {
    expect(isAgentInputArrivedEvent(event)).toBe(true)
    expect(isAgentInputArrivedEvent({ ...event, messages: [{ ...record, metadata: { inputMode: 'live' } }] })).toBe(true)
    expect(isAgentInputArrivedEvent({ ...event, messages: [{ ...record, metadata: { inputMode: 'turn' } }] })).toBe(true)
    expect(isAgentInputArrivedEvent({ ...event, messages: [{ ...record, metadata: { inputMode: 'other' } }] })).toBe(false)
    expect(isAgentInputArrivedEvent({ ...event, messages: [{ ...record, metadata: { inputReplyId: 'reply' } }] })).toBe(true)
    expect(isAgentInputArrivedEvent({ ...event, messages: [{ ...record, metadata: { inputReplyId: 3 } }] })).toBe(false)
    expect(isAgentInputArrivedEvent({ ...event, messages: null })).toBe(false)
    expect(isAgentInputArrivedEvent({ ...event, messages: [null] })).toBe(false)
    expect(isAgentInputArrivedEvent({ ...event, messages: [{ ...record, metadata: { references: 'not an array' } }] })).toBe(false)
    expect(isAgentInputArrivedEvent({ ...event, messages: [{ ...record, images: ['not an image'] }] })).toBe(false)
  })
})

describe('stopped-input transport', () => {
  const stopped = { spaceId: 'space', conversationId: 'chat', messages: [{ ...record, role: 'user', source: 'injection', metadata: { inputOutcome: 'stopped' } }] }

  it('is detail-only on both desktop and remote visibility rules', () => {
    expect(shouldDeliverAgentEvent('agent:input-stopped', 'chat', new Set(), stopped)).toBe(false)
    expect(shouldDeliverAgentEvent('agent:input-stopped', 'chat', new Set(['chat']), stopped)).toBe(true)
  })

  it('accepts stopped records and refuses malformed ones', () => {
    expect(isAgentInputStoppedEvent(stopped)).toBe(true)
    expect(isAgentInputStoppedEvent({ ...stopped, messages: [{ ...record, metadata: { inputOutcome: 'other' } }] })).toBe(false)
    expect(isAgentInputStoppedEvent({ ...stopped, conversationId: 3 })).toBe(false)
    expect(isAgentInputStoppedEvent({ ...stopped, messages: [null] })).toBe(false)
    expect(isAgentInputArrivedEvent({ ...event, messages: stopped.messages })).toBe(true)
  })
})
