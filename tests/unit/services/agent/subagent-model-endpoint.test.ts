import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelProfileCatalogView, type ListModelProfilesInput, type PreparedModelMetadata, type SpawnInput } from '@hello-halo/agent-sdk/collaboration'
import type { AISource } from '../../../../src/shared/types/ai-sources'
import type { SubagentModelSettings } from '../../../../src/shared/types/subagent-models'
import type { DelegatedModelContext } from '../../../../src/main/services/agent/delegated-model'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), settings: vi.fn(), profile: vi.fn(), metadata: vi.fn() }))
vi.mock('../../../../src/main/services/ai-sources', () => ({
  getSubagentModelConfigurationSnapshot: mocks.snapshot,
  getSubagentModelSettings: mocks.settings,
  getSubagentModelProfile: mocks.profile,
}))
vi.mock('../../../../src/main/services/agent/subagent-model-metadata', () => ({ prepareSubagentModelMetadata: mocks.metadata }))
import { createDelegatedModelEndpoint, type DelegatedModelEndpoint } from '../../../../src/main/services/agent/subagent-models'

const accountId = 'private-account-id-canary'
const model = 'gpt-6-sol'
const selection = { modelSourceId: accountId, modelId: model }
let settings: SubagentModelSettings
let sources: AISource[]
let revision: number
let allowed: boolean
let parent: DelegatedModelContext & Required<Pick<DelegatedModelContext, 'reasoning'>>
let endpoints: DelegatedModelEndpoint[]

