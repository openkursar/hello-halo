import express, { type RequestHandler } from 'express'
import { MAX_IMAGES, MAX_IMAGE_SIZE, MAX_IMAGE_DIMENSION } from '../../shared/constants/chat-attachments'

// Cover the full composer batch, base64 expansion and 1 MiB of text/metadata.
// Canvas encoding can grow a source file; allow RGBA pixels plus PNG overhead too.
const imageBytes = Math.max(MAX_IMAGE_SIZE, MAX_IMAGE_DIMENSION ** 2 * 4 + 64 * 1024)
export const CHAT_BODY_LIMIT = MAX_IMAGES * Math.ceil(imageBytes / 3) * 4 + 1024 * 1024

// Match Express's case-insensitive routes and optional trailing slash.
const chatPath = /^\/api\/(?:agent\/message|apps\/[^/]+\/chat\/send|teams\/[^/]+\/members\/[^/]+\/send)\/?$/i

export function isChatRequest(method: string, path: string): boolean {
  return method === 'POST' && chatPath.test(path)
}

const parseJson = express.json({ limit: CHAT_BODY_LIMIT })

/** Mounted only after API authentication; the default parser must skip these paths. */
export const parseChatBody: RequestHandler = (req, res, next) => {
  if (!isChatRequest(req.method, req.path)) return next()
  parseJson(req, res, (error?: { type?: string }) => {
    if (!error) return next()
    if (error.type !== 'entity.too.large' && error.type !== 'entity.parse.failed') return next(error)
    const tooLarge = error.type === 'entity.too.large'
    console.warn(`[HTTP] Chat request body rejected: ${error.type}`)
    res.status(tooLarge ? 413 : 400).json({
      success: false,
      code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
      error: tooLarge ? 'Request is too large. Reduce the attachment size or shorten the text.' : 'Invalid JSON request body',
    })
  })
}
