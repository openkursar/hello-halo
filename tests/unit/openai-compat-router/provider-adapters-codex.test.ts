/**
 * The Codex backend accepts the Responses API but not the generic shape Halo's
 * converter produces. These tests lock in the reshapes the open-source Codex CLI
 * performs, and the fact that the adapter is opt-in by adapterId rather than
 * capturing every request that happens to share the host.
 */

import { describe, expect, it } from 'vitest'
import { applyProviderAdapter, type AdapterContext } from '../../../src/main/openai-compat-router/server/provider-adapters'
import type { CodexModelCapability } from '../../../src/shared/types/ai-sources'
import { CODEX_ADAPTER_ID } from '../../../src/shared/constants/codex-models'

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses'

function context(sessionId = '', capability?: Partial<CodexModelCapability>): AdapterContext {
  return {
    originalRequest: {} as AdapterContext['originalRequest'], sessionId,
    codexModelCapabilities: capability ? { reasoningSummary: true, responsesLite: false, ...capability } : undefined
  }
}

describe('openai-codex provider adapter', () => {
  it('hoists the system message into top-level instructions and out of input', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'SYS' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
      ]
    }

    applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

    expect(body.instructions).toBe('SYS')
    const input = body.input as Array<Record<string, unknown>>
    expect(input).toHaveLength(1)
    expect(input[0].role).toBe('user')
  })

  it('omits instructions entirely when no system prompt was sent', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      instructions: 'stale',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
    }

    applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

    expect('instructions' in body).toBe(false)
  })

  it('sets the unconditional fields the backend reads', () => {
    const body: Record<string, unknown> = { model: 'gpt-5.5', input: [] }

    applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body.tool_choice).toBe('auto')
    expect(body.parallel_tool_calls).toBe(true)
  })

  /**
   * The backend rejects parameters the CLI never sends; observed live as
   * HTTP 400 "Unsupported parameter: max_output_tokens" on a request Halo's
   * converter had built. The adapter therefore reduces the body to the CLI's
   * own field set instead of dropping offenders one at a time.
   */
  it('reduces the body to the field set the CLI can send', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      input: [],
      stream: true,
      stream_options: { include_usage: true },
      max_output_tokens: 32000
    }

    applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

    expect('stream_options' in body).toBe(false)
    expect('max_output_tokens' in body).toBe(false)
    expect(Object.keys(body).sort()).toEqual([
      'include',
      'input',
      'model',
      'parallel_tool_calls',
      'store',
      'stream',
      'tool_choice'
    ])
  })

  it('mirrors the session id into prompt_cache_key and the session headers', () => {
    const body: Record<string, unknown> = { model: 'gpt-5.5', input: [] }
    const headers: Record<string, string> = {}

    applyProviderAdapter(CODEX_URL, body, headers, CODEX_ADAPTER_ID, context('sess-1'))

    expect(body.prompt_cache_key).toBe('sess-1')
    expect(headers['session-id']).toBe('sess-1')
    expect(headers['thread-id']).toBe('sess-1')
    expect(headers['x-client-request-id']).toBe('sess-1')
  })

  it('sends no session headers when the caller carried no session id', () => {
    const headers: Record<string, string> = {}

    applyProviderAdapter(CODEX_URL, { model: 'gpt-5.5', input: [] }, headers, CODEX_ADAPTER_ID, context())

    expect(headers).toEqual({})
  })

  it('leaves an unrelated upstream untouched when no adapterId is passed', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'SYS' }] }],
      stream_options: { include_usage: true }
    }

    applyProviderAdapter('https://api.example.com/v1/responses', body, {}, undefined, context('sess-1'))

    expect('instructions' in body).toBe(false)
    expect(body.store).toBeUndefined()
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('keeps conflicting capabilities of the same model independent across accounts', () => {
    const makeBody = () => ({ model: 'shared-model', reasoning: { effort: 'max' }, input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'SYS' }] }
    ] }) as Record<string, unknown>
    const first = makeBody()
    const second = makeBody()
    const third = makeBody()
    const a = context('', { responsesLite: true, reasoningSummary: false, reasoningLevels: ['low'] })
    const b = context('', { responsesLite: false, reasoningSummary: true, reasoningLevels: ['high', 'xhigh'] })
    applyProviderAdapter(CODEX_URL, first, {}, CODEX_ADAPTER_ID, a)
    applyProviderAdapter(CODEX_URL, second, {}, CODEX_ADAPTER_ID, b)
    applyProviderAdapter(CODEX_URL, third, {}, CODEX_ADAPTER_ID, a)
    expect(first.instructions).toBeUndefined()
    expect(first.reasoning).toEqual({ effort: 'low' })
    expect(second.instructions).toBe('SYS')
    expect(second.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
    expect(third).toEqual(first)
  })

  describe('capability-driven reshapes', () => {
    it('requests a reasoning summary while thinking is on', () => {
      const body: Record<string, unknown> = { model: 'm-summary', input: [], reasoning: { effort: 'high' } }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

      expect((body.reasoning as { summary?: string }).summary).toBe('auto')
    })

    it('leaves summaries off when thinking is disabled', () => {
      const body: Record<string, unknown> = { model: 'm-summary', input: [], reasoning: { effort: 'none' } }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

      expect((body.reasoning as { summary?: string }).summary).toBeUndefined()
    })

    it('leaves summaries off when the catalog states the model rejects the parameter', () => {
      const body: Record<string, unknown> = { model: 'm-no-summary', input: [], reasoning: { effort: 'high' } }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context('', { reasoningSummary: false }))

      expect((body.reasoning as { summary?: string }).summary).toBeUndefined()
    })

    it('holds the effort to the levels the catalog lists for the model', () => {
      const body: Record<string, unknown> = { model: 'm-levels', input: [], reasoning: { effort: 'max' } }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context('', { reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }))

      expect((body.reasoning as { effort: string }).effort).toBe('xhigh')
    })

    it('bounds the effort by the Codex CLI enum before the catalog is read', () => {
      const body: Record<string, unknown> = { model: 'm-unknown', input: [], reasoning: { effort: 'max' } }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

      expect((body.reasoning as { effort: string }).effort).toBe('xhigh')
    })

    it('runs an off switch the catalog does not list at the lowest listed level', () => {
      const body: Record<string, unknown> = { model: 'm-levels', input: [], reasoning: { effort: 'none' } }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context('', { reasoningLevels: ['medium', 'high'] }))

      expect((body.reasoning as { effort: string }).effort).toBe('medium')
    })

    it('keeps an off switch the catalog lists or cannot rule on', () => {
      const listed: Record<string, unknown> = { model: 'm-none', input: [], reasoning: { effort: 'none' } }
      applyProviderAdapter(CODEX_URL, listed, {}, CODEX_ADAPTER_ID, context('', { reasoningLevels: ['none', 'low'] }))
      expect((listed.reasoning as { effort: string }).effort).toBe('none')

      const unread: Record<string, unknown> = { model: 'm-unread', input: [], reasoning: { effort: 'none' } }
      applyProviderAdapter(CODEX_URL, unread, {}, CODEX_ADAPTER_ID, context())
      expect((unread.reasoning as { effort: string }).effort).toBe('none')
    })

    it('gives every function tool its strict flag', () => {
      const body: Record<string, unknown> = {
        model: 'm-tools',
        input: [],
        tools: [
          { type: 'function', name: 'a', parameters: {} },
          { type: 'function', name: 'b', parameters: {}, strict: true }
        ]
      }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context())

      const tools = body.tools as Array<{ name: string; strict: boolean }>
      expect(tools.find((t) => t.name === 'a')!.strict).toBe(false)
      expect(tools.find((t) => t.name === 'b')!.strict).toBe(true)
    })

    /**
     * Responses-Lite models reject `instructions`; the CLI moves the system
     * prompt into `input` as a developer item for them.
     */
    it('moves the system prompt into a developer item for a Responses-Lite model', () => {
      const body: Record<string, unknown> = {
        model: 'm-lite',
        input: [
          { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'SYS' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
        ]
      }

      applyProviderAdapter(CODEX_URL, body, {}, CODEX_ADAPTER_ID, context('', { responsesLite: true }))

      expect('instructions' in body).toBe(false)
      const input = body.input as Array<Record<string, unknown>>
      expect(input[0].role).toBe('developer')
      expect(input[1].role).toBe('user')
    })
  })
})
