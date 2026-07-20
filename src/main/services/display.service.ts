/**
 * Display scale — a persistent UI zoom the user controls from both the View menu
 * (Cmd/Ctrl +, -, 0) and Settings → Appearance. Stored in
 * config.appearance.displayScale and applied via webContents.setZoomFactor on
 * window load and on every change, so the choice survives restarts.
 *
 * Exists because the default Electron zoom roles are ephemeral (reset on
 * restart) and the `zoomOut` role's Cmd+- accelerator is unreliable on macOS.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { getConfig, saveConfig } from '../foundation/config.service'
import { DISPLAY_SCALE_MIN, DISPLAY_SCALE_MAX, DISPLAY_SCALE_STEP } from '../../shared/constants'

const MIN = DISPLAY_SCALE_MIN
const MAX = DISPLAY_SCALE_MAX
export const DISPLAY_STEP = DISPLAY_SCALE_STEP

const clamp = (f: number): number => {
  const n = Number(f)
  if (!Number.isFinite(n)) return 1
  return Math.max(MIN, Math.min(MAX, Math.round(n * 100) / 100))
}

// Cached so repeated nudges (held Cmd+-) don't re-read/decrypt config from disk
// each keystroke and accumulate off a stale value.
let currentScale: number | null = null

export function currentDisplayScale(): number {
  if (currentScale === null) {
    const s = getConfig().appearance.displayScale
    currentScale = typeof s === 'number' ? clamp(s) : 1
  }
  return currentScale
}

/** Apply the saved scale to a window without persisting — call on window load. */
export function applyDisplayScale(win: BrowserWindow): void {
  win.webContents.setZoomFactor(currentDisplayScale())
}

/** Set the scale, apply it, and persist + broadcast only on a real change. */
export function setDisplayScale(win: BrowserWindow | null, factor: number): number {
  const f = clamp(factor)
  win?.webContents.setZoomFactor(f)
  if (f !== currentScale) {
    currentScale = f
    saveConfig({ appearance: { displayScale: f } })
    win?.webContents.send('display:scale-changed', f)
  }
  return f
}

export function nudgeDisplayScale(win: BrowserWindow | null, delta: number): number {
  return setDisplayScale(win, currentDisplayScale() + delta)
}

/** IPC for the Settings control. `getWindow` returns the current main window. */
export function registerDisplayHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('display:get-scale', async () => ({ success: true, data: currentDisplayScale() }))
  ipcMain.handle('display:set-scale', async (_e, factor: number) => ({
    success: true,
    data: setDisplayScale(getWindow(), factor),
  }))
  console.log('[Display] Scale IPC handlers registered')
}
