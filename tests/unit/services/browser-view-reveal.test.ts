import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ initialize: vi.fn(), create: vi.fn(), present: vi.fn(), isVisible: vi.fn(), destroy: vi.fn(), destroyAll: vi.fn() }))
const policy = vi.hoisted(() => ({ allowed: true }))
const popups = vi.hoisted(() => ({ configure: vi.fn() }))
const compatibility = vi.hoisted(() => ({ ensure: vi.fn(async () => {}) }))
vi.mock('../../../src/main/services/browser-compatibility', () => ({ ensureBrowserCompatibility: compatibility.ensure }))
vi.mock('../../../src/main/services/browser-popup', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/main/services/browser-popup')>()
  return { ...actual, configureBrowserPopups: (...args: Parameters<typeof actual.configureBrowserPopups>) => { popups.configure(...args); actual.configureBrowserPopups(...args) } }
})
const browserSession = { getUserAgent: () => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', setUserAgent: vi.fn() }
const fromPartition = vi.fn(() => browserSession)
const guests = new Map<string, FakeGuest>()
const visible = new Set<string>()
let nextId = 1

class FakeGuest extends EventEmitter {
  id = nextId++
  mainFrame = { frameTreeNodeId: this.id }
  destroyed = false
  isDestroyed = () => this.destroyed
  setUserAgent = vi.fn()
  session = browserSession
  getUserAgent = this.session.getUserAgent
  loadURL = vi.fn().mockResolvedValue(undefined)
  reload = vi.fn()
  setWindowOpenHandler = vi.fn()
  pageUrl = 'https://example.com'
  getURL = () => this.pageUrl
  zoom = 1
  getZoomFactor = () => this.zoom
  setZoomFactor = vi.fn((value: number) => { this.zoom = value })
  debugger = Object.assign(new EventEmitter(), { isAttached: vi.fn(() => false), attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn().mockResolvedValue({}) })
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => 0, removeEntryAtIndex: vi.fn() }
  close() { this.destroyed = true; this.emit('destroyed') }
}

class FakeWindow extends EventEmitter {
  webContents = { send: vi.fn(), getZoomFactor: () => 1, isDestroyed: () => false }
  isDestroyed = () => false
}

