/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Halo - Electron Main Process
 * The main entry point for the Electron application
 */

// ========================================
// LOGGING INITIALIZATION (must be first)
// ========================================
// Initialize electron-log before any other code to capture all logs
// This replaces console.log/warn/error globally with electron-log
// Logs are written to: ~/Library/Logs/Halo/ (macOS), %USERPROFILE%\AppData\Roaming\Halo\logs (Windows)
import log from 'electron-log/main.js'

// Initialize for renderer process support (IPC transport)
log.initialize()

// Configure log levels (industry standard)
// - Production: 'info' (logs info/warn/error, skips debug/silly)
// - Development: 'debug' (more verbose)
const isDev = process.env.NODE_ENV === 'development'
log.transports.file.level = 'info'           // Always log info+ to file
log.transports.console.level = isDev ? 'debug' : 'info'
log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB per file, auto-rotate

// Handle EPIPE errors gracefully (must be registered BEFORE electron-log's errorHandler)
// electron-log's startCatching() registers its own uncaughtException handler that shows
// an Electron error dialog. By registering our EPIPE filter first, we intercept EPIPE
// errors before they reach electron-log's handler, preventing unwanted error popups.
process.on('uncaughtException', (error) => {
  if (error.message?.includes('EPIPE')) {
    log.warn('[Main] Ignored EPIPE error during shutdown')
    return
  }
  // Non-EPIPE errors: fall through to electron-log's handler (registered below via startCatching).
  // Node.js calls all registered uncaughtException handlers in order — no need to re-throw.
})

// Catch unhandled errors and log them (after EPIPE filter is in place)
log.errorHandler.startCatching()

// Replace global console with electron-log (performance: direct replacement, no wrapper)
Object.assign(console, log.functions)

// Fix PATH for macOS GUI apps
// GUI apps don't inherit shell environment variables (.zshrc, .bash_profile, etc.)
// This ensures tools like git, node, npm are discoverable
// Executed after page load to avoid blocking startup
// Note: fix-path is ESM-only, loaded dynamically to support both CJS and ESM builds

import { app, shell, BrowserWindow, Menu } from 'electron'

// GPU compatibility: Disable hardware acceleration on Windows to prevent blank window issues
// Some Windows GPU configurations cause the GPU process to crash, resulting in a white/blank screen
// Using both disableHardwareAcceleration() and disable-gpu switch for maximum compatibility
if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

// Anti-fingerprinting: Disable automation detection features in Chromium
// This prevents websites from detecting the app as an automated browser
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// Single instance lock: Prevent multiple instances of the application
// Must be called before app.whenReady()
// Skip in development mode and E2E tests to allow multiple instances
const gotTheLock =
  !app.isPackaged || process.env.HALO_E2E_TEST ? true : app.requestSingleInstanceLock()

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
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  // Restore from hidden state if needed
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
})

import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  initializeEssentialServices,
  initializeExtendedServices,
  cleanupExtendedServices
} from './bootstrap'
import { initializeApp } from './services/config.service'
import { flushAllPendingIndexWrites } from './services/conversation.service'
import { disableRemoteAccess } from './services/remote.service'
import { stopOpenAICompatRouter } from './openai-compat-router'
import { manualCheckForUpdates } from './services/updater.service'
import { initAnalytics } from './services/analytics'
import { registerProtocols } from './services/protocol.service'
import { setMainWindow } from './services/window.service'
import { initInstanceId, shutdownHealthSystem, onRendererCrash, onRendererUnresponsive } from './services/health'

let mainWindow: BrowserWindow | null = null
let isAppQuitting = false
let recentRecoveryWindowStart = 0
let recoveryAttempts = 0

