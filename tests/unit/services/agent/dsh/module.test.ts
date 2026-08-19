/**
 * Unit Tests: services/agent/dsh — module facade wiring.
 *
 * `module.ts` is the only place that composes the adapter's two halves: it
 * registers the transport's client factory into the session half's seam, and
 * it runs the `resolveDshOptions()` step that turns Halo's SDK options into a
 * launch spec. Both are wiring rather than logic, and both fail silently if
 * they regress — a missing registration only surfaces as a runtime throw on
 * the user's first message.
 *
 * `options.ts` reads Electron's app paths and the active AI source, so it is
 * mocked here; what these tests assert is that whatever it resolves actually
 * reaches the runtime client.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveDshOptions = vi.fn()
const createDshRuntimeClient = vi.fn()

vi.mock('../../../../../src/main/services/agent/dsh/options', () => ({
  resolveDshOptions: (options: Record<string, any>) => resolveDshOptions(options),
}))

vi.mock('../../../../../src/main/services/agent/dsh/transport', () => ({
  createDshRuntimeClient: (options: Record<string, any>) => createDshRuntimeClient(options),
}))

const { createDshSdkModule } = await import(
  '../../../../../src/main/services/agent/dsh/module'
)

const LAUNCH = {
  command: '/path/to/electron',
  args: ['/path/to/packaged-bin.js', '/path/to/halo.cordis.yml'],
  env: { DSH_CWD: '/work' },
  cwd: '/work',
}

const INIT = { cwd: '/work', provider: 'deepseek-official', model: 'deepseek-v4' }

function fakeClient() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ messageId: 'm-1' }),
    onNotification: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

describe('dsh module facade', () => {
  beforeEach(() => {
    resolveDshOptions.mockReset()
    createDshRuntimeClient.mockReset()
    resolveDshOptions.mockResolvedValue({
      launch: LAUNCH,
      init: INIT,
      includePartialMessages: true,
    })
  })

  it('exposes the SDK module surface resolved-sdk.ts loads', () => {
    const sdk = createDshSdkModule()

    expect(typeof sdk.tool).toBe('function')
    expect(typeof sdk.createSdkMcpServer).toBe('function')
    expect(typeof sdk.createSession).toBe('function')
    expect(typeof sdk.query).toBe('function')
    expect(sdk.capabilities.engineId).toBe('dsh')
  })

  it('drives the runtime with the spec resolveDshOptions produced', async () => {
    const client = fakeClient()
    createDshRuntimeClient.mockReturnValue(client)

    await createDshSdkModule().createSession({ cwd: '/work', model: 'ignored-by-resolver' })

    expect(createDshRuntimeClient).toHaveBeenCalledTimes(1)
    expect(createDshRuntimeClient.mock.calls[0][0].launch).toMatchObject({
      command: LAUNCH.command,
      args: LAUNCH.args,
    })
    expect(client.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'deepseek-official', model: 'deepseek-v4' })
    )
  })

  it('resumes the session id Halo persisted instead of minting a new one', async () => {
    const client = fakeClient()
    createDshRuntimeClient.mockReturnValue(client)

    const session = await createDshSdkModule().createSession({
      cwd: '/work',
      resume: 'conversation-session-id',
    })
    session.send('hello')

    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled())
    expect(client.prompt.mock.calls[0][0]).toBe('conversation-session-id')
  })

  /**
   * The MCP bridge is a listening socket opened during option resolution, one
   * per session. Nothing else can close it: leaking one leaks a port and keeps
   * Halo's in-process tools reachable by anything on the loopback interface for
   * the rest of the process's life.
   */
  describe('MCP bridge ownership', () => {
    const mcpBridge = {
      close: vi.fn().mockResolvedValue(undefined),
      whenDialled: vi.fn().mockResolvedValue(undefined),
    }

    beforeEach(() => {
      mcpBridge.close.mockClear()
      mcpBridge.whenDialled.mockClear()
      resolveDshOptions.mockResolvedValue({
        launch: LAUNCH,
        init: INIT,
        includePartialMessages: true,
        mcpBridge,
        mcpServerNames: ['ai-browser'],
      })
    })

    it('closes the bridge with the session', async () => {
      createDshRuntimeClient.mockReturnValue(fakeClient())

      const session = await createDshSdkModule().createSession({ cwd: '/work' })
      expect(mcpBridge.close).not.toHaveBeenCalled()

      await session.close()
      expect(mcpBridge.close).toHaveBeenCalledTimes(1)
    })

    it('does not report the session started until the bridge has been dialled', async () => {
      // A session handed out before then accepts a prompt the runtime answers
      // without the MCP tools registered.
      createDshRuntimeClient.mockReturnValue(fakeClient())

      await createDshSdkModule().createSession({ cwd: '/work' })

      expect(mcpBridge.whenDialled).toHaveBeenCalledTimes(1)
    })

    it('closes the bridge when the runtime never starts', async () => {
      // Resolution already opened the socket, and no session exists to own it.
      createDshRuntimeClient.mockImplementation(() => {
        throw new Error('runtime entry not found')
      })

      await expect(createDshSdkModule().createSession({ cwd: '/work' })).rejects.toThrow(
        'runtime entry not found'
      )
      expect(mcpBridge.close).toHaveBeenCalledTimes(1)
    })

    it('tells the session which servers to report, so the MCP panel is populated', async () => {
      const client = fakeClient()
      createDshRuntimeClient.mockReturnValue(client)

      const session = await createDshSdkModule().createSession({ cwd: '/work' })
      session.send('hello')
      await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled())

      // The receipt opens the turn interval, and `system.init` is its first frame.
      const onNotification = client.onNotification.mock.calls[0][0]
      onNotification({
        method: 'session.event',
        payload: {
          sessionId: client.prompt.mock.calls[0][0],
          event: {
            type: 'agent/inbox/spliced',
            data: { inserted: [{ id: 'm-1' }] },
          },
        },
      })

      for await (const frame of session.stream()) {
        if (frame.subtype !== 'init') continue
        expect(frame.mcp_servers).toEqual([{ name: 'ai-browser', status: 'pending' }])
        break
      }
    })
  })
})
