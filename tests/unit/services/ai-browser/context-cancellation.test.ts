import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from '../../../../src/main/services/ai-browser'

const nativeImages = vi.hoisted(() => ({ decode: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/halo-browser-cancellation' },
  nativeImage: { createFromBuffer: nativeImages.decode },
  clipboard: {},
}))

const pages = new Map<string, TestContents>()
const destroyedListeners = new Set<(viewId: string, contentsId?: number) => void>()
const prepareFrames = vi.fn()
const releaseFrames = vi.fn()

vi.mock('../../../../src/main/services/browser-host/manager', () => ({
  browserHostManager: { prepareFrames },
}))
vi.mock('../../../../src/main/services/browser-view.service', () => ({
  browserViewManager: {
    getAllStates: () => [...pages.keys()].map(id => ({ id, url: `https://example.test/${id}`, title: id })),
    getState: (id: string) => pages.has(id) ? { id, url: `https://example.test/${id}`, title: id } : null,
    getWebContents: (id: string) => pages.get(id) ?? null,
    isRevealed: () => false,
    onViewDestroyed: (listener: (viewId: string, contentsId?: number) => void) => {
      destroyedListeners.add(listener)
      return () => destroyedListeners.delete(listener)
    },
    destroy: (id: string) => closePage(id),
  },
}))
vi.mock('../../../../src/main/services/ai-browser/download-handler', () => ({
  registerWebContentsForDownload: vi.fn(),
  unregisterWebContentsForDownload: vi.fn(),
}))
vi.mock('../../../../src/main/services/ai-browser/sdk-mcp-server', () => ({
  createAIBrowserMcpServer: vi.fn(),
}))

type Command = (params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}

function accessibilityTree(name = 'Waiting') {
  return { nodes: [{ nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, name: { value: name } }] }
}

class TestContents extends EventEmitter {
  id = 47
  destroyed = false
  throttling = true
  commands = new Map<string, Command>()
  isDestroyed = () => this.destroyed
  getBackgroundThrottling = () => this.throttling
  setBackgroundThrottling = vi.fn((value: boolean) => { this.throttling = value })
  getURL = vi.fn(() => 'https://example.test/page')
  getTitle = vi.fn(() => 'Page')
  setAudioMuted = vi.fn()
  executeJavaScript = vi.fn().mockResolvedValue(undefined)
  sendInputEvent = vi.fn()
  insertText = vi.fn().mockResolvedValue(undefined)
  capturePage = vi.fn().mockResolvedValue({ isEmpty: () => true })
  debugger = Object.assign(new EventEmitter(), {
    attach: vi.fn(),
    isAttached: () => true,
    sendCommand: vi.fn((method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
      const command = this.commands.get(method)
      if (command) return command(params, sessionId)
      if (method === 'Accessibility.getFullAXTree') return Promise.resolve(accessibilityTree())
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: false } })
      return Promise.resolve({})
    }),
  })
}

function closePage(id: string) {
  const contents = pages.get(id)
  if (!contents) return
  contents.destroyed = true
  pages.delete(id)
  contents.emit('destroyed')
  for (const listener of destroyedListeners) listener(id, contents.id)
}

const { createScopedBrowserContext } = await import('../../../../src/main/services/ai-browser')
const contexts: BrowserContext[] = []

async function harness() {
  const contents = new TestContents()
  pages.set('page', contents)
  const context = createScopedBrowserContext()
  contexts.push(context)
  context.trackView('page')
  context.setActiveViewId('page')
  await vi.advanceTimersByTimeAsync(0)
  contents.debugger.sendCommand.mockClear()
  return { context, contents }
}

