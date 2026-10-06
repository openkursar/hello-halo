/**
 * "Add from existing chats": the picker lists what other bots know, names the
 * digital human that gets the replies, and adds the picked chats as push
 * targets with auto-sync off — telling the user when one could not be added.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ runner: null as any, api: {} as Record<string, any> }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useMemo: (compute: any) => compute(),
  useCallback: (fn: any) => fn,
  useEffect: (effect: any) => env.runner.effect(effect),
}))
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }))
vi.mock('../../../src/renderer/api', () => ({ api: new Proxy({}, { get: (_t, key: string) => env.api[key] }) }))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, vars?: Record<string, unknown>) => (vars ? text.replace(/{{(\w+)}}/g, (_, k) => String(vars[k])) : text) }),
}))

import { ImPushTargetPicker } from '../../../src/renderer/components/apps/ImPushTargetPicker'
import type { ImSessionRecord } from '../../../src/shared/types/im-channel'

class ComponentRunner {
  values: any[] = []
  index = 0
  effects: Array<() => unknown> = []
  state(initial: any) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = initial
    return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }]
  }
  effect(effect: () => unknown) { this.effects.push(effect) }
  render(component: () => any) { this.index = 0; this.effects = []; env.runner = this; return component() }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}
const texts = (tree: any) => nodes(tree).flatMap(node => [node.props?.children].flat()).filter(child => typeof child === 'string')
const checkboxes = (tree: any) => nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox')
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && texts(node).some(text => text.startsWith(label)))

const record = (over: Partial<ImSessionRecord>): ImSessionRecord => ({
  appId: 'morning', channel: 'wecom-bot', source: 'im', instanceId: 'bot-1', chatId: 'g1', chatType: 'group',
  displayName: 'Product weekly', proactive: false, lastActiveAt: 2, ...over,
})

let onClose: ReturnType<typeof vi.fn>
let onAdded: ReturnType<typeof vi.fn>

beforeEach(() => {
  onClose = vi.fn()
  onAdded = vi.fn()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { body: {} })
  env.api = {
    imSessionsList: vi.fn(async () => ({
      success: true,
      data: [record({}), record({ chatId: 'alice', chatType: 'direct', displayName: 'Alice', lastActiveAt: 1 }), record({ appId: 'weekly', chatId: 'own' })],
    })),
    imChannelsStatus: vi.fn(async () => ({ success: true, data: [{ id: 'bot-1', type: 'wecom-bot', enabled: true, connected: true, appId: 'morning', appName: 'Morning report' }] })),
    imSessionsSetPushLink: vi.fn(async () => ({ success: true })),
  }
})

async function mount() {
  const runner = new ComponentRunner()
  const render = () => runner.render(() => ImPushTargetPicker({ appId: 'weekly', onClose, onAdded }))
  render()
  runner.effects.forEach(effect => effect())
  await vi.waitFor(() => expect(checkboxes(render())).toHaveLength(2))
  return render
}

it('lists the other bots\' chats with the digital human that gets the replies, never the digital human\'s own', async () => {
  const render = await mount()
  const tree = render()
  expect(texts(tree)).toEqual(expect.arrayContaining(['Product weekly', 'Alice', 'Replies go to Morning report']))
  expect(texts(tree)).not.toContain('own')
  expect(button(tree, 'Add (').props.disabled).toBe(true)
})

it('adds the picked chats with auto-sync off, then closes', async () => {
  const render = await mount()
  checkboxes(render())[1].props.onChange()
  expect(button(render(), 'Add (').props.disabled).toBe(false)
  await button(render(), 'Add (').props.onClick()
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(env.api.imSessionsSetPushLink).toHaveBeenCalledTimes(1)
  expect(env.api.imSessionsSetPushLink).toHaveBeenCalledWith({
    appId: 'weekly',
    session: { appId: 'morning', channel: 'wecom-bot', chatId: 'alice' },
    link: { autoSync: false },
  })
  expect(onAdded).toHaveBeenCalled()
})

it('stays open and says how many could not be added, keeping what was added', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.api.imSessionsSetPushLink = vi.fn(async (input: any) => ({ success: input.session.chatId === 'g1' }))
  const render = await mount()
  for (const box of checkboxes(render())) box.props.onChange()
  await button(render(), 'Add (').props.onClick()
  await vi.waitFor(() => expect(texts(render()).some(text => text.startsWith('Could not add 1 chat(s)'))).toBe(true))
  expect(onAdded).toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})
