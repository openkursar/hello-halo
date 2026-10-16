import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let nextId = 1
const windows: FakeWindow[] = []

class FakeContents extends EventEmitter {
  id = nextId++
  destroyed = false
  url = ''
  throttling = true
  pid = 0
  preferences: Record<string, unknown> = {}
  send = vi.fn()
  setWindowOpenHandler = vi.fn()
  isDestroyed = () => this.destroyed
  isCrashed = () => false
  getOSProcessId = () => this.pid
  getLastWebPreferences = () => this.preferences
  getURL = () => this.url
  getBackgroundThrottling = () => this.throttling
  setBackgroundThrottling = vi.fn((value: boolean) => { this.throttling = value })
  close = vi.fn(() => { this.destroyed = true; this.emit('destroyed') })
}

class FakeWindow extends EventEmitter {
  webContents = new FakeContents()
  destroyed = false
  visible = true
  minimized = false
  constructor(public options?: Record<string, unknown>) { super(); windows.push(this) }
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isMinimized = () => this.minimized
  loadFile = vi.fn().mockResolvedValue(undefined)
  loadURL = vi.fn().mockResolvedValue(undefined)
  destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
}

vi.mock('electron', () => ({ BrowserWindow: FakeWindow }))

type HostModule = typeof import('../../../src/main/services/browser-host')
type HostManager = HostModule['browserHostManager']
let manager: HostManager
let MainHostAttachError: HostModule['MainHostAttachError']
let main: FakeWindow

function attach(window: FakeWindow, page: { src: string }, partition = 'persist:browser') {
  const event = { preventDefault: vi.fn() }
  const preferences: Record<string, unknown> = { preload: '/untrusted/preload.js', nodeIntegration: true, sandbox: false, transparent: true }
  window.webContents.emit('will-attach-webview', event, preferences, { src: page.src, partition })
  const guest = new FakeContents()
  guest.preferences = preferences
  guest.url = page.src
  if (!event.preventDefault.mock.calls.length) {
    window.webContents.emit('did-attach-webview', {}, guest)
    guest.emit('dom-ready')
  }
  return { event, preferences, guest }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  windows.length = 0
  ;({ browserHostManager: manager, MainHostAttachError } = await import('../../../src/main/services/browser-host'))
  main = new FakeWindow()
  manager.initialize(main as never)
})

afterEach(() => {
  manager.destroyAll()
  for (const window of windows) if (!window.destroyed) window.destroy()
  vi.useRealTimers()
})

