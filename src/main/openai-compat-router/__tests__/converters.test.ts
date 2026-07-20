/**
 * Unit Tests for Converters (colocated)
 *
 * This file is outside the vitest CI include pattern and runs only when
 * invoked manually. It is retained for local development of legacy converter
 * behavior.
 *
 * Canonical tests for issue #137 (max_tokens routing, reasoning model
 * detection, output-token normalization) live in
 * `tests/unit/services/openai-compat-converters.test.ts` — that file is the
 * mandatory pre-handoff validation source. Do not add new #137 coverage here.
 */

import { describe, it, expect } from 'vitest'
import {
  convertAnthropicToOpenAIChat,
  convertAnthropicToOpenAIResponses,
  convertOpenAIChatToAnthropic,
  convertOpenAIResponsesToAnthropic,
  createAnthropicErrorResponse
} from '../converters'
import type { AnthropicRequest, OpenAIChatResponse } from '../types'

describe('Request Converters', () => {
  describe('convertAnthropicToOpenAIChat', () => {
    it('should convert a simple text message', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello, world!' }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.request.model).toBe('claude-3-opus')
      // max_tokens is forwarded so providers honor the user's output length setting
      expect(result.request.max_tokens).toBe(1024)
      expect(result.request.messages).toHaveLength(1)
      expect(result.request.messages[0]).toEqual({
        role: 'user',
        content: 'Hello, world!'
      })
      expect(result.hasImages).toBe(false)
    })

    it('should omit max_tokens when not a positive value', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 0,
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.request.max_tokens).toBeUndefined()
    })

    it('should convert system prompt to system message', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'Hi' }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.request.messages).toHaveLength(2)
      expect(result.request.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.'
      })
    })

    it('should convert image blocks', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'abc123'
                }
              }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.hasImages).toBe(true)
      const userContent = result.request.messages[0].content as any[]
      expect(userContent).toHaveLength(2)
      expect(userContent[1].type).toBe('image_url')
      expect(userContent[1].image_url.url).toBe('data:image/png;base64,abc123')
    })

    it('should convert tool_result to tool message', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_123',
                content: 'Result from tool'
              }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.request.messages[0]).toEqual({
        role: 'tool',
        content: 'Result from tool',
        tool_call_id: 'call_123'
      })
    })

    it('should convert assistant tool_use to tool_calls', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_456',
                name: 'get_weather',
                input: { location: 'Tokyo' }
              }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.request.messages[0].role).toBe('assistant')
      expect((result.request.messages[0] as any).tool_calls).toHaveLength(1)
      expect((result.request.messages[0] as any).tool_calls[0]).toEqual({
        id: 'call_456',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"Tokyo"}'
        }
      })
    })

    it('should convert thinking config to reasoning_effort', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Think about this' }],
        thinking: { type: 'enabled', budget_tokens: 15000 }
      }

      const result = convertAnthropicToOpenAIChat(request)

      // Chat Completions uses top-level reasoning_effort string (not nested object)
      expect(result.request.reasoning_effort).toBe('high')
    })

    it('should omit reasoning_effort when thinking is disabled', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        thinking: { type: 'disabled' }
      }

      const result = convertAnthropicToOpenAIChat(request)

      // Disabled thinking must NOT produce any reasoning field
      expect(result.request.reasoning_effort).toBeUndefined()
    })

    // ====================================================================
    // reasoning_content injection from thinking blocks
    // ====================================================================

    it('should inject reasoning_content when assistant has thinking blocks', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'The user greeted me, I should respond warmly.' },
              { type: 'text', text: 'Hi there!' }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const msgs = result.request.messages as any[]
      expect(msgs[1].role).toBe('assistant')
      expect(msgs[1].reasoning_content).toBe('The user greeted me, I should respond warmly.')
      expect(msgs[1].content).toBe('Hi there!')
    })

    it('should join multiple thinking blocks within one turn', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Solve this' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Step 1: parse the problem' },
              { type: 'thinking', thinking: 'Step 2: compute the answer' },
              { type: 'text', text: 'The answer is 42' }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const msgs = result.request.messages as any[]
      expect(msgs[1].reasoning_content).toBe('Step 1: parse the problem\nStep 2: compute the answer')
    })

    it('should inject reasoning_content alongside tool_calls', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Search this' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I need to search for this query.' },
              {
                type: 'tool_use',
                id: 'call_search',
                name: 'search',
                input: { query: 'test' }
              }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const msgs = result.request.messages as any[]
      expect(msgs[1].role).toBe('assistant')
      expect(msgs[1].reasoning_content).toBe('I need to search for this query.')
      expect(msgs[1].content).toBeNull()
      expect(msgs[1].tool_calls).toHaveLength(1)
      expect(msgs[1].tool_calls[0].function.name).toBe('search')
    })

    it('should not inject reasoning_content when no thinking blocks present', () => {
      const request: AnthropicRequest = {
        model: 'gpt-4',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Hi!' }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const msgs = result.request.messages as any[]
      expect(msgs[1].content).toBe('Hi!')
      expect(msgs[1].reasoning_content).toBeUndefined()
    })

    it('should not inject reasoning_content on user messages', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'thought' },
              { type: 'text', text: 'Hi' }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const msgs = result.request.messages as any[]
      expect(msgs[0].reasoning_content).toBeUndefined()
      expect(msgs[1].reasoning_content).toBeDefined()
    })

    it('should handle multi-turn with thinking blocks in different turns', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Q1' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'thinking-1' },
              { type: 'text', text: 'A1' }
            ]
          },
          { role: 'user', content: 'Q2' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'thinking-2' },
              { type: 'text', text: 'A2' }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const msgs = result.request.messages as any[]
      expect(msgs[1].reasoning_content).toBe('thinking-1')
      expect(msgs[3].reasoning_content).toBe('thinking-2')
    })

    it('should inject empty reasoning_content on all assistant messages when reasoning_effort is set', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'how are you' },
          { role: 'assistant', content: 'good' }
        ],
        thinking: { type: 'enabled', budget_tokens: 8000 }
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.request.reasoning_effort).toBe('medium')
      const msgs = result.request.messages as any[]
      // All assistant messages get reasoning_content even without thinking blocks
      expect(msgs[0].role).toBe('user')
      expect(msgs[0].reasoning_content).toBeUndefined() // user messages untouched
      expect(msgs[1].role).toBe('assistant')
      expect(msgs[1].reasoning_content).toBe('') // empty: no thinking block
      expect(msgs[2].role).toBe('user')
      expect(msgs[3].role).toBe('assistant')
      expect(msgs[3].reasoning_content).toBe('') // empty: no thinking block
    })

    it('should inject empty reasoning_content on messages without thinking blocks when thinking exists in conversation', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-v4-pro',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Q1' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'thinking-1' },
              { type: 'text', text: 'A1' }
            ]
          },
          { role: 'user', content: 'Q2' },
          { role: 'assistant', content: 'A2' } // no thinking block
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const msgs = result.request.messages as any[]
      // First assistant message has real thinking
      expect(msgs[1].reasoning_content).toBe('thinking-1')
      // Second assistant message (no thinking block) gets empty string
      // because thinking exists in the conversation, so all must carry it
      expect(msgs[3].reasoning_content).toBe('')
    })
  })

  describe('convertAnthropicToOpenAIResponses', () => {
    it('should convert to Responses API format', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello!' }
        ]
      }

      const result = convertAnthropicToOpenAIResponses(request)

      expect(result.request.model).toBe('claude-3-opus')
      // The Responses API field `max_output_tokens` is part of the public spec
      // and is forwarded so the user's "max output tokens" setting is honored.
      expect(result.request.max_output_tokens).toBe(1024)
      expect(result.request.input).toHaveLength(1)
      expect((result.request.input as any)[0].role).toBe('user')
      expect((result.request.input as any)[0].content[0]).toEqual({
        type: 'input_text',
        text: 'Hello!'
      })
    })

    it('should convert tool_use to function_call', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_789',
                name: 'search',
                input: { query: 'test' }
              }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIResponses(request)

      const functionCall = (result.request.input as any[]).find(
        (item) => item.type === 'function_call'
      )
      expect(functionCall).toBeDefined()
      expect(functionCall.call_id).toBe('call_789')
      expect(functionCall.name).toBe('search')
    })
  })

  // ========================================================================
  // Non-vision model image stripping (issue #109)
  //
  // OpenAI Chat encodes images as `{type:'image_url',...}`, but strict
  // non-vision providers reject the variant entirely. The renderer UI
  // gates direct user input, but images still leak in via tool products
  // (Read on image files, browser screenshots, MCP image returns) and
  // mid-conversation model switches. The converter must drop image blocks
  // for non-vision models as a hard backstop while preserving `hasImages`
  // for accurate telemetry/UX.
  // ========================================================================
  describe('non-vision model image stripping', () => {
    const PNG_SOURCE = {
      type: 'base64' as const,
      media_type: 'image/png',
      data: 'abc123'
    }

    it('drops image blocks from user content for non-vision models', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-chat',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in the screenshot?' },
              { type: 'image', source: PNG_SOURCE }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      // hasImages reports the ORIGINAL input shape — unaffected by stripping.
      expect(result.hasImages).toBe(true)

      const content = result.request.messages[0].content as any[]
      expect(content).toHaveLength(1)
      expect(content[0].type).toBe('text')
      expect(content.some((p: any) => p.type === 'image_url')).toBe(false)
    })

    it('drops image blocks nested in tool_result.content arrays', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-reasoner',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_screenshot',
                content: [
                  { type: 'text', text: 'Page rendered' },
                  { type: 'image', source: PNG_SOURCE }
                ]
              }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.hasImages).toBe(true)
      const toolMsg = result.request.messages[0] as any
      expect(toolMsg.role).toBe('tool')
      // Serialized content must not carry the image block.
      expect(toolMsg.content).not.toContain('"image"')
      expect(toolMsg.content).toContain('Page rendered')
    })

    it('preserves images for vision-capable models (unchanged behavior)', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-5-sonnet',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe' },
              { type: 'image', source: PNG_SOURCE }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.hasImages).toBe(true)
      const content = result.request.messages[0].content as any[]
      expect(content).toHaveLength(2)
      expect(content[1].type).toBe('image_url')
    })

    it('preserves images when vision keyword overrides the blacklist (deepseek-vl)', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-vl-7b-chat',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: PNG_SOURCE }]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const content = result.request.messages[0].content as any[]
      expect(content[0].type).toBe('image_url')
    })

    it('defaults to preserving images for unknown model IDs', () => {
      const request: AnthropicRequest = {
        model: 'some-novel-future-model',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: PNG_SOURCE }]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const content = result.request.messages[0].content as any[]
      expect(content[0].type).toBe('image_url')
    })

    it('is a no-op for text-only conversations with non-vision models', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-chat',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }]
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.hasImages).toBe(false)
      expect(result.request.messages[0]).toEqual({ role: 'user', content: 'hello' })
    })

    it('symmetric stripping on the Responses API path', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-chat',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source: PNG_SOURCE }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIResponses(request)

      expect(result.hasImages).toBe(true)
      const userMsg = (result.request.input as any[]).find((i) => i.role === 'user')
      expect(userMsg).toBeDefined()
      expect(userMsg.content.some((p: any) => p.type === 'input_image')).toBe(false)
      expect(userMsg.content.some((p: any) => p.type === 'input_text')).toBe(true)
    })

    it('Responses path drops images nested in tool_result.content', () => {
      const request: AnthropicRequest = {
        model: 'deepseek-chat',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_x',
                content: [
                  { type: 'text', text: 'ok' },
                  { type: 'image', source: PNG_SOURCE }
                ]
              }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIResponses(request)

      expect(result.hasImages).toBe(true)
      const fco = (result.request.input as any[]).find((i) => i.type === 'function_call_output')
      expect(fco).toBeDefined()
      expect(fco.output).not.toContain('"image"')
      expect(fco.output).toContain('ok')
    })

    // Issue #139: the router receives the provider-declared
    // ModelOption.supportsVision through the encoded BackendConfig. Models that
    // are NOT in the built-in blacklist (so supportsVisionById would return
    // true) must still strip images when the override says the model has no
    // vision capability. Without this, non-multimodal custom/niche models
    // receive image payloads and reject them with HTTP 400.
    it('Chat path honors explicit supportsVision=false override for unknown models', () => {
      const request: AnthropicRequest = {
        model: 'some-novel-future-model',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source: PNG_SOURCE }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request, { supportsVision: false })

      expect(result.hasImages).toBe(true)
      const content = result.request.messages[0].content as any[]
      expect(content).toHaveLength(1)
      expect(content[0].type).toBe('text')
      expect(content.some((p: any) => p.type === 'image_url')).toBe(false)
    })

    it('Chat path honors explicit supportsVision=true override for blacklisted models', () => {
      // Override wins both ways: a provider can declare a blacklisted model
      // actually supports vision (e.g. a custom multimodal deepseek variant).
      const request: AnthropicRequest = {
        model: 'deepseek-chat',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: PNG_SOURCE }]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request, { supportsVision: true })

      const content = result.request.messages[0].content as any[]
      expect(content[0].type).toBe('image_url')
    })

    it('Responses path honors explicit supportsVision=false override for unknown models', () => {
      const request: AnthropicRequest = {
        model: 'some-novel-future-model',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source: PNG_SOURCE }
            ]
          }
        ]
      }

      const result = convertAnthropicToOpenAIResponses(request, { supportsVision: false })

      expect(result.hasImages).toBe(true)
      const userMsg = (result.request.input as any[]).find((i) => i.role === 'user')
      expect(userMsg).toBeDefined()
      expect(userMsg.content.some((p: any) => p.type === 'input_image')).toBe(false)
      expect(userMsg.content.some((p: any) => p.type === 'input_text')).toBe(true)
    })

    it('converter omits override → falls back to supportsVisionById (preserves default behavior)', () => {
      // Sanity: when no override is passed, the heuristic still defaults
      // unknown models to vision-capable.
      const request: AnthropicRequest = {
        model: 'some-novel-future-model',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: PNG_SOURCE }]
          }
        ]
      }

      const result = convertAnthropicToOpenAIChat(request)

      const content = result.request.messages[0].content as any[]
      expect(content[0].type).toBe('image_url')
    })
  })
})

