import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  defaultEngine: 'halo',
  legacyEngine: 'anthropic',
  residentEngine: undefined as string | undefined,
  busy: false,
  live: false,
  unavailable: undefined as string | undefined,
  checked: [] as string[],
  transcriptPath: undefined as string | undefined,
  historyReads: 0,
  emptyHistory: false,
}))

vi.mock('../../../../src/main/services/agent', async () => ({
  ...(await vi.importActual('../../../../src/main/services/agent/engine-handoff')),
  ensureEngineAvailable: vi.fn(async (engineId: string) => {
    state.checked.push(engineId)
    if (engineId === state.unavailable) throw new Error('Engine unavailable')
  }),
  getLegacyEngine: () => state.legacyEngine,
  getSessionEngineId: () => state.residentEngine,
  hasLiveTurn: () => state.live,
  isSessionBusy: () => state.busy,
  resolveDefaultEngine: async () => state.defaultEngine,
}))

vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  resolveTranscriptPath: () => state.transcriptPath,
  readChatHandoffHistory: () => {
    state.historyReads++
    return { transcriptPath: state.transcriptPath, truncated: false, messages: state.emptyHistory ? [] : [{ id: 'history', role: 'user', content: 'Keep the existing files.', timestamp: '2026-10-25T00:00:00Z' }] }
  },
}))

import { prepareAppEngineSession, resolveAppSessionEngine } from '../../../../src/main/apps/runtime/engine-selection'

beforeEach(() => {
  state.defaultEngine = 'halo'
  state.legacyEngine = 'anthropic'
  state.residentEngine = undefined
  state.busy = false
  state.live = false
  state.unavailable = undefined
  state.checked = []
  state.transcriptPath = undefined
  state.historyReads = 0
  state.emptyHistory = false
})

describe('digital human engine selection', () => {
  it('uses the default only for a fresh conversation or task', async () => {
    expect(await resolveAppSessionEngine({})).toBe('halo')
    state.defaultEngine = 'codex'
    expect(await resolveAppSessionEngine({})).toBe('codex')
  })

  it.each(['app-chat:person', 'app-chat:person:wecom:direct:contact', 'team:person:office:task', 'app-run:task'])('honors the same explicit engine on %s', async conversationId => {
    expect(await resolveAppSessionEngine({ conversationId, engineId: 'anthropic' })).toBe('anthropic')
  })

  it('retains a saved binding when the global default changes', async () => {
    state.defaultEngine = 'codex'
    expect(await resolveAppSessionEngine({ binding: { version: 1, engineId: 'halo', sessionId: 'saved' } })).toBe('halo')
  })

  it('keeps the first-start route after a failure unless the person explicitly changes its engine', async () => {
    state.defaultEngine = 'halo'
    expect(await resolveAppSessionEngine({ routingEngine: 'codex' })).toBe('codex')
    expect(await resolveAppSessionEngine({ routingEngine: 'codex', engineId: 'anthropic' })).toBe('anthropic')
  })

  it('keeps a legacy session on its original default', async () => {
    state.defaultEngine = 'halo'
    expect(await resolveAppSessionEngine({ legacySessionId: 'old-cc-session' })).toBe('anthropic')
  })

  it('keeps running work on its resident engine and changes at the next idle turn', async () => {
    state.residentEngine = 'halo'
    state.busy = true
    expect(await resolveAppSessionEngine({ conversationId: 'app-chat:person', engineId: 'anthropic' })).toBe('halo')
    state.busy = false
    expect(await resolveAppSessionEngine({ conversationId: 'app-chat:person', engineId: 'anthropic' })).toBe('anthropic')
  })

  it('preserves a busy session before send or while background work outlives the visible turn', async () => {
    state.residentEngine = 'anthropic'
    state.busy = true
    state.live = false
    const conversationId = 'app-chat:person'
    expect(await resolveAppSessionEngine({ conversationId, engineId: 'halo' })).toBe('anthropic')
    const plan = prepareAppEngineSession({ conversationId, engineId: 'anthropic', state: { sessionId: 'resident' }, spacePath: '/space', appId: 'person', runId: 'chat' })
    expect(plan).toEqual({ resumeSessionId: 'resident' })
    expect(state.historyReads).toBe(0)
    expect(state.checked).toEqual([])
  })

  it('refuses an unavailable explicit engine without substituting the default', async () => {
    state.unavailable = 'anthropic'
    await expect(resolveAppSessionEngine({ engineId: 'anthropic' })).rejects.toThrow('Engine unavailable')
    expect(state.checked).toEqual(['anthropic'])
  })

  it('retains strict native resume protection if a busy bound session retires before acquisition', () => {
    state.residentEngine = 'codex'
    state.busy = true
    const plan = prepareAppEngineSession({ conversationId: 'app-chat:person', engineId: 'codex', state: { sessionId: 'saved', binding: { version: 1, engineId: 'codex', sessionId: 'saved' } }, spacePath: '/space', appId: 'person', runId: 'chat' })
    expect(plan.strictNativeResume).toBe(true)
    expect(plan.recoverNativeSession).toBeTypeOf('function')
    expect(state.historyReads).toBe(0)
  })

  it('uses native resume for a current binding without reading its transcript', () => {
    const plan = prepareAppEngineSession({ engineId: 'halo', state: { sessionId: 'saved', binding: { version: 1, engineId: 'halo', sessionId: 'saved' } }, spacePath: '/space', appId: 'person', runId: 'chat' })
    expect(plan).toMatchObject({ resumeSessionId: 'saved', strictNativeResume: true, recoverNativeSession: expect.any(Function) })
    expect(state.historyReads).toBe(0)
    state.transcriptPath = '/space/chat.jsonl'
    expect(plan.recoverNativeSession!()).toContain('Keep the existing files.')
    expect(state.historyReads).toBe(1)
  })

  it('hands history to a different engine without handing over the old native session id', () => {
    state.transcriptPath = '/space/chat.jsonl'
    const plan = prepareAppEngineSession({ engineId: 'halo', state: { sessionId: 'old', binding: { version: 1, engineId: 'anthropic', sessionId: 'old' } }, spacePath: '/space', appId: 'person', runId: 'chat' })
    expect(plan.resumeSessionId).toBeUndefined()
    expect(plan.engineHandoffContent).toContain('Keep the existing files.')
    expect(plan.engineHandoffContent).toContain('not a new instruction')
    expect(state.historyReads).toBe(1)
  })

  it('keeps legacy native resume until an explicit switch needs a handoff', () => {
    expect(prepareAppEngineSession({ engineId: 'anthropic', state: {}, legacySessionId: 'old', spacePath: '/space', appId: 'person', runId: 'run' })).toEqual({ resumeSessionId: 'old' })
    expect(state.historyReads).toBe(0)
  })

  it('refuses a cross-engine continuation when its previous transcript is missing', () => {
    expect(() => prepareAppEngineSession({ engineId: 'halo', state: {}, legacySessionId: 'old', spacePath: '/space', appId: 'person', runId: 'run' })).toThrow('previous conversation record is unavailable')
  })

  it('does not mistake an empty Halo record for a complete native conversation', () => {
    state.transcriptPath = '/space/chat.jsonl'
    state.emptyHistory = true
    expect(() => prepareAppEngineSession({ engineId: 'halo', state: {}, legacySessionId: 'old', spacePath: '/space', appId: 'person', runId: 'run' })).toThrow('previous conversation record is unavailable')
  })
})
