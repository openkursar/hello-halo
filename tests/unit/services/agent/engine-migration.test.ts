import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ config: { agent: {} } as any, discover: vi.fn(), save: vi.fn() }))
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => state.config,
  saveConfig: (patch: any) => { state.save(patch); state.config = { ...state.config, ...patch } },
}))
vi.mock('../../../../src/main/services/cc-runtime', () => ({ discoverAndSelectCcRuntime: state.discover }))
import { migrateCcRuntimeSelection } from '../../../../src/main/services/agent/engine-migration'

beforeEach(() => {
  state.config = { agent: { sdkEngine: 'anthropic', maxTurns: 200 } }
  state.discover.mockReset().mockResolvedValue(null)
  state.save.mockReset()
})

describe('external CC migration', () => {
  it.each([undefined, 'halo', 'codex', 'dsh'])('never discovers CC for engine %s', async sdkEngine => {
    state.config.agent.sdkEngine = sdkEngine
    await migrateCcRuntimeSelection()
    expect(state.discover).not.toHaveBeenCalled()
    expect(state.save).not.toHaveBeenCalled()
  })
  it.each([{ selectedPath: '/selected' }, { discoveryCompleted: true }])('does not repeat completed or user-selected discovery', async ccRuntime => {
    state.config.agent.ccRuntime = ccRuntime
    await migrateCcRuntimeSelection()
    expect(state.discover).not.toHaveBeenCalled()
  })
  it('records one bounded attempt while retaining the user’s CC preference', async () => {
    await migrateCcRuntimeSelection()
    await migrateCcRuntimeSelection()
    expect(state.discover).toHaveBeenCalledTimes(1)
    expect(state.discover).toHaveBeenCalledWith({ deadlineMs: 8000 })
    expect(state.config.agent).toMatchObject({ sdkEngine: 'anthropic', ccRuntime: { discoveryCompleted: true } })
  })
  it('preserves changes made while discovery was running', async () => {
    state.discover.mockImplementation(async () => {
      state.config.agent = { sdkEngine: 'halo', maxTurns: 42, ccRuntime: { selectedPath: '/chosen', sourceId: 'internal' } }
      return { path: '/chosen' }
    })
    await migrateCcRuntimeSelection()
    expect(state.config.agent).toMatchObject({ sdkEngine: 'halo', maxTurns: 42, ccRuntime: { selectedPath: '/chosen', sourceId: 'internal', discoveryCompleted: true } })
  })
  it('does not abort startup or retry each launch when discovery fails', async () => {
    state.discover.mockRejectedValue(new Error('runtime check failed'))
    await expect(migrateCcRuntimeSelection()).resolves.toBeUndefined()
    expect(state.config.agent.ccRuntime.discoveryCompleted).toBe(true)
  })
})
