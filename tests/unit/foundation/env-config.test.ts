/**
 * env-config unit tests.
 *
 * Covers env-var override precedence for the service token and LLM source:
 * env wins over persisted, absent env preserves persisted / seeds default,
 * aiKey OR aiUrl triggers source build, provider→legacy mapping, the egress
 * proxy variables, and the no-op path when nothing is set.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('uuid', () => ({
  v4: () => 'fixed-uuid',
}))

import { getConfig, saveConfig } from '../../../src/main/foundation/config.service'
import { applyEnvConfig } from '../../../src/main/foundation/env-config'

type MockFn = ReturnType<typeof vi.fn>

const ENV_KEYS = [
  'HALO_REMOTE_PASSWORD',
  'HALO_AI_PROVIDER',
  'HALO_AI_API_URL',
  'HALO_AI_API_KEY',
  'HALO_AI_MODEL',
  'HALO_PROXY',
  'HALO_PROXY_ONLY',
  'HALO_NO_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
]

// The runner's own proxy variables come back after this file.
const inheritedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
afterAll(() => {
  for (const [k, v] of Object.entries(inheritedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function setConfig(cfg: Record<string, unknown>): void {
  ;(getConfig as unknown as MockFn).mockReturnValue(cfg)
}

describe('env-config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of ENV_KEYS) delete process.env[k]
  })

  describe('service token (HALO_REMOTE_PASSWORD)', () => {
    it('env password wins over persisted', () => {
      setConfig({ remoteAccess: { enabled: true, password: 'persisted' } })
      process.env.HALO_REMOTE_PASSWORD = 'from-env'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.remoteAccess.password).toBe('from-env')
      expect(saved.remoteAccess.enabled).toBe(true)
    })

    it('absent env + no persisted password → default', () => {
      setConfig({ remoteAccess: { enabled: true } })
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.remoteAccess.password).toBe('halo123')
    })

    it('absent env + existing persisted password → not clobbered', () => {
      setConfig({ remoteAccess: { enabled: true, password: 'keep-me' } })
      applyEnvConfig()
      expect((saveConfig as unknown as MockFn)).not.toHaveBeenCalled()
    })

    it('whitespace-only env is treated as absent', () => {
      setConfig({ remoteAccess: { password: 'keep-me' } })
      process.env.HALO_REMOTE_PASSWORD = '   '
      applyEnvConfig()
      expect((saveConfig as unknown as MockFn)).not.toHaveBeenCalled()
    })
  })

  describe('LLM source', () => {
    it('aiKey alone triggers a source build', () => {
      setConfig({ remoteAccess: { password: 'x' } })
      process.env.HALO_AI_API_KEY = 'sk-key'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.aiSources.currentId).toBe('fixed-uuid')
      expect(saved.aiSources.sources[0].apiKey).toBe('sk-key')
      expect(saved.aiSources.sources[0].apiUrl).toBe('https://api.anthropic.com')
    })

    it('keeps the env source id across restarts so conversations stay bound', () => {
      setConfig({
        remoteAccess: { password: 'x' },
        aiSources: { version: 2, currentId: 'kept-id', sources: [{ id: 'kept-id', name: 'anthropic (env)', createdAt: 'then' }] },
      })
      process.env.HALO_AI_API_KEY = 'sk-new'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.aiSources.currentId).toBe('kept-id')
      expect(saved.aiSources.sources[0]).toMatchObject({ id: 'kept-id', createdAt: 'then', apiKey: 'sk-new' })
    })

    it('a provider change starts a new env source', () => {
      setConfig({
        remoteAccess: { password: 'x' },
        aiSources: { version: 2, currentId: 'old-id', sources: [{ id: 'old-id', name: 'anthropic (env)', createdAt: 'then' }] },
      })
      process.env.HALO_AI_PROVIDER = 'openai'
      process.env.HALO_AI_API_KEY = 'sk-new'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.aiSources.sources[0].id).not.toBe('old-id')
      expect(saved.aiSources.sources[0].name).toBe('openai (env)')
    })

    it('aiUrl alone triggers a source build', () => {
      setConfig({ remoteAccess: { password: 'x' } })
      process.env.HALO_AI_API_URL = 'https://gw.example.com'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.aiSources.sources[0].apiUrl).toBe('https://gw.example.com')
      expect(saved.aiSources.sources[0].apiKey).toBe('')
    })

    it('maps provider openai → legacy api.provider openai', () => {
      setConfig({ remoteAccess: { password: 'x' } })
      process.env.HALO_AI_API_KEY = 'sk-key'
      process.env.HALO_AI_PROVIDER = 'openai'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.api.provider).toBe('openai')
    })

    it('maps provider anthropic → legacy api.provider anthropic', () => {
      setConfig({ remoteAccess: { password: 'x' } })
      process.env.HALO_AI_API_KEY = 'sk-key'
      process.env.HALO_AI_PROVIDER = 'anthropic'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.api.provider).toBe('anthropic')
    })

    it('maps any other provider → legacy api.provider custom', () => {
      setConfig({ remoteAccess: { password: 'x' } })
      process.env.HALO_AI_API_KEY = 'sk-key'
      process.env.HALO_AI_PROVIDER = 'gemini'
      applyEnvConfig()
      const saved = (saveConfig as unknown as MockFn).mock.calls[0][0]
      expect(saved.api.provider).toBe('custom')
      expect(saved.aiSources.sources[0].provider).toBe('gemini')
    })
  })

  describe('egress proxy', () => {
    function savedNetwork(): Record<string, unknown> | undefined {
      return (saveConfig as unknown as MockFn).mock.calls[0]?.[0]?.network
    }

    it('takes the proxy, the proxied-only hosts and the direct hosts, keeping other network settings', () => {
      setConfig({ remoteAccess: { password: 'x' }, network: { imUseProxy: false, noProxy: 'old.example.com' } })
      process.env.HALO_PROXY = 'http://proxy.example.com:3128'
      process.env.HALO_PROXY_ONLY = '*.weixin.qq.com, api.example.com ,'
      process.env.HALO_NO_PROXY = 'a.example.com, 10.0.0.0/8'
      applyEnvConfig()
      expect(savedNetwork()).toEqual({
        imUseProxy: false,
        proxy: 'http://proxy.example.com:3128',
        proxyOnly: ['*.weixin.qq.com', 'api.example.com'],
        noProxy: 'a.example.com,10.0.0.0/8',
      })
    })

    it('falls back to HTTPS_PROXY, then HTTP_PROXY', () => {
      setConfig({ remoteAccess: { password: 'x' } })
      process.env.HTTP_PROXY = 'http://http.example.com:3128'
      process.env.HTTPS_PROXY = 'http://https.example.com:3128'
      applyEnvConfig()
      expect(savedNetwork()).toEqual({ proxy: 'http://https.example.com:3128' })
    })

    it('reads "*" as proxying every host', () => {
      setConfig({ remoteAccess: { password: 'x' } })
      process.env.HALO_PROXY_ONLY = '*'
      applyEnvConfig()
      expect(savedNetwork()).toEqual({ proxyOnly: [] })
    })

    it('leaves the persisted network settings alone without proxy variables', () => {
      setConfig({ remoteAccess: { password: 'x' }, network: { proxyOnly: ['*.weixin.qq.com'] } })
      process.env.NO_PROXY = 'corp.example.com'
      applyEnvConfig()
      expect(saveConfig as unknown as MockFn).not.toHaveBeenCalled()
    })
  })

  it('is a no-op when all env vars are absent and password persists', () => {
    setConfig({ remoteAccess: { password: 'keep-me' } })
    applyEnvConfig()
    expect((saveConfig as unknown as MockFn)).not.toHaveBeenCalled()
  })
})
