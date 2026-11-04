import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ config: {} as any, defaultEngine: vi.fn(), available: vi.fn() }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => state.config }))
vi.mock('../../../../src/main/services/agent/initialization', () => ({ waitForSdkInitialization: async () => {} }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  getStartupEngine: () => 'halo', resolveDefaultEngine: state.defaultEngine, ensureEngineAvailable: state.available,
}))
import { getLegacyEngine, getConversationEngineMetadata, resolveConversationEngine } from '../../../../src/main/services/agent/engine-routing'

beforeEach(() => {
  state.config = { agent: { sdkEngine: 'codex' } }
  state.defaultEngine.mockReset().mockResolvedValue('codex')
  state.available.mockReset().mockResolvedValue(undefined)
})

describe('conversation engine ownership', () => {
  it.each([
    [{ engineBinding: { engineId: 'anthropic' } }, 'halo'],
    [{ engineRoutingVersion: 1, engineId: 'anthropic' }, 'halo'],
    [{ engineOverride: 'anthropic', engineBinding: { engineId: 'anthropic' } }, 'anthropic'],
    [{ engineOverride: 'codex', engineBinding: { engineId: 'anthropic' } }, 'anthropic'],
    [{ engineOverride: 'anthropic' }, 'anthropic'],
    [{ engineOverride: 'halo' }, 'halo'],
  ])('resolves cold metadata without checking runtime availability: %j', (fields, expected) => {
    expect(getConversationEngineMetadata({ messages: [], ...fields } as any)).toBe(expected)
    expect(state.available).not.toHaveBeenCalled()
    expect(state.defaultEngine).not.toHaveBeenCalled()
  })
  it.each([
    ['halo', 'anthropic'],
    ['anthropic', 'halo'],
  ] as const)('keeps current %s metadata separate from desired %s until the next turn', async (current, desired) => {
    const conversation = {
      messages: [], engineOverride: desired,
      engineBinding: { version: 1 as const, engineId: current, sessionId: 'native-session' },
    }
    expect(getConversationEngineMetadata(conversation as any)).toBe(current)
    expect(conversation.engineOverride).toBe(desired)
    expect(state.available).not.toHaveBeenCalled()
    expect(await resolveConversationEngine(conversation as any)).toBe(desired)
  })
  it('uses the new default for an empty conversation only', async () => {
    expect(await resolveConversationEngine({ messages: [] } as any)).toBe('codex')
    expect(await resolveConversationEngine({ messages: [{ content: 'earlier' }], sessionId: 'legacy' } as any)).toBe('halo')
  })
  it('keeps the recorded legacy baseline across application restarts', () => {
    state.config.agent.legacySdkEngine = 'anthropic'
    expect(getLegacyEngine()).toBe('halo')
    state.config.agent.ccRuntime = { selectionOrigin: 'user' }
    expect(getLegacyEngine()).toBe('anthropic')
  })
  it('prefers a persistent binding over a later global default', async () => {
    expect(await resolveConversationEngine({ engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'cc' } } as any)).toBe('halo')
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
