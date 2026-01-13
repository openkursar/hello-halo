/**
 * Unit Tests for Type Guards
 */

import { describe, it, expect } from 'vitest'
import {
  // Anthropic type guards
  isTextBlock,
  isImageBlock,
  isToolUseBlock,
  isToolResultBlock,
  isThinkingBlock,
  isBase64ImageSource,
  isURLImageSource,
  // OpenAI Chat type guards
  isSystemMessage,
  isUserMessage,
  isAssistantMessage,
  isToolMessage,
  isTextPart,
  isImagePart,
  hasToolCalls,
  // OpenAI Responses type guards
  isInputMessage,
  isFunctionCall,
  isFunctionCallOutput,
  isMessageOutput,
  isFunctionCallOutput2,
  isReasoningOutput,
  isInputText,
  isInputImage,
  isOutputText,
  isRefusal,
  isFunctionTool
} from '../types'

describe('Anthropic Type Guards', () => {
  describe('isTextBlock', () => {
    it('should return true for text blocks', () => {
      expect(isTextBlock({ type: 'text', text: 'Hello' })).toBe(true)
    })

    it('should return false for non-text blocks', () => {
      expect(isTextBlock({ type: 'image', source: { type: 'url', url: 'http://...' } })).toBe(false)
    })
  })

  describe('isImageBlock', () => {
    it('should return true for image blocks', () => {
      expect(isImageBlock({ type: 'image', source: { type: 'url', url: 'http://...' } })).toBe(true)
    })

    it('should return false for non-image blocks', () => {
      expect(isImageBlock({ type: 'text', text: 'Hello' })).toBe(false)
    })
  })

  describe('isToolUseBlock', () => {
    it('should return true for tool_use blocks', () => {
      expect(isToolUseBlock({
        type: 'tool_use',
        id: 'call_123',
        name: 'test',
        input: {}
      })).toBe(true)
    })

    it('should return false for non-tool_use blocks', () => {
      expect(isToolUseBlock({ type: 'text', text: 'Hello' })).toBe(false)
    })
  })

  describe('isToolResultBlock', () => {
    it('should return true for tool_result blocks', () => {
      expect(isToolResultBlock({
        type: 'tool_result',
        tool_use_id: 'call_123',
        content: 'Result'
      })).toBe(true)
    })

    it('should return false for non-tool_result blocks', () => {
      expect(isToolResultBlock({ type: 'text', text: 'Hello' })).toBe(false)
    })
  })

  describe('isThinkingBlock', () => {
    it('should return true for thinking blocks', () => {
      expect(isThinkingBlock({ type: 'thinking', thinking: 'Let me think...' })).toBe(true)
    })

    it('should return false for non-thinking blocks', () => {
      expect(isThinkingBlock({ type: 'text', text: 'Hello' })).toBe(false)
    })
  })

  describe('isBase64ImageSource', () => {
    it('should return true for base64 sources', () => {
      expect(isBase64ImageSource({
        type: 'base64',
        media_type: 'image/png',
        data: 'abc123'
      })).toBe(true)
    })

    it('should return false for URL sources', () => {
      expect(isBase64ImageSource({ type: 'url', url: 'http://...' })).toBe(false)
    })
  })

  describe('isURLImageSource', () => {
    it('should return true for URL sources', () => {
      expect(isURLImageSource({ type: 'url', url: 'http://...' })).toBe(true)
    })

    it('should return false for base64 sources', () => {
      expect(isURLImageSource({
        type: 'base64',
        media_type: 'image/png',
        data: 'abc123'
      })).toBe(false)
    })
  })
})

