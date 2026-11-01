import { describe, it, expect, vi } from 'vitest'
import { createHaloSdkModule } from '../../../../../src/main/services/agent/halo'

const paths = vi.hoisted(() => ({ builtSetup: false, packaged: false }))
vi.mock('electron', () => ({ app: { get isPackaged() { return paths.packaged }, getAppPath: () => '/application' } }))
vi.mock('node:fs', async original => ({
  ...await original<typeof import('node:fs')>(),
  existsSync: (file: string) => paths.builtSetup && file === '/application/worker/halo-setup.cjs',
}))

function fixture() {
  const runtime = { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}), diagnostics: vi.fn(() => ({ workers: [] })),
    createSession: vi.fn(async (_options: Record<string, unknown>, _placement?: unknown) => ({ sessionId: 'real' })), query: vi.fn(() => (async function* () {})()) }
  const sdk = { createWorkerRuntime: vi.fn(() => runtime), getWorkerEntryUrl: () => new URL('file:///sdk/dist/worker/entry.js'),
    tool: vi.fn(), createSdkMcpServer: vi.fn(), setLogger: vi.fn() }
  return { runtime, sdk, module: createHaloSdkModule(sdk as never) }
}

describe('Halo host worker adapter', () => {
  it('resolves the setup when Electron starts from the compiled entry directory', async () => {
    paths.builtSetup = true
    try {
      const { runtime, module } = fixture()
      await module.createSession({ haloRequestIdentity: {} })
      expect(runtime.createSession.mock.calls[0][1]).toMatchObject({ setup: { module: 'file:///application/worker/halo-setup.cjs' } })
      paths.packaged = true
      const packaged = fixture()
      await packaged.module.createSession({ haloRequestIdentity: {} })
      expect(packaged.runtime.createSession.mock.calls[0][1]).toMatchObject({ setup: { module: 'file:///application/out/main/worker/halo-setup.cjs' } })
    } finally {
      paths.builtSetup = false
      paths.packaged = false
    }
  })

  it('loads without starting a worker and exposes explicit startup and shutdown', async () => {
    const { runtime, module } = fixture()
    expect(runtime.initialize).not.toHaveBeenCalled()
    await module.initialize()
    await module.close()
    expect(runtime.initialize).toHaveBeenCalledOnce()
    expect(runtime.close).toHaveBeenCalledOnce()
  })

  it('keeps application grouping and identity out of SDK options while preserving session callbacks', async () => {
    const { runtime, module } = fixture()
    const canUseTool = vi.fn()
    const hooks = { SessionStart: [{ hooks: [vi.fn()] }] }
    const mcpServers = { host: { type: 'sdk', instance: {} } }
    await module.createSession({ workerGroup: 'space', haloRequestIdentity: { sessionId: 'conversation' },
      requestIdentity: { systemPrefix: vi.fn() }, canUseTool, hooks, mcpServers, model: 'model' })
    expect(runtime.createSession).toHaveBeenCalledWith({ canUseTool, hooks, mcpServers, model: 'model' }, {
      group: 'space', setup: { module: 'file:///application/out/main/worker/halo-setup.cjs', data: { sessionId: 'conversation' } },
    })
  })

  it('routes one-shot helper queries through the same independent runtime', () => {
    const { runtime, module } = fixture()
    module.query({ prompt: 'task', options: { model: 'model' } })
    expect(runtime.query).toHaveBeenCalledWith({ prompt: 'task', options: { model: 'model' } }, { group: undefined, setup: undefined })
  })

  it('maps the host-resolved shell into the SDK environment without overwriting an explicit SDK choice', async () => {
    const { runtime, module } = fixture()
    await module.createSession({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\portable\\bash.exe' } })
    expect(runtime.createSession.mock.calls[0][0]).toMatchObject({ env: { AGENT_GIT_BASH_PATH: 'C:\\portable\\bash.exe' } })
    await module.createSession({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\portable\\bash.exe', AGENT_GIT_BASH_PATH: 'C:\\chosen\\bash.exe' } })
    expect(runtime.createSession.mock.calls[1][0]).toMatchObject({ env: { AGENT_GIT_BASH_PATH: 'C:\\chosen\\bash.exe' } })
  })
})
