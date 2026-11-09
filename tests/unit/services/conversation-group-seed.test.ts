/**
 * A new conversation starts on the model the user chose last: the group when
 * that was a group, the selected account otherwise.
 *
 * The service is real; only its IO boundaries (fs, space registry, config,
 * KB seed) are replaced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ value: undefined as unknown }))

vi.mock('fs', () => {
  const files = new Map<string, string>()
  return {
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      const data = files.get(p)
      if (data === undefined) throw new Error(`ENOENT: ${p}`)
      return data
    },
    writeFileSync: (p: string, data: string) => { files.set(p, data) },
    mkdirSync: () => undefined,
    readdirSync: (p: string) => [...files.keys()].filter(k => k.startsWith(p)).map(k => k.split('/').pop() as string),
    rmSync: (p: string) => { files.delete(p) },
    renameSync: (from: string, to: string) => {
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, data)
    },
  }
})
vi.mock('../../../src/main/services/space.service', () => ({
  hasSpace: () => true,
  getSpace: (spaceId: string) => ({ id: spaceId, path: `/spaces/${spaceId}`, isTemp: false }),
  touchSpaceActivity: () => undefined,
}))
vi.mock('../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [] }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => config.value }))

import { createConversation } from '../../../src/main/services/conversation.service'
import { GROUP_MODEL_ID } from '../../../src/shared/types/ai-sources'

const account = (id: string, model: string) => ({
  id, name: id, provider: 'custom', authType: 'api-key', apiUrl: '', apiKey: 'k', model, availableModels: [], createdAt: '', updatedAt: '',
})
const group = { id: 'g', name: 'Daily', strategy: 'priority', members: [], createdAt: '', updatedAt: '' }

function start(aiSources: Record<string, unknown>, engineId?: 'halo' | 'codex') {
  config.value = { aiSources }
  return createConversation('space-1', undefined, undefined, engineId ? { engineId } : undefined)
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the model a new conversation starts on', () => {
  const base = { version: 2, currentId: 'a', sources: [account('a', 'model-a')], groups: [group] }

  it('is the selected account when no group was chosen', () => {
    const conversation = start(base)
    expect([conversation.modelSourceId, conversation.modelId]).toEqual(['a', 'model-a'])
  })

  it('is the group the user chose last', () => {
    const conversation = start({ ...base, currentGroupId: 'g' })
    expect([conversation.modelSourceId, conversation.modelId]).toEqual(['g', GROUP_MODEL_ID])
  })

  it('falls back to the account when the chosen group no longer exists', () => {
    const conversation = start({ ...base, groups: [], currentGroupId: 'g' })
    expect([conversation.modelSourceId, conversation.modelId]).toEqual(['a', 'model-a'])
  })

  it('does not put a conversation on a group its engine cannot use', () => {
    const conversation = start({ ...base, currentGroupId: 'g' }, 'codex')
    expect([conversation.modelSourceId, conversation.modelId]).toEqual(['a', 'model-a'])
  })
})
