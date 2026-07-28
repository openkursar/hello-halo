/**
 * Unit tests for the OpenAI-compat request converters — `stream_options` injection.
 *
 * Issue #181: OpenAI-compat gateways (litellm, OpenAI public Chat Completions
 * API) only emit usage in streamed chunks when `stream_options.include_usage`
 * is set; without it, `TokenUsageIndicator` renders zeros. These tests pin
 * the converter contract at the protocol boundary.
 */

import { describe, it, expect } from 'vitest'
import {
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses
} from '../../../src/main/openai-compat-router/converters'
import type { AnthropicRequest } from '../../../src/main/openai-compat-router/types'

describe('Chat Completions — stream_options.include_usage (issue #181)', () => {
  it('injects stream_options.include_usage when stream is true', () => {
    const request: AnthropicRequest = {
      model: 'gpt-4o',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }]
    }

    const result = convertAnthropicToOpenAIChat(request)

    expect(result.request.stream).toBe(true)
    expect(result.request.stream_options).toEqual({ include_usage: true })
  })

  it('omits stream_options when stream is false', () => {
    const request: AnthropicRequest = {
      model: 'gpt-4o',
      stream: false,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }]
    }

    const result = convertAnthropicToOpenAIChat(request)

    expect(result.request.stream).toBe(false)
    expect(result.request.stream_options).toBeUndefined()
  })

  it('omits stream_options when stream is not set (default falsy)', () => {
    const request: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }]
    }

    const result = convertAnthropicToOpenAIChat(request)

    expect(result.request.stream).toBeFalsy()
    expect(result.request.stream_options).toBeUndefined()
  })

  it('injects stream_options.include_usage for reasoning model requests', () => {
    // Sanity check: model id must not affect the stream_options contract.
    const request: AnthropicRequest = {
      model: 'o1-mini',
      stream: true,
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'Hello' }]
    }

    const result = convertAnthropicToOpenAIChat(request)

    expect(result.request.stream_options).toEqual({ include_usage: true })
  })
})

describe('Responses API — stream_options.include_usage (issue #181)', () => {
  it('injects stream_options.include_usage when stream is true', () => {
    // See `anthropic-to-openai-responses.ts` for why this is needed despite
    // the native Responses API returning usage unconditionally.
    const request: AnthropicRequest = {
      model: 'claude-3-opus',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello!' }]
    }

    const result = convertAnthropicToOpenAIResponses(request)

    expect(result.request.stream).toBe(true)
    expect(result.request.stream_options).toEqual({ include_usage: true })
  })

  it('omits stream_options when stream is false', () => {
    const request: AnthropicRequest = {
      model: 'claude-3-opus',
      stream: false,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello!' }]
    }

    const result = convertAnthropicToOpenAIResponses(request)

    expect(result.request.stream).toBe(false)
    expect(result.request.stream_options).toBeUndefined()
  })

  it('omits stream_options when stream is not set (default falsy)', () => {
    const request: AnthropicRequest = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello!' }]
    }

    const result = convertAnthropicToOpenAIResponses(request)

    expect(result.request.stream).toBeFalsy()
    expect(result.request.stream_options).toBeUndefined()
  })

  it('injects stream_options.include_usage for reasoning model requests', () => {
    // Symmetry with the Chat Completions path.
    const request: AnthropicRequest = {
      model: 'o1-mini',
      stream: true,
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'Hello!' }]
    }

    const result = convertAnthropicToOpenAIResponses(request)

    expect(result.request.stream_options).toEqual({ include_usage: true })
  })
})
