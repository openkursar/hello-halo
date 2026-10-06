/**
 * Capacitor Mobile Shell — Status Bar & Safe Area
 *
 * Initializes edge-to-edge display and safe-area inset variables for the
 * Capacitor build. The page renders behind the status bar; the
 * `--safe-area-inset-top` CSS variable carries the real status bar height
 * so layouts using `var(--sat)` (see `globals.css`) push content below it.
 *
 * Who writes the variable on Android (no JS polling):
 *   1. Below Android 15, the app's native SafeArea plugin, whenever a page
 *      finishes loading, the app returns to the foreground or the insets
 *      change (rotation, split screen).
 *   2. From Android 15 on, Capacitor 8's built-in SystemBars plugin.
 *   Native code writes once the page has loaded, after this module first
 *   runs, so a page that starts without the value asks for it once.
 * iOS reports env(safe-area-inset-*) itself, which the CSS falls back to.
 *
 * No-ops in Electron/Web: Capacitor checks short-circuit before any work.
 */

import { isCapacitor } from './transport'

type StatusBarStyle = 'DARK' | 'LIGHT'

const TOP_INSET = '--safe-area-inset-top'

/** The app's native SafeArea plugin (Android only). */
interface SafeAreaPlugin {
  /** `top` in CSS pixels; absent from Android 15 on, where SystemBars writes it. */
  getInsets(): Promise<{ top?: number }>
}

let _statusBarPlugin: typeof import('@capacitor/status-bar').StatusBar | null = null
let _statusBarLoadAttempted = false

async function loadStatusBar(): Promise<typeof import('@capacitor/status-bar').StatusBar | null> {
  if (_statusBarPlugin) return _statusBarPlugin
  if (_statusBarLoadAttempted) return null
  _statusBarLoadAttempted = true

  try {
    const mod = await import('@capacitor/status-bar')
    _statusBarPlugin = mod.StatusBar
    return _statusBarPlugin
  } catch (err) {
    console.warn('[SafeArea] @capacitor/status-bar unavailable:', err)
    return null
  }
}

/**
 * One-time mobile shell init. Safe to call before React mounts.
 * - Lets the layout keep clear of the system bars at any width (`globals.css`)
 * - Asks for the status bar height if the page starts without it
 * - Enables edge-to-edge (overlay WebView)
 *
 * Status bar text style (DARK/LIGHT) is intentionally NOT set here — the
 * theme effect in `App.tsx` calls `syncStatusBarStyle()` once the theme
 * config has loaded. Setting an eager default here would cause a flicker
 * for users on a different theme.
 */
export async function initCapacitorMobileShell(): Promise<void> {
  if (!isCapacitor()) return

  document.documentElement.classList.add('platform-capacitor')
  void askForMissingTopInset()

  const StatusBar = await loadStatusBar()
  if (!StatusBar) return

  try {
    await StatusBar.setOverlaysWebView({ overlay: true })
  } catch (err) {
    console.warn('[SafeArea] setOverlaysWebView failed:', err)
  }
}

/**
 * Sync status bar text style (DARK = dark text on light bg, LIGHT = light
 * text on dark bg) with the app theme. Call from the App's theme effect.
 */
export async function syncStatusBarStyle(isDark: boolean): Promise<void> {
  if (!isCapacitor()) return

  const StatusBar = await loadStatusBar()
  if (!StatusBar) return

  const style: StatusBarStyle = isDark ? 'DARK' : 'LIGHT'
  try {
    await StatusBar.setStyle({ style: style as never })
  } catch (err) {
    console.warn('[SafeArea] setStyle failed:', err)
  }
}

async function askForMissingTopInset(): Promise<void> {
  const root = document.documentElement
  if (root.style.getPropertyValue(TOP_INSET)) return
  try {
    const { Capacitor, registerPlugin } = await import('@capacitor/core')
    if (Capacitor.getPlatform() !== 'android') return
    const { top } = await registerPlugin<SafeAreaPlugin>('SafeArea').getInsets()
    // Native code may have written it while the answer was on its way; that value stands.
    if (typeof top === 'number' && !root.style.getPropertyValue(TOP_INSET)) {
      root.style.setProperty(TOP_INSET, `${top}px`)
    }
  } catch (err) {
    console.warn('[SafeArea] Could not ask for the status bar height:', err)
  }
}
