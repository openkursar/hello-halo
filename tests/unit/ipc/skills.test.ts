import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { HaloAPI } from '../../../src/preload'
import type { RpcClient, RpcResponse } from '../../../src/shared/rpc/define'
import { skillsRpc } from '../../../src/shared/rpc/contracts/skills.contract'
import { validateAppSpec } from '../../../src/main/apps/spec'
import { MODULE } from '../../../src/main/http/routes/skills.routes.meta'

type Handler = (event: unknown, input: unknown) => Promise<RpcResponse>
const { handlers, library, exposed, invoke } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  library: {
    list: vi.fn(), read: vi.fn(), save: vi.fn(), import: vi.fn(), setEnabled: vi.fn(),
    movePreview: vi.fn(), move: vi.fn(), copy: vi.fn(), delete: vi.fn(), openFolder: vi.fn(),
    export: vi.fn(), restoreLegacy: vi.fn(), deleteLegacy: vi.fn(),
  },
  exposed: new Map<string, Record<string, (input: unknown) => Promise<RpcResponse>>>(),
  invoke: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/nonexistent', getAppPath: () => '/nonexistent' },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), on: vi.fn() },
  ipcRenderer: { invoke, on: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (name: string, api: Record<string, (input: unknown) => Promise<RpcResponse>>) => exposed.set(name, api) },
  webUtils: { getPathForFile: vi.fn() },
}))
vi.mock('../../../src/main/apps/skills', () => ({ getSkillLibrary: () => library }))
vi.mock('../../../src/main/services/security-policy', () => ({ isCredentialAtRestSafe: () => false }))

import { registerSkillsHandlers } from '../../../src/main/ipc/skills'
import { registerSkillsRoutes } from '../../../src/main/http/routes/skills.routes'
import { authMiddleware } from '../../../src/main/http/auth/middleware'
import { clearAccessToken, setCustomAccessToken } from '../../../src/main/http/auth/token-store'
import { matchOfficeScope } from '../../../src/main/http/auth/route-scope'

const APP_ID = 'a9a7957e-2346-47d9-b714-92406811b27b'
const REF = { id: `file:${'a'.repeat(64)}`, spaceId: 'workspace-1' }
const REVISION = 'b'.repeat(64)
const SPEC = { type: 'skill', name: 'sample-skill', version: '1.0', description: 'A sample', skill_content: '# Sample' }
const REQUESTS: Array<[keyof typeof skillsRpc, keyof typeof library, string, unknown]> = [
  ['skillsList', 'list', 'list', { spaceId: null }],
  ['skillsRead', 'read', 'read', REF],
  ['skillsSave', 'save', 'save', { ref: REF, content: '# Updated', revision: REVISION }],
  ['skillsImport', 'import', 'import', { spaceId: null, spec: SPEC, requestId: 'request_123' }],
  ['skillsSetEnabled', 'setEnabled', 'set-enabled', { ref: REF, enabled: false }],
  ['skillsMovePreview', 'movePreview', 'move-preview', { ref: REF, spaceId: null }],
  ['skillsMove', 'move', 'move', { ref: REF, spaceId: null, revision: REVISION }],
  ['skillsCopy', 'copy', 'copy', { ref: REF, spaceId: null, name: 'new-copy' }],
  ['skillsDelete', 'delete', 'delete', { ref: REF, revision: REVISION }],
  ['skillsOpenFolder', 'openFolder', 'open-folder', REF],
  ['skillsExport', 'export', 'export', REF],
  ['skillsRestoreLegacy', 'restoreLegacy', 'restore-legacy', { appId: APP_ID, spaceId: null }],
  ['skillsDeleteLegacy', 'deleteLegacy', 'delete-legacy', { appId: APP_ID }],
]

let server: Server
let baseUrl: string
const TOKEN = 'Fixture1!Token'

beforeAll(async () => {
  registerSkillsHandlers()
  await import('../../../src/preload')
  const app = express()
  app.use(express.json())
  app.use('/api', authMiddleware)
  registerSkillsRoutes(app)
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  clearAccessToken()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setCustomAccessToken(TOKEN)
  invoke.mockImplementation((channel: string, input: unknown) => handlers.get(channel)!({}, input))
  for (const [method, fn] of Object.entries(library)) {
    fn.mockReturnValue(['delete', 'deleteLegacy', 'openFolder'].includes(method) ? undefined : { value: method })
  }
})

