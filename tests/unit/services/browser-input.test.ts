import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchBrowserKeyboard, dispatchBrowserText, type BrowserInputCommandSender, type BrowserInputScope } from '../../../src/main/services/browser-input'

const clipboard = vi.hoisted(() => ({ readText: vi.fn(() => ''), readHTML: vi.fn(() => ''), readImage: vi.fn(() => ({ isEmpty: () => true })) }))
vi.mock('electron', () => ({ clipboard }))

function guest() {
  return {
    id: 23,
    isDestroyed: vi.fn(() => false),
    insertText: vi.fn().mockResolvedValue(undefined),
    sendInputEvent: vi.fn(),
    debugger: { sendCommand: vi.fn().mockResolvedValue({}) },
  }
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' }) })
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); vi.restoreAllMocks() })

describe('guest native keyboard routing', () => {
  it('inserts complete Unicode directly into the guest for character events', async () => {
    const contents = guest()
    await dispatchBrowserKeyboard(contents as never, { type: 'char', text: '中文𠮷🙂' })
    expect(contents.insertText.mock.calls).toEqual([['中文𠮷🙂']])
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('translates native arrow names and modifier masks without sending text', async () => {
    const contents = guest()
    await dispatchBrowserKeyboard(contents as never, { type: 'rawKeyDown', key: 'ArrowLeft', modifiers: 15 })
    await dispatchBrowserKeyboard(contents as never, { type: 'keyUp', key: 'ArrowLeft', modifiers: 15 })
    expect(contents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: 'Left', modifiers: ['alt', 'control', 'meta', 'shift'] },
      { type: 'keyUp', keyCode: 'Left', modifiers: ['alt', 'control', 'meta', 'shift'] },
    ])
    expect(contents.insertText).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('sends Enter down, native return character and up exactly once', async () => {
    const contents = guest()
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'Enter' })
    await dispatchBrowserKeyboard(contents as never, { type: 'keyUp', key: 'Enter' })
    expect(contents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: 'Enter', modifiers: [] },
      { type: 'char', keyCode: '\r', modifiers: [] },
      { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
    ])
  })

  it('keeps Linux control shortcuts on the guest native path', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
    const contents = guest()
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 })
    expect(contents.sendInputEvent.mock.calls).toEqual([[{ type: 'keyDown', keyCode: 'a', modifiers: ['control'] }]])
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('rejects incomplete or unsupported events before sending native input', async () => {
    const contents = guest()
    await expect(dispatchBrowserKeyboard(contents as never, { type: 'keyDown' })).rejects.toThrow('requires a key')
    await expect(dispatchBrowserKeyboard(contents as never, { type: 'mouseDown', key: 'a' })).rejects.toThrow('Unsupported')
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
  })

  it('accounts for Electron implicit Shift punctuation and never turns function-key names into text', async () => {
    const contents = guest()
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: '%', code: 'Key%', text: '%' })
    await dispatchBrowserKeyboard(contents as never, { type: 'keyUp', key: '%' })
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'F1', code: 'F1', text: 'F1' })
    expect(contents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: '%', modifiers: ['shift'] },
      { type: 'char', keyCode: '%', modifiers: ['shift'] },
      { type: 'keyUp', keyCode: '%', modifiers: ['shift'] },
      { type: 'keyDown', keyCode: 'F1', modifiers: [] },
    ])
  })
})

