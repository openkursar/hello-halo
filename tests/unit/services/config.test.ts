/**
 * Config Service Unit Tests
 *
 * Tests for the configuration management service.
 * Covers config loading, saving, validation, and defaults.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// Import after mocks are set up
import {
  getConfig,
  saveConfig,
  getHaloDir,
  getConfigPath,
  initializeApp,
  getCredentialsGeneration
} from '../../../src/main/foundation/config.service'

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
