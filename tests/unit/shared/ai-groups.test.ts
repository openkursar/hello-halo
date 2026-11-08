import { describe, expect, it } from 'vitest'
import {
  MAX_GROUPS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_LENGTH,
  combineCapabilityFacts,
  describeGroupMember,
  describeMemberFacts,
  groupMemberKey,
  isSourceGroupEligible,
  listSourceModels,
  normalizeGroups,
  suggestGroupName,
  validateGroupInput,
} from '../../../src/shared/ai-groups'
import type { AIGroup, AISource } from '../../../src/shared/types/ai-sources'

function source(id: string, extra: Partial<AISource> = {}): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid/v1', apiKey: 'test-key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: 'M1' }, { id: `${id}-m2`, name: 'M2' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  }
}

function group(id: string, name: string, members: Array<[string, string]>): AIGroup {
  return {
    id, name, strategy: 'priority', members: members.map(([sourceId, modelId]) => ({ sourceId, modelId })),
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const sources = [source('a'), source('b')]

describe('listSourceModels', () => {
  it('prefers the account list, then the vendor defaults for Anthropic, then the current model', () => {
    expect(listSourceModels(source('a')).map(m => m.id)).toEqual(['a-m1', 'a-m2'])
    expect(listSourceModels(source('x', { provider: 'anthropic', availableModels: [] })).length).toBeGreaterThan(1)
    expect(listSourceModels(source('y', { availableModels: [], model: 'only' }))).toEqual([{ id: 'only', name: 'only' }])
    expect(listSourceModels(source('z', { availableModels: [], model: '' }))).toEqual([])
  })
})

describe('isSourceGroupEligible', () => {
  it('excludes the Claude Code CLI account and accounts that cannot send a request', () => {
    expect(isSourceGroupEligible(source('a'))).toBe(true)
    expect(isSourceGroupEligible(source('d', { authType: 'delegated' }))).toBe(false)
    expect(isSourceGroupEligible(source('k', { apiKey: '' }))).toBe(false)
    expect(isSourceGroupEligible(source('o', { authType: 'oauth', accessToken: 'test-token' }))).toBe(true)
    expect(isSourceGroupEligible(source('o2', { authType: 'oauth', accessToken: '' }))).toBe(false)
  })
})

describe('validateGroupInput', () => {
  const valid = { name: '  Daily   work ', strategy: 'spread', members: [{ sourceId: 'a', modelId: 'a-m1' }, { sourceId: 'b', modelId: 'b-m2' }] }

  it('accepts a well-formed group and returns it cleaned', () => {
    expect(validateGroupInput(valid, sources, [])).toEqual({
      ok: true,
      value: { name: 'Daily work', strategy: 'spread', members: valid.members },
    })
  })

  it('defaults the strategy to priority', () => {
    const result = validateGroupInput({ ...valid, strategy: undefined }, sources, [])
    expect(result).toMatchObject({ ok: true, value: { strategy: 'priority' } })
  })

  it.each([
    [null, 'invalid-input'],
    ['text', 'invalid-input'],
    [{ ...valid, name: 42 }, 'name-empty'],
    [{ ...valid, name: '   ' }, 'name-empty'],
    [{ ...valid, name: 'x'.repeat(MAX_GROUP_NAME_LENGTH + 1) }, 'name-too-long'],
    [{ ...valid, strategy: 'random' }, 'invalid-strategy'],
    [{ ...valid, members: 'a' }, 'invalid-input'],
    [{ ...valid, members: [] }, 'no-members'],
  ])('rejects %j as %s', (input, code) => {
    expect(validateGroupInput(input, sources, [])).toEqual({ ok: false, issue: { code } })
  })

  it('rejects more than the member limit', () => {
    const many = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, i) => ({ sourceId: 'a', modelId: `m${i}` }))
    expect(validateGroupInput({ ...valid, members: many }, sources, [])).toEqual({ ok: false, issue: { code: 'too-many-members' } })
  })

  it('refuses another group once there are as many as are allowed, but still lets one of them be edited', () => {
    const existing = Array.from({ length: MAX_GROUPS }, (_, i) => group(`g${i}`, `Group ${i}`, [['a', 'a-m1']]))
    expect(validateGroupInput(valid, sources, existing)).toEqual({ ok: false, issue: { code: 'too-many-groups' } })
    expect(validateGroupInput(valid, sources, existing, existing[0]).ok).toBe(true)
    expect(validateGroupInput(valid, sources, existing.slice(1)).ok).toBe(true)
  })

  it('names the member that is wrong', () => {
    expect(validateGroupInput({ ...valid, members: [valid.members[0], { sourceId: 'a' }] }, sources, []))
      .toEqual({ ok: false, issue: { code: 'invalid-member', memberIndex: 1 } })
    expect(validateGroupInput({ ...valid, members: [valid.members[0], valid.members[0]] }, sources, []))
      .toEqual({ ok: false, issue: { code: 'duplicate-member', memberIndex: 1 } })
    expect(validateGroupInput({ ...valid, members: [{ sourceId: 'gone', modelId: 'm' }] }, sources, []))
      .toEqual({ ok: false, issue: { code: 'unknown-source', memberIndex: 0 } })
    expect(validateGroupInput({ ...valid, members: [{ sourceId: 'a', modelId: 'nope' }] }, sources, []))
      .toEqual({ ok: false, issue: { code: 'unknown-model', memberIndex: 0 } })
  })

  it('allows one account to hold several models but not the same model twice', () => {
    const result = validateGroupInput({ ...valid, members: [{ sourceId: 'a', modelId: 'a-m1' }, { sourceId: 'a', modelId: 'a-m2' }] }, sources, [])
    expect(result.ok).toBe(true)
  })

  it('rejects accounts that cannot join, including the CLI account', () => {
    const list = [...sources, source('d', { authType: 'delegated' }), source('nokey', { apiKey: '' })]
    expect(validateGroupInput({ ...valid, members: [{ sourceId: 'd', modelId: 'd-m1' }] }, list, []))
      .toEqual({ ok: false, issue: { code: 'unsupported-source', memberIndex: 0 } })
    expect(validateGroupInput({ ...valid, members: [{ sourceId: 'nokey', modelId: 'nokey-m1' }] }, list, []))
      .toEqual({ ok: false, issue: { code: 'unsupported-source', memberIndex: 0 } })
  })

  it('rejects a name another group uses, ignoring case and spacing, but not the group being edited', () => {
    const existing = group('g1', 'Daily Work', [['a', 'a-m1']])
    expect(validateGroupInput(valid, sources, [existing])).toEqual({ ok: false, issue: { code: 'name-duplicate' } })
    expect(validateGroupInput(valid, sources, [existing], existing).ok).toBe(true)
  })

  it('keeps a member the group already holds after its model left the account list or the account signed out', () => {
    const list = [source('a', { availableModels: [{ id: 'a-m2', name: 'M2' }] }), source('o', { authType: 'oauth', accessToken: '' })]
    const stored = group('g1', 'Daily', [['a', 'a-m1'], ['o', 'o-m1']])
    const input = { name: 'Daily', members: [{ sourceId: 'a', modelId: 'a-m1' }, { sourceId: 'o', modelId: 'o-m1' }] }
    expect(validateGroupInput(input, list, [stored], stored).ok).toBe(true)
    expect(validateGroupInput(input, list, [], undefined)).toMatchObject({ ok: false })
  })

  it('never keeps a delegated account, even as an existing member', () => {
    const list = [source('d', { authType: 'delegated' })]
    const stored = group('g1', 'Daily', [['d', 'd-m1']])
    expect(validateGroupInput({ name: 'Daily', members: [{ sourceId: 'd', modelId: 'd-m1' }] }, list, [stored], stored))
      .toEqual({ ok: false, issue: { code: 'unsupported-source', memberIndex: 0 } })
  })
})