async function post(operation: string, input: unknown, token: string | null = TOKEN) {
  const response = await fetch(`${baseUrl}/api/skills/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
  })
  return { status: response.status, body: await response.json() as RpcResponse & { code?: string } }
}

function preloadCall(method: keyof typeof skillsRpc, input: unknown) {
  return exposed.get('halo')![method](input)
}

describe('skills transport', () => {
  it('registers every contract channel and types the preload against that same contract', () => {
    expect([...handlers.keys()].sort()).toEqual(Object.values(skillsRpc).map(method => method.channel).sort())
    expectTypeOf<HaloAPI>().toMatchTypeOf<RpcClient<typeof skillsRpc>>()
    for (const name of Object.keys(skillsRpc)) expect(exposed.get('halo')![name]).toBeTypeOf('function')
  })

  it.each(REQUESTS)('%s forwards exactly one unchanged input through preload and RPC', async (method, serviceMethod, _path, input) => {
    const response = await preloadCall(method, input)
    expect(invoke).toHaveBeenCalledWith(skillsRpc[method].channel, input)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(library[serviceMethod]).toHaveBeenCalledTimes(1)
    expect(library[serviceMethod]).toHaveBeenCalledWith(method === 'skillsImport'
      ? { spaceId: null, requestId: 'request_123', spec: validateAppSpec(SPEC) }
      : input)
    expect(response).toEqual({ success: true, data: library[serviceMethod].mock.results[0].value })
  })

  it.each(REQUESTS.filter(([, , path]) => path !== 'open-folder'))('%s returns the same envelope over authenticated HTTP', async (method, serviceMethod, path, input) => {
    const ipc = await preloadCall(method, input)
    const http = await post(path, input)
    expect(http.status).toBe(200)
    expect(http.body).toEqual(JSON.parse(JSON.stringify(ipc)))
    expect(library[serviceMethod]).toHaveBeenCalledTimes(2)
    expect(library[serviceMethod].mock.calls[1]).toEqual(library[serviceMethod].mock.calls[0])
  })

  it.each(REQUESTS)('%s cannot be reached remotely without the existing bearer authorization', async (_method, serviceMethod, path, input) => {
    expect((await post(path, input, null)).status).toBe(401)
    expect((await post(path, input, 'wrong-token')).status).toBe(401)
    expect(matchOfficeScope('POST', `/api/skills/${path}`)).toBe(false)
    expect(library[serviceMethod]).not.toHaveBeenCalled()
  })

  it('refuses host folder opening over HTTP even for an authenticated owner', async () => {
    const response = await post('open-folder', REF)
    expect(response).toMatchObject({ status: 403, body: { success: false, code: 'DESKTOP_ONLY' } })
    expect(response.body.error).toContain('desktop client')
    expect(library.openFolder).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed inputs identically through both transports without a service call', async () => {
    const requests: Array<[keyof typeof skillsRpc, string, unknown]> = [
      ['skillsList', 'list', { spaceId: null, limit: 101 }],
      ['skillsRead', 'read', { ...REF, filePath: '/outside/SKILL.md' }],
      ['skillsRead', 'read', { id: '/outside/SKILL.md', spaceId: null }],
      ['skillsSave', 'save', { ref: REF, content: '# Missing revision' }],
      ['skillsImport', 'import', { spaceId: null, spec: SPEC }],
      ['skillsImport', 'import', { spaceId: null, spec: SPEC, requestId: 'request_123', replace: { ref: REF } }],
      ['skillsSetEnabled', 'set-enabled', { ref: REF, enabled: 'false' }],
      ['skillsMove', 'move', { ref: REF, spaceId: null }],
      ['skillsCopy', 'copy', { ref: REF, spaceId: null, name: 'copy', filePath: '/outside' }],
      ['skillsDelete', 'delete', { ref: REF }],
      ['skillsRestoreLegacy', 'restore-legacy', { appId: 'not-a-uuid', spaceId: null }],
      ['skillsDeleteLegacy', 'delete-legacy', { appId: APP_ID, filePath: '/outside' }],
    ]
    for (const [method, path, input] of requests) {
      const ipc = await preloadCall(method, input)
      expect(ipc.success).toBe(false)
      expect((await post(path, input)).body).toEqual(ipc)
    }
    for (const fn of Object.values(library)) expect(fn).not.toHaveBeenCalled()
  })

  it('returns async service failures and logs them once per transport without the input', async () => {
    const error = new Error('The current revision no longer matches.')
    const input = { ref: REF, content: 'Private instructions', revision: REVISION }
    library.save.mockRejectedValue(error)
    const ipc = await preloadCall('skillsSave', input)
    const http = await post('save', input)
    expect(ipc).toEqual({ success: false, error: String(error) })
    expect(http.body).toEqual(ipc)
    expect(console.error).toHaveBeenCalledTimes(2)
    expect(console.error).toHaveBeenNthCalledWith(1, '[Skills] skills:save error:', error)
    expect(console.error).toHaveBeenNthCalledWith(2, '[Skills] save error:', error)
  })

  it('keeps malformed enum and asset values out of production validation logs', async () => {
    const secret = 'Private skill instructions'
    const input = { spaceId: null, source: secret }
    await preloadCall('skillsList', input)
    await post('list', input)
    const invalidImport = {
      spaceId: null,
      requestId: 'request_123',
      spec: { ...SPEC, skill_assets: { 'asset.bin': { encoding: secret, content: 'AA==' } } },
    }
    await preloadCall('skillsImport', invalidImport)
    await post('import', invalidImport)
    expect(console.error).toHaveBeenCalledTimes(4)
    for (const call of vi.mocked(console.error).mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(secret)
    }
  })

  it('declares each HTTP operation in the real metadata format without hiding skill management from AI', () => {
    expect(MODULE.file).toBe('skills')
    expect(Object.keys(MODULE.routes).sort()).toEqual(REQUESTS.map(([, , path]) => `POST /api/skills/${path}`).sort())
    for (const [path, metadata] of Object.entries(MODULE.routes)) {
      expect(metadata.expose).toBe(path.endsWith('/open-folder') ? 'internal' : 'ai')
      if (metadata.expose === 'ai') {
        expect(metadata.summary.length).toBeLessThanOrEqual(80)
        expect(metadata.group).toBe('store')
        expect(metadata.returns).toBeTruthy()
        expect(() => JSON.parse(metadata.body!)).not.toThrow()
      }
    }
  })
})
