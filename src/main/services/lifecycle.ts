/**
 * App lifecycle orchestration - the single entry point for an intentional relaunch.
 *
 * `app.exit()` terminates immediately WITHOUT firing `before-quit`, so a relaunch
 * bypasses the graceful shutdown path. A relaunch is never recorded as a clean
 * exit: the session marker keeps the reason (see foundation/session-integrity), so
 * the next launch can tell "restarted from Settings" apart from "restarted after
 * repeated failures" and neither is mistaken for a clean quit or hidden. The health
 * registry is likewise left un-cleaned, so the next launch reaps any child process
 * the exit left behind.
 */

import { app, dialog, Notification, type BrowserWindow } from 'electron'
import { recordSessionExitReason } from '../foundation/session-integrity'
import { logFatal } from '../foundation/logging'
import { getBackgroundService } from '../platform/background'
import { isServerMode } from '../foundation/runtime-mode'
import { writePreCrashSnapshot } from './perf'

/**
 * Persist the relaunch reason, then relaunch the app.
 * Does not return — the process exits.
 */
export function relaunchApp(reason: string): void {
  logFatal(`[Lifecycle] Relaunch: ${reason}`)
  recordSessionExitReason(reason)
  writePreCrashSnapshot('relaunch')
  app.relaunch()
  app.exit(0)
}

export interface AllWindowsClosedInput {
  serverMode: boolean
  platform: NodeJS.Platform
  /** A quit is already under way (user quit, update install). */
  quitting: boolean
  /** Background work (activated digital humans, running tasks) holds the process. */
  keepAlive: boolean
  /** A window exists again by the time the event arrives (renderer recovery recreated it). */
  windowRecreated: boolean
  /** A tray icon exists, so the app stays reachable with no window. */
  trayAvailable: boolean
}

/**
 * Whether closing the last window ends the process.
 *
 * Headless server mode: its only windows are incidental automation surfaces, and
 * process lifetime belongs to the signal handlers. macOS: the quit sequence, if
 * any, continues from `before-quit`. Linux: closing the window is the quit
 * (there is no close-to-tray, and a tray icon may exist yet be invisible, as on
 * GNOME without a status-icon extension), so the process never lingers there.
 * Windows: the window only vanishes without a quit when renderer recovery
 * destroyed it; background work then keeps the process alive when a tray icon
 * exists to reach it again.
 */
export function decideAllWindowsClosed(input: AllWindowsClosedInput): 'quit' | 'stay' {
  if (input.serverMode || input.platform === 'darwin') return 'stay'
  if (input.quitting) return 'quit'
  if (input.windowRecreated) return 'stay'
  if (input.platform === 'linux') return 'quit'
  return input.keepAlive && input.trayAvailable ? 'stay' : 'quit'
}

const HALTED_RELAUNCH_REASON = 'user-restart-after-renderer-halt'

/** Chinese copy for zh-* locales, English otherwise — the main-process convention. */
function isChineseLocale(): boolean {
  try {
    return app.getLocale().toLowerCase().startsWith('zh')
  } catch {
    return false
  }
}

function haltedCopy(reason: string, crashes: number) {
  return isChineseLocale()
    ? {
        title: 'Halo 窗口已停止',
        restart: '重启 Halo',
        later: '稍后',
        detail:
          `窗口在一分钟内崩溃了 ${crashes} 次（最后原因：${reason}），为避免崩溃循环已停止自动重新加载。` +
          '数字人和后台任务仍在运行。方便时请重启 Halo 以重新打开窗口。',
      }
    : {
        title: 'Halo window stopped',
        restart: 'Restart Halo',
        later: 'Later',
        detail:
          `The window crashed ${crashes} times within a minute (last reason: ${reason}), ` +
          'so Halo stopped reloading it to avoid a crash loop. Digital humans and background ' +
          'tasks keep running. Restart Halo when convenient to reopen the window.',
      }
}

let halted: ReturnType<typeof haltedCopy> | null = null
let haltedDialogOpen = false

/**
 * Tell the user the window was stopped after repeated renderer crashes, through
 * every surface that does not need the renderer: a system notification, a pinned
 * tray entry, and a dialog on the window. Only the user's choice relaunches.
 */
export function announceRendererHalted(window: BrowserWindow | null, reason: string, crashes: number): void {
  halted = haltedCopy(reason, crashes)

  getBackgroundService()?.setTrayNotice({
    message: halted.title,
    actionLabel: halted.restart,
    onAction: () => relaunchApp(HALTED_RELAUNCH_REASON),
  })

  try {
    if (Notification.isSupported()) {
      new Notification({ title: halted.title, body: halted.detail, urgency: 'critical' }).show()
    }
  } catch (error) {
    console.error('[Lifecycle] Failed to show renderer-halted notification:', error)
  }

  remindRendererHalted(window)
}

/** Re-show the halted dialog (e.g. the user brought the window back from the tray). */
export function remindRendererHalted(window: BrowserWindow | null): void {
  if (!halted || haltedDialogOpen) return
  haltedDialogOpen = true
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Halo',
    message: halted.title,
    detail: halted.detail,
    buttons: [halted.restart, halted.later],
    defaultId: 0,
    cancelId: 1,
  }
  const shown = window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options)
  shown
    .then(({ response }) => {
      haltedDialogOpen = false
      if (response === 0) relaunchApp(HALTED_RELAUNCH_REASON)
    })
    .catch((error) => {
      haltedDialogOpen = false
      console.error('[Lifecycle] Renderer-halted dialog failed:', error)
    })
}

const ERROR_DETAIL_MAX_CHARS = 2000
let errorNoticeOpen = false

/**
 * Non-blocking notice for an uncaught main-process exception. The process keeps
 * running (the error is already logged); at most one notice is on screen, and
 * errors raised while it is open are only logged.
 */
export function showUncaughtErrorNotice(error: Error): void {
  if (errorNoticeOpen || !app.isReady() || isServerMode()) return
  errorNoticeOpen = true
  const zh = isChineseLocale()
  dialog
    .showMessageBox({
      type: 'error',
      title: 'Halo',
      message: zh ? '主进程发生了意外错误' : 'An unexpected error occurred in the main process',
      detail: (error.stack || error.message || String(error)).slice(0, ERROR_DETAIL_MAX_CHARS),
      buttons: [zh ? '确定' : 'OK'],
    })
    .catch((dialogError) => console.error('[Lifecycle] Uncaught-error notice failed:', dialogError))
    .finally(() => {
      errorNoticeOpen = false
    })
}