describe('normalizeGroups', () => {
  const now = '2026-02-02T00:00:00.000Z'

  it('returns nothing for data that is not a list', () => {
    expect(normalizeGroups(undefined, now)).toEqual([])
    expect(normalizeGroups({}, now)).toEqual([])
  })

  it('drops damaged entries and keeps the rest', () => {
    const raw = [
      null, 'x', { id: '', name: 'n', members: [] }, { id: 'g0', name: '   ', members: [] }, { id: 'g9', name: 'n', members: 'm' },
      { id: 'g1', name: ' Daily ', strategy: 'spread', members: [{ sourceId: 'a', modelId: 'm1' }, { sourceId: 'a', modelId: 'm1' }, { sourceId: 'a' }, null] },
      { id: 'g1', name: 'Duplicate id', members: [] },
    ]
    expect(normalizeGroups(raw, now)).toEqual([{
      id: 'g1', name: 'Daily', strategy: 'spread', members: [{ sourceId: 'a', modelId: 'm1' }], createdAt: now, updatedAt: now,
    }])
  })

  it('repairs an unknown strategy, keeps stored timestamps and bounds the lists', () => {
    const members = Array.from({ length: MAX_GROUP_MEMBERS + 4 }, (_, i) => ({ sourceId: 'a', modelId: `m${i}` }))
    const [result] = normalizeGroups([{ id: 'g', name: 'x'.repeat(MAX_GROUP_NAME_LENGTH + 20), strategy: 'weird', members, createdAt: 'c', updatedAt: 'u' }], now)
    expect(result.strategy).toBe('priority')
    expect(result.name).toHaveLength(MAX_GROUP_NAME_LENGTH)
    expect(result.members).toHaveLength(MAX_GROUP_MEMBERS)
    expect([result.createdAt, result.updatedAt]).toEqual(['c', 'u'])
  })
})