describe('Response Converters', () => {
  describe('convertOpenAIChatToAnthropic', () => {
    it('should convert a simple response', () => {
      const response: OpenAIChatResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! How can I help?'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18
        }
      }

      const result = convertOpenAIChatToAnthropic(response)

      expect(result.id).toBe('chatcmpl-123')
      expect(result.model).toBe('gpt-4')
      expect(result.role).toBe('assistant')
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Hello! How can I help?'
      })
      expect(result.stop_reason).toBe('end_turn')
      expect(result.usage.input_tokens).toBe(10)
      expect(result.usage.output_tokens).toBe(8)
    })

    it('should convert tool_calls to tool_use', () => {
      const response: OpenAIChatResponse = {
        id: 'chatcmpl-456',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"London"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 15,
          total_tokens: 35
        }
      }

      const result = convertOpenAIChatToAnthropic(response)

      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('tool_use')
      expect((result.content[0] as any).id).toBe('call_abc')
      expect((result.content[0] as any).name).toBe('get_weather')
      expect((result.content[0] as any).input).toEqual({ city: 'London' })
      expect(result.stop_reason).toBe('tool_use')
    })

    it('should map finish_reason correctly', () => {
      const testCases = [
        { finish_reason: 'stop', expected: 'end_turn' },
        { finish_reason: 'length', expected: 'max_tokens' },
        { finish_reason: 'tool_calls', expected: 'tool_use' },
        { finish_reason: 'content_filter', expected: 'stop_sequence' }
      ] as const

      for (const { finish_reason, expected } of testCases) {
        const response: OpenAIChatResponse = {
          id: 'test',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'test' },
              finish_reason
            }
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }

        const result = convertOpenAIChatToAnthropic(response)
        expect(result.stop_reason).toBe(expected)
      }
    })
  })

  describe('convertOpenAIResponsesToAnthropic', () => {
    it('should convert a simple response', () => {
      const response = {
        id: 'resp_123',
        object: 'response',
        model: 'gpt-4o',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'Hello from Responses API!' }
            ]
          }
        ],
        usage: {
          input_tokens: 15,
          output_tokens: 10,
          total_tokens: 25,
          output_tokens_details: { reasoning_tokens: 0 }
        }
      }

      const result = convertOpenAIResponsesToAnthropic(response)

      expect(result.id).toBe('resp_123')
      expect(result.model).toBe('gpt-4o')
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Hello from Responses API!'
      })
    })

    it('should convert function_call to tool_use', () => {
      const response = {
        id: 'resp_456',
        model: 'gpt-4o',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_xyz',
            name: 'calculator',
            arguments: '{"expression":"2+2"}'
          }
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }

      const result = convertOpenAIResponsesToAnthropic(response)

      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('tool_use')
      expect((result.content[0] as any).name).toBe('calculator')
    })
  })

  describe('createAnthropicErrorResponse', () => {
    it('should create a valid error response', () => {
      const result = createAnthropicErrorResponse('Something went wrong')

      expect(result.type).toBe('message')
      expect(result.role).toBe('assistant')
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Error: Something went wrong'
      })
      expect(result.stop_reason).toBe('end_turn')
    })
  })
})
