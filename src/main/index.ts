/**
 * Halo - Electron Main Process
 * The main entry point for the Electron application
 */

// Handle EPIPE errors gracefully
// These occur when SDK child processes are terminated during app shutdown
// Especially common in E2E tests when app is forcefully closed
process.on('uncaughtException', (error) => {
  // Ignore EPIPE errors during shutdown (common with SDK child processes)
  if (error.message?.includes('EPIPE')) {
    console.warn('[Main] Ignored EPIPE error during shutdown')
    return
  }
  // Re-throw other errors to show the default Electron error dialog
  throw error
})

// Fix PATH for macOS GUI apps
// GUI apps don't inherit shell environment variables (.zshrc, .bash_profile, etc.)
// This ensures tools like git, node, npm are discoverable
// Executed after page load to avoid blocking startup
import fixPath from 'fix-path'

import { app, shell, BrowserWindow, Menu } from 'electron'

// GPU compatibility: Disable hardware acceleration on Windows to prevent blank window issues
// Some Windows GPU configurations cause the GPU process to crash, resulting in a white/blank screen
// Using both disableHardwareAcceleration() and disable-gpu switch for maximum compatibility
if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

// Single instance lock: Prevent multiple instances of the application
// Must be called before app.whenReady()
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Another instance is already running, exit immediately
  // Use app.exit() instead of app.quit() to terminate synchronously
  // This prevents any further initialization code from executing
  app.exit(0)
}

// Handle second-instance event (when user tries to launch another instance)
// Note: This event only fires on the primary instance
app.on('second-instance', () => {
  // Focus the existing window when a second instance is launched
  if (mainWindow) {
    // Restore from tray/hidden state if needed
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    // Restore from minimized state
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    // Bring to front
    mainWindow.focus()

    // On macOS, also show in dock
    if (process.platform === 'darwin') {
      app.dock?.show()
    }
  }
})

import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  initializeEssentialServices,
  initializeExtendedServices,
  cleanupExtendedServices
} from './bootstrap'
import { initializeApp, getMinimizeToTray } from './services/config.service'
import { disableRemoteAccess } from './services/remote.service'
import { stopOpenAICompatRouter } from './openai-compat-router'
import {
  createTray,
  destroyTray,
  hasTray,
  setIsQuitting,
  getIsQuitting
} from './services/tray.service'
import { checkForUpdates } from './services/updater.service'
import { initAnalytics } from './services/analytics'
import { registerProtocols } from './services/protocol.service'

let mainWindow: BrowserWindow | null = null

/**
 * Create application menu with Check for Updates option
 */
function createAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Check for Updates...',
                click: () => checkForUpdates()
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    // File menu
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const } : { role: 'quit' as const }]
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const }
            ]
          : [{ role: 'delete' as const }, { type: 'separator' as const }, { role: 'selectAll' as const }])
      ]
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    // Help menu (Windows: includes Check for Updates)
    {
      role: 'help' as const,
      submenu: [
        ...(!isMac
          ? [
              {
                label: 'Check for Updates...',
                click: () => checkForUpdates()
              },
              { type: 'separator' as const }
            ]
          : []),
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://github.com/openkursar/hello-halo')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createWindow(): void {
  // Platform-specific window options
  const isMac = process.platform === 'darwin'

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // macOS: hiddenInset for traffic lights in content area
    // Windows/Linux: hidden + titleBarOverlay for native buttons overlay
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // Fine-tuned for visual alignment with 40px header
    trafficLightPosition: isMac ? { x: 15, y: 11 } : undefined,
    // Windows/Linux: native window controls overlay in content area
    titleBarOverlay: !isMac ? {
      color: '#0a0a0a',
      symbolColor: '#ffffff',
      height: 40
    } : undefined,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Fix PATH after page loads (avoid blocking startup)
  mainWindow.webContents.on('did-finish-load', () => {
    if (process.platform !== 'win32') {
      fixPath()
    }
  })

  // Handle window close - minimize to tray if enabled
  mainWindow.on('close', (event) => {
    // If quitting, allow close
    if (getIsQuitting()) {
      return
    }

    // If minimize to tray is enabled, hide instead of close
    if (getMinimizeToTray()) {
      event.preventDefault()
      mainWindow?.hide()

      // On macOS, also hide from dock
      if (process.platform === 'darwin') {
        app.dock?.hide()
      }

      // Create tray if not exists
      if (!hasTray()) {
        createTray(mainWindow)
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Open DevTools in development
  if (is.dev) {
    mainWindow.webContents.openDevTools()
  }
}

// Initialize application
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.halo.app')

  // Register custom protocols (halo-file://, etc.)
  registerProtocols()

  // Default open or close DevTools by F12 in development
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize app data directories
  await initializeApp()

  // Create application menu
  createAppMenu()

  // Create window first (before analytics, so Baidu provider can find the window)
  createWindow()

  // ========================================
  // PHASED INITIALIZATION
  // ========================================
  // See src/main/bootstrap/index.ts for architecture documentation

  // Phase 1: Essential Services (synchronous, required for first screen)
  // These services are needed for the initial UI render
  if (mainWindow) {
    initializeEssentialServices(mainWindow)
  }

  // Phase 2: Extended Services (deferred until window is visible)
  // This ensures Extended initialization NEVER affects startup speed
  if (mainWindow) {
    // Wait for window to actually show before loading Extended services
    // This guarantees 100% that startup is not affected
    mainWindow.once('ready-to-show', () => {
      // Additional delay to ensure first paint is complete
      // requestIdleCallback equivalent for Node.js
      setImmediate(() => {
        initializeExtendedServices(mainWindow!)

        // Initialize analytics (after IPC handlers registered and window created)
        initAnalytics().catch(err => console.warn('[Analytics] Init failed:', err))
      })
    })
  }

  // Initialize tray if minimize to tray is enabled
  if (getMinimizeToTray()) {
    createTray(mainWindow)
  }

  app.on('activate', function () {
    // On macOS, re-show the window when clicking dock icon
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      app.dock?.show()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// Set quitting flag before quit
app.on('before-quit', () => {
  setIsQuitting(true)
})

app.on('window-all-closed', () => {
  // If minimize to tray is enabled, don't quit
  if (getMinimizeToTray() && !getIsQuitting()) {
    return
  }

  // Clean up remote access before quitting
  disableRemoteAccess().catch(console.error)
  // Clean up local OpenAI compat router (if started)
  stopOpenAICompatRouter().catch(console.error)

  // Clean up extended services (AI Browser, Overlay, Search, etc.)
  cleanupExtendedServices()

  // Clean up tray
  destroyTray()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Export mainWindow for IPC handlers
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
