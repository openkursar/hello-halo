import { afterEach, describe, expect, it, vi } from 'vitest'
import { imApi } from '../../../src/renderer/api/im.api'
import { clearServerUrl, setServerUrl } from '../../../src/renderer/api/transport'

afterEach(() => {
  clearServerUrl()
  vi.unstubAllGlobals()
})

describe('IM binding confirmation transport', () => {
  it('forwards the owner confirmed by the user through IPC', async () => {
    const rebind = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { halo: { imChannelsSetInstanceApp: rebind } })
    await expect(imApi.imChannelsSetInstanceApp('bot-1', 'support', 'sales')).resolves.toEqual({ success: true })
    expect(rebind).toHaveBeenCalledWith('bot-1', 'support', 'sales')
  })

  it.each(['sales', ''])('preserves the expected owner %j over remote HTTP', async expectedAppId => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:12345/' })
    vi.stubGlobal('localStorage', { getItem: () => 'test-token' })
    setServerUrl('http://127.0.0.1:12345')
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', request)
    await expect(imApi.imChannelsSetInstanceApp('bot-1', 'support', expectedAppId)).resolves.toEqual({ success: true })
    const [url, options] = request.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:12345/api/im-channels/set-instance-app')
    expect(JSON.parse(options.body)).toEqual({ instanceId: 'bot-1', appId: 'support', expectedAppId })
  })
})

describe('IM bot settings write transport', () => {
  it('sends only the changed fields through IPC', async () => {
    const update = vi.fn().mockResolvedValue({ success: true, data: [] })
    vi.stubGlobal('window', { halo: { imChannelsUpdateInstance: update } })
    await imApi.imChannelsUpdateInstance('bot-1', { owners: null, config: { botId: 'aib-2' } })
    expect(update).toHaveBeenCalledWith('bot-1', { owners: null, config: { botId: 'aib-2' } })
  })

  it.each([
    ['update-instance', () => imApi.imChannelsUpdateInstance('bot-1', { owners: null }), { instanceId: 'bot-1', patch: { owners: null } }],
    ['add-instance', () => imApi.imChannelsAddInstance({ id: 'bot-2', type: 'wecom-bot', appId: '', enabled: false, config: {} }),
      { instance: { id: 'bot-2', type: 'wecom-bot', appId: '', enabled: false, config: {} } }],
    ['remove-instance', () => imApi.imChannelsRemoveInstance('bot-1'), { instanceId: 'bot-1' }],
  ])('posts %s over remote HTTP', async (path, call, body) => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:12345/' })
    vi.stubGlobal('localStorage', { getItem: () => 'test-token' })
    setServerUrl('http://127.0.0.1:12345')
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
    vi.stubGlobal('fetch', request)
    await expect(call()).resolves.toEqual({ success: true, data: [] })
    const [url, options] = request.mock.calls[0]
    expect(url).toBe(`http://127.0.0.1:12345/api/im-channels/${path}`)
    expect(JSON.parse(options.body)).toEqual(body)
  })
})
