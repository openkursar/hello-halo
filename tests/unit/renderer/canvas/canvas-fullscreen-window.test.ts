/**
 * The canvas tab bar's fullscreen button also maximizes the window when it is
 * not already; leaving fullscreen gives back only what entering changed, also
 * when the tab bar was remounted in between (fullscreen crossing a layout
 * breakpoint in a narrow window).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  effects: [] as Array<() => void>,
  windowMaximized: true,
  calls: [] as string[],
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: (initial: unknown) => (env.refs[env.refIndex++] ??= { current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void) => { env.effects.push(effect) },
}))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => {
  const state: Record<string, unknown> = { getIsOpen: true, getTabs: [], getActiveTabId: null, getIsTransitioning: false }
  // An open canvas with no tabs; listeners subscribe and are never called.
  return {
    canvasLifecycle: new Proxy({}, {
      get: (_target, key: string) => key in state ? () => state[key] : () => () => {},
    }),
  }
})
vi.mock('../../../../src/renderer/stores/notification.store', () => ({ useNotificationStore: { getState: () => ({ show: () => {} }) } }))
vi.mock('../../../../src/renderer/stores/canvas.store', async original => {
  const actual = await original<typeof import('../../../../src/renderer/stores/canvas.store')>()
  const store = actual.useCanvasStore
  const toggleMaximized = () => {
    env.calls.push('canvas')
    store.getState().toggleMaximized()
  }
  return {
    ...actual,
    useCanvasStore: Object.assign(
      (select: (state: unknown) => unknown) => select({ ...store.getState(), toggleMaximized }),
      store,
    ),
  }
})
vi.mock('../../../../src/renderer/components/canvas/viewers/useWindowMaximize', () => ({
  useWindowMaximize: () => ({
    isMaximized: env.windowMaximized,
    toggleMaximize: async () => {
      env.calls.push(env.windowMaximized ? 'restore window' : 'maximize window')
      env.windowMaximized = !env.windowMaximized
    },
  }),
}))
vi.mock('../../../../src/renderer/hooks/useCanvasLifecycle', () => ({
  useTabList: () => [],
  useActiveTabId: () => null,
  useCanvasActions: () => ({}),
}))
vi.mock('../../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../../src/renderer/utils/browser-homepage', () => ({ getBrowserHomepage: vi.fn() }))
vi.mock('../../../../src/renderer/services/tool-session-telemetry', () => ({ trackToolOpen: vi.fn() }))
vi.mock('../../../../src/renderer/components/canvas/CanvasToggleButton', () => ({ CanvasToggleButton: () => null }))
vi.mock('../../../../src/renderer/components/icons/ToolIcons', () => ({ FileIcon: () => null }))

import { CanvasTabBar } from '../../../../src/renderer/components/canvas/CanvasTabs'
import { useCanvasStore } from '../../../../src/renderer/stores/canvas.store'

const setCanvasMaximized = (maximized: boolean) => useCanvasStore.getState().setMaximized(maximized)

/** Renders the bar as React would (refs kept, effects run) and returns its fullscreen toggle. */
function render(): () => Promise<void> {
  env.refIndex = 0
  env.effects = []
  const element = CanvasTabBar() as unknown as { props: { onToggleMaximize: () => Promise<void> } }
  for (const effect of env.effects) effect()
  return element.props.onToggleMaximize
}

beforeEach(() => {
  env.refs = []
  env.calls = []
  setCanvasMaximized(false)
})

/** The tab bar unmounts and mounts again: what it kept in refs is gone. */
function remount() {
  env.refs = []
}

describe('canvas fullscreen and the window', () => {
  it('leaves a window that was maximized beforehand maximized', async () => {
    env.windowMaximized = true
    await render()()
    expect(env.calls).toEqual(['canvas'])

    await render()()
    expect(env.calls).toEqual(['canvas', 'canvas'])
    expect(env.windowMaximized).toBe(true)
  })

  it('restores a window that entering fullscreen maximized', async () => {
    env.windowMaximized = false
    await render()()
    expect(env.calls).toEqual(['maximize window', 'canvas'])

    await render()()
    expect(env.calls).toEqual(['maximize window', 'canvas', 'restore window', 'canvas'])
    expect(env.windowMaximized).toBe(false)
  })

  it('forgets that once fullscreen is left another way', async () => {
    env.windowMaximized = false
    await render()()
    // Left through the chat capsule, which does not touch the window.
    setCanvasMaximized(false)
    render()
    // Fullscreen again, now from the maximized window: nothing to give back.
    setCanvasMaximized(true)
    env.calls = []
    await render()()
    expect(env.calls).toEqual(['canvas'])
    expect(env.windowMaximized).toBe(true)
  })

  it('restores the window it maximized even after the tab bar remounted in fullscreen', async () => {
    env.windowMaximized = false
    await render()()
    remount()

    await render()()
    expect(env.calls).toEqual(['maximize window', 'canvas', 'restore window', 'canvas'])
    expect(env.windowMaximized).toBe(false)
  })
})
