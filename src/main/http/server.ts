/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * HTTP Server - Remote access server for Halo
 * Exposes REST API and serves the frontend for remote access
 */

import express, { Express, Request, Response, Router, NextFunction } from 'express'
import { createServer, Server, request as httpRequest, IncomingMessage } from 'http'
import { join } from 'path'
import { readFileSync } from 'fs'
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { createConnection, createServer as createNetServer } from 'net'

import {
  authMiddleware,
  generateAccessToken,
  getAccessToken,
  clearAccessToken,
  restoreAccessToken,
  handleLogin,
  CredentialRestoreError,
} from './auth'
import { ACCESS_CODE_MIN_SUBMIT_LENGTH, PASSWORD_MAX_LENGTH } from '../../shared/auth/password-policy'
import { initWebSocket, shutdownWebSocket, getClientCount } from './websocket'
import { registerApiRoutes } from './routes'
import { getMainWindow as getMainWindowFromService } from '../foundation/window.service'

// Vite dev server URL
const VITE_DEV_SERVER = 'http://localhost:5173'
const VITE_DEV_HOST = 'localhost'
const VITE_DEV_PORT = 5173

// Server state
let httpServer: Server | null = null
let expressApp: Express | null = null
let serverPort: number = 0

// Default port
const DEFAULT_PORT = 3847
const MAX_PORT_SEARCH_ATTEMPTS = 20

// ---------------------------------------------------------------------------
// Webhook ingress
// ---------------------------------------------------------------------------

// Mount point and body limit. The limit must match the contract expected by
// apps/runtime WebhookSource (MAX_BODY_BYTES = 256KB).
const WEBHOOK_INGRESS_PATH = '/hooks'
const WEBHOOK_INGRESS_BODY_LIMIT = '256kb'

// The ingress router is a process-lifetime singleton, NOT tied to a server
// instance: apps/runtime initializes (and mounts WebhookSource routes) before
// the HTTP server first starts, and the server may be stopped/restarted with
// a fresh Express app at any time. Each startHttpServer() re-attaches this
// same router, so routes registered on it survive server restarts.
let webhookIngressRouter: Router | null = null

/**
 * Get the webhook ingress router (mounted at /hooks ahead of auth and
 * frontend fallbacks whenever the HTTP server runs). apps/runtime
 * WebhookSource registers its routes here; safe to call before the server
 * has ever started.
 */
export function getWebhookIngressRouter(): Router {
  if (!webhookIngressRouter) {
    webhookIngressRouter = express.Router()
  }
  return webhookIngressRouter
}

/**
 * Mount the webhook ingress on a freshly created Express app, ahead of every
 * other middleware, so external callers (GitHub, Stripe, ...) are never
 * intercepted by the global JSON body limit, auth middleware, or frontend
 * fallbacks. Authentication is per-hook HMAC inside WebhookSource.
 *
 * Chain: content-type guard -> dedicated JSON parser (webhook body limit +
 * raw bytes for HMAC -- re-serialized JSON is not byte-identical) -> ingress
 * router -> 404 terminal (no route consumed the request, e.g. automation
 * runtime inactive) -> JSON error handler (body-parser errors such as 413
 * must never leak an HTML stack trace to external callers).
 */
function attachWebhookIngress(app: Express): void {
  app.use(WEBHOOK_INGRESS_PATH, (req: Request, res: Response, next: NextFunction) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Webhook payloads must be application/json' })
      return
    }
    next()
  })
  app.use(
    WEBHOOK_INGRESS_PATH,
    express.json({
      limit: WEBHOOK_INGRESS_BODY_LIMIT,
      verify: (req, _res, buf) => {
        ;(req as Request & { rawBody?: Buffer }).rawBody = buf
      }
    }),
    getWebhookIngressRouter()
  )
  app.use(WEBHOOK_INGRESS_PATH, (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Webhook ingress not available' })
  })
  app.use(WEBHOOK_INGRESS_PATH, (err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    console.warn(`[HTTP] Webhook ingress request rejected: ${err.message}`)
    res.status(err.status ?? 400).json({ error: 'Invalid webhook request' })
  })
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer()
    tester.once('error', () => {
      tester.close(() => resolve(false))
    })
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, '0.0.0.0')
  })
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let i = 0; i < MAX_PORT_SEARCH_ATTEMPTS; i++) {
    const portToTry = startPort + i
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(portToTry)
    if (available) {
      if (i > 0) {
        console.warn(`[HTTP] Port ${startPort} is in use, falling back to ${portToTry}`)
      }
      return portToTry
    }
  }
  throw new Error(`Unable to find available port near ${startPort}`)
}

