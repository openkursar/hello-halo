/**
 * The group editor's working copy: how a draft changes as someone builds a
 * group, what "use each account's current model" picks, which limits a mixed
 * group has, and what the add-model panel offers for a search.
 */

import { describe, expect, it } from 'vitest'
import {
  appendMembers,
  draftOfGroup,
  fillCurrentModels,
  groupCapabilityNotes,
  moveMember,
  newGroupDraft,
  pickerAccounts,
  planCurrentModels,
  removeMemberAt,
  type GroupDraft,
} from '../../../src/renderer/components/ai-groups/group-editor-model'
import { MAX_GROUP_MEMBERS } from '../../../src/shared/ai-groups'
import type { AIGroup, AISource, ModelOption } from '../../../src/shared/types/ai-sources'

function account(id: string, extra: Partial<AISource> = {}): AISource {
  return {
    id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
    model: `${id}-m1`, availableModels: [{ id: `${id}-m1`, name: `${id} one` }, { id: `${id}-m2`, name: `${id} two` }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  }
}

const model = (id: string, extra: Partial<ModelOption> = {}): ModelOption => ({ id, name: id, ...extra })
const draftOf = (...pairs: Array<[string, string]>): GroupDraft => ({
  name: 'G', strategy: 'priority', members: pairs.map(([sourceId, modelId]) => ({ sourceId, modelId })),
})
const ids = (draft: GroupDraft) => draft.members.map(member => `${member.sourceId}:${member.modelId}`)

describe('starting a draft', () => {
  const group: AIGroup = {
    id: 'g', name: 'Daily', strategy: 'spread', members: [{ sourceId: 'a', modelId: 'a-m1' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('names a new group so that it differs from the ones that exist', () => {
    expect(newGroupDraft([], 'My group')).toEqual({ name: 'My group', strategy: 'priority', members: [] })
    expect(newGroupDraft([{ ...group, name: 'My group' }], 'My group').name).toBe('My group 2')
  })

  it('copies a stored group, so editing the draft cannot touch the stored one', () => {
    const draft = draftOfGroup(group)
    expect(draft).toEqual({ name: 'Daily', strategy: 'spread', members: [{ sourceId: 'a', modelId: 'a-m1' }] })
    draft.members[0].modelId = 'changed'
    expect(group.members[0].modelId).toBe('a-m1')
  })
})

describe('adding models', () => {
  it('appends in the order given and skips what the draft already has', () => {
    const next = appendMembers(draftOf(['a', 'a-m1']), [{ sourceId: 'b', modelId: 'b-m1' }, { sourceId: 'a', modelId: 'a-m1' }, { sourceId: 'a', modelId: 'a-m2' }])
    expect(ids(next)).toEqual(['a:a-m1', 'b:b-m1', 'a:a-m2'])
  })

  it('allows one account with several models, but never the same pair twice', () => {
    const next = appendMembers(draftOf(), [{ sourceId: 'a', modelId: 'x' }, { sourceId: 'a', modelId: 'y' }, { sourceId: 'a', modelId: 'x' }])
    expect(ids(next)).toEqual(['a:x', 'a:y'])
  })

  it('returns the draft itself when nothing is added', () => {
    const draft = draftOf(['a', 'a-m1'])
    expect(appendMembers(draft, [])).toBe(draft)
    expect(appendMembers(draft, [{ sourceId: 'a', modelId: 'a-m1' }])).toBe(draft)
  })

  it('stops at the size of a group', () => {
    const many = Array.from({ length: MAX_GROUP_MEMBERS + 4 }, (_, index) => ({ sourceId: 'a', modelId: `m${index}` }))
    expect(appendMembers(draftOf(), many).members).toHaveLength(MAX_GROUP_MEMBERS)
  })

  it('does not change the draft it was given', () => {
    const draft = draftOf(['a', 'a-m1'])
    appendMembers(draft, [{ sourceId: 'b', modelId: 'b-m1' }])
    expect(draft.members).toHaveLength(1)
  })
})

describe('removing and reordering', () => {
  const draft = draftOf(['a', '1'], ['b', '2'], ['c', '3'])

  it('removes the model at a position', () => {
    expect(ids(removeMemberAt(draft, 1))).toEqual(['a:1', 'c:3'])
    expect(removeMemberAt(draft, 5)).toBe(draft)
    expect(removeMemberAt(draft, -1)).toBe(draft)
  })

  it('moves a model up, down or to another place', () => {
    expect(ids(moveMember(draft, 1, 0))).toEqual(['b:2', 'a:1', 'c:3'])
    expect(ids(moveMember(draft, 1, 2))).toEqual(['a:1', 'c:3', 'b:2'])
    expect(ids(moveMember(draft, 0, 2))).toEqual(['b:2', 'c:3', 'a:1'])
  })

  it('leaves the order alone for a move that goes nowhere', () => {
    expect(moveMember(draft, 1, 1)).toBe(draft)
    expect(moveMember(draft, 0, -1)).toBe(draft)
    expect(moveMember(draft, 2, 3)).toBe(draft)
    expect(moveMember(draft, 4, 0)).toBe(draft)
  })
})

describe('using each account\'s current model', () => {
  it('takes the model every usable account is set to, the account in use first', () => {
    const plan = planCurrentModels([account('a'), account('b', { model: 'b-m2' }), account('c')], 'b')
    expect(plan.members).toEqual([
      { sourceId: 'b', modelId: 'b-m2' },
      { sourceId: 'a', modelId: 'a-m1' },
      { sourceId: 'c', modelId: 'c-m1' },
    ])
    expect(plan.skipped).toEqual([])
  })

  it('keeps list order when no account is in use', () => {
    expect(planCurrentModels([account('a'), account('b')], null).members.map(m => m.sourceId)).toEqual(['a', 'b'])
  })

  it('says why an account was left out instead of dropping it silently', () => {
    const plan = planCurrentModels([
      account('ok'),
      account('cli', { authType: 'delegated', apiKey: undefined }),
      account('out', { authType: 'oauth', accessToken: '' }),
      account('blank', { model: '' }),
      account('gone', { model: 'retired' }),
    ], 'ok')
    expect(plan.members).toEqual([{ sourceId: 'ok', modelId: 'ok-m1' }])
    expect(plan.skipped).toEqual([
      { sourceId: 'cli', name: 'cli', reason: 'cli-account' },
      { sourceId: 'out', name: 'out', reason: 'not-signed-in' },
      { sourceId: 'blank', name: 'blank', reason: 'no-model' },
      { sourceId: 'gone', name: 'gone', reason: 'model-unavailable' },
    ])
  })

  it('fills in only what the list lacks and keeps the order someone already chose', () => {
    const plan = planCurrentModels([account('a'), account('b')], 'a')
    const next = appendMembers(draftOf(['b', 'b-m2'], ['b', 'b-m1']), plan.members)
    expect(ids(next)).toEqual(['b:b-m2', 'b:b-m1', 'a:a-m1'])
  })

  it('offers nothing when there are no accounts', () => {
    expect(planCurrentModels([], null)).toEqual({ members: [], skipped: [] })
  })
})

describe('filling a draft from the accounts', () => {
  const cli = account('cli', { authType: 'delegated', apiKey: undefined })

  it('appends what the draft lacks after what is there', () => {
    const filled = fillCurrentModels(draftOf(['b', 'b-m2']), [account('a'), account('b')], 'a')
    expect(ids(filled.draft)).toEqual(['b:b-m2', 'a:a-m1', 'b:b-m1'])
    expect(filled.added).toBe(true)
    expect(filled.skipped).toEqual([])
  })

  it('adds nothing, and says so, when every usable account is already in', () => {
    const draft = draftOf(['a', 'a-m1'])
    const filled = fillCurrentModels(draft, [account('a')], 'a')
    expect(filled.draft).toBe(draft)
    expect(filled.added).toBe(false)
    expect(filled.skipped).toEqual([])
  })

  it('reports the accounts that cannot serve, alongside the ones it added', () => {
    const filled = fillCurrentModels(draftOf(), [account('a'), cli], 'a')
    expect(ids(filled.draft)).toEqual(['a:a-m1'])
    expect(filled.skipped).toEqual([{ sourceId: 'cli', name: 'cli', reason: 'cli-account' }])
  })

  it('accounts for an account the group has no room left for', () => {
    const nearlyFull = draftOf(...Array.from({ length: MAX_GROUP_MEMBERS - 1 }, (_, index): [string, string] => ['x', `m${index}`]))
    const filled = fillCurrentModels(nearlyFull, [account('a'), account('b')], 'a')
    expect(filled.draft.members).toHaveLength(MAX_GROUP_MEMBERS)
    expect(filled.draft.members.at(-1)).toEqual({ sourceId: 'a', modelId: 'a-m1' })
    expect(filled.skipped).toEqual([{ sourceId: 'b', name: 'b', reason: 'limit' }])
  })

  it('reports every account when a full group has room for none', () => {
    const full = draftOf(...Array.from({ length: MAX_GROUP_MEMBERS }, (_, index): [string, string] => ['x', `m${index}`]))
    const filled = fillCurrentModels(full, [account('a')], 'a')
    expect(filled.draft).toBe(full)
    expect(filled.added).toBe(false)
    expect(filled.skipped).toEqual([{ sourceId: 'a', name: 'a', reason: 'limit' }])
  })
})

describe('what a mixed group gives up', () => {
  const sized = (id: string, contextWindow?: number, supportsVision?: boolean) => account(id, {
    availableModels: [{ id: `${id}-m1`, name: `${id} one`, supportsVision, ...(contextWindow ? { capabilities: { contextWindow } } : {}) } as ModelOption],
  })
  const all = [sized('big', 1_000_000, true), sized('small', 128_000, false), sized('mystery')]
  const pair = (...names: string[]) => names.map(name => ({ sourceId: name, modelId: `${name}-m1` }))

  it('says nothing about a lone model or models that match', () => {
    expect(groupCapabilityNotes(pair('big'), all)).toEqual([])
    expect(groupCapabilityNotes(pair('big', 'big'), [sized('big', 200_000, true)])).toEqual([])
    expect(groupCapabilityNotes([], all)).toEqual([])
  })

  it('names the model that lowers the context size and the one that rules out images', () => {
    expect(groupCapabilityNotes(pair('big', 'small'), all)).toEqual([
      { kind: 'context-limit', tokens: 128_000, member: { sourceId: 'small', modelId: 'small-m1' } },
      { kind: 'images-off', member: { sourceId: 'small', modelId: 'small-m1' } },
    ])
  })

  it('calls what the catalog does not state unconfirmed, never supported', () => {
    expect(groupCapabilityNotes(pair('big', 'mystery'), all)).toEqual([
      { kind: 'context-unconfirmed', count: 1 },
      { kind: 'images-unconfirmed', count: 1 },
    ])
  })

  it('has nothing to compare when no model states anything', () => {
    expect(groupCapabilityNotes(pair('mystery', 'mystery'), [sized('mystery')])).toEqual([])
  })

  it('counts a model whose account is gone as unconfirmed', () => {
    expect(groupCapabilityNotes([{ sourceId: 'gone', modelId: 'x' }, ...pair('small')], all)).toEqual([{ kind: 'context-unconfirmed', count: 1 }])
  })
})

describe('what the add-model panel lists', () => {
  const sources = [
    account('Claude', { provider: 'anthropic', authType: 'oauth', accessToken: 'tok', user: { name: 'amy@example.com' } as AISource['user'], availableModels: [model('claude-sonnet', { name: 'Sonnet' }), model('claude-haiku', { name: 'Haiku' })] }),
    account('Signed out', { authType: 'oauth', accessToken: '' }),
    account('Claude CLI', { authType: 'delegated', apiKey: undefined }),
    account('DeepSeek', { availableModels: [model('deepseek-chat', { name: 'Chat' })] }),
  ]

  it('lists the accounts that can join first, then those that cannot with their reason', () => {
    const accounts = pickerAccounts(sources, '')
    expect(accounts.map(item => item.source.id)).toEqual(['Claude', 'DeepSeek', 'Signed out', 'Claude CLI'])
    expect(accounts.map(item => item.unusable)).toEqual([undefined, undefined, 'not-signed-in', 'cli-account'])
  })

  it('narrows models by a word from the account, the model or both', () => {
    const named = (query: string) => pickerAccounts(sources, query).flatMap(item => item.models.map(m => `${item.source.id}/${m.id}`))
    expect(named('haiku')).toEqual(['Claude/claude-haiku'])
    expect(named('claude sonnet')).toEqual(['Claude/claude-sonnet'])
    expect(named('AMY@')).toEqual(['Claude/claude-sonnet', 'Claude/claude-haiku'])
    expect(named('  deepseek   chat ')).toEqual(['DeepSeek/deepseek-chat'])
  })

  it('keeps an account that cannot join when the search names it, so it can be explained', () => {
    const accounts = pickerAccounts(sources, 'signed')
    expect(accounts.map(item => item.source.id)).toEqual(['Signed out'])
    expect(accounts[0].unusable).toBe('not-signed-in')
  })

  it('finds nothing for a word that matches nothing', () => {
    expect(pickerAccounts(sources, 'zzz')).toEqual([])
  })
})
