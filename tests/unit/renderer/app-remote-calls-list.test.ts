/**
 * The remote calls of a digital human (sessions a backend opened through Halo's
 * HTTP API), as its IM / Remote tab lists them (#454): which records count as
 * one, and what each row tells — that it is a remote call, its last message,
 * whether it is running — with only the newest drawn until more are asked for.
 * The list is read-only: nothing on it pushes to a call or renames it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const env = vi.hoisted(() => ({
  statuses: new Map<string, string>(),
  /** Set to drive state by hand (clicks); unset, React's own state is used. */
  runner: null as null | { state: (initial: unknown) => [unknown, (update: unknown) => void] },
}))

vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => (env.runner ? env.runner.state(initial) : actual.useState(initial)),
  }
})
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useConversationTaskStatus: (conversationId: string) => env.statuses.get(conversationId) ?? 'idle',
}))
vi.mock('../../../src/renderer/stores/app-chat-sessions', () => ({
  acquireAppChatSessions: () => () => {},
  subscribeAppChatSessions: () => () => {},
  getAppChatSessions: () => [],
  isAppChatSessionsLoading: () => false,
}))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  }),
}))
vi.mock('../../../src/renderer/components/apps/ImSessionDetailView', async () => {
  const { createElement: h } = await import('react')
  return { ImSessionDetailView: ({ session }: { session: { chatId: string } }) => h('section', { 'data-transcript': session.chatId }) }
})

import { AppHttpSessionsView } from '../../../src/renderer/components/apps/AppHttpSessionsView'
import { selectHttpSessions } from '../../../src/renderer/hooks/useAppHttpSessions'
import type { ImSessionRecord } from '../../../src/shared/types/im-channel'

const APP = 'concierge'

const record = (chatId: string, over: Partial<ImSessionRecord> = {}): ImSessionRecord => ({
  appId: APP, channel: 'http', source: 'http', instanceId: '', chatId, chatType: 'direct',
  displayName: chatId, proactive: false, lastActiveAt: 1_000, messageCount: 1, ...over,
})

const render = (sessions: ImSessionRecord[]) =>
  renderToStaticMarkup(createElement(AppHttpSessionsView, { appId: APP, spaceId: 'space-1', sessions }))

/** Hook state kept across calls of a component function, so a test can click and render again. */
class StateRunner {
  values: unknown[] = []
  index = 0
  state(initial: unknown): [unknown, (update: unknown) => void] {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [this.values[index], (update: unknown) => {
      this.values[index] = typeof update === 'function' ? (update as (value: unknown) => unknown)(this.values[index]) : update
    }]
  }
  render<T>(component: () => T): T {
    this.index = 0
    env.runner = this
    try { return component() } finally { env.runner = null }
  }
}

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } }

/** The elements of a returned tree that match, without rendering child components. */
function findAll(tree: unknown, match: (node: Element) => boolean): Element[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Element
  return [...(match(node) ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => findAll(child, match))]
}

const elementsOf = (tree: unknown, component: string) =>
  findAll(tree, node => typeof node.type === 'function' && (node.type as { name: string }).name === component)

const showMore = (tree: unknown) =>
  findAll(tree, node => node.type === 'button' && node.props.children === 'Show more')[0]

beforeEach(() => {
  env.statuses = new Map()
  env.runner = null
})

describe('which sessions are a digital human\'s remote calls', () => {
  it('takes its HTTP sessions, newest first, and nothing else', () => {
    const records = [
      record('older', { lastActiveAt: 1_000 }),
      record('another-app', { appId: 'someone-else', lastActiveAt: 9_000 }),
      record('wecom', { channel: 'wecom-bot', source: 'im', lastActiveAt: 9_000 }),
      record('mine', { channel: 'local', source: 'local', lastActiveAt: 9_000 }),
      record('default', { channel: 'native', source: 'native', lastActiveAt: 9_000 }),
      record('newer', { lastActiveAt: 5_000 }),
    ]

    expect(selectHttpSessions(records, APP).map(session => session.chatId)).toEqual(['newer', 'older'])
  })
})

describe('the remote calls list', () => {
  it('marks each row as a remote call and shows its last message', () => {
    const html = render([record('order-42', { lastMessage: 'Where is my parcel?' })])

    expect(html).toContain('order-42')
    expect(html).toContain('Remote call')
    expect(html).toContain('Where is my parcel?')
  })

  it('shows which calls are running, read by their conversation key', () => {
    env.statuses.set('app-chat:concierge:http:direct:order-42', 'generating')

    const html = render([record('order-42', { lastActiveAt: 2_000 }), record('order-41', { lastActiveAt: 1_000 })])

    expect(html.match(/pulse-dot-generating/g)).toHaveLength(1)
    expect(html.indexOf('pulse-dot-generating')).toBeGreaterThan(html.indexOf('order-42'))
    expect(html.indexOf('pulse-dot-generating')).toBeLessThan(html.lastIndexOf('order-41'))
  })

  it('draws the newest 30 calls and offers the rest on request', () => {
    const many = Array.from({ length: 45 }, (_, i) => record(`call-${String(i).padStart(2, '0')}`, { lastActiveAt: 10_000 - i }))

    const html = render(many)

    expect(html).toContain('call-00')
    expect(html).toContain('call-29')
    expect(html).not.toContain('call-30')
    expect(html).toContain('Show more')
  })

  it('draws 30 more each time more are asked for, until every call is drawn', () => {
    const many = Array.from({ length: 45 }, (_, i) => record(`call-${String(i).padStart(2, '0')}`, { lastActiveAt: 10_000 - i }))
    const runner = new StateRunner()
    const view = () => AppHttpSessionsView({ appId: APP, spaceId: 'space-1', sessions: many })

    ;(showMore(runner.render(view)).props.onClick as () => void)()
    const tree = runner.render(view)

    expect(elementsOf(tree, 'HttpSessionRow')).toHaveLength(45)
    expect(showMore(tree)).toBeUndefined()
  })

  it('has nothing more to offer when every call is drawn', () => {
    expect(render([record('order-42')])).not.toContain('Show more')
  })

  it('opens no transcript until a call is picked, then that call\'s', () => {
    const sessions = [record('order-42', { lastActiveAt: 2_000 }), record('order-41', { lastActiveAt: 1_000 })]
    expect(render(sessions)).not.toContain('data-transcript')

    const runner = new StateRunner()
    const view = () => AppHttpSessionsView({ appId: APP, spaceId: 'space-1', sessions })
    const rows = elementsOf(runner.render(view), 'HttpSessionRow')
    ;(rows[1].props.onSelect as () => void)()

    const [transcript] = elementsOf(runner.render(view), 'ImSessionDetailView')
    expect((transcript.props.session as ImSessionRecord).chatId).toBe('order-41')
  })

  it('offers no push, rename or removal for a call', () => {
    const html = render([record('order-42')])

    expect(html).not.toContain('Auto-sync run result')
    expect(html).not.toContain('Rename')
    expect(html).not.toContain('Remove')
  })
})
