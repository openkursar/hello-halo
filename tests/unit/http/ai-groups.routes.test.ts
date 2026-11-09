/**
 * What a remote client receives from the group routes: the same answers as the
 * desktop, but with every account's key hidden, since a remote client has no
 * need of it and the desktop answer only hides managed tokens.
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

vi.mock('../../../src/main/services/ai-sources', async () => {
  class GroupError extends Error {
    constructor(readonly code: string, readonly memberIndex?: number) { super(`rejected: ${code}`) }
  }
  return { ...service, GroupError }
})
vi.mock('../../../src/main/controllers/config.controller', () => ({ notSavedWhileConfigUnreadable: () => null }))
vi.mock('../../../src/main/services/health', () => ({ emitConfigChange: vi.fn() }))

import { registerAiGroupsRoutes } from '../../../src/main/http/routes/ai-groups.routes'

const aiSources = {
  version: 2,
  currentId: 'a',
  sources: [
    { id: 'a', name: 'Account A', apiKey: 'private-api-key' },
    { id: 'o', name: 'Account O', accessToken: 'private-access', refreshToken: 'private-refresh' },
  ],
  groups: [{ id: 'g', name: 'Daily' }],
}

function routes() {
  const handlers = new Map<string, (req: unknown, res: { json: (value: unknown) => void }) => void>()
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(verb => [verb, (url: string, handler: never) => handlers.set(`${verb} ${url}`, handler)]))
  registerAiGroupsRoutes(app as never)
  return (route: string, request: object) => {
    const res = { json: vi.fn() }
    handlers.get(route)!(request, res)
    return res.json.mock.calls[0][0]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  service.createGroup.mockReturnValue({ aiSources, group: { id: 'g' } })
  service.updateGroup.mockReturnValue({ aiSources, group: { id: 'g' } })
  service.deleteGroup.mockReturnValue({ aiSources })
})

describe('group changes over HTTP', () => {
  it.each([
    ['post /api/ai-groups', { body: { name: 'Daily', members: [] } }],
    ['put /api/ai-groups/:groupId', { params: { groupId: 'g' }, body: { name: 'Daily', members: [] } }],
    ['delete /api/ai-groups/:groupId', { params: { groupId: 'g' } }],
  ])('%s hides every key and token and still answers with the configuration', (route, request) => {
    const answer = routes()(route, request) as { success: boolean; data: { aiSources: typeof aiSources } }
    expect(answer.success).toBe(true)
    expect(JSON.stringify(answer)).not.toContain('private-')
    expect(answer.data.aiSources.sources.map(source => source.id)).toEqual(['a', 'o'])
    expect(answer.data.aiSources.groups).toEqual([{ id: 'g', name: 'Daily' }])
  })

  it('leaves what the service holds untouched', () => {
    routes()('post /api/ai-groups', { body: { name: 'Daily', members: [] } })
    expect(aiSources.sources[0].apiKey).toBe('private-api-key')
  })

  it('passes a refusal through without a configuration to mask', () => {
    service.createGroup.mockImplementation(() => { throw new (class extends Error { code = 'name-empty' })('rejected') })
    const answer = routes()('post /api/ai-groups', { body: {} }) as { success: boolean; data?: unknown }
    expect(answer.success).toBe(false)
    expect(answer.data).toBeUndefined()
  })
})
