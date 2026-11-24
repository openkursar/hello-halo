/**
 * The conversation list shows the form the user last left it in — folded to
 * its icon strip, or open — separately beside the canvas and without it, so
 * mounting it again (back from another page, out of a maximized canvas) keeps
 * that form. Dragging its edge decides the form, releasing saves it, and
 * folding never costs the list the width it opens at.
 *
 * No DOM here: React's hooks are replaced by a small runner that also runs
 * effects, `document` is an EventTarget receiving the drag's mouse events, and
 * the returned element tree is searched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) } },
  })
  return {
    mount: null as any,
    chat: { currentSpaceId: 's1', spaceStates: new Map([['s1', { conversations: [], currentConversationId: null, selectedAppChat: null }]]) },
    config: null as any,
    setConfig: null as any,
  }
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
vi.mock('../../../src/renderer/api', () => ({ api: { setConfig: (...args: unknown[]) => env.setConfig(...args) } }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: Object.assign((select: any) => select(env.chat), { getState: () => env.chat }),
  useAllConversationStatuses: () => new Map(),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: any) => select({ appStates: {} }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({ currentSpace: { id: 's1' } }) } }))
vi.mock('../../../src/renderer/stores/app.store', () => ({
  useAppStore: Object.assign((select: any) => select({ config: env.config }), {
    getState: () => ({ config: env.config, updateConfig: (update: any) => { env.config = { ...env.config, ...update } } }),
  }),
}))
vi.mock('../../../src/renderer/stores/app-chat-pins.store', () => ({ useAppChatPinsStore: (select: any) => select({ toggleAppChatPin: vi.fn() }) }))
// The real preference store, read the way its hook reads it.
vi.mock('../../../src/renderer/stores/conversation-list-prefs.store', async original => {
  const actual = await original<typeof import('../../../src/renderer/stores/conversation-list-prefs.store')>()
  const store = actual.useConversationListPrefs
  return { ...actual, useConversationListPrefs: Object.assign((select: any) => select(store.getState()), store) }
})
vi.mock('../../../src/renderer/hooks/useAppChatConversationRows', () => ({ useAppChatConversationRows: () => [] }))
vi.mock('../../../src/renderer/components/chat/conversation-list-panes', () => ({
  ROW_HEIGHT: 32,
  usePaneResize: () => ({ height: 160, dragging: false, handleProps: {} }),
  PaneResizeHandle: () => null,
}))
vi.mock('../../../src/renderer/components/apps/AutomationAvatar', () => ({ AutomationAvatar: () => null }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ markEntry: vi.fn(), trackHome: vi.fn(), trackNavigate: vi.fn() }))
vi.mock('../../../src/renderer/utils/conversation-navigation', () => ({ openDigitalHumanChat: vi.fn() }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonActivity: vi.fn() }))

import { ConversationList } from '../../../src/renderer/components/chat/ConversationList'
import { useConversationListPrefs } from '../../../src/renderer/stores/conversation-list-prefs.store'

type Props = { canvasOpen?: boolean }

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

  render(props: Props) {
    this.index = 0
    env.mount = this
    const tree = (ConversationList as unknown as { type: (props: Props) => unknown }).type(props)
    const queued = this.queued
    this.queued = []
    for (const run of queued) run()
    return tree
  }
}

/** Every element in the tree, without rendering child components. */
function nodes(tree: any): any[] { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] }

/** What the list draws: its icon strip, or the open list's width. */
function drawn(tree: unknown): 'strip' | number {
  const all = nodes(tree)
  if (all.some(node => /(^|\s)w-14(\s|$)/.test(node.props?.className ?? ''))) return 'strip'
  return all.find(node => typeof node.props?.style?.width === 'number').props.style.width
}

const LIST_LEFT = 64
const pointer = (type: string, width: number) => Object.assign(new Event(type), { clientX: LIST_LEFT + width })

/** Presses the list's edge. */
function press(list: Mount, props: Props) {
  const tree = list.render(props)
  // The element the list measures the pointer against.
  const container = nodes(tree).find(node => node.ref && typeof node.ref === 'object' && 'current' in node.ref)
  container.ref.current = { getBoundingClientRect: () => ({ left: LIST_LEFT }) }
  nodes(tree).find(node => node.props?.title === 'Drag to resize width').props.onMouseDown({ preventDefault() {} })
  return list.render(props)
}

