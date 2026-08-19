/**
 * Agent Module - MCP Connection Probe
 *
 * Native, lightweight MCP connectivity check built on the official
 * @modelcontextprotocol/sdk client. Performs a real initialize handshake
 * (+ tools/list) against a single server and classifies failures into a
 * human-readable reason — without spawning an SDK agent session or
 * consuming any model tokens.
 *
 * Used by:
 * - App lifecycle events (install / resume / spec update) to refresh the
 *   status card immediately, so the Enable toggle genuinely retries.
 * - The manual "Test connection" action in the MCP status card.
 * - SDK session init reports of `failed` servers, to attach the failure
 *   reason the SDK itself never provides.
 *
 * Probes never touch live agent sessions: MCP connections are per-session
 * and rebuilt on the next message. A probe only answers "will the next
 * session be able to connect, and if not, why".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { getAppManager } from '../app-bridge'
import { appToSdkServerConfig } from './helpers'
import { purgeStaleMcpOAuth } from './mcp-auth-state'
import { updateServerStatus, removeServerStatus, type McpProbeStatusPatch } from './mcp-manager'
import type { McpAppChange } from '../app-bridge'

// ============================================
// Types
// ============================================

/** SDK-shaped server config as produced by appToSdkServerConfig() */
interface SdkServerConfig {
  type?: 'http' | 'sse'
  url?: string
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpProbeResult {
  status: 'connected' | 'failed' | 'needs-auth'
  /** Short tool names provided by the server (first page) */
  tools?: string[]
  serverInfo?: { name: string; version: string }
  /** Human-readable failure reason (technical, not localized) */
  errorDetail?: string
  latencyMs: number
}

const PROBE_TIMEOUT_MS = 15_000
/** Min interval between automatic probes of the same server (SDK-failure follow-ups) */
const AUTO_PROBE_COOLDOWN_MS = 60_000

// ============================================
// Core probe
// ============================================

function buildTransport(config: SdkServerConfig): Transport {
  if (config.type === 'http' || config.type === 'sse') {
    if (!config.url) throw new Error('MCP server config has no URL')
    const url = new URL(config.url)
    const requestInit = config.headers ? { headers: config.headers } : undefined
    return config.type === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit })
      : new SSEClientTransport(url, { requestInit })
  }
  if (!config.command) throw new Error('MCP server config has no command')
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    // Mirror SDK spawn behavior: safe inherited env + server-specific vars
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    stderr: 'ignore'
  })
}

/**
 * Classify a probe failure into status + human-readable detail.
 * StreamableHTTPError / SseError carry the HTTP status in `code`;
 * network-level fetch failures carry a Node error in `cause`.
 */
function classifyProbeError(err: unknown): { status: 'failed' | 'needs-auth'; detail: string } {
  const e = err as Error & { code?: number | string; cause?: { code?: string; message?: string } }
  const httpCode = typeof e?.code === 'number' ? e.code : undefined

  if (httpCode === 401 || httpCode === 403) {
    return {
      status: 'needs-auth',
      detail: `HTTP ${httpCode} — authentication rejected (check the Authorization header / token)`
    }
  }
  if (httpCode !== undefined) {
    return { status: 'failed', detail: `HTTP ${httpCode}: ${e.message ?? 'request failed'}` }
  }
  // undici wraps network errors as "fetch failed" with the real cause attached
  if (e?.cause?.code || e?.cause?.message) {
    return { status: 'failed', detail: e.cause.code ? `${e.cause.code}: ${e.cause.message ?? ''}`.trim() : e.cause.message! }
  }
  return { status: 'failed', detail: e?.message || String(err) }
}

/**
 * Probe a single MCP server: initialize handshake + tools/list, then close.
 * Never throws — all failures are folded into the result.
 */
export async function probeServerConfig(
  config: SdkServerConfig,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<McpProbeResult> {
  const startedAt = Date.now()
  const client = new Client({ name: 'halo-mcp-probe', version: '1.0.0' })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Connection timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    )
  })

  try {
    const transport = buildTransport(config)
    const probe = (async () => {
      await client.connect(transport)
      const toolsResult = await client.listTools()
      return toolsResult.tools.map(t => t.name)
    })()

    const tools = await Promise.race([probe, timeout])
    const serverVersion = client.getServerVersion()

    return {
      status: 'connected',
      tools,
      ...(serverVersion ? { serverInfo: { name: serverVersion.name, version: serverVersion.version } } : {}),
      latencyMs: Date.now() - startedAt
    }
  } catch (err) {
    const { status, detail } = classifyProbeError(err)
    return { status, errorDetail: detail, latencyMs: Date.now() - startedAt }
  } finally {
    if (timer) clearTimeout(timer)
    // Best-effort teardown: close() ends the HTTP session / kills the stdio child
    void client.close().catch(() => {})
  }
}

