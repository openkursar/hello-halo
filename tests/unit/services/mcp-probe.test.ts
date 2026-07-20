/**
 * Unit Tests: services/agent — MCP Connection Probe
 *
 * Exercises the native probe against real local HTTP servers:
 * - successful initialize + tools/list handshake (real MCP server)
 * - header forwarding (Authorization)
 * - failure classification: 401 → needs-auth, refused/timeout → failed
 * and the app-lifecycle listener (status cache cleanup / probe triggers).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import http, { type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// Mock the heavy agent-module dependencies (config/space/ai-sources chains)
vi.mock('../../../src/main/services/app-bridge', () => ({
  getAppManager: vi.fn(() => null)
}))
vi.mock('../../../src/main/services/agent/helpers', () => ({
  appToSdkServerConfig: vi.fn(() => null)
}))
vi.mock('../../../src/main/services/agent/mcp-manager', () => ({
  updateServerStatus: vi.fn(),
  removeServerStatus: vi.fn()
}))

import {
  probeServerConfig,
  probeMcpApp,
  handleMcpAppsChangeForStatus,
  probeFailedServers
} from '../../../src/main/services/agent/mcp-probe'
import { getAppManager } from '../../../src/main/services/app-bridge'
import { appToSdkServerConfig } from '../../../src/main/services/agent/helpers'
import { updateServerStatus, removeServerStatus } from '../../../src/main/services/agent/mcp-manager'

// ============================================
// Local test servers
// ============================================

interface TestServer {
  url: string
  close: () => Promise<void>
  /** Number of HTTP requests received (for coalescing assertions) */
  requestCount: () => number
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    handler(req, res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }),
        requestCount: () => requests
      })
    })
  })
}

/** Real MCP server (stateless streamable-http) with one tool. */
function startMcpTestServer(opts?: { requiredAuth?: string }): Promise<TestServer> {
  return listen((req, res) => {
    void (async () => {
      if (opts?.requiredAuth && req.headers.authorization !== opts.requiredAuth) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('Unauthorized')
        return
      }
      const mcpServer = new Server(
        { name: 'probe-test', version: '1.2.3' },
        { capabilities: { tools: {} } }
      )
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'ping', inputSchema: { type: 'object' as const } }]
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcpServer.connect(transport)
      res.on('close', () => { void mcpServer.close().catch(() => {}) })
      await transport.handleRequest(req, res)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
}

const servers: TestServer[] = []
async function track(p: Promise<TestServer>): Promise<TestServer> {
  const s = await p
  servers.push(s)
  return s
}

afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  vi.clearAllMocks()
})

// ============================================
// probeServerConfig
// ============================================

