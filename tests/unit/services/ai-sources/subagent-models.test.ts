import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listSubagentSourceModels } from '../../../../src/shared/subagent-models'
import type { AIGroup, AISourcesConfig } from '../../../../src/shared/types/ai-sources'
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
  store.value = { aiSources: { version: 2, currentId: 'account', sources: [{ id: 'account', name: 'Account', provider: 'custom', authType: 'api-key', apiKey: 'synthetic-key', apiUrl: 'https://example.invalid', model: 'm1', availableModels: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }], createdAt: '', updatedAt: '' }] } }
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
  it('retires the runtime configuration while preserving cleared slots and renews policy on reactivation', () => {
    const id = 'builtin:small'
    const first = updateSubagentModel({ id, expectedRevision: 0, description: 'Extract fields', target })
    expect(getSubagentModelSettings()?.policyRevision).toBe(first.policyRevision)
    const cleared = clearBuiltinSubagentModel({ id, expectedRevision: 1 })
    expect(getSubagentModelSettings()).toBeUndefined()
    expect(listSubagentModels().profiles[0]).toMatchObject({ id, description: 'Extract fields', revision: 2 })
    expect(cleared.policyRevision).toBe(first.policyRevision + 1)
    seedSubagentModelSettings(undefined)
    seedSubagentModelSettings(store.value.aiSources)
    expect(getSubagentModelSettings()).toBeUndefined()
    const reactivated = createSubagentModel(input)
    expect(getSubagentModelSettings()?.policyRevision).toBe(cleared.policyRevision + 1)
    expect(reactivated.policyRevision).toBe(cleared.policyRevision + 1)
  })
  it('keeps custom assignments in their original order when edited', () => {
    const first = createSubagentModel(input).profiles[3]
    const second = createSubagentModel({ ...input, name: 'Summarize' }).profiles[4]
    const updated = updateSubagentModel({ ...input, description: 'Revised', id: first.id, expectedRevision: first.revision })
    expect(updated.profiles.slice(3).map(profile => profile.id)).toEqual([first.id, second.id])
    expect(updated.policyRevision).toBe(1)
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
  it('rejects retired profile effort inputs and target credential fields', () => {
    const retiredInput = { ...input, reasoningEffort: 'high' }
    expect(() => createSubagentModel(retiredInput)).toThrow('invalid-input')
    const retiredUpdate = { id: 'builtin:small', expectedRevision: 0, description: input.description, target, reasoningEffort: 'high' }
    expect(() => updateSubagentModel(retiredUpdate)).toThrow('invalid-input')
    expect(() => createSubagentModel({ ...input, target: { ...target, apiKey: 'synthetic-canary' } } as never)).toThrow('invalid-target')
    expect(store.saves).toBe(0)
  })
  it('accepts every offered legacy Anthropic fallback model and rejects withdrawn models', () => {
    const source = store.value.aiSources.sources[0]
    Object.assign(source, { provider: 'anthropic', availableModels: [], withdrawnModels: [{ id: 'claude-opus-5-5', name: 'Opus', at: '' }] })
    const offered = listSubagentSourceModels(source)
    expect(offered.map(model => model.id)).toContain('claude-sonnet-5-5')
    expect(offered.map(model => model.id)).not.toContain('claude-opus-5-5')
    for (const model of offered) {
      expect(createSubagentModel({ ...input, name: model.id, target: { ...target, modelId: model.id } }).profiles.at(-1)?.target)
        .toEqual({ ...target, modelId: model.id })
    }
    expect(() => createSubagentModel({ ...input, target: { ...target, modelId: 'claude-opus-5-5' } })).toThrow('unknown-model')
  })
  it('rejects unsigned accounts and a stale current model not offered by the picker', () => {
    const source = store.value.aiSources.sources[0]
    source.availableModels = [{ id: 'm2', name: 'M2' }]
    expect(() => createSubagentModel(input)).toThrow('unknown-model')
    source.apiKey = undefined
    expect(listSubagentSourceModels(source)).toEqual([])
    expect(() => createSubagentModel({ ...input, target: { ...target, modelId: 'm2' } })).toThrow('unknown-model')
    expect(store.saves).toBe(0)
  })
  it('rejects groups without any configured, nonwithdrawn member', () => {
    const source = store.value.aiSources.sources[0]
    const group: AIGroup = { id: 'group', name: 'Group', members: [{ sourceId: source.id, modelId: 'm1' }], strategy: 'priority', createdAt: '', updatedAt: '' }
    store.value.aiSources.groups = [group]
    const groupInput = { ...input, target: { kind: 'group' as const, groupId: group.id } }
    source.withdrawnModels = [{ id: 'm1', name: 'M1', at: '' }]
    expect(() => createSubagentModel(groupInput)).toThrow('unknown-group')
    group.members.push({ sourceId: source.id, modelId: 'm2' })
    expect(createSubagentModel(groupInput).profiles.at(-1)?.target).toEqual(groupInput.target)
  })
  it('ignores legacy effort without rewriting settings or revising unchanged profiles', () => {
    const builtin = { id: 'builtin:small', kind: 'builtin' as const, slot: 'small' as const, description: 'Extract fields', target, revision: 3, reasoningEffort: 'low' }
    const custom = { ...input, id: 'review', kind: 'custom' as const, revision: 4, reasoningEffort: 'high' }
    store.value.aiSources.subagentModels = { version: 1, revision: 7, policyRevision: 2, selectionMode: 'inherit', profiles: [builtin, custom] }
    seedSubagentModelSettings(store.value.aiSources)

    const listed = listSubagentModels()
    expect(listed.profiles[0]).toMatchObject({ id: builtin.id, description: builtin.description, target, revision: builtin.revision })
    expect(listed.profiles[3]).toMatchObject({ ...input, id: custom.id, revision: custom.revision })
    expect(listed.profiles.every(profile => !('reasoningEffort' in profile))).toBe(true)
    const edit = { ...input, id: custom.id, expectedRevision: custom.revision }
    expect(updateSubagentModel(edit)).toEqual(listed)
    expect(store.saves).toBe(0)
    expect(store.value.aiSources.subagentModels.profiles).toEqual([builtin, custom])

    const updated = updateSubagentModel({ ...edit, description: 'Review changes' })
    expect(updated).toMatchObject({ revision: 8, policyRevision: 2 })
    expect(updated.profiles[3].revision).toBe(5)
    expect(updated.profiles.every(profile => !('reasoningEffort' in profile))).toBe(true)
    const [storedBuiltin, storedCustom] = store.value.aiSources.subagentModels.profiles
    expect(storedBuiltin).toEqual(builtin)
    expect(storedCustom).not.toHaveProperty('reasoningEffort')
    expect(store.saves).toBe(1)
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
