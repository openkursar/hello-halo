/**
 * The conversation list follows the open conversation: one opened from
 * elsewhere (a conversation link, search, another space) is scrolled into view
 * in its pane, in a section the list opens for the moment, or as its dot on the
 * icon strip. A row picked in the list itself never moves it, and once reached
 * a row is not chased again when the list reorders.
 *
 * No DOM here: React's hooks are replaced by a small runner that also runs
 * effects, the virtual lists are reached through their `ref` and measurement
 * callbacks, and the returned element tree is searched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) } },
  })
  return { mount: null as any, chat: null as any, rows: [] as any[] }
})
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.mount.state(value),
  useRef: (value: any) => env.mount.ref(value),
  useMemo: (compute: any) => compute(),
  useCallback: (fn: any) => fn,
  useEffect: (run: any, deps?: unknown[]) => env.mount.effect(run, deps),
  useLayoutEffect: (run: any, deps?: unknown[]) => env.mount.effect(run, deps),
}))
vi.mock('react-virtuoso', () => ({ Virtuoso: function Virtuoso() { return null } }))
vi.mock('zustand/react/shallow', () => ({ useShallow: (select: any) => select }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: Object.assign((select: any) => select(env.chat), { getState: () => env.chat }),
  useAllConversationStatuses: () => new Map(),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ appStates: {} }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({ currentSpace: { id: env.chat.currentSpaceId } }) } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: Object.assign((select: any) => select({ config: null }), { getState: () => ({ config: null }) }) }))
vi.mock('../../../src/renderer/stores/app-chat-pins.store', () => ({ useAppChatPinsStore: (select: any) => select({ toggleAppChatPin: vi.fn() }) }))
// The real preference store, read the way its hook reads it.
vi.mock('../../../src/renderer/stores/conversation-list-prefs.store', async original => {
  const actual = await original<typeof import('../../../src/renderer/stores/conversation-list-prefs.store')>()
  const store = actual.useConversationListPrefs
  return { ...actual, useConversationListPrefs: Object.assign((select: any) => select(store.getState()), store) }
})
vi.mock('../../../src/renderer/hooks/useAppChatConversationRows', () => ({ useAppChatConversationRows: () => env.rows }))
vi.mock('../../../src/renderer/hooks/useTeamConversationRows', async original => ({
  ...await original<typeof import('../../../src/renderer/hooks/useTeamConversationRows')>(),
  useTeamConversationRows: () => ({ tasks: [], teams: [], pins: [], hidden: {}, error: false }),
}))
vi.mock('../../../src/renderer/components/chat/conversation-list-panes', () => ({
  ROW_HEIGHT: 32,
  usePaneResize: () => ({ height: 160, dragging: false, handleProps: {} }),
  PaneResizeHandle: () => null,
}))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ markEntry: vi.fn(), trackHome: vi.fn(), trackNavigate: vi.fn() }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ openDigitalHumanChat: vi.fn() }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonActivity: vi.fn() }))

import { Virtuoso } from 'react-virtuoso'
import { ConversationList } from '../../../src/renderer/components/chat/ConversationList'
import { planReveal } from '../../../src/renderer/components/chat/conversation-list-reveal'
import { useConversationListPrefs } from '../../../src/renderer/stores/conversation-list-prefs.store'

/** One mounted list: its hook state lives here, and its effects run after each render. */
class Mount {
  private slots: any[] = []
  private index = 0
  private queued: Array<() => void> = []

  state(initial: any) {
    const index = this.index++
    if (!(index in this.slots)) this.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = this.slots[index]
    return [slot.value, (update: any) => { slot.value = typeof update === 'function' ? update(slot.value) : update }]
  }

  ref(initial: any) {
    const index = this.index++
    this.slots[index] ??= { current: initial }
    return this.slots[index]
  }

  effect(run: () => void | (() => void), deps?: unknown[]) {
    const index = this.index++
    const previous = this.slots[index]
    if (previous && deps && previous.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    const slot = { deps, cleanup: undefined as void | (() => void) }
    this.slots[index] = slot
    this.queued.push(() => {
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      slot.cleanup = run()
    })
  }

  render(): any {
    this.index = 0
    env.mount = this
    const tree = (ConversationList as unknown as { type: (props: object) => unknown }).type({})
    const queued = this.queued
    this.queued = []
    for (const run of queued) run()
    return tree
  }

  /** Renders until state set by effects (a section opened for the moment) has settled. */
  settle(): any {
    let tree = this.render()
    for (let i = 0; i < 3; i++) tree = this.render()
    return tree
  }
}

/** Every element in the tree, without rendering child components. */
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }

