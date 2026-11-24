/**
 * At phone width the history sheet stands in for the sidebar, so a digital
 * human's row there offers the sidebar's per-person "new conversation": it
 * starts another chat with that person, not an ordinary one, and closes the
 * sheet like every other navigation from it.
 *
 * No DOM here: React's state hooks are replaced by a small runner, the virtual
 * list is reached through its `itemContent`, and the returned element tree is
 * searched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  slots: [] as Array<{ value: unknown }>,
  index: 0,
  chat: null as any,
  rows: [] as any[],
  openDigitalHumanChat: null as any,
  trackHome: null as any,
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = env.index++
    if (!(index in env.slots)) env.slots[index] = { value: initial }
    const slot = env.slots[index]
    return [slot.value, (update: any) => { slot.value = typeof update === 'function' ? update(slot.value) : update }]
  },
  useRef: (current: unknown) => ({ current }),
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))
vi.mock('react-virtuoso', () => ({ Virtuoso: function Virtuoso() { return null } }))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values: Record<string, unknown> = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key])) }),
  getCurrentLanguage: () => 'en',
}))
vi.mock('../../../src/renderer/hooks/useIsMobile', () => ({ useIsMobile: () => true }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: Object.assign((select: any) => select(env.chat), { getState: () => env.chat }),
  useAllConversationStatuses: () => new Map(),
}))
vi.mock('../../../src/renderer/stores/space.store', () => {
  const state = { currentSpace: { id: 's1', name: 'Space' } }
  return { useSpaceStore: Object.assign((select: any) => select(state), { getState: () => state }) }
})
vi.mock('../../../src/renderer/stores/app-chat-pins.store', () => ({ useAppChatPinsStore: (select: any) => select({ toggleAppChatPin: vi.fn() }) }))
vi.mock('../../../src/renderer/hooks/useAppChatConversationRows', () => ({ useAppChatConversationRows: () => env.rows }))
vi.mock('../../../src/renderer/components/pulse/TaskStatusDot', () => ({ TaskStatusDot: () => null }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ trackHome: (...args: unknown[]) => env.trackHome(...args) }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({
  openDigitalHumanChat: (...args: unknown[]) => env.openDigitalHumanChat(...args),
}))

import { Virtuoso } from 'react-virtuoso'
import { ChatHistoryPanel } from '../../../src/renderer/components/chat/ChatHistoryPanel'

function render(): any {
  env.index = 0
  return ChatHistoryPanel()
}

/** Every element in the tree, without rendering child components. */
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}

function text(tree: any): string {
  if (tree == null || typeof tree === 'boolean') return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return text(tree.props?.children)
}

const click = (node: any) => node.props.onClick({ stopPropagation: () => {} })

/** The drawn sheet row of conversation `id`, or undefined when the sheet is closed. */
function sheetRow(id: string): any {
  const list = nodes(render()).find(node => node.type === Virtuoso)
  if (!list) return undefined
  const index = list.props.data.findIndex((item: any) => item.key === id)
  return list.props.itemContent(index, list.props.data[index])
}

function button(tree: any, match: (node: any) => boolean): any {
  const found = nodes(tree).find(node => node.type === 'button' && match(node))
  if (!found) throw new Error('Button not drawn')
  return found
}

function openRowMenu(id: string): any {
  click(button(render(), node => node.props.title === 'Conversation history'))
  click(button(sheetRow(id), node => node.props.title === 'More'))
  return sheetRow(id)
}

const personRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'app-chat:ana:local:direct:one', appId: 'ana', appSpaceId: 's1', digitalHumanName: 'Ana', isDefault: false,
  displayName: '', lastMessage: 'hello', updatedAt: 1, messageCount: 2, starred: false, status: 'active', uninstalled: false,
  ...overrides,
})

beforeEach(() => {
  vi.useFakeTimers()
  env.slots = []
  env.rows = [personRow()]
  env.chat = {
    currentSpaceId: 's1',
    spaceStates: new Map([['s1', { conversations: [{ id: 'c1', title: 'Plan', updatedAt: '2026-11-01T00:00:00.000Z', messageCount: 1 }], currentConversationId: 'c1', selectedAppChat: null }]]),
    createConversation: vi.fn(),
    selectAppChatConversation: vi.fn(),
  }
  env.openDigitalHumanChat = vi.fn(() => Promise.resolve(true))
  env.trackHome = vi.fn()
})

afterEach(() => { vi.useRealTimers() })

describe('history sheet: a new conversation with a digital human', () => {
  it('starts another chat with that person from its row and closes the sheet', () => {
    const menu = openRowMenu('app-chat:ana:local:direct:one')
    click(button(menu, node => text(node) === 'New conversation with Ana'))

    expect(env.openDigitalHumanChat.mock.calls).toEqual([['ana', 's1', { newConversation: true }]])
    expect(env.chat.createConversation).not.toHaveBeenCalled()
    expect(env.chat.selectAppChatConversation).not.toHaveBeenCalled()
    expect(env.trackHome).toHaveBeenCalledWith('home.conversation.create', { surface: 'dh_menu' })

    vi.advanceTimersByTime(200)
    expect(sheetRow('app-chat:ana:local:direct:one')).toBeUndefined()
  })

  it('is offered by each of the person\'s rows, the default chat included', () => {
    env.rows = [personRow({ id: 'app-chat:ana', isDefault: true })]
    const menu = openRowMenu('app-chat:ana')
    click(button(menu, node => text(node) === 'New conversation with Ana'))

    expect(env.openDigitalHumanChat.mock.calls).toEqual([['ana', 's1', { newConversation: true }]])
  })

  it('is not offered for an uninstalled digital human', () => {
    env.rows = [personRow({ uninstalled: true, status: 'uninstalled' })]
    click(button(render(), node => node.props.title === 'Conversation history'))

    expect(() => button(sheetRow('app-chat:ana:local:direct:one'), node => node.props.title === 'More')).toThrow('Button not drawn')
  })
})
