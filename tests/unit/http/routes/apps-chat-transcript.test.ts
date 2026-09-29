/**
 * Paged digital-human transcript routes, driven the way a remote client drives
 * them: chat/transcript (newest-first pages, no thought processes) and
 * chat/messages/:messageId/thoughts (one message's thought process on demand).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { Express } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'

const loadChatTranscriptForConversation = vi.fn()
const loadChatMessageThoughts = vi.fn()
let installed: { id: string; spaceId: string | null } | null = { id: 'app-1', spaceId: 'space-a' }
let space: { id: string; path: string } | null = { id: 'space-a', path: '/tmp/space-a' }

vi.mock('../../../../src/main/http/routes/_shared', () => ({
  AppAlreadyInstalledError: class extends Error {},
  McpCommandBlockedError: class extends Error {},
  MCP_COMMAND_BLOCKED: 'MCP_COMMAND_BLOCKED',
  appController: {},
  broadcastToAll: vi.fn(),
  getAppManager: () => ({ getApp: (id: string) => (installed && installed.id === id ? installed : null) }),
  getSpace: () => space,
  getAppChatConversationId: (appId: string) => `app-chat:${appId}`,
  loadChatTranscriptForConversation: (...args: unknown[]) => loadChatTranscriptForConversation(...args),
  loadChatMessageThoughts: (...args: unknown[]) => loadChatMessageThoughts(...args),
}))

const getEpochById = vi.fn()
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamStore: () => ({ getEpochById: (id: string) => getEpochById(id), getMember: () => ({ appId: 'app-1' }) }),
}))

import { registerAppsRoutes } from '../../../../src/main/http/routes/apps.routes'

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app: Express = express()
  app.use(express.json())
  registerAppsRoutes(app)
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const PAGE = { messages: [{ id: 'session-msg-3', role: 'user', content: 'hi', timestamp: 't' }], hasMoreBefore: false, cursor: 'session-msg-3', total: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  installed = { id: 'app-1', spaceId: 'space-a' }
  space = { id: 'space-a', path: '/tmp/space-a' }
  loadChatTranscriptForConversation.mockReturnValue(PAGE)
  loadChatMessageThoughts.mockReturnValue([{ id: 'th', type: 'thinking', content: 'x', timestamp: 't' }])
  getEpochById.mockReturnValue({ id: 'epoch-9', teamId: 'team-7' })
})

describe('GET chat/transcript', () => {
  it('reads the default session newest page with the paging query', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/apps/app-1/chat/transcript?before=session-msg-40&limit=25&through=session-msg-9`)
      expect(await res.json()).toEqual({ success: true, data: PAGE })
      expect(loadChatTranscriptForConversation).toHaveBeenCalledWith('/tmp/space-a', 'app-1', 'app-chat:app-1', {
        before: 'session-msg-40',
        limit: 25,
        through: 'session-msg-9',
      })
    })
  })

  it('treats missing or malformed paging params as "newest page, default size"', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/api/apps/app-1/chat/transcript?limit=abc`)
      expect(loadChatTranscriptForConversation).toHaveBeenCalledWith('/tmp/space-a', 'app-1', 'app-chat:app-1', {
        before: undefined,
        limit: undefined,
      })
    })
  })

  it('addresses a validated team session, and refuses an unreal one', async () => {
    const key = buildTeamSessionKey('app-1', 'team-7', 'epoch-9')
    await withServer(async (base) => {
      const ok = await fetch(`${base}/api/apps/app-1/chat/transcript?conversationId=${encodeURIComponent(key)}`)
      expect(ok.status).toBe(200)
      expect(loadChatTranscriptForConversation.mock.calls[0][2]).toBe(key)

      getEpochById.mockReturnValue(null)
      loadChatTranscriptForConversation.mockClear()
      const refused = await fetch(`${base}/api/apps/app-1/chat/transcript?conversationId=${encodeURIComponent(key)}`)
      expect(refused.status).toBe(404)
      expect(loadChatTranscriptForConversation).not.toHaveBeenCalled()
    })
  })

  it('refuses a key that addresses another app', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/apps/app-1/chat/transcript?conversationId=app-chat:other:http:direct:x`)
      expect(res.status).toBe(400)
      expect(loadChatTranscriptForConversation).not.toHaveBeenCalled()
    })
  })

  it('answers 404 for an unknown app and an empty page when the app has no space yet', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/apps/ghost/chat/transcript`)).status).toBe(404)

      installed = { id: 'app-1', spaceId: null }
      const res = await fetch(`${base}/api/apps/app-1/chat/transcript`)
      expect((await res.json()).data).toEqual({ messages: [], hasMoreBefore: false, cursor: null, total: 0 })
      expect(loadChatTranscriptForConversation).not.toHaveBeenCalled()
    })
  })
})

describe('GET chat/messages/:messageId/thoughts', () => {
  it('loads one message thought process from the addressed session', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/apps/app-1/chat/messages/session-msg-7/thoughts`)
      expect((await res.json()).data).toHaveLength(1)
      expect(loadChatMessageThoughts).toHaveBeenCalledWith('/tmp/space-a', 'app-1', 'app-chat:app-1', 'session-msg-7')
    })
  })

  it('applies the same session trust boundary', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/apps/app-1/chat/messages/m/thoughts?conversationId=app-chat:other:http:direct:x`)
      expect(res.status).toBe(400)
      expect(loadChatMessageThoughts).not.toHaveBeenCalled()
    })
  })

  it('answers an empty list when there is no space', async () => {
    space = null
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/apps/app-1/chat/messages/m/thoughts`)
      expect((await res.json()).data).toEqual([])
    })
  })
})
