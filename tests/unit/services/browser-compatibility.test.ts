import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { ensureBrowserCompatibility, retainsBrowserDebugger } from '../../../src/main/services/browser-compatibility'
import { CHROME_API_SCRIPT } from '../../../src/main/services/browser-compatibility/chrome-api'

class Contents extends EventEmitter {
  id = 1
  destroyed = false
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: vi.fn(),
    sendCommand: vi.fn((_method: string, _params: unknown, _session?: string): Promise<unknown> => Promise.resolve({ identifier: 'script' })),
  })
  isDestroyed = () => this.destroyed
  start = () => ensureBrowserCompatibility(this as unknown as WebContents)
  close() { this.destroyed = true; this.emit('destroyed') }
  child(sessionId: string, type = 'iframe', waitingForDebugger = true) {
    this.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId, targetInfo: { type }, waitingForDebugger })
  }
}
const pages: Contents[] = []
function page() { const contents = new Contents(); pages.push(contents); return contents }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { pages.splice(0).forEach(contents => contents.close()); vi.useRealTimers(); vi.restoreAllMocks() })

it('shares setup and retries only failed steps after partial registration', async () => {
  const contents = page()
  let failed = false
  contents.debugger.sendCommand.mockImplementation(async method => {
    if (method === 'Target.setAutoAttach' && !failed) { failed = true; throw new Error('temporary') }
    return {}
  })
  const first = contents.start()
  expect(contents.start()).toBe(first)
  await expect(first).resolves.toBeUndefined()
  await contents.start()
  expect(contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1)
})

it('bounds timeout, reuses late registration and never registers twice', async () => {
  vi.useFakeTimers()
  const contents = page()
  let resolve!: (value: unknown) => void
  contents.debugger.sendCommand.mockImplementation(method => method === 'Page.addScriptToEvaluateOnNewDocument' ? new Promise(done => { resolve = done }) : Promise.resolve({}))
  const first = contents.start()
  const settled = expect(first).resolves.toBeUndefined()
  await flush()
  await vi.advanceTimersByTimeAsync(1500)
  await settled
  const retry = contents.start()
  resolve({ identifier: 'late' })
  await retry
  expect(contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('invalidates pending work immediately on detach and recovers without stale commands', async () => {
  const contents = page()
  let resolve!: (value: unknown) => void
  contents.debugger.sendCommand.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const old = contents.start()
  const rejected = expect(old).resolves.toBeUndefined()
  contents.debugger.emit('detach', {}, 'replaced')
  await rejected
  await contents.start()
  resolve({})
  await flush()
  expect(contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1)
})

it('ignores explicit input sessions and avoids duplicate popup descendant ownership', async () => {
  const contents = page()
  await contents.start()
  contents.child('input', 'iframe', false)
  contents.child('popup', 'page')
  contents.child('popup', 'page')
  await flush()
  const calls = contents.debugger.sendCommand.mock.calls
  expect(calls.filter(([, , session]) => session === 'input')).toHaveLength(0)
  expect(calls.filter(([method, , session]) => method === 'Target.setAutoAttach' && session === 'popup')).toHaveLength(0)
  expect(calls.filter(([method, , session]) => method === 'Runtime.runIfWaitingForDebugger' && session === 'popup')).toHaveLength(1)
})

it('resumes worker targets without injecting page APIs or changing their network behavior', async () => {
  const contents = page()
  await contents.start()
  contents.child('worker', 'worker')
  await flush()
  const calls = contents.debugger.sendCommand.mock.calls.filter(([, , session]) => session === 'worker')
  expect(calls.map(([method]) => method)).toEqual(['Runtime.runIfWaitingForDebugger'])
  const autoAttach = contents.debugger.sendCommand.mock.calls.find(([method]) => method === 'Target.setAutoAttach')!
  expect(autoAttach[1]).not.toHaveProperty('filter')
})

it('resumes paused children after setup failure and releases failed resumes', async () => {
  const contents = page()
  await contents.start()
  contents.debugger.sendCommand.mockImplementation(async (method, _params, session) => {
    if (session && ['Page.enable', 'Runtime.runIfWaitingForDebugger'].includes(method)) throw new Error('child failed')
    return {}
  })
  contents.child('child')
  await flush()
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'child')
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Target.detachFromTarget', { sessionId: 'child' }, undefined)
})

it('uses one total root setup budget rather than one timeout per command', async () => {
  vi.useFakeTimers()
  const contents = page()
  contents.debugger.sendCommand.mockImplementation(method => method === 'Page.enable'
    ? new Promise(resolve => setTimeout(() => resolve({}), 1000))
    : new Promise(() => {}))
  const first = contents.start()
  await vi.advanceTimersByTimeAsync(1499)
  const settled = vi.fn()
  void first.then(settled)
  await flush()
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await first
  expect(settled).toHaveBeenCalledOnce()
  expect(console.warn).toHaveBeenCalledOnce()
  expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument'])
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds child setup and cleanup and prevents late obsolete follow-on commands', async () => {
  vi.useFakeTimers()
  const contents = page()
  await contents.start()
  let complete!: (value: unknown) => void
  contents.debugger.sendCommand.mockImplementation((method, _params, session) => {
    if (method === 'Page.enable' && session) return new Promise(resolve => { complete = resolve })
    if (method === 'Runtime.runIfWaitingForDebugger' || method === 'Target.detachFromTarget') return new Promise(() => {})
    return Promise.resolve({})
  })
  contents.child('slow')
  await vi.advanceTimersByTimeAsync(1500)
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'slow')
  await vi.advanceTimersByTimeAsync(250)
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Target.detachFromTarget', { sessionId: 'slow' }, undefined)
  await vi.advanceTimersByTimeAsync(250)
  expect(console.warn).toHaveBeenCalledOnce()
  complete({})
  await flush()
  expect(contents.debugger.sendCommand.mock.calls.filter(([method, , session]) => method === 'Page.addScriptToEvaluateOnNewDocument' && session === 'slow')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels pending child setup on target detach or page destruction', async () => {
  const contents = page()
  await contents.start()
  let complete!: (value: unknown) => void
  contents.debugger.sendCommand.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  contents.child('gone')
  contents.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'gone' })
  complete({})
  await flush()
  expect(contents.debugger.sendCommand.mock.calls.filter(([, , session]) => session === 'gone')).toHaveLength(1)
  const pending = contents.start()
  contents.close()
  await pending
})

