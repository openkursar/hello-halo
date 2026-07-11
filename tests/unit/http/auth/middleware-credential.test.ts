/**
 * Dual-credential authMiddleware tests. Proves the security boundary: an
 * office-member credential reaches ONLY the team read-only family and gets 403
 * on any control-plane endpoint, never falling through to the remote-control
 * PIN path — and that revoking one credential system never affects the other.
 *
 * Crypto and the revocation ledger are real; the remote-control PIN is a real
 * in-memory token.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import type { Request, Response, NextFunction } from 'express'

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
import { issueOfficeCredential, revokeOfficeCredential } from '../../../../src/main/http/auth/office-credential'
import { setCustomAccessToken, clearAccessToken, validateToken } from '../../../../src/main/http/auth/token-store'

const OFFICE_A = 'team-abc'
const PIN = 'Aa1!Aa1!'

interface MockResponse {
  statusCode: number
  body: unknown
  status(code: number): MockResponse
  json(payload: unknown): MockResponse
}

function makeRes(): MockResponse {
  return {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

function makeReq(method: string, reqPath: string, token?: string): Request {
  return {
    method,
    path: reqPath,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query: {},
  } as unknown as Request
}

function run(req: Request): { nextCalled: boolean; res: MockResponse; req: Request } {
  const res = makeRes()
  let nextCalled = false
  const next: NextFunction = () => {
    nextCalled = true
  }
  authMiddleware(req, res as unknown as Response, next)
  return { nextCalled, res, req }
}

describe('authMiddleware — dual credential', () => {
  let dbManager: DatabaseManager

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

  it('office credential on an allowed team-read GET → next() and req.officeCredential set', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: 'id_x' })
    const { nextCalled, req } = run(makeReq('GET', `/api/teams/${OFFICE_A}/epochs`, token))
    expect(nextCalled).toBe(true)
    expect(getOfficeCredential(req)?.officeId).toBe(OFFICE_A)
  })

  it('office credential on /api/agent/* → 403 (never reaches control plane)', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: 'id_x' })
    const { nextCalled, res } = run(makeReq('GET', '/api/agent/sessions', token))
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(403)
    expect((res.body as { error: string }).error).toBe('Forbidden')
  })

  it('office credential on POST /api/teams/x/run → 403', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: 'id_x' })
    const { nextCalled, res } = run(makeReq('POST', `/api/teams/${OFFICE_A}/run`, token))
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  it('invalid office token → 401', () => {
    const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: 'id_x' })
    const sig = token.split('.')[1]
    const forgedClaims = Buffer.from('{"type":"office-member"}').toString('base64url')
    const { nextCalled, res } = run(makeReq('GET', `/api/teams/${OFFICE_A}/epochs`, `${forgedClaims}.${sig}`))
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  it('revoked office credential on an allowed path → 401 (no fallthrough to PIN)', () => {
    const { token, jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: 'id_x' })
    revokeOfficeCredential(jti)
    const { nextCalled, res } = run(makeReq('GET', `/api/teams/${OFFICE_A}/epochs`, token))
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  it('remote-control PIN on any /api path → next() (full access unchanged)', () => {
    const { nextCalled, req } = run(makeReq('GET', '/api/agent/sessions', PIN))
    expect(nextCalled).toBe(true)
    expect(getOfficeCredential(req)).toBeNull()
  })

  describe('AC-6.3 independence', () => {
    it('revoking the office credential does not affect the remote-control PIN', () => {
      const { token, jti } = issueOfficeCredential({ officeId: OFFICE_A, identity: 'id_x' })
      revokeOfficeCredential(jti)
      expect(run(makeReq('GET', `/api/teams/${OFFICE_A}/epochs`, token)).res.statusCode).toBe(401)
      expect(validateToken(PIN)).toBe(true)
      expect(run(makeReq('GET', '/api/agent/sessions', PIN)).nextCalled).toBe(true)
    })

    it('clearing the remote-control PIN does not affect a valid office credential', () => {
      const { token } = issueOfficeCredential({ officeId: OFFICE_A, identity: 'id_x' })
      clearAccessToken()
      expect(validateToken(PIN)).toBe(false)
      expect(run(makeReq('GET', `/api/teams/${OFFICE_A}/epochs`, token)).nextCalled).toBe(true)
    })
  })
})
