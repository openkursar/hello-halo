/**
 * Unit tests for `resolveUserAgent` — the pure resolver extracted from
 * browser-view.service.ts so it can be tested without an Electron runtime.
 *
 * Issue #124: the embedded AI Browser must honor a user-configured custom
 * User-Agent string before falling back to the built-in desktop/mobile UAs.
 */

import { describe, it, expect } from 'vitest'
import { resolveUserAgent, CHROME_USER_AGENT, H5_USER_AGENT } from '../../../src/main/services/user-agent-resolver'

describe('resolveUserAgent (issue #124)', () => {
  describe('custom User-Agent takes priority', () => {
    it('returns the custom UA when set, regardless of device mode (pc)', () => {
      const custom = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      expect(resolveUserAgent(custom, 'pc')).toBe(custom)
    })

    it('returns the custom UA when set, regardless of device mode (h5)', () => {
      const custom = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      expect(resolveUserAgent(custom, 'h5')).toBe(custom)
    })

    it('trims surrounding whitespace from the custom UA', () => {
      const custom = '  Mozilla/5.0 (X11; Linux x86_64)  '
      expect(resolveUserAgent(custom, 'pc')).toBe('Mozilla/5.0 (X11; Linux x86_64)')
    })
  })

  describe('falls back to built-in UAs when custom is absent', () => {
    it('uses CHROME_USER_AGENT for pc mode when custom is undefined', () => {
      expect(resolveUserAgent(undefined, 'pc')).toBe(CHROME_USER_AGENT)
    })

    it('uses H5_USER_AGENT for h5 mode when custom is undefined', () => {
      expect(resolveUserAgent(undefined, 'h5')).toBe(H5_USER_AGENT)
    })

    it('uses CHROME_USER_AGENT when custom is an empty string', () => {
      expect(resolveUserAgent('', 'pc')).toBe(CHROME_USER_AGENT)
    })

    it('uses H5_USER_AGENT when custom is an empty string', () => {
      expect(resolveUserAgent('', 'h5')).toBe(H5_USER_AGENT)
    })

    it('falls back to CHROME_USER_AGENT when custom is only whitespace (pc)', () => {
      expect(resolveUserAgent('   \t  ', 'pc')).toBe(CHROME_USER_AGENT)
    })

    it('falls back to H5_USER_AGENT when custom is only whitespace (h5)', () => {
      expect(resolveUserAgent('   \t  ', 'h5')).toBe(H5_USER_AGENT)
    })
  })
})
