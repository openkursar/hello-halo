import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ electron: false, httpRequest: vi.fn() }))
vi.mock('../../../src/renderer/api/_shared', () => ({ isElectron: () => transport.electron, httpRequest: transport.httpRequest }))
import { gitApi } from '../../../src/renderer/api/git.api'

beforeEach(() => { vi.resetAllMocks(); transport.electron = false })
afterEach(() => { vi.unstubAllGlobals() })

describe('repository path requests', () => {
  it('forwards known/shallow selection unchanged over HTTP', async () => {
    for (const shallow of [false, true]) {
      const result = { success: true, data: { git: { available: true, version: '2' }, repositories: [] } }
      transport.httpRequest.mockResolvedValueOnce(result)
      expect(await gitApi.gitListRepositories('space', { shallow })).toBe(result)
      expect(transport.httpRequest).toHaveBeenLastCalledWith('POST', '/api/git/repositories', { spaceId: 'space', options: { shallow } })
    }
  })

  it('uses the same options and discovery result over IPC', async () => {
    transport.electron = true
    const list = { success: true, data: { git: { available: true, version: '2' }, repositories: [] } }
    const discovered = { success: true, data: { repository: { root: '/space/sdk', name: 'sdk', relativePath: 'sdk' }, remembered: false, recordError: { code: 'GIT_FAILED', error: 'disk full' } } }
    const halo = { gitListRepositories: vi.fn().mockResolvedValue(list), gitDiscoverRepository: vi.fn().mockResolvedValue(discovered) }
    vi.stubGlobal('window', { halo })
    expect(await gitApi.gitListRepositories('space', { shallow: false })).toBe(list)
    expect(halo.gitListRepositories).toHaveBeenCalledWith('space', { shallow: false })
    expect(await gitApi.gitDiscoverRepository('space', '/space/sdk/file.ts')).toBe(discovered)
    expect(halo.gitDiscoverRepository).toHaveBeenCalledWith('space', '/space/sdk/file.ts')
    expect(transport.httpRequest).not.toHaveBeenCalled()
  })

  it('forwards selection-only remembering over both transports', async () => {
    const status = { success: true, data: { remembered: true } }
    transport.httpRequest.mockResolvedValue(status)
    expect(await gitApi.gitGetStatus('space', '/space/sdk', true)).toBe(status)
    expect(transport.httpRequest).toHaveBeenLastCalledWith('POST', '/api/git/status', { spaceId: 'space', repoRoot: '/space/sdk', remember: true })
    transport.electron = true
    const halo = { gitGetStatus: vi.fn().mockResolvedValue(status) }
    vi.stubGlobal('window', { halo })
    expect(await gitApi.gitGetStatus('space', '/space/sdk', true)).toBe(status)
    expect(halo.gitGetStatus).toHaveBeenCalledWith('space', '/space/sdk', true)
  })

  it('preserves record failure information over HTTP', async () => {
    const result = { success: true, data: { repository: { root: '/space/sdk', name: 'sdk', relativePath: 'sdk' }, remembered: false, recordError: { code: 'GIT_FAILED', error: 'disk full' } } }
    transport.httpRequest.mockResolvedValueOnce(result)
    expect(await gitApi.gitDiscoverRepository('space', '/space/sdk/file.ts')).toBe(result)
    expect(transport.httpRequest).toHaveBeenCalledWith('POST', '/api/git/discover-repository', { spaceId: 'space', filePath: '/space/sdk/file.ts' })
  })
})
