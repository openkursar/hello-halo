/**
 * Express Router
 *
 * Defines API routes for the OpenAI compatibility layer
 */

import express, { type Express, type Request, type Response } from 'express'
import type { AnthropicRequest } from '../types'
import { decodeBackendConfig } from '../utils'
import { handleMessagesRequest, handleCountTokensRequest } from './request-handler'

export interface RouterOptions {
  debug?: boolean
  timeoutMs?: number
}

/**
 * Create and configure the Express application
 */
export function createApp(options: RouterOptions = {}): Express {
  const app = express()
  const { debug = false, timeoutMs } = options

  // Body parser with large limit for images
  // verify callback captures the raw body buffer before JSON parsing,
  // enabling zero-cost forwarding when interceptors don't modify the request.
  app.use(express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf
    }
  }))

  // Request logging middleware (production-level)
  app.use((req, _res, next) => {
    console.log(`[Router] ${req.method} ${req.url}`)
    next()
  })

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // Main messages endpoint
  app.post('/v1/messages', async (req: Request, res: Response) => {
    const anthropicRequest = (req.body || {}) as AnthropicRequest

    // Extract API key from header
    const rawKey = req.headers['x-api-key']
    const rawKeyStr = Array.isArray(rawKey) ? rawKey[0] : rawKey

    if (!rawKeyStr) {
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'x-api-key is required' }
      })
    }

    // Decode backend configuration from API key
    const decodedConfig = decodeBackendConfig(String(rawKeyStr))
    if (!decodedConfig) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid x-api-key format. Expect base64(JSON.stringify({ url, key, model?, apiType? }))'
        }
      })
    }

    // Handle the request
    // Forward all SDK headers for transparent passthrough, excluding hop-by-hop
    // headers and those that will be overridden by fetchAnthropicUpstream.
    // Upstream may validate any header at any time — we must not silently drop them.
    const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'x-api-key'])
    const sdkHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key) && value) {
        sdkHeaders[key] = Array.isArray(value) ? value[0] : value
      }
    }
    const queryString = req.url.includes('?') ? req.url.split('?')[1] : undefined

    const rawBody = (req as any).rawBody as Buffer | undefined

    await handleMessagesRequest(anthropicRequest, decodedConfig, res, {
      debug, timeoutMs, sdkHeaders, queryString, rawBody
    })
  })

  // Token counting endpoint
  app.post('/v1/messages/count_tokens', (req: Request, res: Response) => {
    const { messages, system } = (req.body || {}) as { messages?: unknown; system?: unknown }
    const result = handleCountTokensRequest(messages, system)
    res.json(result)
  })

  return app
}
