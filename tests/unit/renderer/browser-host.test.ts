import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostBridge, BrowserHostCommand, BrowserHostPage } from '../../../src/shared/types/browser-host'
import { mountBrowserHost, bindBrowserSurface } from '../../../src/renderer/browser-host'

class FakeElement {
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  ownerDocument: FakeDocument
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  attributes = new Map<string, string>()
  tabIndex = 0
  isConnected = true
  rect = { x: 10, y: 20, width: 640, height: 480 }
  blur = vi.fn()
  constructor(document: FakeDocument) { this.ownerDocument = document }
  appendChild(element: FakeElement) { element.parentElement = this; this.children.push(element) }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  getBoundingClientRect() { return this.rect }
  getAnimations() { return [] }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(element => element !== this)
    this.parentElement = null
    this.isConnected = false
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null
  frames = new Map<number, FrameRequestCallback>()
  nextFrame = 0
  defaultView = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { const id = ++this.nextFrame; this.frames.set(id, callback); return id }),
    cancelAnimationFrame: vi.fn((id: number) => { this.frames.delete(id) }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  createElement = vi.fn(() => new FakeElement(this))
  runFrame() { const callbacks = [...this.frames.values()]; this.frames.clear(); callbacks.forEach(callback => callback(16)) }
}

const page = (id = 'page', token = 'token', visible = true): BrowserHostPage => ({ id, token, src: `about:blank#halo-browser-${token}`, bounds: { x: 10, y: 20, width: 640, height: 480 }, visible })

