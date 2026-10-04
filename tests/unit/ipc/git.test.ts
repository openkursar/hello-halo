/**
 * The git surface over both transports: every contract channel is registered
 * over IPC, the remote routes answer with the same envelopes, and failures
 * carry their stable code.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import { rmSync } from 'fs'
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
