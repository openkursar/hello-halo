import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgSignInState } from '../../../src/shared/types/enterprise-identity'

vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

class FakeSocket {
  static OPEN = 1
  static latest: FakeSocket
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  constructor() { FakeSocket.latest = this }
  close() { this.onclose?.() }
  send() {}
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

const fetchRequest = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
const state = (name: string): OrgSignInState => ({
  status: 'active', account: { displayName: name }, capabilities: [], boundTools: [], signingIn: false, canUnbindDevice: false,
})
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

async function boot(orgSignIn: boolean) {
  const transport = await import('../../../src/renderer/api/transport')
  const { configApi } = await import('../../../src/renderer/api/config.api')
  const { useOrgSignInStore } = await import('../../../src/renderer/stores/org-sign-in.store')
  fetchRequest.mockResolvedValueOnce(json({ success: true, data: {}, orgSignIn }))
  await configApi.getConfig({ snapshot: true })
  useOrgSignInStore.getState().start()
  useOrgSignInStore.getState().start()
  const connect = () => {
    transport.connectWebSocket()
    const socket = FakeSocket.latest
    socket.receive({ type: 'auth:success' })
    return socket
  }
  return { connect, transport, useOrgSignInStore }
}

const orgRequests = () => fetchRequest.mock.calls.filter(([url]) => String(url).endsWith('/api/enterprise-identity/state'))

describe('remote organization sign-in', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchRequest.mockReset()
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { baseURI: 'https://halo.test/' })
    vi.stubGlobal('localStorage', { getItem: () => 'test-remote-session' })
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', fetchRequest)
  })

  afterEach(async () => {
    const { disconnectWebSocket } = await import('../../../src/renderer/api/transport')
    disconnectWebSocket()
    vi.unstubAllGlobals()
  })

  it('makes no organization request on an unconfigured bootstrap or reconnect', async () => {
    const { connect, transport } = await boot(false)
    expect(transport.orgSignInOffered()).toBe(false)
    connect().close()
    connect()
    expect(fetchRequest).toHaveBeenCalledTimes(1)
    expect(orgRequests()).toHaveLength(0)
  })

  it('reads one snapshot at reconnect and does not overwrite newer pushes', async () => {
    const { connect, useOrgSignInStore } = await boot(true)
    fetchRequest.mockResolvedValueOnce(json({ success: true, data: state('Earlier member') }))
    connect().receive({ type: 'auth:success' })
    await vi.waitFor(() => expect(useOrgSignInStore.getState().state).toEqual(state('Earlier member')))
    expect(orgRequests()).toHaveLength(1)
    FakeSocket.latest.close()
    fetchRequest.mockResolvedValueOnce(json({ success: true, data: state('Member changed while disconnected') }))
    connect()
    await vi.waitFor(() => expect(useOrgSignInStore.getState().state).toEqual(state('Member changed while disconnected')))
    expect(orgRequests()).toHaveLength(2)
    FakeSocket.latest.close()
    let finish!: (response: Response) => void
    fetchRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const socket = connect()
    socket.receive({ type: 'event', channel: 'enterprise-identity:changed', data: state('Newest member') })
    finish(json({ success: true, data: state('Older snapshot') }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(useOrgSignInStore.getState().state).toEqual(state('Newest member'))
    expect(orgRequests()).toHaveLength(3)
  })
})
