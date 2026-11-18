import { app, BrowserWindow, WebContentsView, type HandlerDetails, type WebContents } from 'electron'
import { isUrlAllowedByPolicy } from './browser-policy.service'
import { ensureBrowserCompatibility } from './browser-compatibility'

function schemeOf(url: string): string {
  try { return new URL(url).protocol } catch { return '' }
}

export function popupTargetAllowed(target: string, opener: string): boolean {
  const scheme = schemeOf(target)
  if (scheme === 'http:' || scheme === 'https:' || target === 'about:blank') return true
  return scheme === 'file:' && schemeOf(opener) === 'file:'
}

export interface BrowserTabRequest {
  url: string
  referrer: Electron.Referrer
  background: boolean
}

interface PopupOptions {
  visible?: boolean
  openTab?: (request: BrowserTabRequest) => Promise<void>
  canOpenTab?: () => boolean
  onBlocked?: (target: string) => void
}

interface PopupBudget {
  windows: Set<BrowserWindow>
  pending: Set<WebContents>
}

const MAX_POPUPS_PER_PAGE = 6
const configured = new WeakSet<WebContents>()
const openers = new Map<number, WebContents>()

function initializeChildIdentity(_event: Electron.Event, contents: WebContents): void {
  const openerFrame = contents.opener?.top
  const opener = openerFrame ? openers.get(openerFrame.frameTreeNodeId) : undefined
  if (!opener || opener.isDestroyed()) return
  try {
    contents.setUserAgent(opener.getUserAgent())
  } catch (error) {
    console.warn('[Browser] Initial popup identity setup failed', { openerId: opener.id, errorType: error instanceof Error ? error.name : typeof error })
  }
}

export function configureBrowserPopups(opener: WebContents, options: PopupOptions = {}): void {
  attachPopups(opener, options, { windows: new Set(), pending: new Set() })
}

function ordinaryTab(details: HandlerDetails): boolean {
  return ['foreground-tab', 'background-tab'].includes(details.disposition)
    && !details.postBody && (!details.frameName || details.frameName === '_blank')
    && ['http:', 'https:'].includes(schemeOf(details.url))
}

