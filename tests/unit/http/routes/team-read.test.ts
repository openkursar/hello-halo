/**
 * Team read-only HTTP route tests.
 *
 * Proves two security guarantees of the team read family:
 *   1. Cross-office isolation — an office-member credential scoped to office X
 *      may read team X but is 403 on team Y. Remote-control (no office
 *      credential) keeps full read access to any team.
 *   2. chat-messages membership validation — ?appId must be a member of the team;
 *      a non-member is rejected and a missing appId is a 400.
 *
 * The heavy apps/runtime + apps/team dependencies are mocked so the test
 * exercises only the route wiring and the officeGateOk gate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { Express, Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

// ── Mocks ──────────────────────────────────────────────────────────────────

// The office credential is normally attached by authMiddleware. Here we read it
// from a request property set by the test's stub middleware (mirrors the real
// `(req as any).officeCredential` contract). It carries `identity` so the
// read-side scope projection (identity → member appId) can resolve.
vi.mock('../../../../src/main/http/auth/middleware', () => ({
  getOfficeCredential: (req: Request) =>
    ((req as unknown as { officeCredential?: { officeId: string; identity: string } }).officeCredential) ?? null,
}))

interface MockMember {
  appId: string
  memberIdentity?: string | null
  scopeJson?: string | null
  isLead?: boolean
  origin?: 'local' | 'remote'
  ownerNodeId?: string
}
const listMembersByTeam = vi.fn<[string], MockMember[]>()
const getCurrentEpochForTeam = vi.fn<[string], { id: string } | null>()
const listEpochsByTeam = vi.fn<[string], Array<{ id: string }>>()
const getTeamById = vi.fn<[string], { leadAppId: string | null } | null>()
const listEpochs = vi.fn<[string], unknown[]>()
const getTeamDetail = vi.fn<[string], unknown>()
const getEpochBoard = vi.fn<[string, string], unknown>()
const sendToMember = vi.fn<[unknown], Promise<unknown>>()

vi.mock('../../../../src/main/apps/team', () => ({
  getTeamService: () => ({
    listEpochs: (teamId: string) => listEpochs(teamId),
    getTeamDetail: (teamId: string) => getTeamDetail(teamId),
    getEpochBoard: (teamId: string, epochId: string) => getEpochBoard(teamId, epochId),
    sendToMember: (input: unknown) => sendToMember(input),
  }),
  getTeamStore: () => ({
    listMembersByTeam: (teamId: string) => listMembersByTeam(teamId),
    getCurrentEpochForTeam: (teamId: string) => getCurrentEpochForTeam(teamId),
    listEpochsByTeam: (teamId: string) => listEpochsByTeam(teamId),
    getTeamById: (teamId: string) => getTeamById(teamId),
  }),
}))

const readTeamMemberMessages = vi.fn<[string, string, string], unknown[]>()

vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  readTeamMemberMessages: (appId: string, teamId: string, epochId: string) =>
    readTeamMemberMessages(appId, teamId, epochId),
}))

// Federation manager: a remote-owned member's transcript is pulled from its
// owner over the office link instead of read from local chat storage.
const fetchMemberHistory =
  vi.fn<[{ officeId: string; ownerNodeId: string; appId: string; epochId: string }], Promise<unknown[]>>()

vi.mock('../../../../src/main/apps/runtime/federation/manager', () => ({
  getFederationManager: () => ({
    fetchMemberHistory: (params: { officeId: string; ownerNodeId: string; appId: string; epochId: string }) =>
      fetchMemberHistory(params),
  }),
}))

import { registerTeamRoutes } from '../../../../src/main/http/routes/team.routes'

// ── Test server ──────────────────────────────────────────────────────────────

/**
 * Build an Express app that optionally injects an office credential for
 * `officeId` (null = remote-control PIN request, full access). `identity`
 * defaults to a stable test identity so the scope projection can map it to a
 * member; pass an explicit value to model a different reader.
 */
function buildApp(officeId: string | null, identity = 'id-reader'): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (officeId) {
      ;(req as unknown as { officeCredential: { officeId: string; identity: string } }).officeCredential = {
        officeId,
        identity,
      }
    }
    next()
  })
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

