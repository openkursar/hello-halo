import { beforeEach, describe, expect, it, vi } from 'vitest'
const manager = vi.hoisted(() => ({
  ensureInitialized: vi.fn(async () => {}), getSourceConfig: vi.fn(), getCurrentSourceConfig: vi.fn(),
  getBackendConfigForSource: vi.fn(), ensureValidToken: vi.fn(),
}))
const groups = vi.hoisted(() => new Set<string>())
vi.mock('../../../../src/main/services/ai-sources', () => ({ getGroup: (id: string) => groups.has(id) ? { id } : null, getAISourceManager: () => manager }))
import { assertEngineSourceSelection } from '../../../../src/main/services/agent/source-compatibility'

beforeEach(() => {
  vi.clearAllMocks()
  groups.clear()
  const source = { id: 'selected', authType: 'oauth', provider: 'provider', model: 'model-a' }
  manager.getSourceConfig.mockReturnValue(source)
  manager.getCurrentSourceConfig.mockReturnValue(source)
  manager.getBackendConfigForSource.mockReturnValue({ apiType: 'responses' })
})

describe('save-time engine selection preflight', () => {
  it('reads the selected account/model descriptor without refreshing its credentials', async () => {
    await assertEngineSourceSelection('codex', { modelSourceId: 'selected', modelId: 'model-b' })
    expect(manager.getBackendConfigForSource).toHaveBeenCalledWith('selected', 'model-b')
    expect(manager.ensureValidToken).not.toHaveBeenCalled()
    expect(manager.getCurrentSourceConfig).not.toHaveBeenCalled()
  })
  it('rejects a model-specific Anthropic route even if the saved source has no protocol marker', async () => {
    manager.getBackendConfigForSource.mockReturnValue({ apiType: 'anthropic_passthrough' })
    await expect(assertEngineSourceSelection('codex', { modelSourceId: 'selected', modelId: 'claude-custom' }))
      .rejects.toMatchObject({ code: 'ENGINE_SOURCE_INCOMPATIBLE' })
    expect(manager.ensureValidToken).not.toHaveBeenCalled()
  })
  it('does not substitute the current account for a removed explicit account', async () => {
    manager.getSourceConfig.mockReturnValue(null)
    await expect(assertEngineSourceSelection('codex', { modelSourceId: 'deleted' })).rejects.toThrow('unavailable')
    expect(manager.getCurrentSourceConfig).not.toHaveBeenCalled()
  })
  it('can save a preference before an account is configured, without claiming a runnable session', async () => {
    manager.getCurrentSourceConfig.mockReturnValue(null)
    await expect(assertEngineSourceSelection('halo')).resolves.toBeUndefined()
    expect(manager.getBackendConfigForSource).not.toHaveBeenCalled()
  })
  it('can save a preference with unavailable OAuth metadata; execution rechecks the refreshed descriptor', async () => {
    manager.getBackendConfigForSource.mockReturnValue(null)
    await expect(assertEngineSourceSelection('codex')).resolves.toBeUndefined()
    expect(manager.ensureValidToken).not.toHaveBeenCalled()
  })
  it('lets every engine but Codex keep a load-balancing group, and checks no account for it', async () => {
    groups.add('group-1')
    for (const engineId of ['halo', 'anthropic', 'dsh'] as const) {
      await expect(assertEngineSourceSelection(engineId, { modelSourceId: 'group-1' })).resolves.toBeUndefined()
    }
    await expect(assertEngineSourceSelection('codex', { modelSourceId: 'group-1' }))
      .rejects.toMatchObject({ code: 'ENGINE_SOURCE_INCOMPATIBLE', issue: 'codex-unsupported-group' })
    expect(manager.getSourceConfig).not.toHaveBeenCalled()
    expect(manager.getBackendConfigForSource).not.toHaveBeenCalled()
  })
})
