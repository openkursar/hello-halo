/**
 * env-config unit tests.
 *
 * Covers env-var override precedence for the service token and LLM source:
 * env wins over persisted, absent env preserves persisted / seeds default,
 * aiKey OR aiUrl triggers source build, provider→legacy mapping, and the
 * no-op path when nothing is set.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
]

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

  it('is a no-op when all env vars are absent and password persists', () => {
    setConfig({ remoteAccess: { password: 'keep-me' } })
    applyEnvConfig()
    expect((saveConfig as unknown as MockFn)).not.toHaveBeenCalled()
  })
})
