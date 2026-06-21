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
  normalizeApiUrl,
  isNativeAnthropicHost,
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

describe('normalizeApiUrl', () => {
  describe("provider: 'openai'", () => {
    it('appends /v1/chat/completions to host-only URL', () => {
      expect(normalizeApiUrl('https://api.openai.com', 'openai'))
        .toBe('https://api.openai.com/v1/chat/completions')
    })

    it('strips trailing slash before appending', () => {
      expect(normalizeApiUrl('https://api.openai.com/', 'openai'))
        .toBe('https://api.openai.com/v1/chat/completions')
    })

    it('preserves URL already ending with /chat/completions', () => {
      expect(normalizeApiUrl('https://api.openai.com/v1/chat/completions', 'openai'))
        .toBe('https://api.openai.com/v1/chat/completions')
    })

    it('preserves URL already ending with /responses', () => {
      expect(normalizeApiUrl('https://api.openai.com/v1/responses', 'openai'))
        .toBe('https://api.openai.com/v1/responses')
    })

    it('completes URL ending with /v1', () => {
      expect(normalizeApiUrl('https://api.openai.com/v1', 'openai'))
        .toBe('https://api.openai.com/v1/chat/completions')
    })
  })

  describe("provider: 'anthropic'", () => {
    it('returns base URL untouched (Claude SDK appends /v1/messages natively)', () => {
      expect(normalizeApiUrl('https://api.anthropic.com', 'anthropic'))
        .toBe('https://api.anthropic.com')
    })

    it('trims trailing slash', () => {
      expect(normalizeApiUrl('https://api.anthropic.com/', 'anthropic'))
        .toBe('https://api.anthropic.com')
    })
  })

  describe("provider: 'anthropic_passthrough'", () => {
    // A bare gateway URL must gain /v1/messages; gateways that only expose
    // that path return 405 when POSTed to the root.
    it('appends /v1/messages to bare gateway URL', () => {
      expect(normalizeApiUrl('http://203.0.113.10/public', 'anthropic_passthrough'))
        .toBe('http://203.0.113.10/public/v1/messages')
    })

    it('strips trailing slash before appending', () => {
      expect(normalizeApiUrl('http://203.0.113.10/public/', 'anthropic_passthrough'))
        .toBe('http://203.0.113.10/public/v1/messages')
    })

    it('preserves URL already ending with /v1/messages', () => {
      expect(normalizeApiUrl('https://api.anthropic.com/v1/messages', 'anthropic_passthrough'))
        .toBe('https://api.anthropic.com/v1/messages')
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

describe('isNativeAnthropicHost', () => {
  it('matches the first-party Anthropic API host (API key and OAuth)', () => {
    expect(isNativeAnthropicHost('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isNativeAnthropicHost('https://api.anthropic.com/v1/messages?beta=true')).toBe(true)
  })

  it('rejects third-party Anthropic-compatible hosts (keep repair pipeline)', () => {
    expect(isNativeAnthropicHost('https://open.bigmodel.cn/api/anthropic/v1/messages')).toBe(false)
    expect(isNativeAnthropicHost('https://example.com/v1/messages')).toBe(false)
  })

  it('does not match look-alike subdomains or hosts containing the name', () => {
    expect(isNativeAnthropicHost('https://api.anthropic.com.evil.test/v1/messages')).toBe(false)
    expect(isNativeAnthropicHost('https://proxy.api.anthropic.com/v1/messages')).toBe(false)
  })

  it('treats unparseable URLs as non-native (safe default)', () => {
    expect(isNativeAnthropicHost('not a url')).toBe(false)
    expect(isNativeAnthropicHost('')).toBe(false)
  })
})
