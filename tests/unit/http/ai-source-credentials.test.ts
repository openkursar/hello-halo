import { beforeEach, describe, expect, it, vi } from 'vitest'

const { manager } = vi.hoisted(() => ({ manager: {
  switchCurrentSource: vi.fn(), switchCurrentModel: vi.fn(), addSource: vi.fn(),
  updateSource: vi.fn(), deleteSource: vi.fn()
} }))
vi.mock('../../../src/main/http/routes/_shared', () => ({
  getAISourceManager: () => manager, modelCapabilitiesService: {}
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
})
