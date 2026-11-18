import { describe, expect, it } from 'vitest'
import { buildSubagentModelCatalog } from '../../../../src/main/services/agent/subagent-model-catalog'
import type { AIGroup, AISource } from '../../../../src/shared/types/ai-sources'
import type { SubagentModelProfile, SubagentModelSettings } from '../../../../src/shared/types/subagent-models'

const source = (overrides: Partial<AISource> = {}): AISource => ({
  id: 'account-id-canary', name: 'Work account', provider: 'openai', authType: 'api-key',
  apiUrl: 'https://private-endpoint-canary.invalid/v1', apiKey: 'private-api-key-canary',
  model: 'gpt-6-sol', availableModels: [{ id: 'gpt-6-sol', name: 'GPT Sol' }],
  createdAt: '', updatedAt: '', user: { name: 'private-email-canary@example.invalid', uid: 'private-uid-canary' },
  ...overrides,
})
const builtin = (overrides: Partial<SubagentModelProfile> = {}): SubagentModelProfile => ({
  id: 'builtin:small', kind: 'builtin', slot: 'small', revision: 3, description: 'Extract fields',
  target: { kind: 'model', sourceId: 'account-id-canary', modelId: 'gpt-6-sol' }, ...overrides,
} as SubagentModelProfile)
const settings = (profiles: SubagentModelProfile[]): SubagentModelSettings => ({
  version: 1, revision: 7, policyRevision: 2, selectionMode: 'inherit', profiles,
})
const group = (overrides: Partial<AIGroup> = {}): AIGroup => ({
  id: 'group-id-canary', name: 'Work pool', strategy: 'priority',
  members: [{ sourceId: 'account-id-canary', modelId: 'gpt-6-sol' }], createdAt: '', updatedAt: '', ...overrides,
})

function catalog(profiles: SubagentModelProfile[], sources: AISource[] = [source()], groups: AIGroup[] = [], engineId: 'halo' | 'anthropic' | 'codex' = 'halo') {
  return buildSubagentModelCatalog({ settings: settings(profiles), sources, groups, engineId, revision: 'scope:7:source:3' })
}

describe('subagent model catalog projection', () => {
  it('does not create executable profiles for empty builtin slots', () => {
    expect(catalog([builtin({ target: undefined })]).profiles).toEqual([])
  })
  it('projects exact model identity, purpose, canonical names and safe account labels only', () => {
    const result = catalog([builtin()])
    expect(result.revision).toBe('scope:7:source:3')
    expect(result.policyRevision).toBe('2')
    expect(result.profiles[0]).toMatchObject({
      profileId: 'builtin:small', profileRevision: '3', name: 'Small (小杯)',
      description: 'Extract fields', available: true,
      target: { kind: 'single', models: ['gpt-6-sol'], label: 'GPT Sol', accountLabel: 'Work account' },
    })
    const encoded = JSON.stringify(result)
    for (const canary of ['account-id-canary', 'private-endpoint-canary', 'private-api-key-canary', 'private-email-canary', 'private-uid-canary']) {
      expect(encoded).not.toContain(canary)
    }
  })
  it.each(['owner@example.invalid', 'https://private.invalid', 'Account\nmetadata', 'x'.repeat(81)])('omits unsafe account label %s', name => {
    expect(catalog([builtin()], [source({ name })]).profiles[0].target.accountLabel).toBeUndefined()
  })
  it('keeps a removed target unavailable instead of substituting another account', () => {
    const result = catalog([builtin()], [source({ id: 'another-account' })])
    expect(result.profiles[0]).toMatchObject({ available: false, target: { models: ['gpt-6-sol'] } })
    expect(result.profiles[0].unavailableReason).toContain('removed')
  })
  it('reports signed-out and withdrawn targets from known state without probing', () => {
    expect(catalog([builtin()], [source({ apiKey: '' })]).profiles[0].available).toBe(false)
    expect(catalog([builtin()], [source({ withdrawnModels: [{ id: 'gpt-6-sol', name: 'Old model', at: '' }] })]).profiles[0].unavailableReason).toContain('no longer offers')
  })
  it('does not offer delegated credentials on a different execution engine', () => {
    const delegated = source({ authType: 'delegated', apiKey: undefined })
    expect(catalog([builtin()], [delegated]).profiles[0].available).toBe(false)
    expect(catalog([builtin()], [delegated], [], 'anthropic').profiles[0].available).toBe(true)
  })
  it('identifies a pool by all possible model ids, not a fixed first model', () => {
    const target = builtin({ target: { kind: 'group', groupId: 'group-id-canary' } })
    const pool = group({ members: [{ sourceId: 'account-id-canary', modelId: 'gpt-6-sol' }, { sourceId: 'other', modelId: 'gpt-6-luna' }] })
    const result = catalog([target], [source(), source({ id: 'other', model: 'gpt-6-luna' })], [pool])
    expect(result.profiles[0]).toMatchObject({ available: true, target: { kind: 'pool', label: 'Work pool', models: ['gpt-6-sol', 'gpt-6-luna'] } })
    expect(JSON.stringify(result)).not.toContain('group-id-canary')
    expect(catalog([target], [source()], [pool], 'codex').profiles[0].unavailableReason).toContain('Codex')
  })
  it('does not invent possible model ids for a removed or empty pool', () => {
    const target = builtin({ target: { kind: 'group', groupId: 'removed-group' } })
    expect(catalog([target]).profiles[0]).toMatchObject({ available: false, target: { kind: 'pool', models: [] } })
  })
  it('preserves explicit profile defaults and reports unsupported choices unavailable', () => {
    const result = catalog([builtin({ reasoningEffort: 'high' })], [source({ modelOverrides: { 'gpt-6-sol': { reasoningEffort: 'medium' } } })])
    expect(result.profiles[0].reasoning).toMatchObject({ profileDefault: 'high', modelDefault: 'medium' })
    expect(result.profiles[0].available).toBe(true)
    expect(catalog([builtin({ reasoningEffort: 'invented-level' })]).profiles[0].available).toBe(false)
  })
  it('does not mutate the captured configuration', () => {
    const profiles = [builtin()]
    const sources = [source()]
    const before = JSON.stringify({ profiles, sources })
    catalog(profiles, sources)
    expect(JSON.stringify({ profiles, sources })).toBe(before)
  })
})
