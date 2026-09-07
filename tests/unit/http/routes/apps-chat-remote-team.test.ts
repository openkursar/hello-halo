/**
 * App-chat HTTP routes, driven the way a REMOTE client drives them.
 *
 * This layer had no coverage at all, and that is the single reason two defects
 * shipped together on the team branch: the desktop client reaches a team session
 * over IPC and the remote client reaches the same session over these routes, so
 * every team feature was exercised on exactly one of the two paths. A team
 * conversationId was rejected outright here — send, status, history, stop and
 * clear alike — while every local test stayed green.
 *
 * What is pinned:
 *   1. a team conversationId is ADDRESSABLE over HTTP, on every app-chat route;
 *   2. and only when it is real: unknown epoch, epoch belonging to another team,
 *      and an app that is not a member are each refused;
 *   3. IM keys stay refused (an HTTP caller must never inject into an IM session);
 *   4. the team identity a turn runs under is DERIVED, never taken from the body;
 *   5. stopping every session of a digital human must be asked for explicitly.
 *
 * The heavy apps/runtime barrel is mocked so this exercises route wiring and the
 * trust boundary only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { Express } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { buildTeamSessionKey, buildImSessionKey } from '../../../../src/shared/apps/im-keys'

// ── Mocks ──────────────────────────────────────────────────────────────────

const sendAppChatMessage = vi.fn<[Record<string, unknown>], Promise<void>>()
const stopAppChat = vi.fn<[string], Promise<void>>()
const stopAppChatConversation = vi.fn<[string], Promise<void>>()
const clearAppChat = vi.fn<[string, string, string | undefined], Promise<void>>()
const isAppChatConversationGenerating = vi.fn<[string], boolean>()
const loadChatMessagesForConversation = vi.fn<[string, string, string], unknown[]>()
const getAppChatSessionState = vi.fn<[string, string | undefined], unknown>()

vi.mock('../../../../src/main/http/routes/_shared', () => {
  class AppAlreadyInstalledError extends Error {}
  class McpCommandBlockedError extends Error {}
  return {
    AppAlreadyInstalledError,
    McpCommandBlockedError,
    MCP_COMMAND_BLOCKED: 'MCP_COMMAND_BLOCKED',
    appController: {},
    broadcastToAll: vi.fn(),
    clearAppChat: (appId: string, spaceId: string, conversationId?: string) =>
      clearAppChat(appId, spaceId, conversationId),
    clearImSession: vi.fn(),
    stopImSession: vi.fn(),
    getAppChatConversationId: (appId: string) => `app-chat:${appId}`,
    getAppChatSessionState: (appId: string, conversationId?: string) =>
      getAppChatSessionState(appId, conversationId),
    getAppManager: () => ({ getApp: (id: string) => ({ id, spaceId: 'space-a', spec: {} }) }),
    getAppRuntime: () => ({}),
    getSpace: () => ({ id: 'space-a', path: '/tmp/space-a' }),
    isAppChatGenerating: () => false,
    isAppChatConversationGenerating: (conversationId: string) =>
      isAppChatConversationGenerating(conversationId),
    isMcpAppSpec: () => false,
    listAvailableSkills: vi.fn(),
    deriveSkillCommandName: vi.fn(),
    loadAppChatMessages: () => [],
    loadImChatMessages: () => [],
    loadChatMessagesForConversation: (spacePath: string, appId: string, conversationId: string) =>
      loadChatMessagesForConversation(spacePath, appId, conversationId),
    createNativeChatSession: vi.fn(),
    forkNativeChatSession: vi.fn(),
    deleteNativeChatSession: vi.fn(),
    patchTouchesMcp: () => false,
    readSessionMessages: () => [],
    rejectIfRemoteMcpForbidden: () => false,
    restartAppChat: vi.fn(),
    sendAppChatMessage: (request: Record<string, unknown>) => sendAppChatMessage(request),
    stopAppChat: (appId: string) => stopAppChat(appId),
    stopAppChatConversation: (conversationId: string) => stopAppChatConversation(conversationId),
    writeMcpCommandBlockedResponse: vi.fn(),
    yamlIsMcpSpec: () => false,
  }
})

interface MockEpoch {
  id: string
  teamId: string
  endedAt?: number | null
}
const getEpochById = vi.fn<[string], MockEpoch | null>()
const getMember = vi.fn<[string, string], { appId: string; origin?: 'local' | 'remote'; ownerNodeId?: string } | null>()

vi.mock('../../../../src/main/apps/team', () => ({
  getTeamStore: () => ({
    getEpochById: (epochId: string) => getEpochById(epochId),
    getMember: (teamId: string, appId: string) => getMember(teamId, appId),
  }),
}))

import { registerAppsRoutes } from '../../../../src/main/http/routes/apps.routes'

// ── Test server ──────────────────────────────────────────────────────────────

const LEAD_APP = 'app-lead'
const TEAM_ID = 'team-7'
const EPOCH_ID = 'epoch-9'
const TEAM_KEY = buildTeamSessionKey(LEAD_APP, TEAM_ID, EPOCH_ID)

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  registerAppsRoutes(app)
  return app
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = await new Promise((resolve) => {
    const s = buildApp().listen(0, () => resolve(s))
  })
  try {
    const { port } = server.address() as AddressInfo
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sendAppChatMessage.mockResolvedValue(undefined)
  stopAppChat.mockResolvedValue(undefined)
  stopAppChatConversation.mockResolvedValue(undefined)
  clearAppChat.mockResolvedValue(undefined)
  isAppChatConversationGenerating.mockReturnValue(false)
  loadChatMessagesForConversation.mockReturnValue([])
  getAppChatSessionState.mockReturnValue({})
  getEpochById.mockReturnValue({ id: EPOCH_ID, teamId: TEAM_ID })
  getMember.mockReturnValue({ appId: LEAD_APP })
})

// ── 1. A team session is reachable over HTTP at all ──────────────────────────

describe('team sessions over the remote HTTP path', () => {
  it('POST chat/send accepts a team conversationId', async () => {
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'one more instruction',
        conversationId: TEAM_KEY,
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: { conversationId: TEAM_KEY } })
      expect(sendAppChatMessage).toHaveBeenCalledTimes(1)
      expect(sendAppChatMessage.mock.calls[0][0]).toMatchObject({
        appId: LEAD_APP,
        spaceId: 'space-a',
        message: 'one more instruction',
        conversationId: TEAM_KEY,
      })
    })
  })

  it('the whole read/control family accepts it too, not just send', async () => {
    await withServer(async (base) => {
      const q = `conversationId=${encodeURIComponent(TEAM_KEY)}`

      const status = await fetch(`${base}/api/apps/${LEAD_APP}/chat/status?${q}`)
      expect(status.status).toBe(200)
      expect((await status.json()).data.conversationId).toBe(TEAM_KEY)

      const messages = await fetch(`${base}/api/apps/${LEAD_APP}/chat/messages?spaceId=space-a&${q}`)
      expect(messages.status).toBe(200)
      expect(loadChatMessagesForConversation).toHaveBeenCalledWith('/tmp/space-a', LEAD_APP, TEAM_KEY)

      const state = await fetch(`${base}/api/apps/${LEAD_APP}/chat/session-state?${q}`)
      expect(state.status).toBe(200)
      expect(getAppChatSessionState).toHaveBeenCalledWith(LEAD_APP, TEAM_KEY)

      const stop = await post(base, `/api/apps/${LEAD_APP}/chat/stop`, { conversationId: TEAM_KEY })
      expect(stop.status).toBe(200)
      expect(stopAppChatConversation).toHaveBeenCalledWith(TEAM_KEY)

      const clear = await post(base, `/api/apps/${LEAD_APP}/chat/clear`, {
        spaceId: 'space-a',
        conversationId: TEAM_KEY,
      })
      expect(clear.status).toBe(200)
      expect(clearAppChat).toHaveBeenCalledWith(LEAD_APP, 'space-a', TEAM_KEY)
    })
  })
})

// ── 2. Only a REAL team session ──────────────────────────────────────────────

describe('team conversationId ownership', () => {
  it('refuses an epoch that does not exist', async () => {
    getEpochById.mockReturnValue(null)
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: TEAM_KEY,
      })
      expect(res.status).toBe(404)
      expect(sendAppChatMessage).not.toHaveBeenCalled()
    })
  })

  it('refuses an epoch that belongs to a different team', async () => {
    getEpochById.mockReturnValue({ id: EPOCH_ID, teamId: 'someone-elses-team' })
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: TEAM_KEY,
      })
      expect(res.status).toBe(404)
      expect(sendAppChatMessage).not.toHaveBeenCalled()
    })
  })

  it('refuses an app that is not a member of that team', async () => {
    getMember.mockReturnValue(null)
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: TEAM_KEY,
      })
      expect(res.status).toBe(403)
      expect(sendAppChatMessage).not.toHaveBeenCalled()
    })
  })

  it('refuses a member owned by another machine, rather than accepting and failing later', async () => {
    // Its app is not installed here, so the turn cannot run on this machine. Without
    // this the send is answered 200 and only fails inside a fire-and-forget promise
    // the caller never sees — the same "looks sent, was not" shape this work removes.
    // Mirrors the IM binding's rule in dispatch-inbound's resolveTeamBacking.
    getMember.mockReturnValue({ appId: LEAD_APP, origin: 'remote', ownerNodeId: 'node-b' })
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: TEAM_KEY,
      })
      expect(res.status).toBe(403)
      expect(sendAppChatMessage).not.toHaveBeenCalled()
    })
  })

  it('still allows a sealed epoch — a seal is reversible and the desktop path allows it', async () => {
    getEpochById.mockReturnValue({ id: EPOCH_ID, teamId: TEAM_ID, endedAt: Date.now() })
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'picking this back up',
        conversationId: TEAM_KEY,
      })
      expect(res.status).toBe(200)
      expect(sendAppChatMessage).toHaveBeenCalledTimes(1)
    })
  })

  it('refuses ids outside the filename-safe charset before touching the store', async () => {
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: `app-chat:${LEAD_APP}:team:${TEAM_ID}:../../etc`,
      })
      expect(res.status).toBe(400)
      expect(getEpochById).not.toHaveBeenCalled()
    })
  })

  it('still refuses an IM key (an HTTP caller must not reach an IM session)', async () => {
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: buildImSessionKey(LEAD_APP, 'wecom-bot', 'direct', 'user-1'),
      })
      expect(res.status).toBe(400)
      expect(sendAppChatMessage).not.toHaveBeenCalled()
    })
  })
})

// ── 3. Identity is derived, never accepted ───────────────────────────────────

describe('team identity on a remote send', () => {
  it('derives the team context from the validated conversationId', async () => {
    await withServer(async (base) => {
      await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: TEAM_KEY,
      })

      const sent = sendAppChatMessage.mock.calls[0][0] as { teamContext?: Record<string, unknown> }
      expect(sent.teamContext).toMatchObject({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: null, wait: false })
      // No trigger kind: this is the OWNER reaching their own digital human from
      // another device, exactly as the desktop client does. A kind here would put
      // the owner's own chat under the capability policy meant for a teammate.
      expect(sent.teamContext?.kind).toBeUndefined()
    })
  })

  it('ignores a team context supplied by the caller', async () => {
    await withServer(async (base) => {
      await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        conversationId: TEAM_KEY,
        teamContext: {
          teamId: 'other-team',
          epochId: 'other-epoch',
          correlationId: 'forged',
          fromAppId: 'app-someone-else',
          wait: false,
          kind: 'message',
        },
      })

      const sent = sendAppChatMessage.mock.calls[0][0] as { teamContext?: Record<string, unknown> }
      expect(sent.teamContext).toMatchObject({ teamId: TEAM_ID, epochId: EPOCH_ID, fromAppId: null })
      expect(sent.teamContext?.correlationId).not.toBe('forged')
    })
  })

  it('drops any other identity-bearing field the body carries', async () => {
    await withServer(async (base) => {
      await post(base, `/api/apps/${LEAD_APP}/chat/send`, {
        spaceId: 'space-a',
        message: 'hi',
        senderIdentity: { id: 'x', name: 'Somebody Else' },
        relayOrigin: { appId: 'app-other' },
      })

      const sent = sendAppChatMessage.mock.calls[0][0]
      expect(sent).not.toHaveProperty('senderIdentity')
      expect(sent).not.toHaveProperty('relayOrigin')
    })
  })

  it('fails at once on a missing message or spaceId rather than downstream', async () => {
    await withServer(async (base) => {
      expect((await post(base, `/api/apps/${LEAD_APP}/chat/send`, { spaceId: 'space-a' })).status).toBe(400)
      expect((await post(base, `/api/apps/${LEAD_APP}/chat/send`, { message: 'hi' })).status).toBe(400)
      expect(sendAppChatMessage).not.toHaveBeenCalled()
    })
  })
})

// ── 4. Stopping everything must be asked for ─────────────────────────────────

describe('POST chat/stop', () => {
  it('refuses to stop every session when no conversationId is given', async () => {
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/stop`, {})
      expect(res.status).toBe(400)
      expect(stopAppChat).not.toHaveBeenCalled()
      expect(stopAppChatConversation).not.toHaveBeenCalled()
    })
  })

  it('stops every session only when explicitly asked', async () => {
    await withServer(async (base) => {
      const res = await post(base, `/api/apps/${LEAD_APP}/chat/stop`, { all: true })
      expect(res.status).toBe(200)
      expect(stopAppChat).toHaveBeenCalledWith(LEAD_APP)
    })
  })
})
