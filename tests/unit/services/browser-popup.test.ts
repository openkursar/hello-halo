import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions, HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron'

const policy = vi.hoisted(() => ({ allowed: true }))
const app = new EventEmitter()
const allContents: FakeContents[] = []
let nextFrameId = 1
const windows: FakeWindow[] = []
const views: FakeView[] = []
const compatibility = vi.hoisted(() => ({ ensure: vi.fn(async () => {}) }))
class FakeContents extends EventEmitter {
  mainFrame = { frameTreeNodeId: nextFrameId++ }
  opener?: { top: { frameTreeNodeId: number } }
  constructor() { super(); allContents.push(this) }
  id = 1
  session = {}
  debugger = new EventEmitter()
  url = 'https://allowed.example/start'
  destroyed = false
  ua = 'Runtime browser identity'
  handler!: (details: Partial<HandlerDetails> & { url: string }) => WindowOpenHandlerResponse
  close = vi.fn((_options?: { waitForBeforeUnload: boolean }) => this.destroy())
  isDestroyed = () => this.destroyed
  getURL = () => this.url
  getUserAgent = () => this.ua
  setUserAgent = vi.fn((ua: string) => { this.ua = ua })
  setWindowOpenHandler = vi.fn((handler: typeof this.handler) => { this.handler = handler })
  loadURL = vi.fn()
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('destroyed') }
}
class FakeWindow extends EventEmitter {
  loadURL = vi.fn(async (_url: string, _options?: { httpReferrer: Electron.Referrer }) => {})
  webContents: FakeContents
  destroyed = false
  constructor(public options: BrowserWindowConstructorOptions) {
    super()
    this.webContents = (options as unknown as { webContents: FakeContents }).webContents ?? new FakeContents()
    windows.push(this)
  }
  isDestroyed = () => this.destroyed
  destroy() { this.destroyed = true; this.webContents.destroy(); this.emit('closed') }
}
class FakeView {
  webContents: FakeContents
  constructor(public options: BrowserWindowConstructorOptions & { webContents?: FakeContents }) {
    this.webContents = options.webContents ?? new FakeContents()
    views.push(this)
  }
}
vi.mock('electron', () => ({ app, BrowserWindow: FakeWindow, WebContentsView: FakeView }))
vi.mock('../../../src/main/services/browser-compatibility', () => ({ ensureBrowserCompatibility: compatibility.ensure }))
vi.mock('../../../src/main/services/browser-policy.service', () => ({ isUrlAllowedByPolicy: () => policy.allowed }))
const { configureBrowserPopups, popupTargetAllowed } = await import('../../../src/main/services/browser-popup')

