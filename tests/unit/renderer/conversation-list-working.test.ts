/**
 * The conversation list says which digital humans are working, whatever they
 * work on: a turn in a conversation listed here, an IM or team chat the list
 * never shows, or a scheduled task.
 *
 * No DOM here: React's hooks are replaced by a small runner and the returned
 * element tree is searched; the virtualized panes are read through their
 * `itemContent`, the way Virtuoso renders a row.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  chat: {} as any,
  statuses: new Map<string, string>(),
  rows: [] as any[],
  apps: { appStates: {} as Record<string, { status: string }> },
  prefs: {} as any,
}))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: any) => env.runner.state(value), useRef: (value: any) => env.runner.ref(value), useMemo: (compute: any) => compute(), useCallback: (fn: any) => fn, useEffect: () => {}, useLayoutEffect: () => {} }))
vi.mock('react-virtuoso', () => ({ Virtuoso: function Virtuoso() { return null } }))
vi.mock('zustand/react/shallow', () => ({ useShallow: (select: any) => select }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: Object.assign((select: any) => select(env.chat), { getState: () => env.chat }),
  useAllConversationStatuses: () => env.statuses,
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select(env.apps) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({ currentSpace: { id: 's1' } }) } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: Object.assign((select: any) => select({ config: null }), { getState: () => ({ config: null }) }) }))
vi.mock('../../../src/renderer/stores/app-chat-pins.store', () => ({ useAppChatPinsStore: (select: any) => select({ toggleAppChatPin: vi.fn() }) }))
vi.mock('../../../src/renderer/stores/conversation-list-prefs.store', async original => ({
  ...await original<typeof import('../../../src/renderer/stores/conversation-list-prefs.store')>(),
  useConversationListPrefs: (select: any) => select(env.prefs),
}))
vi.mock('../../../src/renderer/hooks/useAppChatConversationRows', () => ({ useAppChatConversationRows: () => env.rows }))
vi.mock('../../../src/renderer/components/chat/conversation-list-panes', () => ({
  ROW_HEIGHT: 32,
  usePaneResize: () => ({ height: 160, dragging: false, handleProps: {} }),
  PaneResizeHandle: () => null,
}))
vi.mock('../../../src/renderer/components/chat/EngineBadge', () => ({ EngineBadge: () => null }))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ markEntry: vi.fn(), trackHome: vi.fn(), trackNavigate: vi.fn() }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ openDigitalHumanChat: vi.fn() }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonActivity: vi.fn() }))

import { ConversationList } from '../../../src/renderer/components/chat/ConversationList'
import { TaskStatusDot } from '../../../src/renderer/components/pulse/TaskStatusDot'

class ComponentRunner {
  values: any[] = []; index = 0
  state(initial: any) { const index = this.index++; if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? initial() : initial; return [this.values[index], (update: any) => { this.values[index] = typeof update === 'function' ? update(this.values[index]) : update }] }
  ref(initial: any) { const index = this.index++; this.values[index] ??= { current: initial }; return this.values[index] }
  render(component: () => any) { this.index = 0; env.runner = this; return component() }
}
/** Every element in the tree, without rendering child components. */
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }

const render = () => new ComponentRunner().render(() => (ConversationList as unknown as { type: (props: object) => unknown }).type({}))

/** One listed conversation with a digital human, idle unless a test says otherwise. */
function listedChat(appId: string) {
  return {
    id: `app-chat:${appId}:local:direct:c-${appId}`, appId, appSpaceId: 's1', digitalHumanName: appId,
    isDefault: false, displayName: 'Plan', updatedAt: 1, messageCount: 2, starred: false, status: 'active', uninstalled: false,
  }
}

/** The status dot a digital human's group heading shows, if any. */
function headingDot(appId: string) {
  const pane = nodes(render()).find(node => node.props?.data?.some?.((row: any) => row.type === 'dh-header'))
  const heading = pane.props.data.find((row: any) => row.type === 'dh-header' && row.appId === appId)
  return nodes(pane.props.itemContent(0, heading)).find(node => node.type === TaskStatusDot)?.props.status
}

/** The status dot on the folded "Digital Humans" heading, if any. */
const foldedSectionDot = () => nodes(render()).find(node => node.props?.section === 'digital-humans')?.props.attention

beforeEach(() => {
  env.chat = { currentSpaceId: 's1', spaceStates: new Map([['s1', { conversations: [], currentConversationId: null, selectedAppChat: null }]]) }
  env.statuses = new Map()
  env.rows = []
  env.apps = { appStates: {} }
  env.prefs = { sectionOpen: {}, appGroupOpen: {}, setAppGroupOpen: vi.fn(), setSectionOpen: vi.fn() }
})

describe('a digital human at work', () => {
  beforeEach(() => {
    env.prefs.sectionOpen = { s1: { 'digital-humans': true } }
  })

  it('shows on its heading while it answers an IM chat the list does not show', () => {
    env.rows = [listedChat('lin')]
    env.statuses = new Map([['app-chat:lin:wecom:direct:customer-1', 'generating']])
    expect(headingDot('lin')).toBe('generating')
  })

  it('shows on its heading during a team turn, a question it waits on, or a scheduled task', () => {
    env.rows = [listedChat('kai'), listedChat('eve'), listedChat('amy')]
    env.statuses = new Map([
      ['app-chat:kai:team:research:epoch-1', 'generating'],
      ['app-chat:eve:local:direct:c-eve', 'waiting'],
    ])
    env.apps.appStates = { amy: { status: 'running' } }
    expect(headingDot('kai')).toBe('generating')
    expect(headingDot('eve')).toBe('generating')
    expect(headingDot('amy')).toBe('generating')
  })

  it('does not show once the work is over or not yet started', () => {
    env.rows = [listedChat('bo'), listedChat('lin')]
    env.statuses = new Map([
      ['app-chat:bo:wecom:direct:customer-1', 'error'],
      ['app-chat:lin:local:direct:c-lin', 'completed-unseen'],
    ])
    env.apps.appStates = { bo: { status: 'queued' }, lin: { status: 'idle' } }
    expect(headingDot('bo')).toBeUndefined()
    expect(headingDot('lin')).toBeUndefined()
  })

  it('keeps the folded "Digital Humans" heading lit while one of its digital humans works elsewhere', () => {
    env.prefs.sectionOpen = {}
    env.rows = [listedChat('lin')]
    env.statuses = new Map([['app-chat:lin:wecom:direct:customer-1', 'generating']])
    expect(foldedSectionDot()).toBe('generating')
  })

  it('leaves the folded heading alone for a digital human it does not list', () => {
    env.prefs.sectionOpen = {}
    env.rows = [listedChat('lin')]
    env.statuses = new Map([['app-chat:zed:wecom:direct:customer-1', 'generating']])
    env.apps.appStates = { zed: { status: 'running' } }
    expect(foldedSectionDot()).toBeUndefined()
  })
})
