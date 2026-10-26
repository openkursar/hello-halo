import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import type { ImChannelInstanceConfig } from '../../../../src/shared/types/im-channel'

const state = vi.hoisted(() => ({
  instances: [] as ImChannelInstanceConfig[],
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
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getImChannelManager: () => ({ applyConfig: vi.fn() }),
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
  getAppManager: () => null,
  getImChannelManager: () => null,
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
  state.instances = [{
    id: 'bot-1',
    type: 'wecom-bot',
    appId: 'sales',
    enabled: true,
    permissionEnabled: true,
    owners: ['zhangsan'],
    config: { botId: 'aib-1', secret: 'real-secret', wsUrl: '' },
  }]
  state.writes = 0
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function post(path: string, body: unknown): Promise<{ success: boolean; data?: ImChannelInstanceConfig[]; error?: string }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return response.json()
}

describe('IM bot settings writes over HTTP', () => {
  it('applies a remote change without touching the owner, and answers with masked secrets', async () => {
    const res = await post('/api/im-channels/update-instance', { instanceId: 'bot-1', patch: { streaming: true } })

    expect(res.success).toBe(true)
    expect(state.instances[0].owners).toEqual(['zhangsan'])
    expect(state.instances[0].streaming).toBe(true)
    expect(res.data?.[0].config.secret).toBe('***')
    expect(res.data?.[0].owners).toEqual(['zhangsan'])
  })

  it('keeps the stored secret when a remote client sends back the masked value', async () => {
    await post('/api/im-channels/update-instance', { instanceId: 'bot-1', patch: { config: { secret: '***', botId: 'aib-2' } } })
    expect(state.instances[0].config).toEqual({ botId: 'aib-2', secret: 'real-secret', wsUrl: '' })
  })

  it('carries a removal through JSON as null', async () => {
    await post('/api/im-channels/update-instance', { instanceId: 'bot-1', patch: { owners: null } })
    expect(state.instances[0]).not.toHaveProperty('owners')
  })

  it('refuses a malformed patch without writing', async () => {
    const res = await post('/api/im-channels/update-instance', { instanceId: 'bot-1' })
    expect(res.success).toBe(false)
    expect(state.writes).toBe(0)
  })

  it('adds and removes instances against the stored list', async () => {
    const added = await post('/api/im-channels/add-instance', {
      instance: { id: 'bot-2', type: 'feishu-bot', appId: '', enabled: false, config: { appId: '', appSecret: '' } },
    })
    expect(added.success).toBe(true)
    expect(state.instances.map(i => i.id)).toEqual(['bot-1', 'bot-2'])

    const removed = await post('/api/im-channels/remove-instance', { instanceId: 'bot-2' })
    expect(removed.success).toBe(true)
    expect(state.instances.map(i => i.id)).toEqual(['bot-1'])
    expect(state.instances[0].owners).toEqual(['zhangsan'])
  })
})
