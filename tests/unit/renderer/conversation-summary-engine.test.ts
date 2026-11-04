import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  config: {} as any, summaries: [] as any[],
  conversationCache: new Map<string, any>(), sessionInitInfo: new Map<string, any>(), spaceStates: new Map<string, any>(),
  availability: vi.fn(), detail: vi.fn(), configRead: vi.fn(), defaultEngine: vi.fn(), ensureAvailable: vi.fn(),
}))
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(), useEffect: (effect: () => void) => effect() }))
vi.mock('../../../src/main/foundation/config.service', () => ({ getConfig: () => { state.configRead(); return state.config } }))
vi.mock('../../../src/main/services/conversation.service', () => ({ listConversations: () => state.summaries, getConversation: state.detail }))
vi.mock('../../../src/main/platform/task-state', () => ({ getTaskStateService: vi.fn() }))
vi.mock('../../../src/main/services/agent/initialization', () => ({ waitForSdkInitialization: async () => {} }))
vi.mock('../../../src/main/services/agent/resolved-sdk', () => ({ getStartupEngine: () => 'halo', resolveDefaultEngine: state.defaultEngine, ensureEngineAvailable: state.ensureAvailable }))
vi.mock('../../../src/main/services/agent', async () => {
  const routing = await import('../../../src/main/services/agent/engine-routing')
  return { getConversationEngineMetadata: routing.getConversationEngineMetadata }
})
vi.mock('../../../src/renderer/api', () => ({ api: { getEngineAvailability: state.availability } }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({ useChatStore: (select: any) => select(state) }))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: (select: any) => select({ config: state.config }) }))
vi.mock('../../../src/renderer/stores/engine.store', () => ({ useEngineId: (id: string) => id ?? 'halo', useEngineStore: vi.fn() }))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useActiveModelTarget', () => ({ useActiveModelTarget: () => ({ kind: 'conversation', conversation: state.summaries[0] }) }))
vi.mock('../../../src/renderer/utils/people-navigation', () => ({ openPersonModelSettings: vi.fn() }))
vi.mock('../../../src/renderer/components/ai-config/ModelSelector', () => ({ ModelSelectSheet: () => null }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

import { listConversations } from '../../../src/main/controllers/conversation.controller'
import { useConversationEngineId } from '../../../src/renderer/hooks/useConversationEngine'
import { EngineRecoveryNotice } from '../../../src/renderer/components/settings/EngineRecoveryNotice'

beforeEach(() => {
  vi.clearAllMocks()
  state.config = { agent: { sdkEngine: 'anthropic', ccRuntime: { selectedPath: '/missing/automatic-cc' } } }
  state.summaries = [{ id: 'c', messageCount: 2, engineBinding: { version: 1, engineId: 'anthropic', sessionId: 'old' } }]
  state.conversationCache.clear()
  state.sessionInitInfo.clear()
  state.spaceStates.clear()
  state.availability.mockReturnValue(new Promise(() => {}))
})

function readSummary() {
  const response = listConversations('s')
  expect(response.success).toBe(true)
  state.spaceStates.set('s', { conversations: response.data })
  return (response.data as any[])[0]
}

function renderColdNotice() {
  const summary = readSummary()
  const engine = useConversationEngineId('c', 's')
  renderToStaticMarkup(createElement(EngineRecoveryNotice, { engineId: engine, spaceId: 's' }))
  expect(state.detail).not.toHaveBeenCalled()
  expect(state.ensureAvailable).not.toHaveBeenCalled()
  expect(state.defaultEngine).not.toHaveBeenCalled()
  return { summary, engine }
}

describe('conversation summary cold engine identity', () => {
  it('reads configuration once for a list containing bound, historical and empty summaries', () => {
    state.summaries.push({ id: 'old', messageCount: 2 }, { id: 'empty', messageCount: 0 })
    readSummary()
    expect(state.configRead).toHaveBeenCalledTimes(1)
    expect(state.detail).not.toHaveBeenCalled()
  })

  it('does not request runtime availability before ordinary historical conversation details arrive', () => {
    const { summary, engine } = renderColdNotice()
    expect(state.availability).not.toHaveBeenCalled()
    expect(engine).toBe('halo')
    expect(summary.resolvedEngineId).toBe('halo')
    expect(summary.engineBinding).toBe(state.summaries[0].engineBinding)
    expect(state.summaries[0]).not.toHaveProperty('resolvedEngineId')
  })

  it.each(['user', 'delegated', 'override'])('preserves the explicit %s Claude Code choice', choice => {
    if (choice === 'user') state.config.agent.ccRuntime.selectionOrigin = 'user'
    if (choice === 'delegated') state.config.aiSources = { version: 2, currentId: 'cli', sources: [{ id: 'cli', provider: 'claude-cli', authType: 'delegated' }] }
    if (choice === 'override') state.summaries[0].engineOverride = 'anthropic'
    const { summary, engine } = renderColdNotice()
    expect(engine).toBe('anthropic')
    expect(summary.resolvedEngineId).toBe('anthropic')
    expect(state.availability).toHaveBeenCalledTimes(1)
  })

  it.each([['halo', 'anthropic'], ['anthropic', 'halo']] as const)('keeps current %s while %s is pending', (current, desired) => {
    state.summaries[0].engineBinding.engineId = current
    state.summaries[0].engineOverride = desired
    const { summary, engine } = renderColdNotice()
    expect(summary.resolvedEngineId).toBe(current)
    expect(engine).toBe(current)
    expect(summary.engineOverride).toBe(desired)
  })

  it('prefers a resident session over cold resolved metadata', () => {
    state.sessionInitInfo.set('c', { engineId: 'codex' })
    const { summary, engine } = renderColdNotice()
    expect(summary.resolvedEngineId).toBe('halo')
    expect(engine).toBe('codex')
    expect(state.availability).not.toHaveBeenCalled()
  })

  it.each([0, 2])('resolves unbound summary metadata with messageCount=%s without loading messages', messageCount => {
    state.config.agent = { sdkEngine: 'codex', legacySdkEngine: 'halo' }
    state.summaries = [{ id: 'c', messageCount }]
    const { summary, engine } = renderColdNotice()
    expect(summary.resolvedEngineId).toBe(messageCount ? 'halo' : 'codex')
    expect(engine).toBe(summary.resolvedEngineId)
  })
})
