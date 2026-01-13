/**
 * Unit Tests for Converters
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
      expect(result.request.max_tokens).toBe(1024)
      expect(result.request.messages).toHaveLength(1)
      expect(result.request.messages[0]).toEqual({
        role: 'user',
        content: 'Hello, world!'
      })
      expect(result.hasImages).toBe(false)
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

    it('should convert thinking config to reasoning', () => {
      const request: AnthropicRequest = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Think about this' }],
        thinking: { type: 'enabled', budget_tokens: 15000 }
      }

      const result = convertAnthropicToOpenAIChat(request)

      expect(result.request.reasoning).toEqual({
        enabled: true,
        effort: 'high'
      })
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