describe('macOS guest editing defaults', () => {
  function sender(prevented: boolean) {
    return vi.fn().mockResolvedValueOnce({ result: { objectId: 'key-ack' } }).mockResolvedValueOnce({ result: { value: prevented } }).mockResolvedValue({ result: {} })
  }

  it('waits for the trusted key acknowledgement and suppresses a page-cancelled command', async () => {
    const contents = guest()
    const send = sender(true)
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }, send as BrowserInputCommandSender)
    expect(contents.sendInputEvent.mock.calls).toEqual([[{ type: 'keyDown', keyCode: 'a', modifiers: ['meta'] }]])
    expect(send.mock.calls.map(([method]) => method)).toEqual(['Runtime.evaluate', 'Runtime.callFunctionOn'])
    expect(send.mock.calls[1][1]).toMatchObject({ objectId: 'key-ack', awaitPromise: true })
    await Promise.resolve()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.callFunctionOn', 'Runtime.releaseObject'])
  })

  it('runs the guest editing command only after the page permits its native key', async () => {
    const contents = guest()
    const send = sender(false)
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 4 }, send as BrowserInputCommandSender)
    expect(send.mock.calls[2][0]).toBe('Runtime.evaluate')
    expect(send.mock.calls[2][1]).toMatchObject({ userGesture: true, returnByValue: true })
    expect(send.mock.calls[2][1].expression).toMatch(/\.owner\.execCommand\("copy"\)$/)
    expect(contents.insertText).not.toHaveBeenCalled()
  })

  it('maps the macOS redo combination without adding character input', async () => {
    const contents = guest()
    const send = sender(false)
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 12 }, send as BrowserInputCommandSender)
    expect(send.mock.calls[2][1].expression).toMatch(/\.owner\.execCommand\("redo"\)$/)
    expect(contents.sendInputEvent).toHaveBeenCalledOnce()
  })

  it('cannot issue a late editing command after the guarded acknowledgement is cancelled', async () => {
    const contents = guest()
    let nativeSent!: () => void
    const sent = new Promise<void>(resolve => { nativeSent = resolve })
    contents.sendInputEvent.mockImplementationOnce(() => nativeSent())
    let rejectAcknowledgement!: (reason: Error) => void
    const acknowledgement = new Promise((_resolve, reject) => { rejectAcknowledgement = reject })
    const send = vi.fn().mockResolvedValueOnce({ result: { objectId: 'key-ack' } }).mockReturnValueOnce(acknowledgement)
    const request = dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4 }, send as BrowserInputCommandSender)
    const rejected = expect(request).rejects.toThrow('context ended')
    await sent
    expect(contents.sendInputEvent).toHaveBeenCalledOnce()
    rejectAcknowledgement(new Error('context ended'))
    await rejected
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
    expect(contents.insertText).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.callFunctionOn', 'Runtime.releaseObject'])
  })

  it('does not dispatch a native key when its guarded preparation was cancelled', async () => {
    const contents = guest()
    const send = vi.fn().mockRejectedValueOnce(new Error('page closed'))
    await expect(dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }, send as BrowserInputCommandSender)).rejects.toThrow('page closed')
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('rejects a late preparation response after cancellation without native dispatch and still releases its object', async () => {
    const contents = guest()
    let cancelled = false
    const error = new Error('page operation cancelled')
    const assertActive = vi.fn(() => { if (cancelled) throw error })
    let respond!: (value: { result: { objectId: string } }) => void
    const preparation = new Promise(resolve => { respond = resolve })
    const send = vi.fn().mockReturnValueOnce(preparation)
    const onDispatched = vi.fn()
    const request = dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }, send as BrowserInputCommandSender, assertActive, { onDispatched })
    const rejected = expect(request).rejects.toBe(error)
    cancelled = true
    respond({ result: { objectId: 'late-key-ack' } })
    await rejected
    await Promise.resolve()
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(onDispatched).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.callFunctionOn', 'Runtime.releaseObject'])
    expect(contents.debugger.sendCommand.mock.calls.every(([_method, params]) => params.objectId === 'late-key-ack')).toBe(true)
  })

  it('keeps a guarded key release pending until the renderer acknowledges its native keyup', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
    const contents = guest()
    let nativeSent!: () => void
    const sent = new Promise<void>(resolve => { nativeSent = resolve })
    contents.sendInputEvent.mockImplementationOnce(() => nativeSent())
    let acknowledge!: (value: { result: { value: boolean } }) => void
    const consumed = new Promise(resolve => { acknowledge = resolve })
    const send = vi.fn().mockResolvedValueOnce({ result: { objectId: 'keyup-ack' } }).mockReturnValueOnce(consumed)
    let complete = false
    const request = dispatchBrowserKeyboard(contents as never, { type: 'keyUp', key: 'Enter' }, send as BrowserInputCommandSender).then(() => { complete = true })
    await sent
    expect(complete).toBe(false)
    expect(contents.sendInputEvent.mock.calls).toEqual([[{ type: 'keyUp', keyCode: 'Enter', modifiers: [] }]])
    expect(send.mock.calls.map(([method]) => method)).toEqual(['Runtime.evaluate', 'Runtime.callFunctionOn'])
    acknowledge({ result: { value: false } })
    await request
    expect(complete).toBe(true)
    await Promise.resolve()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.callFunctionOn', 'Runtime.releaseObject'])
  })

  it('preserves the native error while releasing its prepared acknowledgement', async () => {
    const contents = guest()
    const error = new Error('native target closed')
    contents.sendInputEvent.mockImplementationOnce(() => { throw error })
    const send = sender(false)
    const onDispatched = vi.fn()
    await expect(dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }, send as BrowserInputCommandSender, () => {}, { onDispatched })).rejects.toBe(error)
    await Promise.resolve()
    expect(send).toHaveBeenCalledOnce()
    expect(onDispatched).not.toHaveBeenCalled()
    expect(contents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Runtime.callFunctionOn', 'Runtime.releaseObject'])
  })
})