function configure(contents: FakeContents, visible = true) {
  configureBrowserPopups(contents as unknown as WebContents, { visible })
}
function create(opener: FakeContents, url = 'https://allowed.example/auth') {
  const response = opener.handler({ url })
  expect(response.action).toBe('allow')
  const nativeContents = new FakeContents()
  const options = { ...response.overrideBrowserWindowOptions, webContents: nativeContents }
  expect(response.createWindow).toBeUndefined()
  const window = new FakeWindow(options)
  opener.emit('did-create-window', window, { url })
  return { response, nativeContents, options, window }
}
beforeEach(() => { policy.allowed = true; windows.length = 0; views.length = 0; compatibility.ensure.mockClear(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { for (const window of windows) if (!window.isDestroyed()) window.destroy(); for (const view of views) if (!view.webContents.isDestroyed()) view.webContents.destroy(); allContents.splice(0).forEach(contents => contents.destroy()); vi.restoreAllMocks() })

function tabDetails(overrides: Partial<HandlerDetails> = {}): HandlerDetails {
  return { url: 'https://allowed.example/tab', disposition: 'foreground-tab', frameName: '_blank', features: '', referrer: { url: 'https://allowed.example/start', policy: 'strict-origin-when-cross-origin' }, ...overrides }
}
async function flush() { for (let index = 0; index < 10; index++) await Promise.resolve() }
function handoff(opener: FakeContents, details = tabDetails()) {
  const response = opener.handler(details)
  expect(response.action).toBe('allow')
  expect(response.createWindow).toBeTypeOf('function')
  const preferences = { ...response.overrideBrowserWindowOptions?.webPreferences, javascript: true }
  const contents = response.createWindow!({ ...response.overrideBrowserWindowOptions, webPreferences: preferences }) as unknown as FakeContents
  return { response, contents, preferences }
}

describe('native browser popups', () => {
  it('initializes child identity from its actual opener before native window creation', () => {
    const first = new FakeContents()
    const second = new FakeContents()
    first.ua = 'First browser identity'
    second.ua = 'Second browser identity'
    configure(first)
    configure(second)
    configure(second)
    expect(app.listenerCount('web-contents-created')).toBe(1)
    const child = new FakeContents()
    child.opener = { top: second.mainFrame }
    app.emit('web-contents-created', {}, child)
    expect(child.setUserAgent).toHaveBeenCalledWith(second.ua)
    expect(windows).toHaveLength(0)
    expect(child.loadURL).not.toHaveBeenCalled()
    const unrelated = new FakeContents()
    unrelated.opener = { top: { frameTreeNodeId: -1 } }
    const independent = new FakeContents()
    app.emit('web-contents-created', {}, unrelated)
    app.emit('web-contents-created', {}, independent)
    expect(unrelated.setUserAgent).not.toHaveBeenCalled()
    expect(independent.setUserAgent).not.toHaveBeenCalled()
    first.destroy()
    expect(app.listenerCount('web-contents-created')).toBe(1)
    Object.defineProperty(second, 'mainFrame', { get: () => { throw new Error('destroyed frame getter') } })
    expect(() => second.destroy()).not.toThrow()
    expect(app.listenerCount('web-contents-created')).toBe(0)
  })

  it('preserves native options and child identity without loading or steering a page', () => {
    const opener = new FakeContents()
    configure(opener)
    const child = create(opener)
    expect(child.window.options).toBe(child.options)
    expect(child.window.webContents).toBe(child.nativeContents)
    expect(child.nativeContents.setUserAgent).toHaveBeenCalledWith(opener.ua)
    expect(child.nativeContents.handler).toBeTypeOf('function')
    expect(child.nativeContents.listenerCount('will-navigate')).toBe(1)
    expect(child.nativeContents.listenerCount('will-redirect')).toBe(1)
    expect(child.nativeContents.loadURL).not.toHaveBeenCalled()
    expect(opener.loadURL).not.toHaveBeenCalled()
    expect(child.response.overrideBrowserWindowOptions?.webPreferences).toMatchObject({ session: opener.session, sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, preload: '' })
  })

  it('keeps hidden ownership on descendants without creating startup windows', () => {
    const opener = new FakeContents()
    configure(opener, false)
    expect(windows).toHaveLength(0)
    const child = create(opener)
    expect(child.options.show).toBe(false)
    expect(create(child.nativeContents).options.show).toBe(false)
  })

  it('denies unsafe targets and policy blocks before constructing a window', () => {
    const opener = new FakeContents()
    configure(opener)
    for (const url of ['file:///secret', 'FILE:///secret', 'javascript:alert(1)', 'chrome://settings', 'view-source:file:///secret']) {
      expect(opener.handler({ url })).toEqual({ action: 'deny' })
    }
    policy.allowed = false
    expect(opener.handler({ url: 'https://denied.example/?token=private' })).toEqual({ action: 'deny' })
    expect(windows).toHaveLength(0)
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private')
  })

  it('guards subsequent navigation and redirects including blank-window retargeting', () => {
    const opener = new FakeContents()
    configure(opener)
    const { nativeContents } = create(opener, 'about:blank')
    nativeContents.url = 'about:blank'
    for (const name of ['will-navigate', 'will-redirect']) {
      const event = { preventDefault: vi.fn() }
      nativeContents.emit(name, event, 'https://allowed.example/callback')
      expect(event.preventDefault).not.toHaveBeenCalled()
      nativeContents.emit(name, event, 'file:///secret')
      expect(event.preventDefault).toHaveBeenCalledOnce()
      policy.allowed = false
      nativeContents.emit(name, event, 'https://denied.example/callback')
      expect(event.preventDefault).toHaveBeenCalledTimes(2)
      policy.allowed = true
    }
  })

  it('configures once and destroys descendants with their actual opener', () => {
    const opener = new FakeContents()
    configure(opener)
    configure(opener)
    expect(opener.setWindowOpenHandler).toHaveBeenCalledOnce()
    expect(opener.listenerCount('destroyed')).toBe(1)
    expect(opener.listenerCount('did-create-window')).toBe(1)
    const child = create(opener)
    const grandchild = create(child.nativeContents)
    opener.destroy()
    expect(child.window.isDestroyed()).toBe(true)
    expect(opener.listenerCount('did-create-window')).toBe(0)
    expect(grandchild.window.isDestroyed()).toBe(true)
    expect(child.nativeContents.listenerCount('will-navigate')).toBe(0)
    expect(child.nativeContents.listenerCount('will-redirect')).toBe(0)
  })

  it('destroys a child whose setup fails without logging sensitive error text', () => {
    const opener = new FakeContents()
    configure(opener)
    const response = opener.handler({ url: 'https://allowed.example/auth' })
    const nativeContents = new FakeContents()
    nativeContents.setUserAgent.mockImplementationOnce(() => { throw new Error('token=private') })
    const child = new FakeWindow({ ...response.overrideBrowserWindowOptions, webContents: nativeContents } as BrowserWindowConstructorOptions)
    expect(() => opener.emit('did-create-window', child, { url: 'https://allowed.example/auth' })).not.toThrow()
    expect(windows.at(-1)!.isDestroyed()).toBe(true)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private')
  })

  it('shares one bounded window budget across descendants and recovers it on close', () => {
    const opener = new FakeContents()
    configure(opener)
    const first = create(opener)
    const second = create(first.nativeContents)
    for (let index = 0; index < 4; index++) create(second.nativeContents)
    expect(windows).toHaveLength(6)
    expect(opener.handler({ url: 'https://allowed.example/extra' })).toEqual({ action: 'deny' })
    expect(second.nativeContents.handler({ url: 'https://allowed.example/extra' })).toEqual({ action: 'deny' })
    windows.at(-1)!.destroy()
    expect(create(opener).window.isDestroyed()).toBe(false)
    expect(opener.handler({ url: 'https://allowed.example/extra' })).toEqual({ action: 'deny' })
  })

  it('closes a native popup that raced past the admission limit', () => {
    const opener = new FakeContents()
    configure(opener)
    for (let index = 0; index < 6; index++) create(opener)
    const unexpected = new FakeWindow({})
    opener.emit('did-create-window', unexpected, { url: 'https://allowed.example/extra' })
    expect(unexpected.isDestroyed()).toBe(true)
  })

  it.each(['foreground-tab', 'background-tab'] as const)('hands off a %s without steering the opener or inert contents', async disposition => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    const details = tabDetails({ disposition })
    const { contents, preferences } = handoff(opener, details)
    expect(openTab).not.toHaveBeenCalled()
    expect(windows).toHaveLength(0)
    expect(views[0].options.webPreferences).toBe(preferences)
    expect(preferences).toMatchObject({ session: opener.session, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: '' })
    await flush()
    expect(openTab).toHaveBeenCalledOnce()
    expect(openTab).toHaveBeenCalledWith({ url: details.url, referrer: details.referrer, background: disposition === 'background-tab' })
    expect(opener.loadURL).not.toHaveBeenCalled()
    expect(contents.loadURL).not.toHaveBeenCalled()
    expect(contents.close).toHaveBeenCalledOnce()
    expect(contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  })

  it('preserves and configures an existing native guest without replaying the request', async () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    const response = opener.handler(tabDetails())
    const guest = new FakeContents()
    const native = { ...response.overrideBrowserWindowOptions, webContents: guest } as BrowserWindowConstructorOptions
    expect(response.createWindow!(native)).toBe(guest)
    const child = windows[0]
    expect(child.options).toBe(native)
    expect(guest.setUserAgent).toHaveBeenCalledWith(opener.ua)
    expect(compatibility.ensure).toHaveBeenCalledWith(guest)
    expect(guest.listenerCount('will-redirect')).toBe(1)
    await flush()
    expect(openTab).not.toHaveBeenCalled()
    expect(guest.loadURL).not.toHaveBeenCalled()
    expect(opener.loadURL).not.toHaveBeenCalled()
    expect(views).toHaveLength(0)
    opener.destroy()
    expect(child.isDestroyed()).toBe(true)
  })

  it('hands off a proven independent native guest and cancels its initial navigation', async () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    const details = tabDetails()
    opener.debugger.emit('message', {}, 'Page.windowOpen', { url: details.url, windowFeatures: ['noopener'] })
    const response = opener.handler(details)
    const guest = new FakeContents()
    expect(response.createWindow!({ ...response.overrideBrowserWindowOptions, webContents: guest } as BrowserWindowConstructorOptions)).toBe(guest)
    expect(views[0].webContents).toBe(guest)
    expect(windows).toHaveLength(0)
    const event = { preventDefault: vi.fn() }
    guest.emit('will-frame-navigate', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await flush()
    expect(openTab).toHaveBeenCalledWith({ url: details.url, referrer: details.referrer, background: false })
    expect(guest.close).toHaveBeenCalledOnce()
    expect(guest.listenerCount('will-frame-navigate')).toBe(0)
    expect(guest.loadURL).not.toHaveBeenCalled()
    expect(opener.loadURL).not.toHaveBeenCalled()
    opener.destroy()
    expect(opener.debugger.listenerCount('message')).toBe(0)
  })

  it.each(['missing', 'script', 'child-session', 'different-url', 'expired', 'consumed'] as const)('retains native guest ownership for %s opener evidence', async evidence => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10000)
    const details = tabDetails()
    if (evidence !== 'missing') {
      opener.debugger.emit('message', {}, 'Page.windowOpen', {
        url: evidence === 'different-url' ? `${details.url}/other` : details.url,
        windowFeatures: evidence === 'script' ? [] : ['noopener'],
      }, evidence === 'child-session' ? 'child' : undefined)
    }
    if (evidence === 'expired') clock.mockReturnValue(11000)
    if (evidence === 'consumed') opener.handler(details)
    const response = opener.handler(details)
    const guest = new FakeContents()
    expect(response.createWindow!({ ...response.overrideBrowserWindowOptions, webContents: guest } as BrowserWindowConstructorOptions)).toBe(guest)
    expect(windows).toHaveLength(1)
    expect(views).toHaveLength(0)
    await flush()
    expect(openTab).not.toHaveBeenCalled()
    expect(guest.close).not.toHaveBeenCalled()
    opener.destroy()
  })

  it.each([true, false])('retains inherited HTML sandbox in a native window with existing guest=%s', async hasGuest => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    const details = tabDetails()
    opener.debugger.emit('message', {}, 'Page.windowOpen', { url: details.url, windowFeatures: ['noopener'] })
    const response = opener.handler(details)
    const guest = hasGuest ? new FakeContents() : undefined
    response.createWindow!({ ...response.overrideBrowserWindowOptions, webContents: guest, webPreferences: { ...response.overrideBrowserWindowOptions?.webPreferences, openerSandboxFlags: 1 } } as BrowserWindowConstructorOptions)
    expect(windows).toHaveLength(1)
    expect(views).toHaveLength(0)
    if (hasGuest) {
      expect(windows[0].loadURL).not.toHaveBeenCalled()
      expect(guest!.loadURL).not.toHaveBeenCalled()
    } else {
      expect(windows[0].loadURL).toHaveBeenCalledOnce()
      expect(windows[0].loadURL).toHaveBeenCalledWith(details.url, { httpReferrer: details.referrer })
    }
    await flush()
    expect(openTab).not.toHaveBeenCalled()
    opener.destroy()
  })

  it('uses a cached debugger emitter during opener destruction', () => {
    const opener = new FakeContents()
    configureBrowserPopups(opener as unknown as WebContents, { openTab: vi.fn(async () => {}) })
    const debuggerApi = opener.debugger
    Object.defineProperty(opener, 'debugger', { get: () => { throw new Error('destroyed getter') } })
    expect(() => opener.destroy()).not.toThrow()
    expect(debuggerApi.listenerCount('message')).toBe(0)
  })

  it('keeps POST, blank, named and new-window requests native', () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    for (const details of [tabDetails({ postBody: {} as HandlerDetails['postBody'] }), tabDetails({ url: 'about:blank' }), tabDetails({ frameName: 'account' }), tabDetails({ disposition: 'new-window' })]) {
      const response = opener.handler(details)
      expect(response.action).toBe('allow')
      expect(response.createWindow).toBeUndefined()
    }
    expect(openTab).not.toHaveBeenCalled()
  })

  it('keeps hidden requests native even when a tab owner is supplied', () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { visible: false, openTab })
    const response = opener.handler(tabDetails())
    expect(response.action).toBe('allow')
    expect(response.overrideBrowserWindowOptions?.show).toBe(false)
    expect(response.createWindow).toBeUndefined()
    expect(openTab).not.toHaveBeenCalled()
  })

  it('hands off hidden independent pages when an active owner permits them, but keeps auth native', async () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { visible: false, openTab, canOpenTab: () => true })
    const { contents } = handoff(opener)
    await flush()
    expect(openTab).toHaveBeenCalledOnce()
    expect(contents.close).toHaveBeenCalledOnce()
    expect(opener.loadURL).not.toHaveBeenCalled()
    const auth = create(opener)
    expect(auth.options.show).toBe(false)
    expect(auth.nativeContents.loadURL).not.toHaveBeenCalled()
  })

  it('reports denied targets without steering the opener', () => {
    const opener = new FakeContents()
    const onBlocked = vi.fn()
    configureBrowserPopups(opener as unknown as WebContents, { onBlocked })
    expect(opener.handler({ url: 'file:///secret' })).toEqual({ action: 'deny' })
    expect(onBlocked).toHaveBeenCalledWith('file:///secret')
    onBlocked.mockClear()
    policy.allowed = false
    const target = 'https://denied.example/path?token=private'
    expect(opener.handler({ url: target })).toEqual({ action: 'deny' })
    expect(onBlocked).toHaveBeenCalledWith(target)
    expect(opener.loadURL).not.toHaveBeenCalled()
    expect(windows).toHaveLength(0)
  })

  it('falls back to native windows when the tab owner is unavailable', () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    const canOpenTab = vi.fn(() => false)
    configureBrowserPopups(opener as unknown as WebContents, { openTab, canOpenTab })
    const response = opener.handler(tabDetails())
    expect(response.action).toBe('allow')
    expect(response.createWindow).toBeUndefined()
    expect(canOpenTab).toHaveBeenCalledOnce()
    expect(openTab).not.toHaveBeenCalled()
  })

  it('counts pending handoffs in the shared limit and releases them on settlement', async () => {
    const opener = new FakeContents()
    let finish!: () => void
    const openTab = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    const native = create(opener)
    for (let index = 0; index < 5; index++) handoff(opener)
    expect(opener.handler(tabDetails())).toEqual({ action: 'deny' })
    expect(native.nativeContents.handler(tabDetails())).toEqual({ action: 'deny' })
    await flush()
    finish()
    await flush()
    expect(views.filter(view => view.webContents.isDestroyed())).toHaveLength(1)
    expect(opener.handler(tabDetails()).action).toBe('allow')
    opener.destroy()
    expect(views.every(view => view.webContents.isDestroyed())).toBe(true)
  })

  it('sanitizes asynchronous handoff failure and releases the inert guest', async () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => { throw new Error('token=private') })
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    const { contents } = handoff(opener)
    await flush()
    expect(contents.isDestroyed()).toBe(true)
    expect(console.warn).toHaveBeenCalledWith('[Browser] New tab handoff failed', expect.objectContaining({ errorType: 'Error' }))
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private')
    expect(opener.handler(tabDetails()).action).toBe('allow')
  })

  it('refuses restricted handoffs and cancels deferred creation after opener destruction', async () => {
    const opener = new FakeContents()
    const openTab = vi.fn(async () => {})
    configureBrowserPopups(opener as unknown as WebContents, { openTab })
    policy.allowed = false
    expect(opener.handler(tabDetails())).toEqual({ action: 'deny' })
    policy.allowed = true
    expect(opener.handler(tabDetails({ url: 'javascript:alert(1)' }))).toEqual({ action: 'deny' })
    expect(views).toHaveLength(0)
    const { contents } = handoff(opener)
    opener.destroy()
    expect(contents.isDestroyed()).toBe(true)
    await flush()
    expect(openTab).not.toHaveBeenCalled()
    expect(contents.close).toHaveBeenCalledOnce()
  })

  it('retains existing local-file and blank popup rules', () => {
    expect(popupTargetAllowed('about:blank', 'https://allowed.example')).toBe(true)
    expect(popupTargetAllowed('file:///next.html', 'file:///start.html')).toBe(true)
    expect(popupTargetAllowed('file:///next.html', 'about:blank')).toBe(false)
    expect(popupTargetAllowed('invalid', 'https://allowed.example')).toBe(false)
  })
})
