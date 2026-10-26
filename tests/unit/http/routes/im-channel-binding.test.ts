import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { ImChannelManager } from '../../../../src/main/apps/runtime/im-channels/manager'
import type { ImChannelInstanceConfig, ImChannelInstanceStatus } from '../../../../src/shared/types/im-channel'

const state = vi.hoisted(() => ({
  instances: [] as ImChannelInstanceConfig[],
  manager: null as ImChannelManager | null,
  apps: new Map<string, { spec: { type: string; name: string }; spaceId: string }>(),
  writes: 0,
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ imChannels: { instances: state.instances } }),
  saveConfig: (patch: { imChannels: { instances: ImChannelInstanceConfig[] } }) => {
    state.instances = patch.imChannels.instances
    state.writes++
  },
  isConfigUnreadable: () => false,
}))
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: (id: string) => state.apps.get(id) ?? null }),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getImChannelManager: () => state.manager,
  dispatchInboundMessage: vi.fn(),
  invalidateImSessions: vi.fn(),
}))
vi.mock('../../../../src/main/http/routes/_shared', () => ({
  ILINK_BASE_URL: 'https://ilink.invalid',
  FeishuScanAuthError: class extends Error {},
  WecomScanAuthError: class extends Error {},
  buildDefaultAssistantSpec: vi.fn(),
  buildFeishuAssistantSpec: vi.fn(),
  feishuBeginRegistration: vi.fn(),
  feishuPollRegistration: vi.fn(),
  readFeishuReachability: vi.fn(),
  disconnectIlink: vi.fn(),
  dispatchInboundMessage: vi.fn(),
  fetchJson: vi.fn(),
  getAppManager: () => ({ getApp: (id: string) => state.apps.get(id) ?? null }),
  getImChannelManager: () => state.manager,
  getImSessionRegistry: () => null,
  getServiceConfig: () => ({ imChannels: { instances: state.instances } }),
  renameChatSession: vi.fn(),
  saveIlinkToken: vi.fn(),
  wecomGenerateScode: vi.fn(),
  wecomPollResult: vi.fn(),
}))

import { registerImRoutes } from '../../../../src/main/http/routes/im.routes'

let server: Server
let base: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  registerImRoutes(app)
  server = await new Promise<Server>(resolve => {
    const started = app.listen(0, () => resolve(started))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  state.apps = new Map([
    ['sales', { spec: { type: 'automation', name: 'Sales' }, spaceId: 'space' }],
    ['support', { spec: { type: 'automation', name: 'Support' }, spaceId: 'space' }],
  ])
  state.instances = [
    { id: 'bot-1', type: 'wecom-bot', appId: 'sales', enabled: false, config: {} },
    { id: 'bot-2', type: 'wecom-bot', appId: '', enabled: false, config: {} },
  ]
  state.writes = 0
  state.manager = new ImChannelManager(id => state.apps.get(id)?.spec.name)
  state.manager.applyConfig(state.instances, () => {})
})
afterEach(() => {
  state.manager?.stopAll()
  vi.restoreAllMocks()
})

async function statuses(instanceId?: string): Promise<{ success: boolean; data: ImChannelInstanceStatus[] | ImChannelInstanceStatus }> {
  const path = `/api/im-channels/status${instanceId ? `?instanceId=${instanceId}` : ''}`
  return (await fetch(`${base}${path}`)).json()
}
async function rebind(body: unknown) {
  return fetch(`${base}/api/im-channels/set-instance-app`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('IM bot binding over HTTP', () => {
  it('returns the same bot number and current owner in list and single reads', async () => {
    const list = await statuses()
    expect(list.success).toBe(true)
    expect(list.data).toEqual([
      expect.objectContaining({ id: 'bot-1', ordinal: 1, appName: 'Sales' }),
      expect.objectContaining({ id: 'bot-2', ordinal: 2, appId: '' }),
    ])
    expect((await statuses('bot-1')).data).toEqual((list.data as ImChannelInstanceStatus[])[0])
  })

  it('transfers only after the expected owner matches and reads back the new name', async () => {
    const result = await rebind({ instanceId: 'bot-1', appId: 'support', expectedAppId: 'sales' })
    expect(await result.json()).toEqual({ success: true })
    expect(state.writes).toBe(1)
    expect((await statuses('bot-1')).data).toEqual(expect.objectContaining({ ordinal: 1, appId: 'support', appName: 'Support' }))
    const stale = await rebind({ instanceId: 'bot-1', appId: 'sales', expectedAppId: 'sales' })
    expect(await stale.json()).toEqual({ success: false, code: 'BINDING_CHANGED', error: 'The bot binding changed. Refresh and confirm again.' })
    expect(state.writes).toBe(1)
    expect(state.instances[0].appId).toBe('support')
  })

  it('preserves an explicitly unbound expectation', async () => {
    const result = await rebind({ instanceId: 'bot-2', appId: 'support', expectedAppId: '' })
    expect(await result.json()).toEqual({ success: true })
    expect((await statuses('bot-2')).data).toEqual(expect.objectContaining({ ordinal: 2, appName: 'Support' }))
  })

  it.each([null, 7, {}, []])('rejects a malformed expected owner %j without writing', async expectedAppId => {
    const response = await rebind({ instanceId: 'bot-1', appId: 'support', expectedAppId })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ success: false, error: 'expectedAppId must be a string' })
    expect(state.writes).toBe(0)
  })
})