describe('scoped keyboard acknowledgements', () => {
  function harness() {
    const contents = guest()
    const listeners = new Map<string, (event: Record<string, unknown>) => void>()
    const owner = {
      addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    }
    const document = { activeElement: { tagName: 'INPUT' }, defaultView: owner }
    let ack!: { promise: Promise<boolean>; dispose: () => void }
    const scope = {
      resolveTarget: vi.fn().mockResolvedValue({ contextId: 19 }),
      evaluateResource: vi.fn(async (params: { expression: string }) => {
        ack = new Function('document', `return ${params.expression}`)(document)
        return { result: { objectId: 'scoped-ack' } }
      }),
      releaseResource: vi.fn(async () => ack.dispose()),
      dispose: vi.fn(async () => ack.dispose()),
    }
    const send = vi.fn(async (method: string) => method === 'Runtime.callFunctionOn' ? { result: { value: await ack.promise } } : { result: {} })
    let posted!: () => void
    const nativePosted = new Promise<void>(resolve => { posted = resolve })
    contents.sendInputEvent.mockImplementation(() => posted())
    return {
      contents, scope, send, nativePosted, listeners,
      dispose: () => ack.dispose(),
      key: (flags: Record<string, unknown> = {}) => ({ isTrusted: true, code: 'KeyA', key: 'a', defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: true, shiftKey: false, ...flags }),
    }
  }

  it('settles a cancelled awaitPromise and releases the listener and both timers without supplying an editing default', async () => {
    vi.useFakeTimers()
    const test = harness()
    const reason = new Error('caller cancelled')
    let cancelled = false
    const guard = () => { if (cancelled) throw reason }
    const onDispatched = vi.fn()
    const request = dispatchBrowserKeyboard(test.contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }, test.send as BrowserInputCommandSender, guard, { scope: test.scope as unknown as BrowserInputScope, onDispatched })
    const rejected = expect(request).rejects.toBe(reason)
    await test.nativePosted
    expect(onDispatched).toHaveBeenCalledOnce()
    test.listeners.get('keydown')!(test.key())
    expect(vi.getTimerCount()).toBe(2)
    cancelled = true
    test.dispose()
    await rejected
    expect(test.send.mock.calls.map(([method]) => method)).toEqual(['Runtime.callFunctionOn'])
    expect(test.scope.releaseResource).toHaveBeenCalledOnce()
    expect(test.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('observes bubble cancellation after the complete event dispatch and ignores untrusted or mismatched modifiers', async () => {
    vi.useFakeTimers()
    const test = harness()
    const request = dispatchBrowserKeyboard(test.contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }, test.send as BrowserInputCommandSender, () => {}, { scope: test.scope as unknown as BrowserInputScope })
    await test.nativePosted
    const listener = test.listeners.get('keydown')!
    listener(test.key({ isTrusted: false }))
    listener(test.key({ metaKey: false, ctrlKey: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(test.listeners.size).toBe(1)
    const event = test.key()
    listener(event)
    event.defaultPrevented = true
    await vi.advanceTimersByTimeAsync(0)
    await request
    expect(test.send.mock.calls.map(([method]) => method)).toEqual(['Runtime.callFunctionOn'])
    expect(test.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('rejects a missing trusted event at the acknowledgement deadline and releases the scoped resource', async () => {
    vi.useFakeTimers()
    const test = harness()
    const request = dispatchBrowserKeyboard(test.contents as never, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 }, test.send as BrowserInputCommandSender, () => {}, { scope: test.scope as unknown as BrowserInputScope })
    const rejected = expect(request).rejects.toThrow('acknowledgement timed out')
    await test.nativePosted
    await vi.advanceTimersByTimeAsync(15000)
    await rejected
    expect(test.scope.releaseResource).toHaveBeenCalledOnce()
    expect(test.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})

describe('owned child input sessions', () => {
  it('routes complete Enter and Unicode insertion to the child session without dispatching into the main widget', async () => {
    const contents = guest()
    const scope = { resolveTarget: vi.fn().mockResolvedValue({ sessionId: 'owned-child', contextId: 23 }) } as unknown as BrowserInputScope
    const send = vi.fn().mockResolvedValue({})
    const onDispatched = vi.fn()
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'Enter', code: 'Enter' }, send as BrowserInputCommandSender, () => {}, { scope, onDispatched })
    await dispatchBrowserKeyboard(contents as never, { type: 'keyUp', key: 'Enter', code: 'Enter' }, send as BrowserInputCommandSender, () => {}, { scope, onDispatched })
    await dispatchBrowserText(contents as never, 'child 中文𠮷🙂', send as BrowserInputCommandSender, () => {}, scope)
    expect(send.mock.calls).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, commands: undefined }, 'owned-child'],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', text: undefined, windowsVirtualKeyCode: 13, commands: undefined }, 'owned-child'],
      ['Input.insertText', { text: 'child 中文𠮷🙂' }, 'owned-child'],
    ])
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(contents.insertText).not.toHaveBeenCalled()
    expect(onDispatched).not.toHaveBeenCalled()
  })

  it('supplies the native macOS command to the owned child and leaves its main-widget ledger alone', async () => {
    const contents = guest()
    const scope = { resolveTarget: vi.fn().mockResolvedValue({ sessionId: 'owned-child' }) } as unknown as BrowserInputScope
    const send = vi.fn().mockResolvedValue({})
    const onDispatched = vi.fn()
    await dispatchBrowserKeyboard(contents as never, { type: 'rawKeyDown', key: 'v', code: 'KeyV', modifiers: 4 }, send as BrowserInputCommandSender, () => {}, { scope, onDispatched })
    expect(send.mock.calls[0]).toEqual(['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', modifiers: 4, text: undefined, windowsVirtualKeyCode: 86, commands: ['paste'] }, 'owned-child'])
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
    expect(onDispatched).not.toHaveBeenCalled()
  })

  it('normalizes printable child punctuation to a physical code, VK and effective Shift flags', async () => {
    const contents = guest()
    const scope = { resolveTarget: vi.fn().mockResolvedValue({ sessionId: 'owned-child' }) } as unknown as BrowserInputScope
    const send = vi.fn().mockResolvedValue({})
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: '%', code: 'Key%', text: '%' }, send as BrowserInputCommandSender, () => {}, { scope })
    await dispatchBrowserKeyboard(contents as never, { type: 'keyDown', key: 'F1', code: 'F1', text: 'F1' }, send as BrowserInputCommandSender, () => {}, { scope })
    expect(send.mock.calls).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: '%', code: 'Digit5', text: '%', modifiers: 8, windowsVirtualKeyCode: 53, commands: undefined }, 'owned-child'],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'F1', code: 'F1', text: undefined, windowsVirtualKeyCode: 112, commands: undefined }, 'owned-child'],
    ])
  })
})
