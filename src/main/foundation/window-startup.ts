/**
 * How the main window looks before its page has drawn anything: the native
 * colors it starts with, and the size its first frame is drawn at.
 */

import { screen, type BrowserWindow, type Rectangle, type Size } from 'electron'

export type ThemeSetting = 'light' | 'dark' | 'system'

/**
 * globals.css `--background` (window and caption-button strip) and
 * `--foreground` (caption-button glyphs) per theme, as the literal colors the
 * native window needs. A unit test holds them to the tokens.
 */
export const THEME_WINDOW_COLORS = {
  dark: { background: '#181b20', symbol: '#e7e9ee' },
  light: { background: '#ffffff', symbol: '#181a21' },
} as const

export function startupWindowColors(
  theme: ThemeSetting | undefined,
  systemPrefersDark: boolean,
): { background: string; symbol: string } {
  const dark = theme === 'dark' || (theme !== 'light' && systemPrefersDark)
  return THEME_WINDOW_COLORS[dark ? 'dark' : 'light']
}

/** `size` centered in `area`, shrunk to fit it. */
export function centeredIn(area: Rectangle, size: Size): Rectangle {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  }
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Has the hidden window draw its first frame at the size it is revealed at.
 *
 * The window is revealed maximized on its first paint, which comes before the
 * app's code has run; right after it the page is busy starting the app and
 * cannot redraw at a new size. Maximized from the default size, the enlarged
 * window showed the small first frame: on Windows beside a white band, on
 * macOS off-center. At full size from the start, the reveal leaves the page
 * nothing to redraw.
 *
 * The full size also becomes the one the window restores to: Electron can
 * neither maximize a hidden window nor set that size, and resizing at the
 * reveal would show a default-size frame (the page draws each size it is sent).
 */
export function drawFirstFrameMaximized(win: BrowserWindow, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin' && platform !== 'win32') return
  const defaultBounds = win.getBounds()
  win.setBounds(screen.getDisplayMatching(defaultBounds).workArea)
  // As Windows reports it back, which can differ from the request by a pixel of scaling.
  const firstFrame = win.getBounds()

  // Restoring goes back to the frame the window was maximized from: on Windows
  // this same full size, on macOS (which then knows no earlier frame) a small
  // one in a corner. The first restore puts the default size back instead.
  win.once('unmaximize', () => {
    if (win.isDestroyed()) return
    const restored = win.getBounds()
    // Dragged out of maximized on Windows: placed under the pointer; leave it there.
    if (platform === 'win32' && !sameRect(restored, firstFrame)) return
    win.setBounds(centeredIn(screen.getDisplayMatching(restored).workArea, defaultBounds), true)
  })
}