beforeEach(() => {
  vi.clearAllMocks()
  listEpochs.mockReturnValue([])
  listMembersByTeam.mockReturnValue([])
  getCurrentEpochForTeam.mockReturnValue(null)
  listEpochsByTeam.mockReturnValue([])
  getTeamById.mockReturnValue({ leadAppId: null })
  getTeamDetail.mockReturnValue(null)
  getEpochBoard.mockReturnValue(null)
  readTeamMemberMessages.mockReturnValue([])
  fetchMemberHistory.mockResolvedValue([])
  sendToMember.mockResolvedValue({ ok: true, finalMessage: 'done' })
})

// ── Cross-office isolation ────────────────────────────────────────────────

describe('cross-office isolation on team read routes', () => {
  it('office credential for X may read team X /epochs (200)', async () => {
    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/epochs`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
    })
  })

  it('office credential for X is forbidden on team Y /epochs (403)', async () => {
    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/Y/epochs`)
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body).toEqual({ success: false, error: 'Forbidden' })
    })
  })

  it('remote-control (no office credential) reads BOTH X and Y (200)', async () => {
    await withServer(buildApp(null), async (base) => {
      const resX = await fetch(`${base}/api/teams/X/epochs`)
      const resY = await fetch(`${base}/api/teams/Y/epochs`)
      expect(resX.status).toBe(200)
      expect(resY.status).toBe(200)
    })
  })

  it('gate applies to every read route in the family', async () => {
    const paths = [
      '/api/teams/Y',
      '/api/teams/Y/detail',
      '/api/teams/Y/chat-messages?appId=a1',
      '/api/teams/Y/artifacts',
      '/api/teams/Y/epochs',
      '/api/teams/Y/epochs/e1/board',
      '/api/teams/Y/epochs/e1/artifacts',
    ]
    await withServer(buildApp('X'), async (base) => {
      for (const p of paths) {
        const res = await fetch(`${base}${p}`)
        expect(res.status, p).toBe(403)
      }
    })
  })
})

// ── chat-messages membership validation ──────────────────────────────────────

