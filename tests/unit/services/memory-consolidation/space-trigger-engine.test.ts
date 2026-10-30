import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  listener: null as ((event: any) => void) | null,
  request: null as any,
  conversation: { engineOverride: 'anthropic', modelSourceId: 'pinned-account' },
  defaultEngine: 'halo',
  resolveConversation: vi.fn(),
  getCredentials: vi.fn(),
  resolveCredentials: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent', () => ({
  onAgentEvent: (callback: (event: any) => void) => { state.listener = callback; return { dispose() {} } },
  activeSessions: new Map(),
  getSessionEngineId: () => 'anthropic',
  isSessionBusy: () => false,
  resolveConversationEngine: (...args: unknown[]) => state.resolveConversation(...args),
  resolveDefaultEngine: async () => state.defaultEngine,
  getApiCredentialsForSelection: (...args: unknown[]) => state.getCredentials(...args),
  getApiCredentials: () => state.getCredentials(null),
  resolveCredentialsForSdk: (...args: unknown[]) => state.resolveCredentials(...args),
}))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation: () => state.conversation }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: () => ({ name: 'Test space' }),
  getSpaceMemoryLayout: () => ({ dir: '/tmp/memory' }),
  getSpaceMemorySettings: () => ({ enabled: true }),
}))
vi.mock('../../../../src/main/services/memory-consolidation/service', () => ({
  requestConsolidation: (request: unknown) => { state.request = request },
  consolidateNow: (request: unknown) => { state.request = request; return { started: true } },
  getMemoryStatus: vi.fn(),
}))

import { consolidateSpaceMemoryNow, disposeSpaceMemoryConsolidation, initSpaceMemoryConsolidation } from '../../../../src/main/services/memory-consolidation/space-trigger'

beforeEach(() => {
  disposeSpaceMemoryConsolidation()
  state.defaultEngine = 'halo'
  state.request = null
  state.getCredentials.mockReset().mockResolvedValue({ sourceId: 'pinned-account' })
  state.resolveConversation.mockReset().mockResolvedValue('anthropic')
  state.resolveCredentials.mockReset().mockImplementation(async (credentials, _effort, engineId) => ({ ...credentials, engineId }))
})

describe('space memory engine capture', () => {
  it('uses the triggering conversation engine and account even when the default is different', async () => {
    initSpaceMemoryConsolidation()
    state.listener!({ channel: 'agent:complete', spaceId: 'space', conversationId: 'chat' })
    expect(await state.request.resolveCredentials()).toMatchObject({ sourceId: 'pinned-account', engineId: 'anthropic' })
    expect(state.resolveConversation).toHaveBeenCalledWith(state.conversation, 'anthropic', false)
    expect(state.getCredentials).toHaveBeenCalledWith(state.conversation)
  })

  it('captures a manual consolidation default before refreshing the account', async () => {
    let ready!: () => void
    state.getCredentials.mockReturnValueOnce(new Promise(done => { ready = () => done({ sourceId: 'global-account' }) }))
    consolidateSpaceMemoryNow('space')
    const pending = state.request.resolveCredentials()
    await vi.waitFor(() => expect(state.getCredentials).toHaveBeenCalledWith(null))
    state.defaultEngine = 'anthropic'
    ready()
    expect(await pending).toMatchObject({ sourceId: 'global-account', engineId: 'halo' })
  })
})
