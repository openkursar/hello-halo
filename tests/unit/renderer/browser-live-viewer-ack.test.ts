/**
 * The live viewer's acknowledgements are what keep the stream flowing; a frame
 * that is on screen but never acknowledged gets the viewer dropped as stalled.
 * No DOM: hooks are replaced by a small runner and the element tree is searched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  runner: null as any,
  onFrame: null as ((frame: any) => void) | null,
  page: { visibilityState: 'visible', onVisibility: null as (() => void) | null },
  resources: {
    scope: () => ({ add: () => {}, dispose: () => {} }),
  },
  api: {
    attachBrowserLive: vi.fn(() => true),
    detachBrowserLive: vi.fn(),
    ackBrowserLive: vi.fn(),
    requestBrowserLiveDetail: vi.fn(),
    onBrowserLiveFrame: vi.fn(),
    onBrowserLiveStopped: vi.fn(() => () => {}),
    onWsStateChange: vi.fn(() => () => {}),
  },
}))

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (value: any) => env.runner.state(value),
  useEffect: (fn: any, deps: any) => env.runner.effect(fn, deps),
  useRef: (value: any) => env.runner.ref(value),
  useCallback: (fn: any) => fn,
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
// The desktop link fallback drags in the whole browser store; not under test here.
vi.mock('../../../src/renderer/components/canvas/viewers/BrowserViewer', () => ({ BrowserViewerFallback: () => null }))
vi.mock('../../../src/renderer/components/canvas/viewer-resources', () => ({
  useViewerResources: () => env.resources,
}))

import { BrowserLiveViewer } from '../../../src/renderer/components/canvas/viewers/BrowserLiveViewer'

class Runner {
  values: any[] = []; index = 0; pending: (() => void)[] = []
  state(initial: any) { const i = this.index++; if (!(i in this.values)) this.values[i] = initial; return [this.values[i], (v: any) => { this.values[i] = v }] }
  ref(initial: any) { const i = this.index++; if (!(i in this.values)) this.values[i] = { current: initial }; return this.values[i] }
  effect(fn: () => void, deps?: any[]) {
    const i = this.index++
    const prev = this.values[i]
    if (!deps || !prev || deps.some((d, k) => !Object.is(d, prev[k]))) this.pending.push(fn)
    this.values[i] = deps
  }
  render(component: () => any) {
    this.index = 0; this.pending = []; env.runner = this
    const tree = component()
    this.pending.forEach(fn => fn())
    return tree
  }
}

function nodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]
}

const tab = { id: 'tab-1', title: 'Login', url: 'https://example.com/login', browserViewId: 'view-1' } as any
const frame = (seq: number) => ({ viewId: 'view-1', seq, image: 'data:image/jpeg;base64,AAAA', width: 1024, height: 576 })

function watch() {
  const runner = new Runner()
  const draw = () => runner.render(() => BrowserLiveViewer({ tab }))
  const idle = nodes(draw()).find(n => typeof n.type === 'function' && n.props?.onStart)
  idle.props.onStart()
  draw()
  return draw
}

describe('BrowserLiveViewer acknowledgement', () => {
  beforeEach(() => {
    env.onFrame = null
    env.api.ackBrowserLive.mockReset()
    env.api.attachBrowserLive.mockClear()
    env.api.onBrowserLiveFrame.mockReset().mockImplementation((handler: any) => {
      env.onFrame = handler
      return () => {}
    })
    env.page = { visibilityState: 'visible', onVisibility: null }
    vi.stubGlobal('document', {
      get visibilityState() { return env.page.visibilityState },
      addEventListener: (_type: string, handler: () => void) => { env.page.onVisibility = handler },
      removeEventListener: () => {},
    })
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('acknowledges a frame once it has loaded', () => {
    const draw = watch()
    expect(env.api.attachBrowserLive).toHaveBeenCalledWith('view-1')

    env.onFrame!(frame(1))
    const img = nodes(draw()).find(n => n.type === 'img' && n.props.onLoad)
    expect(env.api.ackBrowserLive).not.toHaveBeenCalled()

    img.props.onLoad()
    expect(env.api.ackBrowserLive).toHaveBeenCalledWith('view-1', 1)
  })

  it('acknowledges a resent identical frame that fires no load event', () => {
    const draw = watch()
    env.onFrame!(frame(1))
    const img = nodes(draw()).find(n => n.type === 'img' && n.props.onLoad)
    ;(img.ref ?? img.props.ref).current = { complete: true, naturalWidth: 1024 }
    img.props.onLoad()

    env.onFrame!(frame(2))
    draw()

    expect(env.api.ackBrowserLive.mock.calls).toEqual([['view-1', 1], ['view-1', 2]])
  })

  it('acknowledges a restarted stream whose seq begins again after coming back', () => {
    const draw = watch()
    env.onFrame!(frame(1))
    const img = nodes(draw()).find(n => n.type === 'img' && n.props.onLoad)
    ;(img.ref ?? img.props.ref).current = { complete: true, naturalWidth: 1024 }
    img.props.onLoad()

    env.page.visibilityState = 'hidden'
    env.page.onVisibility!()
    env.page.visibilityState = 'visible'
    env.page.onVisibility!()
    env.onFrame!(frame(1))
    draw()

    expect(env.api.ackBrowserLive.mock.calls).toEqual([['view-1', 1], ['view-1', 1]])
  })

  it('shows where the page has navigated, not where the tab first opened', () => {
    const draw = watch()
    env.onFrame!({ ...frame(1), url: 'https://example.com/home' })
    const header = nodes(draw()).find(n => n.type === 'span' && n.props.title !== undefined)
    expect(header.props.children).toBe('https://example.com/home')
  })
})
