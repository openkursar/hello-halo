/**
 * The stored list of load-balancing groups and the rules for changing it.
 * The configuration lives in an in-memory store standing in for config.json.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown>, saves: 0 }))
const forgetGroup = vi.hoisted(() => vi.fn())
const ids = vi.hoisted(() => ({ n: 0 }))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => store.value,
  saveConfig: (patch: Record<string, unknown>) => {
    store.saves += 1
    store.value = { ...store.value, ...patch }
  },
}))
vi.mock('../../../../src/main/openai-compat-router', () => ({ forgetGroup }))
vi.mock('uuid', () => ({ v4: () => `id-${++ids.n}` }))

import {
  GroupError,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  selectGroup,
  updateGroup,
} from '../../../../src/main/services/ai-sources/groups'
import type { AIGroup, AISource, AISourcesConfig } from '../../../../src/shared/types/ai-sources'

const account = (id: string, extra: Partial<AISource> = {}): AISource => ({
  id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
  model: 'm1', availableModels: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
})

const aiSources = (): AISourcesConfig => store.value.aiSources as AISourcesConfig
const input = (extra: Record<string, unknown> = {}) => ({
  name: 'Daily',
  strategy: 'priority',
  members: [{ sourceId: 'a', modelId: 'm1' }, { sourceId: 'b', modelId: 'm2' }],
  ...extra,
})

beforeEach(() => {
  ids.n = 0
  store.saves = 0
  forgetGroup.mockReset()
  store.value = { aiSources: { version: 2, currentId: 'a', sources: [account('a'), account('b')] } }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('creating a group', () => {
  it('stores it beside the accounts, untouched, and returns the new group', () => {
    const before = aiSources().sources
    const { group, aiSources: saved } = createGroup(input())
    expect(group).toMatchObject({ id: 'id-1', name: 'Daily', strategy: 'priority', members: input().members })
    expect(Date.parse(group.createdAt)).not.toBeNaN()
    expect(group.updatedAt).toBe(group.createdAt)
    expect(saved).toBe(aiSources())
    expect(aiSources().groups).toEqual([group])
    expect(aiSources().sources).toBe(before)
    expect(aiSources().currentId).toBe('a')
    expect(store.saves).toBe(1)
  })

  it('does not choose the group for anyone', () => {
    createGroup(input())
    expect(aiSources().currentGroupId).toBeUndefined()
  })

  it('numbers groups apart from accounts', () => {
    store.value = { aiSources: { version: 2, currentId: 'a', sources: [account('id-1'), account('b')] } }
    expect(createGroup(input({ members: [{ sourceId: 'b', modelId: 'm1' }] })).group.id).toBe('id-2')
  })

  it.each([
    [{ name: '  ' }, 'name-empty'],
    [{ members: [] }, 'no-members'],
    [{ members: [{ sourceId: 'gone', modelId: 'm1' }] }, 'unknown-source'],
    [{ members: [{ sourceId: 'a', modelId: 'nope' }] }, 'unknown-model'],
    [{ strategy: 'random' }, 'invalid-strategy'],
  ])('refuses %j with %s and saves nothing', (change, code) => {
    expect(() => createGroup(input(change))).toThrow(GroupError)
    try {
      createGroup(input(change))
    } catch (error) {
      expect((error as GroupError).code).toBe(code)
    }
    expect(store.saves).toBe(0)
    expect(aiSources().groups).toBeUndefined()
  })

  it('names the model that was refused', () => {
    try {
      createGroup(input({ members: [{ sourceId: 'a', modelId: 'm1' }, { sourceId: 'a', modelId: 'nope' }] }))
      expect.unreachable()
    } catch (error) {
      expect((error as GroupError).memberIndex).toBe(1)
      expect((error as GroupError).message).toBe('One of the models is not offered by its account')
    }
  })

  it('refuses a name another group uses', () => {
    createGroup(input())
    expect(() => createGroup(input({ name: ' daily ' }))).toThrow('Another group already has this name')
  })

  it('refuses the Claude Code CLI account and an account that is not signed in', () => {
    store.value = {
      aiSources: {
        version: 2, currentId: 'a',
        sources: [account('a'), account('cli', { authType: 'delegated', apiKey: undefined }), account('out', { authType: 'oauth', accessToken: '' })],
      },
    }
    expect(() => createGroup(input({ members: [{ sourceId: 'cli', modelId: 'm1' }] }))).toThrow('cannot be used in a group')
    expect(() => createGroup(input({ members: [{ sourceId: 'out', modelId: 'm1' }] }))).toThrow('cannot be used in a group')
  })
})

describe('editing a group', () => {
  let group: AIGroup
  beforeEach(() => {
    group = createGroup(input()).group
    store.saves = 0
  })

  it('replaces its name, strategy and models and keeps its identity', () => {
    const { group: updated } = updateGroup(group.id, input({
      name: 'Renamed', strategy: 'spread', members: [{ sourceId: 'b', modelId: 'm1' }],
    }))
    expect(updated).toMatchObject({ id: group.id, name: 'Renamed', strategy: 'spread', members: [{ sourceId: 'b', modelId: 'm1' }], createdAt: group.createdAt })
    expect(aiSources().groups).toEqual([updated])
    expect(store.saves).toBe(1)
  })

  it('may keep its own name', () => {
    expect(() => updateGroup(group.id, input())).not.toThrow()
  })

  it('keeps a model whose account dropped it from its list, so an unrelated edit still saves', () => {
    store.value = { aiSources: { ...aiSources(), sources: [account('a', { availableModels: [{ id: 'm2', name: 'M2' }] }), account('b')] } }
    expect(() => updateGroup(group.id, input({ name: 'Renamed' }))).not.toThrow()
  })

  it('refuses a group that does not exist', () => {
    expect(() => updateGroup('missing', input())).toThrow('no longer exists')
  })

  it('leaves the stored group alone when the change is refused', () => {
    expect(() => updateGroup(group.id, input({ members: [] }))).toThrow(GroupError)
    expect(aiSources().groups).toEqual([group])
    expect(store.saves).toBe(0)
  })
})

describe('deleting a group', () => {
  it('removes it, forgets its conversations and saves the new snapshot', () => {
    const { group } = createGroup(input())
    const other = createGroup(input({ name: 'Other' })).group
    store.saves = 0
    deleteGroup(group.id)
    expect(aiSources().groups).toEqual([other])
    expect(forgetGroup).toHaveBeenCalledWith(group.id)
    expect(store.saves).toBe(1)
  })

  it('stops new conversations starting on it, but not on another chosen group', () => {
    const first = createGroup(input()).group
    const second = createGroup(input({ name: 'Other' })).group
    selectGroup(first.id)
    deleteGroup(first.id)
    expect(aiSources()).not.toHaveProperty('currentGroupId')
    selectGroup(second.id)
    deleteGroup(createGroup(input({ name: 'Third' })).group.id)
    expect(aiSources().currentGroupId).toBe(second.id)
  })

  it('refuses a group that does not exist', () => {
    expect(() => deleteGroup('missing')).toThrow('no longer exists')
  })
})

describe('choosing a group', () => {
  it('records it without moving the selected account', () => {
    const { group } = createGroup(input())
    selectGroup(group.id)
    expect(aiSources()).toMatchObject({ currentId: 'a', currentGroupId: group.id })
  })

  it('writes nothing when it is already chosen', () => {
    const { group } = createGroup(input())
    selectGroup(group.id)
    store.saves = 0
    selectGroup(group.id)
    expect(store.saves).toBe(0)
  })

  it('refuses a group that does not exist', () => {
    expect(() => selectGroup('missing')).toThrow('no longer exists')
  })
})

describe('reading groups', () => {
  it('repairs what a damaged file holds', () => {
    store.value = {
      aiSources: {
        version: 2, currentId: 'a', sources: [account('a')],
        groups: [null, { id: 'g', name: 'Fine', strategy: 'weird', members: [{ sourceId: 'a', modelId: 'm1' }, { bad: true }] }],
      },
    }
    expect(listGroups()).toEqual([expect.objectContaining({ id: 'g', name: 'Fine', strategy: 'priority', members: [{ sourceId: 'a', modelId: 'm1' }] })])
    expect(getGroup('g')?.name).toBe('Fine')
    expect(getGroup('missing')).toBeNull()
  })

  it('reads none from a configuration that has never had any', () => {
    expect(listGroups()).toEqual([])
    store.value = {}
    expect(listGroups()).toEqual([])
  })
})
