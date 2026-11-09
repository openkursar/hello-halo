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
const getEpochById = vi.fn<[string], { id: string; teamId: string } | null>()
const getCurrentEpochForTeam = vi.fn<[string], { id: string } | null>()
const getOpenConversationEpoch = vi.fn<[string, string], { id: string } | null>()
const listEpochsByTeam = vi.fn<[string], Array<{ id: string }>>()
const getTeamById = vi.fn<[string], { leadAppId: string | null; ephemeral?: boolean } | null>()
const listEpochs = vi.fn<[string], unknown[]>()
const getTeamDetail = vi.fn<[string], unknown>()
const getEpochRoster = vi.fn<[string, string], unknown>()
const getEpochBoard = vi.fn<[string, string], unknown>()
const sendToMember = vi.fn<[unknown], Promise<unknown>>()
const stopMember = vi.fn<[unknown], Promise<unknown>>()
const listConversations = vi.fn<[string], unknown[]>()
const listArtifacts = vi.fn<[string, string?], Promise<unknown[]>>()

vi.mock('../../../../src/main/apps/team', async () => ({
  workMemberPrincipalId: (await vi.importActual<typeof import('../../../../src/main/apps/team/work-members')>('../../../../src/main/apps/team/work-members')).workMemberPrincipalId,
  getTeamService: () => ({
    getTeam: (teamId: string) => getTeamById(teamId),
    openTeamDetail: async (teamId: string) => getTeamDetail(teamId),
    listEpochs: (teamId: string) => listEpochs(teamId),
    getTeamDetail: (teamId: string) => getTeamDetail(teamId),
    getEpochRoster: (teamId: string, epochId: string) => getEpochRoster(teamId, epochId),
    getEpochBoard: (teamId: string, epochId: string) => getEpochBoard(teamId, epochId),
    sendToMember: (input: unknown) => sendToMember(input),
    stopMember: (input: unknown) => stopMember(input),
    listConversations: (teamId: string) => listConversations(teamId),
    listArtifacts: (teamId: string, epochId?: string) => listArtifacts(teamId, epochId),
  }),
  getTeamStore: () => ({
    listMembersByTeam: (teamId: string) => listMembersByTeam(teamId),
    getMember: (teamId: string, appId: string) => listMembersByTeam(teamId).find(member => member.appId === appId) ?? null,
    getEpochById: (id: string) => getEpochById(id),
    getCurrentEpochForTeam: (teamId: string) => getCurrentEpochForTeam(teamId),
    getOpenConversationEpoch: (teamId: string, chatKey: string) => getOpenConversationEpoch(teamId, chatKey),
    listEpochsByTeam: (teamId: string) => listEpochsByTeam(teamId),
    getTeamById: (teamId: string) => getTeamById(teamId),
  }),
}))

const readTeamMemberMessages = vi.fn<[string, string, string], unknown[]>()

vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  // Mirrors the real seq stamping so the route's sinceSeq handling is exercised.
  readTeamMemberHistory: (appId: string, teamId: string, epochId: string, sinceSeq?: number) => {
    const rows = readTeamMemberMessages(appId, teamId, epochId).map((m, i) => ({ ...(m as object), seq: i + 1 }))
    return sinceSeq ? rows.slice(sinceSeq) : rows
  },
}))

// Federation manager: a remote-owned member's transcript is pulled from its
// owner over the office link instead of read from local chat storage.
const fetchMemberHistory =
  vi.fn<
    [{ officeId: string; ownerNodeId: string; appId: string; epochId: string }],
    Promise<{ messages: unknown[]; stale: boolean }>
  >()

vi.mock('../../../../src/main/apps/runtime/federation/manager', () => ({
  getFederationManager: () => ({
    fetchMemberHistory: (params: { officeId: string; ownerNodeId: string; appId: string; epochId: string }) =>
      fetchMemberHistory(params),
  }),
}))

// A member send writes the references into its text; that needs only the block
// formatter, not the whole engine.
vi.mock('../../../../src/main/services/agent', async () => ({
  formatReferencesBlock: (await vi.importActual<typeof import('../../../../src/main/services/agent/references')>(
    '../../../../src/main/services/agent/references',
  )).formatReferencesBlock,
  getWorkingDir: (spaceId: string) => `/spaces/${spaceId}`,
}))

