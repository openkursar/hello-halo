/**
 * Federation control-plane HTTP route tests.
 *
 * Covers the three office membership/observability routes that mirror the
 * desktop-only IPC surface so a headless/remote-driven node can drive a
 * distributed office over HTTP:
 *   - POST /api/teams/:teamId/join   → joinTeamOffice
 *   - POST /api/teams/:teamId/leave  → leaveTeamOffice
 *   - GET  /api/teams/:teamId/federation/presence → manager.getOfficePresence
 *
 * These are control-plane endpoints (PIN-only): the security boundary itself is
 * enforced by the middleware allowlist, asserted here against OFFICE_READ_ROUTES
 * so a regression that accidentally widens the office-member scope is caught.
 *
 * The heavy controller + federation deps are mocked so the test exercises only
 * route wiring, request validation, and delegation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { Express } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../../src/main/http/auth/middleware', () => ({
  getOfficeCredential: () => null,
}))

// Team service/store are imported at module load by team.routes; the
// control-plane routes under test never touch them, so minimal stubs suffice.
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamService: () => null,
  getTeamStore: () => null,
}))

vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  readTeamMemberMessages: () => [],
}))

const joinTeamOffice =
  vi.fn<[{ officeId: string; serverUrl: string; inviteToken: string; bringAppIds: string[] }], Promise<unknown>>()
const leaveTeamOffice = vi.fn<[string], Promise<unknown>>()

vi.mock('../../../../src/main/controllers/team-invite.controller', () => ({
  generateTeamInvite: vi.fn(),
  revokeTeamInvite: vi.fn(),
  joinTeamOffice: (input: { officeId: string; serverUrl: string; inviteToken: string; bringAppIds: string[] }) =>
    joinTeamOffice(input),
  leaveTeamOffice: (officeId: string) => leaveTeamOffice(officeId),
}))

const getOfficePresence = vi.fn<[string], unknown>()
// Null when the federation manager itself has not initialized yet.
let managerAvailable = true

vi.mock('../../../../src/main/apps/runtime/federation/manager', () => ({
  getFederationManager: () => (managerAvailable ? { getOfficePresence: (id: string) => getOfficePresence(id) } : null),
}))

import { registerTeamRoutes } from '../../../../src/main/http/routes/team.routes'
import { matchOfficeScope } from '../../../../src/main/http/auth/route-scope'

// ── Test server ──────────────────────────────────────────────────────────────

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  registerTeamRoutes(app)
  return app
}

async function withServer(app: Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    const { port } = server.address() as AddressInfo
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function postJson(base: string, path: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  managerAvailable = true
  joinTeamOffice.mockResolvedValue({ success: true })
  leaveTeamOffice.mockResolvedValue({ success: true })
  getOfficePresence.mockReturnValue(null)
})

// ── POST /join ───────────────────────────────────────────────────────────────

describe('POST /api/teams/:teamId/join', () => {
  it('delegates to joinTeamOffice with the path officeId + body fields (200)', async () => {
    await withServer(buildApp(), async (base) => {
      const res = await postJson(base, '/api/teams/office-1/join', {
        serverUrl: 'ws://127.0.0.1:3461',
        inviteToken: 'halo-office.abc.def',
        bringAppIds: ['app-a', 'app-b'],
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ success: true })
    })
    expect(joinTeamOffice).toHaveBeenCalledWith({
      officeId: 'office-1',
      serverUrl: 'ws://127.0.0.1:3461',
      inviteToken: 'halo-office.abc.def',
      bringAppIds: ['app-a', 'app-b'],
    })
  })

  it('400 when serverUrl is missing', async () => {
    await withServer(buildApp(), async (base) => {
      const res = await postJson(base, '/api/teams/office-1/join', {
        inviteToken: 't',
        bringAppIds: ['a'],
      })
      expect(res.status).toBe(400)
    })
    expect(joinTeamOffice).not.toHaveBeenCalled()
  })

  it('400 when inviteToken is missing', async () => {
    await withServer(buildApp(), async (base) => {
      const res = await postJson(base, '/api/teams/office-1/join', {
        serverUrl: 'ws://h',
        bringAppIds: ['a'],
      })
      expect(res.status).toBe(400)
    })
    expect(joinTeamOffice).not.toHaveBeenCalled()
  })

  it('400 when bringAppIds is empty or absent', async () => {
    await withServer(buildApp(), async (base) => {
      const res1 = await postJson(base, '/api/teams/office-1/join', { serverUrl: 'ws://h', inviteToken: 't' })
      const res2 = await postJson(base, '/api/teams/office-1/join', {
        serverUrl: 'ws://h',
        inviteToken: 't',
        bringAppIds: [],
      })
      expect(res1.status).toBe(400)
      expect(res2.status).toBe(400)
    })
    expect(joinTeamOffice).not.toHaveBeenCalled()
  })

  it('passes a controller failure through as the response body (200 envelope)', async () => {
    joinTeamOffice.mockResolvedValue({ success: false, error: 'NO_MEMBERS' })
    await withServer(buildApp(), async (base) => {
      const res = await postJson(base, '/api/teams/office-1/join', {
        serverUrl: 'ws://h',
        inviteToken: 't',
        bringAppIds: ['a'],
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ success: false, error: 'NO_MEMBERS' })
    })
  })
})

// ── POST /leave ──────────────────────────────────────────────────────────────

describe('POST /api/teams/:teamId/leave', () => {
  it('delegates to leaveTeamOffice with the path officeId (200)', async () => {
    await withServer(buildApp(), async (base) => {
      const res = await postJson(base, '/api/teams/office-9/leave', {})
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ success: true })
    })
    expect(leaveTeamOffice).toHaveBeenCalledWith('office-9')
  })
})

// ── GET /federation/presence ─────────────────────────────────────────────────

describe('GET /api/teams/:teamId/federation/presence', () => {
  it('returns the manager snapshot (200)', async () => {
    const snapshot = {
      officeId: 'office-1',
      role: 'host',
      nodes: [{ nodeId: 'id_a', identity: 'id_a', displayName: null, status: 'online', lastSeen: 123 }],
      authority: null,
    }
    getOfficePresence.mockReturnValue(snapshot)
    await withServer(buildApp(), async (base) => {
      const res = await fetch(`${base}/api/teams/office-1/federation/presence`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ success: true, data: snapshot })
    })
    expect(getOfficePresence).toHaveBeenCalledWith('office-1')
  })

  it('returns null data when the office is neither hosted nor joined (200)', async () => {
    getOfficePresence.mockReturnValue(null)
    await withServer(buildApp(), async (base) => {
      const res = await fetch(`${base}/api/teams/unknown/federation/presence`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ success: true, data: null })
    })
  })

  it('503 when the federation manager is not yet initialized', async () => {
    managerAvailable = false
    await withServer(buildApp(), async (base) => {
      const res = await fetch(`${base}/api/teams/office-1/federation/presence`)
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.success).toBe(false)
    })
  })
})

// ── Security boundary: control-plane routes stay PIN-only ─────────────────────

describe('control-plane routes are excluded from the office-member allowlist', () => {
  it('join/leave/presence are NOT reachable by an office credential', () => {
    expect(matchOfficeScope('POST', '/api/teams/office-1/join')).toBe(false)
    expect(matchOfficeScope('POST', '/api/teams/office-1/leave')).toBe(false)
    expect(matchOfficeScope('GET', '/api/teams/office-1/federation/presence')).toBe(false)
  })
})
