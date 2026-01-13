/**
 * Unit Tests for Server Components
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getApiTypeFromUrl,
  isValidEndpointUrl,
  getEndpointUrlError,
  shouldForceStream
} from '../server/api-type'
import {
  withRequestQueue,
  generateQueueKey,
  clearRequestQueues,
  getPendingRequestCount
} from '../server/request-queue'

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

describe('Request Queue', () => {
  beforeEach(() => {
    clearRequestQueues()
  })

  afterEach(() => {
    clearRequestQueues()
  })

  describe('generateQueueKey', () => {
    it('should generate a key from URL and API key', () => {
      const key = generateQueueKey('https://api.example.com', 'sk-1234567890abcdef')
      // slice(0, 16) returns first 16 chars: 'sk-1234567890abc'
      expect(key).toBe('https://api.example.com:sk-1234567890abc')
    })

    it('should handle short API keys', () => {
      const key = generateQueueKey('https://api.example.com', 'sk-short')
      expect(key).toBe('https://api.example.com:sk-short')
    })
  })

  describe('withRequestQueue', () => {
    it('should execute function and return result', async () => {
      const result = await withRequestQueue('test-key', async () => {
        return 42
      })
      expect(result).toBe(42)
    })

    it('should serialize requests with same key', async () => {
      const order: number[] = []

      const promise1 = withRequestQueue('same-key', async () => {
        order.push(1)
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push(2)
        return 'first'
      })

      const promise2 = withRequestQueue('same-key', async () => {
        order.push(3)
        return 'second'
      })

      const [result1, result2] = await Promise.all([promise1, promise2])

      expect(result1).toBe('first')
      expect(result2).toBe('second')
      // Second request should wait for first to complete
      expect(order).toEqual([1, 2, 3])
    })

    it('should allow parallel requests with different keys', async () => {
      const order: string[] = []

      const promise1 = withRequestQueue('key-a', async () => {
        order.push('a-start')
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push('a-end')
        return 'a'
      })

      const promise2 = withRequestQueue('key-b', async () => {
        order.push('b-start')
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('b-end')
        return 'b'
      })

      await Promise.all([promise1, promise2])

      // Both should start immediately (parallel)
      expect(order.indexOf('a-start')).toBeLessThanOrEqual(1)
      expect(order.indexOf('b-start')).toBeLessThanOrEqual(1)
    })

    it('should handle errors without blocking subsequent requests', async () => {
      const promise1 = withRequestQueue('error-key', async () => {
        throw new Error('Test error')
      }).catch(() => 'caught')

      const promise2 = withRequestQueue('error-key', async () => {
        return 'success'
      })

      const [result1, result2] = await Promise.all([promise1, promise2])

      expect(result1).toBe('caught')
      expect(result2).toBe('success')
    })
  })

  describe('getPendingRequestCount', () => {
    it('should return 0 when no pending requests', () => {
      expect(getPendingRequestCount()).toBe(0)
    })

    it('should track pending requests', async () => {
      let resolvePromise: () => void
      const promise = withRequestQueue('counting-key', async () => {
        await new Promise<void>((resolve) => {
          resolvePromise = resolve
        })
        return 'done'
      })

      // Give time for the request to start
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(getPendingRequestCount()).toBe(1)

      resolvePromise!()
      await promise

      expect(getPendingRequestCount()).toBe(0)
    })
  })
})
