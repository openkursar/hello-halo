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
// Default is sync fs.writeFileSync per line, which blocks the main process
// event loop (and every window with it) on every log call. Async queues
// writes instead. Must be set before the first log call: the file object
// caches this at creation and ignores later changes.
log.transports.file.sync = false

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

    // Node 20 Happy-Eyeballs internal timer race (nodejs/node#47644). Primary
    // mitigation is the autoSelectFamily=false above; this branch covers callers
    // that opt in explicitly per-connection.
    if (code === 'ERR_INTERNAL_ASSERTION' && /internalConnectMultiple/.test(stack)) {
      log.warn(`[Main] Ignored Node autoSelectFamily assertion: ${message}`)
      return false
    }
  }
})

// Replace global console with electron-log (performance: direct replacement, no wrapper)
Object.assign(console, log.functions)

// Logging subsystem: subscribe to config changes and control log level + transports.
// Must load after console replacement so its initial log calls go through electron-log.
import './foundation/logging'

// ========================================
// NETWORK SAFETY (must run before any outbound socket)
// ========================================
// Node 20 defaults autoSelectFamily=true; its internal timer race surfaces as
// ERR_INTERNAL_ASSERTION in internalConnectMultiple (nodejs/node#47644).
// Restoring the pre-20 sequential fallback for Node-side sockets removes the
// trigger. Chromium's network stack is separate and unaffected.
import net from 'net'
net.setDefaultAutoSelectFamily(false)

// Fix PATH for macOS GUI apps
// GUI apps don't inherit shell environment variables (.zshrc, .bash_profile, etc.)
// This ensures tools like git, node, npm are discoverable
// Executed after page load to avoid blocking startup
// Note: fix-path is ESM-only, loaded dynamically to support both CJS and ESM builds

import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Menu, crashReporter, nativeImage } from 'electron'
import open from 'open'

// GPU compatibility: Disable hardware acceleration on Windows to prevent blank window issues
// Some Windows GPU configurations cause the GPU process to crash, resulting in a white/blank screen
// Using both disableHardwareAcceleration() and disable-gpu switch for maximum compatibility
if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  // Windows-only native occlusion tracking pauses compositor frames for
  // minimized/covered windows, stalling Page.captureScreenshot on the
  // routinely off-screen views used by AI automation (macOS has no
  // equivalent). Disabling it keeps frames flowing for background AI browser work.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

// Anti-fingerprinting: Disable automation detection features in Chromium
// This prevents websites from detecting the app as an automated browser
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// Per-variant data isolation: Override Electron userData path based on product.json dataFolderName.
// Must be called before app.whenReady() and requestSingleInstanceLock() so that
// each build variant (e.g. Halo vs Halo-Enterprise) uses its own userData directory.
// This isolates cookies, sessions, localStorage, Claude SDK config, etc.
import { getDataFolderName, DEFAULT_DATA_FOLDER_NAME, getMacIconPath, getUpdateChannel, loadProductConfig } from './foundation/product-config'
import {
  clearRunningInstance,
  explainLostSingleInstanceLock,
  markRunningInstance,
} from './foundation/running-instance'
import { isHostnameTrustedForCertificates } from './services/browser-policy.service'
import { join as joinPath } from 'path'
import { isolateLogPath, logFatal } from './foundation/logging'
const dataFolderName = getDataFolderName()
if (dataFolderName !== DEFAULT_DATA_FOLDER_NAME) {
  const appDataPath = app.getPath('appData')
  app.setPath('userData', joinPath(appDataPath, dataFolderName))
  console.log(`[Main] userData isolated to: ${joinPath(appDataPath, dataFolderName)}`)
}

// Log path isolation (per-variant / per-cluster-node) — see
// foundation/logging/log-isolation.ts for the rules. Must run pre-ready.
isolateLogPath(app)

// Single instance lock: Prevent multiple instances of the application
// Must be called before app.whenReady()
// Skip in development mode and E2E tests to allow multiple instances
const gotTheLock =
  !app.isPackaged || process.env.HALO_E2E_TEST ? true : app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Another instance is already running, exit immediately
  // Use app.exit() instead of app.quit() to terminate synchronously
  // This prevents any further initialization code from executing
  explainLostSingleInstanceLock(getUpdateChannel())
  app.exit(0)
} else if (app.isPackaged) {
  // Leave a note for any build that later loses the lock to this process. Only
  // meaningful when two installs share a data directory, which is exactly when
  // the losing build is a different one and the user needs to be told so.
  markRunningInstance(getUpdateChannel(), loadProductConfig().name)
  app.on('will-quit', clearRunningInstance)
}