function cleanupServerOnError(): void {
  shutdownWebSocket()
  if (httpServer) {
    try {
      httpServer.removeAllListeners('error')
      httpServer.close()
    } catch (err) {
      console.warn('[HTTP] Error closing server after failure:', (err as Error).message)
    }
    httpServer = null
  }
  expressApp = null
  serverPort = 0
  clearAccessToken()
}

/**
 * Start the HTTP server
 *
 * @param port            Preferred port. Falls back to the next available one
 *                        if it is occupied.
 * @param existingToken   Previously persisted access token. When provided and
 *                        non-empty, the server restores it instead of
 *                        generating a fresh one. Callers (remote.service)
 *                        are responsible for persisting newly generated
 *                        tokens to config.
 */
export async function startHttpServer(
  port: number = DEFAULT_PORT,
  existingToken?: string
): Promise<{ port: number; token: string }> {
  const listenPort = await findAvailablePort(port)

  // Create Express app
  expressApp = express()

  attachWebhookIngress(expressApp)

  // Middleware
  expressApp.use(express.json())
  expressApp.use(express.urlencoded({ extended: true }))

  // CORS for remote access
  expressApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      return res.sendStatus(200)
    }
    next()
  })

  // Login endpoint (before auth middleware). Owns rate-limit + lockout
  // + audit + alert via the auth module.
  expressApp.post('/api/remote/login', handleLogin)

  // Status endpoint (public)
  expressApp.get('/api/remote/status', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        active: true,
        clients: getClientCount(),
        version: '1.0.0'
      }
    })
  })

  // Auth middleware for API routes
  expressApp.use('/api', authMiddleware)

  // Register API routes
  registerApiRoutes(expressApp)

  // Serve static files (frontend)
  if (is.dev) {
    // In development, proxy to Vite dev server
    expressApp.use('/{*path}', (req, res) => {
      // Check if authenticated (has valid token in query or localStorage check via cookie)
      const urlToken = req.query.token as string
      const authHeader = req.headers.authorization
      const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader

      // If accessing root without auth, show login page
      if (req.path === '/' && !urlToken && !headerToken) {
        // Check cookie for token
        const cookies = req.headers.cookie || ''
        const hasToken = cookies.includes('halo_authenticated=true')
        if (!hasToken) {
          return res.send(getRemoteLoginPage())
        }
      }

      // Proxy to Vite dev server
      const viteUrl = new URL(req.originalUrl, VITE_DEV_SERVER)

      const proxyReq = httpRequest(viteUrl, {
        method: req.method,
        headers: {
          ...req.headers,
          host: new URL(VITE_DEV_SERVER).host
        }
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
        proxyRes.pipe(res)
      })

      proxyReq.on('error', (err) => {
        console.error('[HTTP] Proxy error:', err)
        res.status(502).send('Vite dev server not available')
      })

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.pipe(proxyReq)
      } else {
        proxyReq.end()
      }
    })
  } else {
    // In production, serve built files
    const staticPath = join(__dirname, '../renderer')

    // Authentication check middleware for production
    expressApp.use((req, res, next) => {
      // Skip for API routes (handled by authMiddleware)
      if (req.path.startsWith('/api')) {
        return next()
      }

      // Skip for static assets
      if (
        req.path.startsWith('/assets') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.svg') ||
        req.path.endsWith('.png') ||
        req.path.endsWith('.ico') ||
        req.path.endsWith('.woff') ||
        req.path.endsWith('.woff2')
      ) {
        return next()
      }

      // Check if authenticated via cookie
      const cookies = req.headers.cookie || ''
      const hasToken = cookies.includes('halo_authenticated=true')

      // If not authenticated, show login page
      if (!hasToken) {
        return res.send(getRemoteLoginPage())
      }

      next()
    })

    expressApp.use(express.static(staticPath))

    // SPA fallback - Express 5.x requires named wildcard parameters
    expressApp.get('/{*path}', (req, res) => {
      // Auth already checked by middleware above. Serve the guard-injected shell.
      res.type('html').send(getSpaShellHtml(staticPath))
    })
  }

  // Create HTTP server
  httpServer = createServer(expressApp)

  // Initialize WebSocket (for Halo communication on /ws path)
  initWebSocket(httpServer)

  // In dev mode, proxy Vite HMR WebSocket connections
  if (is.dev) {
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`)

      // Don't intercept Halo's WebSocket connections
      if (url.pathname === '/ws') {
        // Let the wss server handle it (already done by initWebSocket)
        return
      }

      // Proxy other WebSocket connections to Vite dev server
      console.log(`[HTTP] Proxying WebSocket upgrade: ${url.pathname}`)

      const viteSocket = createConnection(VITE_DEV_PORT, VITE_DEV_HOST, () => {
        // Forward the upgrade request to Vite
        const upgradeRequest = [
          `GET ${req.url} HTTP/1.1`,
          `Host: ${VITE_DEV_HOST}:${VITE_DEV_PORT}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
          `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}`,
          '',
          ''
        ].join('\r\n')

        viteSocket.write(upgradeRequest)
        viteSocket.write(head)

        // Pipe data between client and Vite
        socket.pipe(viteSocket)
        viteSocket.pipe(socket)
      })

      viteSocket.on('error', (err) => {
        console.error('[HTTP] Vite WebSocket proxy error:', err.message)
        socket.end()
      })

      socket.on('error', (err) => {
        console.error('[HTTP] Client WebSocket error:', err.message)
        viteSocket.end()
      })
    })
  }

  // Restore previously persisted token when available; otherwise generate a
  // fresh PIN. Persistence of newly generated tokens is owned by the caller
  // (remote.service.ts) to keep this layer free of config concerns. The
  // raw stored value may be encoded (gmcred:v1:...) when
  // `credentialAtRestSafe` is on; restoreAccessToken decodes internally and
  // exposes the plaintext via getAccessToken so the UI keeps working.
  //
  // Fail-loud on restore failure: when an existing credential is present
  // but cannot be decoded (corrupted ciphertext, key derivation drift,
  // profile migration), we refuse to start instead of silently rotating
  // the PIN. Silent rotation would invalidate every previously paired
  // device without telling the user; the caller (remote.service) catches
  // this error, disables remote access in config, and surfaces a code so
  // the UI can prompt for a manual re-pair.
  let token: string
  if (existingToken && existingToken.length >= 4) {
    const restored = restoreAccessToken(existingToken)
    if (!restored.ok) {
      cleanupServerOnError()
      throw new CredentialRestoreError()
    }
    token = getAccessToken() as string
  } else {
    token = generateAccessToken()
  }

  // Start listening
  return new Promise((resolve, reject) => {
    httpServer!.listen(listenPort, '0.0.0.0', () => {
      serverPort = listenPort
      console.log(`[HTTP] Server started on port ${listenPort}`)
      console.log(`[HTTP] Access token: ${token}`)
      resolve({ port: listenPort, token })
    })

    httpServer!.on('error', (error: NodeJS.ErrnoException) => {
      console.error('[HTTP] Server error:', error.message)
      cleanupServerOnError()
      if (error.code === 'EADDRINUSE') {
        const nextPort = listenPort + 1
        console.log(`[HTTP] Port ${listenPort} still in use, trying ${nextPort}`)
        startHttpServer(nextPort, existingToken).then(resolve).catch(reject)
      } else {
        reject(error)
      }
    })
  })
}

