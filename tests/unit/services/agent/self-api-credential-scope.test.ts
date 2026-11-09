/**
 * The core API tool, guide and credentials travel together. Core availability
 * must not leak owner authority into guest or external-origin turns.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Same transitive electron pull the other sdk-config tests mock out.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))

vi.mock('../../../../src/main/services/ai-browser', () => ({
  createAIBrowserMcpServer: vi.fn(), getInteractiveBrowserContext: vi.fn(), AI_BROWSER_SYSTEM_PROMPT: '',
}))
vi.mock('../../../../src/main/services/ai-terminal', () => ({
  createTerminalMcpServer: vi.fn(), getGlobalTerminalContext: vi.fn(), isTerminalAvailable: () => false, AI_TERMINAL_SYSTEM_PROMPT: '',
}))
vi.mock('../../../../src/main/services/ocr', () => ({ createOcrMcpServer: vi.fn() }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({
  getOpenToolsets: () => new Set(),
  getExcludedToolsets: () => new Set(),
}))

import { buildSdkEnv } from '../../../../src/main/services/agent/sdk-config'
import { HALO_API_TOOLSET_ID, HALO_API_USAGE_GUIDE } from '../../../../src/main/services/api-ref'
import { getToolset } from '../../../../src/main/services/agent/toolsets/registry'
import { isToolsetIncluded, isToolsetConfigurable } from '../../../../src/main/services/agent/toolsets/selection'
import { buildToolsetSection } from '../../../../src/main/services/agent/toolsets/capability-index'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8')

describe('self-API credentials', () => {
  it('injects the base URL and token when the session gets the capability', () => {
    const env = buildSdkEnv({
      selfApi: { url: 'http://127.0.0.1:4791', token: 'self-token' },
      spaceId: 'space-a',
    } as Parameters<typeof buildSdkEnv>[0])

    expect(env.HALO_API_URL).toBe('http://127.0.0.1:4791')
    expect(env.HALO_API_TOKEN).toBe('self-token')
    expect(env.HALO_SPACE_ID).toBe('space-a')
  })

  it('sets none of the three otherwise, HALO_SPACE_ID included', () => {
    const env = buildSdkEnv({ spaceId: 'space-a' } as Parameters<typeof buildSdkEnv>[0])

    expect(env.HALO_API_URL).toBeUndefined()
    expect(env.HALO_API_TOKEN).toBeUndefined()
    // Only the manual's curl examples read it, so on its own it would describe
    // a capability the session does not have.
    expect(env.HALO_SPACE_ID).toBeUndefined()
  })
})

describe('self-API capability coupling', () => {
  it.each(['automatic', 'manual'] as const)('supplies the core tool and guide together with no saved switch in %s mode', mode => {
    const definition = getToolset(HALO_API_TOOLSET_ID)!
    expect(definition).toBeDefined()
    expect(definition.contextManaged).toBe(true)
    expect(definition.isAvailable()).toBe(true)
    expect(definition.createServer).toEqual(expect.any(Function))
    expect(definition.usageGuide).toBe(HALO_API_USAGE_GUIDE)
    expect(isToolsetIncluded(definition, new Set(), mode)).toBe(true)
    expect(isToolsetConfigurable(definition, mode)).toBe(false)
    expect(buildToolsetSection('space-a', 'conversation-a', mode)).toContain(HALO_API_USAGE_GUIDE.trim())
    expect(read('src/main/services/agent/toolsets/broker.ts')).not.toContain('createApiRefMcpServer')
  })

  it('never states the capability in the base system prompt', () => {
    // Both profiles reach digital humans through buildAppSystemPrompt /
    // buildIdentityFragments, so anything unconditional here is delivered to
    // sessions that do not have the tool.
    const prompt = read('src/main/services/agent/system-prompt.ts')
    expect(prompt).not.toContain('halo_api_ref')
    expect(prompt).not.toContain('HALO_API_URL')
  })

  it('supplies space credentials alongside creation-time core servers and guides', () => {
    for (const rel of ['src/main/services/agent/send-message.ts', 'src/main/services/agent/session-manager.ts']) {
      const source = read(rel)
      expect(source, rel).toMatch(/selfApiAccess:\s*true/)
      expect(source, rel).toMatch(/buildCreationTimeServers\s*\(/)
      expect(source, rel).toMatch(/buildToolsetSection\s*\(/)
    }
  })

  it('couples app credentials, tools and prompt guides to the same caller-scoped decision', () => {
    for (const rel of ['src/main/apps/runtime/app-chat.ts', 'src/main/apps/runtime/execute.ts']) {
      const source = read(rel)
      expect(source, rel).toMatch(/selfApiAccess:\s*usesHaloApi\b/)
      expect(source, rel).toMatch(/usesHaloApi\s*\?\s*\{\s*'halo-api-ref':\s*createApiRefMcpServer\(\)/)
      expect(source, rel).toMatch(/\busesHaloApi\s*,/)
      expect(source, rel).not.toMatch(/selfApiAccess:\s*true/)
    }
    for (const rel of ['src/main/apps/runtime/prompt.ts', 'src/main/apps/runtime/prompt/identity.ts']) {
      expect(read(rel), rel).toMatch(/if\s*\((?:options|input)\.usesHaloApi\)\s*\{[^}]*HALO_API_USAGE_GUIDE/)
    }
  })

  it('uses one identifier for the toolset, the MCP server and the permission', () => {
    expect(HALO_API_TOOLSET_ID).toBe('halo-api-ref')
    // The runtime injection sites use the literal so the builtin-mcp drift
    // guard can see them; this keeps the literal and the constant in step.
    for (const rel of ['src/main/apps/runtime/app-chat.ts', 'src/main/apps/runtime/execute.ts']) {
      expect(read(rel)).toContain(`'${HALO_API_TOOLSET_ID}': createApiRefMcpServer()`)
    }
  })

  it('withholds the app capability from guests, external origins and disposable members', () => {
    const source = read('src/main/apps/runtime/app-chat.ts')
    const decision = source.match(/const usesHaloApi\s*=\s*([^\n]+)/)?.[1]
    expect(decision).toBeDefined()
    const conditions = decision!.split('&&').map(condition => condition.trim()).sort()
    expect(conditions).toEqual(['!disposableMember', '!origin', 'permCtx?.isOwner !== false'].sort())
  })
})
