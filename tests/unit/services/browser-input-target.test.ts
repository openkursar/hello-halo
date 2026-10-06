import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserInputScope, type BrowserInputCommandSender, type BrowserInputResource } from '../../../src/main/services/browser-input/target'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}

function harness() {
  let active = true
  let destroyed = false
  const evaluate = vi.fn().mockResolvedValue({ result: { value: null } })
  const attach = vi.fn((params: Record<string, unknown>) => Promise.resolve({ sessionId: `session-${params.targetId}` }))
  const release = vi.fn().mockResolvedValue({})
  const disposeObject = vi.fn().mockResolvedValue({})
  const detach = vi.fn().mockResolvedValue({})
  const describeNode = vi.fn().mockResolvedValue({ node: { frameId: 'child', nodeName: 'IFRAME' } })
  const frameTree = vi.fn().mockResolvedValue({ frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child' } }] } })
  const targetInfo = vi.fn().mockRejectedValue(new Error('No target with given id found'))
  const createWorld = vi.fn().mockResolvedValue({ executionContextId: 42 })
  const sendCommand = vi.fn((method: string, params?: Record<string, unknown>, sessionId?: string) => {
    if (method === 'Runtime.evaluate') return evaluate(params, sessionId)
    if (method === 'Target.attachToTarget') return attach(params!)
    if (method === 'Runtime.releaseObject') return release(params, sessionId)
    if (method === 'Runtime.callFunctionOn') return disposeObject(params, sessionId)
    if (method === 'Target.detachFromTarget') return detach(params, sessionId)
    throw new Error(`Unexpected raw command: ${method}`)
  })
  const contents = Object.assign(new EventEmitter(), {
    id: 31,
    isDestroyed: vi.fn(() => destroyed),
    debugger: { sendCommand },
  })
  const sender = vi.fn((method: string, params?: Record<string, unknown>, sessionId?: string) => {
    if (method === 'DOM.describeNode') return describeNode(params, sessionId)
    if (method === 'Page.getFrameTree') return frameTree(params, sessionId)
    if (method === 'Target.getTargetInfo') return targetInfo(params, sessionId)
    if (method === 'Page.createIsolatedWorld') return createWorld(params, sessionId)
    throw new Error(`Unexpected guarded command: ${method}`)
  })
  const scope = createBrowserInputScope(contents as never, sender as BrowserInputCommandSender, () => {
    if (!active) throw new Error('page operation cancelled')
  })
  return {
    scope, contents, sender, sendCommand, evaluate, attach, release, disposeObject, detach, describeNode, frameTree, targetInfo, createWorld,
    cancel: () => { active = false },
    destroy: () => { destroyed = true; contents.emit('destroyed') },
    opaque: () => evaluate.mockResolvedValueOnce({ result: { objectId: 'opaque-frame' } }),
    oop: () => targetInfo.mockResolvedValue({ targetInfo: { targetId: 'child', type: 'iframe', parentFrameId: 'main' } }),
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('browser input focused frame scope', () => {
  it('follows shadow roots and same-origin active frames without frame-tree or target work', async () => {
    const state = harness()
    const leaf = { tagName: 'INPUT' }
    const child = { activeElement: { shadowRoot: { activeElement: leaf } } }
    const document = { activeElement: { tagName: 'IFRAME', contentDocument: child } }
    state.evaluate.mockImplementation((params: Record<string, unknown>) => {
      expect(runInNewContext(String(params.expression), { document })).toBeNull()
      return Promise.resolve({ result: { value: null } })
    })
    await expect(state.scope.resolveTarget()).resolves.toEqual({})
    expect(state.sender).not.toHaveBeenCalled()
    expect(state.attach).not.toHaveBeenCalled()
    expect(state.release).not.toHaveBeenCalled()
    await state.scope.dispose()
    expect(state.contents.listenerCount('destroyed')).toBe(0)
  })

  it('returns the actual opaque active iframe without searching sibling frames', async () => {
    const state = harness()
    const focused = { tagName: 'IFRAME', contentDocument: null, isConnected: true }
    state.evaluate.mockImplementationOnce((params: Record<string, unknown>) => {
      expect(runInNewContext(String(params.expression), { document: { activeElement: { shadowRoot: { activeElement: focused } } } })).toBe(focused)
      return Promise.resolve({ result: { objectId: 'focused-frame' } })
    })
    await expect(state.scope.resolveTarget()).resolves.toEqual({ contextId: 42 })
    expect(state.describeNode).toHaveBeenCalledWith({ objectId: 'focused-frame' }, undefined)
    expect(state.createWorld).toHaveBeenCalledWith({ frameId: 'child', worldName: 'halo-browser-input', grantUniveralAccess: false }, undefined)
    expect(state.evaluate.mock.calls[1]).toEqual([expect.objectContaining({ contextId: 42 }), undefined])
    expect(state.release).toHaveBeenCalledWith({ objectId: 'focused-frame' }, undefined)
    expect(state.disposeObject).not.toHaveBeenCalled()
    await state.scope.dispose()
  })

  it('keeps one owned OOPIF session for successive key targets and disposes it by session ID', async () => {
    const state = harness()
    state.oop()
    state.evaluate.mockImplementation((_params: unknown, sessionId?: string) => Promise.resolve({ result: sessionId ? { value: null } : { objectId: 'opaque-frame' } }))
    await expect(state.scope.resolveTarget()).resolves.toEqual({ contextId: 42, sessionId: 'session-child' })
    await expect(state.scope.resolveTarget()).resolves.toEqual({ contextId: 42, sessionId: 'session-child' })
    expect(state.attach).toHaveBeenCalledOnce()
    expect(state.attach).toHaveBeenCalledWith({ targetId: 'child', flatten: true })
    expect(state.frameTree).toHaveBeenCalledOnce()
    expect(state.targetInfo).toHaveBeenCalledOnce()
    expect(state.createWorld.mock.calls.every(([_params, sessionId]) => sessionId === 'session-child')).toBe(true)
    expect(state.detach).not.toHaveBeenCalled()
    await state.scope.dispose()
    expect(state.detach).toHaveBeenCalledWith({ sessionId: 'session-child' }, undefined)
    await state.scope.dispose()
    expect(state.detach).toHaveBeenCalledOnce()
  })

  it('enters a real OOPIF omitted from the parent frame tree', async () => {
    const state = harness()
    state.opaque()
    state.oop()
    state.frameTree.mockResolvedValue({ frameTree: { frame: { id: 'main' } } })
    await expect(state.scope.resolveTarget()).resolves.toEqual({ contextId: 42, sessionId: 'session-child' })
    expect(state.frameTree).toHaveBeenCalledOnce()
    expect(state.attach).toHaveBeenCalledOnce()
    await state.scope.dispose()
  })

  it('resolves OOPIF, local opaque and nested OOPIF edges through their owning sessions', async () => {
    const state = harness()
    state.evaluate.mockResolvedValueOnce({ result: { objectId: 'root-frame' } })
      .mockResolvedValueOnce({ result: { objectId: 'local-frame' } })
      .mockResolvedValueOnce({ result: { objectId: 'nested-frame' } })
      .mockResolvedValueOnce({ result: { value: null } })
    state.describeNode.mockResolvedValueOnce({ node: { frameId: 'child', nodeName: 'IFRAME' } })
      .mockResolvedValueOnce({ node: { frameId: 'local-child', nodeName: 'IFRAME' } })
      .mockResolvedValueOnce({ node: { frameId: 'nested-child', nodeName: 'IFRAME' } })
    state.targetInfo.mockResolvedValueOnce({ targetInfo: { targetId: 'child', type: 'iframe', parentFrameId: 'main' } })
      .mockRejectedValueOnce(new Error('No target with given id found'))
      .mockResolvedValueOnce({ targetInfo: { targetId: 'nested-child', type: 'iframe', parentFrameId: 'local-child' } })
    state.frameTree.mockResolvedValueOnce({ frameTree: { frame: { id: 'main' } } })
      .mockResolvedValueOnce({ frameTree: { frame: { id: 'child' }, childFrames: [{ frame: { id: 'local-child' } }] } })
    state.createWorld.mockResolvedValueOnce({ executionContextId: 11 }).mockResolvedValueOnce({ executionContextId: 12 })
      .mockResolvedValueOnce({ executionContextId: 13 })
    await expect(state.scope.resolveTarget()).resolves.toEqual({ contextId: 13, sessionId: 'session-nested-child' })
    expect(state.describeNode.mock.calls).toEqual([
      [{ objectId: 'root-frame' }, undefined],
      [{ objectId: 'local-frame' }, 'session-child'],
      [{ objectId: 'nested-frame' }, 'session-child'],
    ])
    expect(state.createWorld.mock.calls).toEqual([
      [{ frameId: 'child', worldName: 'halo-browser-input', grantUniveralAccess: false }, 'session-child'],
      [{ frameId: 'local-child', worldName: 'halo-browser-input', grantUniveralAccess: false }, 'session-child'],
      [{ frameId: 'nested-child', worldName: 'halo-browser-input', grantUniveralAccess: false }, 'session-nested-child'],
    ])
    expect(state.frameTree.mock.calls).toEqual([[undefined, undefined], [undefined, 'session-child']])
    expect(state.targetInfo.mock.calls).toEqual([
      [{ targetId: 'child' }, undefined], [{ targetId: 'local-child' }, 'session-child'], [{ targetId: 'nested-child' }, 'session-child'],
    ])
    expect(state.release.mock.calls).toEqual([
      [{ objectId: 'root-frame' }, undefined], [{ objectId: 'local-frame' }, 'session-child'], [{ objectId: 'nested-frame' }, 'session-child'],
    ])
    await state.scope.dispose()
    expect(state.detach.mock.calls).toEqual([[{ sessionId: 'session-child' }, undefined], [{ sessionId: 'session-nested-child' }, undefined]])
  })

  it('rejects an OOPIF whose reported parent is outside the proven guest session', async () => {
    const state = harness()
    state.opaque()
    state.targetInfo.mockResolvedValue({ targetInfo: { targetId: 'child', type: 'iframe', parentFrameId: 'foreign-parent' } })
    await expect(state.scope.resolveTarget()).rejects.toThrow('does not belong to the guest')
    expect(state.attach).not.toHaveBeenCalled()
    expect(state.createWorld).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledOnce()
    await state.scope.dispose()
  })

  it('refuses a detached opaque iframe and a remote object that is not an iframe', async () => {
    const detached = harness()
    detached.evaluate.mockImplementation((params: Record<string, unknown>) => {
      expect(() => runInNewContext(String(params.expression), { document: { activeElement: { tagName: 'IFRAME', contentDocument: null, isConnected: false } } })).toThrow('was detached')
      return Promise.resolve({ result: {}, exceptionDetails: {} })
    })
    await expect(detached.scope.resolveTarget()).rejects.toThrow('could not be resolved')
    expect(detached.sender).not.toHaveBeenCalled()
    await detached.scope.dispose()
    const state = harness()
    state.opaque()
    state.describeNode.mockResolvedValue({ node: { frameId: 'child', nodeName: 'DIV' } })
    await expect(state.scope.resolveTarget()).rejects.toThrow('no frame identity')
    expect(state.targetInfo).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledOnce()
    await state.scope.dispose()
  })

  it('rejects a frame ID outside the guest tree before opening a debugger session', async () => {
    const state = harness()
    state.opaque()
    state.describeNode.mockResolvedValue({ node: { frameId: 'foreign-page', nodeName: 'IFRAME' } })
    await expect(state.scope.resolveTarget()).rejects.toThrow('does not belong to the guest')
    expect(state.targetInfo).toHaveBeenCalledWith({ targetId: 'foreign-page' }, undefined)
    expect(state.attach).not.toHaveBeenCalled()
    expect(state.createWorld).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledWith({ objectId: 'opaque-frame' }, undefined)
    await state.scope.dispose()
  })

  it('refuses the guest main frame as an opaque child identity', async () => {
    const state = harness()
    state.opaque()
    state.describeNode.mockResolvedValue({ node: { frameId: 'main', nodeName: 'IFRAME' } })
    await expect(state.scope.resolveTarget()).rejects.toThrow('does not belong to the guest')
    expect(state.attach).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledOnce()
    await state.scope.dispose()
  })

  it('refreshes the operation frame cache only when navigation exposes a new ID', async () => {
    const state = harness()
    state.evaluate.mockResolvedValueOnce({ result: { objectId: 'old-element' } }).mockResolvedValueOnce({ result: { value: null } })
      .mockResolvedValueOnce({ result: { objectId: 'new-element' } }).mockResolvedValueOnce({ result: { value: null } })
    state.describeNode.mockResolvedValueOnce({ node: { frameId: 'old-child', nodeName: 'IFRAME' } }).mockResolvedValueOnce({ node: { frameId: 'new-child', nodeName: 'IFRAME' } })
    state.frameTree.mockResolvedValueOnce({ frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'old-child' } }] } })
      .mockResolvedValueOnce({ frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'new-child' } }] } })
    await state.scope.resolveTarget()
    await state.scope.resolveTarget()
    expect(state.frameTree).toHaveBeenCalledTimes(2)
    expect(state.createWorld.mock.calls.map(([params]) => params.frameId)).toEqual(['old-child', 'new-child'])
    expect(state.release.mock.calls.map(([params]) => params.objectId)).toEqual(['old-element', 'new-element'])
    await state.scope.dispose()
  })

  it('does not swallow debugger target failures as a local-frame fallback', async () => {
    const state = harness()
    state.opaque()
    state.targetInfo.mockRejectedValue(new Error('Target lookup is unavailable'))
    await expect(state.scope.resolveTarget()).rejects.toThrow('lookup is unavailable')
    expect(state.createWorld).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledOnce()
    await state.scope.dispose()
  })

  it('rejects a wrong target type before attachment', async () => {
    const state = harness()
    state.opaque()
    state.targetInfo.mockResolvedValue({ targetInfo: { targetId: 'child', type: 'page' } })
    await expect(state.scope.resolveTarget()).rejects.toThrow('unexpected debugger target')
    expect(state.attach).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledOnce()
    await state.scope.dispose()
  })

  it('releases both opaque handles when a malformed chain points to the same frame twice', async () => {
    const state = harness()
    state.evaluate.mockResolvedValueOnce({ result: { objectId: 'first' } }).mockResolvedValueOnce({ result: { objectId: 'second' } })
    await expect(state.scope.resolveTarget()).rejects.toThrow('chain is cyclic')
    expect(state.release.mock.calls.map(([params]) => params.objectId)).toEqual(['first', 'second'])
    expect(state.createWorld).toHaveBeenCalledOnce()
    await state.scope.dispose()
  })
})