/**
 * Stop the HTTP server
 */
export function stopHttpServer(): void {
  if (httpServer) {
    shutdownWebSocket()
    httpServer.close()
    httpServer = null
    expressApp = null
    serverPort = 0
    clearAccessToken()
    console.log('[HTTP] Server stopped')
  }
}

/**
 * Check if server is running
 */
export function isServerRunning(): boolean {
  return httpServer !== null
}

/**
 * Get server info
 */
export function getServerInfo(): {
  running: boolean
  port: number
  token: string | null
  clients: number
} {
  return {
    running: isServerRunning(),
    port: serverPort,
    token: getAccessToken(),
    clients: getClientCount()
  }
}

/**
 * Get main window reference (for agent controller)
 */
export function getMainWindow(): BrowserWindow | null {
  return getMainWindowFromService()
}

/**
 * Get the Express app instance (for webhook route mounting).
 * Returns null if the HTTP server is not running.
 */
export function getExpressApp(): Express | null {
  return expressApp
}

/**
 * Path-prefix guard injected into the SPA shell the headless server returns.
 *
 * Behind a reverse proxy that mounts the app under a path prefix with no trailing
 * slash, the browser resolves relative asset/API/WS URLs against the parent
 * directory and drops the prefix → 404. The proxy collapses both the slashed and
 * unslashed forms to `/` before the request reaches us, so only the browser can
 * distinguish them — the fix must run client-side. It lives here, not in the
 * shared renderer entry, to keep that entry deployment-agnostic.
 */
