/**
 * Zhipu GLM Coding Plan OAuth Provider — Unit Tests
 *
 * Locks the load-bearing backend-config contract: the coding-plan key must route
 * to the OpenAI-compatible coding endpoint (`/api/coding/paas/v4/chat/completions`)
 * as a Bearer token, which the router adds when the provider omits an
 * `Authorization` header. The generic `/api/anthropic` endpoint does not draw
 * from the plan, so it must not be used.
 */

import { describe, it, expect } from 'vitest'
import { getZhipuCodingOAuthProvider } from '../../../src/main/services/ai-sources/providers/zhipu-coding-oauth.provider'
import type { AISourcesConfig } from '../../../src/shared/types'

const PROVIDER = 'zhipu-coding-oauth'

/** Build the legacy v1 config shape the manager passes to provider methods. */
function cfg(slice: unknown): AISourcesConfig {
  return { [PROVIDER]: slice } as unknown as AISourcesConfig
}

describe('ZhipuCodingOAuthProvider', () => {
  const provider = getZhipuCodingOAuthProvider()

  it('exposes the zhipu-coding-oauth type', () => {
    expect(provider.type).toBe(PROVIDER)
  })

  describe('isConfigured', () => {
    it('is false without a logged-in token', () => {
      expect(provider.isConfigured(cfg(undefined))).toBe(false)
      expect(provider.isConfigured(cfg({ loggedIn: false }))).toBe(false)
      expect(provider.isConfigured(cfg({ loggedIn: true }))).toBe(false)
    })

    it('is true with a minted key', () => {
      expect(provider.isConfigured(cfg({ loggedIn: true, accessToken: 'abc.def' }))).toBe(true)
    })
  })

  describe('getBackendConfig', () => {
    it('returns null when not configured', () => {
      expect(provider.getBackendConfig(cfg(undefined))).toBeNull()
      expect(provider.getBackendConfig(cfg({ loggedIn: true }))).toBeNull()
    })

    it('routes to the OpenAI-compatible coding endpoint via chat_completions', () => {
      const bc = provider.getBackendConfig(cfg({ loggedIn: true, accessToken: 'abc.def', model: 'glm-4.6' }))
      expect(bc).not.toBeNull()
      expect(bc!.url).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
      expect(bc!.apiType).toBe('chat_completions')
      expect(bc!.key).toBe('abc.def')
      expect(bc!.model).toBe('glm-4.6')
    })

    it('never injects an Authorization header (so the router adds Bearer)', () => {
      const bc = provider.getBackendConfig(cfg({ loggedIn: true, accessToken: 'k', model: 'glm-5.2' }))
      const hasAuth = bc!.headers && Object.keys(bc!.headers).some(h => h.toLowerCase() === 'authorization')
      expect(hasAuth).toBeFalsy()
    })

    it('falls back to the default model when none is selected', () => {
      const bc = provider.getBackendConfig(cfg({ loggedIn: true, accessToken: 'k' }))
      expect(bc!.model).toBe('glm-4.6')
    })
  })

  describe('models', () => {
    it('lists the GLM coding-plan catalog', async () => {
      const models = await provider.getAvailableModels(cfg(undefined))
      expect(models).toContain('glm-4.6')
      expect(models).toContain('glm-5.2')
    })

    it('reports the current model from config', () => {
      expect(provider.getCurrentModel(cfg({ loggedIn: true, accessToken: 'k', model: 'glm-5.1' }))).toBe('glm-5.1')
      expect(provider.getCurrentModel(cfg(undefined))).toBeNull()
    })
  })

  describe('token management', () => {
    it('treats the minted key as long-lived (never needs refresh)', () => {
      const status = provider.checkTokenWithConfig(cfg({ loggedIn: true, accessToken: 'k' }))
      expect(status.valid).toBe(true)
      expect(status.needsRefresh).toBe(false)
    })

    it('does not implement refreshTokenWithConfig (so the manager skips refresh)', () => {
      expect((provider as unknown as Record<string, unknown>).refreshTokenWithConfig).toBeUndefined()
    })
  })
})
