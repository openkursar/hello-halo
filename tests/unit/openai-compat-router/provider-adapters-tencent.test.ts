/**
 * Request shaping of the `tencent` adapter: what it removes from the prompt and
 * headers, what it renews per request, and that it touches no other upstream.
 */

import { describe, expect, it } from 'vitest'
import { applyProviderAdapter, findAdapter, type AdapterContext } from '../../../src/main/openai-compat-router/server/provider-adapters'
import { stampRequestTrace } from '../../../src/main/openai-compat-router/utils/request-trace'

const TENCENT_URL = 'https://copilot.tencent.com/v2/chat/completions'
const CLI_LINE = "You are Claude Code, Anthropic's official CLI for Claude."
const CLI_SDK_LINE = `${CLI_LINE.slice(0, -1)}, running within the Claude Agent SDK.`
const AGENT_LINE = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

const context = (sessionId = ''): AdapterContext => ({ originalRequest: {} as AdapterContext['originalRequest'], sessionId })

function body(system: unknown): Record<string, unknown> {
  return { model: 'm', messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }] }
}

function systemOf(request: Record<string, unknown>): unknown {
  return (request.messages as Array<{ role: string; content: unknown }>)[0]
}

function run(request: Record<string, unknown>, headers: Record<string, string> = {}, sessionId = '') {
  applyProviderAdapter(TENCENT_URL, request, headers, 'tencent', context(sessionId))
  return headers
}

describe('tencent adapter: Claude Code identity line', () => {
  it.each([CLI_LINE, CLI_SDK_LINE, AGENT_LINE])('drops a block that is only %s', (line) => {
    const request = body([{ type: 'text', text: line }, { type: 'text', text: 'You are Halo.' }])
    run(request)
    expect((systemOf(request) as { content: unknown }).content).toEqual([{ type: 'text', text: 'You are Halo.' }])
  })

  it.each([CLI_LINE, CLI_SDK_LINE, AGENT_LINE])('drops %s from the start of a string prompt', (line) => {
    const request = body(`${line}\n\nYou are Halo.`)
    run(request)
    expect((systemOf(request) as { content: unknown }).content).toBe('You are Halo.')
  })

  it('drops text glued to the line without a space', () => {
    const request = body(`${AGENT_LINE}You are Halo.`)
    run(request)
    expect((systemOf(request) as { content: unknown }).content).toBe('You are Halo.')
  })

  it('removes the system message when the line was all it held', () => {
    const request = body(CLI_SDK_LINE)
    run(request)
    expect(request.messages).toEqual([{ role: 'user', content: 'hi' }])

    const blocks = body([{ type: 'text', text: CLI_LINE }])
    run(blocks)
    expect(blocks.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('follows a changed wording of the line', () => {
    const request = body('You are Claude Code, Anthropic\'s CLI, now running inside another host. You are Halo.')
    run(request)
    expect((systemOf(request) as { content: unknown }).content).toBe('You are Halo.')
  })

  it('is idempotent across the retry that applies the adapter again', () => {
    const request = body([{ type: 'text', text: CLI_SDK_LINE }, { type: 'text', text: 'You are Halo.' }])
    run(request)
    const once = JSON.stringify(request)
    run(request)
    expect(JSON.stringify(request)).toBe(once)
  })

  it('leaves Halo prompts and passing mentions alone', () => {
    for (const system of ['You are Halo.', `Notes: ${CLI_LINE}`, [{ type: 'text', text: 'Mention Claude Code here.' }]]) {
      const request = body(system)
      const before = JSON.stringify(request)
      run(request)
      expect(JSON.stringify(request)).toBe(before)
    }
  })

  it('ignores a request whose first message is not a system message', () => {
    const request = { model: 'm', messages: [{ role: 'user', content: CLI_LINE }] }
    run(request)
    expect(request.messages[0].content).toBe(CLI_LINE)
  })

  it('still reshapes reasoning for the gateway', () => {
    const request: Record<string, unknown> = { ...body(CLI_LINE), reasoning_effort: 'high' }
    run(request)
    expect(request.reasoningEffort).toBe('high')
    expect(request.reasoning_summary).toBe('auto')
  })

  it('is applied to no other upstream', () => {
    const request = body(CLI_SDK_LINE)
    const before = JSON.stringify(request)
    const headers = { 'x-claude-code-session-id': 's', 'x-request-id': 'keep' }
    applyProviderAdapter('https://api.example.com/v1/chat/completions', request, headers, undefined, context('s'))
    expect(JSON.stringify(request)).toBe(before)
    expect(headers).toEqual({ 'x-claude-code-session-id': 's', 'x-request-id': 'keep' })
  })
})

describe('tencent adapter: headers', () => {
  const provider = () => ({
    'x-conversation-id': 'provider-conversation',
    'x-request-id': 'old', 'x-conversation-message-id': 'old', 'x-conversation-request-id': 'old', 'x-root-request-id': 'old',
    traceparent: 'old', b3: 'old', 'x-b3-traceid': 'old', 'x-b3-spanid': 'old', 'x-b3-parentspanid': 'old', 'x-trace-id': 'old',
    'x-ide-type': 'client', authorization: 'Bearer t'
  })

  it('does not forward the engine session headers', () => {
    const headers = run(body('x'), { ...provider(), 'x-claude-code-session-id': 's', session_id: 's' }, 's')
    expect(headers).not.toHaveProperty('x-claude-code-session-id')
    expect(headers).not.toHaveProperty('session_id')
  })

  it('gives each request its own identifiers, in the formats the client uses', () => {
    const a = run(body('x'), provider())
    const b = run(body('x'), provider())
    for (const name of ['x-request-id', 'x-conversation-request-id', 'x-trace-id', 'traceparent', 'b3']) {
      expect(a[name]).not.toBe('old')
      expect(a[name]).not.toBe(b[name])
    }
    expect(a['x-request-id']).toMatch(/^[0-9a-f]{32}$/)
    expect(a['x-conversation-message-id']).toBe(a['x-request-id'])
    expect(a['x-root-request-id']).toBe(a['x-conversation-request-id'])
    expect(a.traceparent).toBe(`00-${a['x-trace-id']}-${a['x-b3-spanid']}-01`)
    expect(a.b3).toBe(`${a['x-trace-id']}-${a['x-b3-spanid']}-1-${a['x-b3-parentspanid']}`)
    expect(a['x-b3-traceid']).toBe(a['x-trace-id'])
  })

  it('keeps everything it does not own', () => {
    const headers = run(body('x'), provider())
    expect(headers['x-ide-type']).toBe('client')
    expect(headers.authorization).toBe('Bearer t')
  })

  it('names the conversation after the engine session when there is one', () => {
    expect(run(body('x'), provider(), 'session-1')['x-conversation-id']).toBe('session-1')
    expect(run(body('x'), provider())['x-conversation-id']).toBe('provider-conversation')
  })

  it('never adds an identifier the provider did not set', () => {
    const headers: Record<string, string> = { authorization: 'Bearer t' }
    stampRequestTrace(headers, 'c')
    expect(headers).toEqual({ authorization: 'Bearer t' })
  })
})

describe('tencent adapter: selection', () => {
  it('is chosen by id whatever the host, and by its own host without one', () => {
    expect(findAdapter('https://example.com', 'tencent')?.id).toBe('tencent')
    expect(findAdapter('https://other-host.example/v2/chat/completions', 'tencent')?.id).toBe('tencent')
    expect(findAdapter('https://copilot.tencent.com/v2/chat/completions')?.id).toBe('tencent')
    expect(findAdapter('https://example.com/v2/chat/completions')).toBeUndefined()
  })
})
