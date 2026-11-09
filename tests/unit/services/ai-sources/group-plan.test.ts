/**
 * What the router is told about a group: the models in order with names a
 * person recognizes, and a complete config for each model on demand.
 */

import { describe, expect, it, vi } from 'vitest'
import { createGroupPlanResolver, toRouterBackend } from '../../../../src/main/services/ai-sources/group-plan'
import type { AIGroup, AISource, AISourcesConfig, BackendRequestConfig } from '../../../../src/shared/types/ai-sources'
import type { GroupPlan } from '../../../../src/main/openai-compat-router'

const wiring = vi.hoisted(() => ({
  snapshot: undefined as AISourcesConfig | undefined,
  resolver: null as ((id: string) => GroupPlan | null) | null,
  saved: new Set<(sources: AISourcesConfig | undefined) => void>(),
  reads: vi.fn(),
  backendFor: vi.fn(),
  releaseFacts: vi.fn(),
}))
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => { wiring.reads(); return { aiSources: wiring.snapshot } },
  onAiSourcesConfigChange: (listener: (sources: AISourcesConfig | undefined) => void) => {
    wiring.saved.add(listener)
    return () => { wiring.saved.delete(listener) }
  },
}))
vi.mock('../../../../src/main/services/ai-sources/manager', () => ({
  getAISourceManager: () => ({ resolveMemberBackend: wiring.backendFor }),
}))
vi.mock('../../../../src/main/services/ai-sources/groups', () => ({ getGroup: vi.fn() }))
vi.mock('../../../../src/main/openai-compat-router', () => ({
  setGroupPlanResolver: (resolver: typeof wiring.resolver) => { wiring.resolver = resolver },
  onGroupRouteFact: () => ({ dispose: wiring.releaseFacts }),
  clearGroupRest: vi.fn(),
  getGroupHealth: vi.fn(),
}))
import { startGroupRouting } from '../../../../src/main/services/ai-sources/group-routing'

const account = (id: string, extra: Partial<AISource> = {}): AISource => ({
  id, name: `Account ${id}`, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
  model: 'm1', availableModels: [{ id: 'm1', name: 'Model One' }], createdAt: '', updatedAt: '', ...extra,
})

const group: AIGroup = {
  id: 'g', name: 'Daily', strategy: 'spread', createdAt: '', updatedAt: '',
  members: [{ sourceId: 'a', modelId: 'm1' }, { sourceId: 'gone', modelId: 'old' }],
}

function resolverWith(overrides: { groups?: AIGroup[] } = {}) {
  const sources = new Map([['a', account('a', { authType: 'oauth', user: { name: 'me@example.com' } })]])
  const readSources = vi.fn(() => [...sources.values()])
  const readGroup = vi.fn((id: string) => (overrides.groups ?? [group]).find(item => item.id === id) ?? null)
  const backendFor = vi.fn(async (sourceId: string, modelId: string): Promise<BackendRequestConfig> => ({
    url: `https://${sourceId}.invalid/v1/chat/completions`, key: 'token', model: modelId, sourceId,
  }))
  const resolver = createGroupPlanResolver({ readGroup, readSources, backendFor })
  return { resolver, readGroup, readSources, backendFor, sources }
}

describe('the plan of a group', () => {
  it('lists the models in order, named for a person', () => {
    const plan = resolverWith().resolver.resolve('g')!
    expect(plan).toMatchObject({ id: 'g', name: 'Daily', strategy: 'spread' })
    expect(plan.members).toEqual([
      { member: { key: 'a\u0000m1', sourceId: 'a', modelId: 'm1' }, label: { account: 'Account a · me@example.com', model: 'Model One' } },
      { member: { key: 'gone\u0000old', sourceId: 'gone', modelId: 'old' }, label: { account: 'Removed account', model: 'old' } },
    ])
  })

  it('is absent for a group that does not exist', () => {
    expect(resolverWith().resolver.resolve('missing')).toBeNull()
  })

  it('asks for a member\'s credential only when that member is used', async () => {
    const { resolver, backendFor } = resolverWith()
    const plan = resolver.resolve('g')!
    expect(backendFor).not.toHaveBeenCalled()
    const config = await plan.materialize(plan.members[0].member)
    expect(backendFor).toHaveBeenCalledWith('a', 'm1')
    expect(config).toMatchObject({ sourceId: 'a', url: 'https://a.invalid/v1/chat/completions', key: 'token' })
  })

  it('refuses a member whose account was removed', async () => {
    const plan = resolverWith().resolver.resolve('g')!
    await expect(plan.materialize(plan.members[1].member)).rejects.toThrow('removed')
  })

  it('passes on why an account cannot serve', async () => {
    const { resolver, backendFor } = resolverWith()
    backendFor.mockRejectedValueOnce(new Error('This account is signed out.'))
    const plan = resolver.resolve('g')!
    await expect(plan.materialize(plan.members[0].member)).rejects.toThrow('signed out')
  })
})

