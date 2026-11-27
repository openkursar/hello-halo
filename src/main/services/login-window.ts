import { randomUUID } from 'crypto'
import { BrowserWindow, nativeTheme, screen } from 'electron'
import { getMainWindow } from '../foundation/window.service'
import { loginPageBg } from './browser-login-pages'

export interface LoginWindowOptions {
  url: string
  /** Further https origins the page may navigate the window to. */
  origins?: string[]
  title?: string
  timeoutMs?: number
  onEnd: (outcome: 'cancelled' | 'expired' | 'failed') => void
}

export interface LoginWindow {
  focus(): void
  close(): void
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
// Wide enough for an identity provider's consent page; the window then grows to each page's content.
const WIDTH = 560
const HEIGHT = 480
const MIN_HEIGHT = 360
const SCREEN_MARGIN = 24
// A page taller than the screen is scaled down to fit, but never below this.
const MIN_ZOOM = 0.85
const REFIT_MS = 300
// Pages that render after load (single-page apps) are measured again as they settle.
const FIT_DELAYS_MS = [0, 300, 1000, 2500]
// Measures layout only, away from the page's own scripts.
const FIT_WORLD = 1201
// The height the page needs, or 0 while it fits; the viewport can lag the window before it is shown.
const NEEDED_HEIGHT = '(() => { const h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0); return h > innerHeight ? h : 0 })()'

function loginUrl(value: string): URL | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.username || url.password) return undefined
  if (url.protocol === 'https:') return url
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (url.protocol === 'http:' && loopback) return url
}

function originOf(value: string): string | undefined {
  return URL.canParse(value) ? new URL(value).origin : undefined
}

export function openLoginWindow(options: LoginWindowOptions): LoginWindow {
  const initial = loginUrl(options.url)
  if (!initial) throw new Error('Unsafe sign-in URL')
  const allowed = new Set([initial.origin])
  for (const origin of options.origins ?? []) {
    const url = loginUrl(origin)
    if (url?.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && origin.replace(/\/$/, '') === url.origin) {
      allowed.add(url.origin)
    }
  }
  const parent = getMainWindow()
  const workArea = parent && !parent.isDestroyed()
    ? screen.getDisplayMatching(parent.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea
  const maxHeight = Math.max(MIN_HEIGHT, workArea.height - SCREEN_MARGIN)
  const window = new BrowserWindow({
    width: WIDTH,
    height: Math.min(HEIGHT, maxHeight),
    useContentSize: true,
    show: false,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    backgroundColor: loginPageBg(nativeTheme.shouldUseDarkColors),
    title: options.title,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      partition: `login-${randomUUID()}`,
    },
  })
  const contents = window.webContents
  const session = contents.session
  let closed = false
  let fitTimers: ReturnType<typeof setTimeout>[] = []
  const finish = (outcome?: Parameters<LoginWindowOptions['onEnd']>[0]) => {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    for (const timer of fitTimers) clearTimeout(timer)
    if (!window.isDestroyed()) window.destroy()
    void session.clearStorageData().catch(() => {
      console.warn('[LoginWindow] Could not clear temporary storage')
    })
    if (outcome) options.onEnd(outcome)
  }
  const timeout = setTimeout(() => finish('expired'), options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  timeout.unref?.()

  try {
    // Frames stay on the origin of the page that holds them.
    const restrictNavigation = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
      const target = loginUrl(event.url)
      const origins = event.isMainFrame ? allowed : new Set([originOf(contents.getURL()) ?? initial.origin])
      if (target && origins.has(target.origin)) return
      event.preventDefault()
      console.warn('[LoginWindow] Blocked navigation outside the approved origin')
    }
    contents.on('will-frame-navigate', restrictNavigation)
    contents.on('will-redirect', restrictNavigation)
    contents.setWindowOpenHandler(() => {
      console.warn('[LoginWindow] Blocked a new window')
      return { action: 'deny' }
    })
    session.setPermissionCheckHandler(() => false)
    session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
    session.on('will-download', event => {
      event.preventDefault()
      console.warn('[LoginWindow] Blocked a download')
    })
    // The window only grows and the page only shrinks, so nothing jumps back and forth.
    const fit = async () => {
      let needed: unknown
      try {
        needed = await contents.executeJavaScriptInIsolatedWorld(FIT_WORLD, [{ code: NEEDED_HEIGHT }])
      } catch {
        return
      }
      if (closed || window.isDestroyed() || typeof needed !== 'number' || !Number.isFinite(needed) || needed < 1) return
      const [width, current] = window.getContentSize()
      const frame = window.getSize()[1] - current
      const available = Math.max(MIN_HEIGHT, maxHeight - frame)
      const zoom = contents.getZoomFactor()
      const wanted = needed * zoom
      const scaled = wanted > available ? Math.max(MIN_ZOOM, Math.floor(zoom * available / wanted * 100) / 100) : zoom
      if (scaled < zoom) {
        contents.setZoomFactor(scaled)
        const timer = setTimeout(() => void fit(), REFIT_MS)
        timer.unref?.()
        fitTimers.push(timer)
      }
      const height = Math.min(available, Math.ceil(needed * Math.min(zoom, scaled)))
      if (height <= current) return
      window.setContentSize(width, height)
      const bounds = window.getBounds()
      const bottom = workArea.y + workArea.height
      if (bounds.y + bounds.height > bottom) window.setPosition(bounds.x, Math.max(workArea.y, bottom - bounds.height))
    }
    contents.on('did-stop-loading', () => {
      if (closed) return
      for (const timer of fitTimers) clearTimeout(timer)
      fitTimers = FIT_DELAYS_MS.map(delay => {
        const timer = setTimeout(() => void fit(), delay)
        timer.unref?.()
        return timer
      })
    })
    window.on('page-title-updated', event => event.preventDefault())
    window.on('closed', () => finish('cancelled'))
    // Shown at the first page's own height rather than resizing in front of the person.
    window.once('ready-to-show', () => {
      void fit().finally(() => {
        if (!closed && !window.isDestroyed()) window.show()
      })
    })
    void Promise.resolve().then(async () => {
      if (!closed) await window.loadURL(initial.href)
    }).catch(() => {
      if (closed) return
      console.warn('[LoginWindow] Could not load the sign-in page')
      finish('failed')
    })
  } catch (error) {
    finish()
    throw error
  }

  return {
    focus: () => {
      if (!closed && !window.isDestroyed()) window.focus()
    },
    close: () => finish(),
  }
}
