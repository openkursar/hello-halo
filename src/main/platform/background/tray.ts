/**
 * platform/background/tray -- System tray manager
 *
 * Manages the system tray icon and context menu.
 * Provides visual feedback about the background service status
 * and quick access to show the main window, toggle online/offline, and quit.
 */

import { Tray, Menu, nativeImage, nativeTheme } from 'electron'
import { join } from 'path'
import { getTrayIconDir } from '../../foundation/product-config'
import { readWindowsTaskbarIsDark } from './taskbar-theme'
import type { BackgroundStatus, TrayNotice } from './types'

/**
 * Callback interface for tray menu actions.
 * The TrayManager does not implement business logic; it delegates
 * all actions to the parent (BackgroundService) through these callbacks.
 */
export interface TrayCallbacks {
  onShowWindow: () => void
  onGoOnline: () => void
  onGoOffline: () => void
  onQuit: () => void
  getStatus: () => BackgroundStatus
  getActiveReasons: () => string[]
}

/**
 * TrayManager handles the system tray icon lifecycle.
 *
 * Platform differences:
 * - macOS: Uses template images that auto-adapt to light/dark menu bar.
 *   The tray icon appears in the top menu bar.
 * - Windows: A white or black glyph matching the macOS one, picked to
 *   contrast with the taskbar and swapped when the system theme changes.
 * - Linux: A brand-blue glyph; panel themes vary too much to pick black or white.
 */
export class TrayManager {
  private tray: Tray | null = null
  private callbacks: TrayCallbacks | null = null
  private notice: TrayNotice | null = null
  private readonly onThemeUpdated = (): void => this.refreshWindowsIcon()
  private themeReadSeq = 0

  /**
   * Initialize the tray icon and menu.
   * Safe to call multiple times; subsequent calls update the existing tray.
   */
  init(callbacks: TrayCallbacks): void {
    this.callbacks = callbacks

    if (this.tray) {
      // Already created, just rebuild the menu
      this.updateMenu()
      return
    }

    try {
      this.tray = new Tray(this.createIcon())
    } catch (error) {
      // No status-icon host: the app runs without a tray, and closing the last
      // window quits (see hasTray).
      console.error('[Tray] Could not create the system tray icon:', error)
      return
    }

    this.tray.setToolTip('Halo')

    // On macOS, clicking the tray icon should show a menu (default behavior).
    // On Windows, clicking should show the main window.
    if (process.platform !== 'darwin') {
      this.tray.on('click', () => {
        this.callbacks?.onShowWindow()
      })
    }

    if (process.platform === 'win32') {
      this.refreshWindowsIcon()
      nativeTheme.on('updated', this.onThemeUpdated)
    }

    this.updateMenu()
    console.log('[Tray] System tray initialized')
  }

  /** Whether a tray icon exists, i.e. the user can reach the app with no window open. */
  hasTray(): boolean {
    return this.tray !== null
  }

  setNotice(notice: TrayNotice | null): void {
    this.notice = notice
    this.updateMenu()
  }