function setup() {
  const document = new FakeDocument()
  const container = new FakeElement(document)
  let receive: (command: BrowserHostCommand) => void = () => { throw new Error('Host has not subscribed') }
  let resolve!: (pages: BrowserHostPage[]) => void
  const snapshot = new Promise<BrowserHostPage[]>(accept => { resolve = accept })
  const order: string[] = []
  const unsubscribe = vi.fn()
  const bridge: BrowserHostBridge = {
    onBrowserHostCommand: callback => { order.push('subscribe'); receive = callback; return unsubscribe },
    browserHostReady: () => { order.push('ready'); return snapshot },
    browserHostFailed: vi.fn(),
    browserHostFrameReady: vi.fn(),
  }
  const host = mountBrowserHost(container as never, bridge)
  return { document, container, bridge, host, order, unsubscribe, receive: (command: BrowserHostCommand) => receive(command), resolve }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn() })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('persistent browser DOM host', () => {
  it('subscribes before requesting the snapshot and preserves the node and creation src on presentation updates', async () => {
    const fixture = setup()
    expect(fixture.order).toEqual(['subscribe', 'ready'])
    fixture.resolve([page()])
    await fixture.host.ready
    const element = fixture.container.children[0]
    fixture.receive({ type: 'upsert', page: { ...page(), src: 'https://must-not-navigate.invalid', bounds: { x: 50, y: 60, width: 500, height: 400 } } })
    expect(fixture.container.children).toEqual([element])
    expect(element.getAttribute('src')).toBe(page().src)
    expect(element.getAttribute('partition')).toBe('persist:browser')
    expect(element.style.left).toBe('50px')
    expect(element.style.width).toBe('500px')
    expect(fixture.document.createElement).toHaveBeenCalledOnce()
    fixture.host.dispose()
  })

  it('lets commands received during snapshot loading win, including removal before the snapshot arrives', async () => {
    const fixture = setup()
    fixture.receive({ type: 'upsert', page: page('replaced', 'current') })
    fixture.receive({ type: 'remove', id: 'removed', token: 'old' })
    fixture.resolve([page('replaced', 'old'), page('removed', 'old'), page('unchanged', 'stable')])
    await fixture.host.ready
    expect(fixture.container.children.map(element => element.dataset)).toEqual([
      { browserPageId: 'replaced', browserPageToken: 'current' },
      { browserPageId: 'unchanged', browserPageToken: 'stable' },
    ])
    fixture.host.dispose()
  })

  it('ignores stale removal tokens and replaces a node only for a new guest lifetime', async () => {
    const fixture = setup()
    fixture.resolve([page()])
    await fixture.host.ready
    const original = fixture.container.children[0]
    fixture.receive({ type: 'remove', id: 'page', token: 'stale' })
    expect(fixture.container.children).toEqual([original])
    fixture.receive({ type: 'upsert', page: page('page', 'replacement') })
    const replacement = fixture.container.children[0]
    expect(replacement).not.toBe(original)
    expect(original.isConnected).toBe(false)
    fixture.receive({ type: 'remove', id: 'page', token: 'token' })
    expect(fixture.container.children).toEqual([replacement])
    fixture.host.dispose()
  })

  it('parks without detaching, preserves viewport size and removes keyboard and pointer access', async () => {
    const fixture = setup()
    fixture.resolve([page()])
    await fixture.host.ready
    const element = fixture.container.children[0]
    fixture.document.activeElement = element
    fixture.receive({ type: 'upsert', page: page('page', 'token', false) })
    expect(element.isConnected).toBe(true)
    expect(fixture.container.children).toEqual([element])
    expect(element.style).toMatchObject({ width: '640px', height: '480px', pointerEvents: 'none', left: '-100000px', top: '-100000px' })
    expect(element.tabIndex).toBe(-1)
    expect(element.getAttribute('aria-hidden')).toBe('true')
    expect(element.blur).toHaveBeenCalledOnce()
    fixture.host.dispose()
  })

  it('stays parked immediately after the React surface unmounts even if a late visible command arrives', async () => {
    const fixture = setup()
    const surface = new FakeElement(fixture.document)
    const unbind = bindBrowserSurface('page', surface as never)
    fixture.resolve([page()])
    await fixture.host.ready
    const element = fixture.container.children[0]
    expect(element.style.pointerEvents).toBe('auto')
    unbind()
    expect(element.style.pointerEvents).toBe('none')
    fixture.receive({ type: 'upsert', page: page() })
    expect(element.style.pointerEvents).toBe('none')
    expect(element.isConnected).toBe(true)
    fixture.host.dispose()
  })

  it('does not let an older viewer cleanup remove the replacement viewer surface', async () => {
    const fixture = setup()
    fixture.resolve([page()])
    await fixture.host.ready
    const first = new FakeElement(fixture.document)
    const second = new FakeElement(fixture.document)
    second.rect = { x: 80, y: 90, width: 800, height: 600 }
    const unbindFirst = bindBrowserSurface('page', first as never)
    const unbindSecond = bindBrowserSurface('page', second as never)
    unbindFirst()
    expect(fixture.container.children[0].style).toMatchObject({ pointerEvents: 'auto', left: '80px', top: '90px' })
    unbindSecond()
    fixture.host.dispose()
  })

  it('does not recreate nodes after disposal from a late snapshot or queued command', async () => {
    const fixture = setup()
    fixture.receive({ type: 'upsert', page: page() })
    fixture.host.dispose()
    fixture.host.dispose()
    fixture.resolve([page('late')])
    await fixture.host.ready
    fixture.receive({ type: 'upsert', page: page('queued') })
    expect(fixture.container.children).toEqual([])
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
    expect(fixture.document.createElement).toHaveBeenCalledOnce()
  })

  it('prepares an invisible in-viewport capture without changing its viewport or user input access', async () => {
    const fixture = setup()
    fixture.resolve([page('page', 'token', false)])
    await fixture.host.ready
    const element = fixture.container.children[0]
    fixture.receive({ type: 'upsert', page: { ...page('page', 'token', false), frameLeaseId: 'capture', bounds: { x: 0, y: 0, width: 900, height: 700 } } })
    expect(element.style).toMatchObject({ left: '0px', top: '0px', opacity: '0', pointerEvents: 'none', width: '640px', height: '480px' })
    expect(element.tabIndex).toBe(-1)
    expect(element.getAttribute('aria-hidden')).toBe('true')
    fixture.document.runFrame()
    expect(fixture.bridge.browserHostFrameReady).not.toHaveBeenCalled()
    fixture.document.runFrame()
    expect(fixture.bridge.browserHostFrameReady).toHaveBeenCalledOnce()
    expect(fixture.bridge.browserHostFrameReady).toHaveBeenCalledWith({ id: 'page', token: 'token', frameLeaseId: 'capture' })
    fixture.receive({ type: 'upsert', page: { ...page('page', 'token', false), frameLeaseId: 'capture' } })
    fixture.document.runFrame()
    expect(fixture.bridge.browserHostFrameReady).toHaveBeenCalledOnce()
    fixture.receive({ type: 'upsert', page: page('page', 'token', false) })
    expect(element.style).toMatchObject({ left: '-100000px', top: '-100000px', opacity: '1', pointerEvents: 'none' })
    fixture.host.dispose()
  })

  it('does not move or hide a guest that is already visible during capture', async () => {
    const fixture = setup()
    fixture.resolve([{ ...page(), frameLeaseId: 'capture' }])
    await fixture.host.ready
    expect(fixture.container.children[0].style).toMatchObject({ left: '10px', top: '20px', opacity: '1', pointerEvents: 'auto' })
    fixture.host.dispose()
    fixture.document.runFrame()
    fixture.document.runFrame()
    expect(fixture.bridge.browserHostFrameReady).not.toHaveBeenCalled()
  })

  it('cancels stale capture readiness when the lease ends or the guest lifetime changes', async () => {
    const fixture = setup()
    fixture.resolve([{ ...page('page', 'old', false), frameLeaseId: 'old-capture' }])
    await fixture.host.ready
    const stale = [...fixture.document.frames.values()][0]
    fixture.receive({ type: 'remove', id: 'page', token: 'old' })
    fixture.receive({ type: 'upsert', page: { ...page('page', 'new', false), frameLeaseId: 'new-capture' } })
    stale(16)
    expect(fixture.bridge.browserHostFrameReady).not.toHaveBeenCalled()
    fixture.receive({ type: 'upsert', page: page('page', 'new', false) })
    fixture.document.runFrame()
    fixture.document.runFrame()
    expect(fixture.bridge.browserHostFrameReady).not.toHaveBeenCalled()
    fixture.host.dispose()
  })
})