function recoverRenderer(reason: string): void {
  if (isAppQuitting) {
    return
  }

  const now = Date.now()
  if (now - recentRecoveryWindowStart > 60000) {
    recentRecoveryWindowStart = now
    recoveryAttempts = 0
  }

  recoveryAttempts += 1
  console.warn(`[Main] Renderer issue detected (${reason}). Attempting recovery #${recoveryAttempts}`)

  if (recoveryAttempts > 3) {
    console.error('[Main] Renderer failed repeatedly. Relaunching app for a clean state.')
    app.relaunch()
    app.exit(0)
    return
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.reloadIgnoringCache()
      mainWindow.show()
      return
    } catch (error) {
      console.error('[Main] Failed to reload renderer, recreating window:', error)
      try {
        mainWindow.destroy()
      } catch (destroyError) {
        console.error('[Main] Failed to destroy corrupted window:', destroyError)
      }
      mainWindow = null
    }
  }

  createWindow()
}

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
                click: () => manualCheckForUpdates()
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
                click: () => manualCheckForUpdates()
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
    console.log('[Main] ready-to-show event fired')
    mainWindow?.maximize()
    mainWindow?.show()
  })

  // Fix PATH after page loads (avoid blocking startup)
  mainWindow.webContents.on('did-finish-load', async () => {
    if (process.platform !== 'win32') {
      // Dynamic import for ESM-only fix-path module
      const { default: fixPath } = await import('fix-path')
      fixPath()
    }
  })

  mainWindow.on('unresponsive', () => {
    onRendererUnresponsive()
    recoverRenderer('unresponsive')
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    onRendererCrash({ reason: details.reason })
    recoverRenderer(`render-process-gone:${details.reason}`)
  })

  mainWindow.on('closed', () => {
    setMainWindow(null)
    mainWindow = null
  })

  // Notify all subscribers about the new window
  setMainWindow(mainWindow)

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

  // Open DevTools in development (skip during E2E to avoid viewport interference)
  if (is.dev && !process.env.HALO_E2E_TEST) {
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

  // Initialize health system instance ID (synchronous, <1ms)
  // Must be called before any subprocess is spawned
  initInstanceId()

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
  // Window reference is managed by window.service.ts
  initializeEssentialServices()

  // Phase 2: Extended Services (deferred until window is visible)
  // This ensures Extended initialization NEVER affects startup speed
  if (mainWindow) {
    // Wait for window to actually show before loading Extended services
    // This guarantees 100% that startup is not affected
    mainWindow.once('ready-to-show', () => {
      // Additional delay to ensure first paint is complete
      // requestIdleCallback equivalent for Node.js
      setImmediate(() => {
        initializeExtendedServices()

        // Initialize analytics (after IPC handlers registered and window created)
        initAnalytics().catch(err => console.warn('[Analytics] Init failed:', err))
      })
    })
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

let hasShutdown = false
const SHUTDOWN_TIMEOUT_MS = 5000
async function shutdownServices(): Promise<void> {
  if (hasShutdown) {
    return
  }
  hasShutdown = true

  // Flush pending conversation index writes before shutdown
  flushAllPendingIndexWrites()

  // Shutdown health system first (marks clean exit)
  shutdownHealthSystem()

  await disableRemoteAccess().catch(console.error)
  await stopOpenAICompatRouter().catch(console.error)
  await cleanupExtendedServices().catch(console.error)
}

async function shutdownServicesWithTimeout(timeoutMs: number): Promise<void> {
  const shutdownPromise = shutdownServices().catch(console.error)
  await Promise.race([
    shutdownPromise,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        console.warn(`[Main] Shutdown timeout after ${timeoutMs}ms, forcing quit`)
        resolve()
      }, timeoutMs)
    })
  ])
}

app.on('before-quit', () => {
  isAppQuitting = true
  shutdownServicesWithTimeout(SHUTDOWN_TIMEOUT_MS).catch(console.error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    shutdownServicesWithTimeout(SHUTDOWN_TIMEOUT_MS)
      .catch(console.error)
      .finally(() => app.quit())
  }
})

// Export mainWindow for IPC handlers
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