describe('browser guest trust boundary', () => {
  it('resolves only the allocated guest and strips renderer supplied privileges', async () => {
    const creation = manager.create('trusted', false)
    const [page] = manager.ready(main.webContents as never)
    const { event, preferences, guest } = attach(main, page)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({ sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, webviewTag: false, webSecurity: true, navigateOnDragDrop: false, allowRunningInsecureContent: false, partition: 'persist:browser', transparent: false })
    expect(preferences).not.toHaveProperty('preload')
    expect(await creation).toBe(guest)
  })

  it('keeps screenshot capable background preferences on the unattended host', async () => {
    const creation = manager.create('background', true)
    const background = windows[1]
    const [page] = manager.ready(background.webContents as never)
    const { guest, preferences } = attach(background, page)
    expect(preferences.backgroundThrottling).toBe(false)
    expect(preferences.transparent).toBe(false)
    expect(background.options).toMatchObject({ show: false, webPreferences: { backgroundThrottling: false } })
    expect(await creation).toBe(guest)
  })

  it('refuses unsolicited, wrong-partition, duplicate and foreign-host attachments', async () => {
    expect(attach(main, { src: 'https://attacker.invalid' }).event.preventDefault).toHaveBeenCalledOnce()
    const creation = manager.create('trusted', false)
    const [page] = manager.ready(main.webContents as never)
    expect(attach(main, page, 'persist:foreign').event.preventDefault).toHaveBeenCalledOnce()
    const foreign = new FakeWindow()
    manager.initialize(foreign as never)
    expect(attach(foreign, page).event.preventDefault).toHaveBeenCalledOnce()
    const guest = attach(main, page).guest
    expect(await creation).toBe(guest)
    expect(attach(main, page).event.preventDefault).toHaveBeenCalledOnce()
  })

  it('closes guests whose attachment event cannot be tied to its pending record', () => {
    const unknown = new FakeContents()
    main.webContents.emit('did-attach-webview', {}, unknown)
    unknown.emit('dom-ready')
    expect(unknown.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  })

  it('rejects host protocol calls from unknown senders and ignores another host failures', async () => {
    const creation = manager.create('trusted', false)
    const [page] = manager.ready(main.webContents as never)
    const rejected = expect(creation).rejects.toThrow('closed')
    expect(() => manager.ready(new FakeContents() as never)).toThrow('Unrecognized browser host')
    manager.failed(new FakeContents() as never, { id: page.id, token: page.token, error: 'foreign request' })
    expect(manager.ready(main.webContents as never)).toHaveLength(1)
    manager.destroy(page.id)
    await rejected
  })
})

describe('browser attachment lifecycle', () => {
  it('accepts frame readiness only from the allocated host and current page and capture tokens', async () => {
    const creation = manager.create('capture-page', false)
    const [page] = manager.ready(main.webContents as never)
    const guest = attach(main, page).guest
    await creation
    let prepared = false
    const preparing = manager.prepareFrames(guest as never).then(release => { prepared = true; return release })
    const current = manager.ready(main.webContents as never)[0]
    const ready = { id: current.id, token: current.token, frameLeaseId: current.frameLeaseId! }
    expect(ready.frameLeaseId).toBeTruthy()
    manager.framesReady(new FakeContents() as never, ready)
    manager.framesReady(main.webContents as never, { ...ready, token: 'foreign-token' })
    manager.framesReady(main.webContents as never, { ...ready, frameLeaseId: 'stale-capture' })
    await Promise.resolve()
    expect(prepared).toBe(false)
    manager.framesReady(main.webContents as never, ready)
    const release = await preparing
    expect(main.webContents.throttling).toBe(false)
    release()
    release()
    expect(main.webContents.throttling).toBe(true)
    expect(manager.ready(main.webContents as never)[0].frameLeaseId).toBeUndefined()
  })

  it('restores the host after frame preparation times out or its guest is closed', async () => {
    const creation = manager.create('capture-page', false)
    const [page] = manager.ready(main.webContents as never)
    const guest = attach(main, page).guest
    await creation
    const preparing = manager.prepareFrames(guest as never)
    const rejected = expect(preparing).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(main.webContents.throttling).toBe(true)
    expect(manager.ready(main.webContents as never)[0].frameLeaseId).toBeUndefined()
    const second = manager.prepareFrames(guest as never)
    const closed = expect(second).rejects.toThrow(/released|closed/)
    manager.destroy(page.id)
    await closed
    expect(main.webContents.throttling).toBe(true)
    expect(manager.ready(main.webContents as never)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // A page operation that cannot get frames fails in 5 s with nothing in the log,
  // so whether that happens while nobody is at the computer could not be told.
  it('logs a frame preparation that timed out, with its window state, and nothing else', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const frameTimeouts = () => warn.mock.calls.filter(([message]) => message === '[BrowserHost] Frame preparation timed out').map(([, details]) => details)
    const creation = manager.create('frames-page', false)
    const [page] = manager.ready(main.webContents as never)
    const guest = attach(main, page).guest
    await creation

    const acknowledged = manager.prepareFrames(guest as never)
    const leased = manager.ready(main.webContents as never)[0]
    manager.framesReady(main.webContents as never, { id: leased.id, token: leased.token, frameLeaseId: leased.frameLeaseId! })
    ;(await acknowledged)()
    const controller = new AbortController()
    const cancelled = manager.prepareFrames(guest as never, 5000, controller.signal).catch(() => undefined)
    controller.abort(new Error('caller ended'))
    await cancelled
    await vi.advanceTimersByTimeAsync(5000)
    expect(frameTimeouts()).toEqual([])

    main.minimized = true
    const timedOut = manager.prepareFrames(guest as never).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await timedOut as Error).message).toBe('Browser frame preparation timed out')
    expect(frameTimeouts()).toEqual([{ pageId: 'frames-page', hostId: main.webContents.id, host: 'main', window: { visible: true, minimized: true }, displayed: false }])
  })

  it('aborts preparation before readiness and ignores its ack during a new lease', async () => {
    const creation = manager.create('capture-page', false)
    const [page] = manager.ready(main.webContents as never)
    const guest = attach(main, page).guest
    await creation
    const ordinaryTimers = vi.getTimerCount()
    const controller = new AbortController()
    const preparing = manager.prepareFrames(guest as never, 5000, controller.signal)
    const cancelled = expect(preparing).rejects.toThrow('caller ended')
    const first = manager.ready(main.webContents as never)[0]
    const staleAck = { id: first.id, token: first.token, frameLeaseId: first.frameLeaseId! }
    controller.abort(new Error('caller ended'))
    await cancelled
    expect(main.webContents.throttling).toBe(true)
    expect(manager.ready(main.webContents as never)[0].frameLeaseId).toBeUndefined()
    expect(vi.getTimerCount()).toBe(ordinaryTimers)

    let ready = false
    const next = manager.prepareFrames(guest as never).then(release => { ready = true; return release })
    const current = manager.ready(main.webContents as never)[0]
    expect(current.frameLeaseId).not.toBe(staleAck.frameLeaseId)
    manager.framesReady(main.webContents as never, staleAck)
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(main.webContents.throttling).toBe(false)
    manager.framesReady(main.webContents as never, { id: current.id, token: current.token, frameLeaseId: current.frameLeaseId! })
    const release = await next
    release()
    expect(main.webContents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(ordinaryTimers)
  })

  it('does not let a closed page lease or its ack alter the replacement page generation', async () => {
    const creation = manager.create('same-page', false)
    const [page] = manager.ready(main.webContents as never)
    const guest = attach(main, page).guest
    await creation
    const preparing = manager.prepareFrames(guest as never)
    const closed = expect(preparing).rejects.toThrow(/released|closed/)
    const old = manager.ready(main.webContents as never)[0]
    manager.destroy(page.id)
    await closed

    const replacementCreation = manager.create(page.id, false)
    const [replacement] = manager.ready(main.webContents as never)
    const replacementGuest = attach(main, replacement).guest
    await replacementCreation
    const ordinaryTimers = vi.getTimerCount()
    let ready = false
    const next = manager.prepareFrames(replacementGuest as never).then(release => { ready = true; return release })
    const current = manager.ready(main.webContents as never)[0]
    manager.framesReady(main.webContents as never, { id: old.id, token: old.token, frameLeaseId: old.frameLeaseId! })
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(current.token).not.toBe(old.token)
    expect(main.webContents.throttling).toBe(false)
    manager.framesReady(main.webContents as never, { id: current.id, token: current.token, frameLeaseId: current.frameLeaseId! })
    const release = await next
    release()
    expect(manager.ready(main.webContents as never)[0].token).toBe(current.token)
    expect(main.webContents.throttling).toBe(true)
    expect(vi.getTimerCount()).toBe(ordinaryTimers)
  })

  it('shares host frame production until the last page capture ends', async () => {
    const guests: FakeContents[] = []
    for (const id of ['first-capture', 'second-capture']) {
      const creation = manager.create(id, false)
      const page = manager.ready(main.webContents as never).find(page => page.id === id)!
      guests.push(attach(main, page).guest)
      await creation
    }
    const first = manager.prepareFrames(guests[0] as never)
    const second = manager.prepareFrames(guests[1] as never)
    for (const page of manager.ready(main.webContents as never)) manager.framesReady(main.webContents as never, { id: page.id, token: page.token, frameLeaseId: page.frameLeaseId! })
    const releaseFirst = await first
    const releaseSecond = await second
    expect(main.webContents.setBackgroundThrottling.mock.calls).toEqual([[false]])
    releaseFirst()
    expect(main.webContents.throttling).toBe(false)
    releaseSecond()
    expect(main.webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
  })

  it('lends an unattended page frames from its own host, never from the main window', async () => {
    manager.ready(main.webContents as never)
    const sentToMain = main.webContents.send.mock.calls.length
    const creation = manager.create('unattended-capture', true)
    const background = windows[1]
    const [page] = manager.ready(background.webContents as never)
    const guest = attach(background, page).guest
    await creation
    const preparing = manager.prepareFrames(guest as never)
    const leased = manager.ready(background.webContents as never)[0]
    manager.framesReady(background.webContents as never, { id: leased.id, token: leased.token, frameLeaseId: leased.frameLeaseId! })
    const release = await preparing
    release()
    expect(main.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(main.webContents.send.mock.calls).toHaveLength(sentToMain)
  })

  it('deduplicates pending creation and rejects a close before attachment exactly once', async () => {
    const creation = manager.create('closing', false)
    expect(manager.create('closing', false)).toBe(creation)
    const rejected = expect(creation).rejects.toThrow('closed')
    manager.ready(main.webContents as never)
    manager.destroy('closing')
    manager.destroy('closing')
    await rejected
    expect(manager.ready(main.webContents as never)).toEqual([])
    expect(main.webContents.send.mock.calls.filter(([, command]) => command.type === 'remove')).toHaveLength(1)
  })

  it('bounds attachment time and releases its page and reporting timer on timeout', async () => {
    const creation = manager.create('timed-out', false)
    const rejected = expect(creation).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    expect(manager.ready(main.webContents as never)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases main guests on reload and keeps unattended guests on their original host', async () => {
    const mainCreation = manager.create('main-page', false)
    const [mainPage] = manager.ready(main.webContents as never)
    const mainGuest = attach(main, mainPage).guest
    await mainCreation
    const backgroundCreation = manager.create('background-page', true)
    const background = windows[1]
    const [backgroundPage] = manager.ready(background.webContents as never)
    const backgroundGuest = attach(background, backgroundPage).guest
    await backgroundCreation
    main.webContents.emit('did-start-navigation', {}, 'file:///host.html', false, true)
    expect(mainGuest.close).toHaveBeenCalledOnce()
    expect(backgroundGuest.close).not.toHaveBeenCalled()
    expect(manager.ready(main.webContents as never)).toEqual([])
    expect(manager.ready(background.webContents as never)).toHaveLength(1)
  })

  it('refuses displaying unattended guests and does not emit unchanged presentation state', async () => {
    const creation = manager.create('visible-page', false)
    const [page] = manager.ready(main.webContents as never)
    attach(main, page)
    await creation
    const bounds = { x: 20, y: 30, width: 400, height: 300 }
    expect(manager.present(page.id, bounds, true)).toBe(true)
    const count = main.webContents.send.mock.calls.length
    expect(manager.present(page.id, bounds, true)).toBe(true)
    expect(main.webContents.send.mock.calls).toHaveLength(count)
    expect(manager.isVisible(page.id)).toBe(true)
    manager.present(page.id, bounds, false)
    expect(manager.isVisible(page.id)).toBe(false)
    const backgroundCreation = manager.create('background-page', true)
    const background = windows[1]
    attach(background, manager.ready(background.webContents as never)[0])
    await backgroundCreation
    expect(manager.present('background-page', bounds, true)).toBe(false)
  })
})

// The Windows incident left only "timed out": nothing said how far an
// attachment got or what the window was doing, so the cause stayed a guess.
describe('a main window that cannot attach pages', () => {
  const timeoutReport = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.find(([message]) => message === '[BrowserHost] Guest attachment timed out')?.[1] as Record<string, unknown> | undefined

  async function timeOut(id: string, background = false): Promise<unknown> {
    const failure = manager.create(id, background).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15000)
    return failure
  }

  it('reports how far a timed-out attachment got and what its window was doing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    main.minimized = true
    await timeOut('never-delivered')
    expect(timeoutReport(warn)).toMatchObject({ pageId: 'never-delivered', host: 'main', stage: 'queued', guest: null, window: { visible: true, minimized: true } })

    warn.mockClear()
    manager.ready(main.webContents as never)
    await timeOut('never-attached')
    expect(timeoutReport(warn)).toMatchObject({ stage: 'sent', guest: null })

    warn.mockClear()
    main.visible = false
    const failure = manager.create('no-document', false).catch((error: unknown) => error)
    const page = manager.ready(main.webContents as never).find(candidate => candidate.id === 'no-document')!
    const event = { preventDefault: vi.fn() }
    main.webContents.emit('will-attach-webview', event, {}, { src: page.src, partition: 'persist:browser' })
    const guest = new FakeContents()
    main.webContents.emit('did-attach-webview', {}, guest)
    await vi.advanceTimersByTimeAsync(15000)
    await failure
    expect(timeoutReport(warn)).toMatchObject({ stage: 'did-attach', guest: { id: guest.id, pid: 0, alive: true }, window: { visible: false, minimized: true } })
  })

  it('fails with an error that lets the caller open the page elsewhere, only when the main window failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    manager.ready(main.webContents as never)
    expect(await timeOut('main-timeout')).toBeInstanceOf(MainHostAttachError)

    const failed = manager.create('renderer-failed', false).catch((error: unknown) => error)
    const page = manager.ready(main.webContents as never).find(candidate => candidate.id === 'renderer-failed')!
    manager.failed(main.webContents as never, { id: page.id, token: page.token, error: 'append failed' })
    expect(await failed).toBeInstanceOf(MainHostAttachError)

    const reloaded = manager.create('host-reloaded', false).catch((error: unknown) => error)
    main.webContents.emit('did-start-navigation', {}, 'file:///host.html', false, true)
    expect(await reloaded).toBeInstanceOf(MainHostAttachError)
    expect(await manager.create('during-recovery', false).catch((error: unknown) => error)).toBeInstanceOf(MainHostAttachError)
    manager.ready(main.webContents as never)

    // Closed by its owner, or the app quitting: not something another host should take over.
    const closed = manager.create('closed-by-owner', false).catch((error: unknown) => error)
    manager.destroy('closed-by-owner')
    expect(await closed).not.toBeInstanceOf(MainHostAttachError)
    const quitting = manager.create('window-closed', false).catch((error: unknown) => error)
    main.emit('closed')
    expect(await quitting).not.toBeInstanceOf(MainHostAttachError)
  })

  it('a hidden host timing out is not the main window failing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = await timeOut('background-timeout', true)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(MainHostAttachError)
    expect(manager.isMainHostStalled()).toBe(false)
  })

  it.each(['show', 'restore', 'focus'])('remembers a main-window timeout until the window is %s', async (event) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    manager.ready(main.webContents as never)
    await timeOut('stalled')
    expect(manager.isMainHostStalled()).toBe(true)
    await timeOut('still-stalled')
    expect(manager.isMainHostStalled()).toBe(true)
    main.emit(event)
    expect(manager.isMainHostStalled()).toBe(false)
  })

  it('stops remembering it once a page attaches there or its renderer starts over', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    manager.ready(main.webContents as never)
    await timeOut('stalled')
    const creation = manager.create('user-page', false)
    attach(main, manager.ready(main.webContents as never).find(page => page.id === 'user-page')!)
    await creation
    expect(manager.isMainHostStalled()).toBe(false)

    await timeOut('stalled-again')
    expect(manager.isMainHostStalled()).toBe(true)
    main.webContents.emit('did-start-navigation', {}, 'file:///host.html', false, true)
    manager.ready(main.webContents as never)
    expect(manager.isMainHostStalled()).toBe(false)
  })
})
