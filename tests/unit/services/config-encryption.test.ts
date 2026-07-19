/**
 * Config encryption + masking unit tests.
 *
 * Covers the four public functions in config-encryption.ts:
 *   encryptConfigFields / decryptConfigFields — at-rest envelope
 *   maskConfigFields — output masking
 *   unmaskSentinels — sentinel preservation on write
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

import { isCredentialAtRestSafe } from '../../../src/main/foundation/credential-safety'
import {
  encryptConfigFields,
  decryptConfigFields,
  maskConfigFields,
  unmaskSentinels,
  configHasUnmigratedCredentials,
  MASK_SENTINEL,
} from '../../../src/main/foundation/config-encryption'

type MockFn = ReturnType<typeof vi.fn>

function setProfile(gm: boolean): void {
  ;(isCredentialAtRestSafe as unknown as MockFn).mockReturnValue(gm)
}

function makeConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api: { provider: 'openai', apiKey: 'sk-test-123', apiUrl: '' },
    aiSources: {
      version: 2,
      currentId: 'src-1',
      sources: [
        {
          id: 'src-1',
          name: 'Test',
          provider: 'openai',
          apiKey: 'sk-source-key',
          accessToken: 'access-tok',
          refreshToken: 'refresh-tok',
          oauth: {
            accessToken: 'oauth-access',
            refreshToken: 'oauth-refresh',
          },
        },
      ],
    },
    remoteAccess: { enabled: true, port: 3847, password: '123456' },
    mcpServers: {
      myServer: {
        command: 'node',
        env: { API_KEY: 'mcp-secret', PYTHONPATH: '/usr/lib' },
        headers: { Authorization: 'Bearer mcp-tok' },
      },
    },
    notificationChannels: {
      email: { password: 'email-pass' },
      wecom: { secret: 'wecom-sec' },
      dingtalk: { appKey: 'dt-key', appSecret: 'dt-secret' },
      feishu: { appSecret: 'fs-secret' },
      webhook: { url: 'https://hook.example.com', secret: 'wh-secret' },
    },
    wecomBot: { secret: 'legacy-bot-sec' },
    ...overrides,
  }
}

describe('config-encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --------------------------------------------------------------------------
  // At-rest encryption
  // --------------------------------------------------------------------------

  describe('encryptConfigFields + decryptConfigFields', () => {
    it('is identity when credentialAtRestSafe is off (open-source default)', () => {
      setProfile(false)
      const config = makeConfig()
      const before = JSON.stringify(config)
      encryptConfigFields(config)
      expect(JSON.stringify(config)).toBe(before)
    })

    it('encrypts and decrypts all sensitive fields when credentialAtRestSafe is on', () => {
      setProfile(true)
      const config = makeConfig()
      const original = JSON.parse(JSON.stringify(config))

      encryptConfigFields(config)

      // Verify fields are encrypted (start with gmcred:v1:)
      expect((config.api as any).apiKey).toMatch(/^gmcred:v1:/)
      const src = (config.aiSources as any).sources[0]
      expect(src.apiKey).toMatch(/^gmcred:v1:/)
      expect(src.accessToken).toMatch(/^gmcred:v1:/)
      expect(src.refreshToken).toMatch(/^gmcred:v1:/)
      expect(src.oauth.accessToken).toMatch(/^gmcred:v1:/)
      expect(src.oauth.refreshToken).toMatch(/^gmcred:v1:/)

      // MCP env: only the sensitive key, not PYTHONPATH
      const mcp = (config.mcpServers as any).myServer
      expect(mcp.env.API_KEY).toMatch(/^gmcred:v1:/)
      expect(mcp.env.PYTHONPATH).toBe('/usr/lib')
      expect(mcp.headers.Authorization).toMatch(/^gmcred:v1:/)

      // Notification channels
      expect((config.notificationChannels as any).email.password).toMatch(/^gmcred:v1:/)
      expect((config.notificationChannels as any).wecom.secret).toMatch(/^gmcred:v1:/)
      expect((config.notificationChannels as any).dingtalk.appKey).toMatch(/^gmcred:v1:/)

      // Roundtrip
      decryptConfigFields(config)
      expect((config.api as any).apiKey).toBe(original.api.apiKey)
      expect(src.apiKey).toBe(original.aiSources.sources[0].apiKey)
      expect(mcp.env.API_KEY).toBe('mcp-secret')
      expect((config.notificationChannels as any).email.password).toBe('email-pass')
    })

    it('does not double-encrypt already-encrypted values on re-save', () => {
      setProfile(true)
      const config = makeConfig()
      encryptConfigFields(config)
      const firstPass = (config.api as any).apiKey
      encryptConfigFields(config)
      expect((config.api as any).apiKey).toBe(firstPass)
    })
  })

  // --------------------------------------------------------------------------
  // Migration detection
  // --------------------------------------------------------------------------

  describe('configHasUnmigratedCredentials', () => {
    it('is true when sensitive fields are still plaintext under at-rest mode', () => {
      setProfile(true)
      expect(configHasUnmigratedCredentials(makeConfig())).toBe(true)
    })

    it('is false once all sensitive fields are encrypted under the master key', () => {
      setProfile(true)
      const config = makeConfig()
      encryptConfigFields(config)
      expect(configHasUnmigratedCredentials(config)).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Output masking
  // --------------------------------------------------------------------------

  describe('maskConfigFields', () => {
    it('replaces all sensitive fields with *** in the returned clone', () => {
      setProfile(false)
      const config = makeConfig()
      const masked = maskConfigFields(config)

      expect((masked.api as any).apiKey).toBe(MASK_SENTINEL)
      const src = (masked.aiSources as any).sources[0]
      expect(src.apiKey).toBe(MASK_SENTINEL)
      expect(src.accessToken).toBe(MASK_SENTINEL)
      expect(src.refreshToken).toBe(MASK_SENTINEL)
      expect(src.oauth.accessToken).toBe(MASK_SENTINEL)
      expect(src.oauth.refreshToken).toBe(MASK_SENTINEL)

      // remoteAccess.password is also masked
      expect((masked.remoteAccess as any).password).toBe(MASK_SENTINEL)

      // MCP sensitive env masked, non-sensitive preserved
      expect((masked.mcpServers as any).myServer.env.API_KEY).toBe(MASK_SENTINEL)
      expect((masked.mcpServers as any).myServer.env.PYTHONPATH).toBe('/usr/lib')
      expect((masked.mcpServers as any).myServer.headers.Authorization).toBe(MASK_SENTINEL)

      // Notification channels
      expect((masked.notificationChannels as any).email.password).toBe(MASK_SENTINEL)
      expect((masked.notificationChannels as any).webhook.secret).toBe(MASK_SENTINEL)
      // webhook.url is NOT masked (it's an endpoint, not a credential)
      expect((masked.notificationChannels as any).webhook.url).toBe('https://hook.example.com')
    })

    it('does not mutate the original config object', () => {
      setProfile(false)
      const config = makeConfig()
      const originalApiKey = (config.api as any).apiKey
      maskConfigFields(config)
      expect((config.api as any).apiKey).toBe(originalApiKey)
    })

    it('handles absent optional sections without throwing', () => {
      const config = { api: { provider: 'openai', apiKey: '', apiUrl: '' } }
      expect(() => maskConfigFields(config as any)).not.toThrow()
    })
  })

  // --------------------------------------------------------------------------
  // Sentinel preservation
  // --------------------------------------------------------------------------

  describe('unmaskSentinels', () => {
    it('restores *** to the existing value for each sensitive field', () => {
      const existing = makeConfig()
      const incoming = makeConfig()

      // Simulate client sending *** for all sensitive fields
      ;(incoming.api as any).apiKey = MASK_SENTINEL
      ;(incoming.aiSources as any).sources[0].apiKey = MASK_SENTINEL
      ;(incoming.notificationChannels as any).email.password = MASK_SENTINEL
      ;(incoming.mcpServers as any).myServer.env.API_KEY = MASK_SENTINEL

      unmaskSentinels(incoming, existing)

      expect((incoming.api as any).apiKey).toBe('sk-test-123')
      expect((incoming.aiSources as any).sources[0].apiKey).toBe('sk-source-key')
      expect((incoming.notificationChannels as any).email.password).toBe('email-pass')
      expect((incoming.mcpServers as any).myServer.env.API_KEY).toBe('mcp-secret')
    })

    it('preserves explicitly-changed values (not ***)', () => {
      const existing = makeConfig()
      const incoming = makeConfig()
      ;(incoming.api as any).apiKey = 'sk-new-key'

      unmaskSentinels(incoming, existing)

      expect((incoming.api as any).apiKey).toBe('sk-new-key')
    })

    it('does not cross-contaminate between array sources', () => {
      const existing = makeConfig()
      ;(existing.aiSources as any).sources.push({
        id: 'src-2',
        name: 'Other',
        provider: 'anthropic',
        apiKey: 'sk-other-key',
      })

      const incoming = JSON.parse(JSON.stringify(existing))
      ;(incoming.aiSources as any).sources[0].apiKey = MASK_SENTINEL
      ;(incoming.aiSources as any).sources[1].apiKey = MASK_SENTINEL

      unmaskSentinels(incoming, existing)

      expect((incoming.aiSources as any).sources[0].apiKey).toBe('sk-source-key')
      expect((incoming.aiSources as any).sources[1].apiKey).toBe('sk-other-key')
    })

    it('handles absent sections in incoming gracefully', () => {
      const existing = makeConfig()
      const incoming: Record<string, unknown> = { api: { provider: 'openai', apiKey: MASK_SENTINEL, apiUrl: '' } }

      expect(() => unmaskSentinels(incoming, existing)).not.toThrow()
      expect((incoming.api as any).apiKey).toBe('sk-test-123')
    })

    it('restores remoteAccess.password sentinel', () => {
      const existing = makeConfig()
      const incoming = makeConfig()
      ;(incoming.remoteAccess as any).password = MASK_SENTINEL

      unmaskSentinels(incoming, existing)

      expect((incoming.remoteAccess as any).password).toBe('123456')
    })

    // ── IM channel instances ───────────────────────────────────────
    // Bug #172: WeCom Bot Secret lost after restart. The frontend
    // (MessageChannelsSection.saveInstances) sends the full instances
    // array; unchanged instances carry `config.secret === '***'` from
    // getConfig(). unmaskSentinels must restore each by instance ID,
    // never persist the literal '***', and self-heal prior corruption.

    it('restores IM channel instance secrets by instance ID, not array index', () => {
      const existing = {
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: 'real-secret-a' } },
            { id: 'B', type: 'wecom-bot', config: { botId: 'aib-b', secret: 'real-secret-b' } },
          ],
        },
      }
      // Incoming array reordered [B, A] with both secrets masked.
      const incoming = {
        imChannels: {
          instances: [
            { id: 'B', type: 'wecom-bot', config: { botId: 'aib-b', secret: MASK_SENTINEL } },
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: MASK_SENTINEL } },
          ],
        },
      }

      unmaskSentinels(incoming as any, existing as any)

      const inc = (incoming.imChannels as any).instances
      expect(inc[0].config.secret).toBe('real-secret-b')
      expect(inc[1].config.secret).toBe('real-secret-a')
    })

    it('preserves a new IM channel instance real secret when prepended before existing masked instance', () => {
      const existing = {
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: 'real-secret-a' } },
          ],
        },
      }
      // Incoming: new B (real secret) prepended before A (masked).
      const incoming = {
        imChannels: {
          instances: [
            { id: 'B', type: 'wecom-bot', config: { botId: 'aib-b', secret: 'real-secret-b' } },
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: MASK_SENTINEL } },
          ],
        },
      }

      unmaskSentinels(incoming as any, existing as any)

      const inc = (incoming.imChannels as any).instances
      expect(inc[0].config.secret).toBe('real-secret-b')
      expect(inc[1].config.secret).toBe('real-secret-a')
    })

    it('clears IM channel instance *** to empty string when no matching existing instance exists', () => {
      // Existing has no instance at all; incoming carries a stale '***'.
      const existing = { imChannels: { instances: [] } }
      const incoming = {
        imChannels: {
          instances: [
            { id: 'orphan', type: 'wecom-bot', config: { botId: 'aib-x', secret: MASK_SENTINEL } },
          ],
        },
      }

      unmaskSentinels(incoming as any, existing as any)

      expect((incoming.imChannels as any).instances[0].config.secret).toBe('')
    })

    it('self-heals a corrupted existing IM channel *** to empty string', () => {
      // Simulates prior corruption: '***' was previously written to disk.
      const existing = {
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: MASK_SENTINEL } },
          ],
        },
      }
      const incoming = {
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: MASK_SENTINEL } },
          ],
        },
      }

      unmaskSentinels(incoming as any, existing as any)

      expect((incoming.imChannels as any).instances[0].config.secret).toBe('')
    })

    it('restoreMap clears unmatched sentinels when existing config is undefined', () => {
      // Edge case: existing instance missing entirely (incoming references
      // an id that does not exist). restoreMap must not leave '***' in place.
      const existing = {
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: 'real-secret-a' } },
          ],
        },
      }
      const incoming = {
        imChannels: {
          instances: [
            // B has no counterpart in existing.
            { id: 'B', type: 'wecom-bot', config: { botId: 'aib-b', secret: MASK_SENTINEL } },
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: MASK_SENTINEL } },
          ],
        },
      }

      unmaskSentinels(incoming as any, existing as any)

      const inc = (incoming.imChannels as any).instances
      expect(inc[0].config.secret).toBe('')
      expect(inc[1].config.secret).toBe('real-secret-a')
    })

    it('does not mutate existing during self-heal (existing is read-only)', () => {
      const existing = {
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: MASK_SENTINEL } },
          ],
        },
      }
      const incoming = {
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: MASK_SENTINEL } },
          ],
        },
      }
      const existingBefore = JSON.parse(JSON.stringify(existing))

      unmaskSentinels(incoming as any, existing as any)

      // The contract states `existing` is read-only.
      expect(existing).toEqual(existingBefore)
    })

    it('skips IM channel restore when incoming.imChannels is absent (partial update)', () => {
      // Partial config update: only api is touched, imChannels not in incoming.
      const existing = {
        api: { provider: 'openai', apiKey: 'sk-real', apiUrl: '' },
        imChannels: {
          instances: [
            { id: 'A', type: 'wecom-bot', config: { botId: 'aib-a', secret: 'real-secret-a' } },
          ],
        },
      }
      const incoming = { api: { provider: 'openai', apiKey: MASK_SENTINEL, apiUrl: '' } }

      expect(() => unmaskSentinels(incoming as any, existing as any)).not.toThrow()
      expect((incoming as any).api.apiKey).toBe('sk-real')
    })
  })
})