describe('GET /api/teams/:teamId/chat-messages', () => {
  it('returns messages for the reader own member appId (200) using the current epoch', async () => {
    // The office reader (identity id-reader) owns member-1; reading its OWN
    // transcript is always allowed regardless of scope.
    listMembersByTeam.mockReturnValue([{ appId: 'member-1', memberIdentity: 'id-reader' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    readTeamMemberMessages.mockReturnValue([{ id: 'm1', role: 'assistant', content: 'hi' }])

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-1`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.data).toHaveLength(1)
    })
    expect(readTeamMemberMessages).toHaveBeenCalledWith('member-1', 'X', 'epoch-1')
  })

  it('honors an explicit ?epochId over the current epoch', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-current' })

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-1&epochId=epoch-past`)
      expect(res.status).toBe(200)
    })
    expect(readTeamMemberMessages).toHaveBeenCalledWith('member-1', 'X', 'epoch-past')
  })

  it('rejects a non-member appId (404)', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=intruder`)
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.success).toBe(false)
    })
    expect(readTeamMemberMessages).not.toHaveBeenCalled()
  })

  it('rejects a missing appId (400)', async () => {
    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages`)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.success).toBe(false)
    })
  })

  it('falls back to the latest (sealed) epoch when no run is open', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue(null)
    listEpochsByTeam.mockReturnValue([{ id: 'epoch-sealed' }])

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-1`)
      expect(res.status).toBe(200)
    })
    expect(readTeamMemberMessages).toHaveBeenCalledWith('member-1', 'X', 'epoch-sealed')
  })

  it('400 when a member has no epoch available', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1', memberIdentity: 'id-reader' }])
    getCurrentEpochForTeam.mockReturnValue(null)
  listEpochsByTeam.mockReturnValue([])

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-1`)
      expect(res.status).toBe(400)
    })
    expect(readTeamMemberMessages).not.toHaveBeenCalled()
  })

  it('denies a narrow reader reading a PEER member transcript (404)', async () => {
    // reader owns member-self (assigned visibility → narrow); member-other is a
    // peer it does not own. A narrow reader is confined to its own transcripts.
    listMembersByTeam.mockReturnValue([
      { appId: 'member-self', memberIdentity: 'id-reader', scopeJson: JSON.stringify({ visibility: 'assigned' }) },
      { appId: 'member-other', memberIdentity: 'id-other' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-other`)
      expect(res.status).toBe(404)
    })
    expect(readTeamMemberMessages).not.toHaveBeenCalled()
  })

  it('allows a full+discoverable reader to read a peer transcript (200)', async () => {
    // A reader whose member has full visibility AND discoverable may read peers.
    listMembersByTeam.mockReturnValue([
      { appId: 'member-self', memberIdentity: 'id-reader' }, // null scope → default full+discoverable
      { appId: 'member-other', memberIdentity: 'id-other' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    readTeamMemberMessages.mockReturnValue([{ id: 'm', role: 'assistant', content: 'x' }])

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-other`)
      expect(res.status).toBe(200)
    })
    expect(readTeamMemberMessages).toHaveBeenCalledWith('member-other', 'X', 'epoch-1')
  })

  it('pulls a remote-owned member transcript from its owner (C-1), not local storage', async () => {
    // member-remote is owned by another node; its transcript is fetched over the
    // office link from that owner, never read from this node's local chat store.
    listMembersByTeam.mockReturnValue([
      { appId: 'member-remote', origin: 'remote', ownerNodeId: 'node-owner' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    fetchMemberHistory.mockResolvedValue([{ role: 'assistant', content: 'from owner', ts: 1 }])

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-remote`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.data).toEqual([{ role: 'assistant', content: 'from owner', ts: 1 }])
    })
    expect(fetchMemberHistory).toHaveBeenCalledWith({
      officeId: 'X',
      ownerNodeId: 'node-owner',
      appId: 'member-remote',
      epochId: 'epoch-1',
    })
    expect(readTeamMemberMessages).not.toHaveBeenCalled()
  })

  it('translates an owner fetch failure to a neutral 502 (never leaks the technical error)', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'member-remote', origin: 'remote', ownerNodeId: 'node-owner' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    fetchMemberHistory.mockRejectedValue(new Error('history: office not present or M2 off office=X'))

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-remote`)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.success).toBe(false)
      // The raw technical code must not appear in the response.
      expect(body.error).not.toContain('M2')
      expect(body.error).not.toContain('office not present')
    })
  })
})

// ── Per-invite board scope projection ─────────────────────────────────────

describe('GET /api/teams/:teamId/detail scope projection', () => {
  const detail = {
    team: { id: 'X' },
    members: [],
    edges: [],
    roster: [],
    tasks: [
      { id: 't-own', assigneeAppId: 'member-self' },
      { id: 't-peer', assigneeAppId: 'member-other' },
    ],
    findings: [
      { id: 'f-own', authorAppId: 'member-self' },
      { id: 'f-peer', authorAppId: 'member-other' },
    ],
  }

  it('PIN request (no credential) sees the full board', async () => {
    getTeamDetail.mockReturnValue(detail)
    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/detail`)
      const body = await res.json()
      expect(body.data.tasks).toHaveLength(2)
      expect(body.data.findings).toHaveLength(2)
    })
  })

  it('assigned-visibility reader sees only its own tasks; non-discoverable hides peer findings', async () => {
    listMembersByTeam.mockReturnValue([
      {
        appId: 'member-self',
        memberIdentity: 'id-reader',
        scopeJson: JSON.stringify({ visibility: 'assigned', discoverable: false }),
      },
    ])
    getTeamDetail.mockReturnValue(detail)

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/detail`)
      const body = await res.json()
      expect(body.data.tasks.map((t: { id: string }) => t.id)).toEqual(['t-own'])
      expect(body.data.findings.map((f: { id: string }) => f.id)).toEqual(['f-own'])
    })
  })

  it('credential mapping to NO member sees an empty board (fail-closed)', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-self', memberIdentity: 'id-someone-else' }])
    getTeamDetail.mockReturnValue(detail)

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/detail`)
      const body = await res.json()
      expect(body.data.tasks).toEqual([])
      expect(body.data.findings).toEqual([])
    })
  })

  it('full+discoverable reader sees the whole board', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-self', memberIdentity: 'id-reader' }])
    getTeamDetail.mockReturnValue(detail)

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/detail`)
      const body = await res.json()
      expect(body.data.tasks).toHaveLength(2)
      expect(body.data.findings).toHaveLength(2)
    })
  })
})

