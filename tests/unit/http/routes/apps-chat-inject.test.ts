/**
 * chat/inject (the user adding to a running digital-human turn) and the canvas
 * context chat/send accepts, driven the way a remote client drives them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'

const injectIntoAppChat = vi.fn()
const sendAppChatMessage = vi.fn()

vi.mock('../../../../src/main/http/routes/_shared', () => ({
  AppAlreadyInstalledError: class extends Error {},
  McpCommandBlockedError: class extends Error {},
  MCP_COMMAND_BLOCKED: 'MCP_COMMAND_BLOCKED',
  appController: {},
  broadcastToAll: vi.fn(),
  getAppRuntime: () => ({}),
  getAppChatConversationId: (appId: string) => `app-chat:${appId}`,
  injectIntoAppChat: (...args: unknown[]) => injectIntoAppChat(...args),
  sendAppChatMessage: (...args: unknown[]) => sendAppChatMessage(...args),
}))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamStore: () => null }))

import { registerAppsRoutes } from '../../../../src/main/http/routes/apps.routes'

async function withServer(fn: (post: (path: string, body: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const app = express()
  app.use(express.json())
  registerAppsRoutes(app)
  const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await fn(async (path, body) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  injectIntoAppChat.mockReturnValue(true)
  sendAppChatMessage.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST chat/inject', () => {
  it('adds the message to the running turn of the user\'s own chats, marked as an injection', async () => {
    await withServer(async (post) => {
      const res = await post('/api/apps/app-1/chat/inject', { conversationId: 'app-chat:app-1', message: '  also this  ' })
      expect(res.body).toEqual({ success: true, data: { delivered: true } })
      expect(injectIntoAppChat).toHaveBeenCalledWith('app-chat:app-1', 'also this', { source: 'injection' }, undefined)

      await post('/api/apps/app-1/chat/inject', { conversationId: 'app-chat:app-1:local:direct:abc', message: 'x' })
      expect(injectIntoAppChat.mock.calls[1][0]).toBe('app-chat:app-1:local:direct:abc')
    })
  })

  it('reports that nothing took it when no turn was running', async () => {
    injectIntoAppChat.mockReturnValue(false)
    await withServer(async (post) => {
      const res = await post('/api/apps/app-1/chat/inject', { conversationId: 'app-chat:app-1', message: 'late' })
      expect(res.body).toEqual({ success: true, data: { delivered: false } })
    })
  })

  it.each([
    ['an IM session', 'app-chat:app-1:wecom-bot:direct:someone'],
    ['an HTTP session', 'app-chat:app-1:http:direct:x'],
    ['a team session', 'app-chat:app-1:team:t1:e1'],
    ['another digital human\'s chat', 'app-chat:app-2'],
    ['a space conversation', '0d9a1c6e-1111-2222-3333-444444444444'],
  ])('refuses %s', async (_label, conversationId) => {
    await withServer(async (post) => {
      const res = await post('/api/apps/app-1/chat/inject', { conversationId, message: 'hi' })
      expect(res.status).toBe(400)
      expect(injectIntoAppChat).not.toHaveBeenCalled()
    })
  })

  it('refuses a missing, blank or non-string message and conversationId', async () => {
    await withServer(async (post) => {
      for (const body of [{}, { conversationId: 'app-chat:app-1' }, { conversationId: 'app-chat:app-1', message: '   ' }, { conversationId: 'app-chat:app-1', message: 5 }, { conversationId: 7, message: 'x' }]) {
        expect((await post('/api/apps/app-1/chat/inject', body)).status).toBe(400)
      }
      expect(injectIntoAppChat).not.toHaveBeenCalled()
    })
  })
})

describe('POST chat/send canvas context', () => {
  const tab = (over: Record<string, unknown> = {}) => ({ type: 'code', title: 'a.ts', path: '/w/a.ts', isActive: true, ...over })
  const canvas = (over: Record<string, unknown> = {}) => ({ isOpen: true, tabCount: 1, activeTab: { type: 'code', title: 'a.ts', path: '/w/a.ts' }, tabs: [tab()], ...over })
  const send = (post: Parameters<Parameters<typeof withServer>[0]>[0], canvasContext: unknown) =>
    post('/api/apps/app-1/chat/send', { spaceId: 's', message: 'hi', canvasContext })
  const sent = () => sendAppChatMessage.mock.calls[0][0]

  it('passes a well-formed context through', async () => {
    await withServer(async (post) => {
      await send(post, canvas())
      expect(sent().canvasContext).toEqual({
        isOpen: true,
        tabCount: 1,
        activeTab: { type: 'code', title: 'a.ts', path: '/w/a.ts' },
        tabs: [{ type: 'code', title: 'a.ts', path: '/w/a.ts', isActive: true }],
      })
    })
  })

  it('drops a context that is not one', async () => {
    await withServer(async (post) => {
      for (const bad of ['x', null, canvas({ isOpen: false }), canvas({ tabCount: 'many' }), canvas({ tabs: 'no' }), canvas({ tabs: [{ title: 1 }] }), canvas({ activeTab: 'a.ts' })]) {
        sendAppChatMessage.mockClear()
        expect((await send(post, bad)).body.success).toBe(true)
        expect(sent().canvasContext).toBeUndefined()
      }
    })
  })

  it('bounds what reaches the prompt: tab count and field length, foreign fields dropped', async () => {
    await withServer(async (post) => {
      await send(post, canvas({
        tabCount: 9999,
        tabs: Array.from({ length: 60 }, (_, i) => tab({ title: `t${i}`, url: 'u'.repeat(600), path: { evil: true }, extra: 'ignored' })),
      }))
      const context = sent().canvasContext
      expect(context.tabs).toHaveLength(50)
      expect(context.tabCount).toBe(50)
      expect(context.tabs[0].url).toHaveLength(500)
      expect(context.tabs[0].path).toBeUndefined()
      expect(context.tabs[0]).not.toHaveProperty('extra')
    })
  })
})
