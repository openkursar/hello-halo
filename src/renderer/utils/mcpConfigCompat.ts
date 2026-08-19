import type { McpServerConfig } from '../../shared/apps/spec-types'

export type McpJsonConfig =
  | {
    type?: 'stdio'
    command: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
  }
  | {
    type: 'sse' | 'http' | 'streamable-http'
    url: string
    headers?: Record<string, string>
    env?: Record<string, string>
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateStringArray(value: unknown, fieldName: string): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      return `${fieldName}[${i}] must be a string`
    }
  }
  return null
}

function validateStringRecord(value: unknown, fieldName: string): string | null {
  if (value === undefined) return null
  if (!isRecord(value)) {
    return `${fieldName} must be an object`
  }
  for (const [key, entry] of Object.entries(value)) {
    const t = typeof entry
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      return `${fieldName}.${key} must be a string, number, or boolean`
    }
  }
  return null
}

function looksLikeServerConfig(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ('command' in value || 'url' in value || 'type' in value || 'transport' in value)
}

/**
 * Canonicalize external `type` variants seen in the wild:
 * `streamable_http` / `Streamable-HTTP` → `streamable-http`, etc.
 */
function canonicalExternalType(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.trim().toLowerCase().replace(/_/g, '-')
}

/** A server config plus the name recovered from its wrapper key, if any */
export interface UnwrappedMcpServer {
  name?: string
  config: Record<string, unknown>
}

/**
 * Tolerant unwrapping of pasted MCP JSON. Accepts every clipboard shape the
 * ecosystem produces (see issue #126):
 * - direct server config:        `{ "command": ... }` / `{ "type": "http", "url": ... }`
 * - Cursor / Claude Desktop:     `{ "mcpServers": { "name": { ... } } }` (1..n servers)
 * - bare name-keyed wrapper:     `{ "name": { ... } }` (1..n servers)
 */
