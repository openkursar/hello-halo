import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const state = vi.hoisted(() => ({ config: { agent: {} } as any }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => state.config }))
import { resolveHistoricalEngine } from '../../../../src/main/services/agent/engine-migration'

beforeEach(() => { state.config = { agent: { sdkEngine: 'anthropic' } } })

describe('external CC upgrade routing', () => {
  it.each([{}, { selectedPath: '/selected' }, { selectedPath: '/selected', discoveryCompleted: true }])('does not infer user intent from old configuration %j', ccRuntime => {
    state.config.agent.ccRuntime = ccRuntime
    const before = JSON.stringify(state.config)
    expect(resolveHistoricalEngine('anthropic')).toBe('halo')
    expect(JSON.stringify(state.config)).toBe(before)
  })
  it('retains a recorded user choice without inspecting any installation', () => {
    state.config.agent.ccRuntime = { selectedPath: '/chosen', selectionOrigin: 'user' }
    expect(resolveHistoricalEngine('anthropic')).toBe('anthropic')
  })
  it.each([
    ['delegated', 'claude-cli', 'cli', 'anthropic'],
    ['delegated', 'claude-cli', 'other', 'halo'],
    ['oauth', 'claude-cli', 'cli', 'halo'],
    ['delegated', 'other-provider', 'cli', 'halo'],
  ])('resolves selected source %s/%s/%s to %s', (authType, provider, currentId, expected) => {
    state.config.aiSources = { version: 2, currentId, sources: [{ id: 'cli', authType, provider }] }
    expect(resolveHistoricalEngine('anthropic')).toBe(expected)
  })
  it.each(['halo', 'codex', 'dsh'] as const)('does not change %s history', engine => {
    expect(resolveHistoricalEngine(engine)).toBe(engine)
  })
  it('does not decorate conversation rows with historical engine badges', () => {
    const source = readFileSync(resolve('src/renderer/components/chat/ConversationList.tsx'), 'utf8')
    expect(source).not.toContain('EngineBadge')
  })
  it('keeps startup and routing free of discovery and bulk history traversal', () => {
    for (const file of ['engine-migration.ts', 'engine-routing.ts', 'resolved-sdk.ts']) {
      const source = readFileSync(resolve('src/main/services/agent', file), 'utf8')
      expect(source).not.toMatch(/discoverAndSelect|scanCcInstallations|discoverInstallations|readdir|listSpaces|listConversations|migrateCcRuntimeSelection/)
    }
  })
})
