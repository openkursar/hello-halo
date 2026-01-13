/**
 * Unit Tests for Utilities
 */

import { describe, it, expect } from 'vitest'
import {
  generateId,
  generateMessageId,
  generateToolUseId,
  generateToolCallId,
  encodeBackendConfig,
  decodeBackendConfig,
  normalizeOpenAIChatCompletionsUrl,
  normalizeOpenAIResponsesUrl,
  normalizeAnthropicMessagesUrl,
  safeJsonParse,
  deepClone,
  isNonEmptyString,
  isNonEmptyArray,
  extractTextContent,
  mapValue
} from '../utils'

describe('ID Generation', () => {
  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateId()
      const id2 = generateId()
      expect(id1).not.toBe(id2)
    })

    it('should use the provided prefix', () => {
      const id = generateId('test')
      expect(id.startsWith('test_')).toBe(true)
    })

    it('should generate ID without prefix when empty', () => {
      const id = generateId('')
      expect(id).not.toContain('undefined')
    })
  })

  describe('generateMessageId', () => {
    it('should generate IDs with msg_ prefix', () => {
      const id = generateMessageId()
      expect(id.startsWith('msg_')).toBe(true)
    })
  })

  describe('generateToolUseId', () => {
    it('should generate IDs with toolu_ prefix', () => {
      const id = generateToolUseId()
      expect(id.startsWith('toolu_')).toBe(true)
    })
  })

  describe('generateToolCallId', () => {
    it('should generate IDs with call_ prefix', () => {
      const id = generateToolCallId()
      expect(id.startsWith('call_')).toBe(true)
    })
  })
})

describe('Backend Config', () => {
  describe('encodeBackendConfig', () => {
    it('should encode config to base64', () => {
      const config = { url: 'https://api.example.com', key: 'sk-test' }
      const encoded = encodeBackendConfig(config)
      expect(typeof encoded).toBe('string')
      expect(encoded.length).toBeGreaterThan(0)
    })
  })

  describe('decodeBackendConfig', () => {
    it('should decode valid config', () => {
      const config = { url: 'https://api.example.com', key: 'sk-test', model: 'gpt-4' }
      const encoded = encodeBackendConfig(config)
      const decoded = decodeBackendConfig(encoded)

      expect(decoded).toEqual(config)
    })

    it('should return null for invalid base64', () => {
      const decoded = decodeBackendConfig('not-valid-base64!!!')
      expect(decoded).toBeNull()
    })

    it('should return null for invalid JSON', () => {
      const invalidJson = Buffer.from('not json').toString('base64')
      const decoded = decodeBackendConfig(invalidJson)
      expect(decoded).toBeNull()
    })

    it('should return null for config without required fields', () => {
      const incompleteConfig = Buffer.from(JSON.stringify({ url: 'test' })).toString('base64')
      const decoded = decodeBackendConfig(incompleteConfig)
      expect(decoded).toBeNull()
    })
  })
})

describe('URL Normalization', () => {
  describe('normalizeOpenAIChatCompletionsUrl', () => {
    it('should add /v1/chat/completions to base URL', () => {
      const result = normalizeOpenAIChatCompletionsUrl('https://api.openai.com')
      expect(result).toBe('https://api.openai.com/v1/chat/completions')
    })

    it('should handle URL with trailing slash', () => {
      const result = normalizeOpenAIChatCompletionsUrl('https://api.openai.com/')
      expect(result).toBe('https://api.openai.com/v1/chat/completions')
    })

    it('should not modify URL already ending with /chat/completions', () => {
      const result = normalizeOpenAIChatCompletionsUrl('https://api.openai.com/v1/chat/completions')
      expect(result).toBe('https://api.openai.com/v1/chat/completions')
    })

    it('should handle URL already ending with /v1', () => {
      const result = normalizeOpenAIChatCompletionsUrl('https://api.openai.com/v1')
      expect(result).toBe('https://api.openai.com/v1/chat/completions')
    })
  })

  describe('normalizeOpenAIResponsesUrl', () => {
    it('should add /v1/responses to base URL', () => {
      const result = normalizeOpenAIResponsesUrl('https://api.openai.com')
      expect(result).toBe('https://api.openai.com/v1/responses')
    })

    it('should not modify URL already ending with /responses', () => {
      const result = normalizeOpenAIResponsesUrl('https://api.openai.com/v1/responses')
      expect(result).toBe('https://api.openai.com/v1/responses')
    })
  })

  describe('normalizeAnthropicMessagesUrl', () => {
    it('should add /v1/messages to base URL', () => {
      const result = normalizeAnthropicMessagesUrl('https://api.anthropic.com')
      expect(result).toBe('https://api.anthropic.com/v1/messages')
    })
  })
})

