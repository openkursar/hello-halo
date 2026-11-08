import { describe, it, expect } from 'vitest'
import { agentErrorText, describeAgentError, formatAgentErrorDetail } from '../../../../src/renderer/components/chat/agent-error-text'
import { COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR } from '../../../../src/shared/constants/agent-errors'

const t = (key: string) => `translated:${key}`

// A gateway wrapping the upstream's own 429 body inside its 500 envelope.
const REASON = 'Provider credits rate limit: Credits limit exceeded for api_key. team: example-team, plan: standard, will reset at 2030-01-01 00:00:00 UTC'
const upstream = JSON.stringify({ error: { message: REASON, type: 'None', param: 'None', code: '429' } })
const GATEWAY_ERROR = `Provider API error (500): ${JSON.stringify({
  code: 10000,
  msg: `Gateway stream error, status: 429, resp: ${upstream}`,
  requestId: 'fixture-request-001',
  retry_policy: { retry: true, retry_after: 10 },
  displayMsg: { en: 'Service error. Please try again later', zh: '服务出错了，请稍后重试' },
  actions: ['RETRY', 'SUBMIT_FEEDBACK'],
})}`

describe('agentErrorText', () => {
  // The t() key must stay the stored English text, or nothing is ever translated.
  it('shows the missing command environment in the interface language', () => {
    expect(agentErrorText(COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR, t)).toBe(`translated:${COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR}`)
  })

  it('leaves any other error as it came', () => {
    expect(agentErrorText('process exited with code 1', t)).toBe('process exited with code 1')
  })
})

describe('describeAgentError', () => {
  it('reads the reason out from under two layers of provider envelope', () => {
    expect(describeAgentError(GATEWAY_ERROR, t)).toEqual({ text: REASON, expandable: true })
  })

  it('still finds the reason when a length cap cut the payload short', () => {
    const cut = GATEWAY_ERROR.slice(0, 400)
    expect(() => JSON.parse(cut.slice(cut.indexOf('{')))).toThrow()
    expect(describeAgentError(cut, t).text).toBe(REASON)
  })

  it('reads the message of a plain provider body', () => {
    expect(describeAgentError('API Error: 429 {"error":{"type":"rate_limit_error","message":"Slow down"}}', t))
      .toEqual({ text: 'Slow down', expandable: true })
    expect(describeAgentError('{"error":"Bad key"}', t)).toEqual({ text: 'Bad key', expandable: true })
  })

  it('prefers the sentence over the error code next to it', () => {
    expect(describeAgentError('API Error: 401 {"error":"unauthorized","message":"Invalid API key"}', t).text).toBe('Invalid API key')
  })

  it('decodes escaped characters in the reason', () => {
    expect(describeAgentError('x {"message":"\\u8bf7\\u7a0d\\u540e \\"retry\\""}', t).text).toBe('请稍后 "retry"')
  })

  it('falls back to the text before the payload when it has no reason field', () => {
    expect(describeAgentError('Provider API error (502): {"code":10000,"requestId":"abc"}', t))
      .toEqual({ text: 'Provider API error (502)', expandable: true })
  })

  it('does not take a brace in an ordinary message for a payload', () => {
    expect(describeAgentError('Unexpected token { in JSON at position 3', t))
      .toEqual({ text: 'Unexpected token { in JSON at position 3', expandable: false })
  })

  it('leaves a short plain error as it came, with nothing to expand', () => {
    expect(describeAgentError('Agent process exited with code 1', t))
      .toEqual({ text: 'Agent process exited with code 1', expandable: false })
  })

  it('cuts a long plain error and offers the rest', () => {
    const long = 'x'.repeat(1000)
    const summary = describeAgentError(long, t)
    expect(summary.text).toBe(`${'x'.repeat(400)}…`)
    expect(summary.expandable).toBe(true)
  })

  it('shows the known English failures in the interface language', () => {
    expect(describeAgentError(COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR, t))
      .toEqual({ text: `translated:${COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR}`, expandable: false })
  })
})

describe('formatAgentErrorDetail', () => {
  it('indents the payload and keeps the text around it', () => {
    const detail = formatAgentErrorDetail(GATEWAY_ERROR)
    expect(detail.startsWith('Provider API error (500):\n{\n  "code": 10000,')).toBe(true)
    expect(detail).toContain('"requestId": "fixture-request-001"')
  })

  it('returns an error without a payload, or with one that does not parse, unchanged', () => {
    expect(formatAgentErrorDetail('process exited with code 1')).toBe('process exited with code 1')
    const cut = GATEWAY_ERROR.slice(0, 200)
    expect(formatAgentErrorDetail(cut)).toBe(cut)
  })
})
