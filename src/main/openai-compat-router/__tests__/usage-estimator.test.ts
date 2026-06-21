/**
 * Tests for the usage estimation fallback.
 *
 * Contract under test: estimates MAY over-count but MUST NEVER under-count,
 * real upstream usage is never overwritten, and the stream-level fallback
 * fills usage only when the upstream omitted it.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/halo-test',
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test'
  },
  session: {
    defaultSession: {
      resolveProxy: vi.fn(async () => 'DIRECT')
    },
    fromPartition: vi.fn(() => ({ setProxy: vi.fn(async () => undefined) }))
  }
}))

import {
  estimateUsageTokens,
  estimateRequestInputTokens,
  estimateResponseOutputTokens,
  deferInputTokensEstimate,
  fillResponseUsageFallback
} from '../utils/usage-estimator'
import { estimateTokensByChars, countTokens } from '../utils/token-counter'
import { streamOpenAIChatToAnthropic } from '../stream/openai-chat-stream'
import type { AnthropicMessageResponse, AnthropicRequest } from '../types'

function makeRequest(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: 'qwen-plus',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Summarize the latest deploy logs.' }],
    ...overrides
  }
}

describe('estimateUsageTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateUsageTokens('')).toBe(0)
  })

  it('applies the bias-high factor over the raw char estimate', () => {
    const text = '2026-06-11 12:34:56 INFO request_id=8f3a92 latency=123ms status=200\n'.repeat(20)
    const raw = estimateTokensByChars(text)
    expect(estimateUsageTokens(text)).toBe(Math.ceil(raw * 1.35))
  })

  it('never under-counts vs the real cl100k tokenizer on log/JSON-heavy text', () => {
    // The contract is "may over-count, must never under-count". Log/JSON/digit
    // text is where the raw char estimate dips lowest (~0.74x real), so the
    // bias factor must keep the final estimate at or above the real count for
    // the cl100k family (Qwen/DeepSeek/GLM default tokenizer).
    const text = JSON.stringify({
      status: 'ok',
      items: Array.from({ length: 30 }, (_, i) => ({ id: i, ts: 1781168205972 + i, ok: true }))
    })
    expect(estimateUsageTokens(text)).toBeGreaterThanOrEqual(countTokens(text, 'qwen-plus'))
  })

  it('never under-counts vs the real cl100k tokenizer on CJK prose', () => {
    const text = '今天的部署任务已经全部完成，所有的检查项都通过了，没有发现任何异常。'.repeat(8)
    expect(estimateUsageTokens(text)).toBeGreaterThanOrEqual(countTokens(text, 'qwen-plus'))
  })
})

describe('estimateRequestInputTokens', () => {
  it('counts system, messages and tool definitions', () => {
    const base = estimateRequestInputTokens(makeRequest())
    const withSystem = estimateRequestInputTokens(
      makeRequest({ system: 'You are a helpful assistant with a long preamble.' })
    )
    const withTools = estimateRequestInputTokens(
      makeRequest({
        tools: [{
          name: 'read_file',
          description: 'Read a file from disk',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } }
        }]
      })
    )
    expect(base).toBeGreaterThan(0)
    expect(withSystem).toBeGreaterThan(base)
    expect(withTools).toBeGreaterThan(base)
  })

  it('walks structured content blocks including tool_use and tool_result', () => {
    const structured = estimateRequestInputTokens(makeRequest({
      messages: [
        { role: 'user', content: 'run the check' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running it now.' },
            { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test --reporter=verbose' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'All 42 tests passed in 3.2s' }
          ]
        }
      ]
    }))
    expect(structured).toBeGreaterThan(estimateRequestInputTokens(makeRequest()))
  })

  it('skips image base64 payloads', () => {
    const withImage = estimateRequestInputTokens(makeRequest({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(500_000) } as never }
        ]
      }]
    }))
    // A 500KB base64 blob naively counted as text would add ~100K+ tokens.
    expect(withImage).toBeLessThan(1_000)
  })
})

describe('deferInputTokensEstimate', () => {
  it('resolves to the same value as the synchronous walk', async () => {
    const request = makeRequest({ system: 'be brief' })
    const thunk = deferInputTokensEstimate(request)
    expect(await thunk()).toBe(estimateRequestInputTokens(request))
  })
})

describe('fillResponseUsageFallback', () => {
  function makeResponse(usage: { input_tokens: number; output_tokens: number }): AnthropicMessageResponse {
    return {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'qwen-plus',
      content: [{ type: 'text', text: 'The deploy finished without errors.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage
    }
  }

  it('fills both fields when usage is all-zero', () => {
    const response = makeResponse({ input_tokens: 0, output_tokens: 0 })
    fillResponseUsageFallback(response, makeRequest())
    expect(response.usage.input_tokens).toBeGreaterThan(0)
    expect(response.usage.output_tokens).toBe(estimateResponseOutputTokens(response.content))
  })

  it('never overwrites real upstream usage', () => {
    const response = makeResponse({ input_tokens: 123, output_tokens: 456 })
    fillResponseUsageFallback(response, makeRequest())
    expect(response.usage.input_tokens).toBe(123)
    expect(response.usage.output_tokens).toBe(456)
  })
})

describe('stream usage fallback (OpenAIChatStreamHandler)', () => {
  function createMockRes() {
    const chunks: string[] = []
    const res = {
      write: (chunk: unknown) => { chunks.push(String(chunk)); return true },
      end: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }
    return { res: res as never, chunks }
  }

  function sseToStream(lines: string): ReadableStream {
    const encoded = new TextEncoder().encode(lines)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoded)
        controller.close()
      }
    })
  }

  function extractMessageDeltaUsage(chunks: string[]): { input_tokens?: number; output_tokens: number } {
    const body = chunks.join('')
    for (const part of body.split('\n\n')) {
      const dataLine = part.split('\n').find(l => l.startsWith('data:'))
      if (!dataLine) continue
      const data = JSON.parse(dataLine.slice(5).trim())
      if (data.type === 'message_delta') return data.usage
    }
    throw new Error('no message_delta in stream output')
  }

  const usageLessUpstream = [
    'data: {"id":"c1","model":"qwen-plus","choices":[{"index":0,"delta":{"content":"The deploy finished without errors and all checks passed."}}]}\n\n',
    'data: {"id":"c1","model":"qwen-plus","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ].join('')

  it('fills estimated usage when the upstream omits it', async () => {
    const { res, chunks } = createMockRes()
    await streamOpenAIChatToAnthropic(
      sseToStream(usageLessUpstream),
      res,
      'qwen-plus',
      false,
      () => Promise.resolve(2048)
    )
    const usage = extractMessageDeltaUsage(chunks)
    expect(usage.input_tokens).toBe(2048)
    expect(usage.output_tokens).toBeGreaterThan(0)
  })

  it('keeps real upstream usage untouched', async () => {
    const upstream = [
      'data: {"id":"c1","model":"qwen-plus","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
      'data: {"id":"c1","model":"qwen-plus","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    const { res, chunks } = createMockRes()
    await streamOpenAIChatToAnthropic(
      sseToStream(upstream),
      res,
      'qwen-plus',
      false,
      () => Promise.resolve(9999)
    )
    const usage = extractMessageDeltaUsage(chunks)
    expect(usage.input_tokens).toBe(11)
    expect(usage.output_tokens).toBe(7)
  })

  it('still finishes cleanly without an input estimator', async () => {
    const { res, chunks } = createMockRes()
    await streamOpenAIChatToAnthropic(sseToStream(usageLessUpstream), res, 'qwen-plus')
    const usage = extractMessageDeltaUsage(chunks)
    expect(usage.output_tokens).toBeGreaterThan(0)
  })

  it('applies fallback when the upstream stops without finish_reason or usage', async () => {
    // Provider streams partial text then closes the connection — no
    // finish_reason, no usage, no [DONE]. finishMessage still runs in the
    // handler's finally block, so the fallback must populate usage from the
    // text accumulated before the stream ended.
    const partial =
      'data: {"id":"c1","model":"qwen-plus","choices":[{"index":0,"delta":{"content":"partial answer before the connection closed"}}]}\n\n'
    const { res, chunks } = createMockRes()
    await streamOpenAIChatToAnthropic(sseToStream(partial), res, 'qwen-plus', false, () => Promise.resolve(512))
    const usage = extractMessageDeltaUsage(chunks)
    expect(usage.input_tokens).toBe(512)
    expect(usage.output_tokens).toBeGreaterThan(0)
  })
})
