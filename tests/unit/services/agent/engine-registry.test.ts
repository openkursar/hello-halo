import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const state = vi.hoisted(() => ({
  configured: 'halo',
  selectedPath: '',
  unavailable: new Set<string>(),
  modules: new Map<string, any[]>(),
  factories: new Map<string, () => any>(),
  probed: [] as string[],
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ agent: { sdkEngine: state.configured, ccRuntime: { selectedPath: state.selectedPath } } }),
}))
vi.mock('../../../../src/main/foundation/logging', () => ({ installSdkLogger: vi.fn() }))
vi.mock('../../../../src/main/services/agent/engine-migration', () => ({ migrateCcRuntimeSelection: vi.fn() }))
vi.mock('../../../../src/main/services/agent/engine-availability', () => ({
  getEngineAvailability: async (ids: string[]) => {
    state.probed.push(...ids)
    return ids.map(engineId => ({ engineId, available: !state.unavailable.has(engineId) }))
  },
}))
vi.mock('@hello-halo/agent-sdk/worker', () => ({}))
vi.mock('../../../../src/main/services/agent/halo', () => ({ createHaloSdkModule: () => state.factories.get('halo')!() }))
vi.mock('../../../../src/main/services/agent/cc', () => ({ createCcSdkModule: () => state.factories.get('anthropic')!() }))
vi.mock('../../../../src/main/services/agent/codex', () => ({ createCodexSdkModule: () => state.factories.get('codex')!() }))
vi.mock('../../../../src/main/services/agent/dsh', () => ({ createDshSdkModule: () => state.factories.get('dsh')!() }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise<void>(done => setImmediate(done))

class Session {
  #model: string
  close = vi.fn()
  flush = vi.fn(async () => {})
  constructor(readonly options: Record<string, any>) { this.#model = options.model }
  getModel() { return this.#model }
}

function makeModule(id: string) {
  const module = {
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createSession: vi.fn(async (options: Record<string, any>) => new Session(options)),
    query: vi.fn(async function* (params: any) { yield { engine: id, model: params.options.model } }),
  }
  state.modules.set(id, [...state.modules.get(id) ?? [], module])
  return module
}

type Registry = typeof import('../../../../src/main/services/agent/resolved-sdk')
let sdk: Registry
beforeEach(async () => {
  vi.resetModules()
  state.configured = 'halo'
  state.selectedPath = ''
  state.modules.clear()
  state.unavailable.clear()
  state.probed = []
  for (const id of ['halo', 'anthropic', 'codex', 'dsh']) state.factories.set(id, () => makeModule(id))
  sdk = await import('../../../../src/main/services/agent/resolved-sdk')
})
afterEach(async () => { await sdk.closeSdkRuntime() })

describe('session-owned engine registry', () => {
  it('loads only the startup default and prewarms only when requested', async () => {
    await sdk.initSdk()
    expect(state.probed).toEqual(['halo'])
    expect([...state.modules.keys()]).toEqual(['halo'])
    expect(state.modules.get('halo')![0].initialize).not.toHaveBeenCalled()
    await sdk.initializeSdkRuntime()
    expect(state.modules.get('halo')![0].initialize).toHaveBeenCalledOnce()
  })

  it('routes concurrent sessions and queries by captured engine and model', async () => {
    await sdk.initSdk()
    const [halo, cc] = await Promise.all([
      sdk.createSession({ engineId: 'halo', model: 'halo-model', engineHandoffContent: ['history'] }),
      sdk.createSession({ engineId: 'anthropic', model: 'cc-model' }),
    ])
    expect(halo.getModel()).toBe('halo-model')
    expect(cc.getModel()).toBe('cc-model')
    expect(halo.engineId).toBe('halo')
    expect(cc.engineId).toBe('anthropic')
    expect(halo.options).not.toHaveProperty('engineId')
    expect(halo.options).not.toHaveProperty('engineHandoffContent')
    const results = []
    for await (const result of sdk.query({ prompt: 'test', options: { engineId: 'codex', model: 'codex-model', engineHandoffContent: ['history'] } })) results.push(result)
    expect(results).toEqual([{ engine: 'codex', model: 'codex-model' }])
    expect(state.modules.get('codex')![0].query.mock.calls[0][0].options).not.toHaveProperty('engineHandoffContent')
    halo.close(); cc.close()
    await Promise.all([halo.flush(), cc.flush()])
    await settle()
    expect(state.modules.get('halo')![0].close).not.toHaveBeenCalled()
    expect(state.modules.get('anthropic')![0].close).toHaveBeenCalledOnce()
    expect(state.modules.get('codex')![0].close).toHaveBeenCalledOnce()
  })

  it('changes defaults without changing or closing a borrowed session', async () => {
    await sdk.initSdk()
    const first = await sdk.createSession({ model: 'first' })
    state.configured = 'anthropic'
    expect(await sdk.resolveDefaultEngine()).toBe('anthropic')
    expect(sdk.getStartupEngine()).toBe('halo')
    expect(sdk.getDefaultEngine()).toBe('anthropic')
    expect(first.engineId).toBe('halo')
    expect(state.modules.get('halo')![0].close).not.toHaveBeenCalled()
    const second = await sdk.createSession({ model: 'second' })
    expect(second.engineId).toBe('anthropic')
    first.close()
    await first.flush()
    await settle()
    expect(state.modules.get('halo')![0].close).toHaveBeenCalledOnce()
    expect(state.modules.get('anthropic')![0].close).not.toHaveBeenCalled()
    second.close(); await second.flush()
  })

  it('keeps the shared runtime until the final session has flushed', async () => {
    await sdk.initSdk()
    const [first, second] = await Promise.all([
      sdk.createSession({ engineId: 'anthropic' }), sdk.createSession({ engineId: 'anthropic' }),
    ])
    const module = state.modules.get('anthropic')![0]
    expect(module.initialize).toHaveBeenCalledOnce()
    const flush = deferred()
    const underlying = await module.createSession.mock.results[1].value as Session
    underlying.flush.mockImplementation(() => flush.promise)
    first.close(); await first.flush()
    expect(module.close).not.toHaveBeenCalled()
    second.close(); await settle()
    expect(module.close).not.toHaveBeenCalled()
    flush.resolve(); await second.flush(); await settle()
    expect(module.close).toHaveBeenCalledOnce()
    expect(state.modules.get('anthropic')).toHaveLength(1)
  })

  it('waits for a closing runtime and builds a fresh one for the new borrower', async () => {
    await sdk.initSdk()
    const first = await sdk.createSession({ engineId: 'anthropic' })
    const closing = deferred()
    const module = state.modules.get('anthropic')![0]
    module.close.mockImplementation(() => closing.promise)
    first.close(); await first.flush(); await settle()
    expect(module.close).toHaveBeenCalledOnce()
    let ready = false
    const pending = sdk.createSession({ engineId: 'anthropic' }).then(value => { ready = true; return value })
    await settle()
    expect(ready).toBe(false)
    closing.resolve()
    const second = await pending
    expect(state.modules.get('anthropic')).toHaveLength(2)
    second.close(); await second.flush()
  })

  it('falls back only for defaults and recovers a later-installed default without restart', async () => {
    state.configured = 'anthropic'
    state.unavailable.add('anthropic')
    await sdk.initSdk()
    expect(sdk.getDefaultEngine()).toBe('halo')
    await expect(sdk.createSession({ engineId: 'anthropic' })).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE', engineId: 'anthropic' })
    state.unavailable.delete('anthropic')
    expect(await sdk.resolveDefaultEngine()).toBe('anthropic')
    expect(sdk.getStartupEngine()).toBe('halo')
  })

  it('releases failed creation without closing another engine', async () => {
    await sdk.initSdk()
    await sdk.ensureEngineAvailable('anthropic')
    const module = state.modules.get('anthropic')![0]
    module.createSession.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(sdk.createSession({ engineId: 'anthropic' })).rejects.toThrow('spawn failed')
    await settle()
    expect(module.close).toHaveBeenCalledOnce()
    expect(state.modules.get('halo')![0].close).not.toHaveBeenCalled()
    expect(sdk.getSdkDiagnostics().engines.every(entry => entry.borrowers === 0)).toBe(true)
  })

  it('aborts every borrowed engine on shutdown and rejects new sessions', async () => {
    await sdk.initSdk()
    const [first, second] = await Promise.all([
      sdk.createSession({ engineId: 'halo' }), sdk.createSession({ engineId: 'anthropic' }),
    ])
    await sdk.closeSdkRuntime()
    expect(first.options.abortController.signal.aborted).toBe(true)
    expect(second.options.abortController.signal.aborted).toBe(true)
    expect(state.modules.get('halo')![0].close).toHaveBeenCalledOnce()
    expect(state.modules.get('anthropic')![0].close).toHaveBeenCalledOnce()
    await expect(sdk.createSession({ engineId: 'halo' })).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    first.close(); second.close()
    await Promise.all([first.flush(), second.flush()])
  })

  it('cancels a pending creation on shutdown and closes the runtime after initialization settles', async () => {
    await sdk.initSdk()
    const ready = deferred()
    state.factories.set('anthropic', () => {
      const module = makeModule('anthropic')
      module.initialize.mockImplementation(() => ready.promise)
      return module
    })
    const pending = sdk.createSession({ engineId: 'anthropic' })
    const rejected = expect(pending).rejects.toThrow()
    await settle()
    const closing = sdk.closeSdkRuntime()
    ready.resolve()
    await Promise.all([rejected, closing])
    const module = state.modules.get('anthropic')![0]
    expect(module.createSession).not.toHaveBeenCalled()
    expect(module.close).toHaveBeenCalledOnce()
    expect(sdk.getSdkDiagnostics().engines.every(entry => entry.borrowers === 0)).toBe(true)
  })

  it('retains executable MCP tools before initialization and across engines', async () => {
    const handler = vi.fn(async ({ text }) => ({ content: [{ type: 'text', text }] }))
    const definition = sdk.tool('echo', 'Echo', { text: z.string() }, handler, { annotations: { readOnlyHint: true }, searchHint: 'echo', alwaysLoad: true })
    const server = sdk.createSdkMcpServer({ name: 'common', tools: [definition] })
    await sdk.initSdk()
    state.configured = 'anthropic'
    await sdk.resolveDefaultEngine()
    const controller = new AbortController()
    expect(server.instance.listTools()[0]).toMatchObject({ annotations: { readOnlyHint: true }, _meta: { searchHint: 'echo', alwaysLoad: true } })
    expect(await server.instance.callTool('echo', { text: 'hello' }, { signal: controller.signal })).toEqual({ content: [{ type: 'text', text: 'hello' }] })
    expect(handler).toHaveBeenCalledWith({ text: 'hello' }, { signal: controller.signal })
  })
})
