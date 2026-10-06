/**
 * The /api gate exactly as the server wires it: `app.use('/api', authMiddleware)`
 * in front of real routes, driven over HTTP. Express hands a mounted middleware
 * the path without its mount point, so this is the only shape in which the
 * public allowlist, the static-file exemptions and the office-member route scope
 * can be proven to apply as written.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import express from 'express'
import type { Request, Response } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      const dir = testHome()
      if (name === 'userData') return path.join(dir, '.halo')
      return dir
    },
    getAppPath: () => path.join(testHome(), 'app'),
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('../../../../src/main/services/security-policy', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { initFederationStore, shutdownFederationStore } from '../../../../src/main/apps/federation/index'
import { ensureLocalIdentity, _resetLocalIdentityCache } from '../../../../src/main/http/identity/device-key'
import { authMiddleware, getOfficeCredential } from '../../../../src/main/http/auth/middleware'
import { issueOfficeCredential } from '../../../../src/main/http/auth/office-credential'
import { setCustomAccessToken, clearAccessToken } from '../../../../src/main/http/auth/token-store'

const OFFICE = 'team-abc'
const PIN = 'Aa1!Aa1!'

let server: Server
let base: string
let dbManager: DatabaseManager

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', authMiddleware)
  const reached = (name: string) => (req: Request, res: Response) => {
    res.json({ reached: name, office: getOfficeCredential(req)?.officeId ?? null })
  }
  app.get('/api/security/policy', reached('policy'))
  app.get('/api/apps/:appId', reached('app'))
  app.get('/api/agent/sessions', reached('sessions'))
  app.get('/api/teams/:teamId/epochs', reached('epochs'))
  app.post('/api/teams/:teamId/members/:appId/send', reached('send'))
  app.post('/api/teams/:teamId/run', reached('run'))
  app.get('/api/artifacts/file/:ticket', reached('ticket'))
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  _resetLocalIdentityCache()
  ensureLocalIdentity()
  dbManager = createDatabaseManager(':memory:')
  initFederationStore({ db: dbManager })
  clearAccessToken()
  setCustomAccessToken(PIN)
})

afterEach(() => {
  shutdownFederationStore()
  dbManager.closeAll()
  clearAccessToken()
  _resetLocalIdentityCache()
})

async function call(method: 'GET' | 'POST', urlPath: string, token?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? '{}' : undefined,
  })
  const text = await response.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: response.status, body }
}

describe('the mounted /api gate without a token', () => {
  it('serves the public security policy', async () => {
    expect(await call('GET', '/api/security/policy')).toEqual({ status: 200, body: { reached: 'policy', office: null } })
  })

  it('never treats an /api path as a static file', async () => {
    for (const urlPath of ['/api/x.js', '/api/apps/x.js', '/API/apps/x.js', '/api/apps/logo.png', '/api/assets/x', '/api/node_modules/x', '/api/@vite/client', '/api/', '/api']) {
      expect((await call('GET', urlPath)).status, urlPath).toBe(401)
    }
  })

  it('still admits a download ticket link', async () => {
    expect((await call('GET', `/api/artifacts/file/${'a'.repeat(43)}`)).body).toEqual({ reached: 'ticket', office: null })
  })
})

describe('office-member credentials on the mounted gate', () => {
  it('reach the office routes they are scoped to, with the credential attached', async () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE, identity: 'id_x' })
    expect(await call('GET', `/api/teams/${OFFICE}/epochs`, token)).toEqual({ status: 200, body: { reached: 'epochs', office: OFFICE } })
    expect(await call('POST', `/api/teams/${OFFICE}/members/app-1/send`, token)).toEqual({ status: 200, body: { reached: 'send', office: OFFICE } })
  })

  it('get 403 everywhere else', async () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE, identity: 'id_x' })
    expect((await call('POST', `/api/teams/${OFFICE}/run`, token)).status).toBe(403)
    expect((await call('GET', '/api/agent/sessions', token)).status).toBe(403)
    expect((await call('GET', '/api/apps/x.js', token)).status).toBe(403)
  })
})

describe('the remote-control token on the mounted gate', () => {
  it('reaches every route as before', async () => {
    expect(await call('GET', '/api/agent/sessions', PIN)).toEqual({ status: 200, body: { reached: 'sessions', office: null } })
    expect(await call('POST', `/api/teams/${OFFICE}/run`, PIN)).toEqual({ status: 200, body: { reached: 'run', office: null } })
    expect((await call('GET', '/api/apps/x.js', PIN)).body).toEqual({ reached: 'app', office: null })
  })

  it('is refused when wrong', async () => {
    expect((await call('GET', '/api/agent/sessions', 'Wrong1!x')).status).toBe(401)
  })
})