describe('probeServerConfig', () => {
  it('connects to a real MCP server and lists tools', async () => {
    const server = await track(startMcpTestServer())
    const result = await probeServerConfig({ type: 'http', url: server.url })

    expect(result.status).toBe('connected')
    expect(result.tools).toEqual(['ping'])
    expect(result.serverInfo).toEqual({ name: 'probe-test', version: '1.2.3' })
    expect(result.errorDetail).toBeUndefined()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('forwards configured headers (Authorization)', async () => {
    const server = await track(startMcpTestServer({ requiredAuth: 'Bearer secret' }))

    const ok = await probeServerConfig({
      type: 'http',
      url: server.url,
      headers: { Authorization: 'Bearer secret' }
    })
    expect(ok.status).toBe('connected')

    const rejected = await probeServerConfig({ type: 'http', url: server.url })
    expect(rejected.status).toBe('needs-auth')
    expect(rejected.errorDetail).toContain('401')
  })

  it('classifies HTTP 401 as needs-auth with detail', async () => {
    const server = await track(listen((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('Unauthorized')
    }))

    const result = await probeServerConfig({ type: 'http', url: server.url })
    expect(result.status).toBe('needs-auth')
    expect(result.errorDetail).toMatch(/401/)
  })

  it('classifies connection refused as failed with detail', async () => {
    // Grab a free port, then close the server so nothing listens on it
    const server = await listen((_req, res) => res.end())
    await server.close()

    const result = await probeServerConfig({ type: 'http', url: server.url })
    expect(result.status).toBe('failed')
    expect(result.errorDetail).toMatch(/ECONNREFUSED|refused|fetch failed/i)
  })

  it('times out against an unresponsive server', async () => {
    const server = await track(listen(() => { /* never respond */ }))

    const result = await probeServerConfig({ type: 'http', url: server.url }, 500)
    expect(result.status).toBe('failed')
    expect(result.errorDetail).toMatch(/timed out/i)
  })

  it('fails fast on invalid config', async () => {
    const result = await probeServerConfig({ type: 'http' })
    expect(result.status).toBe('failed')
    expect(result.errorDetail).toBeTruthy()
  })
})

// ============================================
// App-level probe + lifecycle listener
// ============================================

function mockManagerWithApp(app: Record<string, unknown> | null): void {
  vi.mocked(getAppManager).mockReturnValue({
    getApp: vi.fn(() => app),
    listApps: vi.fn(() => (app ? [app] : []))
  } as never)
}

describe('probeMcpApp', () => {
  beforeEach(() => vi.clearAllMocks())

  it('probes an installed MCP app and updates the status cache', async () => {
    const server = await track(startMcpTestServer())
    mockManagerWithApp({ id: 'app-1', specId: 'my-server', spec: { type: 'mcp' } })
    vi.mocked(appToSdkServerConfig).mockReturnValue({ type: 'http', url: server.url })

    const res = await probeMcpApp('app-1')

    expect(res.success).toBe(true)
    expect(res.result?.status).toBe('connected')
    expect(updateServerStatus).toHaveBeenCalledWith(
      'my-server',
      expect.objectContaining({ status: 'connected', tools: ['ping'] })
    )
  })

  it('returns an error for unknown apps', async () => {
    mockManagerWithApp(null)
    const res = await probeMcpApp('missing')
    expect(res.success).toBe(false)
    expect(res.error).toContain('missing')
  })

  it('rejects non-MCP apps', async () => {
    mockManagerWithApp({ id: 'app-2', specId: 'a-skill', spec: { type: 'skill' } })
    const res = await probeMcpApp('app-2')
    expect(res.success).toBe(false)
  })

  it('coalesces concurrent probes of the same server into one handshake', async () => {
    const server = await track(startMcpTestServer())
    mockManagerWithApp({ id: 'app-1', specId: 'coalesce-server', spec: { type: 'mcp' } })
    vi.mocked(appToSdkServerConfig).mockReturnValue({ type: 'http', url: server.url })

    // Baseline: requests produced by a single probe
    await probeMcpApp('app-1')
    const singleProbeRequests = server.requestCount()

    // Two concurrent probes must share one in-flight handshake
    const [a, b] = await Promise.all([probeMcpApp('app-1'), probeMcpApp('app-1')])
    expect(a.result?.status).toBe('connected')
    expect(b.result?.status).toBe('connected')
    expect(server.requestCount()).toBe(singleProbeRequests * 2)
  })
})

describe('handleMcpAppsChangeForStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops the cached status on pause and uninstall', () => {
    handleMcpAppsChangeForStatus('space-1', { appId: 'a', specId: 's1', action: 'paused' })
    handleMcpAppsChangeForStatus(null, { appId: 'b', specId: 's2', action: 'uninstalled' })

    expect(removeServerStatus).toHaveBeenCalledWith('s1')
    expect(removeServerStatus).toHaveBeenCalledWith('s2')
  })

  it('probes on resume and broadcasts the fresh status', async () => {
    const server = await track(startMcpTestServer())
    mockManagerWithApp({ id: 'app-1', specId: 'my-server', spec: { type: 'mcp' } })
    vi.mocked(appToSdkServerConfig).mockReturnValue({ type: 'http', url: server.url })

    handleMcpAppsChangeForStatus('space-1', { appId: 'app-1', specId: 'my-server', action: 'resumed' })

    await vi.waitFor(() => {
      expect(updateServerStatus).toHaveBeenCalledWith(
        'my-server',
        expect.objectContaining({ status: 'connected' })
      )
    })
  })

  it('probes on app-status transitions (e.g. error→active)', async () => {
    const server = await track(startMcpTestServer())
    mockManagerWithApp({ id: 'app-3', specId: 'status-server', spec: { type: 'mcp' } })
    vi.mocked(appToSdkServerConfig).mockReturnValue({ type: 'http', url: server.url })

    handleMcpAppsChangeForStatus('space-1', { appId: 'app-3', specId: 'status-server', action: 'status' })

    await vi.waitFor(() => {
      expect(updateServerStatus).toHaveBeenCalledWith(
        'status-server',
        expect.objectContaining({ status: 'connected' })
      )
    })
  })

  it('ignores events without change details', () => {
    handleMcpAppsChangeForStatus('space-1', undefined)
    expect(removeServerStatus).not.toHaveBeenCalled()
    expect(updateServerStatus).not.toHaveBeenCalled()
  })
})

describe('probeFailedServers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('probes SDK-reported failures once, then honors the cooldown', async () => {
    const server = await track(startMcpTestServer())
    const app = { id: 'app-cd', specId: 'cooldown-server', spec: { type: 'mcp' }, status: 'active' }
    mockManagerWithApp(app)
    vi.mocked(appToSdkServerConfig).mockReturnValue({ type: 'http', url: server.url })

    probeFailedServers(['cooldown-server'])
    await vi.waitFor(() => {
      expect(updateServerStatus).toHaveBeenCalledTimes(1)
    })
    const requestsAfterFirst = server.requestCount()

    // Immediately reported failed again — must be suppressed by the cooldown
    probeFailedServers(['cooldown-server'])
    await new Promise(r => setTimeout(r, 100))
    expect(updateServerStatus).toHaveBeenCalledTimes(1)
    expect(server.requestCount()).toBe(requestsAfterFirst)
  })

  it('skips servers that have no installed app record (.mcp.json / built-ins)', async () => {
    mockManagerWithApp(null)
    probeFailedServers(['not-an-app'])
    await new Promise(r => setTimeout(r, 50))
    expect(updateServerStatus).not.toHaveBeenCalled()
  })
})
