import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'

/** Copies a fixture file into the test space's artifacts folder so it shows up in the 产物 panel on boot. */
export function seedArtifact(testConfigDir: string, fixtureAbsPath: string): { name: string; destPath: string } {
  const name = path.basename(fixtureAbsPath)
  const destDir = path.join(testConfigDir, '.halo', 'temp', 'artifacts')
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, name)
  fs.copyFileSync(fixtureAbsPath, destPath)
  return { name, destPath }
}

/**
 * Clicks the artifact card matching `name` in the 产物 panel — mirrors a real
 * user opening a file preview. `noWaitAfter` skips Playwright's own
 * post-click "wait for navigations" step: a huge file can block the renderer
 * main thread long enough that even that housekeeping round-trip stalls,
 * which would corrupt our own open-duration measurement (that stall itself
 * is exactly what `waitForCanvasLoaded` is meant to time, not an artifact of
 * how we dispatched the click).
 */
export async function clickArtifactByName(window: Page, name: string): Promise<void> {
  const card = window.getByText(name, { exact: true }).first()
  await card.waitFor({ state: 'visible', timeout: 15000 })
  await card.click({ noWaitAfter: true })
}

/**
 * WP7 harness audit P1-7: if the loading indicator never appears because
 * rendering genuinely never started (not because it was fast enough to
 * miss), the old code's `waitForSelector(..., {state:'hidden'})` on an
 * element that was never in the DOM resolves almost immediately — a broken
 * white-screen open gets reported as a suspiciously fast "instant load"
 * instead of a failure. After the indicator-based wait, we additionally
 * confirm ContentCanvas actually left its `t('No files open')` empty state;
 * if it's still showing that, nothing opened and we throw instead of
 * reporting a fake duration.
 */
async function assertCanvasHasOpenTab(window: Page): Promise<void> {
  const emptyState = await window.getByText(/No files open/i).count()
  if (emptyState > 0) {
    throw new Error('Canvas still shows "No files open" after the loading wait — the file never actually opened (not a fast load).')
  }
}

/**
 * Waits for ContentCanvas's own `t('Loading...')` indicator to appear then
 * clear — the one loading signal shared by every viewer type except
 * pdf/browser (see `waitForPdfLoaded`), so it works across S4/S5 regardless
 * of which component ends up rendering the file. Throws on timeout, or if
 * the canvas never actually left its empty state; callers that need
 * "hanging is itself a result" (S5 CSV extreme) catch it and record
 * `status: 'hung'` instead of failing.
 */
export async function waitForCanvasLoaded(window: Page, timeoutMs = 60000): Promise<void> {
  await window.waitForSelector('text=/Loading\\.\\.\\./i', { timeout: 3000 }).catch(() => {})
  await window.waitForSelector('text=/Loading\\.\\.\\./i', { state: 'hidden', timeout: timeoutMs })
  await assertCanvasHasOpenTab(window)
}

/**
 * pdf/browser tabs bypass ContentCanvas's shared "Loading..." branch — they
 * render `BrowserViewer`, whose own overlay says `t('Opening...')` until the
 * BrowserView (a separate Electron renderer process) is ready.
 */
export async function waitForPdfLoaded(window: Page, timeoutMs = 60000): Promise<void> {
  await window.waitForSelector('text=/Opening\\.\\.\\./i', { timeout: 3000 }).catch(() => {})
  await window.waitForSelector('text=/Opening\\.\\.\\./i', { state: 'hidden', timeout: timeoutMs })
  await assertCanvasHasOpenTab(window)
}