describe('browser input scope resource cancellation', () => {
  it.each(['describe', 'tree', 'target', 'world'] as const)('stops derived frame work after cancellation during %s', async stage => {
    const state = harness()
    state.opaque()
    const callback = () => { state.cancel(); return Promise.resolve({}) }
    if (stage === 'describe') state.describeNode.mockImplementation(callback)
    if (stage === 'tree') state.frameTree.mockImplementation(callback)
    if (stage === 'target') state.targetInfo.mockImplementation(callback)
    if (stage === 'world') state.createWorld.mockImplementation(callback)
    await expect(state.scope.resolveTarget()).rejects.toThrow('page operation cancelled')
    expect(state.release).toHaveBeenCalledOnce()
    if (stage !== 'world') expect(state.createWorld).not.toHaveBeenCalled()
    expect(state.attach).not.toHaveBeenCalled()
    await state.scope.dispose()
  })

  it('detaches a late raw attachment after disposal without creating a child world', async () => {
    const state = harness()
    const response = deferred<{ sessionId: string }>()
    const attached = deferred<void>()
    state.opaque()
    state.oop()
    state.attach.mockImplementation(() => { attached.resolve(); return response.promise })
    const request = state.scope.resolveTarget()
    const rejected = expect(request).rejects.toThrow('scope was closed')
    await attached.promise
    await state.scope.dispose()
    response.resolve({ sessionId: 'late-session' })
    await rejected
    expect(state.detach).toHaveBeenCalledWith({ sessionId: 'late-session' }, undefined)
    expect(state.detach).toHaveBeenCalledOnce()
    expect(state.createWorld).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledOnce()
  })

  it('owns and detaches an attachment even if the page guard throws on its response', async () => {
    const state = harness()
    state.opaque()
    state.oop()
    state.attach.mockImplementation(() => { state.cancel(); return Promise.resolve({ sessionId: 'cancelled-session' }) })
    await expect(state.scope.resolveTarget()).rejects.toThrow('page operation cancelled')
    expect(state.detach).toHaveBeenCalledWith({ sessionId: 'cancelled-session' }, undefined)
    expect(state.createWorld).not.toHaveBeenCalled()
    await state.scope.dispose()
    expect(state.detach).toHaveBeenCalledOnce()
  })

  it('releases a late opaque object response after scope disposal without describing it', async () => {
    const state = harness()
    const response = deferred<BrowserInputResource<unknown>>()
    state.evaluate.mockReturnValue(response.promise)
    const request = state.scope.resolveTarget()
    const rejected = expect(request).rejects.toThrow('scope was closed')
    await state.scope.dispose()
    response.resolve({ result: { objectId: 'late-object' } })
    await rejected
    expect(state.release).toHaveBeenCalledWith({ objectId: 'late-object' }, undefined)
    expect(state.sender).not.toHaveBeenCalled()
  })

  it('releases the child iframe handle in its original session when nested resolution is cancelled', async () => {
    const state = harness()
    const response = deferred<BrowserInputResource<unknown>>()
    const enteredChild = deferred<void>()
    state.oop()
    state.evaluate.mockResolvedValueOnce({ result: { objectId: 'root-frame' } })
      .mockImplementationOnce((_params: unknown, sessionId?: string) => {
        expect(sessionId).toBe('session-child')
        enteredChild.resolve()
        return response.promise
      })
    const request = state.scope.resolveTarget()
    const rejected = expect(request).rejects.toThrow('scope was closed')
    await enteredChild.promise
    await state.scope.dispose()
    response.resolve({ result: { objectId: 'late-child-frame' } })
    await rejected
    expect(state.release.mock.calls).toEqual([[{ objectId: 'root-frame' }, undefined], [{ objectId: 'late-child-frame' }, 'session-child']])
    expect(state.describeNode).toHaveBeenCalledOnce()
    expect(state.detach).toHaveBeenCalledOnce()
  })

  it('releases a remote object accompanying an evaluation exception', async () => {
    const state = harness()
    state.evaluate.mockResolvedValue({ result: { objectId: 'exception-object' }, exceptionDetails: {} })
    await expect(state.scope.resolveTarget()).rejects.toThrow('could not be resolved')
    expect(state.release).toHaveBeenCalledWith({ objectId: 'exception-object' }, undefined)
    expect(state.sender).not.toHaveBeenCalled()
    await state.scope.dispose()
  })

  it('keeps session ownership after child world creation fails, until scope cleanup', async () => {
    const state = harness()
    state.opaque()
    state.oop()
    state.createWorld.mockRejectedValue(new Error('Frame navigated'))
    await expect(state.scope.resolveTarget()).rejects.toThrow('Frame navigated')
    expect(state.detach).not.toHaveBeenCalled()
    await state.scope.dispose()
    expect(state.detach).toHaveBeenCalledWith({ sessionId: 'session-child' }, undefined)
  })

  it('closes and removes listeners on WebContents destruction', async () => {
    const state = harness()
    state.opaque()
    state.oop()
    await state.scope.resolveTarget()
    state.destroy()
    await state.scope.dispose()
    await expect(state.scope.resolveTarget()).rejects.toThrow('scope was closed')
    expect(state.contents.listenerCount('destroyed')).toBe(0)
    expect(state.detach).not.toHaveBeenCalled()
  })
})

