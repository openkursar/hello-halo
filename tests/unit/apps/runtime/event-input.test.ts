import { describe, it, expect } from 'vitest'
import { eventPayloadForModel, renderEventInput, renderTriggerContext } from '../../../../src/main/apps/runtime/event-input'
import type { TriggerContext } from '../../../../src/main/apps/runtime/types'

const webhookPayload = {
  path: '/orders',
  body: { order: 42, headers: 'a body field keeps its name', ip: 'so does this one' },
  query: { dry: '1' },
  method: 'POST',
  headers: { authorization: 'Bearer secret-token', cookie: 'sid=secret-cookie', 'x-hub-signature-256': 'sha256=sig' },
  ip: '203.0.113.7',
}

const eventTrigger: TriggerContext = {
  type: 'event',
  description: 'Triggered by event "webhook.received"',
  eventPayload: webhookPayload,
}

describe('event-input', () => {
  it('drops request headers and the caller address but keeps the event content', () => {
    expect(eventPayloadForModel(webhookPayload)).toEqual({
      path: '/orders',
      body: webhookPayload.body,
      query: { dry: '1' },
      method: 'POST',
    })
  })

  it('renders neither secrets nor the caller address in a run opening or a live addition', () => {
    for (const text of [renderTriggerContext(eventTrigger), renderEventInput(eventTrigger)]) {
      expect(text).toContain('"order": 42')
      expect(text).toContain('a body field keeps its name')
      expect(text).not.toContain('secret-token')
      expect(text).not.toContain('secret-cookie')
      expect(text).not.toContain('sha256=sig')
      expect(text).not.toContain('203.0.113.7')
    }
  })

  it('leaves non-event triggers as their description', () => {
    expect(renderTriggerContext({ type: 'schedule', description: 'Scheduled run' })).toBe('Scheduled run')
  })

  it('does not mutate the payload kept for the run record', () => {
    renderTriggerContext(eventTrigger)
    expect(eventTrigger.eventPayload).toHaveProperty('headers')
    expect(eventTrigger.eventPayload).toHaveProperty('ip')
  })
})
