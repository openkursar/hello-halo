import type { WebContents } from 'electron'

export interface BrowserInputCommandSender {
  <T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
}

export interface BrowserInputTarget {
  contextId?: number
  sessionId?: string
}

export interface BrowserInputScope {
  resolveTarget(): Promise<BrowserInputTarget>
  evaluateResource<T>(params: Record<string, unknown>, sessionId?: string, dispose?: boolean): Promise<BrowserInputResource<T>>
  releaseResource(objectId: string, sessionId?: string): Promise<void>
  dispose(): Promise<void>
}

export interface BrowserInputResource<T> {
  result: { objectId?: string; value?: T }
  exceptionDetails?: unknown
}

interface FrameTree {
  frame: { id: string }
  childFrames?: FrameTree[]
}

interface FrameMembership {
  rootId: string
  ids: Set<string>
}

interface FrameSession {
  frameId: string
  sessionId: string
  detach?: Promise<void>
}

interface RemoteHandle extends BrowserInputTarget {
  objectId: string
  frameId?: string
  dispose: boolean
  release?: Promise<void>
}

const INPUT_WORLD_NAME = 'halo-browser-input'
const OPAQUE_FOCUSED_FRAME = `(() => {
  let owner = document;
  let target = owner.activeElement;
  while (target) {
    if (target.shadowRoot?.activeElement) { target = target.shadowRoot.activeElement; continue; }
    if (target.tagName === 'IFRAME') {
      const child = target.contentDocument;
      if (!child) {
        if (!target.isConnected) throw new Error('Browser focused iframe was detached');
        return target;
      }
      owner = child;
      target = owner.activeElement;
      continue;
    }
    break;
  }
  return null;
})()`

function protocolError(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message)
}

