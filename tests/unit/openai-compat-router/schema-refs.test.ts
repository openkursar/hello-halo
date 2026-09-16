/**
 * Tool schema `$ref` handling.
 *
 * Pins the invariant that the shared conversion path forwards tool schemas
 * unchanged, so Halo's wire output stays equivalent to what the SDK sends an
 * Anthropic endpoint directly. Inlining is a per-upstream concession and must
 * stay inside a provider adapter.
 */

import { describe, it, expect } from 'vitest'
import {
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses
} from '../../../src/main/openai-compat-router/converters'
import { applyProviderAdapter } from '../../../src/main/openai-compat-router/server/provider-adapters'
import {
  inlineSchemaRefs,
  inlineToolSchemaRefs
} from '../../../src/main/openai-compat-router/utils/json-schema'
import type { AnthropicRequest } from '../../../src/main/openai-compat-router/types'

const SCHEMA_WITH_REFS = {
  type: 'object',
  description: 'Send a message.',
  properties: {
    image: { $ref: '#/$defs/Media' },
    file: { $ref: '#/$defs/Media' }
  },
  required: ['image'],
  $defs: {
    Media: {
      type: 'object',
      properties: { media_id: { type: 'string', description: 'Uploaded media id' } },
      required: ['media_id']
    }
  }
}

function requestWithTools(): AnthropicRequest {
  return {
    model: 'gpt-4o',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'mcp__wecom__message_send',
        description: 'Send a message.',
        input_schema: structuredClone(SCHEMA_WITH_REFS) as never
      }
    ]
  }
}

describe('tool schema forwarding', () => {
  it('keeps $ref and $defs intact on the Chat Completions path', () => {
    const { request } = convertAnthropicToOpenAIChat(requestWithTools())
    const params = request.tools![0].function.parameters as Record<string, unknown>

    expect(params).toEqual(SCHEMA_WITH_REFS)
  })

  it('keeps $ref and $defs intact on the Responses path', () => {
    const { request } = convertAnthropicToOpenAIResponses(requestWithTools())
    const params = (request.tools as any[])![0].parameters as Record<string, unknown>

    expect(params).toEqual(SCHEMA_WITH_REFS)
  })

  it('preserves schema keywords the previous normalization dropped', () => {
    const anthropicRequest = requestWithTools()
    anthropicRequest.tools![0].input_schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#'
    } as never

    const { request } = convertAnthropicToOpenAIChat(anthropicRequest)
    const params = request.tools![0].function.parameters as Record<string, unknown>

    expect(params.additionalProperties).toBe(false)
    expect(params.$schema).toBe('http://json-schema.org/draft-07/schema#')
  })

  it('guarantees an object type when the schema omits it', () => {
    const anthropicRequest = requestWithTools()
    anthropicRequest.tools![0].input_schema = { properties: {} } as never

    const { request } = convertAnthropicToOpenAIChat(anthropicRequest)

    expect(request.tools![0].function.parameters).toEqual({ type: 'object', properties: {} })
  })
})

describe('inlineToolSchemaRefs', () => {
  it('returns the schema untouched when there is nothing to inline', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }

    expect(inlineSchemaRefs(schema)).toBe(schema)
  })

  it('rewrites both wire shapes and reports the count', () => {
    const body = {
      tools: [
        { type: 'function', function: { name: 'chat_shape', parameters: structuredClone(SCHEMA_WITH_REFS) } },
        { type: 'function', name: 'responses_shape', parameters: structuredClone(SCHEMA_WITH_REFS) },
        { type: 'function', function: { name: 'no_refs', parameters: { type: 'object', properties: {} } } }
      ]
    }

    expect(inlineToolSchemaRefs(body)).toBe(2)
    expect(body.tools[0].function!.parameters).not.toHaveProperty('$defs')
    expect((body.tools[1] as any).parameters).not.toHaveProperty('$defs')
    expect(body.tools[2].function!.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('ignores a body without tools', () => {
    expect(inlineToolSchemaRefs({ model: 'gpt-4o' })).toBe(0)
  })
})

describe('provider-scoped inlining', () => {
  function bodyWithRefs() {
    return {
      tools: [
        { type: 'function', function: { name: 'send', parameters: structuredClone(SCHEMA_WITH_REFS) } }
      ]
    }
  }

  it('inlines for Moonshot', () => {
    const body = bodyWithRefs()
    const adapter = applyProviderAdapter('https://api.moonshot.cn/v1/chat/completions', body, {})

    expect(adapter?.id).toBe('moonshot')
    expect(body.tools[0].function.parameters).not.toHaveProperty('$defs')
    expect(body.tools[0].function.parameters.properties.image).toEqual(SCHEMA_WITH_REFS.$defs.Media)
  })

  it('leaves refs alone for every other upstream', () => {
    const body = bodyWithRefs()
    applyProviderAdapter('https://api.deepseek.com/v1/chat/completions', body, {})

    expect(body.tools[0].function.parameters).toEqual(SCHEMA_WITH_REFS)
  })
})
