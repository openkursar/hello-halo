import type { WebContents } from 'electron'
import { CHROME_API_SCRIPT } from './chrome-api'

const controllers = new WeakMap<WebContents, BrowserCompatibility>()
const SETUP_TIMEOUT_MS = 1500
const CLEANUP_TIMEOUT_MS = 250

interface Registration {
  generation: number
  sessionId?: string
  steps: Map<string, Promise<unknown>>
  cancel?: () => void
}

interface AttachedTarget {
  sessionId: string
  targetInfo: { type: string }
  waitingForDebugger: boolean
}

/** The compatibility layer retains Page and child-frame sessions for the page's lifetime. */
export function retainsBrowserDebugger(contents: WebContents): boolean {
  return controllers.has(contents)
}

export function ensureBrowserCompatibility(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return Promise.reject(new Error('Browser page is closed'))
  let controller = controllers.get(contents)
  if (!controller) {
    controller = new BrowserCompatibility(contents)
    controllers.set(contents, controller)
  }
  return controller.start()
}

class BrowserCompatibility {
  private ready: Promise<void> | null = null
  private disposed = false
  private generation = 0
  private root: Registration = { generation: 0, steps: new Map() }
  private readonly children = new Map<string, Registration>()
  private readonly cancellations = new Set<() => void>()
  private readonly debuggerApi: WebContents['debugger']
  private readonly webContentsId: number

  constructor(private readonly contents: WebContents) {
    this.debuggerApi = contents.debugger
    this.webContentsId = contents.id
    this.debuggerApi.on('message', this.onMessage)
    this.debuggerApi.on('detach', this.onDetach)
    contents.on('did-start-navigation', this.onNavigation)
    contents.on('devtools-closed', this.onDevToolsClosed)
    contents.once('destroyed', this.dispose)
  }

  start(): Promise<void> {
    if (this.ready) return this.ready
    if (this.disposed || this.contents.isDestroyed()) return Promise.reject(new Error('Browser page is closed'))
    const root = this.root
    const pending = this.configure(root).catch(error => {
      if (root === this.root) {
        this.ready = null
        this.report('document setup', error)
      }
    })
    this.ready = pending
    return pending
  }

  private current(registration: Registration): boolean {
    return !this.disposed && !this.contents.isDestroyed() && registration.generation === this.generation
      && (!registration.sessionId || this.children.get(registration.sessionId) === registration)
  }

  private async send(registration: Registration, method: string, params: Record<string, unknown> = {}, once = false, deadline = Date.now() + CLEANUP_TIMEOUT_MS): Promise<unknown> {
    if (!this.current(registration)) throw new Error('Browser compatibility session ended')
    if (Date.now() >= deadline) throw new Error('Browser compatibility setup timed out')
    let command = once ? registration.steps.get(method) : undefined
    if (!command) {
      command = this.debuggerApi.sendCommand(method, params, registration.sessionId)
      if (once) {
        registration.steps.set(method, command)
        void command.catch(() => {
          if (registration.steps.get(method) === command) registration.steps.delete(method)
        })
      }
    }
    const value = await new Promise((resolve, reject) => {
      const cancel = () => finish(new Error('Browser compatibility session ended'))
      const finish = (error?: unknown, result?: unknown) => {
        clearTimeout(timer)
        this.cancellations.delete(cancel)
        if (registration.cancel === cancel) registration.cancel = undefined
        if (error) reject(error)
        else resolve(result)
      }
      const timer = setTimeout(() => finish(new Error(`Browser compatibility command timed out: ${method}`)), Math.max(0, deadline - Date.now()))
      this.cancellations.add(cancel)
      registration.cancel = cancel
      command.then(result => finish(undefined, result), error => finish(error))
    })
    if (!this.current(registration)) throw new Error('Browser compatibility session ended')
    return value
  }

