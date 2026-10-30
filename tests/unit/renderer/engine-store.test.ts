import { beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ getEngineCapabilities: vi.fn() }))
vi.mock('../../../src/renderer/api', () => ({ api }))
import { useEngineStore } from '../../../src/renderer/stores/engine.store'

const caps = (engineId: string) => ({ engineId, features: { goal: engineId === 'halo' } })
beforeEach(() => {
  api.getEngineCapabilities.mockReset()
  useEngineStore.setState({ capabilities: null, byEngine: {}, loading: false })
})

describe('per-engine capabilities', () => {
  it('deduplicates parallel requests and keeps default and conversation flags independent', async () => {
    api.getEngineCapabilities.mockImplementation(async id => ({ success: true, data: caps(id ?? 'codex') }))
    await Promise.all([useEngineStore.getState().load(), useEngineStore.getState().load('halo'), useEngineStore.getState().load('halo')])
    const state = useEngineStore.getState()
    expect(state.capabilities?.engineId).toBe('codex')
    expect(state.byEngine.halo?.features.goal).toBe(true)
    expect(state.byEngine.codex?.features.goal).toBe(false)
    expect(api.getEngineCapabilities).toHaveBeenCalledTimes(2)
    await state.load('halo')
    expect(api.getEngineCapabilities).toHaveBeenCalledTimes(2)
  })

  it('does not let an old default response overwrite a newer selection', async () => {
    let finish!: (value: unknown) => void
    api.getEngineCapabilities.mockReturnValueOnce(new Promise(done => { finish = done }))
    const first = useEngineStore.getState().load()
    api.getEngineCapabilities.mockResolvedValueOnce({ success: true, data: caps('halo') })
    await useEngineStore.getState().reload()
    finish({ success: true, data: caps('anthropic') })
    await first
    expect(useEngineStore.getState().capabilities?.engineId).toBe('halo')
    expect(useEngineStore.getState().loading).toBe(false)
  })

  it('refuses a descriptor for another engine instead of using its flags', async () => {
    api.getEngineCapabilities.mockResolvedValue({ success: true, data: caps('codex') })
    await useEngineStore.getState().load('halo')
    expect(useEngineStore.getState().byEngine.halo).toBeUndefined()
    expect(useEngineStore.getState().capabilities).toBeNull()
  })
})
