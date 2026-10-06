/**
 * The proxy bypass list in Settings saves what the user typed as
 * network.noProxy, next to the other network settings, and removes it when
 * the field is emptied.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ states: [] as unknown[], index: 0, api: { setConfig: vi.fn() } }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = env.index++
    if (!(index in env.states)) env.states[index] = initial
    return [env.states[index], (next: unknown) => { env.states[index] = next }]
  },
}))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

import { ProxyBypassField } from '../../../src/renderer/components/settings/ProxyBypassField'

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}

const network = { proxy: 'http://127.0.0.1:7890', browserUseProxy: true }
let setConfig = vi.fn()
const render = (noProxy?: string) => ProxyBypassField({ config: { network: { ...network, noProxy } } as never, setConfig })
const rerender = (noProxy?: string) => { env.index = 0; return render(noProxy) }
const input = (tree: unknown) => nodes(tree).find(node => node.type === 'input')!
const button = (tree: unknown) => nodes(tree).find(node => node.type === 'button')!

beforeEach(() => {
  env.states = []
  env.index = 0
  env.api.setConfig.mockReset().mockResolvedValue({ success: true })
  setConfig = vi.fn()
})

describe('proxy bypass list setting', () => {
  it('shows the saved list', () => {
    expect(input(render('.weixin.qq.com')).props!.value).toBe('.weixin.qq.com')
  })

  it('saves the typed list next to the other network settings', async () => {
    input(render()).props!.onChange({ target: { value: ' .weixin.qq.com, docs.example.com ' } })

    await button(rerender()).props!.onClick()

    const saved = { ...network, noProxy: '.weixin.qq.com, docs.example.com' }
    expect(env.api.setConfig).toHaveBeenCalledWith({ network: saved })
    expect(setConfig).toHaveBeenCalledWith({ network: saved })
  })

  it('removes the list when the field is emptied', async () => {
    input(render('.weixin.qq.com')).props!.onChange({ target: { value: '  ' } })

    await button(rerender('.weixin.qq.com')).props!.onClick()

    expect(env.api.setConfig).toHaveBeenCalledWith({ network: { ...network, noProxy: undefined } })
  })
})
