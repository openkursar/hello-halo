import { randomUUID } from 'crypto'
import { BrowserWindow, nativeTheme } from 'electron'
import { getMainWindow } from '../foundation/window.service'
import { loginPageBg } from './browser-login-pages'

export interface LoginWindowOptions {
  url: string
  title?: string
  timeoutMs?: number
  onEnd: (outcome: 'cancelled' | 'expired' | 'failed') => void
}

export interface LoginWindow {
  focus(): void
  close(): void
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

function loginUrl(value: string): URL | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.username || url.password) return undefined
  if (url.protocol === 'https:') return url
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (url.protocol === 'http:' && loopback) return url
}

export function openLoginWindow(options: LoginWindowOptions): LoginWindow {
  const initial = loginUrl(options.url)
  if (!initial) throw new Error('Unsafe sign-in URL')
  const parent = getMainWindow()
  const window = new BrowserWindow({
    width: 520,
    height: 680,
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
  const finish = (outcome?: Parameters<LoginWindowOptions['onEnd']>[0]) => {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    if (!window.isDestroyed()) window.destroy()
    void session.clearStorageData().catch(() => {
      console.warn('[LoginWindow] Could not clear temporary storage')
    })
    if (outcome) options.onEnd(outcome)
  }
  const timeout = setTimeout(() => finish('expired'), options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  timeout.unref?.()

  try {
    const restrictNavigation = (event: Electron.Event<{ url: string }>) => {
      if (loginUrl(event.url)?.origin === initial.origin) return
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
    window.on('page-title-updated', event => event.preventDefault())
    window.on('closed', () => finish('cancelled'))
    window.once('ready-to-show', () => {
      if (!closed && !window.isDestroyed()) window.show()
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
