/**
 * Unit Tests for Server Components
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getApiTypeFromUrl,
  isValidEndpointUrl,
  getEndpointUrlError,
  shouldForceStream
} from '../../../src/main/openai-compat-router/server/api-type'

describe('API Type Resolution', () => {
  describe('getApiTypeFromUrl', () => {
    it('should return chat_completions for URLs ending with /chat/completions', () => {
      expect(getApiTypeFromUrl('https://api.openai.com/v1/chat/completions')).toBe('chat_completions')
      expect(getApiTypeFromUrl('https://openrouter.ai/api/v1/chat/completions')).toBe('chat_completions')
      expect(getApiTypeFromUrl('http://localhost:8080/chat/completions')).toBe('chat_completions')
    })

    it('should return responses for URLs ending with /responses', () => {
      expect(getApiTypeFromUrl('https://api.openai.com/v1/responses')).toBe('responses')
      expect(getApiTypeFromUrl('https://openrouter.ai/api/v1/responses')).toBe('responses')
      expect(getApiTypeFromUrl('http://localhost:8080/responses')).toBe('responses')
    })

    it('should return null for URLs without valid endpoint suffix', () => {
      expect(getApiTypeFromUrl('https://api.openai.com')).toBeNull()
      expect(getApiTypeFromUrl('https://api.openai.com/v1')).toBeNull()
      expect(getApiTypeFromUrl('https://api.openai.com/v1/models')).toBeNull()
      expect(getApiTypeFromUrl('https://api.openai.com/chat/completions/extra')).toBeNull()
    })
  })

  describe('isValidEndpointUrl', () => {
    it('should return true for valid endpoint URLs', () => {
      expect(isValidEndpointUrl('https://api.openai.com/v1/chat/completions')).toBe(true)
      expect(isValidEndpointUrl('https://api.openai.com/v1/responses')).toBe(true)
    })

    it('should return false for invalid endpoint URLs', () => {
      expect(isValidEndpointUrl('https://api.openai.com')).toBe(false)
      expect(isValidEndpointUrl('https://api.openai.com/v1')).toBe(false)
    })
  })

  describe('getEndpointUrlError', () => {
    it('should include the invalid URL in error message', () => {
      const error = getEndpointUrlError('https://invalid.url')
      expect(error).toContain('https://invalid.url')
      expect(error).toContain('/chat/completions')
      expect(error).toContain('/responses')
    })
  })

  describe('shouldForceStream', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
      delete process.env.HALO_OPENAI_FORCE_STREAM
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should return false when not set', () => {
      expect(shouldForceStream()).toBe(false)
    })

    it('should return true for "1"', () => {
      process.env.HALO_OPENAI_FORCE_STREAM = '1'
      expect(shouldForceStream()).toBe(true)
    })

    it('should return true for "true"', () => {
      process.env.HALO_OPENAI_FORCE_STREAM = 'true'
      expect(shouldForceStream()).toBe(true)
    })

    it('should return true for "yes"', () => {
      process.env.HALO_OPENAI_FORCE_STREAM = 'yes'
      expect(shouldForceStream()).toBe(true)
    })

    it('should return false for other values', () => {
      process.env.HALO_OPENAI_FORCE_STREAM = 'false'
      expect(shouldForceStream()).toBe(false)
    })
  })
})
