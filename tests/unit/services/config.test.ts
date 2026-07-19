/**
 * Config Service Unit Tests
 *
 * Tests for the configuration management service.
 * Covers config loading, saving, validation, and defaults.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('../../../src/main/foundation/credential-safety', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

// Import after mocks are set up
import {
  getConfig,
  saveConfig,
  getHaloDir,
  getConfigPath,
  initializeApp,
  getCredentialsGeneration,
  migrateCredentialEncryption
} from '../../../src/main/foundation/config.service'
import { isCredentialAtRestSafe } from '../../../src/main/foundation/credential-safety'
import {
  encodeForStorage,
  decodeFromStorage,
  needsKeyMigration,
  __resetKeyCacheForTests,
} from '../../../src/main/foundation/crypto-envelope'

type MockFn = ReturnType<typeof vi.fn>
function setCredentialAtRestSafe(on: boolean): void {
  ;(isCredentialAtRestSafe as unknown as MockFn).mockReturnValue(on)
}

describe('Config Service', () => {
  describe('getHaloDir', () => {
    it('should return path to .halo directory in home', () => {
      const haloDir = getHaloDir()
      expect(haloDir).toContain('.halo')
    })
  })

  describe('getConfigPath', () => {
    it('should return path to config.json', () => {
      const configPath = getConfigPath()
      expect(configPath).toContain('config.json')
      expect(configPath).toContain('.halo')
    })
  })

  describe('initializeApp', () => {
    it('should create necessary directories', async () => {
      await initializeApp()

      const haloDir = getHaloDir()
      expect(fs.existsSync(haloDir)).toBe(true)
      expect(fs.existsSync(path.join(haloDir, 'temp'))).toBe(true)
      expect(fs.existsSync(path.join(haloDir, 'spaces'))).toBe(true)
    })

    it('should create default config if not exists', async () => {
      await initializeApp()

      const configPath = getConfigPath()
      expect(fs.existsSync(configPath)).toBe(true)

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      expect(config.api).toBeDefined()
      expect(config.permissions).toBeDefined()
    })
  })

  describe('getConfig', () => {
    it('should return default config when no config file exists', () => {
      const config = getConfig()

      expect(config.api.provider).toBe('anthropic')
      expect(config.api.apiKey).toBe('')
      expect(config.api.apiUrl).toBe('https://api.anthropic.com')
      expect(config.permissions.commandExecution).toBe('ask')
      expect(config.appearance.theme).toBe('dark')
      expect(config.isFirstLaunch).toBe(true)
    })

    it('should merge saved config with defaults', async () => {
      await initializeApp()

      // Save partial config
      const configPath = getConfigPath()
      fs.writeFileSync(configPath, JSON.stringify({
        api: { apiKey: 'test-key' },
        isFirstLaunch: false
      }))

      const config = getConfig()

      // Saved values
      expect(config.api.apiKey).toBe('test-key')
      expect(config.isFirstLaunch).toBe(false)

      // Default values for missing fields
      expect(config.api.provider).toBe('anthropic')
      expect(config.api.apiUrl).toBe('https://api.anthropic.com')
      expect(config.permissions.fileAccess).toBe('allow')
    })
  })

  describe('saveConfig', () => {
    beforeEach(async () => {
      await initializeApp()
    })

    it('should save config to file', () => {
      saveConfig({ api: { apiKey: 'new-key' } } as any)

      const configPath = getConfigPath()
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

      expect(saved.api.apiKey).toBe('new-key')
    })

    it('should merge with existing config', () => {
      // Save initial config
      saveConfig({ api: { apiKey: 'key1' } } as any)

      // Save another field
      saveConfig({ isFirstLaunch: false })

      const config = getConfig()
      expect(config.api.apiKey).toBe('key1')
      expect(config.isFirstLaunch).toBe(false)
    })

    it('should deep merge nested objects', () => {
      saveConfig({
        api: { apiKey: 'test-key' }
      } as any)

      saveConfig({
        api: { model: 'claude-3-opus' }
      } as any)

      const config = getConfig()
      expect(config.api.apiKey).toBe('test-key')
      expect(config.api.model).toBe('claude-3-opus')
    })

    it('should replace mcpServers entirely', () => {
      saveConfig({
        mcpServers: { server1: { command: 'cmd1' } }
      } as any)

      saveConfig({
        mcpServers: { server2: { command: 'cmd2' } }
      } as any)

      const config = getConfig()
      expect(config.mcpServers).toEqual({ server2: { command: 'cmd2' } })
    })
  })

  // Guards the session-rebuild signal: anything baked into the CC subprocess at
  // startup (API key, model, modelOverrides) must influence the signature so
  // ModelConfigPanel edits take effect without an app restart.
  describe('credentials generation invalidation', () => {
    const sourceId = '11111111-1111-1111-1111-111111111111'

    function makeApiKeySource(extra: Record<string, unknown> = {}) {
      return {
        version: 2 as const,
        currentId: sourceId,
        sources: [
          {
            id: sourceId,
            name: 'Test',
            provider: 'custom' as const,
            authType: 'api-key' as const,
            apiUrl: 'https://example.com',
            apiKey: 'sk-test',
            model: 'deepseek-v4-flash',
            availableModels: [{ id: 'deepseek-v4-flash', name: 'DeepSeek v4 Flash' }],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            ...extra
          }
        ]
      }
    }

    beforeEach(async () => {
      await initializeApp()
      // Establish baseline source so subsequent saves are diffs, not first-set.
      saveConfig({ aiSources: makeApiKeySource() } as any)
    })

    it('increments generation when model id changes', () => {
      const before = getCredentialsGeneration()
      saveConfig({ aiSources: makeApiKeySource({ model: 'deepseek-chat' }) } as any)
      expect(getCredentialsGeneration()).toBe(before + 1)
    })

    it('increments generation when modelOverrides is first added', () => {
      const before = getCredentialsGeneration()
      saveConfig({
        aiSources: makeApiKeySource({
          modelOverrides: { 'deepseek-v4-flash': { contextWindow: 500_000 } }
        })
      } as any)
      expect(getCredentialsGeneration()).toBe(before + 1)
    })

    it('increments generation when modelOverrides value changes', () => {
      saveConfig({
        aiSources: makeApiKeySource({
          modelOverrides: { 'deepseek-v4-flash': { contextWindow: 200_000 } }
        })
      } as any)
      const before = getCredentialsGeneration()
      saveConfig({
        aiSources: makeApiKeySource({
          modelOverrides: { 'deepseek-v4-flash': { contextWindow: 500_000 } }
        })
      } as any)
      // 500K crosses the [1m] unlock threshold (200K) — sessions MUST rebuild
      // so the next CC subprocess is spawned with the suffixed sdkModel.
      expect(getCredentialsGeneration()).toBe(before + 1)
    })

    it('increments generation when maxOutputTokens override changes', () => {
      saveConfig({
        aiSources: makeApiKeySource({
          modelOverrides: { 'deepseek-v4-flash': { maxOutputTokens: 32_000 } }
        })
      } as any)
      const before = getCredentialsGeneration()
      saveConfig({
        aiSources: makeApiKeySource({
          modelOverrides: { 'deepseek-v4-flash': { maxOutputTokens: 64_000 } }
        })
      } as any)
      // CLAUDE_CODE_MAX_OUTPUT_TOKENS is injected at subprocess startup; the
      // session-rebuild signal is the only way the new cap reaches CC.
      expect(getCredentialsGeneration()).toBe(before + 1)
    })

    it('does NOT increment when modelOverrides is saved unchanged', () => {
      // Idempotency check: a no-op save (e.g. user opens panel, closes without
      // editing) must not churn sessions. Stable serialization (sorted keys)
      // guards this.
      saveConfig({
        aiSources: makeApiKeySource({
          modelOverrides: {
            'model-a': { contextWindow: 100_000 },
            'model-b': { contextWindow: 300_000 }
          }
        })
      } as any)
      const before = getCredentialsGeneration()
      saveConfig({
        aiSources: makeApiKeySource({
          modelOverrides: {
            // Different key insertion order — serializer must normalize.
            'model-b': { contextWindow: 300_000 },
            'model-a': { contextWindow: 100_000 }
          }
        })
      } as any)
      expect(getCredentialsGeneration()).toBe(before)
    })

    it('does NOT increment when an unrelated field changes', () => {
      const before = getCredentialsGeneration()
      saveConfig({ isFirstLaunch: false })
      expect(getCredentialsGeneration()).toBe(before)
    })
  })
})

describe('migrateCredentialEncryption', () => {
  beforeEach(() => {
    setCredentialAtRestSafe(false)
    __resetKeyCacheForTests()
  })

  it('is a no-op when at-rest encryption is off', () => {
    setCredentialAtRestSafe(false)
    fs.writeFileSync(getConfigPath(), JSON.stringify({ isFirstLaunch: false }))
    const before = fs.readFileSync(getConfigPath(), 'utf-8')
    migrateCredentialEncryption()
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe(before)
  })

  it('re-encrypts a legacy-seed remote PIN under the master key, preserving other fields', () => {
    setCredentialAtRestSafe(true)
    const credKey = path.join(getHaloDir(), 'cred.key')

    // Produce a PIN encoded under the legacy machine seed (master unavailable).
    fs.writeFileSync(credKey, 'malformed-not-hex')
    __resetKeyCacheForTests()
    const legacyPin = encodeForStorage('842913')
    expect(legacyPin.startsWith('gmcred:v1:')).toBe(true)

    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ remoteAccess: { enabled: true, port: 3847, password: legacyPin } }),
    )

    // New build establishes a real master key.
    fs.rmSync(credKey)
    __resetKeyCacheForTests()

    migrateCredentialEncryption()

    const after = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
    expect(after.remoteAccess.password).not.toBe(legacyPin) // re-encoded
    expect(after.remoteAccess.enabled).toBe(true) // preserved
    expect(after.remoteAccess.port).toBe(3847) // preserved
    expect(needsKeyMigration(after.remoteAccess.password)).toBe(false) // now under master
    expect(decodeFromStorage(after.remoteAccess.password)).toBe('842913')
  })

  it('migrates AI source keys and is idempotent on a second run', () => {
    setCredentialAtRestSafe(true)
    __resetKeyCacheForTests()

    // Plaintext key on disk under at-rest mode → needs migration.
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        aiSources: {
          version: 2,
          currentId: 's1',
          sources: [{ id: 's1', name: 'X', provider: 'openai', authType: 'api-key', apiKey: 'sk-plain' }],
        },
      }),
    )

    migrateCredentialEncryption()
    const first = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
    expect(first.aiSources.sources[0].apiKey).toMatch(/^gmcred:v1:/)

    // Second run: nothing left to migrate → no rewrite.
    const snapshot = fs.readFileSync(getConfigPath(), 'utf-8')
    migrateCredentialEncryption()
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe(snapshot)
  })
})
