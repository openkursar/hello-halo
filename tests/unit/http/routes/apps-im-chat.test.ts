/**
 * The im-chat routes (read, stop and clear one IM session of a digital human)
 * address the session by its parts, so they check those parts the way the
 * chat routes check a conversationId: a malformed channel, chat type or chat
 * id is a 400 before anything below the route is asked, and a well-formed one
 * reaches the runtime exactly as given.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

const clearImSession = vi.fn<[string, string, string, string, string], Promise<void>>()
const stopImSession = vi.fn<[string, string, string, string], Promise<{ stopped: boolean }>>()
const loadImChatMessages = vi.fn<[string, string, string, string, string], unknown[]>()

vi.mock('../../../../src/main/http/routes/_shared', () => {
  class AppAlreadyInstalledError extends Error {}
  class McpCommandBlockedError extends Error {}
  return {
    AppAlreadyInstalledError,
    McpCommandBlockedError,
    MCP_COMMAND_BLOCKED: 'MCP_COMMAND_BLOCKED',
    appController: {},
    broadcastToAll: vi.fn(),
    clearAppChat: vi.fn(),
    clearImSession: (...args: [string, string, string, string, string]) => clearImSession(...args),
    stopImSession: (...args: [string, string, string, string]) => stopImSession(...args),
    getAppChatConversationId: (appId: string) => `app-chat:${appId}`,
    getAppChatSessionState: vi.fn(),
    getAppManager: () => ({ getApp: (id: string) => ({ id, spaceId: 'space-a', spec: {} }) }),
    getAppRuntime: () => ({}),
    getSpace: () => ({ id: 'space-a', path: '/tmp/space-a' }),
    isAppChatGenerating: () => false,
    isAppChatConversationGenerating: () => false,
    isMcpAppSpec: () => false,
    listAvailableSkills: vi.fn(),
    deriveSkillCommandName: vi.fn(),
    loadAppChatMessages: () => [],
    loadImChatMessages: (...args: [string, string, string, string, string]) => loadImChatMessages(...args),
    loadChatMessagesForConversation: () => [],
    createNativeChatSession: vi.fn(),
    forkNativeChatSession: vi.fn(),
    deleteNativeChatSession: vi.fn(),
    patchTouchesMcp: () => false,
    readSessionMessages: () => [],
    rejectIfRemoteMcpForbidden: () => false,
    restartAppChat: vi.fn(),
    sendAppChatMessage: vi.fn(),
    stopAppChat: vi.fn(),
    stopAppChatConversation: vi.fn(),
    writeMcpCommandBlockedResponse: vi.fn(),
    yamlIsMcpSpec: () => false,
  }
})

import { registerAppsRoutes } from '../../../../src/main/http/routes/apps.routes'

const APP = 'app-1'
const WECHAT_ID = 'o9cq80Abc@im.wechat'

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.json())
  registerAppsRoutes(app)
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const messagesQuery = (parts: Record<string, string>) =>
  `/api/apps/${APP}/im-chat/messages?${new URLSearchParams({ spaceId: 'space-a', ...parts })}`

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  clearImSession.mockResolvedValue(undefined)
  stopImSession.mockResolvedValue({ stopped: true })
  loadImChatMessages.mockReturnValue([{ id: 'm1', role: 'user', content: 'hi' }])
})

describe('reading an IM session', () => {
  it('passes a well-formed session to the runtime as given, a missing chat type read as direct', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}${messagesQuery({ channel: 'weixin-ilink-bot', chatId: WECHAT_ID })}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: [{ id: 'm1', role: 'user', content: 'hi' }] })
      expect(loadImChatMessages).toHaveBeenCalledWith('/tmp/space-a', APP, 'weixin-ilink-bot', 'direct', WECHAT_ID)
    })
  })

  it('answers 400 for a channel, chat type or chat id that cannot address an IM session, reading nothing', async () => {
    await withServer(async (base) => {
      for (const parts of [
        { channel: 'wecom', chatId: 'u1' } as Record<string, string>,
        { channel: 'http', chatId: 'u1' },
        { channel: 'wecom-bot', chatId: 'a:b' },
        { channel: 'wecom-bot', chatId: '../x' },
        { channel: 'wecom-bot', chatId: 'u1', chatType: 'channel' },
      ]) {
        const res = await fetch(`${base}${messagesQuery(parts)}`)
        expect(res.status, JSON.stringify(parts)).toBe(400)
        expect((await res.json()).success).toBe(false)
      }
      expect(loadImChatMessages).not.toHaveBeenCalled()
    })
  })

  it('still names the missing parameters first', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/apps/${APP}/im-chat/messages?channel=wecom-bot&spaceId=space-a`)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: 'Missing required query params: channel, chatId, spaceId' })
    })
  })
})

describe('stopping and clearing an IM session', () => {
  it('stops and clears a well-formed session', async () => {
    await withServer(async (base) => {
      const stop = await post(base, `/api/apps/${APP}/im-chat/stop`, { channel: 'feishu-bot', chatType: 'group', chatId: 'oc_123' })
      expect(await stop.json()).toEqual({ success: true, data: { stopped: true } })
      expect(stopImSession).toHaveBeenCalledWith(APP, 'feishu-bot', 'group', 'oc_123')

      const clear = await post(base, `/api/apps/${APP}/im-chat/clear`, { spaceId: 'space-a', channel: 'wecom-bot', chatType: 'direct', chatId: 'zhang.san@example' })
      expect(await clear.json()).toEqual({ success: true })
      expect(clearImSession).toHaveBeenCalledWith(APP, 'space-a', 'wecom-bot', 'direct', 'zhang.san@example')
    })
  })

  it('answers 400 for a malformed session and touches nothing, where a bad chat type used to stop a direct chat', async () => {
    await withServer(async (base) => {
      for (const body of [
        { channel: 'wecom', chatType: 'direct', chatId: 'u1' },
        { channel: 'local', chatType: 'direct', chatId: 'u1' },
        { channel: 'wecom-bot', chatType: 'channel', chatId: 'u1' },
        { channel: 'wecom-bot', chatType: 'direct', chatId: 'a/b' },
        { channel: 'wecom-bot', chatType: 'direct', chatId: 'a b' },
        { channel: ['wecom-bot'], chatType: 'direct', chatId: 'u1' },
      ]) {
        const stop = await post(base, `/api/apps/${APP}/im-chat/stop`, body)
        expect(stop.status, JSON.stringify(body)).toBe(400)
        const clear = await post(base, `/api/apps/${APP}/im-chat/clear`, { spaceId: 'space-a', ...body })
        expect(clear.status, JSON.stringify(body)).toBe(400)
      }
      expect(stopImSession).not.toHaveBeenCalled()
      expect(clearImSession).not.toHaveBeenCalled()
    })
  })
})