/** Keeps child debugger sessions alive for one page operation's input sequence. */
export function createBrowserInputScope(
  contents: WebContents,
  sender: BrowserInputCommandSender,
  assertActive: () => void
): BrowserInputScope {
  let closed = false
  let cleanupWarning = false
  const frameIds = new Map<string, FrameMembership>()
  let disposeResult: Promise<void> | undefined
  const sessions = new Map<string, FrameSession>()
  const attaching = new Map<string, Promise<FrameSession>>()
  const handles = new Map<string, RemoteHandle>()
  const resourceKey = (objectId: string, sessionId?: string) => `${sessionId ?? ''}\0${objectId}`

  const checkActive = () => {
    assertActive()
    if (closed || contents.isDestroyed()) throw new Error('Browser input scope was closed')
  }

  const warnCleanup = (resource: string, frameId: string | undefined, error: unknown) => {
    if (cleanupWarning || contents.isDestroyed()) return
    cleanupWarning = true
    console.warn('[BrowserInput] Failed to release input frame resource', { contentsId: contents.id, frameId, resource }, error)
  }

  const releaseHandle = async (handle: RemoteHandle): Promise<void> => {
    if (handle.release) return handle.release
    const key = resourceKey(handle.objectId, handle.sessionId)
    if (handles.get(key) !== handle) return
    handle.release = (async () => {
      try {
        if (contents.isDestroyed()) return
        if (handle.dispose) {
          try {
            await contents.debugger.sendCommand('Runtime.callFunctionOn', {
              objectId: handle.objectId, functionDeclaration: 'function() { this.dispose() }',
            }, handle.sessionId)
          } catch (error) {
            if (!protocolError(error, /(?:Could not find object with given id|Cannot find context with specified id|Execution context was destroyed|Session with given id not found|No session with given id)/i)) {
              warnCleanup('key acknowledgement', handle.frameId, error)
            }
          }
        }
        try {
          await contents.debugger.sendCommand('Runtime.releaseObject', { objectId: handle.objectId }, handle.sessionId)
        } catch (error) {
          if (!protocolError(error, /(?:Could not find object with given id|Cannot find context with specified id|Execution context was destroyed|Session with given id not found|No session with given id)/i)) {
            warnCleanup('remote object', handle.frameId, error)
          }
        }
      } finally {
        if (handles.get(key) === handle) handles.delete(key)
      }
    })()
    return handle.release
  }

  const releaseResource = async (objectId: string, sessionId?: string): Promise<void> => {
    const handle = handles.get(resourceKey(objectId, sessionId))
    if (handle) await releaseHandle(handle)
  }

  const evaluateResource = async <T>(
    params: Record<string, unknown>,
    sessionId?: string,
    dispose = false
  ): Promise<BrowserInputResource<T>> => {
    checkActive()
    // Own returned handles before cancellation checks, including responses after scope disposal.
    const response = await contents.debugger.sendCommand('Runtime.evaluate', params, sessionId)
      .then(async (result: BrowserInputResource<T>) => {
        const handle = result.result.objectId ? { objectId: result.result.objectId, sessionId, dispose } : undefined
        if (handle) handles.set(resourceKey(handle.objectId, sessionId), handle)
        try {
          checkActive()
        } catch (error) {
          if (handle) await releaseHandle(handle)
          throw error
        }
        return result
      })
    try {
      checkActive()
    } catch (error) {
      if (response.result.objectId) await releaseResource(response.result.objectId, sessionId)
      throw error
    }
    return response
  }

  const detachSession = async (session: FrameSession): Promise<void> => {
    if (session.detach) return session.detach
    if (sessions.get(session.frameId) !== session) return
    session.detach = (async () => {
      try {
        if (contents.isDestroyed()) return
        try {
          await contents.debugger.sendCommand('Target.detachFromTarget', { sessionId: session.sessionId })
        } catch (error) {
          if (!protocolError(error, /(?:No session with given id|Session with given id not found|Session not found|Invalid session id)/i)) {
            warnCleanup('child session', session.frameId, error)
          }
        }
      } finally {
        if (sessions.get(session.frameId) === session) sessions.delete(session.frameId)
      }
    })()
    return session.detach
  }

  const send: BrowserInputCommandSender = async <T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> => {
    checkActive()
    const result = await sender<T>(method, params, sessionId)
    checkActive()
    return result
  }

  const refreshFrames = async (sessionId?: string) => {
    const { frameTree } = await send<{ frameTree: FrameTree }>('Page.getFrameTree', undefined, sessionId)
    checkActive()
    const next = new Set<string>([frameTree.frame.id])
    const pending = [...(frameTree.childFrames ?? [])]
    while (pending.length) {
      const frame = pending.pop()!
      next.add(frame.frame.id)
      pending.push(...(frame.childFrames ?? []))
    }
    frameIds.set(sessionId ?? '', { rootId: frameTree.frame.id, ids: next })
  }

  const requireGuestFrame = async (frameId: string, sessionId?: string, parent = false) => {
    let membership = frameIds.get(sessionId ?? '')
    if (!membership || !membership.ids.has(frameId)) {
      await refreshFrames(sessionId)
      membership = frameIds.get(sessionId ?? '')
    }
    checkActive()
    if (!membership!.ids.has(frameId) || (!parent && membership!.rootId === frameId)) {
      throw new Error('Browser focused frame does not belong to the guest page')
    }
  }

  const attachFrame = async (frameId: string): Promise<FrameSession> => {
    checkActive()
    const existing = sessions.get(frameId)
    if (existing) return existing
    let pending = attaching.get(frameId)
    if (!pending) {
      // Register raw attach results before the caller's guard can discard a late session ID.
      pending = contents.debugger.sendCommand('Target.attachToTarget', { targetId: frameId, flatten: true })
        .then(async (response: { sessionId?: string }) => {
          if (!response.sessionId) throw new Error('Browser child frame attachment returned no session')
          const session = { frameId, sessionId: response.sessionId }
          sessions.set(frameId, session)
          try {
            checkActive()
          } catch (error) {
            await detachSession(session)
            throw error
          }
          return session
        })
      attaching.set(frameId, pending)
      void pending.finally(() => {
        if (attaching.get(frameId) === pending) attaching.delete(frameId)
      }).catch(() => {})
    }
    const session = await pending
    checkActive()
    return session
  }

  const frameTarget = async (frameId: string, current: BrowserInputTarget): Promise<BrowserInputTarget> => {
    let sessionId = current.sessionId
    const existing = sessions.get(frameId)
    if (existing) {
      sessionId = existing.sessionId
    } else {
      let info: { targetInfo: { targetId: string; type: string; parentFrameId?: string } } | undefined
      try {
        info = await send('Target.getTargetInfo', { targetId: frameId }, current.sessionId)
        checkActive()
      } catch (error) {
        checkActive()
        if (!protocolError(error, /No target with given id(?: found)?/i)) throw error
      }
      if (info) {
        if (info.targetInfo.targetId !== frameId || info.targetInfo.type !== 'iframe') {
          throw new Error('Browser focused frame has an unexpected debugger target')
        }
        // Chromium omits remote frames from Page.getFrameTree; this real iframe node proves the child edge.
        if (info.targetInfo.parentFrameId && !sessions.has(info.targetInfo.parentFrameId)) {
          await requireGuestFrame(info.targetInfo.parentFrameId, current.sessionId, true)
          checkActive()
        }
        const session = await attachFrame(frameId)
        checkActive()
        sessionId = session.sessionId
      } else {
        await requireGuestFrame(frameId, current.sessionId)
        checkActive()
      }
    }
    const { executionContextId } = await send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId, worldName: INPUT_WORLD_NAME, grantUniveralAccess: false,
    }, sessionId)
    checkActive()
    if (!Number.isInteger(executionContextId) || executionContextId <= 0) throw new Error('Browser focused frame has no input execution context')
    return sessionId ? { contextId: executionContextId, sessionId } : { contextId: executionContextId }
  }

  const resolveTarget = async (): Promise<BrowserInputTarget> => {
    checkActive()
    let current: BrowserInputTarget = {}
    const visited = new Set<string>()
    while (true) {
      const handleSession = current.sessionId
      const response = await evaluateResource<unknown>({
        expression: OPAQUE_FOCUSED_FRAME,
        ...(current.contextId === undefined ? {} : { contextId: current.contextId }),
      }, current.sessionId)
      const objectId = response.result.objectId
      try {
        checkActive()
        if (response.exceptionDetails) throw new Error('Browser focused frame could not be resolved')
        if (!objectId) return current
        const { node } = await send<{ node: { frameId?: string; nodeName: string } }>('DOM.describeNode', { objectId }, current.sessionId)
        checkActive()
        if (!node.frameId || node.nodeName !== 'IFRAME') throw new Error('Browser focused iframe has no frame identity')
        const handle = handles.get(resourceKey(objectId, current.sessionId))
        if (handle) handle.frameId = node.frameId
        if (visited.has(node.frameId)) throw new Error('Browser focused frame chain is cyclic')
        visited.add(node.frameId)
        current = await frameTarget(node.frameId, current)
        checkActive()
      } finally {
        if (objectId) await releaseResource(objectId, handleSession)
      }
      checkActive()
    }
  }

  const dispose = (): Promise<void> => {
    if (disposeResult) return disposeResult
    closed = true
    contents.removeListener('destroyed', onDestroyed)
    frameIds.clear()
    attaching.clear()
    disposeResult = (async () => {
      await Promise.all(Array.from(handles.values(), releaseHandle))
      await Promise.all(Array.from(sessions.values(), detachSession))
    })()
    return disposeResult
  }
  const onDestroyed = () => { void dispose() }
  contents.once('destroyed', onDestroyed)
  return { resolveTarget, evaluateResource, releaseResource, dispose }
}
