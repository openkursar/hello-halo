import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), bridgeClose: vi.fn(), resolved: vi.fn(),
  pending: undefined as ((reason: Error) => void) | undefined,
  initialize: undefined as (() => void) | undefined,
}))
vi.mock('../../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../../src/main/services/external-runtime', () => ({
  resolveExternalRuntimeLaunch: async () => ({ command: '/synthetic-codex', argsPrefix: [], env: {}, path: '/synthetic-codex', kind: 'native', version: '0.132.0' }),
}))
vi.mock('../../../../../src/main/services/agent/codex/transport/connection', () => ({
  createCodexConnection: () => ({ start: state.start, stop: state.stop, onExit: () => () => {}, stdin: {}, stdout: {}, pid: 123, isAlive: () => true }),
}))
vi.mock('../../../../../src/main/services/agent/codex/options', () => ({ resolveCodexOptions: state.resolved }))
vi.mock('../../../../../src/main/services/agent/codex/transport/server-request-handler', () => ({ registerServerRequestHandlers: () => () => {} }))
vi.mock('../../../../../src/main/services/agent/codex/transport/jsonrpc-client', () => ({
  JsonRpcClient: class {
    onNotification() {}
    notify() {}
    close() { state.pending?.(new Error('RPC closed')) }
    async request(method: string) {
      if (method === 'initialize') {
        state.initialize?.()
        return new Promise((_resolve, reject) => { state.pending = reject })
      }
      return { thread: { id: 'synthetic-thread' } }
    }
  },
}))

import { CodexAppServerSession } from '../../../../../src/main/services/agent/codex/session-adapter'

const options = () => ({ env: {}, cwd: '/tmp', model: 'm', displayModel: 'm', threadParams: {}, mcpServers: {}, mcpBridge: { close: state.bridgeClose } })

describe('Codex creation cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.pending = undefined
    state.initialize = undefined
    state.start.mockResolvedValue(undefined)
    state.stop.mockResolvedValue(undefined)
    state.bridgeClose.mockResolvedValue(undefined)
    state.resolved.mockResolvedValue(options())
  })

  it('refuses a pre-aborted creation before preparing resources', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before preparation'))
    await expect(CodexAppServerSession.create({ abortController: controller })).rejects.toThrow('cancelled before preparation')
    expect(state.resolved).not.toHaveBeenCalled()
    expect(state.start).not.toHaveBeenCalled()
  })

  it('closes a prepared MCP bridge if cancellation arrives while resolving options', async () => {
    const controller = new AbortController()
    let prepared!: (value: ReturnType<typeof options>) => void
    state.resolved.mockReturnValue(new Promise(resolve => { prepared = resolve }))
    const creating = CodexAppServerSession.create({ abortController: controller })
    controller.abort(new Error('cancelled during options'))
    prepared(options())
    await expect(creating).rejects.toThrow('cancelled during options')
    expect(state.bridgeClose).toHaveBeenCalledOnce()
    expect(state.start).not.toHaveBeenCalled()
  })

  it('cancels an initializing native connection and releases its bridge', async () => {
    const controller = new AbortController()
    let initialized!: () => void
    const starting = new Promise<void>(resolve => { initialized = resolve })
    state.initialize = initialized
    const creating = CodexAppServerSession.create({ abortController: controller })
    await starting
    controller.abort(new Error('cancelled during initialize'))
    await expect(creating).rejects.toThrow('RPC closed')
    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.bridgeClose).toHaveBeenCalledOnce()
  })
})