// ── Member dispatch: POST /members/:appId/send ────────────────────────────

describe('POST /api/teams/:teamId/members/:appId/send scope gating', () => {
  async function post(base: string, teamId: string, appId: string, body: Record<string, unknown>) {
    return fetch(`${base}/api/teams/${teamId}/members/${appId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('PIN request (no credential) may dispatch and resolves the current epoch', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })

    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'member-1', { message: 'hello' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.data).toEqual({ ok: true, finalMessage: 'done' })
    })
    expect(sendToMember).toHaveBeenCalledWith({
      teamId: 'X',
      appId: 'member-1',
      epochId: 'epoch-1',
      message: 'hello',
      images: undefined,
      thinkingEnabled: undefined,
    })
  })

  it('404 when the target is not a member of the team', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'intruder', { message: 'hi' })
      expect(res.status).toBe(404)
    })
    expect(sendToMember).not.toHaveBeenCalled()
  })

  it('400 when message is missing', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'member-1', {})
      expect(res.status).toBe(400)
    })
    expect(sendToMember).not.toHaveBeenCalled()
  })

  it('403 when a credential maps to NO member (fail-closed)', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1', memberIdentity: 'id-someone-else' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'member-1', { message: 'hi' })
      expect(res.status).toBe(403)
    })
    expect(sendToMember).not.toHaveBeenCalled()
  })

  it('403 when a read-only caller tries to dispatch (canCoordinationWrite)', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader', scopeJson: JSON.stringify({ visibility: 'readonly' }) },
      { appId: 'target', memberIdentity: 'id-target' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'target', { message: 'hi' })
      expect(res.status).toBe(403)
    })
    expect(sendToMember).not.toHaveBeenCalled()
  })

  it('403 when a non-lead caller targets a lead-only member (canContact)', async () => {
    // target is contactable lead-only; the office lead is some OTHER appId, so a
    // non-lead caller cannot reach it.
    getTeamById.mockReturnValue({ leadAppId: 'the-lead' })
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader' },
      { appId: 'target', memberIdentity: 'id-target', scopeJson: JSON.stringify({ contactable: 'lead-only' }) },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'target', { message: 'hi' })
      expect(res.status).toBe(403)
    })
    expect(sendToMember).not.toHaveBeenCalled()
  })

  it('allows the lead caller to reach a lead-only target', async () => {
    getTeamById.mockReturnValue({ leadAppId: 'caller' })
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader' },
      { appId: 'target', memberIdentity: 'id-target', scopeJson: JSON.stringify({ contactable: 'lead-only' }) },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'target', { message: 'hi' })
      expect(res.status).toBe(200)
    })
    expect(sendToMember).toHaveBeenCalledTimes(1)
  })

  it('a full+contactable-all caller may dispatch to a peer', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader' }, // default full + contactable all
      { appId: 'target', memberIdentity: 'id-target' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'target', { message: 'hi', thinkingEnabled: true })
      expect(res.status).toBe(200)
    })
    expect(sendToMember).toHaveBeenCalledWith({
      teamId: 'X',
      appId: 'target',
      epochId: 'epoch-1',
      message: 'hi',
      images: undefined,
      thinkingEnabled: true,
    })
  })

  it('honors an explicit ?epochId in the body over the current epoch', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-current' })
    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'member-1', { message: 'hi', epochId: 'epoch-explicit' })
      expect(res.status).toBe(200)
    })
    expect(sendToMember).toHaveBeenCalledWith(
      expect.objectContaining({ epochId: 'epoch-explicit' }),
    )
  })
})
