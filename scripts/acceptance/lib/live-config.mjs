import fs from 'node:fs/promises'
import { z } from 'zod'
import { hash } from './catalog.mjs'

const configSchema = z.object({
  upstream: z.string().url(), protocol: z.enum(['openai', 'anthropic']), model: z.string().min(1),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN)[A-Z0-9_]*$/),
  maxRequests: z.number().int().min(1).max(64).default(8),
  maxOutputTokens: z.number().int().min(1).max(65536).default(1024),
  maxInputBytes: z.number().int().min(1).max(32 * 1024 * 1024).default(128 * 1024),
  timeoutMs: z.number().int().min(1).max(600000).default(120000),
}).strict()

export async function loadLiveConfig(filename, { requireCredential = false, environment = process.env } = {}) {
  if (!filename) return null
  let value
  try { value = JSON.parse(await fs.readFile(filename, 'utf8')) }
  catch { throw new Error('The live model configuration could not be read as JSON') }
  const config = configSchema.parse(value)
  const url = new URL(config.upstream)
  if (url.username || url.password || url.search || url.hash) throw new Error('Live model upstream must not contain credentials, query parameters or fragments')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('Live model upstream must use HTTPS, except for an explicit local test server')
  const apiKey = environment[config.apiKeyEnv]
  if (requireCredential && !apiKey?.trim()) throw new Error('The dedicated live-test credential environment variable is not configured')
  return { config, apiKey, public: { identity: hash(config), protocol: config.protocol, model: config.model, limits: { maxRequests: config.maxRequests, maxOutputTokens: config.maxOutputTokens, maxInputBytes: config.maxInputBytes, timeoutMs: config.timeoutMs } } }
}
