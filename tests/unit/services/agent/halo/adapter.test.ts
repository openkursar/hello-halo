import { describe, it, expect, vi } from 'vitest'
import { createHaloSdkModule } from '../../../../../src/main/services/agent/halo'
import { app } from 'electron'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/application' } }))

function fixture() {
  const runtime = { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}), diagnostics: vi.fn(() => ({ workers: [] })),
    createSession: vi.fn(async (_options: Record<string, unknown>, _placement?: unknown) => ({ sessionId: 'real' })), query: vi.fn(() => (async function* () {})()) }
  const sdk = { createWorkerRuntime: vi.fn(() => runtime), getWorkerEntryUrl: () => new URL('file:///sdk/dist/worker/entry.js'),
    tool: vi.fn(), createSdkMcpServer: vi.fn(), setLogger: vi.fn() }
  return { runtime, sdk, module: createHaloSdkModule(sdk as never) }
}

describe('Halo host worker adapter', () => {
  it('finds setup beside a built unpackaged main entry', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'halo-adapter-'))
    const main = join(root, 'out/main')
    const setup = join(main, 'worker/halo-setup.cjs')
    fs.mkdirSync(join(main, 'worker'), { recursive: true })
    fs.writeFileSync(setup, '')
    const appPath = vi.spyOn(app, 'getAppPath').mockReturnValue(main)
    try {
      const { module, runtime } = fixture()
      await module.createSession({ haloRequestIdentity: { sessionId: 'conversation' } })
      expect(runtime.createSession.mock.calls[0][1]).toMatchObject({ setup: { module: pathToFileURL(setup).href } })
    } finally { appPath.mockRestore(); fs.rmSync(root, { recursive: true, force: true }) }
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
