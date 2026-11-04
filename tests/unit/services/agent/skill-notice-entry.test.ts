import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ create: vi.fn(), query: vi.fn() }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => ({ agent: { sdkEngine: 'halo' } }) }))
vi.mock('../../../../src/main/foundation/logging', () => ({ installSdkLogger: vi.fn() }))
vi.mock('../../../../src/main/services/agent/engine-availability', () => ({
  getEngineAvailability: async (ids: string[]) => ids.map(engineId => ({ engineId, available: true })),
}))
vi.mock('@hello-halo/agent-sdk/worker', () => ({}))
vi.mock('../../../../src/main/services/agent/halo', () => ({ createHaloSdkModule: () => ({ createSession: state.create, query: state.query }) }))
vi.mock('../../../../src/main/services/agent/cc', () => ({ createCcSdkModule: () => ({ createSession: state.create, query: state.query }) }))
vi.mock('../../../../src/main/services/agent/codex', () => ({ createCodexSdkModule: () => ({ createSession: state.create, query: state.query }) }))

let sdk: typeof import('../../../../src/main/services/agent/resolved-sdk')
let bridge: typeof import('../../../../src/main/services/app-bridge')
async function collect(stream: AsyncIterable<any>) { const frames = []; for await (const frame of stream) frames.push(frame); return frames }
const frames = async function* () { yield { type: 'system', subtype: 'init' }; yield { type: 'assistant', message: { content: 'ordinary answer' } }; yield { type: 'result' } }
const catalog = [{ name: 'private', description: 'not public', source: { kind: 'file' as const, path: '/private/skill/SKILL.md' } }]
function register(provider: () => typeof catalog) {
  bridge.registerAppBridge({ getAppManager: () => null, createHaloAppsMcpServer: () => null, onMcpAppsChange: () => () => {}, getEffectiveSkillCatalog: provider })
}
beforeEach(async () => {
  vi.resetModules()
  state.create.mockReset().mockImplementation(async () => ({ send: vi.fn(), sendIntoLiveTurn: vi.fn(() => true), stream: frames, close: vi.fn(), flush: vi.fn() }))
  state.query.mockReset().mockImplementation(frames)
  sdk = await import('../../../../src/main/services/agent/resolved-sdk')
  bridge = await import('../../../../src/main/services/app-bridge')
  await sdk.initSdk()
})
afterEach(async () => { await sdk.closeSdkRuntime(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('optional-engine skill notice entry', () => {
  it.each(['anthropic', 'codex'])('reads once for %s, keeps permissions/input unchanged and sends a generic system notice', async engineId => {
    const provider = vi.fn(() => catalog)
    register(provider)
    const canUseTool = vi.fn()
    const options = { engineId, workerGroup: 'space', cwd: '/work', allowedTools: ['Read'], disallowedTools: ['Skill(private)'], canUseTool }
    const session = await sdk.createSession(options)
    expect(provider).toHaveBeenCalledOnce()
    expect(state.create.mock.calls[0][0]).toMatchObject(optionsWithoutEngine(options))
    session.send('/private hello')
    const output = await collect(session.stream())
    expect(output[1]).toEqual({ type: 'system', subtype: 'skill_notice', skillNotice: 'skill-unsupported' })
    expect(output[2].message.content).toBe('ordinary answer')
    expect(JSON.stringify(output)).not.toMatch(/not public|\/private\/skill/)
    session.send('follow up')
    expect((await collect(session.stream())).some(item => item.subtype === 'skill_notice')).toBe(false)
    session.send('/private again')
    expect((await collect(session.stream())).filter(item => item.subtype === 'skill_notice')).toEqual([{ type: 'system', subtype: 'skill_notice', skillNotice: 'skill-unsupported' }])
    expect(provider).toHaveBeenCalledOnce()
    session.close()
  })

  it('keeps standalone unscoped optional-engine helpers free of scans and notices', async () => {
    const session = await sdk.createSession({ engineId: 'anthropic' })
    expect((await collect(session.stream())).some(item => item.subtype === 'skill_notice')).toBe(false)
    session.close()
  })

  it('recognizes direct query commands without replacing the prompt', async () => {
    const provider = vi.fn(() => catalog)
    register(provider)
    const output = await collect(sdk.query({ prompt: '/private hi', options: { engineId: 'codex', workerGroup: 'space' } }))
    expect(output[1].skillNotice).toBe('skill-unsupported')
    expect(state.query.mock.calls[0][0].prompt).toBe('/private hi')
    expect(provider).toHaveBeenCalledOnce()
  })

  it.each(['anthropic', 'codex'])('starts %s immediately before catalog registration and keeps its own skills available', async engineId => {
    vi.useFakeTimers()
    const session = await sdk.createSession({ engineId, workerGroup: 'space' })
    expect(state.create).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect((await collect(session.stream())).some(item => item.subtype === 'skill_notice')).toBe(false)
    const provider = vi.fn(() => catalog)
    register(provider)
    session.send('/private later')
    expect((await collect(session.stream())).some(item => item.subtype === 'skill_notice')).toBe(false)
    expect(provider).not.toHaveBeenCalled()
    session.close()
  })

  it.each(['anthropic', 'codex'])('does not delay a %s one-shot query for an unavailable Halo catalog', async engineId => {
    vi.useFakeTimers()
    const output = await collect(sdk.query({ prompt: 'hello', options: { engineId, workerGroup: 'space' } }))
    expect(state.query).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(output.some(item => item.subtype === 'skill_notice')).toBe(false)
    expect(output.some(item => item.message?.content === 'ordinary answer')).toBe(true)
  })

  it.each(['anthropic', 'codex'])('does not claim native %s skills are unavailable when the ready Halo catalog read fails', async engineId => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = vi.fn(() => { throw new Error('catalog read failed') })
    register(provider)
    const session = await sdk.createSession({ engineId, workerGroup: 'space' })
    expect(state.create).toHaveBeenCalledOnce()
    expect(provider).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect((await collect(session.stream())).some(item => item.subtype === 'skill_notice')).toBe(false)
    session.close()
  })

  it('still honors cancellation before an optional engine starts', async () => {
    vi.useFakeTimers()
    const abortController = new AbortController()
    abortController.abort(new Error('cancel'))
    await expect(sdk.createSession({ engineId: 'anthropic', workerGroup: 'space', abortController })).rejects.toThrow('cancel')
    expect(state.create).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(sdk.getSdkDiagnostics().engines.every(entry => entry.borrowers === 0)).toBe(true)
  })
})
function optionsWithoutEngine({ engineId: _engineId, ...options }: Record<string, any>) { return options }