describe('JSON Utilities', () => {
  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse('{"key": "value"}')
      expect(result).toEqual({ key: 'value' })
    })

    it('should return null for invalid JSON', () => {
      const result = safeJsonParse('not json')
      expect(result).toBeNull()
    })

    it('should return null for empty string', () => {
      const result = safeJsonParse('')
      expect(result).toBeNull()
    })
  })

  describe('deepClone', () => {
    it('should create a deep copy', () => {
      const original = { a: 1, b: { c: 2 } }
      const cloned = deepClone(original)

      expect(cloned).toEqual(original)
      expect(cloned).not.toBe(original)
      expect(cloned.b).not.toBe(original.b)
    })

    it('should handle arrays', () => {
      const original = [1, [2, 3]]
      const cloned = deepClone(original)

      expect(cloned).toEqual(original)
      expect(cloned[1]).not.toBe(original[1])
    })
  })
})

describe('Type Guards', () => {
  describe('isNonEmptyString', () => {
    it('should return true for non-empty strings', () => {
      expect(isNonEmptyString('hello')).toBe(true)
    })

    it('should return false for empty strings', () => {
      expect(isNonEmptyString('')).toBe(false)
    })

    it('should return false for non-strings', () => {
      expect(isNonEmptyString(null)).toBe(false)
      expect(isNonEmptyString(undefined)).toBe(false)
      expect(isNonEmptyString(123)).toBe(false)
    })
  })

  describe('isNonEmptyArray', () => {
    it('should return true for non-empty arrays', () => {
      expect(isNonEmptyArray([1, 2, 3])).toBe(true)
    })

    it('should return false for empty arrays', () => {
      expect(isNonEmptyArray([])).toBe(false)
    })

    it('should return false for non-arrays', () => {
      expect(isNonEmptyArray(null)).toBe(false)
      expect(isNonEmptyArray('array')).toBe(false)
    })
  })
})

describe('extractTextContent', () => {
  it('should return string content directly', () => {
    expect(extractTextContent('hello')).toBe('hello')
  })

  it('should return null for empty content', () => {
    expect(extractTextContent(null)).toBeNull()
    expect(extractTextContent(undefined)).toBeNull()
    expect(extractTextContent('')).toBeNull()
  })

  it('should extract text from array of parts', () => {
    const parts = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'World' }
    ]
    expect(extractTextContent(parts)).toBe('Hello World')
  })

  it('should handle mixed content array', () => {
    const parts = [
      'direct string',
      { type: 'text', text: ' and object' }
    ]
    expect(extractTextContent(parts)).toBe('direct string and object')
  })
})

describe('mapValue', () => {
  it('should map values using the lookup table', () => {
    const mapping = { a: 1, b: 2, c: 3 }
    expect(mapValue('a', mapping, 0)).toBe(1)
    expect(mapValue('b', mapping, 0)).toBe(2)
  })

  it('should return default for unmapped values', () => {
    const mapping = { a: 1 }
    expect(mapValue('z', mapping, 99)).toBe(99)
  })

  it('should return default for null/undefined', () => {
    const mapping = { a: 1 }
    expect(mapValue(null, mapping, 99)).toBe(99)
    expect(mapValue(undefined, mapping, 99)).toBe(99)
  })
})
