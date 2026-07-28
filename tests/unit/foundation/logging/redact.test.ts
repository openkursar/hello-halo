/**
 * Logging redaction unit tests.
 *
 * Covers redactSecrets pattern masking, /g lastIndex safety, redactHeaders
 * case-insensitivity, and truncateField boundary behavior.
 */

import { describe, it, expect } from 'vitest'

import { redactHeaders, redactSecrets, truncateField } from '../../../../src/main/foundation/logging/redact'

describe('redact', () => {
  describe('redactSecrets', () => {
    it('masks Anthropic sk-ant- keys', () => {
      const text = 'key=sk-ant-' + 'a'.repeat(25) + ' end'
      expect(redactSecrets(text)).toBe('key=[REDACTED] end')
    })

    it('masks OpenAI-style sk- keys', () => {
      const text = 'token sk-' + 'B'.repeat(30)
      expect(redactSecrets(text)).toBe('token [REDACTED]')
    })

    it('masks inline Bearer tokens case-insensitively', () => {
      const text = 'bearer ' + 'x'.repeat(25)
      expect(redactSecrets(text)).toBe('[REDACTED]')
    })

    it('masks 40+ char hex tokens', () => {
      const hex = 'a'.repeat(40)
      expect(redactSecrets(`oauth=${hex}`)).toBe('oauth=[REDACTED]')
    })

    it('leaves non-secret text untouched', () => {
      const text = 'just a normal log line with sk-short and 1234'
      expect(redactSecrets(text)).toBe(text)
    })

    it('is stable across repeated calls (/g lastIndex reset)', () => {
      const text = 'sk-' + 'C'.repeat(30) + ' and sk-' + 'D'.repeat(30)
      const first = redactSecrets(text)
      const second = redactSecrets(text)
      expect(first).toBe(second)
      expect(first).toBe('[REDACTED] and [REDACTED]')
    })
  })

  describe('redactHeaders', () => {
    it('redacts secret headers regardless of case', () => {
      const result = redactHeaders({
        Authorization: 'Bearer abc',
        'X-Api-Key': 'sk-123',
        COOKIE: 'session=1',
        'Set-Cookie': 'a=b',
        'Proxy-Authorization': 'Basic xyz',
      })
      expect(result.Authorization).toBe('[REDACTED]')
      expect(result['X-Api-Key']).toBe('[REDACTED]')
      expect(result.COOKIE).toBe('[REDACTED]')
      expect(result['Set-Cookie']).toBe('[REDACTED]')
      expect(result['Proxy-Authorization']).toBe('[REDACTED]')
    })

    it('preserves non-secret headers', () => {
      const result = redactHeaders({
        'Content-Type': 'application/json',
        'User-Agent': 'halo',
      })
      expect(result['Content-Type']).toBe('application/json')
      expect(result['User-Agent']).toBe('halo')
    })

    it('does not mutate the input object', () => {
      const input = { Authorization: 'secret' }
      redactHeaders(input)
      expect(input.Authorization).toBe('secret')
    })
  })

  describe('truncateField', () => {
    it('returns the original string at the boundary', () => {
      const value = 'x'.repeat(2048)
      expect(truncateField(value)).toBe(value)
    })

    it('truncates one byte over the boundary', () => {
      const value = 'x'.repeat(2049)
      const result = truncateField(value)
      expect(result.startsWith('x'.repeat(2048))).toBe(true)
      expect(result).toContain('truncated, total 2049 chars')
    })

    it('honors a custom maxBytes', () => {
      expect(truncateField('abcdef', 3)).toBe('abc…(truncated, total 6 chars)')
      expect(truncateField('abc', 3)).toBe('abc')
    })
  })
})
