import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ config: {} as any, defaultEngine: vi.fn(), available: vi.fn() }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => state.config }))
vi.mock('../../../../src/main/services/agent/initialization', () => ({ waitForSdkInitialization: async () => {} }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  getStartupEngine: () => 'halo', resolveDefaultEngine: state.defaultEngine, ensureEngineAvailable: state.available,
}))
import { getLegacyEngine, resolveConversationEngine } from '../../../../src/main/services/agent/engine-routing'

beforeEach(() => {
  state.config = { agent: { sdkEngine: 'codex' } }
  state.defaultEngine.mockReset().mockResolvedValue('codex')
  state.available.mockReset().mockResolvedValue(undefined)
})

describe('conversation engine ownership', () => {
  it('uses the new default for an empty conversation only', async () => {
    expect(await resolveConversationEngine({ messages: [] } as any)).toBe('codex')
    expect(await resolveConversationEngine({ messages: [{ content: 'earlier' }], sessionId: 'legacy' } as any)).toBe('halo')
  })
  it('keeps the recorded legacy baseline across application restarts', () => {
    state.config.agent.legacySdkEngine = 'anthropic'
    expect(getLegacyEngine()).toBe('anthropic')
  })
  it('prefers a persistent binding over a later global default', async () => {
    expect(await resolveConversationEngine({ engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'cc' } } as any)).toBe('anthropic')
    expect(state.defaultEngine).not.toHaveBeenCalled()
  })
  it('waits for a running session before honoring its explicit override', async () => {
    const conversation = { engineOverride: 'codex', engineBinding: { version: 1, engineId: 'halo', sessionId: 'halo' } } as any
    expect(await resolveConversationEngine(conversation, 'halo', true)).toBe('halo')
    expect(state.available).not.toHaveBeenCalled()
    expect(await resolveConversationEngine(conversation, 'halo', false)).toBe('codex')
  })
  it('reports an unavailable explicit engine without changing its owner', async () => {
    state.available.mockRejectedValue(new Error('Missing runtime'))
    const conversation = { engineOverride: 'anthropic', messages: [] } as any
    await expect(resolveConversationEngine(conversation)).rejects.toThrow('Missing runtime')
    expect(conversation.engineOverride).toBe('anthropic')
    expect(state.defaultEngine).not.toHaveBeenCalled()
  })
})