// ============================================
// App-level probe (cache + broadcast integration)
// ============================================

// Coalesce concurrent probes of the same server (rapid toggle, double click)
const inflightProbes = new Map<string, Promise<McpProbeResult>>()
// Cooldown ledger for automatic (non user-initiated) probes
const lastAutoProbeAt = new Map<string, number>()

function statusPatchFromResult(result: McpProbeResult): McpProbeStatusPatch {
  return {
    status: result.status,
    ...(result.tools ? { tools: result.tools } : {}),
    ...(result.serverInfo ? { serverInfo: result.serverInfo } : {}),
    ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
    lastCheckedAt: Date.now()
  }
}

/**
 * Probe an installed MCP app by id, update the shared status cache and
 * broadcast to all clients. Concurrent calls for the same server share
 * one probe.
 */
export async function probeMcpApp(
  appId: string
): Promise<{ success: boolean; result?: McpProbeResult; error?: string }> {
  const manager = getAppManager()
  if (!manager) return { success: false, error: 'App manager not available' }

  const app = manager.getApp(appId)
  if (!app) return { success: false, error: `App not found: ${appId}` }
  if (app.spec.type !== 'mcp') return { success: false, error: `App is not an MCP server: ${appId}` }

  const config = appToSdkServerConfig(app)
  if (!config) return { success: false, error: 'MCP server config is invalid or blocked by policy' }

  const specId = app.specId
  let probe = inflightProbes.get(specId)
  if (!probe) {
    probe = probeServerConfig(config as SdkServerConfig).finally(() => {
      inflightProbes.delete(specId)
    })
    inflightProbes.set(specId, probe)
  }

  const result = await probe
  lastAutoProbeAt.set(specId, Date.now())

  // A handshake that succeeds with the current config proves any CC OAuth
  // record for it is leftover state, so drop it before the next session picks
  // it up and refuses to connect.
  if (result.status === 'connected') {
    await purgeStaleMcpOAuth({ [specId]: config }, `probe:${specId}`)
  }

  updateServerStatus(specId, statusPatchFromResult(result))

  console.log(
    `[McpProbe] ${specId}: ${result.status} in ${result.latencyMs}ms` +
    (result.errorDetail ? ` (${result.errorDetail})` : '') +
    (result.tools ? `, ${result.tools.length} tools` : '')
  )
  return { success: true, result }
}

function probeMcpAppSilently(appId: string, reason: string): void {
  probeMcpApp(appId).catch(err => {
    console.error(`[McpProbe] Background probe failed (${reason}, app=${appId}):`, err)
  })
}

// ============================================
// Lifecycle integration
// ============================================

/**
 * React to MCP app lifecycle changes. Wired to the Apps layer's
 * onMcpAppsChange event by apps/runtime (same seam as the agent's
 * session-invalidation handler).
 *
 * - paused / uninstalled → drop the cached status so the UI never shows a
 *   stale "connection error" for a disabled or reinstalled server.
 * - installed / resumed / updated / status → probe immediately so the Enable
 *   toggle, config save, and app-status transitions (e.g. error→active) act
 *   as a real retry with immediate feedback.
 */
export function handleMcpAppsChangeForStatus(_spaceId: string | null, change?: McpAppChange): void {
  if (!change) return

  switch (change.action) {
    case 'paused':
    case 'uninstalled':
      removeServerStatus(change.specId)
      break
    case 'installed':
    case 'reinstalled':
    case 'resumed':
    case 'updated':
    case 'status':
      probeMcpAppSilently(change.appId, change.action)
      break
  }
}

/**
 * Follow up on SDK session-init reports: servers the SDK marked `failed` or
 * `needs-auth` get probed (with cooldown). For `failed` this attaches the
 * reason the SDK never provides; for `needs-auth` it is also the recovery
 * path, since a successful probe clears the CC auth record that produced that
 * verdict. Called by stream-processor after broadcasting init status.
 */
export function probeUnhealthyServers(specIds: string[]): void {
  const manager = getAppManager()
  if (!manager || specIds.length === 0) return

  const now = Date.now()
  for (const specId of specIds) {
    const last = lastAutoProbeAt.get(specId) ?? 0
    if (now - last < AUTO_PROBE_COOLDOWN_MS) continue

    // Status names are specIds; resolve back to an installed app. Non-app
    // servers (built-in / .mcp.json entries) have no app record — skip.
    const app = manager.listApps({ type: 'mcp', status: 'active' }).find(a => a.specId === specId)
    if (!app) continue

    lastAutoProbeAt.set(specId, now)
    probeMcpAppSilently(app.id, 'sdk-reported-unhealthy')
  }
}