function expectReleased(contents: TestContents) {
  expect(contents.listenerCount('destroyed')).toBe(0)
  expect(contents.listenerCount('did-start-navigation')).toBe(0)
  expect(contents.throttling).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  prepareFrames.mockReset().mockResolvedValue(releaseFrames)
  releaseFrames.mockReset()
  nativeImages.decode.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const context of contexts.splice(0)) context.release()
  pages.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const waits = [
  { name: 'text', method: 'Accessibility.getFullAXTree', start: (context: BrowserContext) => context.waitForText('Ready', 5000) },
  { name: 'element', method: 'Runtime.evaluate', start: (context: BrowserContext) => context.waitForElement('#ready', 5000) },
]
const releaseCommands = ['Network.disable', 'Runtime.disable', 'Page.disable']

describe('browser context cancellation', () => {
  it.each(waits)('stops the $name polling sleep immediately when its context is released', async ({ method, start }) => {
    const { context, contents } = await harness()
    const request = start(context)
    const rejected = expect(request).rejects.toThrow('released')
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.debugger.sendCommand.mock.calls.map(([command]) => command)).toEqual([method])
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    context.release()
    await rejected
    expectReleased(contents)
    expect(releaseFrames).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(contents.debugger.sendCommand.mock.calls.map(([command]) => command)).toEqual([method, ...releaseCommands])
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each(waits)('stops the $name polling sleep when the page is closed', async ({ method, start }) => {
    const { context, contents } = await harness()
    const request = start(context)
    const rejected = expect(request).rejects.toThrow(/closed|destroyed/)
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.debugger.sendCommand.mock.calls.map(([command]) => command)).toEqual([method])

    closePage('page')
    await rejected
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(context.getActiveViewId()).toBeNull()
    await vi.advanceTimersByTimeAsync(5000)
    expect(contents.debugger.sendCommand.mock.calls.map(([command]) => command)).toEqual([method])
    expect(console.warn).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledWith('[BrowserContext] No state for view: page')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('discards a late accessibility reply without deriving or publishing a snapshot', async () => {
    const { context, contents } = await harness()
    const response = deferred<unknown>()
    contents.commands.set('Accessibility.getFullAXTree', () => response.promise)
    const request = context.createSnapshot()
    const rejected = expect(request).rejects.toThrow('released')
    await vi.advanceTimersByTimeAsync(0)
    context.release()
    await rejected

    const readTree = vi.fn(() => accessibilityTree('Late result').nodes)
    response.resolve({ get nodes() { return readTree() } })
    await vi.advanceTimersByTimeAsync(0)
    expect(readTree).not.toHaveBeenCalled()
    expect(contents.getURL).not.toHaveBeenCalled()
    expect(contents.getTitle).not.toHaveBeenCalled()
    expect(context.getLastSnapshot()).toBeNull()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Accessibility.getFullAXTree', ...releaseCommands])
    expectReleased(contents)
  })

  it('discards a late screenshot reply without decoding it or requesting native capture', async () => {
    const { context, contents } = await harness()
    const response = deferred<{ data: string }>()
    contents.commands.set('Page.captureScreenshot', () => response.promise)
    const request = context.captureScreenshot()
    const rejected = expect(request).rejects.toThrow('released')
    await vi.advanceTimersByTimeAsync(0)
    context.release()
    await rejected

    response.resolve({ data: 'late-image' })
    await vi.advanceTimersByTimeAsync(0)
    expect(nativeImages.decode).not.toHaveBeenCalled()
    expect(contents.capturePage).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.captureScreenshot', ...releaseCommands])
    expectReleased(contents)
  })

  it('cancels the native screenshot retry sleep and leaves no further capture work', async () => {
    const { context, contents } = await harness()
    contents.commands.set('Page.captureScreenshot', () => Promise.reject(new Error('No compositor frame')))
    const request = context.captureScreenshot()
    const rejected = expect(request).rejects.toThrow('released')
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    context.release()
    await rejected
    expectReleased(contents)
    await vi.advanceTimersByTimeAsync(5000)
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(nativeImages.decode).not.toHaveBeenCalled()
    expect(releaseFrames).toHaveBeenCalledOnce()
  })

  it('does not send a phantom key-up when cancellation interrupts focused-frame preparation', async () => {
    const { context, contents } = await harness()
    const response = deferred<unknown>()
    contents.commands.set('Runtime.evaluate', () => response.promise)
    const request = context.pressKey('Enter')
    const rejected = expect(request).rejects.toThrow('released')
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.evaluate'])

    context.release()
    await rejected
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    response.resolve({ result: { value: null } })
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.evaluate', ...releaseCommands])
    expectReleased(contents)
  })

  it.runIf(process.platform === 'darwin')('disposes a late editing-key acknowledgement without dispatching input', async () => {
    const { context, contents } = await harness()
    const response = deferred<unknown>()
    const evaluate = vi.fn().mockResolvedValueOnce({ result: { value: null } }).mockReturnValueOnce(response.promise)
    contents.commands.set('Runtime.evaluate', evaluate)
    const request = context.pressKey('Meta+A')
    const rejected = expect(request).rejects.toThrow('released')
    await vi.advanceTimersByTimeAsync(0)
    expect(evaluate).toHaveBeenCalledTimes(2)

    context.release()
    await rejected
    response.resolve({ result: { objectId: 'late-key-ack' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand.mock.calls).toEqual([
      ['Runtime.evaluate', expect.any(Object), undefined],
      ['Runtime.evaluate', expect.any(Object), undefined],
      ['Network.disable'],
      ['Runtime.disable'],
      ['Page.disable'],
      ['Runtime.callFunctionOn', { objectId: 'late-key-ack', functionDeclaration: 'function() { this.dispose() }' }, undefined],
      ['Runtime.releaseObject', { objectId: 'late-key-ack' }, undefined],
    ])
    expectReleased(contents)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('keeps a polling operation alive after its nested snapshot completes', async () => {
    const { context, contents } = await harness()
    const readTree = vi.fn().mockResolvedValueOnce(accessibilityTree()).mockResolvedValueOnce(accessibilityTree('Ready'))
    contents.commands.set('Accessibility.getFullAXTree', readTree)
    const request = context.waitForText('Ready', 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(readTree).toHaveBeenCalledOnce()
    expect(contents.throttling).toBe(false)
    expect(releaseFrames).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    await expect(request).resolves.toBeUndefined()
    expect(readTree).toHaveBeenCalledTimes(2)
    expect(prepareFrames).toHaveBeenCalledOnce()
    expect(releaseFrames).toHaveBeenCalledOnce()
    expectReleased(contents)
  })

  it('keeps an ongoing wait on its original page when the active tab changes', async () => {
    const { context, contents } = await harness()
    const nextContents = new TestContents()
    nextContents.id = 48
    pages.set('next-page', nextContents)
    context.trackView('next-page')
    const evaluate = vi.fn().mockResolvedValueOnce({ result: { value: false } }).mockResolvedValueOnce({ result: { value: true } })
    contents.commands.set('Runtime.evaluate', evaluate)
    const request = context.waitForElement('#ready', 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(evaluate).toHaveBeenCalledOnce()

    context.setActiveViewId('next-page')
    await vi.advanceTimersByTimeAsync(0)
    nextContents.debugger.sendCommand.mockClear()
    await vi.advanceTimersByTimeAsync(500)
    await expect(request).resolves.toBeUndefined()
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(context.getActiveViewId()).toBe('next-page')
    expect(nextContents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(prepareFrames).toHaveBeenCalledOnce()
    expect(prepareFrames.mock.calls[0][0]).toBe(contents)
    expectReleased(contents)
  })

  it('cancels the original page operation after a tab switch without clearing the new active tab', async () => {
    const { context, contents } = await harness()
    const nextContents = new TestContents()
    nextContents.id = 48
    pages.set('next-page', nextContents)
    context.trackView('next-page')
    const request = context.waitForElement('#ready', 1000)
    const rejected = expect(request).rejects.toThrow(/closed|destroyed/)
    await vi.advanceTimersByTimeAsync(0)
    context.setActiveViewId('next-page')
    await vi.advanceTimersByTimeAsync(0)
    nextContents.debugger.sendCommand.mockClear()

    closePage('page')
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(context.getActiveViewId()).toBe('next-page')
    await vi.advanceTimersByTimeAsync(1000)
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.evaluate', ...releaseCommands])
    expect(nextContents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('releases the remote object of a reply that arrives after its command timed out', async () => {
    const { context, contents } = await harness()
    const response = deferred<unknown>()
    contents.commands.set('DOM.resolveNode', () => response.promise)
    const request = context.sendCDPCommand('DOM.resolveNode', { backendNodeId: 7 }, 100)
    const rejected = expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejected

    response.resolve({ object: { objectId: 'late-node' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Runtime.releaseObject', { objectId: 'late-node' }, undefined)
  })

  it('falls back to a viewport screenshot when the page cannot box the element', async () => {
    const { context, contents } = await harness()
    contents.commands.set('Accessibility.getFullAXTree', () => Promise.resolve({ nodes: [
      { nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['button'] },
      { nodeId: 'button', parentId: 'root', ignored: false, role: { value: 'button' }, name: { value: 'Hidden' }, backendDOMNodeId: 7 },
    ] }))
    await context.createSnapshot()
    const uid = [...context.getLastSnapshot()!.idToNode.values()].find(node => node.role === 'button')!.uid
    for (const method of ['DOM.resolveNode', 'DOM.getBoxModel']) {
      contents.commands.set(method, () => Promise.reject(new Error('Could not compute box model.')))
    }
    contents.commands.set('Page.captureScreenshot', () => Promise.resolve({ data: 'viewport' }))
    nativeImages.decode.mockReturnValue({ isEmpty: () => true })
    contents.debugger.sendCommand.mockClear()

    await expect(context.captureScreenshot({ uid })).resolves.toEqual({ data: 'viewport', mimeType: 'image/jpeg' })
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['DOM.resolveNode', 'DOM.getBoxModel', 'Page.captureScreenshot'])
    expect(contents.debugger.sendCommand.mock.calls[2][1]).not.toHaveProperty('clip')
    expect(console.warn).toHaveBeenCalledWith('[Snapshot] Could not scroll the element into view; continuing without it:', expect.stringContaining('DOM.resolveNode'))
  })

  it('does not treat cancellation inside an element helper as a page rejection', async () => {
    const { context, contents } = await harness()
    contents.commands.set('Accessibility.getFullAXTree', () => Promise.resolve({ nodes: [
      { nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['button'] },
      { nodeId: 'button', parentId: 'root', ignored: false, role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 7 },
    ] }))
    await context.createSnapshot()
    const uid = [...context.getLastSnapshot()!.idToNode.values()].find(node => node.role === 'button')!.uid
    const response = deferred<unknown>()
    contents.commands.set('DOM.resolveNode', () => response.promise)
    contents.debugger.sendCommand.mockClear()

    const request = context.clickElement(uid)
    const rejected = expect(request).rejects.toThrow('released')
    await vi.advanceTimersByTimeAsync(0)
    context.release()
    await rejected
    response.resolve({ object: { objectId: 'late-node' } })
    await vi.advanceTimersByTimeAsync(0)

    const methods = contents.debugger.sendCommand.mock.calls.map(([method]) => method)
    expect(methods).not.toContain('DOM.getBoxModel')
    expect(methods).not.toContain('Input.dispatchMouseEvent')
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('[Snapshot]'), expect.anything())
  })

  it('counts snapshot work against the enclosing wait deadline', async () => {
    const { context, contents } = await harness()
    const response = deferred<unknown>()
    contents.commands.set('Accessibility.getFullAXTree', () => response.promise)
    const request = context.waitForText('Ready', 750)
    const rejected = expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(700)
    response.resolve(accessibilityTree())
    await vi.advanceTimersByTimeAsync(0)
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Accessibility.getFullAXTree'])

    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expectReleased(contents)
    await vi.advanceTimersByTimeAsync(1000)
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Accessibility.getFullAXTree'])
  })
})