describe('browser input acknowledgement resource ownership', () => {
  it('disposes acknowledgement objects before releasing them in their original child session', async () => {
    const state = harness()
    state.evaluate.mockResolvedValue({ result: { objectId: 'ack' } })
    await state.scope.evaluateResource({ expression: 'ack preparation', contextId: 17 }, 'child-session', true)
    expect(state.evaluate).toHaveBeenCalledWith({ expression: 'ack preparation', contextId: 17 }, 'child-session')
    await state.scope.releaseResource('ack', 'child-session')
    expect(state.disposeObject).toHaveBeenCalledWith({ objectId: 'ack', functionDeclaration: 'function() { this.dispose() }' }, 'child-session')
    expect(state.release).toHaveBeenCalledWith({ objectId: 'ack' }, 'child-session')
    expect(state.disposeObject.mock.invocationCallOrder[0]).toBeLessThan(state.release.mock.invocationCallOrder[0])
    await state.scope.dispose()
    expect(state.release).toHaveBeenCalledOnce()
  })

  it('cleans a late acknowledgement with its child session after cancellation', async () => {
    const state = harness()
    const response = deferred<BrowserInputResource<unknown>>()
    state.evaluate.mockReturnValue(response.promise)
    const request = state.scope.evaluateResource({ expression: 'ack preparation' }, 'child-session', true)
    const rejected = expect(request).rejects.toThrow('page operation cancelled')
    state.cancel()
    await state.scope.dispose()
    response.resolve({ result: { objectId: 'late-ack' } })
    await rejected
    expect(state.disposeObject).toHaveBeenCalledWith({ objectId: 'late-ack', functionDeclaration: 'function() { this.dispose() }' }, 'child-session')
    expect(state.release).toHaveBeenCalledWith({ objectId: 'late-ack' }, 'child-session')
  })

  it('identifies handles by object ID and session so sibling acknowledgements cannot collide', async () => {
    const state = harness()
    state.evaluate.mockResolvedValue({ result: { objectId: 'same-id' } })
    await state.scope.evaluateResource({ expression: 'first' }, 'session-one', true)
    await state.scope.evaluateResource({ expression: 'second' }, 'session-two', true)
    await state.scope.releaseResource('same-id', 'session-one')
    await state.scope.dispose()
    expect(state.release.mock.calls).toEqual([[{ objectId: 'same-id' }, 'session-one'], [{ objectId: 'same-id' }, 'session-two']])
  })

  it('continues releasing all resources if acknowledgement disposal fails and warns only once', async () => {
    const state = harness()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.evaluate.mockResolvedValueOnce({ result: { objectId: 'first' } }).mockResolvedValueOnce({ result: { objectId: 'second' } })
    state.disposeObject.mockRejectedValue(new Error('Cleanup failed'))
    state.release.mockRejectedValue(new Error('Release failed'))
    await state.scope.evaluateResource({ expression: 'first' }, 'session', true)
    await state.scope.evaluateResource({ expression: 'second' }, 'session', true)
    await state.scope.dispose()
    expect(state.release).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledOnce()
    expect(warning.mock.calls[0][1]).toMatchObject({ contentsId: 31, resource: 'key acknowledgement' })
  })

  it('shares one in-flight disposal promise and waits for cleanup exactly once', async () => {
    const state = harness()
    const response = deferred<unknown>()
    state.evaluate.mockResolvedValue({ result: { objectId: 'ack' } })
    state.release.mockReturnValue(response.promise)
    await state.scope.evaluateResource({ expression: 'ack' }, undefined, true)
    const first = state.scope.dispose()
    const second = state.scope.dispose()
    expect(first).toBe(second)
    let finished = false
    void second.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    response.resolve({})
    await first
    expect(finished).toBe(true)
    expect(state.release).toHaveBeenCalledOnce()
  })

  it('waits for an acknowledgement release already in flight before disposing its child session', async () => {
    const state = harness()
    const disposedAck = deferred<unknown>()
    state.opaque()
    state.oop()
    await state.scope.resolveTarget()
    state.evaluate.mockResolvedValue({ result: { objectId: 'ack' } })
    await state.scope.evaluateResource({ expression: 'ack' }, 'session-child', true)
    state.disposeObject.mockReturnValue(disposedAck.promise)
    const release = state.scope.releaseResource('ack', 'session-child')
    const disposal = state.scope.dispose()
    await Promise.resolve()
    expect(state.detach).not.toHaveBeenCalled()
    disposedAck.resolve({})
    await Promise.all([release, disposal])
    expect(state.disposeObject).toHaveBeenCalledOnce()
    expect(state.release).toHaveBeenCalledTimes(2)
    expect(state.detach).toHaveBeenCalledOnce()
    expect(state.release.mock.invocationCallOrder[1]).toBeLessThan(state.detach.mock.invocationCallOrder[0])
  })

  it('treats already released objects and sessions as idempotent cleanup', async () => {
    const state = harness()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.opaque()
    state.oop()
    await state.scope.resolveTarget()
    state.evaluate.mockResolvedValue({ result: { objectId: 'ack' } })
    await state.scope.evaluateResource({ expression: 'ack' }, 'session-child', true)
    state.disposeObject.mockRejectedValue(new Error('Cannot find context with specified id'))
    state.release.mockRejectedValue(new Error('Could not find object with given id'))
    state.detach.mockRejectedValue(new Error('No session with given id'))
    await state.scope.dispose()
    expect(warning).not.toHaveBeenCalled()
    expect(state.release).toHaveBeenCalledTimes(2)
    expect(state.detach).toHaveBeenCalledOnce()
  })

  it('does not warn for a late child object whose debugger session has already been detached', async () => {
    const state = harness()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = deferred<BrowserInputResource<unknown>>()
    state.evaluate.mockReturnValue(response.promise)
    const request = state.scope.evaluateResource({ expression: 'ack' }, 'child-session', true)
    const rejected = expect(request).rejects.toThrow('scope was closed')
    await state.scope.dispose()
    state.disposeObject.mockRejectedValue(new Error('Session with given id not found.'))
    state.release.mockRejectedValue(new Error('Session with given id not found.'))
    response.resolve({ result: { objectId: 'late-ack' } })
    await rejected
    expect(state.release).toHaveBeenCalledOnce()
    expect(warning).not.toHaveBeenCalled()
  })
})