// Handle second-instance event (when user tries to launch another instance)
// Note: This event only fires on the primary instance
app.on('second-instance', (_event, argv) => {
  // Windows/Linux deliver halo:// deep links via the second instance's argv.
  handleDeepLinkArgv(argv)

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

// halo:// deep links (office invites): register the protocol handler + macOS
// open-url listener before ready — a link click can be what launches the app.
registerDeepLinkHandling()

// Trust certificates for hosts covered by built-in browser allowlist domain
// patterns (never user custom entries or CIDR ranges — see
// isHostnameTrustedForCertificates). Only fires when Chromium has already
// rejected a certificate (self-signed, private CA, etc.). Normal HTTPS
// requests with valid certificates are unaffected (zero overhead).
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  if (isHostnameTrustedForCertificates(url)) {
    event.preventDefault()
    callback(true)
    return
  }
  callback(false)
})

import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  initializeEssentialServices,
  initializeExtendedServices,
  cleanupExtendedServices,
  applyServerModeSwitches,
  installServerSignalHandlers,
  bootServerMode
} from './bootstrap'
import { isServerMode } from './foundation/runtime-mode'
import { initializeApp } from './foundation/config.service'
import { applyDisplayScale, currentDisplayScale, nudgeDisplayScale, setDisplayScale, DISPLAY_STEP, registerDisplayHandlers } from './services/display.service'
import { flushAllPendingIndexWrites } from './services/conversation.service'
import { shutdownRemoteAccess } from './services/remote'
import { registerDeepLinkHandling, handleDeepLinkArgv } from './services/deep-link.service'
import { stopOpenAICompatRouter } from './openai-compat-router'
import { manualCheckForUpdates } from './services/updater'
import { initAnalytics } from './services/analytics'
import { registerProtocols } from './foundation/protocol.service'
import { setMainWindow } from './foundation/window.service'
import { checkAndArmSessionIntegrity, markSessionCleanExit } from './foundation/session-integrity'
import { relaunchApp } from './services/lifecycle'
import { initInstanceId, shutdownHealthSystem, onRendererCrash, onRendererUnresponsive } from './services/health'
import { reconcileAllSpaces } from './services/artifact-cache.service'
import { initSdk } from './services/agent/resolved-sdk'

// Headless server mode: apply no-display / no-sandbox switches before the app
// becomes ready (required for Electron to start without a display in a container),
// and route container stop signals (SIGTERM/SIGINT) into a graceful quit.
if (isServerMode()) {
  applyServerModeSwitches(app)
  installServerSignalHandlers(app)
}

let mainWindow: BrowserWindow | null = null
let displayHandlersRegistered = false
let isAppQuitting = false

/**
 * "The first screen is up" — the cue the deferred startup tier waits on.
 *
 * Kept separate from Electron's first-paint event because a launch that never
 * paints still has to reach this point; see the reveal logic in createWindow.
 */
let firstScreenReached = false
const firstScreenListeners: Array<() => void> = []

function registerFirstScreenListener(listener: () => void): void {
  if (firstScreenReached) {
    listener()
    return
  }
  firstScreenListeners.push(listener)
}

