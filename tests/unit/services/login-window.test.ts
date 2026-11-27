import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { windows } = vi.hoisted(() => ({ windows: [] as FakeWindow[] }))

class FakeWindow extends EventEmitter {
  readonly session = Object.assign(new EventEmitter(), {
    clearStorageData: vi.fn(async () => {}),
    setProxy: vi.fn(async (_config: Electron.ProxyConfig) => {}),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  })
  currentUrl = ''
  readonly webContents = Object.assign(new EventEmitter(), {
    session: this.session, setWindowOpenHandler: vi.fn(), getURL: () => this.currentUrl,
    executeJavaScriptInIsolatedWorld: vi.fn(async (_worldId: number, _scripts: { code: string }[]): Promise<unknown> => 0),
    zoom: 1,
    getZoomFactor(): number { return this.zoom },
    setZoomFactor: vi.fn(function (this: { zoom: number }, factor: number) { this.zoom = factor }),
  })
  contentSize = [0, 0]
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  readonly getContentSize = () => this.contentSize
  readonly setContentSize = vi.fn((width: number, height: number) => {
    this.contentSize = [width, height]
    this.bounds = { ...this.bounds, width, height: height + 28 }
  })
  readonly getBounds = () => this.bounds
  readonly getSize = () => [this.bounds.width, this.bounds.height]
  readonly setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y } })
  readonly focus = vi.fn()
  readonly show = vi.fn()
  readonly loadURL = vi.fn(async (_url: string) => {})
  readonly destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
  destroyed = false
  isDestroyed = () => this.destroyed

  constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
    super()
    this.contentSize = [options.width ?? 0, options.height ?? 0]
    this.bounds = { x: 100, y: 500, width: options.width ?? 0, height: (options.height ?? 0) + 28 }
    windows.push(this)
  }
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  nativeTheme: { shouldUseDarkColors: true },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 875 } }), getDisplayMatching: vi.fn() },
}))
vi.mock('../../../src/main/foundation/window.service', () => ({ getMainWindow: () => null }))

const { openLoginWindow } = await import('../../../src/main/services/login-window')

const log = vi.fn()
const onEnd = vi.fn()
const url = 'https://login.example/start?ticket=mock-ticket'

