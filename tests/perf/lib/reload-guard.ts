import type { Page } from '@playwright/test'

export interface ReloadGuard {
  getReloadCount(): number
}

/**
 * `src/main/index.ts` hooks `mainWindow.on('unresponsive')` ->
 * `recoverRenderer()`, which **silently** calls `reloadIgnoringCache()` (3
 * strikes in 60s -> full app relaunch), with no user-facing warning. If a
 * scenario blocks the main thread long enough to trip that, the page gets
 * reloaded mid-measurement: our `addInitScript` buffers reset to empty, CDP
 * Nodes/JSEventListeners readings restart from zero, and the very content
 * that caused the hang gets abandoned — so the worse a scenario actually is,
 * the *better* its numbers can look. This guard is the only thing standing
 * between that and a false "looks fine" result reaching the report.
 *
 * Call this once the page's own initial load has already settled — every
 * `load` event after that point is necessarily a reload, since this SPA
 * never does a real full-page navigation during normal operation.
 */
export function installReloadGuard(window: Page): ReloadGuard {
  let count = 0
  window.on('load', () => {
    count++
  })
  return { getReloadCount: () => count }
}
