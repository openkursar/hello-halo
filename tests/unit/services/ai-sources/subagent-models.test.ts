import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AISourcesConfig } from '../../../../src/shared/types/ai-sources'
const store = vi.hoisted(() => ({ value: {} as { aiSources: AISourcesConfig }, saves: 0, unreadable: false, fail: false }))
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => store.value,
  onAiSourcesConfigChange: () => () => {},
  isConfigUnreadable: () => store.unreadable,
  saveConfig: (patch: typeof store.value) => {
    if (store.fail) throw new Error('write failed')
    store.saves++; store.value = patch
  },
}))
import { clearBuiltinSubagentModel, createSubagentModel, deleteSubagentModel, getSubagentModelSettings, listSubagentModels, seedSubagentModelSettings, setSubagentModelSelectionMode, updateSubagentModel } from '../../../../src/main/services/ai-sources/subagent-models'
const target = { kind: 'model' as const, sourceId: 'account', modelId: 'm1' }
const input = { name: 'Review', description: 'Check boundaries', target }
beforeEach(() => {
  seedSubagentModelSettings(undefined)
  store.saves = 0; store.unreadable = false; store.fail = false
  store.value = { aiSources: { version: 2, currentId: 'account', sources: [{ id: 'account', name: 'Account', provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', model: 'm1', availableModels: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }], createdAt: '', updatedAt: '' }] } }
})
describe('model assignment persistence', () => {
  it('projects empty fixed slots without writing or activating', () => {
    expect(listSubagentModels().profiles.map(profile => profile.id)).toEqual(['builtin:small', 'builtin:medium', 'builtin:large'])
    expect(getSubagentModelSettings()).toBeUndefined()
    expect(store.saves).toBe(0)
  })
  it('creates a custom assignment without changing selection and rejects stale profile writes', () => {
    const settings = createSubagentModel(input)
    const profile = settings.profiles.find(profile => profile.kind === 'custom')!
    expect(settings).toMatchObject({ revision: 1, policyRevision: 1, selectionMode: 'inherit' })
    expect(() => updateSubagentModel({ ...input, id: profile.id, expectedRevision: 0 })).toThrow('revision-conflict')
    expect(store.saves).toBe(1)
  })
  it('keeps builtin identity and revisions across clear and reconfiguration', () => {
    const id = 'builtin:small'
    updateSubagentModel({ id, expectedRevision: 0, description: 'Extract fields', target })
    setSubagentModelSelectionMode({ expectedRevision: 1, selectionMode: 'task' })
    const cleared = clearBuiltinSubagentModel({ id, expectedRevision: 1 })
    expect(cleared).toMatchObject({ revision: 3, policyRevision: 3, selectionMode: 'inherit' })
    expect(cleared.profiles[0]).toMatchObject({ id, revision: 2, description: 'Extract fields' })
    expect(cleared.profiles[0].target).toBeUndefined()
    const saved = updateSubagentModel({ id, expectedRevision: 2, description: 'Again', target })
    expect(saved.profiles[0].revision).toBe(3)
    expect(() => deleteSubagentModel({ id, expectedRevision: 3 })).toThrow('builtin-immutable')
  })
  it('does not write for clearing an unsaved slot or setting the current mode', () => {
    clearBuiltinSubagentModel({ id: 'builtin:large', expectedRevision: 0 })
    setSubagentModelSelectionMode({ expectedRevision: 0, selectionMode: 'inherit' })
    expect(store.saves).toBe(0)
  })
  it.each(['Small', '小杯', 'Ｒｅｖｉｅｗ'])('reserves normalized and builtin names: %s', name => {
    createSubagentModel(input)
    expect(() => createSubagentModel({ ...input, name })).toThrow('name-duplicate')
  })
  it('validates codepoints rather than UTF-16 length', () => {
    expect(() => createSubagentModel({ ...input, name: '😀'.repeat(80) })).not.toThrow()
    expect(() => createSubagentModel({ ...input, name: '😀'.repeat(81) })).toThrow('invalid-name')
  })
  it('rejects unsupported efforts and target credential fields', () => {
    expect(() => createSubagentModel({ ...input, reasoningEffort: 'high' })).toThrow('unsupported-effort')
    expect(() => createSubagentModel({ ...input, target: { ...target, apiKey: 'synthetic-canary' } } as never)).toThrow('invalid-target')
    expect(store.saves).toBe(0)
  })
  it('keeps deleted account references for repair without leaking account fields', () => {
    createSubagentModel(input)
    store.value.aiSources.sources = []
    expect(listSubagentModels().profiles.find(profile => profile.kind === 'custom')?.target).toEqual(target)
    expect(JSON.stringify(listSubagentModels())).not.toContain('example.invalid')
  })
  it('rejects unreadable configurations and propagates failed writes', () => {
    store.unreadable = true
    expect(() => createSubagentModel(input)).toThrow('config-unreadable')
    store.unreadable = false; store.fail = true
    expect(() => createSubagentModel(input)).toThrow('write failed')
    expect(store.saves).toBe(0)
    expect(getSubagentModelSettings()).toBeUndefined()
  })
  it('does not write or revise an identical profile update', () => {
    const settings = createSubagentModel(input)
    const profile = settings.profiles.find(profile => profile.kind === 'custom')!
    const unchanged = updateSubagentModel({ ...input, id: profile.id, expectedRevision: profile.revision })
    expect(unchanged.revision).toBe(settings.revision)
    expect(store.saves).toBe(1)
  })
  it('rejects unknown fields on destructive and policy operations', () => {
    expect(() => clearBuiltinSubagentModel({ id: 'builtin:small', expectedRevision: 0, target } as never)).toThrow('invalid-input')
    expect(() => deleteSubagentModel({ id: 'builtin:small', expectedRevision: 0, target } as never)).toThrow('invalid-input')
    expect(() => setSubagentModelSelectionMode({ selectionMode: 'inherit', expectedRevision: 0, target } as never)).toThrow('invalid-input')
    expect(store.saves).toBe(0)
  })
  it('rejects excessive total resource use without modifying the snapshot', () => {
    createSubagentModel(input)
    const settings = store.value.aiSources.subagentModels!
    const profile = settings.profiles[0]
    settings.profiles = Array.from({ length: 1100 }, (_, index) => ({ ...profile, id: String(index), description: 'x'.repeat(1000), kind: 'custom' as const, name: String(index), target }))
    expect(() => createSubagentModel(input)).toThrow('resource-limit')
    expect(store.saves).toBe(1)
  })
})