function metadata(sourceId = accountId): PreparedModelMetadata {
  const identity = JSON.stringify({ sourceId, modelId: model })
  return { bindingId: identity, restoreRef: identity, model, targetKind: 'single', contextWindow: 32000,
    maxOutputTokens: 4096, modalities: ['text'], reasoning: { supported: ['low', 'medium', 'high'],
      default: { version: 1, mode: 'effort', effort: 'medium' },
      effortMapping: { high: { version: 1, mode: 'effort', effort: 'high' }, off: { version: 1, mode: 'off' } } } }
}
function endpoint() {
  const result = createDelegatedModelEndpoint({ parent: () => parent, allowed: () => allowed })!
  endpoints.push(result)
  return result
}
async function query(target: DelegatedModelEndpoint, input: ListModelProfilesInput = {}) {
  const result = await target.list(input, {})
  return (result.content[0] as { text: string }).text
}
async function profileId(target: DelegatedModelEndpoint) {
  const id = (await query(target)).match(/^  model_profile: (p[a-z0-9]+)$/m)?.[1]
  expect(id).toBeDefined()
  return id!
}
function spawn(input: Partial<SpawnInput> = {}): SpawnInput { return { prompt: 'Extract fields', ...input } }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('delegated model endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revision = 1
    allowed = true
    endpoints = []
    settings = { version: 1, revision: 1, policyRevision: 1, selectionMode: 'task', profiles: [{
      id: 'builtin:small', kind: 'builtin', slot: 'small', revision: 1, description: 'Extract fields',
      target: { kind: 'model', sourceId: accountId, modelId: model },
    }] }
    sources = [{ id: accountId, name: 'Work account', provider: 'openai', authType: 'api-key', apiKey: 'synthetic-key-canary',
      apiUrl: 'https://synthetic-endpoint.invalid/v1', availableModels: [{ id: model, name: 'GPT Sol' }],
      model, createdAt: 'identity-1', updatedAt: 'version-1' }]
    parent = { selection: { ...selection }, engineId: 'halo', reasoning: { version: 1, mode: 'off' } }
    mocks.settings.mockImplementation(() => settings)
    mocks.snapshot.mockImplementation(() => ({ settings, revision, sources, groups: [] }))
    mocks.profile.mockImplementation((id: string) => settings.profiles.find(profile => profile.id === id))
    mocks.metadata.mockImplementation(async () => ({ metadata: metadata() }))
  })
  afterEach(() => {
    endpoints.forEach(target => target.close())
    vi.restoreAllMocks()
  })

  it('does not register an endpoint without settings or owner permission', () => {
    allowed = false
    expect(createDelegatedModelEndpoint({ parent: () => parent, allowed: () => allowed })).toBeUndefined()
    allowed = true
    mocks.settings.mockReturnValue(undefined)
    expect(createDelegatedModelEndpoint({ parent: () => parent, allowed: () => allowed })).toBeUndefined()
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('returns safe model descriptors without account or restore identities', async () => {
    const result = await query(endpoint())
    expect(result).toMatch(/^- Small — Extract fields\n  Model: GPT Sol \(ID: gpt-6-sol\) · Account: Work account\n  model_profile: p[a-z0-9]+$/)
    for (const secret of [accountId, 'builtin:small', 'restoreRef', 'bindingId', 'synthetic-key-canary', 'identity-1', 'reasoning', 'revision', 'cursor']) {
      expect(result).not.toContain(secret)
    }
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it.each(['raw-model-id', 'https://model.invalid', accountId])('rejects invalid profile %s before metadata preparation', async model_profile => {
    await expect(endpoint().prepare(spawn({ model_profile }), parent, vi.fn())).rejects.toThrow()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('rejects an already aborted preparation before reading the catalog or preparing metadata', async () => {
    const target = endpoint()
    const controller = new AbortController()
    controller.abort()
    await expect(target.prepare(spawn(), parent, vi.fn(), controller.signal)).rejects.toThrow()
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('rechecks the selected profile against live storage before preparing metadata', async () => {
    const target = endpoint()
    const ref = await profileId(target)
    mocks.profile.mockReturnValue({ ...settings.profiles[0], revision: 2 })
    await expect(target.prepare(spawn({ model_profile: ref }), parent, vi.fn())).rejects.toThrow()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('rejects an obsolete profile reference before metadata preparation', async () => {
    const target = endpoint()
    const ref = await profileId(target)
    settings.profiles[0] = { ...settings.profiles[0], revision: 2 }
    revision++
    await expect(target.prepare(spawn({ model_profile: ref }), parent, vi.fn())).rejects.toThrow()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('rejects query, profile and effort-only overrides under a stale endpoint policy but permits pure inheritance', async () => {
    const target = endpoint()
    const ref = await profileId(target)
    settings = { ...settings, selectionMode: 'inherit', policyRevision: 2 }
    revision++
    await expect(query(target)).rejects.toThrow()
    await expect(target.prepare(spawn({ model_profile: ref }), parent, vi.fn())).rejects.toThrow()
    await expect(target.prepare(spawn({ reasoning_effort: 'high' }), parent, vi.fn())).rejects.toThrow()
    expect(mocks.metadata).not.toHaveBeenCalled()
    const inherited = await target.prepare(spawn(), parent, vi.fn())
    expect(inherited.inheritedReasoning).toEqual(parent.reasoning)
  })

  it('uses the same short ID within a view and never accepts it in another endpoint', async () => {
    const target = endpoint()
    const other = endpoint()
    const id = await profileId(target)
    expect(await profileId(target)).toBe(id)
    expect(await profileId(other)).not.toBe(id)
    await expect(other.prepare(spawn({ model_profile: id }), parent, vi.fn())).rejects.toThrow('no longer valid')
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('lists all configured profiles in one call and includes unavailable entries without IDs', async () => {
    const first = settings.profiles[0]
    for (let index = 0; index < 21; index++) {
      settings.profiles.push({ id: `custom:${index}`, kind: 'custom', name: `Profile ${index}`, description: 'Extract fields', revision: 1, target: first.target! })
    }
    settings.profiles.push({ id: 'custom:missing', kind: 'custom', name: 'Missing account', description: '', revision: 1,
      target: { kind: 'model', sourceId: 'missing', modelId: model } })
    const target = endpoint()
    const text = await query(target)
    expect(text.match(/^  model_profile:/gm)).toHaveLength(22)
    expect(text).toMatch(/\n- Missing account\n  Model: .+\n  Unavailable: .+removed\.$/)
    expect(text).not.toContain('Next page')
    // @ts-expect-error Legacy arguments must also be refused at runtime.
    await expect(query(target, { query: '小杯' })).rejects.toThrow('without arguments')
  })

  it('refuses an oversized complete directory rather than returning a partial list', async () => {
    const first = settings.profiles[0]
    for (let index = 0; index < 20; index++) {
      settings.profiles.push({ id: `custom:${index}`, kind: 'custom', name: `Profile ${index}`, description: 'x'.repeat(900), revision: 1, target: first.target! })
    }
    await expect(query(endpoint())).rejects.toThrow('No profiles were listed')
  })

  it('reuses the native catalog until snapshot revision changes and closes replaced and final views', async () => {
    const querySpy = vi.spyOn(ModelProfileCatalogView.prototype, 'query')
    const closeSpy = vi.spyOn(ModelProfileCatalogView.prototype, 'close')
    const target = endpoint()
    await query(target)
    await query(target)
    const first = querySpy.mock.instances[0]
    expect(querySpy).toHaveBeenCalledTimes(1)
    revision++
    await query(target)
    expect(querySpy.mock.instances[1]).not.toBe(first)
    expect(closeSpy.mock.instances).toEqual([first])
    target.close()
    expect(closeSpy.mock.instances).toEqual([first, querySpy.mock.instances[1]])
  })

  it.each(['stop', 'abort', 'permission', 'policy', 'profile', 'identity'] as const)('rejects a post-await %s race', async race => {
    const target = endpoint()
    const ref = await profileId(target)
    const pending = deferred<{ metadata: PreparedModelMetadata }>()
    mocks.metadata.mockReturnValue(pending.promise)
    const controller = new AbortController()
    let stopped = false
    const check = vi.fn(() => { if (stopped) throw new Error('stopped') })
    const preparation = target.prepare(spawn({ model_profile: ref }), parent, check, controller.signal)
    expect(mocks.metadata).toHaveBeenCalledOnce()
    if (race === 'stop') stopped = true
    if (race === 'abort') controller.abort()
    if (race === 'permission') allowed = false
    if (race === 'policy') settings = { ...settings, policyRevision: 2 }
    if (race === 'profile') settings.profiles[0] = { ...settings.profiles[0], revision: 2 }
    if (race === 'identity') sources = [{ ...sources[0], createdAt: 'replacement-identity' }]
    pending.resolve({ metadata: metadata() })
    await expect(preparation).rejects.toThrow()
    expect(check).toHaveBeenCalledTimes(race === 'abort' ? 1 : 2)
  })

  it('cancels a waiting consumer promptly without consuming a late shared credential refresh', async () => {
    const target = endpoint()
    const pending = deferred<{ metadata: PreparedModelMetadata }>()
    mocks.metadata.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const check = vi.fn()
    const preparation = target.prepare(spawn(), parent, check, controller.signal)
    const assertion = expect(preparation).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled'))
    await assertion
    expect(check).toHaveBeenCalledOnce()
    pending.resolve({ metadata: metadata() })
    await Promise.resolve()
    expect(check).toHaveBeenCalledOnce()
  })

  it('switches accounts while adapting the direct parent reasoning level', async () => {
    const targetId = 'second-account-id-canary'
    sources.push({ ...sources[0], id: targetId, name: 'Second account' })
    settings.profiles[0] = { ...settings.profiles[0], target: { kind: 'model', sourceId: targetId, modelId: model } }
    const binding = metadata(targetId)
    mocks.metadata.mockResolvedValue({ metadata: { ...binding, reasoning: { ...binding.reasoning, default: parent.reasoning } } })
    const target = endpoint()
    const ref = await profileId(target)
    const result = await target.prepare(spawn({ model_profile: ref }), parent, vi.fn())
    expect(mocks.metadata).toHaveBeenCalledWith({ modelSourceId: targetId, modelId: model }, 'halo', 'off')
    expect(result.modelSelection.modelSourceId).toBe(targetId)
    expect(result.modelBinding.bindingId).toBe(metadata(targetId).bindingId)
    expect(result.inheritedReasoning).toEqual(parent.reasoning)
    expect(result.reasoningLevel).toBe('off')
  })

  it.each([undefined, 'inherit'])('normalizes %s to the exact parent binding and effective reasoning', async model_profile => {
    const binding = metadata()
    parent = { ...parent, modelBinding: { version: 1, selection: { kind: 'inherit' }, bindingId: binding.bindingId,
      restoreRef: binding.restoreRef, model, targetKind: 'single', reasoning: parent.reasoning } }
    const result = await endpoint().prepare(spawn({ model_profile }), parent, vi.fn())
    expect(result.modelSelection).toEqual(parent.selection)
    expect(result.modelBinding.bindingId).toBe(parent.modelBinding!.bindingId)
    expect(result.modelBinding.restoreRef).toBe(parent.modelBinding!.restoreRef)
    expect(result.modelBinding.selection).toEqual({ kind: 'inherit' })
    expect(result.inheritedReasoning).toEqual({ version: 1, mode: 'off' })
  })

  it('rejects metadata for a different inherited binding even when the model string matches', async () => {
    mocks.metadata.mockResolvedValue({ metadata: metadata('different-account') })
    await expect(endpoint().prepare(spawn(), parent, vi.fn())).rejects.toThrow()
  })
})