  private async configure(registration: Registration, childPage = false): Promise<void> {
    const deadline = Date.now() + SETUP_TIMEOUT_MS
    if (!registration.sessionId && !this.debuggerApi.isAttached()) this.debuggerApi.attach('1.3')
    await this.send(registration, 'Page.enable', {}, true, deadline)
    // Keep pending registrations across retries: a timed-out command can still succeed.
    await this.send(registration, 'Page.addScriptToEvaluateOnNewDocument', { source: CHROME_API_SCRIPT, runImmediately: true }, true, deadline)
    // Popup WebContents owns its descendants through its own controller.
    if (childPage) return
    // Filtering workers here can pause them without an attach event in Electron.
    await this.send(registration, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }, true, deadline)
  }

  private onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
    if (this.disposed) return
    if (method === 'Target.detachedFromTarget') {
      const registration = this.children.get(params.sessionId as string)
      this.children.delete(params.sessionId as string)
      registration?.cancel?.()
      return
    }
    if (method !== 'Target.attachedToTarget') return
    const target = params as unknown as AttachedTarget
    // Non-paused sessions belong to explicit input-tool attachments.
    if (!target.waitingForDebugger || this.children.has(target.sessionId)) return
    const registration = { generation: this.generation, sessionId: target.sessionId, steps: new Map<string, Promise<unknown>>() }
    this.children.set(target.sessionId, registration)
    void this.configureChild(target, registration)
  }

  private async configureChild(target: AttachedTarget, registration: Registration): Promise<void> {
    const document = ['iframe', 'page'].includes(target.targetInfo.type)
    let failure: unknown
    try {
      if (document) await this.configure(registration, target.targetInfo.type === 'page')
    } catch (error) {
      failure = error
    }
    if (!this.current(registration)) return
    let resumed = false
    try {
      await this.send(registration, 'Runtime.runIfWaitingForDebugger')
      resumed = true
    } catch (error) {
      failure ??= error
    }
    if ((!document || failure || !resumed) && this.current(registration)) {
      try {
        await this.send(this.root, 'Target.detachFromTarget', { sessionId: target.sessionId })
      } catch (error) {
        failure = new Error(`${failure instanceof Error ? failure.message : 'Child target release failed'}; debugger release did not complete`)
      } finally {
        if (this.children.get(target.sessionId) === registration) this.children.delete(target.sessionId)
      }
    }
    if (failure && registration.generation === this.generation && this.current(this.root)) this.report('child target setup/resume/release', failure)
  }

  private invalidate(): void {
    this.generation++
    this.ready = null
    this.children.clear()
    this.root = { generation: this.generation, steps: new Map() }
    for (const cancel of this.cancellations) cancel()
  }

  private onDetach = (_event: Electron.Event, reason: string): void => {
    this.invalidate()
    if (!this.disposed && !this.contents.isDestroyed() && reason !== 'target closed') {
      console.warn('[BrowserCompatibility] Debugger detached; setup will resume on navigation', { webContentsId: this.contents.id, reason })
    }
  }

  private onNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (!isMainFrame || isInPlace || this.ready || this.disposed) return
    void this.start().catch(() => { /* start reports the failed recovery. */ })
  }

  private onDevToolsClosed = (): void => {
    if (!this.ready && !this.disposed) void this.start().catch(() => { /* start reports the failed recovery. */ })
  }

  private report(stage: string, error: unknown): void {
    if (this.disposed || this.contents.isDestroyed()) return
    console.warn('[BrowserCompatibility] Installation failed', {
      webContentsId: this.contents.id,
      stage,
      error: describeError(error),
    })
  }

  private dispose = (): void => {
    this.disposed = true
    this.invalidate()
    this.debuggerApi.removeListener('message', this.onMessage)
    this.debuggerApi.removeListener('detach', this.onDetach)
    this.contents.removeListener('did-start-navigation', this.onNavigation)
    this.contents.removeListener('devtools-closed', this.onDevToolsClosed)
    controllers.delete(this.contents)
    this.releaseDebugger()
  }

  // The page's DevTools host holds an attached debugger by raw pointer, and a webview guest's
  // WebContents is destroyed before its host removes the frame. A debugger left attached can be
  // collected in between, and the frame teardown then crashes the main process.
  private releaseDebugger(): void {
    try {
      if (this.debuggerApi.isAttached()) this.debuggerApi.detach()
    } catch (error) {
      console.warn('[BrowserCompatibility] Debugger release failed at page destruction', {
        webContentsId: this.webContentsId,
        error: describeError(error),
      })
    }
  }
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/gi, '[URL redacted]')
}
