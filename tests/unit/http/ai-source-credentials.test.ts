import { beforeEach, describe, expect, it, vi } from 'vitest'

const { manager, writeOutcome } = vi.hoisted(() => ({ manager: {
  switchCurrentSource: vi.fn(), switchCurrentModel: vi.fn(), addSource: vi.fn(),
  updateSource: vi.fn(), deleteSource: vi.fn()
}, writeOutcome: { notSaved: null as Record<string, unknown> | null } }))
vi.mock('../../../src/main/http/routes/_shared', () => ({
  getAISourceManager: () => manager, modelCapabilitiesService: {},
  configController: { notSavedWhileConfigUnreadable: () => writeOutcome.notSaved }
}))
import { registerAiSourcesRoutes } from '../../../src/main/http/routes/ai-sources.routes'

const config = { version: 2, currentId: 'a', sources: [
  { id: 'a', accessToken: 'private-access', refreshToken: 'private-refresh', name: 'Account A' },
  { id: 'b', apiKey: 'private-api-key', name: 'Account B' }
] }

describe('AI source HTTP credential boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    for (const method of Object.values(manager)) method.mockReturnValue(config)
  })

  it.each([
    ['post', '/api/ai-sources/switch-source'],
    ['post', '/api/ai-sources/set-model'],
    ['post', '/api/ai-sources/sources'],
    ['put', '/api/ai-sources/sources/:sourceId'],
    ['delete', '/api/ai-sources/sources/:sourceId']
  ])('masks credentials in %s %s responses without changing manager state', async (method, path) => {
    const routes = new Map<string, any>()
    const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(verb => [verb, (url: string, handler: any) => routes.set(`${verb} ${url}`, handler)]))
    registerAiSourcesRoutes(app as any)
    const res = { json: vi.fn() }
    await routes.get(`${method} ${path}`)({ body: { sourceId: 'a' }, params: { sourceId: 'a' } }, res)
    const result = res.json.mock.calls[0][0]
    expect(result).toMatchObject({ success: true, data: { sources: [
      { id: 'a', accessToken: '***', refreshToken: '***' }, { id: 'b', apiKey: '***' }
    ] } })
    expect(JSON.stringify(result)).not.toContain('private-')
    expect(config.sources[0].accessToken).toBe('private-access')
  })

  describe('choosing a load-balancing group', () => {
    const answer = async (selected: Record<string, unknown>, sourceId: string) => {
      manager.switchCurrentSource.mockReturnValue({ ...config, groups: [{ id: 'g1' }], ...selected })
      const routes = new Map<string, any>()
      const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(verb => [verb, (url: string, handler: any) => routes.set(`${verb} ${url}`, handler)]))
      registerAiSourcesRoutes(app as any)
      const res = { json: vi.fn() }
      await routes.get('post /api/ai-sources/switch-source')({ body: { sourceId } }, res)
      return res.json.mock.calls[0][0]
    }

    it('takes a group as the choice while the account in use stays', async () => {
      expect(await answer({ currentGroupId: 'g1' }, 'g1')).toMatchObject({ success: true, data: { currentId: 'a', currentGroupId: 'g1' } })
    })

    it('refuses an id that is neither, and the account kept for a chosen group', async () => {
      expect(await answer({}, 'nope')).toEqual({ success: false, error: 'Source not found: nope' })
      expect(await answer({ currentGroupId: 'g1' }, 'a')).toMatchObject({ success: false })
    })
  })

  it.each([
    ['post', '/api/ai-sources/switch-source'],
    ['post', '/api/ai-sources/set-model'],
    ['post', '/api/ai-sources/sources'],
    ['put', '/api/ai-sources/sources/:sourceId'],
    ['delete', '/api/ai-sources/sources/:sourceId']
  ])('reports %s %s as not saved while the config file cannot be read', async (method, path) => {
    const notSaved = { success: false, code: 'CONFIG_UNREADABLE', error: 'Not saved' }
    writeOutcome.notSaved = notSaved
    try {
      const routes = new Map<string, any>()
      const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(verb => [verb, (url: string, handler: any) => routes.set(`${verb} ${url}`, handler)]))
      registerAiSourcesRoutes(app as any)
      const res = { json: vi.fn() }
      await routes.get(`${method} ${path}`)({ body: { sourceId: 'a' }, params: { sourceId: 'a' } }, res)
      expect(res.json).toHaveBeenCalledWith(notSaved)
    } finally {
      writeOutcome.notSaved = null
    }
  })
})