beforeEach(() => {
  windows.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(log)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('login window', () => {
  it.each(['http://login.example/', 'file:///tmp/test', 'https://user:secret@login.example/'])('refuses an unsafe initial location', invalid => {
    expect(() => openLoginWindow({ url: invalid, onEnd })).toThrow('Unsafe sign-in URL')
    expect(windows).toHaveLength(0)
  })

  it.each(['http://localhost:7301/', 'http://127.0.0.1:7301/', 'http://[::1]:7301/'])('accepts a loopback HTTP location', local => {
    const login = openLoginWindow({ url: local, onEnd })
    expect(windows).toHaveLength(1)
    login.close()
  })

  it('isolates the page and denies cross-origin navigation, extra windows and permissions', async () => {
    const login = openLoginWindow({ url, onEnd })
    const window = windows[0]
    expect(window.options.webPreferences).toMatchObject({
      contextIsolation: true, sandbox: true, nodeIntegration: false, partition: expect.stringMatching(/^login-/),
    })
    expect(window.options.backgroundColor).toBeDefined()
    expect(window.options).toMatchObject({ width: 560, height: 480, useContentSize: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(window.session.setProxy).not.toHaveBeenCalled()
    expect(window.loadURL).toHaveBeenCalledWith(url)
    login.focus()
    expect(window.focus).toHaveBeenCalledOnce()
    for (const channel of ['will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      window.webContents.emit(channel, { url: 'https://login.example/continue', isMainFrame: true, preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      window.webContents.emit(channel, { url: 'https://elsewhere.example/?ticket=other-secret', isMainFrame: true, preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(window.session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    const respond = vi.fn()
    window.session.setPermissionRequestHandler.mock.calls[0][0](window.webContents, 'camera', respond)
    expect(respond).toHaveBeenCalledWith(false)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/mock-ticket|other-secret|login\.example/)
    login.close()
    expect(onEnd).not.toHaveBeenCalled()
    expect(window.session.clearStorageData).toHaveBeenCalledOnce()
  })

  it('lets the page take the window to listed https origins while frames stay with their page', async () => {
    const login = openLoginWindow({
      url: 'http://127.0.0.1:7301/?token=page',
      origins: ['https://consent.example', 'https://path.example/consent', 'http://plain.example', 'https://user:pw@cred.example'],
      onEnd,
    })
    const window = windows[0]
    const navigate = (target: string, isMainFrame: boolean) => {
      const preventDefault = vi.fn()
      window.webContents.emit('will-frame-navigate', { url: target, isMainFrame, preventDefault })
      return preventDefault.mock.calls.length === 0
    }
    window.currentUrl = 'http://127.0.0.1:7301/?token=page'
    expect(navigate('https://consent.example/page/consent?code=1', true)).toBe(true)
    expect(navigate('https://consent.example/frame', false)).toBe(false)
    expect(navigate('http://127.0.0.1:7301/frame', false)).toBe(true)
    for (const refused of ['https://path.example/', 'http://plain.example/', 'https://cred.example/']) {
      expect(navigate(refused, true)).toBe(false)
    }
    window.currentUrl = 'https://consent.example/page/signin'
    expect(navigate('https://consent.example/frame', false)).toBe(true)
    expect(navigate('http://127.0.0.1:7301/frame', false)).toBe(false)
    expect(navigate('https://elsewhere.example/', true)).toBe(false)
    login.close()
  })

  it('scales a page taller than the screen down to fit, but not below 85%', async () => {
    const login = openLoginWindow({ url, onEnd })
    const window = windows[0]
    const contents = window.webContents
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(900)
    contents.emit('did-stop-loading')
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(0.91)
    expect(window.getContentSize()).toEqual([560, 819])
    expect(window.getBounds().y + window.getBounds().height).toBeLessThanOrEqual(875)
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValue(2000)
    await vi.advanceTimersByTimeAsync(300)
    expect(contents.zoom).toBe(0.85)
    expect(window.getContentSize()).toEqual([560, 823])
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValue(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(contents.zoom).toBe(0.85)
    login.close()
  })

  it('is shown at the first page\'s own height', async () => {
    const login = openLoginWindow({ url, onEnd })
    const window = windows[0]
    window.webContents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(652)
    window.emit('ready-to-show')
    expect(window.show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(window.getContentSize()).toEqual([560, 652])
    expect(window.show).toHaveBeenCalledOnce()
    login.close()
  })

  it('grows to each page\'s content within the screen and never shrinks', async () => {
    const login = openLoginWindow({ url, onEnd })
    const window = windows[0]
    window.setContentSize(560, 600)
    const overflow = [652.4, 0, 800, 500, 5000]
    window.webContents.executeJavaScriptInIsolatedWorld.mockImplementation(async () => overflow.shift())
    window.webContents.emit('did-stop-loading')
    await vi.advanceTimersByTimeAsync(0)
    expect(window.getContentSize()).toEqual([560, 653])
    await vi.advanceTimersByTimeAsync(300)
    expect(window.getContentSize()).toEqual([560, 653])
    await vi.advanceTimersByTimeAsync(700)
    expect(window.getContentSize()).toEqual([560, 800])
    await vi.advanceTimersByTimeAsync(1500)
    expect(window.getContentSize()).toEqual([560, 800])
    window.webContents.emit('did-stop-loading')
    await vi.advanceTimersByTimeAsync(0)
    expect(window.getContentSize()).toEqual([560, 823])
    expect(window.getBounds().height).toBe(851)
    expect(window.getBounds().y + window.getBounds().height).toBe(875)
    expect(window.webContents.executeJavaScriptInIsolatedWorld.mock.calls[0][1][0].code).not.toMatch(/fetch|cookie|localStorage/)
    login.close()
    window.webContents.emit('did-stop-loading')
    await vi.advanceTimersByTimeAsync(3000)
    expect(window.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(5)
  })

  it.each(['expired', 'cancelled'] as const)('settles once when first ending as %s', async outcome => {
    const login = openLoginWindow({ url, onEnd, timeoutMs: 1000 })
    const window = windows[0]
    await vi.advanceTimersByTimeAsync(0)
    if (outcome === 'cancelled') window.destroy()
    await vi.advanceTimersByTimeAsync(1000)
    window.emit('closed')
    login.close()
    expect(onEnd.mock.calls).toEqual([[outcome]])
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(window.session.clearStorageData).toHaveBeenCalledOnce()
  })
})
