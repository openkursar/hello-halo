/**
 * Provider Adapters Unit Tests
 */

import { describe, it, expect } from 'vitest'
import {
  findAdapter,
  deepSeekAdapter,
  groqAdapter,
  openRouterAdapter,
  orcaRouterAdapter,
  moonshotAdapter,
  zhipuAdapter
} from '../../../src/main/openai-compat-router/server/provider-adapters'

// ============================================================================
// DeepSeek Adapter
// ============================================================================

describe('deepSeekAdapter', () => {
  describe('match', () => {
    it('matches api.deepseek.com URLs', () => {
      expect(deepSeekAdapter.match('https://api.deepseek.com/v1')).toBe(true)
      expect(deepSeekAdapter.match('https://api.deepseek.com/v1/chat/completions')).toBe(true)
    })

    it('does not match other URLs', () => {
      expect(deepSeekAdapter.match('https://api.openai.com/v1')).toBe(false)
      expect(deepSeekAdapter.match('https://openrouter.ai/api/v1')).toBe(false)
    })
  })

  it('has no transformRequest (reasoning_content handled at converter layer)', () => {
    expect(deepSeekAdapter.transformRequest).toBeUndefined()
  })
})

// ============================================================================
// Moonshot Adapter
// ============================================================================

describe('moonshotAdapter', () => {
  describe('match', () => {
    it('matches api.moonshot.cn URLs', () => {
      expect(moonshotAdapter.match('https://api.moonshot.cn/v1')).toBe(true)
      expect(moonshotAdapter.match('https://api.moonshot.cn/v1/chat/completions')).toBe(true)
    })

    it('matches api.moonshot.ai URLs', () => {
      expect(moonshotAdapter.match('https://api.moonshot.ai/v1')).toBe(true)
    })

    it('does not match other URLs', () => {
      expect(moonshotAdapter.match('https://api.deepseek.com/v1')).toBe(false)
      expect(moonshotAdapter.match('https://api.openai.com/v1')).toBe(false)
    })
  })

  it('has no transformRequest (reasoning_content handled at converter layer)', () => {
    expect(moonshotAdapter.transformRequest).toBeUndefined()
  })
})

// ============================================================================
// Zhipu AI (GLM) Adapter
// ============================================================================

describe('zhipuAdapter', () => {
  describe('match', () => {
    it('matches open.bigmodel.cn URLs', () => {
      expect(zhipuAdapter.match('https://open.bigmodel.cn/api/paas/v4')).toBe(true)
      expect(zhipuAdapter.match('https://open.bigmodel.cn/api/paas/v4/chat/completions')).toBe(true)
    })

    it('does not match other URLs', () => {
      expect(zhipuAdapter.match('https://api.deepseek.com/v1')).toBe(false)
      expect(zhipuAdapter.match('https://api.moonshot.cn/v1')).toBe(false)
    })
  })

  it('has no transformRequest (reasoning_content handled at converter layer)', () => {
    expect(zhipuAdapter.transformRequest).toBeUndefined()
  })
})

// ============================================================================
// Groq Adapter
// ============================================================================

describe('groqAdapter', () => {
  it('converts temperature 0 to 0.01', () => {
    const body: Record<string, unknown> = { temperature: 0 }
    groqAdapter.transformRequest!(body)
    expect(body.temperature).toBe(0.01)
  })

  it('leaves non-zero temperature unchanged', () => {
    const body: Record<string, unknown> = { temperature: 0.7 }
    groqAdapter.transformRequest!(body)
    expect(body.temperature).toBe(0.7)
  })
})

// ============================================================================
// findAdapter
// ============================================================================

describe('findAdapter', () => {
  it('finds deepseek adapter by URL', () => {
    const adapter = findAdapter('https://api.deepseek.com/v1')
    expect(adapter?.id).toBe('deepseek')
  })

  it('finds deepseek adapter by explicit adapterId', () => {
    const adapter = findAdapter('https://some-third-party.com/v1', 'deepseek')
    expect(adapter?.id).toBe('deepseek')
  })

  it('finds moonshot adapter by URL (cn)', () => {
    const adapter = findAdapter('https://api.moonshot.cn/v1')
    expect(adapter?.id).toBe('moonshot')
  })

  it('finds moonshot adapter by URL (ai)', () => {
    const adapter = findAdapter('https://api.moonshot.ai/v1')
    expect(adapter?.id).toBe('moonshot')
  })

  it('finds moonshot adapter by explicit adapterId', () => {
    const adapter = findAdapter('https://some-third-party.com/v1', 'moonshot')
    expect(adapter?.id).toBe('moonshot')
  })

  it('finds zhipu adapter by URL', () => {
    const adapter = findAdapter('https://open.bigmodel.cn/api/paas/v4')
    expect(adapter?.id).toBe('zhipu')
  })

  it('finds zhipu adapter by explicit adapterId', () => {
    const adapter = findAdapter('https://some-proxy.com/v1', 'zhipu')
    expect(adapter?.id).toBe('zhipu')
  })

  it('finds groq adapter by URL', () => {
    const adapter = findAdapter('https://api.groq.com/openai/v1')
    expect(adapter?.id).toBe('groq')
  })

  it('finds openrouter adapter by URL', () => {
    const adapter = findAdapter('https://openrouter.ai/api/v1')
    expect(adapter?.id).toBe('openrouter')
  })

  it('finds orcarouter adapter by URL', () => {
    const adapter = findAdapter('https://api.orcarouter.ai/v1')
    expect(adapter?.id).toBe('orcarouter')
  })

  it('attaches app attribution headers for the app', () => {
    expect(orcaRouterAdapter.getExtraHeaders?.()).toEqual({
      'HTTP-Referer': 'https://hello-halo.cc/',
      'X-Title': 'Halo'
    })
  })

  it('returns undefined for unknown URL without adapterId', () => {
    const adapter = findAdapter('https://unknown.example.com/v1')
    expect(adapter).toBeUndefined()
  })
})