type Pane = 'pinned' | 'digital-humans' | 'conversations'

/** The virtual list drawing `pane`, told apart by what its rows are. */
function paneList(tree: unknown, pane: Pane) {
  return nodes(tree).find(node => node.type === Virtuoso && node.props.data.some((row: any) => {
    if (pane === 'digital-humans') return row.type === 'dh-header'
    if (row.type !== 'item' && row.type !== 'dh-item') return false
    const starred = row.type === 'item' ? row.conversation.starred : row.row.starred
    return pane === 'pinned' ? !!starred && (row.type === 'item' || row.standalone) : !starred && row.type === 'item'
  }))
}

/** Lets `pane`'s list come up the way Virtuoso does: attached, then measured. */
function attach(tree: unknown, pane: Pane, { measure = true } = {}) {
  const list = paneList(tree, pane)
  if (!list) throw new Error(`The ${pane} pane is not drawn`)
  const handle = { scrollIntoView: vi.fn(), measure: () => list.props.totalListHeightChanged(640) }
  list.props.scrollerRef({})
  list.ref(handle)
  if (measure) handle.measure()
  return handle
}

/** Virtuoso re-renders: its handle ref is detached and a new handle attached, the list staying mounted. */
function rerenderList(tree: unknown, pane: Pane) {
  const list = paneList(tree, pane)
  const handle = { scrollIntoView: vi.fn() }
  list.ref(null)
  list.ref(handle)
  return handle
}

const conversation = (id: string, starred = false) => ({ id, spaceId: 's1', title: `Title ${id}`, updatedAt: '2026-11-01T00:00:00.000Z', starred })
/** Forty conversations, newest first. */
const archive = (space = 's1', prefix = 'c') => Array.from({ length: 40 }, (_, i) => ({ ...conversation(`${prefix}${String(i).padStart(2, '0')}`), spaceId: space }))

function spaceState(conversations: any[], current: string | null, selectedAppChat: any = null) {
  return { conversations, currentConversationId: current, selectedAppChat }
}

/** Opens `id` the way a link or another surface does: only the store's pointer moves. */
function openElsewhere(id: string) {
  const state = env.chat.spaceStates.get(env.chat.currentSpaceId)
  env.chat.spaceStates.set(env.chat.currentSpaceId, { ...state, currentConversationId: id, selectedAppChat: null })
}

function dhRow(appId: string, id: string, starred = false) {
  return { id, appId, appSpaceId: 's1', digitalHumanName: appId, isDefault: false, displayName: id, updatedAt: 1, messageCount: 2, starred, status: 'active', uninstalled: false }
}

let frames: Array<() => void> = []
/** Runs the animation frames requested so far, and those they request, up to `count` rounds. */
function runFrames(count = 10) {
  for (let i = 0; i < count && frames.length > 0; i++) {
    const due = frames
    frames = []
    for (const frame of due) frame()
  }
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (frame: () => void) => frames.push(frame))
  env.rows = []
  env.chat = {
    currentSpaceId: 's1',
    spaceStates: new Map([['s1', spaceState(archive(), 'c00')]]),
    selectConversation: vi.fn((id: string) => openElsewhere(id)),
  }
  useConversationListPrefs.setState({ sectionOpen: {}, appGroupOpen: {}, listFolded: {} })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('planReveal', () => {
  const rows = (...keys: string[]) => keys.map(key => ({ key }))
  const panes = (open = { pinned: true, 'digital-humans': true, conversations: true }) => ({
    pinned: { rows: rows('p1', 'p2'), open: open.pinned },
    'digital-humans': { rows: rows('dh-header:a', 'd1'), open: open['digital-humans'] },
    conversations: { rows: rows('c1', 'c2', 'c3'), open: open.conversations },
  })

  it('finds the row by id in the pane that draws it', () => {
    expect(planReveal('c3', panes(), null)).toEqual({ type: 'row', section: 'conversations', index: 2 })
    expect(planReveal('p2', panes(), null)).toEqual({ type: 'row', section: 'pinned', index: 1 })
    expect(planReveal('d1', panes(), null)).toEqual({ type: 'row', section: 'digital-humans', index: 1 })
  })

  it('opens a folded section first', () => {
    expect(planReveal('c1', panes({ pinned: true, 'digital-humans': true, conversations: false }), null))
      .toEqual({ type: 'open', section: 'conversations' })
  })

  it('aims at the dot when the list is folded to its strip', () => {
    expect(planReveal('c2', panes(), rows('p1', 'p2', 'c1', 'c2'))).toEqual({ type: 'dot', index: 3 })
  })

  it('waits while the conversation is not drawn', () => {
    expect(planReveal('missing', panes(), null)).toBeNull()
    expect(planReveal('d9', panes(), null)).toBeNull()
  })
})