/** Moves the held edge to `width` from the list's left side. */
function move(list: Mount, props: Props, width: number) {
  document.dispatchEvent(pointer('mousemove', width))
  return list.render(props)
}

function release(list: Mount, props: Props, width: number) {
  document.dispatchEvent(pointer('mouseup', width))
  return list.render(props)
}

/** Drags the list's edge through `widths` and lets go at the last one. */
function drag(list: Mount, props: Props, widths: number[]) {
  press(list, props)
  for (const width of widths) move(list, props, width)
  return release(list, props, widths.at(-1) ?? 0)
}

const besideCanvas: Props = { canvasOpen: true }
const withoutCanvas: Props = { canvasOpen: false }

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget())
  useConversationListPrefs.setState({ listFolded: {} })
  env.config = { layout: { sidebarWidth: 300 } }
  env.setConfig = vi.fn(() => Promise.resolve({ success: true }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('the conversation list form', () => {
  it('starts folded beside the canvas and open at its width without it', () => {
    expect(drawn(new Mount().render(besideCanvas))).toBe('strip')
    expect(drawn(new Mount().render(withoutCanvas))).toBe(300)
  })

  it('stays open beside the canvas once dragged open, when it is mounted again', () => {
    expect(drawn(drag(new Mount(), besideCanvas, [90, 180, 280]))).toBe(280)
    expect(env.setConfig).toHaveBeenCalledWith({ layout: { sidebarWidth: 280 } })

    // Back from another page, or out of a maximized canvas.
    expect(drawn(new Mount().render(besideCanvas))).toBe(280)
  })

  it('stays folded without the canvas once dragged to its strip, when it is mounted again', () => {
    expect(drawn(drag(new Mount(), withoutCanvas, [200, 120, 60]))).toBe('strip')
    expect(drawn(new Mount().render(withoutCanvas))).toBe('strip')
  })

  it('follows the pointer while held and saves only where it is let go', () => {
    const list = new Mount()
    press(list, besideCanvas)
    expect(drawn(move(list, besideCanvas, 200))).toBe(200)
    expect(drawn(move(list, besideCanvas, 40))).toBe('strip')
    expect(useConversationListPrefs.getState().listFolded).toEqual({})

    expect(drawn(release(list, besideCanvas, 40))).toBe('strip')
    expect(useConversationListPrefs.getState().listFolded).toEqual({ 'with-canvas': true })
  })

  it('keeps the choice beside the canvas apart from the one without it', () => {
    // Folded beside the canvas, still open once it closes.
    drag(new Mount(), besideCanvas, [280])
    drag(new Mount(), besideCanvas, [40])
    expect(drawn(new Mount().render(besideCanvas))).toBe('strip')
    expect(drawn(new Mount().render(withoutCanvas))).toBe(280)

    // Folded without the canvas, still open beside it.
    drag(new Mount(), besideCanvas, [260])
    drag(new Mount(), withoutCanvas, [40])
    expect(drawn(new Mount().render(withoutCanvas))).toBe('strip')
    expect(drawn(new Mount().render(besideCanvas))).toBe(260)
  })

  it('opens again at the width it had after being folded through narrower widths', () => {
    env.config = null
    useConversationListPrefs.getState().setListFolded('with-canvas', false)
    const list = new Mount()
    expect(drawn(list.render(withoutCanvas))).toBe(260)
    expect(drawn(drag(list, withoutCanvas, [200, 150, 120, 60]))).toBe('strip')
    expect(env.setConfig).not.toHaveBeenCalled()

    // The same list once the canvas opens beside it, where it was left open.
    expect(drawn(list.render(besideCanvas))).toBe(260)
  })

  it('changes nothing when its edge is only clicked', () => {
    const list = new Mount()
    drag(list, besideCanvas, [])
    expect(drawn(list.render(besideCanvas))).toBe('strip')
    expect(useConversationListPrefs.getState().listFolded).toEqual({})
    expect(env.setConfig).not.toHaveBeenCalled()
  })
})
