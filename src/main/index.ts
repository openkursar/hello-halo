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

// Catch unhandled errors and log them.
// Use onError callback to suppress benign/transient errors — returning false prevents
// electron-log from showing the native error dialog. A separate process.on('uncaughtException')
// handler does NOT work because Node.js calls ALL registered listeners; the return in one
// listener cannot stop electron-log's listener from firing and showing the dialog.
//
// Suppressed categories:
//   - EPIPE: broken pipe when writing to closed stdio
//   - Transient network errors from long-lived TCP/TLS sockets (IMAP/SMTP/CalDAV/etc.)
//     that are either already handled by their owning clients, or are unrecoverable
//     background failures the user can do nothing about. These are logged as warnings
//     and must not crash or alert the main process.
log.errorHandler.startCatching({
  onError({ error }) {
    const message = error?.message || ''
    const code = (error as NodeJS.ErrnoException | undefined)?.code || ''
    const stack = error?.stack || ''

    if (message.includes('EPIPE') || code === 'EPIPE') {
      log.warn('[Main] Ignored EPIPE error (broken pipe)')
      return false
    }

    // Transient socket-level errors from long-lived TCP/TLS connections.
    // Match by error code first (authoritative), then by stack origin as a fallback
    // for libraries that throw plain Error objects (e.g. imapflow "Socket timeout").
    const TRANSIENT_NET_CODES = new Set([
      'ETIMEDOUT',
      'ETIMEOUT',        // imapflow uses this non-standard variant
      'ECONNRESET',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENETDOWN',
      'ENOTFOUND',
      'EAI_AGAIN',
    ])
    const isTransientNetCode = code && TRANSIENT_NET_CODES.has(code)
    const isImapSocketTimeout =
      message === 'Socket timeout' && stack.includes('imapflow')
    const isNodeSocketTimeout =
      /TLSSocket\._socketTimeout|Socket\._onTimeout/.test(stack)

    if (isTransientNetCode || isImapSocketTimeout || isNodeSocketTimeout) {
      log.warn(`[Main] Ignored transient network error: ${code || 'no-code'} ${message}`)
      return false
    }
  }
})

// Replace global console with electron-log (performance: direct replacement, no wrapper)
Object.assign(console, log.functions)

// Logging subsystem: subscribe to config changes and control log level + transports.
// Must load after console replacement so its initial log calls go through electron-log.
import './foundation/logging'

// Fix PATH for macOS GUI apps
// GUI apps don't inherit shell environment variables (.zshrc, .bash_profile, etc.)
// This ensures tools like git, node, npm are discoverable
// Executed after page load to avoid blocking startup
// Note: fix-path is ESM-only, loaded dynamically to support both CJS and ESM builds

import { app, BrowserWindow, Menu } from 'electron'
import open from 'open'

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

// Per-variant data isolation: Override Electron userData path based on product.json dataFolderName.
// Must be called before app.whenReady() and requestSingleInstanceLock() so that
// each build variant (e.g. Halo vs Halo-Enterprise) uses its own userData directory.
// This isolates cookies, sessions, localStorage, Claude SDK config, etc.
import { getDataFolderName, DEFAULT_DATA_FOLDER_NAME, loadProductConfig } from './foundation/product-config'
import { join as joinPath } from 'path'
const dataFolderName = getDataFolderName()
if (dataFolderName !== DEFAULT_DATA_FOLDER_NAME) {
  const appDataPath = app.getPath('appData')
  app.setPath('userData', joinPath(appDataPath, dataFolderName))
  console.log(`[Main] userData isolated to: ${joinPath(appDataPath, dataFolderName)}`)
}

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

// Trust certificates for domains explicitly listed in browserPolicy.allowlist.
// Only fires when Chromium has already rejected a certificate (self-signed, private CA, etc.).
// Normal HTTPS requests with valid certificates are unaffected (zero overhead).
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  const policy = loadProductConfig().browserPolicy
  if (policy?.mode === 'allowlist' && policy.allowlist) {
    try {
      const h = new URL(url).hostname.toLowerCase()
      const trusted = policy.allowlist.some(p => {
        const lp = p.toLowerCase()
        if (lp.startsWith('*.')) {
          const base = lp.slice(2)
          return h === base || h.endsWith('.' + base)
        }
        return h === lp
      })
      if (trusted) {
        event.preventDefault()
        callback(true)
        return
      }
    } catch {
      // Malformed URL — reject
    }
  }
  callback(false)
})

import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  initializeEssentialServices,
  initializeExtendedServices,
  cleanupExtendedServices
} from './bootstrap'
import { initializeApp } from './foundation/config.service'
import { flushAllPendingIndexWrites } from './services/conversation.service'
import { shutdownRemoteAccess } from './services/remote.service'
import { stopOpenAICompatRouter } from './openai-compat-router'
import { manualCheckForUpdates } from './services/updater.service'
import { initAnalytics } from './services/analytics'
import { registerProtocols } from './foundation/protocol.service'
import { setMainWindow } from './foundation/window.service'
import { initInstanceId, shutdownHealthSystem, onRendererCrash, onRendererUnresponsive } from './services/health'
import { reconcileAllSpaces } from './services/artifact-cache.service'
import { initSdk } from './services/agent/resolved-sdk'

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
            await open('https://github.com/openkursar/hello-halo')
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

  // Close-to-tray: hide window instead of destroying (macOS + Windows only).
  // Linux: allow normal close because system tray support is fragmented across DEs.
  // Only allow actual close when the app is quitting (Cmd+Q, menu quit, tray quit).
  mainWindow.on('close', (event) => {
    if (!isAppQuitting && process.platform !== 'linux' && mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    setMainWindow(null)
    mainWindow = null
  })

  // Reconcile artifact caches on window focus (recover missed watcher events)
  mainWindow.on('focus', () => {
    reconcileAllSpaces().catch((err) => {
      console.error('[Main] Artifact reconciliation error on focus:', err)
    })
  })

  // Notify all subscribers about the new window
  setMainWindow(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    open(details.url)
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

  // Initialize SDK engine (must be after config is loaded, before any SDK usage)
  // This loads the configured engine (halo or anthropic) dynamically.
  // Hard constraint: if the configured SDK is not available, startup fails.
  await initSdk()

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

  await shutdownRemoteAccess().catch(console.error)
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
  // With close-to-tray, this event only fires during actual quit
  // (isAppQuitting=true, so the close handler did not preventDefault).
  // On non-macOS, ensure clean shutdown before exiting.
  // On macOS, the quit sequence continues automatically from before-quit.
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
