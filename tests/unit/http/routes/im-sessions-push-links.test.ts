/**
 * The remote client manages push links over HTTP the way the desktop does over
 * IPC, against the real registry: a link is added, listed, given auto-sync and
 * removed; a malformed request is a 400 and a session that cannot be linked a
 * 404, with nothing changed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'

const state = vi.hoisted(() => ({ registry: null as unknown }))

vi.mock('../../../../src/main/http/routes/_shared', () => {
  class FeishuScanAuthError extends Error {}
  class WecomScanAuthError extends Error {}
  return {
    ILINK_BASE_URL: 'https://ilink.invalid',
    FeishuScanAuthError,
    WecomScanAuthError,
    buildDefaultAssistantSpec: vi.fn(),
    buildFeishuAssistantSpec: vi.fn(),
    feishuBeginRegistration: vi.fn(),
    feishuPollRegistration: vi.fn(),
    readFeishuReachability: vi.fn(),
    disconnectIlink: vi.fn(),
    dispatchInboundMessage: vi.fn(),
    fetchJson: vi.fn(),
    getAppManager: () => null,
    getImChannelManager: () => null,
    getImSessionRegistry: () => state.registry,
    getServiceConfig: () => ({}),
    renameChatSession: vi.fn(),
    saveIlinkToken: vi.fn(),
    wecomGenerateScode: vi.fn(),
    wecomPollResult: vi.fn(),
  }
})

import { registerImRoutes } from '../../../../src/main/http/routes/im.routes'

const GROUP = { appId: 'morning', channel: 'wecom-bot', chatId: 'wrkGroup1' }

let server: Server
let base: string
let dir: string
let registry: ImSessionRegistry

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  registerImRoutes(app)
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
  vi.spyOn(console, 'log').mockImplementation(() => {})
  dir = mkdtempSync(join(tmpdir(), 'im-push-link-routes-'))
  registry = new ImSessionRegistry(join(dir, 'sessions.json'))
  registry.register('morning', 'wecom-bot', 'wrkGroup1', 'group', 'bot-1', { displayName: 'Product weekly' })
  state.registry = registry
})

afterEach(async () => {
  // Writes are fire-and-forget; let them land before the folder goes.
  await new Promise(resolve => setTimeout(resolve, 20))
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const setLink = (body: unknown) =>
  fetch(`${base}/api/im-sessions/set-push-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const linked = async (appId: string) => (await (await fetch(`${base}/api/im-sessions/linked?appId=${appId}`)).json()) as {
  success: boolean
  data: Array<{ appId: string; chatId: string; pushLinks?: unknown }>
}

describe('push links over HTTP', () => {
  it('adds a link, lists it, turns auto-sync on and removes it', async () => {
    expect(await (await setLink({ appId: 'weekly', session: GROUP, link: { autoSync: false } })).json()).toEqual({ success: true })
    const listed = await linked('weekly')
    expect(listed.data.map(s => [s.appId, s.chatId])).toEqual([['morning', 'wrkGroup1']])

    await setLink({ appId: 'weekly', session: GROUP, link: { autoSync: true } })
    expect(registry.getProactiveSessions('weekly').map(s => s.chatId)).toEqual(['wrkGroup1'])

    expect((await setLink({ appId: 'weekly', session: GROUP, link: null })).status).toBe(200)
    expect((await linked('weekly')).data).toEqual([])
  })

  it('answers 400 for a malformed request and changes nothing', async () => {
    for (const body of [
      { session: GROUP, link: { autoSync: false } },
      { appId: 'weekly', link: { autoSync: false } },
      { appId: 'weekly', session: { appId: 'morning', channel: 'wecom-bot' }, link: { autoSync: false } },
      { appId: 'weekly', session: GROUP },
      { appId: 'weekly', session: GROUP, link: { autoSync: 'yes' } },
      { appId: 7, session: GROUP, link: { autoSync: false } },
    ]) {
      expect((await setLink(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(registry.findSession('morning', 'wecom-bot', 'wrkGroup1')?.pushLinks).toBeUndefined()
    expect((await fetch(`${base}/api/im-sessions/linked`)).status).toBe(400)
  })

  it('answers 404 for a session that does not exist or is the digital human\'s own', async () => {
    expect((await setLink({ appId: 'weekly', session: { ...GROUP, chatId: 'nobody' }, link: { autoSync: false } })).status).toBe(404)
    expect((await setLink({ appId: 'morning', session: GROUP, link: { autoSync: true } })).status).toBe(404)
  })
})