export function unwrapMcpJson(parsed: unknown): { servers?: UnwrappedMcpServer[]; error?: string } {
  if (!isRecord(parsed)) {
    return { error: 'Configuration must be an object' }
  }

  // Direct config takes precedence — its top-level keys identify it unambiguously.
  if (looksLikeServerConfig(parsed)) {
    return { servers: [{ config: parsed }] }
  }

  const map = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const entries = Object.entries(map)
  if (entries.length > 0 && entries.every(([, value]) => looksLikeServerConfig(value))) {
    return {
      servers: entries.map(([name, config]) => ({ name, config: config as Record<string, unknown> }))
    }
  }

  return { error: 'Invalid format: requires command (stdio) or type + url (http/sse)' }
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries: [string, string][] = []
  for (const [key, entry] of Object.entries(value)) {
    const t = typeof entry
    if (t === 'string' || t === 'number' || t === 'boolean') {
      entries.push([key, String(entry)])
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function normalizeInternalConfig(config: Record<string, unknown>): McpServerConfig {
  const transport = (config.transport as McpServerConfig['transport'] | undefined) ?? 'stdio'
  return {
    transport,
    command: String(config.command).trim(),
    ...(Array.isArray(config.args) && config.args.length > 0 ? { args: config.args as string[] } : {}),
    ...(normalizeStringRecord(config.env) ? { env: normalizeStringRecord(config.env)! } : {}),
    ...(normalizeStringRecord(config.headers) ? { headers: normalizeStringRecord(config.headers)! } : {}),
    ...(typeof config.cwd === 'string' && config.cwd.trim() ? { cwd: config.cwd.trim() } : {}),
  }
}

function normalizeExternalConfig(config: Record<string, unknown>): McpServerConfig {
  const type = canonicalExternalType(config.type) as 'stdio' | 'sse' | 'http' | 'streamable-http' | undefined
  if (type === 'sse' || type === 'http' || type === 'streamable-http') {
    return {
      transport: type === 'sse' ? 'sse' : 'streamable-http',
      command: String(config.url).trim(),
      ...(normalizeStringRecord(config.headers) ? { headers: normalizeStringRecord(config.headers)! } : {}),
      ...(normalizeStringRecord(config.env) ? { env: normalizeStringRecord(config.env)! } : {}),
    }
  }

  return {
    transport: 'stdio',
    command: String(config.command).trim(),
    ...(Array.isArray(config.args) && config.args.length > 0 ? { args: config.args as string[] } : {}),
    ...(normalizeStringRecord(config.env) ? { env: normalizeStringRecord(config.env)! } : {}),
    ...(typeof config.cwd === 'string' && config.cwd.trim() ? { cwd: config.cwd.trim() } : {}),
  }
}

function validateInternalConfig(config: Record<string, unknown>): string | null {
  const transport = config.transport
  if (transport !== undefined && transport !== 'stdio' && transport !== 'sse' && transport !== 'streamable-http') {
    return 'transport must be one of: stdio, sse, streamable-http'
  }
  if (typeof config.command !== 'string' || !config.command.trim()) {
    return 'command must be a non-empty string'
  }
  const argsError = validateStringArray(config.args, 'args')
  if (argsError) return argsError
  const envError = validateStringRecord(config.env, 'env')
  if (envError) return envError
  const headersError = validateStringRecord(config.headers, 'headers')
  if (headersError) return headersError
  if (config.cwd !== undefined && typeof config.cwd !== 'string') {
    return 'cwd must be a string'
  }
  if ((transport === 'sse' || transport === 'streamable-http')) {
    try {
      new URL(String(config.command))
    } catch {
      return 'command must be a valid URL for sse/streamable-http transport'
    }
  }
  return null
}

function validateExternalConfig(config: Record<string, unknown>): string | null {
  const type = canonicalExternalType(config.type)
  if (type !== undefined && type !== 'stdio' && type !== 'sse' && type !== 'http' && type !== 'streamable-http') {
    return 'type must be one of: stdio, sse, http, streamable-http'
  }

  if (type === 'sse' || type === 'http' || type === 'streamable-http') {
    if (typeof config.url !== 'string' || !config.url.trim()) {
      return 'url must be a non-empty string'
    }
    try {
      new URL(config.url)
    } catch {
      return 'url must be a valid URL'
    }
    const headersError = validateStringRecord(config.headers, 'headers')
    if (headersError) return headersError
    const envError = validateStringRecord(config.env, 'env')
    if (envError) return envError
    return null
  }

  if (typeof config.command !== 'string' || !config.command.trim()) {
    return 'command must be a non-empty string'
  }
  const argsError = validateStringArray(config.args, 'args')
  if (argsError) return argsError
  const envError = validateStringRecord(config.env, 'env')
  if (envError) return envError
  if (config.cwd !== undefined && typeof config.cwd !== 'string') {
    return 'cwd must be a string'
  }
  return null
}

export function validateMcpJsonConfig(config: unknown): string | null {
  if (!isRecord(config)) {
    return 'Configuration must be an object'
  }

  if ('transport' in config) {
    return validateInternalConfig(config)
  }

  if ('type' in config) {
    return validateExternalConfig(config)
  }

  if ('command' in config) {
    return validateExternalConfig(config)
  }

  return 'Invalid format: requires command (stdio) or type + url (http/sse)'
}

function convertSingleConfig(config: Record<string, unknown>): { data?: McpServerConfig; error?: string } {
  const error = validateMcpJsonConfig(config)
  if (error) return { error }

  if ('transport' in config) {
    return { data: normalizeInternalConfig(config) }
  }
  return { data: normalizeExternalConfig(config) }
}

/** An internal server config plus the name recovered from its wrapper key, if any */
export interface NamedMcpServerConfig {
  name?: string
  config: McpServerConfig
}

/**
 * Parse arbitrary pasted MCP JSON into internal server configs.
 * Accepts wrapped and direct shapes (see unwrapMcpJson); may yield multiple
 * servers when the paste contains a whole `mcpServers` map.
 */
export function parseMcpJsonInput(parsed: unknown): { servers?: NamedMcpServerConfig[]; error?: string } {
  const unwrapped = unwrapMcpJson(parsed)
  if (unwrapped.error || !unwrapped.servers) return { error: unwrapped.error }

  const servers: NamedMcpServerConfig[] = []
  for (const { name, config } of unwrapped.servers) {
    const result = convertSingleConfig(config)
    if (result.error || !result.data) {
      return { error: name ? `${name}: ${result.error}` : result.error }
    }
    servers.push({ name, config: result.data })
  }
  return { servers }
}

/**
 * Single-server variant used where the server identity is fixed (editing an
 * installed server). Tolerates a wrapper as long as it contains exactly one
 * server; `name` carries the wrapper key when present.
 */
export function mcpJsonConfigToInternal(config: unknown): { data?: McpServerConfig; name?: string; error?: string } {
  const parsed = parseMcpJsonInput(config)
  if (parsed.error || !parsed.servers) return { error: parsed.error }
  if (parsed.servers.length > 1) {
    return { error: 'Configuration contains multiple servers. Paste a single server config here.' }
  }
  const [first] = parsed.servers
  return { data: first.config, ...(first.name ? { name: first.name } : {}) }
}

export function internalMcpServerToJsonConfig(config: McpServerConfig): McpJsonConfig {
  if (config.transport === 'sse' || config.transport === 'streamable-http') {
    return {
      type: config.transport === 'streamable-http' ? 'http' : 'sse',
      url: config.command,
      ...(config.headers && Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
      ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
    }
  }

  return {
    command: config.command,
    ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
    ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
  }
}

export function recordToKeyValueLines(record?: Record<string, string>): string {
  if (!record || Object.keys(record).length === 0) return ''
  return Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n')
}

export function keyValueLinesToRecord(text: string): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (key) {
      record[key] = value
    }
  }
  return Object.keys(record).length > 0 ? record : undefined
}
