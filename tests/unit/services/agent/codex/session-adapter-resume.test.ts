/**
 * A Codex thread that can no longer be resumed must not fail every later
 * message of its conversation: the session continues on a fresh thread.
 */

import { describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; params: unknown }>,
  failResume: true,
}))

vi.mock('../../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../../src/main/services/agent/codex/transport/connection', () => ({
  resolveBundledCodexBinary: () => ({ binaryPath: '/codex', isJsShim: false, pathDirs: [] }),
  createCodexConnection: () => ({
    start: async () => {},
    stop: async () => {},
    onExit: () => () => {},
    stdin: {},
    stdout: {},
    pid: 1,
    isRunning: () => true,
  }),
}))
vi.mock('../../../../../src/main/services/agent/codex/transport/jsonrpc-client', () => ({
  JsonRpcClient: class {
    onNotification(): void {}
    notify(): void {}
    close(): void {}
    async request(method: string, params: unknown): Promise<unknown> {
      rpc.requests.push({ method, params })
      if (method === 'initialize') return {}
      if (method === 'thread/resume' && rpc.failResume) throw new Error('thread not found')
      return { thread: { id: method === 'thread/resume' ? 'resumed-thread' : 'fresh-thread' } }
    }
  },
}))
vi.mock('../../../../../src/main/services/agent/codex/transport/server-request-handler', () => ({
  registerServerRequestHandlers: () => () => {},
}))
vi.mock('../../../../../src/main/services/agent/codex/options', () => ({
  resolveCodexOptions: async () => ({ env: {}, cwd: '/tmp', model: 'm', displayModel: 'm', threadParams: {}, mcpServers: {} }),
}))

import { CodexAppServerSession } from '../../../../../src/main/services/agent/codex/session-adapter'

describe('Codex thread resume', () => {
  it('starts a fresh thread when the stored thread cannot be resumed', async () => {
    rpc.requests.length = 0
    rpc.failResume = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const session = await CodexAppServerSession.create({ resume: 'gone-thread' })
      expect(rpc.requests.map(request => request.method)).toEqual(['initialize', 'thread/resume', 'thread/start'])
      expect(session.sessionId).toBe('fresh-thread')
    } finally { warn.mockRestore() }
  })

  it('keeps the resumed thread when resume succeeds', async () => {
    rpc.requests.length = 0
    rpc.failResume = false
    const session = await CodexAppServerSession.create({ resume: 'live-thread' })
    expect(rpc.requests.map(request => request.method)).toEqual(['initialize', 'thread/resume'])
    expect(session.sessionId).toBe('resumed-thread')
  })
})
