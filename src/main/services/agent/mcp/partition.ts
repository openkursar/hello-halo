/**
 * Split Halo's `mcpServers` option into the two kinds an out-of-process engine
 * has to treat differently, and normalize the external ones.
 *
 * Pure: no I/O, no ambient state. This is the ONE place that understands the
 * record shape `helpers.ts` builds from the installed-app database, so an
 * adapter never has to guess whether an endpoint arrives in `url` or in
 * `command`, or which of `type: 'http' | 'sse'` a record carries.
 */

import type { ExternalMcpServer, SdkMcpServerInstance } from './types'

export interface PartitionedMcpServers {
  /** In-process servers, callable only from Halo's heap. */
  sdk: Record<string, SdkMcpServerInstance>
  /** Servers a child process can be pointed at. */
  external: Record<string, ExternalMcpServer>
  /**
   * Names that matched neither kind. A record reaches this list when it has no
   * command and no URL, which means the user installed a server no engine can
   * reach; callers log it rather than dropping it silently.
   */
  unusable: string[]
}

export function partitionMcpServers(
  servers: Record<string, unknown> | undefined | null,
): PartitionedMcpServers {
  const sdk: Record<string, SdkMcpServerInstance> = {}
  const external: Record<string, ExternalMcpServer> = {}
  const unusable: string[] = []

  for (const [name, server] of Object.entries(servers || {})) {
    const instance = asSdkMcpServer(server)
    if (instance) {
      sdk[name] = instance
      continue
    }
    const normalized = normalizeExternalMcpServer(server)
    if (normalized) external[name] = normalized
    else unusable.push(name)
  }

  return { sdk, external, unusable }
}

/** The in-process instance behind a `createSdkMcpServer()` result, if this is one. */
export function asSdkMcpServer(server: unknown): SdkMcpServerInstance | null {
  if (!server || typeof server !== 'object') return null
  const candidate = server as { type?: unknown; instance?: any }
  if (candidate.type !== 'sdk') return null
  const instance = candidate.instance
  if (!instance || typeof instance.listTools !== 'function' || typeof instance.callTool !== 'function') {
    return null
  }
  return instance as SdkMcpServerInstance
}

/**
 * Project one stored record onto {@link ExternalMcpServer}, or null when it
 * describes nothing reachable.
 *
 * A remote transport puts its endpoint in `url`, but older records and the
 * CLI-import path leave it in `command`, so the URL shape is checked before the
 * record is read as a spawn instruction — otherwise an `https://` endpoint
 * becomes an executable name and the child fails with ENOENT.
 */
export function normalizeExternalMcpServer(server: unknown): ExternalMcpServer | null {
  if (!server || typeof server !== 'object') return null
  const record = server as Record<string, unknown>

  const url = firstNonEmptyString(record.url, isUrl(record.command) ? record.command : undefined)
  if (url) {
    return {
      transport: record.type === 'sse' ? 'sse' : 'http',
      url,
      headers: toStringRecord(record.headers),
    }
  }

  const command = firstNonEmptyString(record.command)
  if (!command) return null

  const cwd = firstNonEmptyString(record.cwd)
  return {
    transport: 'stdio',
    command,
    args: Array.isArray(record.args) ? record.args.map(String) : [],
    ...(cwd ? { cwd } : {}),
    env: toStringRecord(record.env),
  }
}

/**
 * The environment variable named by an `Authorization: Bearer ${VAR}` header.
 *
 * Halo stores that indirection so a token never has to sit in a config file.
 * Engines that support the same indirection reuse this; the rest send the
 * header as written.
 */
export function bearerTokenEnvVar(headers: Record<string, string>): string | undefined {
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
  return authorization?.match(/^Bearer\s+\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1]
}

function isUrl(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry != null)
      .map(([key, entry]) => [key, String(entry)]),
  )
}
