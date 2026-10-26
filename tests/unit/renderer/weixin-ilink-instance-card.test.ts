/**
 * After a WeChat sign-in is confirmed, the card asks for a fresh connection
 * status at once — otherwise it keeps the pre-scan status (red "Stopped" after
 * an expired session) until the next periodic refresh, up to 10 s later.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, api: {} as Record<string, any> }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useRef: (value: any) => env.runner.ref(value),
  useCallback: (fn: any) => fn,
  useEffect: () => {},
}))
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }))
vi.mock('../../../src/renderer/api', () => ({ api: new Proxy({}, { get: (_t, key: string) => env.api[key] }) }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

import { WeixinIlinkInstanceCard } from '../../../src/renderer/components/settings/WeixinIlinkInstanceCard'
import type { ImChannelInstanceConfig, ImChannelInstanceStatus } from '../../../src/shared/types/im-channel'

class ComponentRunner {
  values: any[] = []
  refs: any[] = []
  index = 0
  refIndex = 0
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  ref(initial: any) {
    const index = this.refIndex++
    if (!(index in this.refs)) this.refs[index] = { current: initial }
    return this.refs[index]
  }
  render(component: () => any) { this.index = 0; this.refIndex = 0; env.runner = this; return component() }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
const texts = (tree: any) => nodes(tree).flatMap(node => [node.props?.children].flat()).filter(child => typeof child === 'string')
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && texts(node).includes(label))

const instance = {
  id: 'wx-1', type: 'weixin-ilink-bot', enabled: true, appId: 'dh-1', config: { botToken: '' },
} as unknown as ImChannelInstanceConfig
/** What the list showed before the scan: the session had expired. */
const expired: ImChannelInstanceStatus = {
  id: 'wx-1', type: 'weixin-ilink-bot', enabled: true, connected: false, appId: 'dh-1', state: 'offline',
  link: { attempt: 0, viaProxy: false, drops: 0, lastError: 'WeChat session expired — scan the QR code again' },
}

beforeEach(() => {
  vi.useFakeTimers()
  env.api = {
    weixinIlinkRequestQrcode: vi.fn(async () => ({ success: true, data: { qrcode: 'q', qrcodeImgContent: 'img', baseUrl: 'https://ilink.example' } })),
    weixinIlinkPollAuthStatus: vi.fn(async () => ({ success: true, data: { status: 'confirmed', botToken: 'token', accountId: 'acc' } })),
    weixinIlinkSaveToken: vi.fn(async () => ({ success: true })),
    imChannelsReload: vi.fn(async () => ({ success: true })),
  }
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('asks for a fresh status as soon as the sign-in is confirmed', async () => {
  const runner = new ComponentRunner()
  const onChange = vi.fn()
  const onLinkChanged = vi.fn()
  const props = {
    instance, status: expired, automationApps: [], teams: [], isExpanded: true,
    onToggle: vi.fn(), onChange, onRebind: vi.fn(), onDelete: vi.fn(), onReconnect: vi.fn(), onUseDirect: vi.fn(),
    onLinkChanged,
  }
  const tree = runner.render(() => WeixinIlinkInstanceCard(props as never))
  await button(tree, 'Connect WeChat').props.onClick()

  await vi.advanceTimersByTimeAsync(2_000)

  expect(env.api.imChannelsReload).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onLinkChanged).toHaveBeenCalledTimes(1)
  expect(env.api.imChannelsReload.mock.invocationCallOrder[0]).toBeLessThan(onLinkChanged.mock.invocationCallOrder[0])
})
