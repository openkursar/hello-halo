import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelProfileCatalogView, type ModelProfileQueryResult, type PreparedModelMetadata, type SpawnInput } from '@hello-halo/agent-sdk/collaboration'
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
let parent: DelegatedModelContext
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
async function query(target: DelegatedModelEndpoint): Promise<ModelProfileQueryResult> {
  const result = await target.list({}, {})
  return JSON.parse((result.content[0] as { text: string }).text)
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
    expect(result.profiles[0].target.models).toEqual([model])
    const encoded = JSON.stringify(result)
    for (const secret of [accountId, 'restoreRef', 'bindingId', 'synthetic-key-canary', 'identity-1']) expect(encoded).not.toContain(secret)
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
    const ref = (await query(target)).profiles[0].selectionRef
    mocks.profile.mockReturnValue({ ...settings.profiles[0], revision: 2 })
    await expect(target.prepare(spawn({ model_profile: ref }), parent, vi.fn())).rejects.toThrow()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('rejects an obsolete profile reference before metadata preparation', async () => {
    const target = endpoint()
    const ref = (await query(target)).profiles[0].selectionRef
    settings.profiles[0] = { ...settings.profiles[0], revision: 2 }
    revision++
    await expect(target.prepare(spawn({ model_profile: ref }), parent, vi.fn())).rejects.toThrow()
    expect(mocks.metadata).not.toHaveBeenCalled()
  })

  it('rejects query, profile and effort-only overrides under a stale endpoint policy but permits pure inheritance', async () => {
    const target = endpoint()
    const ref = (await query(target)).profiles[0].selectionRef
    settings = { ...settings, selectionMode: 'inherit', policyRevision: 2 }
    revision++
    await expect(query(target)).rejects.toThrow()
    await expect(target.prepare(spawn({ model_profile: ref }), parent, vi.fn())).rejects.toThrow()
    await expect(target.prepare(spawn({ reasoning_effort: 'high' }), parent, vi.fn())).rejects.toThrow()
    expect(mocks.metadata).not.toHaveBeenCalled()
    const inherited = await target.prepare(spawn(), parent, vi.fn())
    expect(inherited.inheritedReasoning).toEqual(parent.reasoning)
  })

  it('reuses the native catalog until snapshot revision changes and closes replaced and final views', async () => {
    const querySpy = vi.spyOn(ModelProfileCatalogView.prototype, 'query')
    const closeSpy = vi.spyOn(ModelProfileCatalogView.prototype, 'close')
    const target = endpoint()
    await query(target)
    await query(target)
    const first = querySpy.mock.instances[0]
    expect(querySpy.mock.instances[1]).toBe(first)
    revision++
    await query(target)
    expect(querySpy.mock.instances[2]).not.toBe(first)
    expect(closeSpy.mock.instances).toEqual([first])
    target.close()
    expect(closeSpy.mock.instances).toEqual([first, querySpy.mock.instances[2]])
  })

  it.each(['stop', 'abort', 'permission', 'policy', 'profile', 'identity'] as const)('rejects a post-await %s race', async race => {
    const target = endpoint()
    const ref = (await query(target)).profiles[0].selectionRef
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

  it('uses an explicit same-model profile target rather than inheriting the parent account or reasoning', async () => {
    const targetId = 'second-account-id-canary'
    sources.push({ ...sources[0], id: targetId, name: 'Second account' })
    settings.profiles[0] = { ...settings.profiles[0], target: { kind: 'model', sourceId: targetId, modelId: model } }
    mocks.metadata.mockResolvedValue({ metadata: metadata(targetId) })
    const target = endpoint()
    const ref = (await query(target)).profiles[0].selectionRef
    const result = await target.prepare(spawn({ model_profile: ref }), parent, vi.fn())
    expect(mocks.metadata).toHaveBeenCalledWith({ modelSourceId: targetId, modelId: model }, 'halo')
    expect(result.modelSelection.modelSourceId).toBe(targetId)
    expect(result.modelBinding.bindingId).toBe(metadata(targetId).bindingId)
    expect(result.inheritedReasoning).toEqual({ version: 1, mode: 'effort', effort: 'medium' })
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