const PATH_PREFIX_GUARD =
  `<script>(function(){try{` +
  `if('halo' in window)return;` +
  `if(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform())return;` +
  `if(location.protocol!=='http:'&&location.protocol!=='https:')return;` +
  `var p=location.pathname;` +
  `if(p&&p.charAt(p.length-1)!=='/'&&!/\\.[^/]+$/.test(p)){location.replace(p+'/'+location.search+location.hash);}` +
  `}catch(e){}})();</script>`

/**
 * SPA shell with the path-prefix guard as the first <head> child, so it runs
 * before any relative asset tag. Cached: the built index.html is immutable for
 * the process lifetime.
 */
let cachedSpaShellHtml: string | null = null
function getSpaShellHtml(staticPath: string): string {
  if (cachedSpaShellHtml) return cachedSpaShellHtml
  const raw = readFileSync(join(staticPath, 'index.html'), 'utf-8')
  cachedSpaShellHtml = raw.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${PATH_PREFIX_GUARD}`)
  return cachedSpaShellHtml
}

/**
 * Simple login page HTML for remote access
 */
function getRemoteLoginPage(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Path-prefix guard: with no trailing slash behind a proxy prefix, the
       relative login fetch drops the prefix → 404. Normalize to a trailing slash. -->
  <script>
    (function () {
      try {
        var p = location.pathname;
        if (p && p.charAt(p.length - 1) !== '/' && !/\\.[^/]+$/.test(p)) {
          location.replace(p + '/' + location.search + location.hash);
        }
      } catch (e) {}
    })();
  </script>
  <title>Halo Remote Access</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .logo {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      margin: 0 auto 1.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2rem;
      box-shadow: 0 0 30px rgba(102, 126, 234, 0.4);
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #888; margin-bottom: 2rem; }
    .input-group {
      display: flex;
      gap: 0.5rem;
      max-width: 300px;
      margin: 0 auto;
    }
    input {
      flex: 1;
      padding: 1rem;
      border: 1px solid #333;
      border-radius: 12px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-size: 1.5rem;
      text-align: center;
      letter-spacing: 0.5em;
    }
    input:focus { outline: none; border-color: #667eea; }
    button {
      padding: 1rem 2rem;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      font-size: 1rem;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover { transform: scale(1.05); }
    .error { color: #ff6b6b; margin-top: 1rem; }
    .success { color: #4ade80; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">◯</div>
    <h1>Halo Remote Access</h1>

    <p>Enter access code to connect to your desktop</p>
    <div class="input-group">
      <input type="password" id="token" maxlength="${PASSWORD_MAX_LENGTH}" placeholder="Access Code" autocomplete="off">
    </div>
    <button onclick="login()" style="margin-top: 1rem; width: 100%; max-width: 300px;">Connect</button>
    <p id="error" class="error"></p>
  </div>
  <script>
    async function login() {
      const token = document.getElementById('token').value;
      const error = document.getElementById('error');

      if (!token || token.length < ${ACCESS_CODE_MIN_SUBMIT_LENGTH}) {
        error.textContent = 'Please enter access code';
        return;
      }

      try {
        const res = await fetch('api/remote/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });

        if (res.ok) {
          localStorage.setItem('halo_remote_token', token);
          // Set cookie for server-side auth check
          document.cookie = 'halo_authenticated=true; path=/';
          error.textContent = '';
          error.classList.remove('error');
          error.classList.add('success');
          error.textContent = 'Connected! Loading...';

          // Reload to get the full app (will be proxied to Vite)
          setTimeout(() => location.reload(), 500);
        } else {
          error.textContent = 'Invalid code';
        }
      } catch (e) {
        error.textContent = 'Connection failed';
      }
    }

    // Auto-focus input
    document.getElementById('token').focus();

    // Enter key to submit
    document.getElementById('token').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>
  `
}