describe('remembering plans', () => {
  it('keeps the plan until its configuration changes, regardless of elapsed time', () => {
    const { resolver, readGroup } = resolverWith()
    const first = resolver.resolve('g')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_000)
    try {
      expect(resolver.resolve('g')).toBe(first)
      expect(readGroup).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('forgets everything when told a group changed', () => {
    const { resolver, readGroup } = resolverWith()
    resolver.resolve('g')
    resolver.invalidate()
    resolver.resolve('g')
    expect(readGroup).toHaveBeenCalledTimes(2)
  })

  it('reads the accounts once for a plan, however many models it has or are used', async () => {
    const { resolver, readSources } = resolverWith()
    const plan = resolver.resolve('g')!
    await plan.materialize(plan.members[0].member)
    await plan.materialize(plan.members[0].member)
    resolver.resolve('g')
    expect(readSources).toHaveBeenCalledTimes(1)
  })

  it('does not keep asking about ids that are no group for ever: the oldest answers go first', () => {
    const { resolver, readGroup } = resolverWith()
    for (let id = 0; id < 100; id++) resolver.resolve(`account-${id}`)
    readGroup.mockClear()
    resolver.resolve('account-99')
    expect(readGroup).not.toHaveBeenCalled()
    resolver.resolve('account-0')
    expect(readGroup).toHaveBeenCalledTimes(1)
  })

  it('does not keep a missing group as found', () => {
    const groups: AIGroup[] = []
    const { resolver } = resolverWith({ groups })
    expect(resolver.resolve('g')).toBeNull()
    groups.push(group)
    resolver.invalidate()
    expect(resolver.resolve('g')).not.toBeNull()
  })
})

describe('memory-only group routing', () => {
  it('reads once at startup, updates on saved snapshots and releases its subscriptions', () => {
    wiring.snapshot = { version: 2, currentId: 'a', sources: [account('a')], groups: [group] }
    wiring.reads.mockClear()
    wiring.releaseFacts.mockClear()
    const stop = startGroupRouting(vi.fn())
    const resolve = (id: string) => wiring.resolver!(id)
    const save = (snapshot: AISourcesConfig) => {
      wiring.snapshot = snapshot
      for (const listener of wiring.saved) listener(snapshot)
    }
    try {
      expect(wiring.reads).toHaveBeenCalledTimes(1)
      const first = resolve('g')!
      for (let i = 0; i < 100; i++) {
        expect(resolve(`ordinary-${i}`)).toBeNull()
        expect(resolve('g')?.name).toBe('Daily')
      }
      expect(wiring.reads).toHaveBeenCalledTimes(1)

      save({ ...wiring.snapshot!, sources: [account('a', { name: 'Renamed account' })], groups: [{ ...group, name: 'Renamed group' }] })
      expect(resolve('g')).not.toBe(first)
      expect(resolve('g')).toMatchObject({ name: 'Renamed group', members: [{ label: { account: 'Renamed account' } }, { label: { account: 'Removed account' } }] })

      expect(resolve('new-group')).toBeNull()
      save({ ...wiring.snapshot!, groups: [{ ...group, id: 'new-group' }] })
      expect(resolve('new-group')).not.toBeNull()
      expect(resolve('g')).toBeNull()
      save({ ...wiring.snapshot!, groups: [] })
      expect(resolve('new-group')).toBeNull()
      expect(wiring.reads).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
    expect(wiring.resolver).toBeNull()
    expect(wiring.saved.size).toBe(0)
    expect(wiring.releaseFacts).toHaveBeenCalledTimes(1)
  })
})

describe('a member in the form the router needs', () => {
  const backend = (extra: Partial<BackendRequestConfig> = {}): BackendRequestConfig =>
    ({ url: 'https://api.example.invalid/v1/chat/completions', key: 'k', model: 'm1', ...extra })

  it('names the account and carries the member\'s own reasoning setting', () => {
    const source = account('a', { modelOverrides: { m1: { reasoningEffort: 'high' } } })
    expect(toRouterBackend(source, backend(), 'm1')).toMatchObject({ sourceId: 'a', reasoningEffort: 'high' })
    expect(toRouterBackend(account('a'), backend(), 'm1')).not.toHaveProperty('reasoningEffort')
  })

  it('composes the endpoint of Anthropic\'s own API, which an engine would otherwise compose itself', () => {
    const source = account('a', { provider: 'anthropic' })
    expect(toRouterBackend(source, backend({ url: 'https://api.anthropic.com/' }), 'claude-sonnet-5'))
      .toMatchObject({ url: 'https://api.anthropic.com/v1/messages', apiType: 'anthropic_passthrough' })
  })

  it('leaves an OpenAI-compatible account to the router, which reads the wire from the endpoint', () => {
    expect(toRouterBackend(account('a'), backend(), 'm1')).toEqual({ ...backend(), sourceId: 'a' })
  })

  it('speaks chat completions to a managed account that names no wire', () => {
    expect(toRouterBackend(account('a', { authType: 'oauth' }), backend(), 'm1').apiType).toBe('chat_completions')
    expect(toRouterBackend(account('a', { authType: 'oauth' }), backend({ apiType: 'responses' }), 'm1').apiType).toBe('responses')
  })

  it('maps a retired Anthropic model id as a single account does, and leaves OpenAI-style ids alone', () => {
    const passthrough = toRouterBackend(account('a'), backend({ apiType: 'anthropic_passthrough', model: 'claude-mythos-preview' }), 'x')
    expect(passthrough.model).toBe('claude-sonnet-5')
    expect(toRouterBackend(account('a'), backend({ apiType: 'chat_completions', model: 'claude-mythos-preview' }), 'x').model).toBe('claude-mythos-preview')
  })

  it('carries everything else the account\'s backend decided', () => {
    const decided = backend({
      adapterId: 'codex', forceStream: true, filterContent: true, visionOverride: false, profileArn: 'arn',
      headers: { Authorization: 'Bearer token' }, codexModelCapabilities: { reasoningSummary: true, responsesLite: false },
    })
    expect(toRouterBackend(account('a', { authType: 'oauth' }), decided, 'm1')).toMatchObject(decided)
  })
})