it('resolves installation failure without logging navigation credentials', async () => {
  const contents = page()
  contents.debugger.sendCommand.mockRejectedValue(new Error('Failed https://example.invalid/oauth?code=private'))
  await expect(contents.start()).resolves.toBeUndefined()
  expect(console.warn).toHaveBeenCalledOnce()
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private')
})

it('invalidates root setup on disposal without late registration', async () => {
  vi.useFakeTimers()
  const contents = page()
  let complete!: (value: unknown) => void
  contents.debugger.sendCommand.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const pending = contents.start()
  contents.close()
  await expect(pending).resolves.toBeUndefined()
  complete({})
  await flush()
  expect(contents.debugger.sendCommand).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('removes ownership and listeners at destruction', async () => {
  const contents = page()
  await contents.start()
  expect(retainsBrowserDebugger(contents as unknown as WebContents)).toBe(true)
  contents.close()
  expect(retainsBrowserDebugger(contents as unknown as WebContents)).toBe(false)
  expect(contents.debugger.listenerCount('message')).toBe(0)
  expect(contents.listenerCount('did-start-navigation')).toBe(0)
})

it('never reads the native debugger getter after WebContents destruction', async () => {
  const contents = page()
  const debuggerApi = contents.debugger
  Object.defineProperty(contents, 'debugger', { get: () => {
    if (contents.destroyed) throw new Error('Native debugger getter used after destruction')
    return debuggerApi
  } })
  await contents.start()
  expect(() => contents.close()).not.toThrow()
  expect(debuggerApi.listenerCount('message')).toBe(0)
})

it('keeps the page script self-contained after production bundling', async () => {
  const bundle = await build({
    entryPoints: ['src/main/services/browser-compatibility/chrome-api.ts'],
    absWorkingDir: process.cwd(), bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', minify: true,
  })
  const exports: Record<string, unknown> = {}
  const module = { exports }
  runInNewContext(bundle.outputFiles[0].text, { module, exports })
  const window: any = {}
  runInNewContext((module.exports as { CHROME_API_SCRIPT: string }).CHROME_API_SCRIPT, { window })
  expect(window.chrome.app.getDetails()).toBe(null)
  expect(window.chrome.csi).toBeTypeOf('function')
})

it('installs self-contained APIs with document timing and preserves native implementations', () => {
  const window: any = {}
  const performance = {
    timing: { navigationStart: 1000, responseStart: 1200, domContentLoadedEventEnd: 1500, loadEventEnd: 1800 },
    now: () => 900, timeOrigin: 1000,
    getEntriesByType: () => [{ type: 'reload', nextHopProtocol: 'h2' }],
    getEntriesByName: () => [{ startTime: 300 }],
  }
  const callbacks: Array<() => void> = []
  runInNewContext(CHROME_API_SCRIPT, { window, performance, queueMicrotask: (callback: () => void) => callbacks.push(callback) })
  const chrome = window.chrome
  expect(chrome.app.getDetails()).toBe(null)
  expect(chrome.app.getIsInstalled()).toBe(false)
  expect(chrome.app.runningState()).toBe('cannot_run')
  expect(() => chrome.app.getDetails(1)).toThrow('No matching signature')
  expect(() => chrome.app.installState('wrong')).toThrow('No matching signature')
  const callback = vi.fn()
  chrome.app.installState(callback)
  expect(callback).not.toHaveBeenCalled()
  callbacks.forEach(run => run())
  expect(callback).toHaveBeenCalledWith('not_installed')
  expect(chrome.csi()).toEqual({ startE: 1000, onloadT: 1500, pageT: 900, tran: 16 })
  expect(chrome.loadTimes()).toMatchObject({ requestTime: 1, commitLoadTime: 1.2, firstPaintTime: 1.3, navigationType: 'Reload', wasFetchedViaSpdy: true, connectionInfo: 'h2' })
  runInNewContext(CHROME_API_SCRIPT, { window, performance, queueMicrotask })
  expect(window.chrome.app).toBe(chrome.app)
  expect(window.chrome.csi).toBe(chrome.csi)
  const native = { app: {}, csi: () => 42, loadTimes: () => 43 }
  const nativeWindow = { chrome: native }
  runInNewContext(CHROME_API_SCRIPT, { window: nativeWindow })
  expect(nativeWindow.chrome).toBe(native)
  expect(native.csi()).toBe(42)
})
