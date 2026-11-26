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
  readonly webContents = Object.assign(new EventEmitter(), {
    session: this.session, setWindowOpenHandler: vi.fn(),
  })
  readonly focus = vi.fn()
  readonly show = vi.fn()
  readonly loadURL = vi.fn(async (_url: string) => {})
  readonly destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
  destroyed = false
  isDestroyed = () => this.destroyed

  constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
    super()
    windows.push(this)
  }
}

vi.mock('electron', () => ({ BrowserWindow: FakeWindow, nativeTheme: { shouldUseDarkColors: true } }))
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
    await vi.advanceTimersByTimeAsync(0)
    expect(window.session.setProxy).not.toHaveBeenCalled()
    expect(window.loadURL).toHaveBeenCalledWith(url)
    login.focus()
    expect(window.focus).toHaveBeenCalledOnce()
    for (const channel of ['will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      window.webContents.emit(channel, { url: 'https://login.example/continue', preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      window.webContents.emit(channel, { url: 'https://elsewhere.example/?ticket=other-secret', preventDefault })
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
