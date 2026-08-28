/**
 * Express Router
 *
 * Defines API routes for the OpenAI compatibility layer
 */

import express, { type Express, type Request, type Response } from 'express'
import type { AnthropicRequest } from '../types'
import { decodeBackendConfig } from '../utils'
import { handleMessagesRequest, handleCountTokensRequest } from './request-handler'
import { handleResponsesRequest } from './codex-responses-handler'

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
      console.log(`[Router] decode_backend_config_failed endpoint=/v1/messages reason=missing_x_api_key from=${req.ip || ''}:${req.socket?.remotePort ?? ''}`)
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'x-api-key is required' }
      })
    }

    // Decode backend configuration from API key
    const decodedConfig = decodeBackendConfig(String(rawKeyStr))
    if (!decodedConfig) {
      console.log(`[Router] decode_backend_config_failed endpoint=/v1/messages reason=invalid_format raw_head="${String(rawKeyStr).slice(0, 200).replace(/"/g, "'")}" from=${req.ip || ''}:${req.socket?.remotePort ?? ''}`)
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Invalid x-api-key format. Expect base64(JSON.stringify({ url, key, model?, apiType? }))'
        }
      })
    }

    console.log(`[Router] in_detail endpoint=/v1/messages method=${req.method} url=${req.url} from=${req.ip || ''}:${req.socket?.remotePort ?? ''} backend_host=${(() => { try { return new URL(decodedConfig.url).host } catch { return decodedConfig.url } })()} model_override=${decodedConfig.model || ''} api_type=${decodedConfig.apiType || ''} ts=${Date.now()}`)

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

  app.post('/v1/responses', async (req: Request, res: Response) => {
    const rawAuth = req.headers.authorization
    const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined

    if (!token) {
      console.log(`[Router] decode_backend_config_failed endpoint=/v1/responses reason=missing_bearer from=${req.ip || ''}:${req.socket?.remotePort ?? ''}`)
      return res.status(401).json({
        error: { type: 'authentication_error', message: 'Authorization Bearer token is required' }
      })
    }

    const decodedConfig = decodeBackendConfig(token)
    if (!decodedConfig) {
      console.log(`[Router] decode_backend_config_failed endpoint=/v1/responses reason=invalid_format raw_head="${String(token).slice(0, 200).replace(/"/g, "'")}" from=${req.ip || ''}:${req.socket?.remotePort ?? ''}`)
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid Authorization token format. Expect Bearer base64(JSON.stringify({ url, key, model?, apiType? }))'
        }
      })
    }

    console.log(`[Router] in_detail endpoint=/v1/responses method=${req.method} url=${req.url} from=${req.ip || ''}:${req.socket?.remotePort ?? ''} backend_host=${(() => { try { return new URL(decodedConfig.url).host } catch { return decodedConfig.url } })()} model_override=${decodedConfig.model || ''} api_type=${decodedConfig.apiType || ''} ts=${Date.now()}`)

    // Collect SDK headers so the handler can restore session-affinity headers
    // onto the upstream request.
    const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'authorization'])
    const sdkHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key) && value) {
        sdkHeaders[key] = Array.isArray(value) ? value[0] : value
      }
    }

    await handleResponsesRequest(req.body || {}, decodedConfig, res, { debug, timeoutMs, sdkHeaders })
  })

  // Token counting endpoint
  app.post('/v1/messages/count_tokens', (req: Request, res: Response) => {
    const { messages, system, model } = (req.body || {}) as { messages?: unknown; system?: unknown; model?: string }
    const result = handleCountTokensRequest(messages, system, model)
    res.json(result)
  })

  return app
}
