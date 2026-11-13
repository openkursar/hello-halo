import { beforeEach, describe, it, expect, vi } from 'vitest'
import { getEffectiveSkillCatalogForSession, waitForSkillCatalogProvider } from '../../../../../src/main/services/app-bridge'
vi.mock('../../../../../src/main/services/app-bridge', () => ({ getEffectiveSkillCatalogForSession: vi.fn(), waitForSkillCatalogProvider: vi.fn() }))
beforeEach(() => {
  vi.mocked(getEffectiveSkillCatalogForSession).mockReset().mockReturnValue([])
  vi.mocked(waitForSkillCatalogProvider).mockReset().mockResolvedValue(false)
})
import { createHaloSdkModule } from '../../../../../src/main/services/agent/halo'
import { isNativeSessionResumeError } from '../../../../../src/shared/types/engine-session'
import { readSkillNotice } from '../../../../../src/shared/skill-notice'
import { app } from 'electron'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { markInstalledMcpContext } from '../../../../../src/main/services/agent/tool-discovery'
import type { InstalledApp } from '../../../../../src/shared/apps/app-types'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/application' } }))

function fixture() {
  const runtime = { readSessionToolContextMode: vi.fn(async () => 'deferred' as const), initialize: vi.fn(async () => {}), close: vi.fn(async () => {}), diagnostics: vi.fn(() => ({ workers: [] })),
    createSession: vi.fn(async (_options: Record<string, unknown>, _placement?: unknown) => ({ sessionId: 'real' })), query: vi.fn(() => (async function* () {})()) }
  const sdk = { createNativeRuntime: vi.fn(() => runtime),
    tool: vi.fn(), createSdkMcpServer: vi.fn(), setLogger: vi.fn(),
    isResumeHistoryError: (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'RESUME_HISTORY_UNAVAILABLE' }
  return { runtime, sdk, module: createHaloSdkModule(sdk as never) }
}

describe('Halo host native adapter', () => {
  it('inspects context on the same owned native runtime and maps strict history errors', async () => {
    const { module, runtime } = fixture()
    const signal = new AbortController().signal
    const options = { cwd: '/work', env: { CLAUDE_CONFIG_DIR: '/isolated' } }
    expect(await module.readSessionToolContextMode('stored', options, { signal, group: 'space' })).toBe('deferred')
    expect(runtime.readSessionToolContextMode).toHaveBeenCalledWith('stored', options, { signal, group: 'space' })
    runtime.readSessionToolContextMode.mockRejectedValueOnce(Object.assign(new Error('damaged'), { code: 'RESUME_HISTORY_UNAVAILABLE' }))
    await expect(module.readSessionToolContextMode('stored', options, { signal })).rejects.toMatchObject({ engineId: 'halo', sessionId: 'stored', code: 'NATIVE_SESSION_RESUME_FAILED' })
  })

  it('prepares the final mounted catalog identically for sessions and one-shot queries', async () => {
    const { runtime, module } = fixture()
    const customer = markInstalledMcpContext({ type: 'http', url: 'https://example.test/mcp' }, {
      id: 'customer', spec: { type: 'mcp', description: 'Customer orders' }, userOverrides: {},
    } as InstalledApp)
    const options = { mcpServers: { customer, 'halo-email': { type: 'sdk', instance: {} } } }
    await module.createSession(options)
    for await (const _frame of module.query({ prompt: 'task', options })) { /* drain */ }
    const discovery = runtime.createSession.mock.calls[0][0].toolDiscovery
    expect(discovery).toEqual({ services: {
      customer: { identity: 'app:customer', loading: 'deferred', summary: 'Customer orders' },
      'halo-email': { identity: 'builtin:halo-email', loading: 'deferred', summary: expect.any(String) },
    } })
    expect(runtime.query).toHaveBeenCalledWith({ prompt: 'task', options: { ...options, skillCatalog: [], collaboration: { mode: 'hosted' }, toolDiscovery: discovery } }, expect.anything())
    expect(options).not.toHaveProperty('toolDiscovery')
  })

  it.each(['xml', 'json'])('keeps explicit %s calling free of discovery configuration', async toolCallingMode => {
    const { runtime, module } = fixture()
    await module.createSession({ toolCallingMode, mcpServers: { 'halo-email': { type: 'sdk' } }, toolDiscovery: { services: {} } })
    expect(runtime.createSession.mock.calls[0][0]).not.toHaveProperty('toolDiscovery')
  })

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

  it('loads without starting native execution and exposes explicit startup and shutdown', async () => {
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
    expect(runtime.createSession).toHaveBeenCalledWith({ canUseTool, hooks, mcpServers, model: 'model', skillCatalog: [], collaboration: { mode: 'hosted' }, toolDiscovery: { services: {} } }, {
      group: 'space', setup: { module: 'file:///application/out/main/worker/halo-setup.cjs', data: { sessionId: 'conversation' } },
    })
  })

  it('routes one-shot helper queries through the same independent runtime', async () => {
    const { runtime, module } = fixture()
    for await (const _frame of module.query({ prompt: 'task', options: { model: 'model' } })) { /* drain */ }
    expect(runtime.query).toHaveBeenCalledWith({ prompt: 'task', options: { model: 'model', skillCatalog: [], collaboration: { mode: 'hosted' } } }, { group: undefined, setup: undefined })
  })

  it('resolves one effective catalog at session creation and query creation with the actual workspace', async () => {
    const catalog = [{ name: 'weekly', description: 'Weekly', source: { kind: 'file' as const, path: '/skills/weekly.md' } }]
    vi.mocked(getEffectiveSkillCatalogForSession).mockReturnValue(catalog)
    const { runtime, module } = fixture()
    await module.createSession({ workerGroup: 'space', cwd: '/work' })
    expect(getEffectiveSkillCatalogForSession).toHaveBeenCalledTimes(1)
    expect(getEffectiveSkillCatalogForSession).toHaveBeenCalledWith('space', '/work')
    expect(runtime.createSession.mock.calls[0][0].skillCatalog).toEqual(catalog)
    for await (const _frame of module.query({ prompt: 'task', options: { workerGroup: 'space', cwd: '/other' } })) { /* drain */ }
    expect(getEffectiveSkillCatalogForSession).toHaveBeenLastCalledWith('space', '/other')
    expect(runtime.query).toHaveBeenCalledWith({ prompt: 'task', options: { cwd: '/other', skillCatalog: catalog, collaboration: { mode: 'hosted' } } }, expect.anything())
  })

  it('takes only the effective catalog, never caller-supplied or disabled copies', async () => {
    const catalog = [{ name: 'weekly', description: 'Weekly', source: { kind: 'file' as const, path: '/skills/weekly.md' } }]
    vi.mocked(getEffectiveSkillCatalogForSession).mockReturnValue(catalog)
    const { runtime, module } = fixture()
    await module.createSession({ workerGroup: 'space', skillCatalog: [{ name: 'disabled', source: { kind: 'file', path: '/disabled/SKILL.md' } }] })
    expect(runtime.createSession.mock.calls[0][0].skillCatalog).toEqual(catalog)
    expect(waitForSkillCatalogProvider).not.toHaveBeenCalled()
  })

  it('continues known-space work with an explicit empty catalog when the provider stays unavailable', async () => {
    vi.mocked(getEffectiveSkillCatalogForSession).mockReturnValue(undefined)
    const { runtime, module } = fixture()
    await module.createSession({ workerGroup: 'space' })
    for await (const _frame of module.query({ prompt: 'task', options: { workerGroup: 'space' } })) { /* drain */ }
    expect(runtime.createSession.mock.calls[0][0].skillCatalog).toEqual([])
    expect(runtime.query).toHaveBeenCalledWith({ prompt: 'task', options: { skillCatalog: [], collaboration: { mode: 'hosted' } } }, expect.anything())
    expect(waitForSkillCatalogProvider).toHaveBeenCalledTimes(2)
  })

  it('keeps normal replies running and emits the unavailable notice only once when a catalog read throws', async () => {
    vi.mocked(getEffectiveSkillCatalogForSession).mockImplementation(() => { throw new Error('read failed') })
    const { runtime, module } = fixture()
    const native = {
      sessionId: 'real', send: vi.fn(), close: vi.fn(),
      async *stream() {
        yield { type: 'system', subtype: 'init' }
        yield { type: 'assistant', message: { content: 'normal answer' } }
        yield { type: 'result' }
      },
    }
    runtime.createSession.mockResolvedValue(native)
    const session = await module.createSession({ workerGroup: 'space' })
    const output = []
    for await (const frame of session.stream()) output.push(frame)
    expect(output[1]).toEqual({ type: 'system', subtype: 'skill_notice', skillNotice: 'catalog-unavailable' })
    expect(output[2]).toMatchObject({ type: 'assistant', message: { content: 'normal answer' } })
    const next = []
    for await (const frame of session.stream()) next.push(frame)
    expect(next.some(frame => readSkillNotice(frame))).toBe(false)
    expect(runtime.createSession.mock.calls[0][0].skillCatalog).toEqual([])
    expect(getEffectiveSkillCatalogForSession).toHaveBeenCalledOnce()
  })

  it('keeps unscoped helpers explicitly empty even before Apps bootstrap', async () => {
    vi.mocked(getEffectiveSkillCatalogForSession).mockReturnValue(undefined)
    const { runtime, module } = fixture()
    await module.createSession({ skillCatalog: [{ name: 'commit', source: { kind: 'builtin', name: 'commit' } }] })
    expect(runtime.createSession.mock.calls[0][0].skillCatalog).toEqual([])
    for await (const _frame of module.query({ prompt: 'task' })) { /* drain */ }
    expect(runtime.query).toHaveBeenCalledWith({ prompt: 'task', options: { skillCatalog: [], collaboration: { mode: 'hosted' } } }, expect.anything())
    expect(getEffectiveSkillCatalogForSession).not.toHaveBeenCalled()
  })

  it('maps the host-resolved shell into the SDK environment without overwriting an explicit SDK choice', async () => {
    const { runtime, module } = fixture()
    await module.createSession({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\portable\\bash.exe' } })
    expect(runtime.createSession.mock.calls[0][0]).toMatchObject({ env: { AGENT_GIT_BASH_PATH: 'C:\\portable\\bash.exe' } })
    await module.createSession({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\portable\\bash.exe', AGENT_GIT_BASH_PATH: 'C:\\chosen\\bash.exe' } })
    expect(runtime.createSession.mock.calls[1][0]).toMatchObject({ env: { AGENT_GIT_BASH_PATH: 'C:\\chosen\\bash.exe' } })
  })

  it('reports a strict resume the SDK refused as a native resume failure the host recovers from', async () => {
    const { runtime, module } = fixture()
    runtime.createSession.mockRejectedValueOnce(Object.assign(new Error('history incomplete'), { code: 'RESUME_HISTORY_UNAVAILABLE', reason: 'incomplete' }))
    const failure = await module.createSession({ resume: 'stored', strictResume: true }).catch(error => error)
    expect(isNativeSessionResumeError(failure)).toBe(true)
    expect(failure).toMatchObject({ engineId: 'halo', sessionId: 'stored' })
    runtime.createSession.mockRejectedValueOnce(new Error('native execution failed'))
    await expect(module.createSession({ resume: 'stored' })).rejects.toThrow('native execution failed')
  })
})
