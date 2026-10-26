import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: { id: 'person', status: 'active', spec: { name: 'Person' }, userOverrides: { engineId: 'anthropic', modelSourceId: 'account', modelId: 'model' } } as any,
  choose: vi.fn(async () => 'anthropic'),
  credentials: vi.fn(async (selection: unknown) => selection),
  resolved: vi.fn(async (credentials: unknown, _effort: unknown, engineId: string) => ({ credentials, engineId })),
}))

vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => state.app }) }))
vi.mock('../../../../src/main/apps/runtime/engine-selection', () => ({ resolveAppSessionEngine: state.choose }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({ getApiCredentialsForSelection: state.credentials }))
vi.mock('../../../../src/main/services/agent', () => ({ resolveCredentialsForSdk: state.resolved }))
vi.mock('../../../../src/main/services/space.service', () => ({ getSpace: vi.fn() }))
vi.mock('../../../../src/main/platform/memory', () => ({ resolveMemoryLayout: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/live-instances', () => ({ hasOtherAppExecution: () => false }))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({ consolidateNow: vi.fn(), getMemoryStatus: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/turn/memory-lifecycle', () => ({ appMemorySettings: () => ({}), appConsolidationRequest: vi.fn() }))

import { appConsolidationInputs } from '../../../../src/main/apps/runtime/memory-control'

beforeEach(() => {
  state.app = { id: 'person', status: 'active', spec: { name: 'Person' }, userOverrides: { engineId: 'anthropic', modelSourceId: 'account', modelId: 'model' } }
  state.choose.mockReset().mockResolvedValue('anthropic')
  state.credentials.mockClear()
  state.resolved.mockClear()
})

describe('digital human memory engine', () => {
  it('reads the current digital human when work starts and captures its engine with its account', async () => {
    const inputs = appConsolidationInputs(state.app)
    state.app = { ...state.app, userOverrides: { engineId: 'halo', modelSourceId: 'other', modelId: 'new-model' } }
    state.choose.mockImplementationOnce(async () => {
      state.app.userOverrides = { engineId: 'codex', modelSourceId: 'later' }
      return 'halo'
    })
    await inputs.resolveCredentials()
    expect(state.choose).toHaveBeenCalledWith({ engineId: 'halo' })
    expect(state.credentials).toHaveBeenCalledWith({ engineId: 'halo', modelSourceId: 'other', modelId: 'new-model' })
    expect(state.resolved).toHaveBeenCalledWith(expect.objectContaining({ modelSourceId: 'other' }), undefined, 'halo')
  })

  it('does not consolidate after the digital human was removed', async () => {
    const inputs = appConsolidationInputs(state.app)
    state.app = null
    await expect(inputs.resolveCredentials()).rejects.toThrow('no longer available')
    expect(state.choose).not.toHaveBeenCalled()
    expect(state.credentials).not.toHaveBeenCalled()
  })
})
