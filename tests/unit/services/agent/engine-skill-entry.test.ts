import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  create: vi.fn(),
  query: vi.fn(),
  haloDir: `${process.env.TMPDIR ?? '/tmp'}/halo-engine-skill-entry-${process.pid}`,
}))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => ({ agent: { sdkEngine: 'halo' } }), getHaloDir: () => state.haloDir }))
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
const skillFile = join(state.haloDir, 'user', '.agents', 'skills', 'report', 'SKILL.md')
const catalog = [{ name: 'report', description: 'Report', source: { kind: 'file' as const, path: skillFile } }]
function register(provider: () => typeof catalog) {
  bridge.registerAppBridge({ getAppManager: () => null, createHaloAppsMcpServer: () => null, onMcpAppsChange: () => () => {}, getEffectiveSkillCatalog: provider })
}
function linkedNames(options: { additionalDirectories?: string[] }): string[] {
  return (options.additionalDirectories ?? []).flatMap(directory => readdirSync(join(directory, '.claude', 'skills')))
}

beforeEach(async () => {
  mkdirSync(join(skillFile, '..'), { recursive: true })
  writeFileSync(skillFile, '---\nname: report\ndescription: Report\n---\n')
  vi.resetModules()
  state.create.mockReset().mockImplementation(async () => ({ send: vi.fn(), sendIntoLiveTurn: vi.fn(() => true), stream: frames, close: vi.fn(), flush: vi.fn() }))
  state.query.mockReset().mockImplementation(frames)
  sdk = await import('../../../../src/main/services/agent/resolved-sdk')
  bridge = await import('../../../../src/main/services/app-bridge')
  await sdk.initSdk()
})
afterEach(async () => {
  await sdk.closeSdkRuntime()
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(state.haloDir, { recursive: true, force: true })
})

describe('skills reach every engine', () => {
  it('hands Claude Code the skills it cannot find itself as one extra directory, reading the catalog once', async () => {
    const provider = vi.fn(() => catalog)
    register(provider)
    const canUseTool = vi.fn()
    const options = { engineId: 'anthropic', workerGroup: 'space', cwd: '/work', allowedTools: ['Read'], disallowedTools: ['Skill(report)'], canUseTool }
    const session = await sdk.createSession(options)
    expect(provider).toHaveBeenCalledOnce()
    const received = state.create.mock.calls[0][0]
    expect(received).toMatchObject({ workerGroup: 'space', cwd: '/work', allowedTools: ['Read'], disallowedTools: ['Skill(report)'], canUseTool })
    expect(linkedNames(received)).toEqual(['report'])
    session.send('/report hello')
    const output = await collect(session.stream())
    expect(output.some(item => item.subtype === 'skill_notice')).toBe(false)
    expect(output[1].message.content).toBe('ordinary answer')
    session.close()
  })

  it('does the same for a one-shot Claude Code query without touching the prompt', async () => {
    register(() => catalog)
    const output = await collect(sdk.query({ prompt: '/report hi', options: { engineId: 'anthropic', workerGroup: 'space' } }))
    expect(output.some(item => item.subtype === 'skill_notice')).toBe(false)
    expect(state.query.mock.calls[0][0].prompt).toBe('/report hi')
    expect(linkedNames(state.query.mock.calls[0][0].options)).toEqual(['report'])
  })

  it('leaves other engines to find skills in the shared folder on their own', async () => {
    const provider = vi.fn(() => catalog)
    register(provider)
    const session = await sdk.createSession({ engineId: 'codex', workerGroup: 'space', cwd: '/work' })
    expect(state.create.mock.calls[0][0].additionalDirectories).toBeUndefined()
    expect(provider).not.toHaveBeenCalled()
    session.close()
  })

  it('keeps standalone unscoped helpers free of scans and links', async () => {
    const provider = vi.fn(() => catalog)
    register(provider)
    const session = await sdk.createSession({ engineId: 'anthropic' })
    expect(provider).not.toHaveBeenCalled()
    expect(state.create.mock.calls[0][0].additionalDirectories).toBeUndefined()
    session.close()
  })

  it('starts Claude Code immediately before catalog registration, without a timer', async () => {
    vi.useFakeTimers()
    const session = await sdk.createSession({ engineId: 'anthropic', workerGroup: 'space' })
    expect(state.create).toHaveBeenCalledOnce()
    expect(state.create.mock.calls[0][0].additionalDirectories).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    session.close()
  })

  it('does not delay a Claude Code one-shot query for an unavailable catalog', async () => {
    vi.useFakeTimers()
    const output = await collect(sdk.query({ prompt: 'hello', options: { engineId: 'anthropic', workerGroup: 'space' } }))
    expect(state.query).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(output.some(item => item.message?.content === 'ordinary answer')).toBe(true)
  })

  it('starts Claude Code without the extra skills when the ready catalog cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = vi.fn(() => { throw new Error('catalog read failed') })
    register(provider)
    const session = await sdk.createSession({ engineId: 'anthropic', workerGroup: 'space' })
    expect(state.create).toHaveBeenCalledOnce()
    expect(provider).toHaveBeenCalledOnce()
    expect(state.create.mock.calls[0][0].additionalDirectories).toBeUndefined()
    session.close()
  })

  it('still honors cancellation before the engine starts', async () => {
    vi.useFakeTimers()
    const abortController = new AbortController()
    abortController.abort(new Error('cancel'))
    await expect(sdk.createSession({ engineId: 'anthropic', workerGroup: 'space', abortController })).rejects.toThrow('cancel')
    expect(state.create).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(sdk.getSdkDiagnostics().engines.every(entry => entry.borrowers === 0)).toBe(true)
  })
})