function announceFirstScreen(): void {
  if (firstScreenReached) return
  firstScreenReached = true
  for (const listener of firstScreenListeners.splice(0)) {
    try {
      listener()
    } catch (error) {
      console.error('[Main] First-screen listener failed:', error)
    }
  }
}
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
    relaunchApp('renderer-recovery')
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
        // Persistent zoom. The keyboard shortcuts are handled by a webContents
        // before-input-event (see createWindow) rather than menu accelerators,
        // because the zoomOut role's Cmd+- is unreliable on macOS; the menu items
        // stay for discoverability.
        { label: 'Actual Size', click: () => { setDisplayScale(mainWindow, 1) } },
        { label: 'Zoom In', click: () => { nudgeDisplayScale(mainWindow, DISPLAY_STEP) } },
        { label: 'Zoom Out', click: () => { nudgeDisplayScale(mainWindow, -DISPLAY_STEP) } },
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

  if (!displayHandlersRegistered) {
    registerDisplayHandlers(() => mainWindow)
    displayHandlersRegistered = true
  }
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
    // Vertically centered on the dedicated clearance strip rendered above
    // the whole NavRail+Header row (MAC_TRAFFIC_LIGHT_CLEARANCE_PX in
    // App.tsx). y is the top of the traffic-light button group, not its
    // center — the true group height isn't documented/queryable, so this is
    // tuned empirically rather than derived from a formula. That strip (not
    // NavRail) compensates for zoom via --display-scale.
    trafficLightPosition: isMac ? { x: 8, y: 6 } : undefined,
    // Windows/Linux: native window controls overlay in content area.
    // Matches globals.css's dark-theme `--background`/`--foreground`
    // (the default theme) exactly, for the brief window before the renderer
    // loads and calls setTitleBarOverlay with the live (possibly light)
    // theme's actual tokens — see App.tsx's applyTheme.
    titleBarOverlay: !isMac ? {
      color: '#0c0e12',
      symbolColor: '#e7e9ee',
      // One pixel short of Header's actual 48px height (h-12): tall enough
      // to vertically center the caption buttons in it, but leaves the
      // header's own 1px bottom border un-overpainted by the overlay's
      // opaque fill so it doesn't visually vanish under the buttons.
      height: 47
    } : undefined,
    backgroundColor: '#0c0e12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Seed the persistent display scale before first paint: zoomFactor applies
      // the zoom natively, and the CLI arg lets the preload set --display-scale
      // synchronously, so chrome-inset compensation is correct on frame one.
      zoomFactor: currentDisplayScale(),
      additionalArguments: [`--halo-display-scale=${currentDisplayScale()}`]
    }
  })

  // The window is created hidden and revealed on first paint. When the process
  // was started by something non-interactive — the installer's "run when
  // finished" box, or the updater relaunching after a swap — Windows may never
  // give it a foreground paint, so that event never arrives and the app runs
  // with no window and no tray while its processes sit in Task Manager. The
  // user's only recourse is launching it again, which merely reveals the
  // window that was there all along.
  //
  // So first paint is the preferred cue, not the only one: a loaded page will
  // do, and failing that a deadline. Whichever fires first wins.
  // First paint normally arrives about a second in. The page-loaded cue fires
  // earlier than that, so it waits a moment rather than revealing an unpainted
  // window; the outer deadline covers a launch where neither ever arrives.
  const REVEAL_AFTER_LOAD_MS = 1500
  const REVEAL_DEADLINE_MS = 8000
  let revealed = false
  let revealTimer: NodeJS.Timeout | undefined
  let loadRevealTimer: NodeJS.Timeout | undefined
  const reveal = (cue: string) => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return
    revealed = true
    clearTimeout(revealTimer)
    clearTimeout(loadRevealTimer)
    console.log(`[Main] Showing main window (${cue})`)
    mainWindow.maximize()
    mainWindow.show()
    announceFirstScreen()
  }
  revealTimer = setTimeout(() => reveal('deadline'), REVEAL_DEADLINE_MS)

  mainWindow.on('ready-to-show', () => reveal('ready-to-show'))
  mainWindow.webContents.on('did-finish-load', () => {
    loadRevealTimer ??= setTimeout(() => reveal('page loaded'), REVEAL_AFTER_LOAD_MS)
  })
  mainWindow.on('closed', () => {
    clearTimeout(revealTimer)
    clearTimeout(loadRevealTimer)
  })

  // Fix PATH after page loads (avoid blocking startup)
  mainWindow.webContents.on('did-finish-load', async () => {
    if (mainWindow) applyDisplayScale(mainWindow)
    if (process.platform !== 'win32') {
      // Dynamic import for ESM-only fix-path module
      const { default: fixPath } = await import('fix-path')
      fixPath()
    }
  })

  // Reliable keyboard zoom: Cmd/Ctrl + = / - / 0 adjust the persistent display
  // scale. Handled here at the input layer because the zoomOut menu accelerator
  // (Cmd+-) is unreliable on macOS.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod || input.alt) return
    if (input.key === '-' || input.key === '_') {
      nudgeDisplayScale(mainWindow, -DISPLAY_STEP); event.preventDefault()
    } else if (input.key === '=' || input.key === '+') {
      nudgeDisplayScale(mainWindow, DISPLAY_STEP); event.preventDefault()
    } else if (input.key === '0') {
      setDisplayScale(mainWindow, 1); event.preventDefault()
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
    reconcileAllSpaces('window-focus').catch((err) => {
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
  // Capture native crashes (V8 heap OOM, segfault, renderer GPU crashes) that bypass
  // the JS uncaughtException handler. Minidumps are kept locally (uploadToServer:false)
  // under app.getPath('crashDumps') — the only on-disk evidence when the process dies
  // without running any shutdown code.
  crashReporter.start({ uploadToServer: false })
  console.log(`[CrashReporter] Native crash capture enabled, dumps at: ${app.getPath('crashDumps')}`)

  // Detect whether the previous session ended without a graceful shutdown, then arm
  // the marker for this session. Runs as the first whenReady step so a crash during
  // the heavy init that follows is still attributed on the next launch (a crash
  // before whenReady cannot be marked, but is rare).
  checkAndArmSessionIntegrity()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.halo.app')

  // Preview the brand-correct Dock icon in unpackaged dev builds. Packaged
  // builds get their icon baked into the .app by electron-builder and don't
  // need this — without it, dev mode just shows Electron's default icon.
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(getMacIconPath())
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }

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

  // Headless server mode: no window/menu/tray. bootServerMode runs the essential
  // + extended services directly (the GUI path chains Extended init to the
  // window's ready-to-show, which never fires here) and force-starts remote
  // access.
  if (isServerMode()) {
    await bootServerMode().catch((err) => {
      // Fail fast with a non-zero exit so the orchestrator restarts the
      // container instead of leaving a process up with no HTTP server.
      logFatal('[ServerMode] fatal boot error, exiting:', (err as Error)?.stack || err)
      app.exit(1)
    })
    return
  }

  // Create application menu
  createAppMenu()

  // Create window first (before analytics, so Baidu provider can find the window)
  createWindow()

  // Windows/Linux cold start FROM a halo:// link: the URL rides this process's
  // own argv (no second instance exists yet). Buffered until the renderer pulls
  // it via team:consume-pending-invite.
  handleDeepLinkArgv(process.argv)

  // ========================================
  // PHASED INITIALIZATION
  // ========================================
  // See src/main/bootstrap/index.ts for architecture documentation

  // Phase 1: Essential Services (synchronous, required for first screen)
  // These services are needed for the initial UI render
  // Window reference is managed by window.service.ts
  initializeEssentialServices()

  // Phase 2: Extended Services (deferred until the first screen is up)
  // This ensures Extended initialization NEVER affects startup speed.
  //
  // Tied to the same cue that reveals the window rather than to first paint
  // alone: a launch that never paints — the installer's "run when finished"
  // box, the updater relaunching after a swap — would otherwise leave the app
  // running with no tray, no database and no automation, which is far worse
  // than merely having no window.
  registerFirstScreenListener(() => {
    // Yield first so the paint (when there was one) is not competing with it.
    setImmediate(() => {
      initializeExtendedServices()

      // Initialize analytics (after IPC handlers registered and window created)
      initAnalytics().catch(err => console.warn('[Analytics] Init failed:', err))
    })
  })

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

  // Record that a graceful shutdown was initiated. Done first so a normal quit is
  // marked clean even if a later cleanup step is slow; an ungraceful death never
  // reaches this path and so remains flagged on the next launch.
  markSessionCleanExit()

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

// macOS installs an update through Electron's native updater (Squirrel), which
// emits 'before-quit-for-update' *instead of* 'before-quit' and only swaps the
// bundle once every window has actually closed. Without this flag the
// close-to-tray handler hides the window instead of closing it, so the swap
// never runs and the update silently never installs.
if (process.platform === 'darwin') {
  nativeAutoUpdater.on('before-quit-for-update', () => {
    isAppQuitting = true
  })
}

app.on('before-quit', () => {
  isAppQuitting = true
  shutdownServicesWithTimeout(SHUTDOWN_TIMEOUT_MS).catch(console.error)
})

app.on('window-all-closed', () => {
  // Headless server mode: the only BrowserWindows are incidental hidden
  // automation surfaces (daemon / offscreen browser). Their unexpected close
  // (e.g. a renderer OOM in the container) must NOT quit the service — process
  // lifetime is owned by the signal handlers instead.
  if (isServerMode()) return

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
