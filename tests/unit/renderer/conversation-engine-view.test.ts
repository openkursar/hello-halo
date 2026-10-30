import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  conversationCache: new Map<string, any>(), sessionInitInfo: new Map<string, any>(), spaceStates: new Map(),
}))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: (select: any) => select(state) }))
import { useConversationEngineId } from '../../../src/renderer/hooks/useConversationEngine'

describe('visible conversation engine', () => {
  it('keeps a live session and its capabilities until an engine handoff succeeds', () => {
    state.conversationCache.set('c', { engineBinding: { engineId: 'halo' }, engineOverride: 'anthropic' })
    state.sessionInitInfo.set('c', { engineId: 'halo' })
    expect(useConversationEngineId('c', 's', 'codex')).toBe('halo')
    state.sessionInitInfo.set('c', { engineId: 'anthropic' })
    expect(useConversationEngineId('c', 's', 'codex')).toBe('anthropic')
  })
  it('uses a persisted binding before a preference and never reads another conversation', () => {
    state.sessionInitInfo.clear()
    state.conversationCache.set('bound', { engineBinding: { engineId: 'halo' }, engineOverride: 'anthropic' })
    state.conversationCache.set('new', { engineOverride: 'anthropic' })
    expect(useConversationEngineId('bound', 's', 'codex')).toBe('halo')
    expect(useConversationEngineId('new', 's', 'codex')).toBe('anthropic')
    expect(useConversationEngineId('person', 's', 'codex')).toBe('codex')
  })
  it('uses the current engine returned with cold app history before an older persisted binding', () => {
    state.sessionInitInfo.clear()
    state.conversationCache.set('person', { resolvedEngineId: 'anthropic', engineBinding: { engineId: 'halo' } })
    expect(useConversationEngineId('person', 's', 'codex')).toBe('anthropic')
    state.sessionInitInfo.set('person', { engineId: 'halo' })
    expect(useConversationEngineId('person', 's', 'codex')).toBe('halo')
  })
})