describe('OpenAI Chat Type Guards', () => {
  describe('isSystemMessage', () => {
    it('should return true for system messages', () => {
      expect(isSystemMessage({ role: 'system', content: 'You are helpful' })).toBe(true)
    })

    it('should return false for non-system messages', () => {
      expect(isSystemMessage({ role: 'user', content: 'Hello' })).toBe(false)
    })
  })

  describe('isUserMessage', () => {
    it('should return true for user messages', () => {
      expect(isUserMessage({ role: 'user', content: 'Hello' })).toBe(true)
    })

    it('should return false for non-user messages', () => {
      expect(isUserMessage({ role: 'assistant', content: 'Hi' })).toBe(false)
    })
  })

  describe('isAssistantMessage', () => {
    it('should return true for assistant messages', () => {
      expect(isAssistantMessage({ role: 'assistant', content: 'Hi' })).toBe(true)
    })

    it('should return false for non-assistant messages', () => {
      expect(isAssistantMessage({ role: 'user', content: 'Hello' })).toBe(false)
    })
  })

  describe('isToolMessage', () => {
    it('should return true for tool messages', () => {
      expect(isToolMessage({
        role: 'tool',
        content: 'Result',
        tool_call_id: 'call_123'
      })).toBe(true)
    })

    it('should return false for non-tool messages', () => {
      expect(isToolMessage({ role: 'user', content: 'Hello' })).toBe(false)
    })
  })

  describe('isTextPart', () => {
    it('should return true for text parts', () => {
      expect(isTextPart({ type: 'text', text: 'Hello' })).toBe(true)
    })

    it('should return false for image parts', () => {
      expect(isTextPart({ type: 'image_url', image_url: { url: 'http://...' } })).toBe(false)
    })
  })

  describe('isImagePart', () => {
    it('should return true for image parts', () => {
      expect(isImagePart({ type: 'image_url', image_url: { url: 'http://...' } })).toBe(true)
    })

    it('should return false for text parts', () => {
      expect(isImagePart({ type: 'text', text: 'Hello' })).toBe(false)
    })
  })

  describe('hasToolCalls', () => {
    it('should return true when tool_calls exist', () => {
      expect(hasToolCalls({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }]
      })).toBe(true)
    })

    it('should return false when no tool_calls', () => {
      expect(hasToolCalls({ role: 'assistant', content: 'Hello' })).toBe(false)
    })

    it('should return false for empty tool_calls', () => {
      expect(hasToolCalls({ role: 'assistant', content: null, tool_calls: [] })).toBe(false)
    })
  })
})

describe('OpenAI Responses Type Guards', () => {
  describe('isInputMessage', () => {
    it('should return true for input messages', () => {
      expect(isInputMessage({ role: 'user', content: 'Hello' })).toBe(true)
    })

    it('should return false for function calls', () => {
      expect(isInputMessage({
        type: 'function_call',
        call_id: '123',
        name: 'test',
        arguments: '{}'
      })).toBe(false)
    })
  })

  describe('isFunctionCall', () => {
    it('should return true for function calls', () => {
      expect(isFunctionCall({
        type: 'function_call',
        call_id: '123',
        name: 'test',
        arguments: '{}'
      })).toBe(true)
    })

    it('should return false for messages', () => {
      expect(isFunctionCall({ role: 'user', content: 'Hello' })).toBe(false)
    })
  })

  describe('isFunctionCallOutput', () => {
    it('should return true for function call outputs', () => {
      expect(isFunctionCallOutput({
        type: 'function_call_output',
        call_id: '123',
        output: 'Result'
      })).toBe(true)
    })

    it('should return false for function calls', () => {
      expect(isFunctionCallOutput({
        type: 'function_call',
        call_id: '123',
        name: 'test',
        arguments: '{}'
      })).toBe(false)
    })
  })

  describe('isMessageOutput', () => {
    it('should return true for message outputs', () => {
      expect(isMessageOutput({
        id: '1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: []
      })).toBe(true)
    })

    it('should return false for function call outputs', () => {
      expect(isMessageOutput({
        id: '1',
        type: 'function_call',
        status: 'completed',
        name: 'test',
        call_id: '123',
        arguments: '{}'
      })).toBe(false)
    })
  })

  describe('isReasoningOutput', () => {
    it('should return true for reasoning outputs', () => {
      expect(isReasoningOutput({
        id: '1',
        type: 'reasoning',
        status: 'completed'
      })).toBe(true)
    })

    it('should return false for message outputs', () => {
      expect(isReasoningOutput({
        id: '1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: []
      })).toBe(false)
    })
  })

  describe('isInputText', () => {
    it('should return true for input_text', () => {
      expect(isInputText({ type: 'input_text', text: 'Hello' })).toBe(true)
    })

    it('should return false for input_image', () => {
      expect(isInputText({ type: 'input_image', image_url: 'http://...' })).toBe(false)
    })
  })

  describe('isOutputText', () => {
    it('should return true for output_text', () => {
      expect(isOutputText({ type: 'output_text', text: 'Hello' })).toBe(true)
    })

    it('should return false for refusal', () => {
      expect(isOutputText({ type: 'refusal', refusal: 'Cannot comply' })).toBe(false)
    })
  })

  describe('isRefusal', () => {
    it('should return true for refusal', () => {
      expect(isRefusal({ type: 'refusal', refusal: 'Cannot comply' })).toBe(true)
    })

    it('should return false for output_text', () => {
      expect(isRefusal({ type: 'output_text', text: 'Hello' })).toBe(false)
    })
  })

  describe('isFunctionTool', () => {
    it('should return true for function tools', () => {
      expect(isFunctionTool({
        type: 'function',
        name: 'test',
        parameters: { type: 'object', properties: {} }
      })).toBe(true)
    })

    it('should return false for other tools', () => {
      expect(isFunctionTool({ type: 'web_search' })).toBe(false)
    })
  })
})