vi.mock('electron', () => ({ BrowserWindow: FakeWindow, session: { fromPartition }, app: Object.assign(new EventEmitter(), { userAgentFallback: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) halo/3.2.0 Chrome/150.0.0.0 Electron/43.7.7 Safari/537.36' }) }))
vi.mock('../../../src/main/services/browser-host/manager', () => ({ browserHostManager: host }))
vi.mock('../../../src/main/services/browser-policy.service', () => ({ isUrlAllowedByPolicy: () => policy.allowed }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => ({}), onBrowserConfigChange: vi.fn() }))

type BrowserManager = typeof import('../../../src/main/services/browser-view.service')['browserViewManager']
let manager: BrowserManager
const BOUNDS = { x: 10, y: 20, width: 800, height: 600 }

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  guests.clear()
  visible.clear()
  policy.allowed = true
  compatibility.ensure.mockReset().mockResolvedValue(undefined)
  fromPartition.mockReturnValue(browserSession)
  host.create.mockImplementation(async (id: string) => { const guest = new FakeGuest(); guests.set(id, guest); return guest })
  host.present.mockImplementation((id: string, _bounds: unknown, shown: boolean) => { if (shown) visible.add(id); else visible.delete(id); return true })
  host.isVisible.mockImplementation((id: string) => visible.has(id))
  host.destroy.mockImplementation((id: string) => { const guest = guests.get(id); guests.delete(id); visible.delete(id); guest?.close() })
  host.destroyAll.mockImplementation(() => { for (const id of guests.keys()) host.destroy(id) })
  manager = (await import('../../../src/main/services/browser-view.service')).browserViewManager
  manager.initialize(new FakeWindow() as never)
})

afterEach(() => { manager.destroyAll() })

describe('browser manager and persistent carrier', () => {
  it('configures the persistent session identity before allocating a guest', async () => {
    await manager.create('session-identity', 'https://example.com')
    expect(fromPartition).toHaveBeenCalledWith('persist:browser')
    expect(browserSession.setUserAgent).toHaveBeenCalled()
    expect(browserSession.setUserAgent.mock.invocationCallOrder[0]).toBeLessThan(host.create.mock.invocationCallOrder[0])
    expect(guests.get('session-identity')!.session).toBe(browserSession)
  })

  it('continues ordinary page creation when compatibility setup fails', async () => {
    compatibility.ensure.mockRejectedValueOnce(new Error('setup failed'))
    await expect(manager.create('compatibility-failure', 'https://example.com')).resolves.toMatchObject({ id: 'compatibility-failure' })
    expect(guests.get('compatibility-failure')!.loadURL).toHaveBeenCalledWith('https://example.com', undefined)
  })

  it('keeps WebContents identity across watching, parking and repeated presentation', async () => {
    await manager.create('ai-page', 'https://example.com')
    const guest = manager.getWebContents('ai-page')
    for (let cycle = 0; cycle < 8; cycle++) {
      expect(manager.show('ai-page', BOUNDS)).toBe(true)
      expect(manager.isRevealed('ai-page')).toBe(true)
      expect(manager.hide('ai-page')).toBe(true)
      expect(manager.isRevealed('ai-page')).toBe(false)
      expect(manager.getWebContents('ai-page')).toBe(guest)
    }
    expect(host.create).toHaveBeenCalledOnce()
    expect(host.destroy).not.toHaveBeenCalled()
  })

  it('parks the former page before showing its replacement without recreating either', async () => {
    await manager.create('first', 'https://example.com/first')
    await manager.create('second', 'https://example.com/second')
    manager.show('first', BOUNDS)
    host.present.mockClear()
    manager.show('second', BOUNDS)
    expect(host.present.mock.calls.map(([id, _bounds, shown]) => ({ id, shown }))).toEqual([{ id: 'first', shown: false }, { id: 'second', shown: true }])
    expect(manager.getActiveViewId()).toBe('second')
    expect(host.create).toHaveBeenCalledTimes(2)
  })

  it('uses the host creation contract for unattended pages and never transfers a guest', async () => {
    await manager.create('automation', 'https://example.com', { offscreen: true })
    expect(host.create).toHaveBeenCalledWith('automation', true)
    const guest = manager.getWebContents('automation')
    host.present.mockReturnValueOnce(false)
    expect(manager.show('automation', BOUNDS)).toBe(false)
    expect(manager.getWebContents('automation')).toBe(guest)
    expect(manager.getActiveViewId()).toBeNull()
  })

  it('announces page loss once when the host destroys a guest and clears all browser state', async () => {
    const seen: string[] = []
    const off = manager.onViewDestroyed(id => seen.push(id))
    await manager.create('page', 'https://example.com')
    manager.show('page', BOUNDS)
    guests.get('page')!.close()
    expect(manager.getState('page')).toBeNull()
    expect(manager.getWebContents('page')).toBeNull()
    expect(manager.getActiveViewId()).toBeNull()
    manager.destroy('page')
    expect(seen).toEqual(['page'])
    off()
  })

  it('continues announcing destruction when one subscriber fails', async () => {
    const seen: string[] = []
    const offBad = manager.onViewDestroyed(() => { throw new Error('subscriber failed') })
    const offGood = manager.onViewDestroyed(id => seen.push(id))
    await manager.create('page', 'https://example.com')
    manager.destroy('page')
    expect(seen).toEqual(['page'])
    offBad()
    offGood()
  })

  it('ignores navigation and destruction events from an older guest with the same page id', async () => {
    await manager.create('same-id', 'https://example.com/first')
    const oldGuest = guests.get('same-id')!
    manager.destroy('same-id')
    await manager.create('same-id', 'https://example.com/replacement')
    const replacement = manager.getWebContents('same-id')
    oldGuest.emit('page-title-updated', {}, 'stale title')
    oldGuest.emit('did-start-navigation', {}, 'https://stale.invalid', false, true)
    oldGuest.emit('destroyed')
    expect(manager.getWebContents('same-id')).toBe(replacement)
    expect(manager.getState('same-id')).toMatchObject({ title: 'New Tab', url: 'https://example.com/replacement' })
  })

  it('does not register a guest that attaches after its browser was closed', async () => {
    let resolve!: (guest: FakeGuest) => void
    host.create.mockImplementationOnce(() => new Promise<FakeGuest>(accept => { resolve = accept }))
    const creation = manager.create('closing', 'https://example.com')
    const rejected = expect(creation).rejects.toThrow('closed during creation')
    await Promise.resolve()
    manager.destroy('closing')
    resolve(new FakeGuest())
    await rejected
    expect(manager.getState('closing')).toBeNull()
    expect(manager.getWebContents('closing')).toBeNull()
  })

  it('rejects policy blocked initial URLs before allocating a guest', async () => {
    policy.allowed = false
    await expect(manager.create('blocked', 'https://blocked.invalid')).rejects.toMatchObject({ code: 'BROWSER_POLICY_BLOCKED' })
    expect(host.create).not.toHaveBeenCalled()
    expect(manager.getState('blocked')).toBeNull()
  })

  it('parks a policy blocked page and restores its existing guest after allowed navigation', async () => {
    await manager.create('page', 'https://example.com')
    const guest = manager.getWebContents('page')
    manager.show('page', BOUNDS)
    policy.allowed = false
    expect(await manager.navigate('page', 'https://blocked.invalid')).toBe(false)
    expect(manager.getState('page')).toMatchObject({ blockedByPolicy: true, blockedUrl: 'https://blocked.invalid' })
    expect(manager.isRevealed('page')).toBe(false)
    expect(manager.getWebContents('page')).toBe(guest)
    policy.allowed = true
    guests.get('page')!.emit('did-start-navigation', {}, 'https://example.com/allowed', false, true)
    expect(manager.getState('page')).toMatchObject({ blockedByPolicy: false, blockedUrl: undefined })
    expect(manager.isRevealed('page')).toBe(true)
  })
})

describe('website tabs', () => {
  type PopupOptions = { canOpenTab: () => boolean; openTab: (request: import('../../../src/main/services/browser-popup').BrowserTabRequest) => Promise<void>; onBlocked: (target: string) => void }
  const request = { url: 'https://example.org/next', referrer: { url: 'https://example.com', policy: 'strict-origin-when-cross-origin' }, background: true } as const

  it('creates a tab with its referrer without changing the opener', async () => {
    const main = new FakeWindow()
    manager.initialize(main as never)
    await manager.create('opener', 'https://example.com')
    const opener = guests.get('opener')!
    const options = popups.configure.mock.calls[0][1] as PopupOptions
    expect(options.canOpenTab()).toBe(false)
    manager.show('opener', BOUNDS)
    expect(options.canOpenTab()).toBe(true)
    opener.loadURL.mockClear()
    await options.openTab(request)
    const childId = host.create.mock.calls[1][0] as string
    expect(host.create).toHaveBeenLastCalledWith(childId, false)
    expect(main.webContents.send).toHaveBeenCalledWith('browser:tab-opened', expect.objectContaining({ viewId: childId, openerViewId: 'opener', url: request.url, background: true }))
    expect(guests.get(childId)!.loadURL).toHaveBeenLastCalledWith(request.url, { httpReferrer: request.referrer })
    expect(opener.loadURL).not.toHaveBeenCalled()
    expect(manager.getWebContents('opener')).toBe(opener)
  })

  it.each([true, false])('inherits ownership and device mode without watching, hidden=%s', async offscreen => {
    const main = new FakeWindow()
    manager.initialize(main as never)
    const owner = { isActive: () => true, reserve: vi.fn(), ready: vi.fn(), release: vi.fn() }
    await manager.create('owned-opener', 'https://example.com', { offscreen, deviceMode: 'h5', owner })
    const options = popups.configure.mock.calls[0][1] as PopupOptions
    expect(options.canOpenTab()).toBe(true)
    main.webContents.send.mockClear()
    await options.openTab(request)
    const childId = host.create.mock.calls[1][0] as string
    expect(host.create).toHaveBeenLastCalledWith(childId, offscreen)
    expect(manager.getState(childId)).toMatchObject({ deviceMode: 'h5' })
    expect(owner.reserve).toHaveBeenCalledWith(childId, offscreen)
    expect(owner.ready).toHaveBeenCalledWith(childId)
    expect(owner.reserve.mock.invocationCallOrder[1]).toBeLessThan(host.create.mock.invocationCallOrder[1])
    expect(owner.ready.mock.invocationCallOrder[1]).toBeLessThan(guests.get(childId)!.loadURL.mock.invocationCallOrder[0])
    if (offscreen) expect(main.webContents.send.mock.calls.some(([channel]) => channel === 'browser:tab-opened')).toBe(false)
    else expect(main.webContents.send).toHaveBeenCalledWith('browser:tab-opened', expect.objectContaining({ viewId: childId, borrowed: true }))
    manager.destroy(childId)
    expect(owner.release).toHaveBeenCalledWith(childId)
  })

  it('reserves an owner before asynchronous attachment exposes a guest', async () => {
    let finish!: (guest: FakeGuest) => void
    host.create.mockImplementationOnce(() => new Promise<FakeGuest>(resolve => { finish = resolve }))
    let active = true
    const owner = { isActive: () => active, reserve: vi.fn(), ready: vi.fn(), release: vi.fn() }
    const opening = manager.create('reserved', 'https://example.com', { owner })
    const rejected = expect(opening).rejects.toThrow(/closed|released/)
    expect(owner.reserve).toHaveBeenCalledWith('reserved', false)
    expect(host.create).not.toHaveBeenCalled()
    await Promise.resolve()
    active = false
    manager.destroy('reserved')
    finish(new FakeGuest())
    await rejected
    expect(owner.ready).not.toHaveBeenCalled()
    expect(manager.getState('reserved')).toBeNull()
  })

  it('reports only visible policy-blocked popups without parking or navigating the opener', async () => {
    await manager.create('opener', 'https://example.com')
    const options = popups.configure.mock.calls[0][1] as PopupOptions
    options.onBlocked('https://blocked.example/path?token=private')
    expect(manager.getState('opener')?.blockedPopupHost).toBeUndefined()
    manager.show('opener', BOUNDS)
    options.onBlocked('https://blocked.example/path?token=private')
    options.onBlocked('https://blocked.example/again')
    expect(manager.getState('opener')).toMatchObject({ blockedPopupHost: 'blocked.example', blockedPopupSequence: 2 })
    expect(manager.getState('opener')?.blockedByPolicy).not.toBe(true)
    expect(manager.isRevealed('opener')).toBe(true)
    guests.get('opener')!.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
    expect(manager.getState('opener')?.blockedPopupHost).toBeUndefined()
  })

  it('cleans up a child if its opener closes while the host attaches it', async () => {
    await manager.create('opener', 'https://example.com')
    const options = popups.configure.mock.calls[0][1] as PopupOptions
    let resolve!: (guest: FakeGuest) => void
    host.create.mockImplementationOnce((id: string) => new Promise<FakeGuest>(accept => { resolve = guest => { guests.set(id, guest); accept(guest) } }))
    const opening = options.openTab(request)
    const rejected = expect(opening).rejects.toThrow('opener closed during tab creation')
    await Promise.resolve()
    const childId = host.create.mock.calls[1][0] as string
    manager.destroy('opener')
    const child = new FakeGuest()
    resolve(child)
    await rejected
    expect(child.isDestroyed()).toBe(true)
    expect(manager.getState(childId)).toBeNull()
    expect(manager.getWebContents(childId)).toBeNull()
  })
})

describe('pages opening new windows', () => {
  type OpenHandler = (details: { url: string }) => { action: string }

  async function openHandlerOf(id: string, pageUrl: string): Promise<{ guest: FakeGuest; open: OpenHandler }> {
    await manager.create(id, 'https://example.com')
    const guest = guests.get(id)!
    guest.pageUrl = pageUrl
    guest.loadURL.mockClear()
    return { guest, open: guest.setWindowOpenHandler.mock.calls[0][0] as OpenHandler }
  }

  it('lets a web page open a native child without navigating its own view', async () => {
    const { guest, open } = await openHandlerOf('page', 'https://example.com')
    expect(open({ url: 'https://example.org/next' })).toMatchObject({ action: 'allow' })
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  it('never lets a web page open a local address', async () => {
    const { guest, open } = await openHandlerOf('page', 'https://example.com')
    for (const url of ['file:///etc/hosts', 'FILE:///etc/hosts', 'view-source:file:///etc/hosts', 'filesystem:file:///x', 'chrome://settings']) {
      expect(open({ url })).toEqual({ action: 'deny' })
    }
    expect(guest.loadURL).not.toHaveBeenCalled()
    expect(manager.getState('page')).not.toMatchObject({ blockedByPolicy: true })
  })

  it('lets a local page open another local file, as browsers do', async () => {
    const { guest, open } = await openHandlerOf('page', 'file:///Users/me/report/index.html')
    expect(open({ url: 'file:///Users/me/report/detail.html' })).toMatchObject({ action: 'allow' })
    expect(guest.loadURL).not.toHaveBeenCalled()
  })
})

describe('popupTargetAllowed', () => {
  it('follows the browser rule for what a page may open', async () => {
    const { popupTargetAllowed } = await import('../../../src/main/services/browser-popup')
    expect(popupTargetAllowed('https://a.example', 'https://b.example')).toBe(true)
    expect(popupTargetAllowed('http://a.example', 'file:///x.html')).toBe(true)
    expect(popupTargetAllowed('about:blank', 'https://b.example')).toBe(true)
    expect(popupTargetAllowed('file:///x', 'https://b.example')).toBe(false)
    expect(popupTargetAllowed('file:///x', 'about:blank')).toBe(false)
    expect(popupTargetAllowed('file:///y', 'file:///x.html')).toBe(true)
    expect(popupTargetAllowed('view-source:file:///x', 'file:///x.html')).toBe(false)
    expect(popupTargetAllowed('javascript:alert(1)', 'https://b.example')).toBe(false)
    expect(popupTargetAllowed('not a url', 'https://b.example')).toBe(false)
  })
})
