/**
 * Tray Service - System tray management
 * Handles system tray icon and menu for Mac/Windows
 */

import { Tray, Menu, nativeImage, app, BrowserWindow, NativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let tray: Tray | null = null
let isQuitting = false

// Get the correct icon path based on platform and environment
function getTrayIconPath(): string {
  // In development, use resources folder relative to project root
  // In production, use app.getAppPath() which points to app.asar
  const resourcesPath = is.dev
    ? join(__dirname, '../../resources')
    : join(app.getAppPath(), '../resources')

  // macOS uses template images (16x16 or 22x22 monochrome)
  // Windows uses 16x16 or 32x32 icons
  if (process.platform === 'darwin') {
    return join(resourcesPath, 'tray/trayTemplate.png')
  } else {
    return join(resourcesPath, 'tray/tray-16.png')
  }
}

// Create a simple tray icon programmatically if file doesn't exist
function createDefaultTrayIcon(): NativeImage {
  // Create a simple 16x16 icon
  const size = process.platform === 'darwin' ? 16 : 32

  // Create a simple circle icon
  const canvas = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="none" stroke="${process.platform === 'darwin' ? 'black' : '#6366f1'}" stroke-width="2"/>
    </svg>
  `

  const buffer = Buffer.from(canvas)
  const icon = nativeImage.createFromBuffer(buffer)

  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }

  return icon
}

/**
 * Initialize the system tray
 */
export function createTray(mainWindow: BrowserWindow | null): Tray | null {
  if (tray) {
    return tray
  }

  try {
    let icon: NativeImage

    // Try to load custom icon, fall back to default
    const iconPath = getTrayIconPath()
    try {
      icon = nativeImage.createFromPath(iconPath)
      if (icon.isEmpty()) {
        throw new Error('Icon file is empty')
      }
      if (process.platform === 'darwin') {
        icon.setTemplateImage(true)
      }
    } catch {
      console.log('[Tray] Using default icon')
      icon = createDefaultTrayIcon()
    }

    tray = new Tray(icon)
    tray.setToolTip('Halo - AI Assistant')

    // Update context menu
    updateTrayMenu(mainWindow)

    // Double-click to show window (Windows)
    tray.on('double-click', () => {
      showMainWindow(mainWindow)
    })

    // Single click to show window (macOS)
    if (process.platform === 'darwin') {
      tray.on('click', () => {
        showMainWindow(mainWindow)
      })
    }

    console.log('[Tray] Created successfully')
    return tray
  } catch (error) {
    console.error('[Tray] Failed to create:', error)
    return null
  }
}

/**
 * Update tray context menu
 */
export function updateTrayMenu(mainWindow: BrowserWindow | null): void {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Halo',
      click: () => {
        showMainWindow(mainWindow)
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
}

/**
 * Show the main window
 */
function showMainWindow(mainWindow: BrowserWindow | null): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()

    // On macOS, also show in dock
    if (process.platform === 'darwin') {
      app.dock?.show()
    }
  }
}

/**
 * Destroy the tray
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
    console.log('[Tray] Destroyed')
  }
}

/**
 * Check if tray exists
 */
export function hasTray(): boolean {
  return tray !== null
}

/**
 * Set quitting flag
 */
export function setIsQuitting(value: boolean): void {
  isQuitting = value
}

/**
 * Check if app is quitting
 */
export function getIsQuitting(): boolean {
  return isQuitting
}
