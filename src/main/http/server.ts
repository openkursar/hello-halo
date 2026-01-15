/**
 * HTTP Server - Remote access server for Halo
 * Exposes REST API and serves the frontend for remote access
 */

import express, { Express, Request, Response } from 'express'
import { createServer, Server, request as httpRequest, IncomingMessage } from 'http'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { createConnection } from 'net'

import { authMiddleware, generateAccessToken, getAccessToken, clearAccessToken, validateToken } from './auth'
import { initWebSocket, shutdownWebSocket, getClientCount } from './websocket'
import { registerApiRoutes } from './routes'

// Vite dev server URL
const VITE_DEV_SERVER = 'http://localhost:5173'
const VITE_DEV_HOST = 'localhost'
const VITE_DEV_PORT = 5173

// Server state
let httpServer: Server | null = null
let expressApp: Express | null = null
let serverPort: number = 0
let mainWindow: BrowserWindow | null = null

// Default port
const DEFAULT_PORT = 3847

/**
 * Start the HTTP server
 */
export async function startHttpServer(
  window: BrowserWindow | null,
  port: number = DEFAULT_PORT
): Promise<{ port: number; token: string }> {
  // Store reference to main window for agent calls
  mainWindow = window

  // Create Express app
  expressApp = express()

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

  // Login endpoint (before auth middleware)
  expressApp.post('/api/remote/login', (req: Request, res: Response) => {
    const { token } = req.body

    if (validateToken(token)) {
      res.json({ success: true })
    } else {
      res.status(401).json({ success: false, error: 'Invalid token' })
    }
  })

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
  registerApiRoutes(expressApp, mainWindow)

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
      // Auth already checked by middleware above
      res.sendFile(join(staticPath, 'index.html'))
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

  // Generate access token
  const token = generateAccessToken()

  // Start listening
  return new Promise((resolve, reject) => {
    httpServer!.listen(port, '0.0.0.0', () => {
      serverPort = port
      console.log(`[HTTP] Server started on port ${port}`)
      console.log(`[HTTP] Access token: ${token}`)
      resolve({ port, token })
    })

    httpServer!.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        // Try next port
        console.log(`[HTTP] Port ${port} in use, trying ${port + 1}`)
        startHttpServer(window, port + 1)
          .then(resolve)
          .catch(reject)
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
  return mainWindow
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
      <input type="text" id="token" maxlength="32" placeholder="000000" autocomplete="off">
    </div>
    <button onclick="login()" style="margin-top: 1rem; width: 100%; max-width: 300px;">Connect</button>
    <p id="error" class="error"></p>
  </div>
  <script>
    async function login() {
      const token = document.getElementById('token').value;
      const error = document.getElementById('error');

      if (!token || token.length < 4) {
        error.textContent = 'Please enter access code';
        return;
      }

      try {
        const res = await fetch('/api/remote/login', {
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
