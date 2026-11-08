/**
 * The git surface over both transports: every contract channel is registered
 * over IPC, the remote routes answer with the same envelopes, and failures
 * carry their stable code.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { gitRpc } from '../../../src/shared/rpc/contracts/git.contract'
import { initRepo, isolateGit, makeTempDir } from '../services/git/_repo'

type Handler = (event: unknown, ...args: unknown[]) => Promise<{ success: boolean; data?: any; error?: string; code?: string }>
const { handlers, spaces } = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), spaces: new Map<string, string>() }))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn), on: vi.fn() },
  shell: { trashItem: vi.fn() },
}))
vi.mock('../../../src/main/services/space.service', () => ({
  getSpaceDir: (spaceId: string) => spaces.get(spaceId) ?? '',
  getSpace: (spaceId: string) => {
    const path = spaces.get(spaceId)
    return path ? { id: spaceId, path, isTemp: false } : null
  },
}))

const { registerGitHandlers } = await import('../../../src/main/ipc/git')
const { registerGitRoutes } = await import('../../../src/main/http/routes/git.routes')

let restoreGit: () => void
let dir: string

beforeAll(() => {
  restoreGit = isolateGit()
  dir = makeTempDir('halo-git-ipc-')
  spaces.set('s', dir)
  const repo = initRepo(dir)
  repo.write('a.txt', 'a\n')
  repo.commitAll('base')
  repo.write('a.txt', 'b\n')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  registerGitHandlers()
})
afterAll(() => {
  restoreGit()
  rmSync(dir, { recursive: true, force: true })
})

async function post(path: string, body: unknown): Promise<any> {
  const app = express()
  app.use(express.json())
  registerGitRoutes(app)
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('git transport', () => {
  it('registers every contract channel over IPC', () => {
    expect([...handlers.keys()].sort()).toEqual(Object.values(gitRpc).map((method) => method.channel).sort())
  })

  it('answers the same over IPC and HTTP', async () => {
    const overIpc = await handlers.get('git:get-status')!({}, 's', dir)
    const overHttp = await post('/api/git/status', { spaceId: 's', repoRoot: dir })
    expect(overIpc.success).toBe(true)
    expect(overIpc.data.unstaged.map((file: { path: string }) => file.path)).toEqual(['a.txt'])
    expect(overHttp).toEqual(JSON.parse(JSON.stringify(overIpc)))

    const changes = await post('/api/git/changes', { spaceId: 's', repoRoot: dir, scope: { kind: 'uncommitted' } })
    const contents = await post('/api/git/file-contents', {
      spaceId: 's',
      repoRoot: dir,
      request: { scope: changes.data.scope, beforeRevision: changes.data.beforeRevision, path: 'a.txt' },
    })
    expect(contents.data).toMatchObject({ before: 'a\n', after: 'b\n' })
  })

  it('discovers, opens, lists and forgets a deep repository over both transports', async () => {
    const repoRoot = join(dir, 'projects', 'nested', 'repo with spaces')
    const repo = initRepo(repoRoot)
    repo.write('src/example.ts', 'export const value = 1\n')
    repo.commitAll('base')
    const filePath = join(repoRoot, 'src', 'example.ts')
    const index = readFileSync(join(repoRoot, '.git', 'index'))
    const before = await post('/api/git/repositories', { spaceId: 's' })
    expect(before.success).toBe(true)
    expect(before.data.repositories.map((entry: { root: string }) => entry.root)).not.toContain(repoRoot)

    const discovered = await handlers.get('git:discover-repository')!({}, 's', filePath)
    expect(discovered).toMatchObject({ success: true, data: { root: repoRoot, relativePath: 'projects/nested/repo with spaces' } })
    expect(await post('/api/git/discover-repository', { spaceId: 's', filePath })).toEqual(discovered)

    const opened = await handlers.get('git:open-repository')!({}, 's', repoRoot)
    expect(opened).toEqual(discovered)
    expect(await post('/api/git/open-repository', { spaceId: 's', repoRoot })).toEqual(opened)
    const listed = await handlers.get('git:list-repositories')!({}, 's')
    expect(listed.data.savedRepositories).toEqual([{ root: repoRoot, available: true }])
    expect(await post('/api/git/repositories', { spaceId: 's' })).toEqual(listed)

    expect(await handlers.get('git:forget-repository')!({}, 's', repoRoot)).toEqual({ success: true, data: undefined })
    expect(await post('/api/git/open-repository', { spaceId: 's', repoRoot })).toEqual(opened)
    expect(await post('/api/git/forget-repository', { spaceId: 's', repoRoot })).toEqual({ success: true })
    const forgotten = await post('/api/git/repositories', { spaceId: 's' })
    expect(forgotten.data.savedRepositories ?? []).toEqual([])
    expect(forgotten.data.repositories.map((entry: { root: string }) => entry.root)).not.toContain(repoRoot)
    expect(readFileSync(filePath, 'utf8')).toBe('export const value = 1\n')
    expect(readFileSync(join(repoRoot, '.git', 'index'))).toEqual(index)
    expect(existsSync(join(repoRoot, '.git', 'HEAD'))).toBe(true)
  })

  it('lists unavailable saved roots and lets either transport forget them', async () => {
    const repoRoot = join(dir, 'projects', 'unavailable', 'repo')
    initRepo(repoRoot)
    expect(await post('/api/git/open-repository', { spaceId: 's', repoRoot })).toMatchObject({ success: true })
    rmSync(repoRoot, { recursive: true, force: true })
    const listed = await handlers.get('git:list-repositories')!({}, 's')
    expect(listed.data.savedRepositories).toEqual([{ root: repoRoot, available: false }])
    expect(await post('/api/git/repositories', { spaceId: 's' })).toEqual(listed)
    expect(await handlers.get('git:forget-repository')!({}, 's', repoRoot)).toEqual({ success: true, data: undefined })
    expect(await post('/api/git/forget-repository', { spaceId: 's', repoRoot })).toEqual({ success: true })
  })

  it('returns null discovery results without turning them into failures', async () => {
    const filePath = join(dir, '..', 'outside.txt')
    expect(await handlers.get('git:discover-repository')!({}, 's', filePath)).toEqual({ success: true, data: null })
    expect(await post('/api/git/discover-repository', { spaceId: 's', filePath })).toEqual({ success: true, data: null })
  })

  it.each(['discover-repository', 'open-repository', 'forget-repository'])('preserves validation failures for %s', async (operation) => {
    const overIpc = await handlers.get(`git:${operation}`)!({}, 's', 42)
    const argument = operation === 'discover-repository' ? 'filePath' : 'repoRoot'
    expect(overIpc).toMatchObject({ success: false, code: 'GIT_INVALID_ARGUMENT' })
    expect(await post(`/api/git/${operation}`, { spaceId: 's', [argument]: 42 })).toEqual(overIpc)
    expect(await post(`/api/git/${operation}`, {})).toMatchObject({ success: false, code: 'GIT_INVALID_ARGUMENT' })
  })

  it('carries a stable code on failure, whatever the transport', async () => {
    expect(await handlers.get('git:list-repositories')!({}, 'missing-space')).toMatchObject({ success: false, code: 'GIT_INVALID_ARGUMENT' })
    expect(await handlers.get('git:stage')!({}, 's', dir, ['../outside.txt'])).toMatchObject({ success: false, code: 'GIT_INVALID_ARGUMENT' })
    expect(await post('/api/git/status', { spaceId: 's', repoRoot: '/' })).toMatchObject({ success: false, code: 'GIT_NOT_A_REPOSITORY' })
    expect(await post('/api/git/commit', { spaceId: 's', repoRoot: dir, request: { message: '', amend: false, push: false } })).toMatchObject({
      success: false,
      code: 'GIT_EMPTY_MESSAGE',
    })
    expect(await post('/api/git/changes', {})).toMatchObject({ success: false, code: 'GIT_INVALID_ARGUMENT' })
  })
})