function attachPopups(opener: WebContents, options: PopupOptions, budget: PopupBudget): void {
  if (configured.has(opener) || opener.isDestroyed()) return
  configured.add(opener)
  const frameId = opener.mainFrame.frameTreeNodeId
  if (!openers.size) app.on('web-contents-created', initializeChildIdentity)
  openers.set(frameId, opener)
  const children = new Set<BrowserWindow>()
  const pending = new Set<WebContents>()
  const visible = options.visible !== false
  const debuggerApi = opener.debugger
  let windowOpen: { url: string; noopener: boolean; timestamp: number } | undefined
  const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>, sessionId?: string) => {
    if (method !== 'Page.windowOpen' || sessionId) return
    const features = params.windowFeatures
    windowOpen = { url: String(params.url), noopener: Array.isArray(features) && features.includes('noopener'), timestamp: Date.now() }
  }
  if (options.openTab) debuggerApi.on('message', onMessage)
  const atLimit = () => budget.windows.size + budget.pending.size >= MAX_POPUPS_PER_PAGE

  opener.setWindowOpenHandler(details => {
    const { url } = details
    const nativeOpen = windowOpen
    windowOpen = undefined
    const independent = nativeOpen?.url === url && nativeOpen.noopener && Date.now() - nativeOpen.timestamp < 1000
    if (opener.isDestroyed()) return { action: 'deny' }
    if (!popupTargetAllowed(url, opener.getURL()) || !isUrlAllowedByPolicy(url)) {
      console.warn('[Browser] Popup refused by navigation policy', { openerId: opener.id, scheme: schemeOf(url) })
      options.onBlocked?.(url)
      return { action: 'deny' }
    }
    if (atLimit()) {
      console.warn('[Browser] Popup refused at the page window limit', { openerId: opener.id, limit: MAX_POPUPS_PER_PAGE })
      return { action: 'deny' }
    }
    const nativeOptions: Electron.BrowserWindowConstructorOptions = {
      show: visible,
      webPreferences: {
        session: opener.session,
        sandbox: true,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        preload: '',
      },
    }
    if (!options.openTab || (options.canOpenTab?.() ?? visible) === false || !ordinaryTab(details)) return { action: 'allow', overrideBrowserWindowOptions: nativeOptions }

    return {
      action: 'allow',
      overrideBrowserWindowOptions: nativeOptions,
      createWindow: native => {
        const nativeGuest = (native as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents
        const sandboxFlags = (native.webPreferences as Electron.WebPreferences & { openerSandboxFlags?: number } | undefined)?.openerSandboxFlags
        // Never rebuild an opener relationship or inherited HTML sandbox in a new guest.
        if ((nativeGuest && !independent) || sandboxFlags) {
          const child = new BrowserWindow(native)
          onCreated(child, { url })
          // Electron delegates no-guest GET navigation to this callback.
          if (!nativeGuest && !child.isDestroyed()) {
            void child.loadURL(url, { httpReferrer: details.referrer }).catch(error => {
              if (child.isDestroyed()) return
              console.warn('[Browser] Native popup navigation failed', { openerId: opener.id, errorType: error instanceof Error ? error.name : typeof error })
            })
          }
          return child.webContents
        }
        const handoff = new WebContentsView({ webContents: nativeGuest, webPreferences: native.webPreferences })
        const contents = handoff.webContents
        const cancelNavigation = (event: Electron.Event) => event.preventDefault()
        contents.on('will-frame-navigate', cancelNavigation)
        pending.add(contents)
        budget.pending.add(contents)
        const release = () => {
          pending.delete(contents)
          budget.pending.delete(contents)
          contents.removeListener('will-frame-navigate', cancelNavigation)
          if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
        }
        // No opener or POST is transferred; cancel the old GET before it reaches the network.
        void Promise.resolve().then(() => {
          if (opener.isDestroyed()) throw new Error('Browser opener closed before tab creation')
          return options.openTab!({ url, referrer: details.referrer, background: details.disposition === 'background-tab' })
        }).catch(error => {
          console.warn('[Browser] New tab handoff failed', { openerId: opener.id, errorType: error instanceof Error ? error.name : typeof error })
        }).finally(release)
        return contents
      },
    }
  })

  const onCreated = (child: BrowserWindow, details: { url: string }) => {
    const contents = child.webContents
    if (atLimit()) {
      console.warn('[Browser] Closing a popup beyond the page window limit', { openerId: opener.id, pageId: contents.id, limit: MAX_POPUPS_PER_PAGE })
      child.destroy()
      return
    }
    children.add(child)
    budget.windows.add(child)
    const guard = (event: Electron.Event, target: string) => {
      if (!popupTargetAllowed(target, contents.getURL() || details.url) || !isUrlAllowedByPolicy(target)) {
        event.preventDefault()
        console.warn('[Browser] Popup navigation refused by policy', { pageId: contents.id, scheme: schemeOf(target) })
        options.onBlocked?.(target)
      }
    }
    child.once('closed', () => {
      children.delete(child)
      budget.windows.delete(child)
      contents.removeListener('will-navigate', guard)
      contents.removeListener('will-redirect', guard)
    })
    try {
      // Native initial requests use the application fallback before this event.
      contents.setUserAgent(opener.getUserAgent())
      void ensureBrowserCompatibility(contents).catch(() => { /* The compatibility owner reports installation failures. */ })
      contents.on('will-navigate', guard)
      contents.on('will-redirect', guard)
      attachPopups(contents, { visible, onBlocked: options.onBlocked }, budget)
    } catch (error) {
      if (!child.isDestroyed()) child.destroy()
      console.error('[Browser] Popup setup failed', { openerId: opener.id, errorType: error instanceof Error ? error.name : typeof error })
    }
  }
  opener.on('did-create-window', onCreated)

  opener.once('destroyed', () => {
    opener.removeListener('did-create-window', onCreated)
    openers.delete(frameId)
    if (!openers.size) app.removeListener('web-contents-created', initializeChildIdentity)
    if (options.openTab) debuggerApi.removeListener('message', onMessage)
    for (const child of children) {
      if (!child.isDestroyed()) child.destroy()
    }
    for (const contents of pending) {
      budget.pending.delete(contents)
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
    }
    pending.clear()
    children.clear()
    configured.delete(opener)
  })
}