import { registerTeamRoutes } from '../../../../src/main/http/routes/team.routes'

// ── Test server ──────────────────────────────────────────────────────────────

/**
 * Build an Express app that optionally injects an office credential for
 * `officeId` (null = remote-control PIN request, full access). `identity`
 * defaults to a stable test identity so the scope projection can map it to a
 * member; pass an explicit value to model a different reader.
 */
function buildApp(officeId: string | null, identity = 'id-reader', assistant = false): Express {
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
  registerTeamRoutes(app, { assistant })
  return app
}

async function withServer(app: Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const { port } = server.address() as AddressInfo
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

it('binds the test listener to the IPv4 address used by its client', async () => {
  const app = express()
  app.get('/listener', (req, res) => {
    res.json({ address: req.socket.localAddress, family: req.socket.localFamily })
  })
  await withServer(app, async base => {
    const response = await fetch(`${base}/listener`)
    expect(await response.json()).toEqual({ address: '127.0.0.1', family: 'IPv4' })
  })
})

it('withholds temporary team resources from assistants even when they already know an ID', async () => {
  getTeamById.mockReturnValue({ leadAppId: 'lead-id', ephemeral: true })
  await withServer(buildApp(null, 'id-reader', true), async base => {
    for (const route of ['', '/detail', '/conversations', '/chat-messages?appId=member&epochId=work', '/artifacts']) {
      const response = await fetch(`${base}/api/teams/temporary${route}`)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining('Team not found') })
    }
    for (const route of ['/members/member/send', '/members/member/stop', '/save-collab']) {
      expect((await fetch(`${base}/api/teams/temporary${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    }
  })
  expect(getTeamDetail).not.toHaveBeenCalled()
  expect(sendToMember).not.toHaveBeenCalled()
  expect(stopMember).not.toHaveBeenCalled()
})

it('keeps standing teams available to assistants and source team records available to owner clients', async () => {
  getTeamById.mockReturnValue({ leadAppId: 'lead-id', ephemeral: false })
  await withServer(buildApp(null, 'id-reader', true), async base => {
    expect((await fetch(`${base}/api/teams/saved`)).status).toBe(200)
  })
  getTeamById.mockReturnValue({ leadAppId: 'source-id', ephemeral: true })
  await withServer(buildApp(null), async base => {
    expect((await (await fetch(`${base}/api/teams/temporary`)).json()).data).toMatchObject({ ephemeral: true })
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  listEpochs.mockReturnValue([])
  listMembersByTeam.mockReturnValue([])
  getEpochById.mockImplementation(id => ({ id, teamId: 'X' }))
  getCurrentEpochForTeam.mockReturnValue(null)
  getOpenConversationEpoch.mockReturnValue(null)
  listEpochsByTeam.mockReturnValue([])
  getTeamById.mockReturnValue({ leadAppId: null })
  getTeamDetail.mockReturnValue(null)
  getEpochBoard.mockReturnValue(null)
  getEpochRoster.mockReturnValue(null)
  readTeamMemberMessages.mockReturnValue([])
  fetchMemberHistory.mockResolvedValue({ messages: [], stale: false })
  sendToMember.mockResolvedValue({ ok: true, finalMessage: 'done' })
  stopMember.mockResolvedValue({ ok: true, stopped: true })
  listConversations.mockReturnValue([])
})

/** Recent conversations of team X as the service lists them, one already ended. */
function seedConversations(): void {
  listConversations.mockReturnValue([
    { epochId: 'e-release', teamId: 'X', kind: 'native', label: 'Release', readonly: false, completed: false, startedAt: 1, lastActivityAt: 30, active: true },
    { epochId: 'e-done', teamId: 'X', kind: 'native', label: 'Old bug', readonly: false, completed: true, startedAt: 1, lastActivityAt: 50 },
    { epochId: 'e-im', teamId: 'X', kind: 'im', label: 'Ops group', readonly: true, completed: false, startedAt: 1, lastActivityAt: 40 },
  ])
}

/** A request that names no conversation: refused, with the open ones to choose from unless a teammate asks. */
async function expectConversationRequired(res: Response, listed: boolean): Promise<void> {
  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body).toMatchObject({ success: false, code: 'halo.team.conversation_required' })
  if (listed) {
    expect(body.candidates).toEqual([
      { epochId: 'e-im', label: 'Ops group', kind: 'im', active: false, lastActivityAt: 40 },
      { epochId: 'e-release', label: 'Release', kind: 'native', active: true, lastActivityAt: 30 },
    ])
  } else {
    expect(body).not.toHaveProperty('candidates')
  }
}

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
      '/api/teams/Y/epochs/e1/roster',
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
  it('returns messages for the reader own member appId (200) in the conversation it names', async () => {
    // The office reader (identity id-reader) owns member-1; reading its OWN
    // transcript is always allowed regardless of scope.
    listMembersByTeam.mockReturnValue([{ appId: 'member-1', memberIdentity: 'id-reader' }])
    readTeamMemberMessages.mockReturnValue([{ id: 'm1', role: 'assistant', content: 'hi' }])

    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-1&epochId=epoch-1`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.data).toHaveLength(1)
    })
    expect(readTeamMemberMessages).toHaveBeenCalledWith('member-1', 'X', 'epoch-1')
  })

  it('returns only rows after ?sinceSeq, stamped with seq', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    readTeamMemberMessages.mockReturnValue([
      { id: 'm1', role: 'user', content: 'a' },
      { id: 'm2', role: 'assistant', content: 'b' },
      { id: 'm3', role: 'user', content: 'c' },
    ])

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-1&epochId=epoch-1&sinceSeq=2`)
      const body = await res.json()
      expect(body.data).toEqual([{ id: 'm3', role: 'user', content: 'c', seq: 3 }])
    })
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

  it('refuses a read that names no conversation, even with a run open, listing the open ones newest first', async () => {
    // Reading "the" transcript used to pick the open run, then the member's own
    // chat, then the newest conversation — another task's words, read as this one's.
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'e-release' })
    seedConversations()

    await withServer(buildApp(null), async (base) => {
      await expectConversationRequired(await fetch(`${base}/api/teams/X/chat-messages?appId=member-1`), true)
    })
    expect(readTeamMemberMessages).not.toHaveBeenCalled()
  })

  it('refuses a teammate\u2019s credential the same way, without the team\u2019s list', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1', memberIdentity: 'id-reader' }])
    seedConversations()

    await withServer(buildApp('X'), async (base) => {
      await expectConversationRequired(await fetch(`${base}/api/teams/X/chat-messages?appId=member-1`), false)
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
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-other&epochId=epoch-1`)
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
    fetchMemberHistory.mockResolvedValue({ messages: [{ role: 'assistant', content: 'from owner', ts: 1 }], stale: false })

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-remote&epochId=epoch-1`)
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

  it('marks a cached transcript served while the owner is offline as stale (Blocker-2)', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'member-remote', origin: 'remote', ownerNodeId: 'node-owner' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    // Owner unreachable → manager serves the cached copy flagged stale.
    fetchMemberHistory.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'cached', ts: 1 }],
      stale: true,
    })

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-remote&epochId=epoch-1`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.data).toEqual([{ role: 'assistant', content: 'cached', ts: 1 }])
      expect(body.stale).toBe(true) // renderer shows the "offline" notice
    })
  })

  it('translates an owner fetch failure to a neutral 502 (never leaks the technical error)', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'member-remote', origin: 'remote', ownerNodeId: 'node-owner' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    fetchMemberHistory.mockRejectedValue(new Error('history: office not present or M2 off office=X'))

    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/chat-messages?appId=member-remote&epochId=epoch-1`)
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

// ── Per-invite artifact scope projection ──────────────────────────────────

describe('GET /api/teams/:teamId/artifacts scope projection', () => {
  const groups = [
    { appId: 'member-self', memberName: 'self', spaceId: 's1', artifacts: [] },
    { appId: 'member-other', memberName: 'other', spaceId: 's2', artifacts: [] },
  ]

  it('PIN request (no credential) sees every member group', async () => {
    listArtifacts.mockResolvedValue(groups)
    await withServer(buildApp(null), async (base) => {
      const res = await fetch(`${base}/api/teams/X/artifacts`)
      const body = await res.json()
      expect(body.data.map((g: { appId: string }) => g.appId)).toEqual(['member-self', 'member-other'])
    })
  })

  it('narrow reader (assigned, non-discoverable) sees ONLY its own member group', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'member-self', memberIdentity: 'id-reader', scopeJson: JSON.stringify({ visibility: 'assigned', discoverable: false }) },
    ])
    listArtifacts.mockResolvedValue(groups)
    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/artifacts`)
      const body = await res.json()
      expect(body.data.map((g: { appId: string }) => g.appId)).toEqual(['member-self'])
    })
  })

  it('full+discoverable reader sees every group; epoch artifacts route projects too', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-self', memberIdentity: 'id-reader' }])
    listArtifacts.mockResolvedValue(groups)
    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/epochs/e1/artifacts`)
      const body = await res.json()
      expect(body.data).toHaveLength(2)
    })
  })

  it('credential mapping to NO member sees nothing (fail-closed)', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-self', memberIdentity: 'id-other' }])
    listArtifacts.mockResolvedValue(groups)
    await withServer(buildApp('X'), async (base) => {
      const res = await fetch(`${base}/api/teams/X/artifacts`)
      const body = await res.json()
      expect(body.data).toEqual([])
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

  it('PIN request (no credential) may dispatch into the conversation it names', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])

    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'member-1', { message: 'hello', epochId: 'epoch-1' })
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
      const res = await post(base, 'X', 'target', { message: 'hi', epochId: 'epoch-1' })
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
      const res = await post(base, 'X', 'target', { message: 'hi', thinkingEnabled: true, epochId: 'epoch-1' })
      expect(res.status).toBe(200)
    })
    expect(sendToMember).toHaveBeenCalledWith({
      teamId: 'X',
      appId: 'target',
      epochId: 'epoch-1',
      message: 'hi',
      images: undefined,
      thinkingEnabled: true,
      // The credential is what says this came from another person's machine,
      // and the woken member is held to what its owner granted teammates
      // rather than to the owner's own reach.
      external: true,
    })
  })

  it('does not mark the owner\u2019s own remote access as coming from elsewhere', async () => {
    // Same route, no office credential: this is the owner reaching their own
    // machine from a phone, and marking it external would restrict them in
    // their own office.
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'member-1', { message: 'hi', epochId: 'epoch-1' })
      expect(res.status).toBe(200)
    })
    expect(sendToMember).toHaveBeenCalledWith(
      expect.not.objectContaining({ external: expect.anything() }),
    )
  })

  it('writes the places the person pointed at into the text, relative only to a space of the owner\u2019s own', async () => {
    const reference = {
      id: 'r1',
      source: { kind: 'file', path: '/spaces/s1/src/a.ts', precision: 'lines' },
      range: { startLine: 4, endLine: 4 },
      quote: 'x()',
    }
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader' },
      { appId: 'member-1', memberIdentity: 'id-target' },
    ])
    getCurrentEpochForTeam.mockReturnValue({ id: 'epoch-1' })
    await withServer(buildApp(null), async (base) => {
      // Cards alone are a message too.
      expect((await post(base, 'X', 'member-1', { message: '', spaceId: 's1', references: [reference], epochId: 'epoch-1' })).status).toBe(200)
      expect((await post(base, 'X', 'member-1', { message: 'hi', references: [{ id: 1 }] })).status).toBe(400)
    })
    await withServer(buildApp('X'), async (base) => {
      expect((await post(base, 'X', 'member-1', { message: 'hi', spaceId: 's1', references: [reference], epochId: 'epoch-1' })).status).toBe(200)
    })
    const [own, teammate] = sendToMember.mock.calls.map(([input]) => (input as { message: string }).message)
    expect(own).toMatch(/^<halo_references>\n[\s\S]*\[1\] src\/a\.ts, line 4\n/)
    // A teammate's machine cannot name a folder of this one.
    expect(teammate).toMatch(/^hi\n\n<halo_references>\n[\s\S]*\[1\] \/spaces\/s1\/src\/a\.ts, line 4\n/)
    expect(sendToMember).toHaveBeenCalledTimes(2)
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

  it('refuses a message that names no conversation, even with a run open, and lists the open ones', async () => {
    // The newest task used to catch an unnamed message; that is how a result
    // landed in a task it had nothing to do with.
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    getCurrentEpochForTeam.mockReturnValue({ id: 'e-release' })
    seedConversations()
    await withServer(buildApp(null), async (base) => {
      await expectConversationRequired(await post(base, 'X', 'member-1', { message: 'Results are in' }), true)
    })
    expect(sendToMember).not.toHaveBeenCalled()
  })

  it('refuses a teammate\u2019s unnamed message without showing it the team\u2019s list', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader' },
      { appId: 'target', memberIdentity: 'id-target' },
    ])
    seedConversations()
    await withServer(buildApp('X'), async (base) => {
      await expectConversationRequired(await post(base, 'X', 'target', { message: 'hi' }), false)
    })
    expect(sendToMember).not.toHaveBeenCalled()
  })
})

// ── Member dispatch: POST /members/:appId/stop ────────────────────────────

describe('POST /api/teams/:teamId/members/:appId/stop scope gating', () => {
  async function post(base: string, teamId: string, appId: string, body: Record<string, unknown> = {}) {
    return fetch(`${base}/api/teams/${teamId}/members/${appId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('refuses a stop that names no conversation and stops nothing', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    seedConversations()

    await withServer(buildApp(null), async (base) => {
      await expectConversationRequired(await post(base, 'X', 'member-1'), true)
    })
    expect(stopMember).not.toHaveBeenCalled()
  })

  it('honors an explicit epochId in the body', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'member-1', { epochId: 'epoch-explicit' })
      expect(res.status).toBe(200)
    })
    expect(stopMember).toHaveBeenCalledWith({ teamId: 'X', appId: 'member-1', epochId: 'epoch-explicit' })
  })

  it('404 when the target is not a member of the team', async () => {
    listMembersByTeam.mockReturnValue([{ appId: 'member-1' }])
    await withServer(buildApp(null), async (base) => {
      const res = await post(base, 'X', 'intruder')
      expect(res.status).toBe(404)
    })
    expect(stopMember).not.toHaveBeenCalled()
  })

  it('403 when a read-only caller tries to stop a peer (gated as dispatching to it)', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader', scopeJson: JSON.stringify({ visibility: 'readonly' }) },
      { appId: 'target', memberIdentity: 'id-target' },
    ])
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'target')
      expect(res.status).toBe(403)
    })
    expect(stopMember).not.toHaveBeenCalled()
  })

  it('403 when a non-lead caller targets a lead-only member', async () => {
    getTeamById.mockReturnValue({ leadAppId: 'the-lead' })
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader' },
      { appId: 'target', memberIdentity: 'id-target', scopeJson: JSON.stringify({ contactable: 'lead-only' }) },
    ])
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'target')
      expect(res.status).toBe(403)
    })
    expect(stopMember).not.toHaveBeenCalled()
  })

  it('a full+contactable-all caller may stop a peer', async () => {
    listMembersByTeam.mockReturnValue([
      { appId: 'caller', memberIdentity: 'id-reader' },
      { appId: 'target', memberIdentity: 'id-target' },
    ])
    await withServer(buildApp('X'), async (base) => {
      const res = await post(base, 'X', 'target', { epochId: 'epoch-1' })
      expect(res.status).toBe(200)
    })
    expect(stopMember).toHaveBeenCalledTimes(1)
  })
})


describe('GET /api/teams/:teamId/epochs/:epochId/roster', () => {
  it('reads only scoped membership without loading the board history', async () => {
    const roster = { members: [{ appId: 'temporary' }], roster: [{ appId: 'temporary', status: 'working' }] }
    getEpochRoster.mockReturnValue(roster)
    await withServer(buildApp('X'), async base => {
      const response = await fetch(`${base}/api/teams/X/epochs/work-a/roster`)
      expect(await response.json()).toEqual({ success: true, data: roster })
    })
    expect(getEpochRoster).toHaveBeenCalledWith('X', 'work-a')
    expect(getEpochBoard).not.toHaveBeenCalled()
  })
})
