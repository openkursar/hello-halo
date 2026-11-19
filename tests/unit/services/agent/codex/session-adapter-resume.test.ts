/**
 * A Codex thread that can no longer be resumed must not fail every later
 * message of its conversation: the session continues on a fresh thread.
 */

import { describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; params: unknown }>,
  failResume: true,
  stopped: vi.fn(),
  failInitialize: false,
  launch: { command: '/fixture/codex', argsPrefix: [], env: {}, path: '/fixture/codex', kind: 'native', version: '0.128.0' } as any,
  connect: vi.fn(),
}))

vi.mock('../../../../../src/main/services/external-runtime', () => ({
  resolveExternalRuntimeLaunch: async () => rpc.launch,
}))

vi.mock('../../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../../src/main/services/agent/codex/transport/connection', () => ({
  createCodexConnection: (options: unknown) => {
    rpc.connect(options)
    return {
    start: async () => {},
    stop: async () => { rpc.stopped() },
    onExit: () => () => {},
    stdin: {},
    stdout: {},
    pid: 1,
    isRunning: () => true,
    }
  },
}))
vi.mock('../../../../../src/main/services/agent/codex/transport/jsonrpc-client', () => ({
  JsonRpcClient: class {
    onNotification(): void {}
    notify(): void {}
    close(): void {}
    async request(method: string, params: unknown): Promise<unknown> {
      rpc.requests.push({ method, params })
      if (method === 'initialize' && rpc.failInitialize) throw new Error('Handshake failed')
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
  resolveCodexOptions: async (options: any) => {
    await options.prepareOptions?.()
    return { env: {}, cwd: '/tmp', model: 'm', displayModel: 'm', threadParams: { developerInstructions: 'Host context' }, mcpServers: {} }
  },
}))

import { NativeSessionResumeError, isNativeSessionResumeError } from '../../../../../src/shared/types/engine-session'
import { CodexAppServerSession } from '../../../../../src/main/services/agent/codex/session-adapter'

describe('Codex thread resume', () => {
  it('keeps the captured launch when selection changes during option preparation', async () => {
    const captured = rpc.launch
    try {
      const session = await CodexAppServerSession.create({ prepareOptions: async () => {
        rpc.launch = { ...captured, command: '/other/codex', path: '/other/codex' }
      } })
      expect(rpc.connect.mock.calls.at(-1)?.[0].launch).toBe(captured)
      await session.close()
    } finally { rpc.launch = captured }
  })

  it('reports missing selected Codex before allocating options or a process', async () => {
    const captured = rpc.launch
    const prepareOptions = vi.fn()
    rpc.connect.mockClear()
    try {
      rpc.launch = null
      await expect(CodexAppServerSession.create({ prepareOptions })).rejects.toMatchObject({ name: 'EngineUnavailableError', engineId: 'codex' })
      expect(prepareOptions).not.toHaveBeenCalled()
      expect(rpc.connect).not.toHaveBeenCalled()
    } finally { rpc.launch = captured }
  })
  it('starts a fresh thread when the stored thread cannot be resumed', async () => {
    rpc.requests.length = 0
    rpc.failResume = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const session = await CodexAppServerSession.create({ resume: 'gone-thread' })
      expect(rpc.requests.map(request => request.method)).toEqual(['initialize', 'thread/resume', 'thread/start'])
      expect(rpc.requests.filter(request => request.method.startsWith('thread/')).map(request => request.params)).toEqual([
        { threadId: 'gone-thread', developerInstructions: 'Host context' },
        { developerInstructions: 'Host context' },
      ])
      expect(session.sessionId).toBe('fresh-thread')
    } finally { warn.mockRestore() }
  })

  it('does not start empty when a known binding fails to resume, and closes its process', async () => {
    rpc.requests.length = 0
    rpc.failResume = true
    rpc.stopped.mockClear()
    const error = await CodexAppServerSession.create({ resume: 'bound-thread', strictNativeResume: true }).catch(value => value)
    expect(error).toBeInstanceOf(NativeSessionResumeError)
    expect(isNativeSessionResumeError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'NATIVE_SESSION_RESUME_FAILED', engineId: 'codex', sessionId: 'bound-thread' })
    expect(rpc.requests.map(request => request.method)).toEqual(['initialize', 'thread/resume'])
    expect(rpc.stopped).toHaveBeenCalledOnce()
  })

  it('closes the native process when initialization fails before any thread exists', async () => {
    rpc.requests.length = 0
    rpc.stopped.mockClear()
    rpc.failInitialize = true
    try {
      await expect(CodexAppServerSession.create({})).rejects.toThrow('Handshake failed')
      expect(rpc.requests.map(request => request.method)).toEqual(['initialize'])
      expect(rpc.stopped).toHaveBeenCalledOnce()
    } finally { rpc.failInitialize = false }
  })

  it('keeps the resumed thread when resume succeeds', async () => {
    rpc.requests.length = 0
    rpc.failResume = false
    const session = await CodexAppServerSession.create({ resume: 'live-thread' })
    expect(rpc.requests.map(request => request.method)).toEqual(['initialize', 'thread/resume'])
    expect(rpc.requests[1].params).toEqual({ threadId: 'live-thread', developerInstructions: 'Host context' })
    expect(session.sessionId).toBe('resumed-thread')
  })
})
