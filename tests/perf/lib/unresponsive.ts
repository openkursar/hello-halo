import type { ElectronApplication } from '@playwright/test'

/**
 * Hooks `webContents` 'unresponsive' and 'render-process-gone' in the main
 * process — the two triggers for `src/main/index.ts`'s `recoverRenderer()` —
 * so we can count how many times the OS would show Halo as "Not Responding"
 * (closest technical signal to the user's own words "顶部显示卡住") and how
 * many times the renderer outright crashed (e.g. OOM on a huge unbounded
 * DOM tree). Both matter for `valid`: 'render-process-gone' can recreate the
 * whole `BrowserWindow` (`recoverRenderer`'s `createWindow()` fallback),
 * which the reload-guard's `page.on('load')` listener may not reliably see
 * if the crash tears down the CDP session before a new 'load' fires.
 *
 * Call this only after the target window
 * actually exists — `BrowserWindow.getAllWindows()` at the moment right
 * after `launchElectronApp()` returns can be empty (main process creates the
 * window slightly later), which hooks zero windows and makes
 * `unresponsiveCount` structurally, unconditionally 0 for that scenario. Also
 * hooks `app.on('browser-window-created')` so a window opened *after* this
 * call (a scenario that opens a second window mid-run) still gets covered,
 * instead of only the ones that existed at call time.
 */
export async function installUnresponsiveTracker(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app, BrowserWindow }) => {
    const g = globalThis as { __perfUnresponsiveCount?: number; __perfCrashCount?: number; __perfHookInstalled?: boolean }
    g.__perfUnresponsiveCount = g.__perfUnresponsiveCount ?? 0
    g.__perfCrashCount = g.__perfCrashCount ?? 0

    const hook = (win: Electron.BrowserWindow) => {
      const w = win as unknown as { __perfHooked?: boolean }
      if (w.__perfHooked) return
      w.__perfHooked = true
      win.webContents.on('unresponsive', () => {
        g.__perfUnresponsiveCount = (g.__perfUnresponsiveCount ?? 0) + 1
      })
      win.webContents.on('render-process-gone', () => {
        g.__perfCrashCount = (g.__perfCrashCount ?? 0) + 1
      })
    }

    for (const win of BrowserWindow.getAllWindows()) hook(win)

    if (!g.__perfHookInstalled) {
      g.__perfHookInstalled = true
      app.on('browser-window-created', (_event, win) => hook(win))
    }
  })
}

export async function readUnresponsiveCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as { __perfUnresponsiveCount?: number }).__perfUnresponsiveCount ?? 0)
}

export async function readCrashCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as { __perfCrashCount?: number }).__perfCrashCount ?? 0)
}
