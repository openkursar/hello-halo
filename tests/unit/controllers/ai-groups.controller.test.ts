/**
 * The group operations as the transports answer them: the same envelope over
 * IPC and HTTP, credentials masked, rejected changes carrying their code.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  getHealthOfGroup: vi.fn(),
  releaseGroupRest: vi.fn(),
  getGroupRoutes: vi.fn(),
}))
const notSaved = vi.hoisted(() => ({ value: null as unknown }))
const emitConfigChange = vi.hoisted(() => vi.fn())

vi.mock('../../../src/main/services/ai-sources', async () => {
  class GroupError extends Error {
    constructor(readonly code: string, readonly memberIndex?: number) { super(`rejected: ${code}`) }
  }
  return { ...service, GroupError }
})
vi.mock('../../../src/main/controllers/config.controller', () => ({ notSavedWhileConfigUnreadable: () => notSaved.value }))
vi.mock('../../../src/main/services/health', () => ({ emitConfigChange }))
vi.mock('../../../src/main/foundation/config-encryption', () => ({
  maskOAuthFields: (value: { aiSources: { sources: Array<Record<string, unknown>> } }) => ({
    aiSources: { ...value.aiSources, sources: value.aiSources.sources.map(source => ({ ...source, accessToken: '***' })) },
  }),
}))

import {
  createGroupAnswer,
  deleteGroupAnswer,
  groupHealthAnswer,
  groupRoutesAnswer,
  releaseGroupRestAnswer,
  updateGroupAnswer,
} from '../../../src/main/controllers/ai-groups.controller'
import { GroupError } from '../../../src/main/services/ai-sources'

const aiSources = { version: 2, currentId: 'a', sources: [{ id: 'a', accessToken: 'secret' }], groups: [] }
const input = { name: 'Daily', members: [{ sourceId: 'a', modelId: 'm' }] }

beforeEach(() => {
  vi.clearAllMocks()
  notSaved.value = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('changing a group', () => {
  it('answers with the new group\'s id and the configuration, credentials masked, and tells the app', () => {
    service.createGroup.mockReturnValue({ aiSources, group: { id: 'g' } })
    const answer = createGroupAnswer(input)
    expect(answer).toEqual({ success: true, data: { aiSources: expect.objectContaining({ sources: [{ id: 'a', accessToken: '***' }] }), groupId: 'g' } })
    expect(JSON.stringify(answer)).not.toContain('secret')
    expect(emitConfigChange).toHaveBeenCalledWith(['aiSources.groups'])
  })

  it('does the same for an edit and a deletion', () => {
    service.updateGroup.mockReturnValue({ aiSources, group: { id: 'g' } })
    expect(updateGroupAnswer('g', input)).toMatchObject({ success: true, data: { groupId: 'g' } })
    expect(service.updateGroup).toHaveBeenCalledWith('g', input)
    service.deleteGroup.mockReturnValue({ aiSources })
    const deleted = deleteGroupAnswer('g')
    expect(deleted).toMatchObject({ success: true })
    expect(JSON.stringify(deleted)).not.toContain('secret')
    expect(emitConfigChange).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected change with its code and the model it concerns, and tells nobody', () => {
    service.createGroup.mockImplementation(() => { throw new GroupError('unknown-model' as never, 2) })
    expect(createGroupAnswer(input)).toEqual({ success: false, error: 'rejected: unknown-model', code: 'unknown-model', memberIndex: 2 })
    expect(emitConfigChange).not.toHaveBeenCalled()
  })

  it('leaves out the position when the rejection has none', () => {
    service.deleteGroup.mockImplementation(() => { throw new GroupError('not-found' as never) })
    expect(deleteGroupAnswer('g')).toEqual({ success: false, error: 'rejected: not-found', code: 'not-found' })
  })

  it('reports anything else by its message', () => {
    service.updateGroup.mockImplementation(() => { throw new Error('disk full') })
    expect(updateGroupAnswer('g', input)).toEqual({ success: false, error: 'disk full' })
  })

  it('says so when the settings file could not be written', () => {
    service.createGroup.mockReturnValue({ aiSources, group: { id: 'g' } })
    notSaved.value = { success: false, code: 'CONFIG_UNREADABLE', error: 'Not saved' }
    expect(createGroupAnswer(input)).toEqual({ success: false, code: 'CONFIG_UNREADABLE', error: 'Not saved' })
  })
})

describe('asking how the models stand', () => {
  it('answers with the group\'s health, or that it is gone', () => {
    service.getHealthOfGroup.mockReturnValueOnce({ groupId: 'g', members: [] }).mockReturnValueOnce(null)
    expect(groupHealthAnswer('g')).toEqual({ success: true, data: { groupId: 'g', members: [] } })
    expect(groupHealthAnswer('missing')).toMatchObject({ success: false, code: 'not-found' })
  })

  it('releases rests and says how many', () => {
    service.releaseGroupRest.mockReturnValue(2)
    expect(releaseGroupRestAnswer('g', 'key')).toEqual({ success: true, data: { released: 2 } })
    expect(service.releaseGroupRest).toHaveBeenCalledWith('g', 'key')
  })

  it('takes only a real key to release one model, and otherwise releases the whole group', () => {
    service.releaseGroupRest.mockReturnValue(0)
    for (const bad of [undefined, null, 7, { key: 'x' }, '', 'k'.repeat(2000)]) {
      releaseGroupRestAnswer('g', bad)
      expect(service.releaseGroupRest).toHaveBeenLastCalledWith('g', undefined)
    }
  })

  it('asks for only the conversations it was given, and no more than a bounded number', () => {
    service.getGroupRoutes.mockReturnValue([])
    groupRoutesAnswer(['a', 7, 'b', null])
    expect(service.getGroupRoutes).toHaveBeenLastCalledWith(['a', 'b'])
    groupRoutesAnswer(Array.from({ length: 100 }, (_, i) => `c${i}`))
    expect(service.getGroupRoutes.mock.calls.at(-1)![0]).toHaveLength(64)
    groupRoutesAnswer('not a list')
    expect(service.getGroupRoutes).toHaveBeenLastCalledWith([])
  })
})
