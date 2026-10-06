import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ initialize: vi.fn(), create: vi.fn(), present: vi.fn(), isVisible: vi.fn(), destroy: vi.fn(), destroyAll: vi.fn() }))
const policy = vi.hoisted(() => ({ allowed: true }))
const guests = new Map<string, FakeGuest>()
const visible = new Set<string>()
let nextId = 1

class FakeGuest extends EventEmitter {
  id = nextId++
  destroyed = false
  isDestroyed = () => this.destroyed
  setUserAgent = vi.fn()
  loadURL = vi.fn().mockResolvedValue(undefined)
  reload = vi.fn()
  setWindowOpenHandler = vi.fn()
  zoom = 1
  getZoomFactor = () => this.zoom
  setZoomFactor = vi.fn((value: number) => { this.zoom = value })
  debugger = { isAttached: vi.fn(() => false), attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn().mockResolvedValue({}) }
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => 0, removeEntryAtIndex: vi.fn() }
  close() { this.destroyed = true; this.emit('destroyed') }
}

class FakeWindow extends EventEmitter {
  webContents = { send: vi.fn(), getZoomFactor: () => 1, isDestroyed: () => false }
  isDestroyed = () => false
}

vi.mock('electron', () => ({ BrowserWindow: FakeWindow }))
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
