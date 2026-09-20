/**
 * platform/background/tray -- System tray manager
 *
 * Manages the system tray icon and context menu.
 * Provides visual feedback about the background service status
 * and quick access to show the main window, toggle online/offline, and quit.
 */

import { Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { getTrayIconDir } from '../../foundation/product-config'
import type { BackgroundStatus } from './types'

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
 * - Windows: Uses 16x16 PNG icon. The tray icon appears in the system tray
 *   notification area.
 */
export class TrayManager {
  private tray: Tray | null = null
  private callbacks: TrayCallbacks | null = null

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

    const icon = this.createIcon()
    this.tray = new Tray(icon)

    this.tray.setToolTip('Halo')

    // On macOS, clicking the tray icon should show a menu (default behavior).
    // On Windows, clicking should show the main window.
    if (process.platform !== 'darwin') {
      this.tray.on('click', () => {
        this.callbacks?.onShowWindow()
      })
    }

    this.updateMenu()
    console.log('[Tray] System tray initialized')
  }

  /**
   * Update the context menu to reflect current status.
   */
  updateMenu(): void {
    if (!this.tray || !this.callbacks) return

    const status = this.callbacks.getStatus()
    const reasons = this.callbacks.getActiveReasons()
    const isOnline = status === 'online'

    const menuItems: Electron.MenuItemConstructorOptions[] = [
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
    const tooltip = reasons.length > 0
      ? `Halo (${isOnline ? 'Online' : 'Offline'}) - ${reasons.length} active task(s)`
      : `Halo (${isOnline ? 'Online' : 'Offline'})`
    this.tray.setToolTip(tooltip)
  }

  /**
   * Destroy the tray icon. Called during shutdown.
   */
  destroy(): void {
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

    // Windows/Linux: Use standard 16x16 icon
    const iconPath = join(resourcesPath, 'tray-16.png')
    return nativeImage.createFromPath(iconPath)
  }
}
