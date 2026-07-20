/**
 * Express middleware for the authenticated `/api/*` surface and the
 * login route. Two responsibilities:
 *
 *   1. `authMiddleware` — gate `/api/*` on a valid bearer token. Static
 *      assets and the public endpoints (login, status) are skipped.
 *   2. `handleLogin` — the `/api/remote/login` handler. Applies rate-
 *      limit + lockout + audit + alert. Returns 429 when locked, 401 on
 *      bad credentials, 200 on success.
 *
 * Token validation always goes through {@link validateToken} so the
 * timing-safe compare is the single source of truth.
 */

import type { Request, Response, NextFunction } from 'express'

import { validateToken } from './token-store'
import { checkLock, recordFailure, recordSuccess } from './rate-limit'
import { logAuthEvent } from './audit'
import { notifyLockout } from './alert'
import { parseCredentialType, verifyOfficeCredential, type OfficeCredential } from './office-credential'
import { matchOfficeScope } from './route-scope'

// Augment Express's Request so the office credential attached by authMiddleware
// is typed end-to-end instead of cast through `any`. express-serve-static-core is
// the type package that actually declares Request (express re-exports it).
declare module 'express-serve-static-core' {
  interface Request {
    /** Set by authMiddleware on an office-credential-authenticated request. */
    officeCredential?: OfficeCredential
  }
}

// Paths under /api/* that are reachable without a valid token. Anything
// else under /api/* must present credentials — the static-suffix rule
// below MUST NOT short-circuit /api/* paths or a future route ending in
// .json (or any other static extension) would silently bypass auth.
const PUBLIC_PATHS = new Set([
  '/api/remote/login',
  '/api/remote/status',
  // Renderer-safe security policy slice. Read before login so the UI can
  // render the correct gate (e.g. hide tunnel section). Returned shape is
  // built by getPublicSecurityPolicy() and contains no secrets.
  '/api/security/policy',
])

const STATIC_SUFFIXES = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.map',
]

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true
  // /api/* is the authenticated surface. Never let a suffix-based rule
  // grant access here — only the explicit PUBLIC_PATHS allowlist applies.
  if (path.startsWith('/api/')) return false
  if (path === '/' || path === '/index.html' || path === '/favicon.ico') return true
  if (path.startsWith('/assets')) return true
  if (path.includes('@vite') || path.includes('node_modules')) return true
  return STATIC_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

// RFC 6750 allows the "Bearer" scheme to be matched case-insensitively;
// some clients send lowercase. Reject anything that doesn't match so a
// stray "Basic ..." header is not treated as a token (which would poison
// the lockout counters on the login route and produce confusing audit
// entries on the /api/* gate).
const BEARER_PATTERN = /^Bearer\s+(\S.*)$/i

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization
  if (authHeader) {
    const match = BEARER_PATTERN.exec(authHeader)
    return match ? match[1].trim() : null
  }
  const queryToken = req.query.token
  if (typeof queryToken === 'string') return queryToken
  return null
}

function clientIp(req: Request): string {
  // Prefer the socket address — `req.ip` honours `trust proxy` which is
  // off by default and intentionally so for a local server: a forged
  // X-Forwarded-For must not be able to evade the per-IP counter.
  return req.socket.remoteAddress || 'unknown'
}

/**
 * `/api/*` gate. Public paths and static-looking paths are passed
 * through so the renderer can boot before login. Everything else must
 * present a valid token.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req.path)) {
    return next()
  }

  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ success: false, error: 'No authorization token' })
    return
  }

  // An office-member token MUST NEVER fall through to validateToken — that
  // would grant full /api/* access. The two systems are strictly independent.
  if (parseCredentialType(token) === 'office-member') {
    const cred = verifyOfficeCredential(token)
    if (!cred) {
      res.status(401).json({ success: false, error: 'Invalid token' })
      return
    }
    if (!matchOfficeScope(req.method, req.path)) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }
    req.officeCredential = cred
    next()
    return
  }

  if (!validateToken(token)) {
    // No audit/lockout side effects here — /api/* surface is for already
    // authenticated clients hitting downstream endpoints. The login path
    // owns failure accounting.
    res.status(401).json({ success: false, error: 'Invalid token' })
    return
  }

  next()
}

/**
 * Typed accessor for the office credential attached by {@link authMiddleware}.
 * Downstream team read-only routes use this to scope responses to the office.
 * Returns null on requests authenticated by the remote-control PIN.
 */
export function getOfficeCredential(req: Request): OfficeCredential | null {
  return req.officeCredential ?? null
}

/**
 * `POST /api/remote/login` handler. Mounted by server.ts before the
 * `authMiddleware` so unauthenticated callers can present credentials.
 */
export function handleLogin(req: Request, res: Response): void {
  const ip = clientIp(req)
  const ua = (req.headers['user-agent'] as string) || ''
  const submitted = req.body?.token

  const lock = checkLock(ip)
  if (lock.locked) {
    logAuthEvent('login_blocked', { ip, ua, reason: lock.reason })
    res
      .status(429)
      .set('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)))
      .json({
        success: false,
        error: 'Too many failed attempts. Try again later.',
        code: 'LOCKED',
      })
    return
  }

  if (typeof submitted === 'string' && validateToken(submitted)) {
    recordSuccess(ip)
    logAuthEvent('login_success', { ip, ua })
    res.json({ success: true })
    return
  }

  const outcome = recordFailure(ip)
  logAuthEvent('login_fail', { ip, ua })
  if (outcome.newlyLocked && outcome.reason) {
    logAuthEvent('lockout_start', { ip, reason: outcome.reason, retryAfterMs: outcome.retryAfterMs })
    notifyLockout(outcome.reason, ip)
  }

  res.status(401).json({ success: false, error: 'Invalid token' })
}

/**
 * WebSocket authentication entry point. Participates in the same IP/target
 * lockout as the HTTP login: nothing forces a WS client through the HTTP
 * login first, so an unthrottled 'auth' message would let an attacker
 * brute-force the credential while bypassing the login lockout entirely.
 */
export function authenticateWebSocket(token: string, ip: string): boolean {
  if (checkLock(ip).locked) {
    logAuthEvent('ws_auth_blocked', { ip })
    return false
  }

  if (validateToken(token)) {
    recordSuccess(ip)
    logAuthEvent('ws_auth_success', { ip })
    return true
  }

  const outcome = recordFailure(ip)
  logAuthEvent('ws_auth_fail', { ip })
  if (outcome.newlyLocked && outcome.reason) {
    logAuthEvent('lockout_start', { ip, reason: outcome.reason, retryAfterMs: outcome.retryAfterMs })
    notifyLockout(outcome.reason, ip)
  }
  return false
}
