/**
 * Authentication Middleware - Validates remote access tokens
 */

import { Request, Response, NextFunction } from 'express'

// Store active tokens (in memory, reset on restart)
let accessToken: string | null = null

/**
 * Generate a new access token
 */
export function generateAccessToken(): string {
  // Generate a simple 6-digit PIN for easy mobile entry
  const pin = Math.floor(100000 + Math.random() * 900000).toString()
  accessToken = pin
  // Don't log the actual token for security - it's displayed in the UI
  console.log('[Auth] New access token generated')
  return pin
}

/**
 * Set a custom access token (user-defined password)
 * @param token The custom password to set (4-32 characters)
 * @returns true if set successfully, false if validation failed
 */
export function setCustomAccessToken(token: string): boolean {
  // Validate: 4-32 alphanumeric characters
  if (!token || token.length < 4 || token.length > 32) {
    console.log('[Auth] Custom token rejected: length must be 4-32 characters')
    return false
  }

  // Allow alphanumeric characters only for simplicity
  if (!/^[a-zA-Z0-9]+$/.test(token)) {
    console.log('[Auth] Custom token rejected: only alphanumeric characters allowed')
    return false
  }

  accessToken = token
  console.log('[Auth] Custom access token set')
  return true
}

/**
 * Get current access token
 */
export function getAccessToken(): string | null {
  return accessToken
}

/**
 * Clear access token (disable remote access)
 */
export function clearAccessToken(): void {
  accessToken = null
  console.log('[Auth] Access token cleared')
}

/**
 * Validate a token
 */
export function validateToken(token: string): boolean {
  if (!accessToken) return false
  return token === accessToken
}

/**
 * Express authentication middleware
 * Note: This middleware is applied to /api routes only
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip auth for static files, login page, and Vite module requests
  if (
    req.path === '/api/remote/login' ||
    req.path === '/api/remote/status' ||
    req.path.startsWith('/assets') ||
    req.path === '/' ||
    req.path === '/index.html' ||
    req.path === '/favicon.ico' ||
    // Skip Vite module requests (source files)
    req.path.endsWith('.ts') ||
    req.path.endsWith('.tsx') ||
    req.path.endsWith('.js') ||
    req.path.endsWith('.jsx') ||
    req.path.endsWith('.css') ||
    req.path.endsWith('.svg') ||
    req.path.endsWith('.png') ||
    req.path.endsWith('.jpg') ||
    req.path.endsWith('.woff') ||
    req.path.endsWith('.woff2') ||
    req.path.includes('@vite') ||
    req.path.includes('node_modules')
  ) {
    return next()
  }

  // Check authorization header or query token (for downloads)
  const authHeader = req.headers.authorization
  const queryToken = req.query.token as string | undefined
  console.log(`[Auth] ${req.method} ${req.path} - authHeader: ${authHeader ? 'present' : 'missing'}, queryToken: ${queryToken ? 'present' : 'missing'}`)

  // Try header first, then query parameter (for file downloads)
  let token: string | null = null
  if (authHeader) {
    // Support "Bearer <token>" format
    token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader
  } else if (queryToken) {
    token = queryToken
  }

  if (!token) {
    res.status(401).json({ success: false, error: 'No authorization token' })
    return
  }

  const isValid = validateToken(token)
  // Don't log the expected token for security
  console.log(`[Auth] Token validation: ${isValid ? 'valid' : 'invalid'}`)

  if (!isValid) {
    res.status(401).json({ success: false, error: 'Invalid token' })
    return
  }

  next()
}

/**
 * WebSocket authentication (called from upgrade handler)
 */
export function authenticateWebSocket(token: string): boolean {
  return validateToken(token)
}