describe('suggestGroupName', () => {
  it('numbers a name another group uses', () => {
    const groups = [group('1', 'My group', []), group('2', 'my group 2', [])]
    expect(suggestGroupName('My group', [])).toBe('My group')
    expect(suggestGroupName('My group', groups)).toBe('My group 3')
  })
})

describe('combineCapabilityFacts', () => {
  it('takes the smallest known limits and says which member sets them', () => {
    const envelope = combineCapabilityFacts([
      { contextWindow: 1_000_000, maxOutputTokens: 64_000, vision: true },
      { contextWindow: 200_000, maxOutputTokens: 32_000, vision: true },
      { contextWindow: 400_000, maxOutputTokens: 128_000, vision: true },
    ])
    expect(envelope).toEqual({
      contextWindow: 200_000, contextWindowSetBy: 1, maxOutputTokens: 32_000, maxOutputTokensSetBy: 1,
      vision: true, contextWindowUnknown: [],
    })
  })

  it('promises images only when no member lacks them', () => {
    expect(combineCapabilityFacts([{ vision: true }, { vision: false }, { vision: true }]))
      .toMatchObject({ vision: false, visionBlockedBy: 1 })
    expect(combineCapabilityFacts([{ vision: true }, {}]).vision).toBeUndefined()
    expect(combineCapabilityFacts([{ vision: false }, {}])).toMatchObject({ vision: false, visionBlockedBy: 0 })
  })

  it('does not treat an unknown limit as zero and reports which are unknown', () => {
    const envelope = combineCapabilityFacts([{ contextWindow: 128_000 }, {}, { contextWindow: 0 }])
    expect(envelope.contextWindow).toBe(128_000)
    expect(envelope.contextWindowUnknown).toEqual([1, 2])
  })

  it('promises nothing for an empty group', () => {
    expect(combineCapabilityFacts([])).toEqual({ contextWindowUnknown: [] })
  })
})

describe('describeMemberFacts', () => {
  it('lets the user\'s own settings win over the catalog', () => {
    const s = source('a', {
      availableModels: [{ id: 'a-m1', name: 'M1', supportsVision: true, capabilities: { contextWindow: 200_000, maxOutputTokens: 8_000 } }],
      modelOverrides: { 'a-m1': { contextWindow: 100_000, vision: false } },
    })
    expect(describeMemberFacts(s, 'a-m1')).toEqual({ contextWindow: 100_000, maxOutputTokens: 8_000, vision: false })
    expect(describeMemberFacts(s, 'other')).toEqual({ contextWindow: undefined, maxOutputTokens: undefined, vision: undefined })
  })
})

describe('groupMemberKey', () => {
  it('keeps account and model apart, so neighbouring pairs never collide', () => {
    expect(groupMemberKey({ sourceId: 'a', modelId: 'bc' })).not.toBe(groupMemberKey({ sourceId: 'ab', modelId: 'c' }))
  })
})

describe('describeGroupMember', () => {
  it('names the account and the model the way a picker does', () => {
    expect(describeGroupMember(source('a'), 'a-m2')).toEqual({ account: 'a', model: 'M2' })
  })

  it('tells two accounts of one vendor apart by who is signed in', () => {
    const signedIn = source('o', { name: 'Claude', authType: 'oauth', user: { name: 'amy@example.com' } as AISource['user'] })
    expect(describeGroupMember(signedIn, 'o-m1').account).toBe('Claude · amy@example.com')
  })

  it('falls back to the provider when an account has no name, and to the model id when the model is not listed', () => {
    expect(describeGroupMember(source('a', { name: '' }), 'unlisted')).toEqual({ account: 'custom', model: 'unlisted' })
  })

  it('does not fail on an account that has been removed', () => {
    expect(describeGroupMember(null, 'gone')).toEqual({ account: 'Removed account', model: 'gone' })
    expect(describeGroupMember(undefined, 'gone').model).toBe('gone')
  })
})