  /**
   * Update the context menu to reflect current status.
   */
  updateMenu(): void {
    if (!this.tray || !this.callbacks) return

    const status = this.callbacks.getStatus()
    const reasons = this.callbacks.getActiveReasons()
    const isOnline = status === 'online'

    const notice = this.notice
    const menuItems: Electron.MenuItemConstructorOptions[] = [
      ...(notice
        ? [
            { label: notice.message, enabled: false },
            { label: notice.actionLabel, click: () => notice.onAction() },
            { type: 'separator' as const }
          ]
        : []),
      {
        label: 'Show Halo',
        click: () => this.callbacks?.onShowWindow()
      },
      { type: 'separator' },
      {
        label: isOnline ? 'Go Offline' : 'Go Online',
        click: () => {
          if (isOnline) {
            this.callbacks?.onGoOffline()
          } else {
            this.callbacks?.onGoOnline()
          }
        }
      },
      {
        label: `Status: ${isOnline ? 'Online' : 'Offline'}`,
        enabled: false
      }
    ]

    // Show active keep-alive reasons if any
    if (reasons.length > 0) {
      menuItems.push({ type: 'separator' })
      menuItems.push({
        label: `Active Tasks (${reasons.length})`,
        enabled: false
      })
      // Show up to 5 reasons to avoid an excessively long menu
      const displayReasons = reasons.slice(0, 5)
      for (const reason of displayReasons) {
        menuItems.push({
          label: `  ${reason}`,
          enabled: false
        })
      }
      if (reasons.length > 5) {
        menuItems.push({
          label: `  ... and ${reasons.length - 5} more`,
          enabled: false
        })
      }
    }

    menuItems.push(
      { type: 'separator' },
      {
        label: 'Quit Halo',
        click: () => this.callbacks?.onQuit()
      }
    )

    const contextMenu = Menu.buildFromTemplate(menuItems)
    this.tray.setContextMenu(contextMenu)

    // Update tooltip to show status
    const tooltip = notice
      ? `Halo - ${notice.message}`
      : reasons.length > 0
      ? `Halo (${isOnline ? 'Online' : 'Offline'}) - ${reasons.length} active task(s)`
      : `Halo (${isOnline ? 'Online' : 'Offline'})`
    this.tray.setToolTip(tooltip)
  }

  /**
   * Destroy the tray icon. Called during shutdown.
   */
  destroy(): void {
    nativeTheme.off('updated', this.onThemeUpdated)
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
      console.log('[Tray] System tray destroyed')
    }
  }

  /**
   * Create the tray icon appropriate for the current platform.
   */
  private createIcon(): Electron.NativeImage {
    const isMac = process.platform === 'darwin'

    // Resolve the path to tray icon assets. Defaults to resources/tray/, but a
    // brand build can point product.json's `trayIconDir` at its own icon set
    // (see getTrayIconDir). That directory is included in app.asar via the
    // build's `files` config, so this resolves correctly both in development
    // and packaged.
    const resourcesPath = getTrayIconDir()

    if (isMac) {
      // macOS: Use template images. Electron automatically picks @2x for Retina.
      // Template images adapt to the menu bar's light/dark appearance.
      const iconPath = join(resourcesPath, 'trayTemplate.png')
      const icon = nativeImage.createFromPath(iconPath)
      icon.setTemplateImage(true)
      return icon
    }

    if (process.platform === 'win32') {
      // Until the taskbar theme is read, guess from the app theme.
      const icon = createWindowsGlyph(resourcesPath, nativeTheme.shouldUseDarkColors)
      if (icon) return icon
    }

    // Brand-blue glyph: reads on light and dark panels alike. `tray-16.png` is
    // the fallback for icon sets that predate it.
    const colored = nativeImage.createFromPath(join(resourcesPath, 'tray-color.png'))
    return colored.isEmpty() ? nativeImage.createFromPath(join(resourcesPath, 'tray-16.png')) : colored
  }

  private refreshWindowsIcon(): void {
    const seq = ++this.themeReadSeq
    readWindowsTaskbarIsDark().then((isDark) => {
      // A later read may have finished first; only the newest applies.
      if (!this.tray || isDark === null || seq !== this.themeReadSeq) return
      const icon = createWindowsGlyph(getTrayIconDir(), isDark)
      if (icon) this.tray.setImage(icon)
    })
  }
}

/**
 * White glyph for a dark taskbar, black for a light one. An .ico, since
 * Windows builds the tray icon from the image's 1x bitmap only and loads other
 * sizes only from an .ico. Null when the icon set predates these files (a
 * brand `trayIconDir`), so the caller falls back to the brand-blue icon instead
 * of showing a blank slot.
 */
function createWindowsGlyph(resourcesPath: string, taskbarIsDark: boolean): Electron.NativeImage | null {
  const icon = nativeImage.createFromPath(join(resourcesPath, taskbarIsDark ? 'tray-win-white.ico' : 'tray-win-black.ico'))
  return icon.isEmpty() ? null : icon
}