describe('the open conversation in the list', () => {
  it('is scrolled into view once its pane has measured itself, and again when one is opened from elsewhere', () => {
    const list = new Mount()
    const conversations = attach(list.render(), 'conversations', { measure: false })
    list.render()
    // Aimed before the viewport is measured, the list would treat it as zero height.
    expect(conversations.scrollIntoView).not.toHaveBeenCalled()
    conversations.measure()
    // On mount the list asks; Virtuoso leaves an already visible row where it is.
    expect(conversations.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(conversations.scrollIntoView).toHaveBeenLastCalledWith({ index: 0, behavior: 'auto' })

    openElsewhere('c35')
    list.render()
    expect(conversations.scrollIntoView).toHaveBeenCalledTimes(2)
    expect(conversations.scrollIntoView).toHaveBeenLastCalledWith({ index: 35, behavior: 'auto' })
  })

  it('aims again on the next frames while the list lays out, and stops once another conversation is opened', () => {
    const list = new Mount()
    const conversations = attach(list.render(), 'conversations')
    runFrames()
    conversations.scrollIntoView.mockClear()

    openElsewhere('c35')
    list.render()
    runFrames()
    expect(conversations.scrollIntoView.mock.calls).toEqual(Array(3).fill([{ index: 35, behavior: 'auto' }]))

    conversations.scrollIntoView.mockClear()
    openElsewhere('c30')
    list.render()
    openElsewhere('c20')
    list.render()
    runFrames()
    expect(conversations.scrollIntoView.mock.calls.filter(([location]) => location.index === 30)).toHaveLength(1)
    expect(conversations.scrollIntoView.mock.calls.filter(([location]) => location.index === 20)).toHaveLength(3)
  })

  it('keeps reaching rows after the virtual list re-renders and hands out a new handle', () => {
    const list = new Mount()
    const tree = list.render()
    attach(tree, 'conversations')
    const renewed = rerenderList(tree, 'conversations')

    openElsewhere('c35')
    list.render()
    expect(renewed.scrollIntoView).toHaveBeenLastCalledWith({ index: 35, behavior: 'auto' })
  })

  it('waits for a remounted list to measure itself again', () => {
    const list = new Mount()
    const tree = list.render()
    attach(tree, 'conversations')
    paneList(tree, 'conversations').props.scrollerRef(null)
    paneList(tree, 'conversations').ref(null)
    const remounted = attach(list.render(), 'conversations', { measure: false })

    openElsewhere('c35')
    list.render()
    expect(remounted.scrollIntoView).not.toHaveBeenCalled()
    remounted.measure()
    expect(remounted.scrollIntoView).toHaveBeenLastCalledWith({ index: 35, behavior: 'auto' })
  })

  it('is not chased again when the list reorders after it was reached', () => {
    const list = new Mount()
    const conversations = attach(list.render(), 'conversations')
    openElsewhere('c35')
    list.render()
    const before = conversations.scrollIntoView.mock.calls.length

    const state = env.chat.spaceStates.get('s1')
    const moved = state.conversations.find((conv: any) => conv.id === 'c35')
    env.chat.spaceStates.set('s1', { ...state, conversations: [moved, ...state.conversations.filter((conv: any) => conv !== moved)] })
    list.render()
    expect(conversations.scrollIntoView).toHaveBeenCalledTimes(before)
  })

  it('leaves the list still when the row was picked in the list itself', () => {
    const list = new Mount()
    const tree = list.render()
    const conversations = attach(tree, 'conversations')
    const pane = paneList(tree, 'conversations')
    const row = pane.props.data[3]
    pane.props.itemContent(3, row).props.onClick()
    expect(env.chat.selectConversation).toHaveBeenCalledWith('c03')

    list.render()
    expect(conversations.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('waits for a conversation the list does not hold yet, then reaches it', () => {
    const list = new Mount()
    const conversations = attach(list.render(), 'conversations')
    openElsewhere('fresh')
    list.render()
    expect(conversations.scrollIntoView).toHaveBeenCalledTimes(1)

    const state = env.chat.spaceStates.get('s1')
    env.chat.spaceStates.set('s1', { ...state, conversations: [...state.conversations, conversation('fresh')] })
    list.render()
    expect(conversations.scrollIntoView).toHaveBeenLastCalledWith({ index: 40, behavior: 'auto' })
  })

  it('opens a folded section for the moment, without saving it as the user\'s choice', () => {
    useConversationListPrefs.getState().setSectionOpen('s1', 'conversations', false)
    openElsewhere('c20')
    const list = new Mount()
    const tree = list.settle()
    expect(nodes(tree).find(node => node.props?.section === 'conversations').props.collapsed).toBe(false)
    const conversations = attach(tree, 'conversations')
    expect(conversations.scrollIntoView).toHaveBeenLastCalledWith({ index: 20, behavior: 'auto' })
    expect(useConversationListPrefs.getState().sectionOpen).toEqual({ s1: { conversations: false } })

    // The user's own fold still wins once they use the header.
    nodes(list.render()).find(node => node.props?.section === 'conversations').props.onToggle('conversations')
    expect(nodes(list.render()).find(node => node.props?.section === 'conversations').props.collapsed).toBe(true)
  })

  it('reaches a pinned conversation inside a folded pinned section', () => {
    const pins = Array.from({ length: 8 }, (_, i) => conversation(`p${i}`, true))
    env.chat.spaceStates.set('s1', spaceState([...pins, ...archive()], 'c00'))
    useConversationListPrefs.getState().setSectionOpen('s1', 'pinned', false)
    const list = new Mount()
    attach(list.render(), 'conversations')

    openElsewhere('p7')
    const tree = list.settle()
    const pinned = attach(tree, 'pinned')
    expect(pinned.scrollIntoView).toHaveBeenLastCalledWith({ index: 7, behavior: 'auto' })
    expect(useConversationListPrefs.getState().sectionOpen).toEqual({ s1: { pinned: false } })
  })

  it('reaches a digital human\'s conversation in a folded group, leaving the saved folds alone', () => {
    env.rows = [dhRow('dh1', 'app-chat:dh1:local:direct:c1'), dhRow('dh1', 'app-chat:dh1:local:direct:c2'), dhRow('dh2', 'app-chat:dh2:local:direct:c3')]
    useConversationListPrefs.getState().setAppGroupOpen('s1', 'dh1', false)
    const list = new Mount()
    list.render()

    const state = env.chat.spaceStates.get('s1')
    env.chat.spaceStates.set('s1', { ...state, selectedAppChat: { appId: 'dh1', conversationId: 'app-chat:dh1:local:direct:c2' } })
    const tree = list.settle()
    const humans = attach(tree, 'digital-humans')
    const data = paneList(tree, 'digital-humans').props.data
    const index = data.findIndex((row: any) => row.key === 'app-chat:dh1:local:direct:c2')
    expect(index).toBeGreaterThan(0)
    expect(humans.scrollIntoView).toHaveBeenLastCalledWith({ index, behavior: 'auto' })
    expect(useConversationListPrefs.getState().appGroupOpen).toEqual({ s1: { dh1: false } })
    expect(useConversationListPrefs.getState().sectionOpen).toEqual({})
  })

  it('is reached in another space after the switch', () => {
    const list = new Mount()
    const conversations = attach(list.render(), 'conversations')
    env.chat.spaceStates.set('s2', spaceState(archive('s2', 'd'), null))
    env.chat.currentSpaceId = 's2'
    list.render()
    openElsewhere('d25')
    list.render()
    expect(conversations.scrollIntoView).toHaveBeenLastCalledWith({ index: 25, behavior: 'auto' })
  })

  it('scrolls the dot into view on the icon strip and leaves the list folded', () => {
    useConversationListPrefs.getState().setListFolded('without-canvas', true)
    const list = new Mount()
    const tree = list.render()
    const strip = nodes(tree).find(node => node.ref && typeof node.ref === 'object' && 'current' in node.ref && /overflow-y-auto/.test(node.props.className))
    const dots = strip.props.children.map((_: unknown, i: number) => ({ getBoundingClientRect: () => ({ top: 40 + i * 26 - column.scrollTop, bottom: 64 + i * 26 - column.scrollTop }) }))
    const column = { scrollTop: 0, children: dots, getBoundingClientRect: () => ({ top: 40, bottom: 640 }) }
    strip.ref.current = column

    openElsewhere('c35')
    const folded = list.render()
    // Dot 35 ends at 64 + 35 * 26 = 974: just enough to bring its bottom to the column's.
    expect(column.scrollTop).toBe(974 - 640)
    expect(nodes(folded).some(node => /(^|\s)w-14(\s|$)/.test(node.props?.className ?? ''))).toBe(true)
    expect(nodes(folded).find(node => node.key === 'c35').props['aria-current']).toBe(true)

    // A visible dot does not move the strip.
    openElsewhere('c30')
    list.render()
    expect(column.scrollTop).toBe(974 - 640)
  })
})
